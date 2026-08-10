// progress_wiring_test.go — t210：把 progress.go 的地基（Progress()／ClassifyFailure／
// BuildFailureBreakdown，已在 progress_test.go 單獨驗過）跟 RunDirectOnce 的接線也測一遍。
//
// 驗的是 leo 08-08 驗法①③：
//
//	① 四個數字（Done/Pending/Stuck/Unreadable）相加要等於 Total——這正是 Evan 封測
//	   回報「9000/101/20 兜不起來」的病，這裡用一輪同時湊出四種狀態的真實跑法覆現＋守住。
//	③ 斷網/閒置一輪後數字不歸零：Progress／FailureBreakdown 是**現況快照**（每輪原地
//	   重算），不是靠 CarryForwardActivity 才不歸零——這裡故意驗一輪「什麼都沒發生」
//	   （已放棄重試的跳過、還在退避窗內的跳過、已完成的沒有事件）之後數字原封不動。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestT210ProgressWiring(t *testing.T) {
	root := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 雲端版本探測與畫面無關，stub 掉避免真實網路呼叫拖慢測試（同 direct_multi_test.go 手法）。
	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	// Gemini 替身：pageName 是 "stuck" 或 "pending" 的一律萃取失敗（模擬「本地萃取失敗」
	// 這一種無法同步的成因），其餘（"ok"）成功萃出一張最簡卡片。用 prompt 裡「# <pageName>」
	// 那行分辨是哪個檔（gemmaPrompt 的契約：第一行必須是「# <pageName>」）。
	restoreGemma := gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.Contains(string(body), "「# stuck」"), strings.Contains(string(body), "「# pending」"):
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("上游炸了（測試用）"))
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"candidates": []map[string]any{{
					"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("ok", "測試")}}},
				}},
			})
		}
	})
	defer restoreGemma()

	// 雲端 ingest 端點：卡片成功送達就回 200（stuck/pending 根本不會萃出卡，不會打到這裡）。
	cypher := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer cypher.Close()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    cypher.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
		// ForceSync：測試用真實時間跑不完 1m→5m→…→6h 的退避階梯，force 讓每輪都真的嘗試，
		// 只影響「要不要重試」，不影響 FailCount 怎麼記——跟正式情境「使用者按立刻同步」是
		// 同一條路徑，不是另開後門。
		ForceSync: true,
	}

	// 先讓 stuck.md 連續失敗到 MaxFailBeforeSkip（8）次，成為「已放棄自動重試」。
	write("stuck.md", "# 原稿 stuck 內容")
	for i := 0; i < MaxFailBeforeSkip; i++ {
		if _, exit, _ := RunDirectOnce(cfg, false); exit == 0 {
			t.Fatalf("第 %d 輪應該失敗（exit!=0），卻是 0", i+1)
		}
	}

	// 同一輪裡湊齊四種狀態：ok.md 會成功（Done）、pending.md 只失敗這一輪
	// （Pending，FailCount=1 < 8）、skip.doc 是不支援的格式（Unreadable，根本沒進
	// manifest）、stuck.md 維持已放棄重試（Stuck，force 讓它再撞一次牆，FailCount 繼續
	// 往上加但不影響「已達上限」這個判斷）。
	write("ok.md", "# 原稿 ok 內容")
	write("pending.md", "# 原稿 pending 內容")
	write("skip.doc", "舊版 Word，還不支援")

	results, exit, _ := RunDirectOnce(cfg, false)
	if exit == 0 {
		t.Fatalf("這輪 stuck/pending 都會失敗，exit 不該是 0：results=%+v", results)
	}

	st, err := LoadSyncStatus(StatusFilePath(manifestPath))
	if err != nil {
		t.Fatalf("讀 status.json 失敗：%v", err)
	}

	// ── 驗法①：四個數字相加等於總數（Evan 封測的病：9000/101/20 兜不起來）──
	p := st.Progress
	t.Logf("round1 Progress=%+v FailureBreakdown=%+v", p, st.FailureBreakdown)
	if sum := p.Done + p.Pending + p.Stuck + p.Unreadable; sum != p.Total {
		t.Fatalf("🔴 數字對不起來：%d+%d+%d+%d=%d ≠ 總數 %d\n完整 Progress=%+v",
			p.Done, p.Pending, p.Stuck, p.Unreadable, sum, p.Total, p)
	}
	if p.Done != 1 {
		t.Errorf("Done 應為 1（ok.md），got %d", p.Done)
	}
	if p.Pending != 1 {
		t.Errorf("Pending 應為 1（pending.md，FailCount=1 < %d），got %d", MaxFailBeforeSkip, p.Pending)
	}
	if p.Stuck < 1 {
		t.Errorf("Stuck 應至少 1（stuck.md 已達 %d 次失敗上限），got %d", MaxFailBeforeSkip, p.Stuck)
	}
	if p.Unreadable != 1 {
		t.Errorf("Unreadable 應為 1（skip.doc，G-6.2 白名單擋下、根本沒進 manifest），got %d", p.Unreadable)
	}
	if p.Total != 4 {
		t.Errorf("Total 應為 4（ok+pending+stuck+skip），got %d（%+v）", p.Total, p)
	}

	// FailureBreakdown 的分組加總要等於「送不上去」（Stuck+Unreadable），
	// 且只有分類與份數——不含檔名、不含解法（呼叫端／前端都不該認得分類名稱，
	// 這裡只是照 collector 已經分好的結果核對總量，不重新判斷）。
	wantCantSync := p.Stuck + p.Unreadable
	if st.FailureBreakdown.Total != wantCantSync {
		t.Fatalf("FailureBreakdown.Total=%d，應等於 Stuck+Unreadable=%d", st.FailureBreakdown.Total, wantCantSync)
	}
	groupSum := 0
	for _, g := range st.FailureBreakdown.Groups {
		groupSum += g.Count
	}
	if groupSum != wantCantSync {
		t.Fatalf("FailureBreakdown.Groups 加總=%d，應等於 %d：%+v", groupSum, wantCantSync, st.FailureBreakdown.Groups)
	}
	// Unreadable 那一份必然分類成「格式不支援」（G-6.2 白名單擋下的定義就是這樣）。
	foundUnsupported := false
	for _, g := range st.FailureBreakdown.Groups {
		if g.Category == FailUnsupportedFormat {
			foundUnsupported = true
		}
	}
	if !foundUnsupported {
		t.Errorf("skip.doc 應該被分類進「%s」，實際分組：%+v", FailUnsupportedFormat, st.FailureBreakdown.Groups)
	}

	// ── 驗法③：斷網／閒置一輪後數字不歸零（現況快照，不是本輪計數）──
	// 這輪關掉 ForceSync：stuck.md 已達上限、pending.md 還在退避窗內、ok.md 內容沒變，
	// 全部不會真的觸發任何萃取/上傳動作——模擬「斷網一輪」或「什麼都沒發生的一輪」。
	// exit 值不重要（上一輪的失敗紀錄可能還在別的欄位），重點是 Progress 有沒有被清空。
	cfg.ForceSync = false
	RunDirectOnce(cfg, false)

	st2, err := LoadSyncStatus(StatusFilePath(manifestPath))
	if err != nil {
		t.Fatalf("讀第二次 status.json 失敗：%v", err)
	}
	t.Logf("round2(idle) Progress=%+v FailureBreakdown=%+v", st2.Progress, st2.FailureBreakdown)
	if st2.Progress != p {
		t.Fatalf("🔴 閒置一輪後數字變了（不該歸零/不該亂動）：before=%+v after=%+v", p, st2.Progress)
	}
}
