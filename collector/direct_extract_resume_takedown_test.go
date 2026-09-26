// direct_extract_resume_takedown_test.go — arcrun-rag#213：走過續讀機制的大檔，
// 刪除原稿時**每一張概念卡都要各自下架**，不能只下架 hub（否則雲端留下孤兒卡，
// 是 c10625 驗收條件「刪檔後主題卡一起下架」的整輪證據）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestDirect_ExtractResumable_刪檔後概念卡逐一下架(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 230)
	// mass_delete_guard（既有的災難防護，`inkstone/arcrun-rag#…`「一次消失比例超過 40% 全部不下架」）
	// 只在監看資料夾裡有別的檔案陪襯時才不會被這次的單一刪除誤觸——多放幾個無關小檔，
	// 讓「刪一個」的比例壓在門檻之下，這不是繞過那道閘，是讓測試場景貼近真實資料夾。
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(root, "旁邊的檔"+strconv.Itoa(i)+".md"),
			[]byte("# 旁邊的檔"+strconv.Itoa(i)+"\n\n這是別的檔案，不參與這次測試的斷言。"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	var extractHits int32
	var mu sync.Mutex
	var takedownPageNames []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(healthyNew))
			return
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			if isWorkersAIProbeBody(r) {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "{}"})
				return
			}
			n := atomic.AddInt32(&extractHits, 1)
			body := `{"gloss":"段落` + strconv.Itoa(int(n)) + `","summary":"這是一段測試摘要文字內容",` +
				`"points":["這是一句判斷句"],"concepts":[{"name":"概念` + strconv.Itoa(int(n)) + `",` +
				`"gloss":"一句話","summary":"摘要內容一段話","points":["重點一句話"]}]}`
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": body})
			return
		case strings.Contains(r.URL.Path, "rag_takedown_direct/trigger"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			if pn, _ := m["page_name"].(string); pn != "" {
				mu.Lock()
				takedownPageNames = append(takedownPageNames, pn)
				mu.Unlock()
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"success": true}})
	}))
	defer srv.Close()

	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFetch }()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct", MaxRemoved: DefaultMaxRemovedRatio,
	}

	// 🔴 段數（見 extract_resume.go extractChunkTargetBytes 的真實量測，8,000 bytes／段）
	// 可能超過單輪的 maxChunksPerInvocation，跑好幾輪直到蓋章（handler 永遠成功，
	// 純粹是量體要好幾輪才讀得完，不是模擬失敗）。
	var e1 *ManifestEntry
	for round := 0; round < 10; round++ {
		resetCloudChecks()
		RunDirectOnce(cfg, false)
		m1, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			t.Fatal(err)
		}
		e1 = m1.Entries["手冊.md"]
		if e1 != nil && e1.IngestedHash != "" {
			break
		}
	}
	if e1 == nil || e1.IngestedHash == "" {
		t.Fatalf("前提：這輪應該已經完整讀完並蓋章，實際：%+v", e1)
	}
	cardRels := WikiDocCardRels(root, "手冊.md")
	if len(cardRels) < 2 {
		t.Fatalf("前提：這份檔應該產出 hub＋至少 1 張概念卡，實際 %d 張：%v", len(cardRels), cardRels)
	}
	if !docWentThroughResumable(root, "手冊.md") {
		t.Fatal("前提：這份檔應該被記錄成走過續讀機制")
	}

	// 使用者刪除原稿。
	if err := os.Remove(filepath.Join(root, "手冊.md")); err != nil {
		t.Fatal(err)
	}

	resetCloudChecks()
	RunDirectOnce(cfg, false) // 這輪應該偵測到 removed 事件並下架

	mu.Lock()
	got := append([]string(nil), takedownPageNames...)
	mu.Unlock()

	if len(got) < len(cardRels) {
		t.Errorf("下架請求數應該至少等於卡片數（hub＋每張概念卡各一發），"+
			"卡片數=%d 下架請求數=%d：%v", len(cardRels), len(got), got)
	}
	// hub 用的是原稿頁名（跟改版前一致）；其餘每張概念卡各自的名字也要出現在下架清單裡。
	wantHub := pageNameOf("手冊.md")
	foundHub := false
	for _, pn := range got {
		if pn == wantHub {
			foundHub = true
		}
	}
	if !foundHub {
		t.Errorf("下架清單裡應該有 hub 的 page_name %q，實際：%v", wantHub, got)
	}
	for _, rel := range cardRels[1:] { // [0] 是 hub，已經驗過了
		want := pageNameOf(rel)
		found := false
		for _, pn := range got {
			if pn == want {
				found = true
			}
		}
		if !found {
			t.Errorf("概念卡 %q 的下架請求沒有送出（page_name=%q），實際下架清單：%v", rel, want, got)
		}
	}

	// 書籤也該一起清掉，不留孤兒狀態。
	if docWentThroughResumable(root, "手冊.md") {
		t.Errorf("原稿下架後，續讀書籤應該一起清掉")
	}
}
