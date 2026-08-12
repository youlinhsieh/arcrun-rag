// vault_footprint_test.go — arcrun-rag#60 第二輪，驗收條件④「回頭看：上一批為什麼沒抓到」。
//
// ══════════════════════════════════════════════════════════════════════════
// 上一批（1e36bb1）為什麼漏掉這次這個？
// ══════════════════════════════════════════════════════════════════════════
//
// 上一批問的問題是：「**卡片落在哪個目錄？**」
// 於是它加了 cardsRelDirFor()，並且只寫了一支點測（TestCardsRelDirFor）去驗
// 「這個函式回傳的常數對不對」。它從頭到尾**沒有問過「檔名叫什麼」**——
// 而 Logseq/Obsidian 的頁名正是從 basename 來的，撞名撞的是名字不是目錄。
//
// 更根本的形狀問題：那批測試是**點測**（挑一個已知的寫檔點，驗它的回傳值）。
// 點測只能保護「測試作者當時想得到的那幾個寫檔點」，於是這些全部漏在網外：
//
//	· snapshotCards() 仍硬寫 cardsRelDir（vault 上 snapshot 到空目錄）
//	· ExtractWithClaude 的檔名由 prompt 決定，Go 測試碰不到
//	· safeWriteCard 的 .bak-<ts> 備份檔沒人問過它叫什麼名字
//	· 之後任何人新增第 N 個寫檔點——沒有任何機制會提醒他要帶標記
//
// ⇒ 這正是「規則寫了、卻沒有機制驗證有沒有照做」的同款（頂層 CLAUDE.md 記過
//
//	history-first／KBDB-first／stage-first 三個同形狀的事故）。
//
// ══════════════════════════════════════════════════════════════════════════
// 所以這一批補的是「足跡測試」，不是再多一支點測
// ══════════════════════════════════════════════════════════════════════════
//
// 判準從「某個函式回傳什麼」換成「**跑完一輪之後，這個資料夾多出了什麼**」：
//
//	跑之前 walk 整個監看根拍一張全景快照 → 跑一輪真的同步 → 再拍一張 →
//	  ① 所有**新出現**的檔案，basename 一律要帶 MachineMark
//	  ② 所有**本來就在**的檔案，內容與 mtime 一個位元都不能變
//
// 這張網**與寫檔點的數量無關**：以後誰新增一個沒帶標記的寫檔點，不管它藏在
// 哪支檔案、哪條分支，只要它真的寫進了使用者的資料夾就會被這裡抓到。
package collector

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// gemmaEchoStub＝會**看請求是哪一頁**、回傳對應那一頁合格卡片的 Gemini 替身。
//
// 為什麼不能沿用 gemmaCardStub（固定回同一張卡）：這一支測試的 fixture 是「真的有
// 既有頁面的 vault」，一輪會萃好幾份（journals、pages、丟進去的原稿）。固定回同一張卡
// 會讓 pageName 對不上 cleanGemmaCard 的「# <頁名>」契約 ⇒ 被品質 lint 擋下 ⇒ 測試
// 綠不了，而那是替身的問題不是產品的問題。頁名從 gemmaPrompt 的「# <頁名>」裡取回來。
func gemmaEchoStub(t *testing.T) func() {
	t.Helper()
	return gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		prompt := ""
		if len(req.Contents) > 0 && len(req.Contents[0].Parts) > 0 {
			prompt = req.Contents[0].Parts[0].Text
		}
		page := "未知頁"
		if i := strings.Index(prompt, "「# "); i >= 0 {
			rest := prompt[i+len("「# "):]
			if j := strings.Index(rest, "」"); j >= 0 {
				page = rest[:j]
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{
					{"text": cardFixture(page, "測試客體")},
				}},
			}},
		})
	})
}

// footprintEntry＝快照裡的一筆（內容雜湊足以同時偵測「被改了」與「被截斷了」）。
type footprintEntry struct {
	size  int64
	mtime int64
	hash  string
}

// snapshotTree walk 整個 root（含隱藏目錄——機器產物就藏在那裡），回傳 rel → 狀態。
func snapshotTree(t *testing.T, root string) map[string]footprintEntry {
	t.Helper()
	out := map[string]footprintEntry{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		h, herr := hashFile(p)
		if herr != nil {
			return herr
		}
		out[filepath.ToSlash(rel)] = footprintEntry{size: info.Size(), mtime: info.ModTime().UnixNano(), hash: h}
		return nil
	})
	if err != nil {
		t.Fatalf("快照失敗：%v", err)
	}
	return out
}

// sortedFootprintKeys 讓 t.Log 印出來的清單順序穩定（人要拿它當實測輸出貼進 issue）。
// 名字不叫 sortedKeys：convert_table.go 已經有一支同名的（吃 map[string][]byte），
// 同一個 package 裡不能重名。
func sortedFootprintKeys(m map[string]footprintEntry) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func logTree(t *testing.T, title string, snap map[string]footprintEntry) {
	t.Helper()
	t.Logf("──── %s（%d 個檔案）────", title, len(snap))
	for _, k := range sortedFootprintKeys(snap) {
		t.Logf("  %s", k)
	}
}

// newVaultWithRealJournals 造一個「真的有既有日誌檔」的 Logseq vault。
//
// 🔴 日期檔是這一票的核心：使用者的 journals/2026_08_10.md 一旦被當成原稿萃取，
// 舊版產出的卡片就叫 2026_08_10.md ⇒ 在 Logseq 眼裡跟他自己的日誌**同一頁**。
// 所以 fixture 必須真的擺日期檔，否則測不到 leo 抱怨的那一類。
func newVaultWithRealJournals(t *testing.T) (root string, preexisting map[string]string) {
	t.Helper()
	root = t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	mustMkdir(t, filepath.Join(root, "pages"))
	mustMkdir(t, filepath.Join(root, "journals"))

	preexisting = map[string]string{
		"logseq/config.edn":      "{:default-home {:page \"contents\"}}",
		"pages/contents.md":      "- 我的目錄頁",
		"pages/讀書筆記.md":          "- leo 自己寫的讀書筆記",
		"journals/2026_08_10.md": "- 今天想到的事，這是我自己寫的日記",
		"journals/2026_08_11.md": "- 昨天的日記",
	}
	for rel, body := range preexisting {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, preexisting
}

// 驗收條件①②：在一個真的有既有日誌檔的 vault 上跑一輪，
// 新檔全部帶標記、他原本的檔一個都沒被動到。
func TestVaultFootprint_EveryNewFileIsMarked(t *testing.T) {
	root, preexisting := newVaultWithRealJournals(t)

	// 使用者丟進 vault 的原稿，**刻意用日期當檔名**——這是最會撞的那一種：
	// 舊行為會萃出 `2026_08_10.md`，跟 journals/2026_08_10.md 同頁名。
	srcRel := "2026_08_10.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 要被萃取的原稿"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaEchoStub(t)()

	before := snapshotTree(t, root)
	logTree(t, "跑之前", before)

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("同步失敗 exit=%d results=%+v", exit, results)
	}

	after := snapshotTree(t, root)
	logTree(t, "跑之後", after)

	// ── ① 所有新出現的檔案，basename 一律帶標記 ──────────────────────────
	var unmarked, added []string
	for rel := range after {
		if _, existed := before[rel]; existed {
			continue
		}
		added = append(added, rel)
		if !IsMarked(filepath.Base(rel)) {
			unmarked = append(unmarked, rel)
		}
	}
	sort.Strings(added)
	sort.Strings(unmarked)
	t.Logf("新增的檔案：%v", added)
	if len(added) == 0 {
		t.Fatal("這一輪什麼都沒產出——紅線是「東西照樣產出、但不撞名」，沒產出等於沒測到")
	}
	if len(unmarked) > 0 {
		t.Fatalf("有 %d 個新檔沒帶 %q 標記，使用者分不出是誰寫的：%v",
			len(unmarked), MachineMark, unmarked)
	}

	// ── ② 他原本的檔，一個位元都不能變 ────────────────────────────────
	for rel, want := range before {
		got, still := after[rel]
		if !still {
			t.Fatalf("使用者原本的檔案不見了：%s", rel)
		}
		if got.hash != want.hash || got.size != want.size {
			t.Fatalf("使用者原本的檔案被改了：%s（size %d→%d）", rel, want.size, got.size)
		}
		if got.mtime != want.mtime {
			t.Fatalf("使用者原本的檔案 mtime 被動過：%s", rel)
		}
	}
	// 內容也逐字核對一次（hash 相同已足夠，這裡是給人看的雙保險）。
	for rel, want := range preexisting {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("讀不回原本的檔案 %s：%v", rel, err)
		}
		if string(data) != want {
			t.Fatalf("原本的檔案內容變了：%s\n want %q\n got  %q", rel, want, data)
		}
	}

	// ── ③ 撞名這件事本身：不准有任何機器產物的頁名等於使用者的頁名 ──────
	userPages := map[string]string{}
	for rel := range preexisting {
		if strings.HasSuffix(rel, ".md") {
			userPages[pageNameOf(rel)] = rel
		}
	}
	userPages[pageNameOf(srcRel)] = srcRel
	for _, rel := range added {
		if !strings.HasSuffix(rel, ".md") {
			continue
		}
		if owner, clash := userPages[pageNameOf(rel)]; clash {
			t.Fatalf("機器產物 %s 的頁名與使用者的 %s 撞在一起（Logseq 會當成同一頁）", rel, owner)
		}
	}
}

// 非 vault 的一般資料夾，同一條規則同樣成立。
//
// 🔴 為什麼要有這一支：紅線是「前綴只准一種，不要一部分加一部分不加」。
// 若只在 vault 加標記，一般資料夾的使用者照樣分不出哪些是機器寫的——
// 而 system-dev/wiki/cards/ 在他的檔案總管裡是**看得見的**，不像 vault 那條是隱藏目錄。
func TestPlainFolderFootprint_EveryNewFileIsMarked(t *testing.T) {
	root := t.TempDir()
	mine := filepath.Join(root, "我的報告.md")
	if err := os.WriteFile(mine, []byte("我自己的內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	srcRel := "報銷規則.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaEchoStub(t)()

	before := snapshotTree(t, root)
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	if results, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatalf("同步失敗 exit=%d results=%+v", exit, results)
	}
	after := snapshotTree(t, root)
	logTree(t, "一般資料夾・跑之後", after)

	newCount := 0
	for rel := range after {
		if _, existed := before[rel]; existed {
			continue
		}
		newCount++
		if !IsMarked(filepath.Base(rel)) {
			t.Fatalf("一般資料夾也不准有沒帶標記的新檔：%s", rel)
		}
	}
	if newCount == 0 {
		t.Fatal("沒有任何產出，測不到東西")
	}
	if data, _ := os.ReadFile(mine); string(data) != "我自己的內容" {
		t.Fatalf("使用者原本的檔被動過：%q", data)
	}
}

// 備份檔也在網內：既有卡片被改寫時產生的 .bak-<ts>，同樣必須帶標記。
//
// 這一條是「足跡測試比點測強」的最好例子——沒有人特地為備份檔寫過測試，
// 但它確確實實是 daemon 寫進使用者資料夾的檔案。
func TestVaultFootprint_BackupFilesAreMarkedToo(t *testing.T) {
	root, _ := newVaultWithRealJournals(t)
	srcRel := "會議記錄.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿 v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 先放一張同名舊卡（內容不同）→ 這一輪落卡會先備份它。
	cardDir := filepath.Join(root, filepath.FromSlash(vaultCardsRelDir))
	mustMkdir(t, cardDir)
	cardName := MarkName("會議記錄.md")
	if err := os.WriteFile(filepath.Join(cardDir, cardName), []byte("# 會議記錄\n舊的內容"), 0o644); err != nil {
		t.Fatal(err)
	}

	defer gemmaCardStub(t, cardFixture("會議記錄", "專案"))()
	if _, err := ExtractWithGemma("k-test", "gemma-test", root, srcRel); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(cardDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	foundBackup := false
	for _, e := range entries {
		names = append(names, e.Name())
		if !IsMarked(e.Name()) {
			t.Fatalf("卡片目錄裡出現沒帶標記的檔案：%s（目錄內容：%v）", e.Name(), names)
		}
		if bakSuffix.MatchString(e.Name()) {
			foundBackup = true
		}
	}
	t.Logf("卡片目錄內容：%v", names)
	if !foundBackup {
		t.Fatalf("既有卡片沒有被備份就被改寫了，目錄內容：%v", names)
	}
}
