package collector

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var idxLinkRe = regexp.MustCompile(`\[\[([^\]]+)\]\]`)

// 錯誤碼形狀的大庫：6500 份、鍵像 120-0006_002。
func errorCodeEntries(n int) []idxEntry {
	var es []idxEntry
	for i := 0; i < n; i++ {
		prefix := []string{"120", "145", "280", "1A0", "1A1", "237"}[i%6]
		stem := fmt.Sprintf("%s-%04X_%03d", prefix, i/6, 1+i%2)
		es = append(es, idxEntry{Key: stem, Lines: "- [[" + stem + "]] — 錯誤 " + stem + "（原稿 `" + stem + ".md`）\n"})
	}
	return es
}

// 🔴 #264 核心：大庫分層後，每張卡都夠小、每個分組數都在上限內、而且從根一路點得到每一份文件。
func TestLayeredIndex_大庫每張卡夠小且走得到每份文件(t *testing.T) {
	es := errorCodeEntries(6500)
	cards := buildIdxCards(es, idxOpts{RootName: "00-INDEX", NameJoiner: "-", WithGloss: true, Footer: "## 說明\nx\n"})
	byName := map[string]string{}
	maxSize := 0
	for _, c := range cards {
		if _, dup := byName[c.Name]; dup {
			t.Fatalf("卡名重複：%s", c.Name)
		}
		byName[c.Name] = c.Content
		if len(c.Content) > maxSize {
			maxSize = len(c.Content)
		}
		if len(c.Content) > idxCardMaxBytes {
			t.Fatalf("%s 太大：%d", c.Name, len(c.Content))
		}
		if n := strings.Count(c.Content, "\n- [["); n > idxLeafMax && n > idxFanoutMax {
			t.Fatalf("%s 列了 %d 條", c.Name, n)
		}
	}
	if cards[0].Name != "00-INDEX" {
		t.Fatalf("第一張必須是根卡：%s", cards[0].Name)
	}
	if len(cards[0].Content) > 8*1024 {
		t.Fatalf("根卡 %d 位元組，應是 LLM 一眼讀完的大小", len(cards[0].Content))
	}
	// 從根 BFS，收集走得到的文件卡
	reach := map[string]bool{}
	seen := map[string]bool{"00-INDEX": true}
	queue := []string{"00-INDEX"}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, m := range idxLinkRe.FindAllStringSubmatch(byName[cur], -1) {
			l := m[1]
			if l == "00-INDEX" || seen[l] {
				continue
			}
			if _, isIdx := byName[l]; isIdx {
				seen[l] = true
				queue = append(queue, l)
			} else {
				reach[l] = true
			}
		}
	}
	for _, e := range es {
		if !reach[e.Key] {
			t.Fatalf("從根走不到 %s", e.Key)
		}
	}
	t.Logf("卡數 %d，最大一張 %d B，根卡 %d B", len(cards), maxSize, len(cards[0].Content))
}

// 小庫維持一張、不分層。
func TestLayeredIndex_小庫不分層(t *testing.T) {
	cards := buildIdxCards(errorCodeEntries(50), idxOpts{RootName: "00-INDEX", NameJoiner: "-", Footer: "## 說明\n"})
	if len(cards) != 1 || strings.Contains(cards[0].Content, "## 分組") {
		t.Fatalf("小庫不該分層：%d 張", len(cards))
	}
}

// 鍵全部相同（分不開前綴）也不能無限遞迴、卡不能超限。
func TestLayeredIndex_同鍵退回區間(t *testing.T) {
	var es []idxEntry
	for i := 0; i < 500; i++ {
		es = append(es, idxEntry{Key: "同名", Lines: fmt.Sprintf("- [[同名%d]]\n", i)})
	}
	cards := buildIdxCards(es, idxOpts{RootName: "00-INDEX", NameJoiner: "-", Footer: "f\n"})
	if len(cards) < 3 {
		t.Fatalf("應該分成多張：%d", len(cards))
	}
	for _, c := range cards {
		if len(c.Content) > idxCardMaxBytes {
			t.Fatal("超限")
		}
	}
}

// 本機 .wiki：大庫寫出 00-INDEX.md＋00-INDEX-*.md，再變小時舊的子卡被清掉。
func TestWriteNodeIndex_分層落檔並清舊(t *testing.T) {
	root := t.TempDir()
	m := &wikiManifest{Version: 1}
	for i := 0; i < 400; i++ {
		stem := fmt.Sprintf("%d-%04d_001", 100+i%5, i)
		m.Docs = append(m.Docs, wikiDoc{Node: wikiRootNodeKey, Path: stem + ".md", Status: "extracted", Card: stem, Gloss: "g"})
	}
	if err := regenerateWikiIndexes(root, m); err != nil {
		t.Fatal(err)
	}
	subs, _ := filepath.Glob(filepath.Join(root, ".wiki", "00-INDEX-*.md"))
	if len(subs) == 0 {
		t.Fatal("沒有子目錄卡")
	}
	b, _ := os.ReadFile(filepath.Join(root, ".wiki", "00-INDEX.md"))
	if len(b) > 8*1024 {
		t.Fatalf("根目錄 %d B", len(b))
	}
	m.Docs = m.Docs[:10]
	if err := regenerateWikiIndexes(root, m); err != nil {
		t.Fatal(err)
	}
	if subs, _ := filepath.Glob(filepath.Join(root, ".wiki", "00-INDEX-*.md")); len(subs) != 0 {
		t.Fatalf("舊子卡沒清：%v", subs)
	}
}

func idxHarness(t *testing.T, fail func(page string) bool) (*DirectConfig, *[]string) {
	t.Helper()
	var pages []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		pn, _ := m["page_name"].(string)
		if fail != nil && fail(pn) {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"success":false,"error":"boom"}`))
			return
		}
		pages = append(pages, pn)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(srv.Close)
	cfg := &DirectConfig{
		Manifest: filepath.Join(t.TempDir(), "m.json"), CypherURL: srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct",
	}
	return cfg, &pages
}

func idxFixture(t *testing.T, n int) (string, *Manifest) {
	root := t.TempDir()
	wm := &wikiManifest{Version: 1}
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	for i := 0; i < n; i++ {
		stem := fmt.Sprintf("%d-%04d_001", 100+i%5, i)
		wm.Docs = append(wm.Docs, wikiDoc{Node: wikiRootNodeKey, Path: stem + ".md", Status: "extracted", Card: stem, Gloss: "g"})
		m.Entries[stem+".md"] = &ManifestEntry{ContentHash: "h", IngestedHash: "h"}
	}
	if err := saveWikiManifest(root, wm); err != nil {
		t.Fatal(err)
	}
	return root, m
}

// 🔴 #264 c19297：根目錄卡一定要被嘗試；成功後雜湊記帳、靜止不重送。
func TestSyncWikiIndexCards_送出根卡且冪等(t *testing.T) {
	cfg, pages := idxHarness(t, nil)
	root, m := idxFixture(t, 400)
	res := syncWikiIndexCards(cfg, root, m, false, time.Now())
	if len(res) < 2 || res[0].Status != "ingested" {
		t.Fatalf("結果：%+v", res)
	}
	if (*pages)[0] != "00-INDEX" {
		t.Fatalf("第一張必須是 00-INDEX：%v", *pages)
	}
	if len(m.WikiIndexFails) != 0 {
		t.Fatal("不該有失敗")
	}
	if again := syncWikiIndexCards(cfg, root, m, false, time.Now()); len(again) != 0 {
		t.Fatalf("靜止不該重送：%+v", again)
	}
}

// 🔴 #264 c19297：送不上去要記成失敗、算進 !N、退避到點自動重送；不准安靜跳過。
func TestSyncWikiIndexCards_失敗記帳顯示並重試(t *testing.T) {
	failing := true
	cfg, _ := idxHarness(t, func(p string) bool { return failing && p == "00-INDEX" })
	root, m := idxFixture(t, 400)
	m.Entries["x.md"] = &ManifestEntry{ContentHash: "h", IngestedHash: "h"}
	now := time.Now()
	res := syncWikiIndexCards(cfg, root, m, false, now)
	if res[0].Status != "failed" || m.WikiIndexFails["00-INDEX"] == nil {
		t.Fatalf("失敗沒記帳：%+v", res)
	}
	if p := m.Progress(); p.Errors() < 1 {
		t.Fatalf("畫面 !N 沒算到目錄卡：%+v", p)
	}
	// 退避窗口內不重撞
	if r2 := syncWikiIndexCards(cfg, root, m, false, now.Add(10*time.Second)); len(r2) > 0 && r2[0].Path != "" && strings.Contains(r2[0].Path, "00-INDEX") && r2[0].Status == "failed" {
		t.Fatal("退避窗口內不該重送")
	}
	// 雲端好了＋退避到點 ⇒ 自動重送、病歷清掉
	failing = false
	r3 := syncWikiIndexCards(cfg, root, m, false, now.Add(2*time.Hour))
	if len(r3) == 0 || m.WikiIndexFails["00-INDEX"] != nil || m.WikiIndexHashes["00-INDEX"] == "" {
		t.Fatalf("到點沒自動重送：%+v fails=%v", r3, m.WikiIndexFails)
	}
	if p := m.Progress(); p.Errors() != 0 {
		t.Fatalf("成功後 !N 應歸零：%+v", p)
	}
}

// 🔴 #264 c19383：收卡路在退避時，目錄卡不能安靜跳過——畫面要有 !N，退避一結束立刻真的送出。
func TestSyncWikiIndexCards_收卡路退避時看得到且退避結束立刻補送(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	cfg, pages := idxHarness(t, nil)
	cfg.CardIngestWF = "rag_ingest_card"
	root, m := idxFixture(t, 400)
	now := time.Now()
	// 把收卡路弄進退避（連續 500）
	for i := 0; i < 4; i++ {
		cloudRoutes.record(cfg.triggerURL(cfg.cardWF()), now, 500, nil, false)
	}
	if cfg.routeNote(cfg.triggerURL(cfg.cardWF())) == "" {
		t.Skip("斷路器沒進退避，測試前提不成立")
	}
	res := syncWikiIndexCards(cfg, root, m, false, now)
	if len(res) == 0 || res[0].Error == "" {
		t.Fatalf("退避中不能安靜：%+v", res)
	}
	if len(*pages) != 0 {
		t.Fatalf("退避中不該送：%v", *pages)
	}
	if m.WikiIndexFails["00-INDEX"] == nil {
		t.Fatal("退避中的目錄卡沒記帳")
	}
	if p := m.Progress(); p.Errors() < 1 {
		t.Fatalf("畫面 !N 沒算到：%+v", p)
	}
	// 退避結束
	cloudRoutes.reset()
	r2 := syncWikiIndexCards(cfg, root, m, false, now.Add(time.Second))
	if len(r2) == 0 || m.WikiIndexHashes["00-INDEX"] == "" || len(m.WikiIndexFails) != 0 {
		t.Fatalf("退避結束沒立刻補送：%+v fails=%v", r2, m.WikiIndexFails)
	}
	if p := m.Progress(); p.Errors() != 0 {
		t.Fatalf("送完 !N 應歸零：%+v", p)
	}
}
