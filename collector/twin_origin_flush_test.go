// twin_origin_flush_test.go — inkstone/arcrun-rag#209 c10693：
// 「pricing-course 昨天已經上傳完，新增 3 個資料夾，按『立刻同步』它居然去抓舊的完全沒變動的重新推。」
//
// 根因（雲端可重現）：新加的資料夾裡有「內容和舊資料夾某檔一模一樣」的副本 ⇒ 副本被併成雙胞胎，
// 本尊（舊資料夾那張完全沒改過的卡）要多寫一行出處 ⇒ 本尊的卡在雲端整張刪掉重寫。
// 修前：每份副本各重寫一次（k 份副本＝同一張卡重寫 k 次，全擠在按「立刻同步」的那一輪）。
// 修後：副本只記帳，所有資料夾處理完後每張本尊的卡只重寫一次；失敗留著下一輪；再按一次＝0。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type flushCloud struct {
	mu          sync.Mutex
	extracts    int
	posts       map[string]int    // library|path -> 這張卡被推了幾次（文件卡，不含資料夾結構卡）
	content     map[string]string // library|path -> 最後一次推上去的內容
	failRewrite bool              // 為真時，「已存在的卡」被重寫一律回 500
}

func newFlushHarness(t *testing.T, roots ...string) (*DirectConfig, *flushCloud) {
	t.Helper()
	cl := &flushCloud{posts: map[string]int{}, content: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger") {
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if pn, _ := m["page_name"].(string); !strings.HasPrefix(pn, "資料夾") {
				k := m["library"].(string) + "|" + m["path"].(string)
				cl.mu.Lock()
				if cl.failRewrite && cl.posts[k] > 0 {
					cl.mu.Unlock()
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"success":false,"error":"boom"}`))
					return
				}
				cl.posts[k]++
				cl.content[k], _ = m["card_content"].(string)
				cl.mu.Unlock()
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(srv.Close)
	undo := extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		cl.mu.Lock()
		cl.extracts++
		n := cl.extracts
		cl.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("報價"+itoa(n), "財務")})
	})
	t.Cleanup(undo)
	cfg := &DirectConfig{
		WatchFolders: roots, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct", MaxRemoved: 1.0,
	}
	return cfg, cl
}

func (c *flushCloud) snapshot() (posts map[string]int, extracts int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	posts = map[string]int{}
	for k, v := range c.posts {
		posts[k] = v
	}
	return posts, c.extracts
}

func pricingFile(i int) string {
	return "# 報價" + itoa(i) + "\n\n內容 " + itoa(i) + strings.Repeat("字", 60)
}

func forceRun(t *testing.T, cfg *DirectConfig) []DirectResult {
	t.Helper()
	cfg.ForceSync = true
	defer func() { cfg.ForceSync = false }()
	res, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d results=%+v", exit, res)
	}
	return res
}

// 兩個新資料夾各有一份舊檔的副本：舊卡只准重寫一次（修前是 2 次），出處兩行都在，再按一次＝0。
func TestTwinOriginFlush_OldCardRewrittenOncePerRun_NotOncePerCopy(t *testing.T) {
	a := filepath.Join(t.TempDir(), "pricing-course")
	files := []string{"a.md", "b.md", "01_歷史報價/c.md", "01_歷史報價/d.md"}
	for i, n := range files {
		writeSameContent(t, filepath.Join(a, n), pricingFile(i))
	}
	cfg, cl := newFlushHarness(t, a)
	runOK(t, cfg) // 昨天：A 傳完
	before, ex0 := cl.snapshot()
	for _, n := range files {
		if before["pricing-course|"+n] != 1 {
			t.Fatalf("A 的每張卡應各送 1 次：%v", before)
		}
	}

	// 今天：新加兩個資料夾，各有 A 的 a.md／b.md 的副本（內容一模一樣，名字不同資料夾）
	b := filepath.Join(t.TempDir(), "pricing-docs")
	c := filepath.Join(t.TempDir(), "demo-copies")
	writeSameContent(t, filepath.Join(b, "a.md"), pricingFile(0))
	writeSameContent(t, filepath.Join(b, "b.md"), pricingFile(1))
	writeSameContent(t, filepath.Join(c, "a.md"), pricingFile(0))
	cfg.WatchFolders = []string{a, b, c}

	forceRun(t, cfg) // 按「立刻同步」
	after, ex1 := cl.snapshot()
	if ex1 != ex0 {
		t.Fatalf("副本不該再萃取：%d → %d", ex0, ex1)
	}
	// 沒有副本的舊卡：完全沒動
	for _, n := range []string{"01_歷史報價/c.md", "01_歷史報價/d.md"} {
		if after["pricing-course|"+n] != 1 {
			t.Fatalf("沒有副本的舊卡不准被重送：%s %d 次", n, after["pricing-course|"+n])
		}
	}
	// 有副本的：a.md 有 2 份副本、b.md 有 1 份——各自只重寫 1 次（修前 a.md 是 +2）
	if got := after["pricing-course|a.md"]; got != 2 {
		t.Fatalf("a.md 有兩份副本，本尊的卡這一輪只該重寫 1 次（共 2 次），got %d", got)
	}
	if got := after["pricing-course|b.md"]; got != 2 {
		t.Fatalf("b.md 本尊的卡共 2 次，got %d", got)
	}
	// 出處清單沒少：a.md 的卡要列出三個地方
	cl.mu.Lock()
	aCard := cl.content["pricing-course|a.md"]
	cl.mu.Unlock()
	for _, lib := range []string{"pricing-course", "pricing-docs", "demo-copies"} {
		if !strings.Contains(aCard, lib) {
			t.Fatalf("a.md 的出處應列出 %s：\n%s", lib, aCard)
		}
	}

	// 再按一次「立刻同步」：已傳完的檔，送上雲的份數 = 0
	forceRun(t, cfg)
	again, ex2 := cl.snapshot()
	if ex2 != ex1 {
		t.Fatalf("再按一次不該萃取：%d → %d", ex1, ex2)
	}
	for k, v := range after {
		if again[k] != v {
			t.Fatalf("再按一次「立刻同步」不該送任何卡：%s %d → %d", k, v, again[k])
		}
	}
}

// 補出處失敗：副本照樣記帳（不燒萃取、不算失敗），標記留著，下一輪補上；補完就清掉。
func TestTwinOriginFlush_FailureKeepsPendingAndRetries(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "報價.md"), pricingFile(0))
	cfg, cl := newFlushHarness(t, a)
	runOK(t, cfg)
	writeSameContent(t, filepath.Join(b, "報價副本.md"), pricingFile(0))
	cfg.WatchFolders = []string{a, b}

	cl.mu.Lock()
	cl.failRewrite = true
	cl.mu.Unlock()
	res := forceRun(t, cfg)
	noticed := false
	for _, r := range res {
		if r.Type == "resync" && strings.Contains(r.Error, "合併卡的出處") && strings.Contains(r.Error, "沒成功") {
			noticed = true
		}
	}
	if !noticed {
		t.Fatalf("補出處失敗要講出來（不能靜悄悄）：%+v", res)
	}
	mb, _ := LoadManifest(cfg.manifestPathFor(b), b)
	e := mb.Entries["報價副本.md"]
	if e == nil || e.TwinPath == "" || !e.TwinOriginPending || e.IngestedHash == "" {
		t.Fatalf("副本應已記帳且標記待補出處：%+v", e)
	}
	if p := mb.Progress(); p.Done != 1 || p.Errors() != 0 {
		t.Fatalf("補出處失敗不該把副本算成出錯：%+v", p)
	}

	cl.mu.Lock()
	cl.failRewrite = false
	cl.mu.Unlock()
	runOK(t, cfg)
	mb, _ = LoadManifest(cfg.manifestPathFor(b), b)
	if mb.Entries["報價副本.md"].TwinOriginPending {
		t.Fatal("補上之後標記應清掉")
	}
	cl.mu.Lock()
	card := cl.content[filepath.Base(a)+"|報價.md"]
	n := cl.posts[filepath.Base(a)+"|報價.md"]
	cl.mu.Unlock()
	if !strings.Contains(card, filepath.Base(b)) {
		t.Fatalf("出處應補上第二個資料夾：\n%s", card)
	}
	runOK(t, cfg)
	cl.mu.Lock()
	n2 := cl.posts[filepath.Base(a)+"|報價.md"]
	cl.mu.Unlock()
	if n2 != n {
		t.Fatalf("補完後不該再推：%d → %d", n, n2)
	}
}
