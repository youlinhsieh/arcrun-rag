package collector

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// inkstone/arcrun-rag#330 的真 stage 實測（預設 SKIP，要手動開）：
//
//	RUN_STAGE_330=1 STAGE_URL=https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev STAGE_KEY=$ARCRUN_NS_YOULIN \
//	  go test -run TestE2E_330 -v -timeout 900s .
//
// 做法：小幫手（真的 collector 一輪一輪跑）→ 本機代理 → 真的 youlin stage。代理對 /portal/daemon/extract 與
// /read-image 直接掛斷連線（模擬「大檔的 AI 長請求被中途切斷」），其餘原樣轉給 stage。
// 看三件事：① 真實的失敗字串長怎樣 ② 送件帳把它歸成哪一類、現在由誰處理 ③ 代理放行後同一份檔送得上去。
// 🔴 只打 youlin（stage），用獨立庫 stage330；不碰任何 prod 實例、不碰 leo 的 ~/.arcrun-rag。
func TestE2E_330_被切斷的長請求_真Stage(t *testing.T) {
	if os.Getenv("RUN_STAGE_330") != "1" {
		t.Skip("手動驗收，設 RUN_STAGE_330=1（見檔頭）")
	}
	stage, key := os.Getenv("STAGE_URL"), os.Getenv("STAGE_KEY")
	if stage == "" || key == "" || !strings.Contains(stage, "arcrun-yuga3bse") {
		t.Fatal("需要 STAGE_URL（youlin stage）與 STAGE_KEY")
	}
	su, _ := url.Parse(stage)
	var cut atomic.Bool
	cut.Store(true)
	var cuts int32
	rp := httputil.NewSingleHostReverseProxy(su)
	director := rp.Director
	rp.Director = func(r *http.Request) { director(r); r.Host = su.Host }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cut.Load() && (strings.HasSuffix(r.URL.Path, "/portal/daemon/extract") || strings.HasSuffix(r.URL.Path, "/portal/daemon/read-image")) {
			atomic.AddInt32(&cuts, 1)
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			c.Close()
			return
		}
		rp.ServeHTTP(w, r)
	}))
	defer srv.Close()

	root := t.TempDir()
	var sb strings.Builder
	sb.WriteString("# 衛星通訊政策調查期中報告（330 實測）\n\n")
	for i := 0; i < 160; i++ { // 約 40KB：夠切成好幾段送去萃取
		fmt.Fprintf(&sb, "## 第 %d 章\n\n低軌衛星業者 Starlink 與 OneWeb 在第 %d 章討論地面站規劃、海纜登陸點與頻段規範；日本、英國、歐盟各自的政策取向不同，業者需要同時滿足多國的審查。\n\n", i+1, i+1)
	}
	if err := os.WriteFile(filepath.Join(root, "NRI-期中報告-測試.md"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	mpath := filepath.Join(t.TempDir(), "manifest.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root}, Manifest: mpath,
		CypherURL: srv.URL, Namespace: key, APIKey: key,
		Library: "stage330", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	entry := func() *ManifestEntry {
		m, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			return nil
		}
		for _, e := range m.Entries {
			return e
		}
		return nil
	}
	now := time.Now()
	for i := 1; i <= 14; i++ {
		c := *cfg
		c.ForceSync = true // 人按「立刻同步」：略過退避，等於連續失敗 14 輪
		_, _, _ = RunDirectOnce(&c, false)
		e := entry()
		if e == nil {
			t.Fatalf("第 %d 輪後沒有帳本條目", i)
		}
		if i == 1 || i == 9 || i == 14 {
			t.Logf("第 %2d 輪：FailCount=%d LastError=%q", i, e.FailCount, e.LastError)
		}
	}
	e := entry()
	m, _ := LoadManifest(cfg.manifestPathFor(root), root)
	l := BuildLedgerSummaryFor(m.Entries, now, instanceHostOf(srv.URL), nil)
	b, _ := json.MarshalIndent(l, "", "  ")
	t.Logf("代理共掛斷 %d 發\n送件帳（小幫手送上雲端的 ledger_summary）：\n%s", atomic.LoadInt32(&cuts), b)
	if len(l.Reasons) != 1 || l.Reasons[0].Kind == LedgerKindNetwork {
		t.Fatalf("被切斷的長請求不該被說成網路連不上：%+v", l.Reasons)
	}

	// 代理放行（＝問題消失／自癒）：同一份檔送得上去
	cut.Store(false)
	c := *cfg
	c.ForceSync = true
	_, exit, _ := RunDirectOnce(&c, false)
	e = entry()
	t.Logf("放行後：exit=%d FailCount=%d IngestedHash=%q LastError=%q", exit, e.FailCount, e.IngestedHash, e.LastError)
	if e.IngestedHash == "" || e.IngestedHash != e.ContentHash {
		t.Fatalf("放行後應送達：%+v", e)
	}
}
