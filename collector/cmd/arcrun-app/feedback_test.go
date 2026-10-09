package main

// feedback_test.go — SubmitFeedback（inkstone/arcrun-rag#210、#235）
//
// 涵蓋的判準：
//   ① 空白內容不准送出
//   ② 🔴 #235：回報**直接送到我們的收件端**，用戶自己的實例一個 request 都不碰；
//      沒連任何知識庫也送得出去
//   ③ 🔴 #235：namespace（＝self-hosted 的 API key）不出現在 URL、header、body 任何一處
//   ④ HTTP 非 2xx／內層失敗 ＝ 送出失敗，人話、不洩伺服器原文
//   ⑤ 防濫用：本機每小時上限，超過不碰網路；失敗不計次；一小時後恢復
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmitFeedback_EmptyTextRejected(t *testing.T) {
	tempHome(t)
	err := (&App{}).SubmitFeedback("   ", false)
	if err == nil || !strings.Contains(err.Error(), "請先寫下") {
		t.Fatalf("want 講清楚要先寫內容, got %v", err)
	}
}

// feedbackFakeServer 記錄它收到的 request，讓測試斷言 method/path/header/body。
type feedbackFakeServer struct {
	hits       int32
	gotPath    string
	gotMethod  string
	gotAPIKey  string
	gotRaw     string
	gotBody    map[string]any
	respStatus int
	respBody   string
}

func newFeedbackFakeServer(f *feedbackFakeServer) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&f.hits, 1)
		f.gotPath = r.URL.Path
		f.gotMethod = r.Method
		f.gotAPIKey = r.Header.Get("X-Arcrun-API-Key")
		var buf strings.Builder
		dec := json.NewDecoder(r.Body)
		_ = dec.Decode(&f.gotBody)
		b, _ := json.Marshal(f.gotBody)
		buf.Write(b)
		f.gotRaw = buf.String()
		if f.respStatus == 0 {
			f.respStatus = http.StatusOK
		}
		w.WriteHeader(f.respStatus)
		_, _ = w.Write([]byte(f.respBody))
	}))
}

const feedbackOK = `{"success":true,"data":{"success":true,"number":9}}`

// 送到收件端：POST、不帶任何金鑰 header、body 有原文／版本／OS。沒連知識庫也能送。
func TestSubmitFeedback_GoesToInboxWithoutAnyAccount(t *testing.T) {
	tempHome(t) // 沒有 config.json
	inbox := &feedbackFakeServer{respBody: feedbackOK}
	srv := newFeedbackFakeServer(inbox)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")

	if err := (&App{}).SubmitFeedback("搜尋一直轉圈圈，等了五分鐘沒有結果", false); err != nil {
		t.Fatalf("want 送出成功, got %v", err)
	}
	if inbox.gotMethod != http.MethodPost {
		t.Errorf("want POST, got %s", inbox.gotMethod)
	}
	if inbox.gotPath != "/webhooks/named/inbox-feedback/feedback_report/trigger" {
		t.Errorf("path=%q", inbox.gotPath)
	}
	if inbox.gotAPIKey != "" {
		t.Errorf("用戶端不該帶任何金鑰 header，got %q", inbox.gotAPIKey)
	}
	if inbox.gotBody["text"] != "搜尋一直轉圈圈，等了五分鐘沒有結果" {
		t.Errorf("body.text 沒帶到原文：%v", inbox.gotBody)
	}
	if _, ok := inbox.gotBody["os"]; !ok {
		t.Errorf("body 缺 os：%v", inbox.gotBody)
	}
	if inbox.gotBody["instance"] != "（尚未連上知識庫）" {
		t.Errorf("沒連知識庫時 instance 應誠實標示，got %v", inbox.gotBody["instance"])
	}
	if _, has := inbox.gotBody["diagnostics"]; has {
		t.Errorf("attachDiagnostics=false 不該帶 diagnostics")
	}
}

// 🔴 #235 核心：用戶自己的實例一個 request 都不碰；namespace 不外洩到收件端。
func TestSubmitFeedback_NeverTouchesUsersOwnInstance_NoNamespaceLeak(t *testing.T) {
	tempHome(t)
	own := &feedbackFakeServer{respBody: `should not be called`}
	ownSrv := newFeedbackFakeServer(own)
	defer ownSrv.Close()
	inbox := &feedbackFakeServer{respBody: feedbackOK}
	inboxSrv := newFeedbackFakeServer(inbox)
	defer inboxSrv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", inboxSrv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")
	writeCfgWithAccount(t, ownSrv.URL, accountCfg{Namespace: "ns-SECRET-key", InstanceName: "我的公司知識庫"})

	if err := (&App{}).SubmitFeedback("按問號送回報", false); err != nil {
		t.Fatalf("want 成功, got %v", err)
	}
	if atomic.LoadInt32(&own.hits) != 0 {
		t.Fatalf("用戶自己的實例被打了 %d 次——回報不該經過它", own.hits)
	}
	if inbox.gotBody["instance"] != "我的公司知識庫" {
		t.Errorf("instance 應是顯示名，got %v", inbox.gotBody["instance"])
	}
	if strings.Contains(inbox.gotRaw, "ns-SECRET-key") || strings.Contains(inbox.gotPath, "ns-SECRET-key") || inbox.gotAPIKey != "" {
		t.Errorf("namespace 外洩：raw=%s path=%s key=%q", inbox.gotRaw, inbox.gotPath, inbox.gotAPIKey)
	}
}

func TestFeedbackInboxURL_DefaultIsOurCentralService(t *testing.T) {
	t.Setenv("ARCRUN_FEEDBACK_INBOX", "")
	want := "https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev/webhooks/named/inbox-feedback/feedback_report/trigger"
	if got := feedbackInboxURL(); got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestSubmitFeedback_AttachDiagnosticsAddsField(t *testing.T) {
	tempHome(t)
	inbox := &feedbackFakeServer{respBody: feedbackOK}
	srv := newFeedbackFakeServer(inbox)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/x")
	if err := (&App{}).SubmitFeedback("測試", true); err != nil {
		t.Fatalf("got %v", err)
	}
	if _, has := inbox.gotBody["diagnostics"]; !has {
		t.Errorf("attachDiagnostics=true 應帶 diagnostics：%v", inbox.gotBody)
	}
}

func TestSubmitFeedback_NonOKStatusIsSendFailure_NoServerBodyLeak(t *testing.T) {
	for _, code := range []int{404, 500} {
		tempHome(t)
		f := &feedbackFakeServer{respStatus: code, respBody: `請先執行 acr push workflow not found`}
		srv := newFeedbackFakeServer(f)
		t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/x")
		err := (&App{}).SubmitFeedback("測試", false)
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), "沒送出去") {
			t.Fatalf("code %d: want 沒送出去, got %v", code, err)
		}
		if m := err.Error(); strings.Contains(m, "acr") || strings.Contains(m, "not found") || m == "cloud_old" {
			t.Errorf("code %d: 錯誤不該含開發者指令／原文：%q", code, m)
		}
	}
}

func TestSubmitFeedback_InnerWorkflowFailureIsSendFailure(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":false,"error":"開票失敗：缺 repo 參數"}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/x")
	err := (&App{}).SubmitFeedback("測試", false)
	if err == nil || !strings.Contains(err.Error(), "缺 repo 參數") {
		t.Fatalf("want 帶出內層錯誤原因, got %v", err)
	}
}

// 防濫用：連送 feedbackMaxPerHour 則成功後，下一則不碰網路就被擋；失敗不計次。
func TestSubmitFeedback_RateLimitPerMachine(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: feedbackOK}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/x")
	a := &App{}
	for i := 0; i < feedbackMaxPerHour; i++ {
		if err := a.SubmitFeedback("第幾則", false); err != nil {
			t.Fatalf("第 %d 則應成功：%v", i+1, err)
		}
	}
	before := atomic.LoadInt32(&f.hits)
	err := a.SubmitFeedback("太多了", false)
	if err == nil || !strings.Contains(err.Error(), "太多") {
		t.Fatalf("want 太頻繁人話, got %v", err)
	}
	if atomic.LoadInt32(&f.hits) != before {
		t.Errorf("被擋的那則不該碰網路")
	}
	// 一小時前的紀錄不計
	old := make([]int64, feedbackMaxPerHour)
	for i := range old {
		old[i] = time.Now().Add(-2 * time.Hour).Unix()
	}
	b, _ := json.Marshal(old)
	if err := os.WriteFile(feedbackSentPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.SubmitFeedback("隔了一小時", false); err != nil {
		t.Fatalf("一小時後應恢復：%v", err)
	}
}

func TestSubmitFeedback_FailuresDoNotCountTowardLimit(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: 500, respBody: "boom"}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/x")
	a := &App{}
	for i := 0; i < feedbackMaxPerHour+2; i++ {
		err := a.SubmitFeedback("重試", false)
		if err == nil || strings.Contains(err.Error(), "太多") {
			t.Fatalf("失敗不該計入上限（第 %d 次）：%v", i+1, err)
		}
	}
}
