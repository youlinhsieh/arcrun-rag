// direct_quota_test.go — 額度用完要說人話並降速（2026-08-07 task 2）端到端驗證。
//
// 模擬 wiki mistakes.md 2026-08-06 記錄的真實上游狀況：Workers AI 每日免費額度
// 10,000 neurons 用完，HTTP 502，訊息含「4006: you have used up your daily free
// allocation of 10,000 neurons」。驗收：畫面（status.json）出現三句話，
// 沒有裸露的錯誤碼；且同一輪／下一輪不再繼續撞同一面牆。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// quotaExhaustedServer 對任何 /portal/daemon/extract 請求都回上游額度用完的原始錯誤。
// calls 只計「真的萃取」請求（body.text 非空）——ProbeWorkersAI 每輪固定會探測一次
// （送空 text，不燒 LLM 額度，見 probe_workersai.go），不是本測試要驗的「有沒有繼續撞牆」。
func quotaExhaustedServer(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Text) != "" {
			*calls++
		}
		w.WriteHeader(http.StatusBadGateway) // 實據：HTTP 502
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "4006: you have used up your daily free allocation of 10,000 neurons",
		})
	}))
}

func TestDirect_QuotaExhausted_ShowsHumanMessageNoRawCode(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "內容 A", baseTime)
	writeFile(t, root, "b.md", "內容 B", baseTime.Add(time.Minute))

	var calls int
	srv := quotaExhaustedServer(t, &calls)
	defer srv.Close()

	manifest := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifest,
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		MaxRemoved: DefaultMaxRemovedRatio,
	}

	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 1 {
		t.Fatalf("兩份都該萃取失敗，exit 應為 1，got %d", exit)
	}
	if len(results) != 2 {
		t.Fatalf("results=%+v", results)
	}

	banned := []string{"4006", "502", "HTTP", "neurons"}
	for _, r := range results {
		for _, b := range banned {
			if strings.Contains(r.Error, b) {
				t.Errorf("結果不該出現裸露的錯誤碼 %q：%q", b, r.Error)
			}
		}
		// arcrun-rag#59：這支測試裡兩份檔案全部失敗、dailyCount 全程是 0——
		// 正是 leo 實查那個「一份都沒成功、額度卻用完」的情境，buildQuotaNotice
		// 改口不再承諾「自動恢復」（那是做不到的承諾）、也不再建議換模型
		// （結構上做不到：嵌入不管選哪個萃取模型都走 Workers AI），只留「升級」這個真出口。
		for _, want := range []string{"今天已經幫你整理了", "升級 Cloudflare"} {
			if !strings.Contains(r.Error, want) {
				t.Errorf("缺三句話之一 %q：%q", want, r.Error)
			}
		}
		if strings.Contains(r.Error, "可以換一個模型") {
			t.Errorf("dailyCount==0（這輪一份都沒成功）不該再建議換模型：%q", r.Error)
		}
	}

	// status.json 也要是人話，同樣不准有裸碼
	st, err := LoadSyncStatus(StatusFilePath(manifest))
	if err != nil {
		t.Fatalf("讀 status.json 失敗：%v", err)
	}
	if st.ExtractorOK {
		t.Error("額度冷卻中，ExtractorOK 應為 false")
	}
	for _, b := range banned {
		if strings.Contains(st.ExtractorError, b) {
			t.Errorf("status.ExtractorError 不該有裸碼 %q：%q", b, st.ExtractorError)
		}
	}
	acc, ok := st.AccountDetails[instanceHostOf(srv.URL)]
	if !ok {
		t.Fatal("找不到帳號的 status")
	}
	if acc.QuotaMessage == nil {
		t.Fatal("應該有 QuotaMessage")
	}
	if acc.QuotaCooldownUntil == "" {
		t.Fatal("應該記下冷卻到什麼時候")
	}
	for _, b := range banned {
		combined := acc.QuotaMessage.Combined()
		if strings.Contains(combined, b) {
			t.Errorf("QuotaMessage 不該有裸碼 %q：%q", b, combined)
		}
	}

	// 只有第一次真的打了 API（第二份的 xerr 判斷不需要——一偵測到就進冷卻，
	// 第二個事件被上面的 qs.inCooldown 擋下，不再觸網）。
	if calls != 1 {
		t.Fatalf("偵測到額度用完後不該繼續撞牆，got %d 次呼叫", calls)
	}
}

// 同一帳號、下一輪（新的 RunDirectOnce 呼叫，模擬下一次輪詢）：冷卻還沒過，
// 一次網路呼叫都不該再打——這是「不要一次湧上去、也不要一直撞牆」的核心。
func TestDirect_QuotaExhausted_NextRunSkipsWithoutNetworkCall(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "內容 A", baseTime)

	var calls int
	srv := quotaExhaustedServer(t, &calls)
	defer srv.Close()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		MaxRemoved: DefaultMaxRemovedRatio,
	}

	if _, exit, _ := RunDirectOnce(cfg, false); exit != 1 {
		t.Fatal("第一輪應該偵測到額度用完")
	}
	if calls != 1 {
		t.Fatalf("第一輪應該只打 1 次，got %d", calls)
	}

	results2, exit2, _ := RunDirectOnce(cfg, false)
	if exit2 != 0 {
		t.Fatalf("冷卻中的 skip 不是失敗，exit 應為 0，got %d results=%+v", exit2, results2)
	}
	if calls != 1 {
		t.Fatalf("冷卻中不該再打任何一次 API，got %d 次呼叫", calls)
	}
	if len(results2) != 1 || results2[0].Status != "skipped" {
		t.Fatalf("results2=%+v", results2)
	}
	// arcrun-rag#59：這支測試同樣是 dailyCount==0（單一檔案、全程沒有成功過），
	// 跳過訊息改口成「升級 Cloudflare」這個真出口，不再是「自動恢復」的舊三句話。
	if !strings.Contains(results2[0].Error, "今天已經幫你整理了") ||
		!strings.Contains(results2[0].Error, "升級 Cloudflare") {
		t.Errorf("跳過訊息也該是三句話（新版）：%q", results2[0].Error)
	}
}
