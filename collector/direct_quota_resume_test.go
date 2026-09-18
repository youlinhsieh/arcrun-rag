// direct_quota_resume_test.go — inkstone/arcrun-rag#197 驗收 ④后半「額度恢復後自動續傳」
// 的**整輪**（RunDirectOnce）證據。
//
// 為什麼另立一支：
//   既有的 cloudquota_test.go `TestD1Quota_NoCloudWritesUntilRecovered` 驗在 postJSON 這一層
//   （直接呼叫 c.postJSON），證得了「額度用完不打、/health 說恢復就放行」的閘邏輯。
//   但票上要的是**整輪自動續傳**：小幫手每分鐘跑一次 RunDirectOnce，額度用完那一輪把檔案
//   擋著、**下一輪 /health 變正常後不需要任何人動手，同一個檔就被送出去**。
//   本測試就跑兩次 RunDirectOnce（＝daemon 相鄰兩輪），/health 由額度用完切成正常，
//   斷言：第一輪對雲端 0 發內容卡、第二輪把同一個檔送出。
//
// /health 原文照抄 2026-09-13 對 youlin（1.4.63）實打的結果（與 cloudquota_test.go 同一份常數）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDirect_D1Quota_AutoResumesNextRoundAfterHealthy(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "報銷規則.md"),
		[]byte("# 報銷規則\n\n報銷上限每人每日 3000 元，需附發票正本。機密內容 XYZZY"), 0o644); err != nil {
		t.Fatal(err)
	}

	// /health 一開始回「D1 讀取額度用完」（youlin 實打原文），之後切成正常。
	var health atomic.Value
	health.Store(youlinHealthD1ReadExhausted)
	// 只數「內容卡」上雲：排除機械資料夾/總覽卡（page_name 以「資料夾」開頭）。
	var contentPosts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(health.Load().(string)))
			return
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			// workers-ai 萃取：回一份合格卡（output＝wikiExtractPrompt 契約的 JSON）
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("報銷規則", "財務")})
			return
		case strings.Contains(r.URL.Path, "rag_ingest_card/trigger"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			if pn, _ := m["page_name"].(string); !strings.HasPrefix(pn, "資料夾") {
				atomic.AddInt32(&contentPosts, 1)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"success": true}})
	}))
	defer srv.Close()

	// 走真的 /health 解析（noteD1Quota 在 fetchBundleVersion 裡），與產品預設一致。
	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFetch }()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}

	// 第一輪：額度用完 → 對雲端 0 發內容卡（檔案被擋著、不萃取、不上雲）。
	resetCloudChecks()
	RunDirectOnce(cfg, false)
	if got := atomic.LoadInt32(&contentPosts); got != 0 {
		t.Fatalf("額度用完那一輪應對雲端 0 發內容卡，got %d", got)
	}

	// 雲端恢復：/health 說資料層正常了。使用者什麼都沒做、設定也沒改。
	health.Store(healthyNew)

	// 下一輪（相鄰的 RunDirectOnce）：不需任何人動手，同一個檔自己被送出去。
	resetCloudChecks() // 只重置「一分鐘問一次」的節流，讓這一輪真的重問 /health（模擬過了一分鐘）
	RunDirectOnce(cfg, false)
	if got := atomic.LoadInt32(&contentPosts); got < 1 {
		t.Fatalf("恢復後下一輪應自動把排隊的檔送出（≥1 發內容卡），got %d", got)
	}
}
