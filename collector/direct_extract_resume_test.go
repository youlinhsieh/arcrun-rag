// direct_extract_resume_test.go — arcrun-rag#213 整輪（RunDirectOnce）證據：
// 大檔在額度用完那一輪，①卡片確實送上雲了 ②manifest **不蓋「已送達」的章**
// ③也**不記失敗／退避**（這是本票最容易撞回 t195 那個「1387 輪×11 小時」老病的地方，
// 所以要用整輪測試釘死，不能只信任 extract_resume_test.go 那一層的單元測試）。
// 額度恢復的下一輪則要把剩下的段讀完、正式蓋章。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// isWorkersAIProbeBody 認出 probeWorkersAI() 那一發空探測（`{"page_name":"","text":""}`，
// 見 probe_workersai.go）——它跟真正的萃取打同一條 route，**每輪每帳號的第一發都是它**，
// 測試的 mock handler 要把它跟真正的段落萃取分開算，不然計數會多算一發、把「第幾段」
// 的斷言全部往後偏一位（本檔早期版本就撞過這個坑）。
func isWorkersAIProbeBody(r *http.Request) bool {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(strings.NewReader(string(body)))
	var payload struct {
		PageName string `json:"page_name"`
		Text     string `json:"text"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return payload.PageName == "" && payload.Text == ""
}

func TestDirect_ExtractResumable_額度用完那輪上雲但不蓋章不記失敗(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 400)

	var extractHits int32
	var contentPosts int32
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
			if n > 2 { // 第 3 段開始撞額度
				w.WriteHeader(http.StatusBadGateway)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": "8007: 4006: you have used up your daily free allocation of 10,000 neurons",
				})
				return
			}
			body := `{"gloss":"段落` + strconv.Itoa(int(n)) + `","summary":"這是一段測試摘要文字內容",` +
				`"points":["這是一句判斷句"],"concepts":[{"name":"概念` + strconv.Itoa(int(n)) + `",` +
				`"gloss":"一句話","summary":"摘要內容一段話","points":["重點一句話"]}]}`
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": body})
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

	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFetch }()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}

	RunDirectOnce(cfg, false)

	if got := atomic.LoadInt32(&contentPosts); got == 0 {
		t.Fatalf("額度用完那一輪，已完成的段落卡照樣要送上雲，got 0")
	}

	m, err := LoadManifest(cfg.manifestPathFor(root), root)
	if err != nil {
		t.Fatal(err)
	}
	e := m.Entries["手冊.md"]
	if e == nil {
		t.Fatal("manifest 應該已經記錄這個檔（不是完全沒碰過）")
	}
	if e.IngestedHash != "" {
		t.Errorf("還沒讀完的檔**不准**蓋「已送達」的章，實際 IngestedHash=%q", e.IngestedHash)
	}
	if e.FailCount != 0 {
		t.Errorf("讀不完是量體問題不是失敗，不該累計失敗次數（會走向 8 次暫停的老病），實際 FailCount=%d", e.FailCount)
	}
	if e.NextRetry != 0 {
		t.Errorf("不該被排進退避佇列（那是失敗才有的欄位），實際 NextRetry=%d", e.NextRetry)
	}

	percent, has := ExtractProgressPercent(root, "手冊.md")
	if !has || percent <= 0 || percent >= 100 {
		t.Errorf("這輪應該有部分進度（0-100 之間）：has=%v percent=%d", has, percent)
	}
}

// 🔴 第一輪停下來的原因刻意用「暫時性錯誤」（HTTP 500，不含額度用完的文案），
// 不是額度用完——額度用完會觸發帳號層級冷卻（qs.markHit → 持續好幾小時、跨輪從
// status.json 復原，見 direct.go 919 行一帶），那個冷卻窗期在測試裡去追時間點
// 沒有意義（不驗那件事，那是既有機制，額度那條路已經被上一個測試釘住）。
// 這裡要驗的是續讀機制本身：**任何**一次呼叫失敗都不該把之前的進度賠掉，
// 下一輪（不管什麼原因觸發）都該從書籤接著讀。
func TestDirect_ExtractResumable_暫時性錯誤後下一輪接著讀到完成(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 230)

	var extractHits int32
	var flaky atomic.Bool
	flaky.Store(true)
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
			if flaky.Load() && n > 1 { // 第一輪只做 1 段就撞到暫時性錯誤
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "暫時性的上游錯誤（測試用，非額度）"})
				return
			}
			body := `{"gloss":"段落` + strconv.Itoa(int(n)) + `","summary":"這是一段測試摘要文字內容",` +
				`"points":["這是一句判斷句"],"concepts":[{"name":"概念` + strconv.Itoa(int(n)) + `",` +
				`"gloss":"一句話","summary":"摘要內容一段話","points":["重點一句話"]}]}`
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": body})
			return
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
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}

	resetCloudChecks()
	RunDirectOnce(cfg, false) // 第一輪：撞到暫時性錯誤，讀不完

	m1, _ := LoadManifest(cfg.manifestPathFor(root), root)
	if e := m1.Entries["手冊.md"]; e == nil || e.IngestedHash != "" {
		t.Fatalf("第一輪不該蓋章：%+v", m1.Entries["手冊.md"])
	}

	// 錯誤消失：這一輪開始永遠成功。內容雜湊沒變（使用者沒有動過檔案），
	// 但因為上一輪沒蓋章，manifest.go 的「IngestedHash == '' 自然補一發 added 事件」
	// 應該讓 Scan() 對這個檔再產生一次事件——不需要任何人手動觸發，也不必等冷卻。
	// 🔴 段數（見 extract_resume.go extractChunkTargetBytes 的真實量測，8,000 bytes／段）
	// 可能超過單輪的 maxChunksPerInvocation，所以這裡**跑好幾輪**直到蓋章，
	// 模擬「daemon 好幾輪、每輪接著讀」，不是假設兩輪就一定讀得完。
	flaky.Store(false)
	var e2 *ManifestEntry
	for round := 0; round < 10; round++ {
		resetCloudChecks()
		res2, exit2, _ := RunDirectOnce(cfg, false)
		t.Logf("round%d exit=%d results=%+v extractHits=%d", round+2, exit2, res2, atomic.LoadInt32(&extractHits))
		if p, has := ExtractProgressPercent(root, "手冊.md"); has {
			t.Logf("round%d progress percent=%d", round+2, p)
		}
		m2, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			t.Fatal(err)
		}
		e2 = m2.Entries["手冊.md"]
		if e2 != nil && e2.IngestedHash != "" {
			break // 蓋章了，讀完了
		}
	}
	if e2 == nil {
		t.Fatal("manifest 應該還記著這個檔")
	}
	if e2.IngestedHash == "" {
		t.Errorf("額度恢復、多輪之後段數應該讀完並蓋章，實際 IngestedHash 仍是空的")
	}
}
