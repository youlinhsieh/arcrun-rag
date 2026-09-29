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
