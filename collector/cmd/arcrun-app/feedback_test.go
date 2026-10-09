package main

// feedback_test.go — SubmitFeedback（inkstone/arcrun-rag#210）
//
// 涵蓋票上寫死的判準：
//   ① 空白內容不准送出（不是靜默失敗，是講清楚要先寫東西）
//   ② 沒有連線帳號 = 講清楚原因，不是裸錯誤
//   ③ 真的 POST 到 /webhooks/named/{ns}/feedback_report/trigger，帶對 header／欄位
//   ④ HTTP 非 2xx = 「沒送出去，請再試一次」（失敗才算送出失敗）
//   ⑤ HTTP 200 但工作流內層回報失敗 = 一樣算送出失敗，不是靜默吞掉
//   ⑥ 成功時不回傳任何錯誤
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSubmitFeedback_EmptyTextRejected(t *testing.T) {
	tempHome(t)
	a := &App{}
	err := a.SubmitFeedback("   ", false)
	if err == nil || !strings.Contains(err.Error(), "請先寫下") {
		t.Fatalf("want 講清楚要先寫內容, got %v", err)
	}
}

func TestSubmitFeedback_NoAccountRejected(t *testing.T) {
	tempHome(t) // 沒有寫任何 config.json
	a := &App{}
	err := a.SubmitFeedback("搜尋找不到我上禮拜存的筆記", false)
	if err == nil || !strings.Contains(err.Error(), "沒有地方可以送出") {
		t.Fatalf("want 講清楚沒有連線帳號, got %v", err)
	}
}

// feedbackFakeServer 記錄它收到的 request，讓測試斷言 method/path/header/body。
type feedbackFakeServer struct {
	gotPath    string
	gotMethod  string
	gotAPIKey  string
	gotBody    map[string]any
	respStatus int
	respBody   string
}

func newFeedbackFakeServer(f *feedbackFakeServer) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.gotPath = r.URL.Path
		f.gotMethod = r.Method
		f.gotAPIKey = r.Header.Get("X-Arcrun-API-Key")
		_ = json.NewDecoder(r.Body).Decode(&f.gotBody)
		if f.respStatus == 0 {
			f.respStatus = http.StatusOK
		}
		w.WriteHeader(f.respStatus)
		_, _ = w.Write([]byte(f.respBody))
	}))
}

func TestSubmitFeedback_PostsToNamedWebhookAndSucceeds(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":true}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Namespace: "ns-test"})

	a := &App{}
	if err := a.SubmitFeedback("搜尋一直轉圈圈，等了五分鐘沒有結果", false); err != nil {
		t.Fatalf("want 送出成功, got error: %v", err)
	}

	if f.gotMethod != http.MethodPost {
		t.Errorf("want POST, got %s", f.gotMethod)
	}
	wantPath := "/webhooks/named/ns-test/feedback_report/trigger"
	if f.gotPath != wantPath {
		t.Errorf("want path %s, got %s", wantPath, f.gotPath)
	}
	if f.gotAPIKey != "ns-test" {
		t.Errorf("want X-Arcrun-API-Key=ns-test, got %q", f.gotAPIKey)
	}
	if f.gotBody["text"] != "搜尋一直轉圈圈，等了五分鐘沒有結果" {
		t.Errorf("body.text 沒帶到原文：%v", f.gotBody)
	}
	if f.gotBody["instance"] != "ns-test" {
		t.Errorf("body.instance 應退回 namespace，got %v", f.gotBody["instance"])
	}
	if _, hasOS := f.gotBody["os"]; !hasOS {
		t.Errorf("body 缺 os 欄位：%v", f.gotBody)
	}
	if _, hasDiag := f.gotBody["diagnostics"]; hasDiag {
		t.Errorf("attachDiagnostics=false 時不該帶 diagnostics 欄位：%v", f.gotBody)
	}
}

func TestSubmitFeedback_NonOKStatusIsSendFailure(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusInternalServerError, respBody: `boom`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Namespace: "ns-test"})

	a := &App{}
	err := a.SubmitFeedback("測試", false)
	if err == nil || !strings.Contains(err.Error(), "沒送出去") {
		t.Fatalf("want 沒送出去請再試一次, got %v", err)
	}
}

func TestSubmitFeedback_InnerWorkflowFailureIsSendFailure(t *testing.T) {
	tempHome(t)
	// HTTP 200，但工作流自己判斷失敗（例如 Gitea 開票那步壞了）——
	// 這種「外層成功、內層失敗」正是 wiki 記過的坑（票 comment 10305），不能被當成送出成功。
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":false,"error":"開票失敗：缺 repo 參數"}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Namespace: "ns-test"})

	a := &App{}
	err := a.SubmitFeedback("測試", false)
	if err == nil || !strings.Contains(err.Error(), "缺 repo 參數") {
		t.Fatalf("want 帶出內層錯誤原因, got %v", err)
	}
}

// writeCfgWithAccounts 寫多帳號 config（writeCfgWithAccount 只寫一個）。
func writeCfgWithAccounts(t *testing.T, accs ...accountCfg) {
	t.Helper()
	cfg := map[string]any{
		"manifest": filepath.Join(appDir(), "manifest.json"),
		"accounts": accs,
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// 2026-09-29 Mac 實測 bug：accounts[0] 雲端太舊（404）＋ accounts[1] 正常
// ⇒ 應該改送 accounts[1] 成功，而不是死在第一個。
func TestSubmitFeedback_FallsBackToNextAccountWhenFirstIs404(t *testing.T) {
	tempHome(t)
	old := &feedbackFakeServer{respStatus: http.StatusNotFound, respBody: `請先執行 acr push`}
	oldSrv := newFeedbackFakeServer(old)
	defer oldSrv.Close()
	good := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":true}}`}
	goodSrv := newFeedbackFakeServer(good)
	defer goodSrv.Close()
	writeCfgWithAccounts(t,
		accountCfg{CypherURL: oldSrv.URL, Namespace: "ns-old"},
		accountCfg{CypherURL: goodSrv.URL, Namespace: "ns-good"})

	a := &App{}
	if err := a.SubmitFeedback("按問號送回報", false); err != nil {
		t.Fatalf("want 換第二個帳號送成功, got %v", err)
	}
	if old.gotPath == "" {
		t.Errorf("第一個帳號應該有被試過")
	}
	if good.gotPath != "/webhooks/named/ns-good/feedback_report/trigger" {
		t.Errorf("第二個帳號沒收到回報，path=%q", good.gotPath)
	}
}

// 所有帳號都 404 ⇒ 人話（雲端太舊、去 Portal 更新），絕不外洩開發者指令。
func TestSubmitFeedback_All404GivesHumanMessageNoDevCommand(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusNotFound, respBody: `workflow not found，請先執行 acr push`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccounts(t, accountCfg{CypherURL: srv.URL, Namespace: "ns-old"})

	a := &App{}
	err := a.SubmitFeedback("測試", false)
	if err == nil {
		t.Fatal("want error")
	}
	msg := err.Error()
	if strings.Contains(msg, "acr") || strings.Contains(msg, "404") || strings.Contains(msg, "not found") {
		t.Errorf("錯誤訊息不該含開發者指令／原始回應：%q", msg)
	}
	if msg != "cloud_old" {
		t.Errorf("雲端太舊要回固定代碼 cloud_old（畫面換成「更新」鈕，#240 c18387），got %q", msg)
	}
}

// 非 404 的伺服器錯誤也不倒出伺服器原文。
func TestSubmitFeedback_5xxDoesNotLeakServerBody(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusInternalServerError, respBody: `請先執行 acr push`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Namespace: "ns-test"})
	err := (&App{}).SubmitFeedback("測試", false)
	if err == nil || strings.Contains(err.Error(), "acr") {
		t.Fatalf("want 人話且不含 acr, got %v", err)
	}
}

func TestFeedbackWorkflowURL_TrimsTrailingSlash(t *testing.T) {
	got := feedbackWorkflowURL("https://arcrun-cypher-executor.example.workers.dev/", "ns-test")
	want := "https://arcrun-cypher-executor.example.workers.dev/webhooks/named/ns-test/feedback_report/trigger"
	if got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestFirstNonEmptyFeedback(t *testing.T) {
	if got := firstNonEmptyFeedback("", "  ", "b"); got != "b" {
		t.Errorf("want b, got %s", got)
	}
	if got := firstNonEmptyFeedback("", ""); got != "unknown" {
		t.Errorf("want unknown fallback, got %s", got)
	}
}
