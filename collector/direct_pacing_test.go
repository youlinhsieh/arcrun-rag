// direct_pacing_test.go — 上傳節奏／新檔優先／單輪上限／斷點續傳（2026-08-07）。
//
// 背景見 direct_pacing.go 檔頭：封測事故實測 1,070 次寫入撞上免費上限 1,000，
// 690 個檔逐檔萃取上傳、daemon 這一半完全沒有節奏。這裡驗四件事：
//  1. 一輪掃到的多個事件依 mtime 新到舊處理（今天寫的最優先）。
//  2. 兩次觸發雲端之間有節流間隔。
//  3. 單輪上限存在——巨量積壓不會一次湧完。
//  4. 已處理的事件會立刻落地 manifest，process 被殺掉重開也不會重做。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// init：測試環境預設把節流歸零，不然每個既有測試都要多等 700ms×N，拖慢整個套件。
// 需要驗證節流本身的測試（見下）自行 save/restore 成一個很小的非零值。
func init() {
	directPaceInterval = 0
}

// ── 1) sortEventsNewestFirst ─────────────────────────────────────────────

func TestSortEventsNewestFirst_NewestGoesFirst(t *testing.T) {
	root := t.TempDir()
	old := baseTime
	mid := baseTime.Add(time.Hour)
	newest := baseTime.Add(2 * time.Hour)
	writeFile(t, root, "old.md", "old", old)
	writeFile(t, root, "mid.md", "mid", mid)
	writeFile(t, root, "newest.md", "newest", newest)

	events := []Event{
		{Type: "added", Path: "old.md"},
		{Type: "added", Path: "newest.md"},
		{Type: "added", Path: "mid.md"},
	}
	got := sortEventsNewestFirst(root, events)
	want := []string{"newest.md", "mid.md", "old.md"}
	for i, w := range want {
		if got[i].Path != w {
			t.Fatalf("順序=%v，want %v", pathsOf(got), want)
		}
	}
}

func pathsOf(evs []Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Path
	}
	return out
}

// removed 事件沒有 mtime 可排，一律排在 added/modified/renamed 之後（下架不急）。
func TestSortEventsNewestFirst_RemovedGoesLast(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "new.md", "x", baseTime.Add(time.Hour))
	events := []Event{
		{Type: "removed", Path: "gone.md"},
		{Type: "added", Path: "new.md"},
	}
	got := sortEventsNewestFirst(root, events)
	if got[0].Path != "new.md" || got[1].Path != "gone.md" {
		t.Fatalf("順序=%v", pathsOf(got))
	}
}

// ── 2) 節流間隔 ────────────────────────────────────────────────────────────

func TestPace_RespectsInterval(t *testing.T) {
	old := directPaceInterval
	directPaceInterval = 30 * time.Millisecond
	defer func() { directPaceInterval = old }()

	start := time.Now()
	pace()
	pace()
	elapsed := time.Since(start)
	if elapsed < 55*time.Millisecond { // 兩次 pace，留一點餘裕
		t.Fatalf("兩次 pace() 只花了 %v，節流間隔沒有生效", elapsed)
	}
}

// ── 端到端：積壓一次湧上去 vs 有節奏 ─────────────────────────────────────────
//
// 模擬「大量積壓」場景：8 個檔、單輪上限設 3——驗證①一輪只處理 3 個
// ②被延後的檔案有交代（不是安靜消失）③下一輪接著處理下一批、依然新到舊。

func TestDirect_LargeBacklog_ProcessedInNewestFirstBatches(t *testing.T) {
	root := t.TempDir()
	// 8 個檔，mtime 依檔名反向遞增（a 最舊，h 最新）
	names := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	for i, n := range names {
		writeFile(t, root, n+".md", "內容 "+n, baseTime.Add(time.Duration(i)*time.Minute))
	}

	var mu sync.Mutex
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// InkStoneCo#44：資料夾樹走 portal 登記端點，body 沒有 page_name。
		// 不先擋掉，下面那行型別斷言會 panic，而測試會變成掛住 8 分鐘（見該 helper 的說明）。
		if answeredFolderTreePost(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		mu.Lock()
		order = append(order, m["page_name"].(string))
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		// 這條測試只在意「觸發了幾次、依什麼順序送到假 cypher」，卡片內容固定即可。
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
			}},
		})
	})()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
		MaxEventsPerRun: 3,
	}

	// 第一輪：只處理 3 個（上限），且依 mtime 新到舊＝h, g, f
	results1, exit1, _ := RunDirectOnce(cfg, false)
	if exit1 != 0 {
		t.Fatalf("exit=%d results=%+v", exit1, results1)
	}
	ingested1 := ingestedPaths(results1)
	if len(ingested1) != 3 {
		t.Fatalf("第一輪應處理 3 個，got %d: %+v", len(ingested1), results1)
	}
	wantFirst := []string{"h.md", "g.md", "f.md"}
	for i, w := range wantFirst {
		if ingested1[i] != w {
			t.Fatalf("第一輪順序=%v，want %v（新改的檔要優先）", ingested1, wantFirst)
		}
	}
	// 有交代被延後了幾筆，不是安靜消失
	if !hasDeferredNotice(results1) {
		t.Errorf("應該要交代還有事件被延後，results=%+v", results1)
	}

	// 第二輪：接著處理下一批 3 個（e, d, c）
	results2, exit2, _ := RunDirectOnce(cfg, false)
	if exit2 != 0 {
		t.Fatalf("exit=%d results=%+v", exit2, results2)
	}
	ingested2 := ingestedPaths(results2)
	wantSecond := []string{"e.md", "d.md", "c.md"}
	if len(ingested2) != 3 {
		t.Fatalf("第二輪應處理 3 個，got %d: %+v", len(ingested2), results2)
	}
	for i, w := range wantSecond {
		if ingested2[i] != w {
			t.Fatalf("第二輪順序=%v，want %v", ingested2, wantSecond)
		}
	}

	// 第三輪：剩下 2 個（b, a）全部處理完，沒有再延後
	results3, exit3, _ := RunDirectOnce(cfg, false)
	if exit3 != 0 {
		t.Fatalf("exit=%d", exit3)
	}
	ingested3 := ingestedPaths(results3)
	if len(ingested3) != 2 || ingested3[0] != "b.md" || ingested3[1] != "a.md" {
		t.Fatalf("第三輪=%v，want [b.md a.md]", ingested3)
	}
	if hasDeferredNotice(results3) {
		t.Error("全部處理完不該再有延後交代")
	}

	// 全部 8 個都真的送到雲端了（沒有一個被永久漏掉）；總覽卡（結構先行）另計
	mu.Lock()
	defer mu.Unlock()
	var contentCards []string
	for _, pn := range order {
		if !strings.HasPrefix(pn, "資料夾總覽") {
			contentCards = append(contentCards, pn)
		}
	}
	if len(contentCards) != 8 {
		t.Fatalf("雲端總共應收到 8 次卡片，got %d: %v", len(contentCards), order)
	}
}

// ── 4) 退避中的檔案不該永久佔滿單輪名額（arcrun-rag#104 comment 4480，t217）──
//
// 背景：leo 實測 leo21c 帳號的積壓「1691→1880→1936 筆從不減少」，
// 「已經好久沒有加過任何檔案，哪來的這些筆數？那就是之前卡住的，就是你要解決的問題」
// 「佇列就是問題本身」。
//
// 根因：舊版把 perRunCap 套在「排序後的原始清單」上。mtime 最新的幾個檔如果持續
// 失敗（進入退避），它們不會因為在退避就往後排，於是每一輪都繼續佔著最前面的
// perRunCap 個名額——即使這一輪根本不會被嘗試，只是被跳過。排在它們後面、
// 從沒被嘗試過的健康檔案因此永遠排不到，不管跑幾輪都一樣。
//
// 這個測試重現該情境：3 個 mtime 最新的檔一直失敗（模擬持續性錯誤，例如票上量到的
// 雲端 subrequest 上限或萃取回傳格式錯誤），5 個 mtime較舊、原本會成功的健康檔案
// 排在它們後面。單輪上限=3。
//
//   - 第一輪：全部檔案都還沒失敗過（FailCount=0），cap 選中 mtime 最新的 3 個
//     （也就是那 3 個會一直失敗的檔），全部失敗，記下退避（下次重試在 60 秒後）。
//   - 第二輪（緊接著呼叫，真實時間遠不到 60 秒）：那 3 個檔仍在退避中。
//     舊版行為：cap 依然套在原始排序上，選中的還是同一批退避中的檔案 ⇒
//     這一輪 0 個健康檔案被嘗試，健康檔案永遠排不到。
//     修好後的行為：退避中的檔案被分流到 waiting、不佔 ready 的名額，
//     cap 改套用在 ready 上 ⇒ 健康檔案的前 3 名遞補上來，這一輪就會被嘗試並成功。
func TestDirect_StarvedBacklog_HealthyFilesEventuallyGetATurn(t *testing.T) {
	root := t.TempDir()

	// 3 個「一直失敗」的檔，mtime 最新（若 bug 還在，會永久佔滿 cap）。
	blockers := []string{"blocker-a", "blocker-b", "blocker-c"}
	for i, n := range blockers {
		writeFile(t, root, n+".md", "持續失敗的內容 "+n, baseTime.Add(time.Duration(10+i)*time.Minute))
	}
	// 5 個「健康」的檔，mtime 較舊（排在後面，理應遞補上來）。
	healthy := []string{"h5", "h4", "h3", "h2", "h1"}
	for i, n := range healthy {
		writeFile(t, root, n+".md", "健康內容 "+n, baseTime.Add(time.Duration(4-i)*time.Minute))
	}

	failingPages := map[string]bool{"blocker-a": true, "blocker-b": true, "blocker-c": true}
	var mu sync.Mutex
	var succeededPages []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answeredFolderTreePost(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		pageName, _ := m["page_name"].(string)
		if strings.HasPrefix(pageName, "資料夾總覽") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
		if failingPages[pageName] {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"success":false,"error":"boom"}`))
			return
		}
		mu.Lock()
		succeededPages = append(succeededPages, pageName)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
			}},
		})
	})()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
		MaxEventsPerRun: 3,
	}

	// 第一輪：8 個檔都還沒失敗過，cap 選中 mtime 最新的 3 個（blocker-a/b/c），全部失敗。
	results1, _, _ := RunDirectOnce(cfg, false)
	if got := ingestedPaths(results1); len(got) != 0 {
		t.Fatalf("第一輪不該有任何成功（cap 選中的 3 個全會失敗），got %v", got)
	}
	var failedCount int
	for _, r := range results1 {
		if r.Status == "failed" {
			failedCount++
		}
	}
	if failedCount != 3 {
		t.Fatalf("第一輪應該有 3 筆真的被嘗試且失敗（blocker-a/b/c），got %d：%+v", failedCount, results1)
	}

	// 第二輪：緊接著呼叫（真實時間遠不到 60 秒退避窗口）。blocker-a/b/c 仍在退避中。
	results2, _, _ := RunDirectOnce(cfg, false)
	ingested2 := ingestedPaths(results2)
	if len(ingested2) != 3 {
		t.Fatalf("🔴 第二輪應該有 3 個健康檔案遞補上來被嘗試並成功——"+
			"如果這裡是 0，代表退避中的 blocker-a/b/c 又佔滿了本輪名額，"+
			"健康檔案永遠排不到（這正是 leo 實測「佇列從不減少」的那個 bug）。got %d：%+v",
			len(ingested2), results2)
	}
	wantSecond := []string{"h5.md", "h4.md", "h3.md"}
	for i, w := range wantSecond {
		if ingested2[i] != w {
			t.Fatalf("第二輪順序=%v，want %v（健康檔案仍照 mtime 新到舊遞補）", ingested2, wantSecond)
		}
	}
	// blocker-a/b/c 這一輪不該再被真的嘗試（還在退避中）——它們只會以「skipped」出現。
	for _, r := range results2 {
		if r.Path == "blocker-a.md" || r.Path == "blocker-b.md" || r.Path == "blocker-c.md" {
			if r.Status != "skipped" {
				t.Fatalf("退避中的 %s 這一輪不該被真的嘗試，got status=%s", r.Path, r.Status)
			}
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if len(succeededPages) != 3 {
		t.Fatalf("雲端應該收到 3 筆健康卡片，got %d: %v", len(succeededPages), succeededPages)
	}
}

func ingestedPaths(results []DirectResult) []string {
	var out []string
	for _, r := range results {
		// 只數「檔案事件」。總覽卡（inventory）與資料夾樹（folder_tree，InkStoneCo#44）
		// 都是每輪的結構回報，不是使用者的檔案——同 countsAsDocument 的那條線。
		if r.Status == "ingested" && r.Type != "inventory" && r.Type != "folder_tree" {
			out = append(out, r.Path)
		}
	}
	return out
}

func hasDeferredNotice(results []DirectResult) bool {
	for _, r := range results {
		if r.Type == "info" && strings.Contains(r.Error, "已排入佇列") {
			return true
		}
	}
	return false
}

// ── 3) 斷點續傳：process 被殺掉重開，不從頭來 ────────────────────────────────
//
// 用「單輪上限=1」模擬中斷：一次只做一件事就等同「這一刻的程序被殺掉」，
// 用全新的 RunDirectOnce 呼叫（不共用任何記憶體狀態，manifest 完全從磁碟重讀）
// 模擬「程序重開」。驗證：已經成功的不會被重送，且每一步都真的落地磁碟
// （不是等到全部做完才存檔）。
func TestDirect_ResumeAfterInterruption(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "one.md", "內容一", baseTime)
	writeFile(t, root, "two.md", "內容二", baseTime.Add(time.Minute))
	writeFile(t, root, "three.md", "內容三", baseTime.Add(2*time.Minute))

	var mu sync.Mutex
	var posted []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// InkStoneCo#44：資料夾樹的 body 沒有 path ⇒ 不擋掉的話會被記成一筆空字串，
		// 本測就會看到「送了 4 次」而誤判斷點續傳失效。
		if answeredFolderTreePost(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		mu.Lock()
		if p, _ := m["path"].(string); !strings.HasPrefix(p, ".arcrun-rag/") {
			posted = append(posted, p) // 結構先行：總覽卡（合成路徑）另計
		}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
			}},
		})
	})()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	newCfg := func() *DirectConfig {
		return &DirectConfig{
			WatchFolders: []string{root},
			Manifest:     manifestPath,
			CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
			Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
			CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
			MaxEventsPerRun: 1, // 模擬「只做一件事就被打斷」
		}
	}

	// 「跑到一半」：只完成第一批（three.md，最新）
	if _, exit, _ := RunDirectOnce(newCfg(), false); exit != 0 {
		t.Fatal("第一批失敗")
	}

	// 直接讀磁碟上的 manifest（不透過任何記憶體物件）——驗證真的已經落地，
	// 不是要等三批都跑完才存檔。
	absRoot, _ := filepath.Abs(root)
	mp := newCfg().manifestPathFor(absRoot)
	m1, err := LoadManifest(mp, absRoot)
	if err != nil {
		t.Fatalf("讀 manifest 失敗：%v", err)
	}
	if m1.Entries["three.md"].IngestedHash == "" {
		t.Fatal("「跑到一半」之後，已完成的那份應該已經落地 manifest（斷點續傳的前提）")
	}
	if m1.Entries["two.md"].IngestedHash != "" || m1.Entries["one.md"].IngestedHash != "" {
		t.Fatal("還沒輪到的不該被誤標成已完成")
	}

	// 「重開程序」：全新呼叫，模擬 process 重啟——應該接著做 two.md，不是重做 three.md
	if _, exit, _ := RunDirectOnce(newCfg(), false); exit != 0 {
		t.Fatal("第二批失敗")
	}
	if _, exit, _ := RunDirectOnce(newCfg(), false); exit != 0 {
		t.Fatal("第三批失敗")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 3 {
		t.Fatalf("三個檔應該總共只被送出 3 次（不重送已完成的），got %d: %v", len(posted), posted)
	}
	seen := map[string]bool{}
	for _, p := range posted {
		if seen[p] {
			t.Fatalf("%q 被重複送出——斷點續傳失效，重開後從頭來了", p)
		}
		seen[p] = true
	}

	// 第四輪：三個都做完了，不該再有任何事件
	results4, _, _ := RunDirectOnce(newCfg(), false)
	if len(results4) != 0 {
		t.Fatalf("全部完成後應該零事件：%+v", results4)
	}
}

// removed 事件在「已放回但下架失敗」時不能被提早存檔清掉——否則下一輪兩邊都找不到
// 這個路徑，永遠不會再重試下架。驗證：POST 失敗時，manifest 磁碟版本仍保留該筆，
// 下一輪會重新產生 removed 事件。
func TestDirect_RemovedRetriesOnFailureEvenWithIncrementalSave(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "keep.md", "留著", baseTime)
	writeFile(t, root, "gone.md", "要刪的", baseTime.Add(time.Minute))

	var failRemoved = true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "rag_takedown_direct") && failRemoved {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
			}},
		})
	})()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct",
		MaxRemoved: 1.0,
	}
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatal("第一輪（兩份都新增）失敗")
	}
	if err := os.Remove(filepath.Join(root, "gone.md")); err != nil {
		t.Fatal(err)
	}

	// 第二輪：下架 POST 會失敗（且這輪也會處理 keep.md 的事件？不會，keep.md 已 ingest 過、
	// 沒有變化，不會再產生事件——但仍會呼叫 saveManifest() 若有其他觸發）。
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 1 {
		t.Fatalf("下架失敗應該 exit=1，got %d results=%+v", exit, results)
	}

	absRoot, _ := filepath.Abs(root)
	mp := cfg.manifestPathFor(absRoot)
	m, err := LoadManifest(mp, absRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Entries["gone.md"]; !ok {
		t.Fatal("下架失敗時，manifest 不該把這個路徑永久丟掉——否則永遠不會再重試下架")
	}

	// 第三輪：換伺服器成功 → 應該重新補發並成功下架
	failRemoved = false
	results3, exit3, _ := RunDirectOnce(cfg, false)
	if exit3 != 0 {
		t.Fatalf("第三輪應成功下架：exit=%d results=%+v", exit3, results3)
	}
	var removedOK bool
	for _, r := range results3 {
		if r.Type == "removed" && r.Status == "removed" && r.Path == "gone.md" {
			removedOK = true
		}
	}
	if !removedOK {
		t.Fatalf("第三輪應該重試下架成功：%+v", results3)
	}
	m2, err := LoadManifest(mp, absRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m2.Entries["gone.md"]; ok {
		t.Fatal("下架成功後這個路徑應該真的從 manifest 消失")
	}
}
