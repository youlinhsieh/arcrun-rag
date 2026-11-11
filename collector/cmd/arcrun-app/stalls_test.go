package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
)

// 在 tempHome 裡造一個「geek 風格」的帳本：N 份因同一個原因停工。
func setupStalledAccount(t *testing.T, srvURL string, n int, lastErr string) (watch string) {
	t.Helper()
	watch = filepath.Join(t.TempDir(), "error_codes")
	if err := os.MkdirAll(watch, 0o755); err != nil {
		t.Fatal(err)
	}
	writeCfgWithAccount(t, srvURL, accountCfg{Namespace: "ns-test", InstanceName: "geek6688", WatchFolders: []string{watch}})
	base := filepath.Join(appDir(), "manifest.json")
	mp := collector.ManifestPathFor(base, srvURL, watch)
	m := &collector.Manifest{FolderID: "t", Root: watch, Entries: map[string]*collector.ManifestEntry{}}
	for i := 0; i < n; i++ {
		m.Entries["160-00"+string(rune('A'+i))+"_002.md"] = &collector.ManifestEntry{
			ContentHash: "h", FailCount: 8, LastError: lastErr, FailLintRev: 2}
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	return watch
}

func TestStalls_CardShownThenReportedOnceNoContent(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":true}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")
	setupStalledAccount(t, srv.URL, 5, "雲端沒有把這一份寫進你的知識庫，稍後會自動再試。")

	cfg, _ := loadCfg()
	stalls := uiStalls(cfg)
	if len(stalls) != 1 || stalls[0].Count != 5 || stalls[0].Reported || stalls[0].Account != "geek6688" {
		t.Fatalf("應有 1 張未回報的卡：%+v", stalls)
	}

	a := &App{}
	// 🔴 #330：沒看過內容就同意＝拒絕，什麼都不送
	if err := a.ReportStall(stalls[0].Fingerprint); err == nil || f.hits != 0 {
		t.Fatalf("沒先看內容不准寄：err=%v hits=%d", err, f.hits)
	}
	shown, err := a.StallPreview(stalls[0].Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if f.gotPath == "/webhooks/named/inbox-feedback/feedback_report/trigger" {
		t.Fatal("看內容只是預覽，不能送出任何東西")
	}
	if err := a.ReportStall(stalls[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	text, _ := f.gotBody["text"].(string)
	if !strings.Contains(shown, text) {
		t.Errorf("寄出去的文字必須是給用戶看過的那一份。\n看到：%s\n寄出：%s", shown, text)
	}
	if _, ok := f.gotBody["diagnostics"]; !ok {
		t.Error("要附診斷資料（預覽裡也看得到）")
	}
	for _, want := range []string{"停工份數：5", "geek6688", "cloud_write", "小幫手版本", "錯誤原文", "160-00A_002.md"} {
		if !strings.Contains(text, want) {
			t.Errorf("回報缺「%s」：\n%s", want, text)
		}
	}
	if strings.Contains(text, "error_codes") {
		t.Errorf("不該帶資料夾路徑：\n%s", text)
	}
	if f.gotPath != "/webhooks/named/inbox-feedback/feedback_report/trigger" {
		t.Errorf("應走既有回報通道，got %s", f.gotPath)
	}

	// 回報後：卡片標已回報；再按不再送第二張票
	f.gotPath = ""
	cachedStalls(cfg, true)
	again := uiStalls(cfg)
	if len(again) != 1 || !again[0].Reported || again[0].State != stallReported {
		t.Fatalf("回報後應標已回報：%+v", again)
	}
	if _, err := a.StallPreview(stalls[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := a.ReportStall(stalls[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if f.gotPath == "/webhooks/named/inbox-feedback/feedback_report/trigger" {
		t.Fatal("已回報的原因不該再送一次")
	}
}

func TestStalls_SendFailureNotMarkedReported(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusInternalServerError}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")
	setupStalledAccount(t, srv.URL, 4, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	s := uiStalls(cfg)
	if len(s) != 1 {
		t.Fatalf("%+v", s)
	}
	if _, err := (&App{}).StallPreview(s[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).ReportStall(s[0].Fingerprint); err == nil {
		t.Fatal("送不出去應回錯誤，讓用戶可再按")
	}
	cachedStalls(cfg, true)
	if again := uiStalls(cfg); again[0].Reported {
		t.Fatal("送失敗不能標已回報")
	}
}

// #330：自己修不了的，一份就該問（leo 11-11 的 NRI 就是 2 份）；自己會好的不打擾。
func TestStalls_OneOrTwoFilesAskWhenSelfHealExhausted(t *testing.T) {
	tempHome(t)
	setupStalledAccount(t, "http://127.0.0.1:1", 2, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	s := uiStalls(cfg)
	if len(s) != 1 || s[0].State != stallAsk || s[0].Count != 2 {
		t.Fatalf("修不了的 2 份也要問：%+v", s)
	}
}

func TestStalls_SelfHealingKindsNeverAskUser(t *testing.T) {
	for name, e := range map[string]string{
		"額度":   "雲端萃取失敗（HTTP 429）：4006: you have used up your daily free allocation of 10,000 neurons",
		"本機斷網": "連不上你的知識庫：Post x: dial tcp: lookup h: no such host",
	} {
		tempHome(t)
		setupStalledAccount(t, "http://127.0.0.1:1", 3, e)
		cfg, _ := loadCfg()
		if s := uiStalls(cfg); len(s) != 0 {
			t.Errorf("%s：小幫手自己等得好，不該問用戶：%+v", name, s)
		}
	}
}

func TestStalls_ConnectionCutOnlyAsksAfterRetriesExhausted(t *testing.T) {
	cut := "連線在中途被切斷（Post \"https://h/portal/daemon/extract\": unexpected EOF）"
	tempHome(t)
	w := setupStalledAccount(t, "http://127.0.0.1:1", 2, cut) // FailCount 8：自動續試還在跑
	cfg, _ := loadCfg()
	if s := uiStalls(cfg); len(s) != 0 {
		t.Fatalf("續試還沒用完，不該打擾用戶：%+v", s)
	}
	base := filepath.Join(appDir(), "manifest.json")
	mp := collector.ManifestPathFor(base, "http://127.0.0.1:1", w)
	m, _ := collector.LoadManifest(mp, w)
	for _, e := range m.Entries {
		e.FailCount = 12
	}
	_ = m.Save(mp)
	cachedStalls(cfg, true)
	s := uiStalls(cfg)
	if len(s) != 1 || s[0].State != stallAsk {
		t.Fatalf("續試也用完了，才問：%+v", s)
	}
}

func TestStalls_DeclineWritesNothingAndStopsAsking(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":true}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")
	setupStalledAccount(t, srv.URL, 3, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	s := uiStalls(cfg)
	if len(s) != 1 {
		t.Fatalf("%+v", s)
	}
	if err := (&App{}).DeclineStall(s[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if f.hits != 0 {
		t.Fatal("不同意＝什麼都不寄")
	}
	if again := uiStalls(cfg); len(again) != 0 {
		t.Fatalf("說不用了之後不該再問：%+v", again)
	}
	// 之後即使有人硬呼叫同意，也沒有預覽記錄 ⇒ 拒絕
	if err := (&App{}).ReportStall(s[0].Fingerprint); err == nil || f.hits != 0 {
		t.Fatal("說過不用了的，沒預覽不准寄")
	}
}

func TestStalls_ReportedShowsTicketThenFixedWhenProblemGone(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respBody: `{"success":true,"data":{"success":true,"data":{"repo":"inkstone/arcrun-rag","number":4321}}}`}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL+"/webhooks/named/inbox-feedback/feedback_report/trigger")
	w := setupStalledAccount(t, srv.URL, 3, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	s := uiStalls(cfg)
	a := &App{}
	if _, err := a.StallPreview(s[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := a.ReportStall(s[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	cachedStalls(cfg, true)
	r := uiStalls(cfg)
	if len(r) != 1 || r[0].State != stallReported || r[0].Ticket != "inkstone/arcrun-rag#4321" {
		t.Fatalf("已通報要帶票號：%+v", r)
	}
	// collector 看得到用戶的決定：送件帳的這個原因變成 reported＋票號
	st := collector.LoadHelpStore(collector.HelpStatePath(filepath.Join(appDir(), "manifest.json")))
	l := collector.BuildLedgerSummaryFor(map[string]*collector.ManifestEntry{
		"a.md": {ContentHash: "h", FailCount: 8, LastError: "品質未過（不送）：H1: x"}}, time.Now(), r0host(srv.URL), st)
	if len(l.Reasons) != 1 || l.Reasons[0].Handling != collector.HandlingReported || l.Reasons[0].Ticket != "inkstone/arcrun-rag#4321" {
		t.Fatalf("送件帳要帶 reported＋票號：%+v", l.Reasons)
	}
	// 問題沒了（帳本清空）⇒ 已修好
	mp := collector.ManifestPathFor(filepath.Join(appDir(), "manifest.json"), srv.URL, w)
	m, _ := collector.LoadManifest(mp, w)
	for _, e := range m.Entries {
		e.FailCount, e.LastError, e.IngestedHash = 0, "", e.ContentHash
	}
	_ = m.Save(mp)
	cachedStalls(cfg, true)
	fx := uiStalls(cfg)
	if len(fx) != 1 || fx[0].State != stallFixed || fx[0].Ticket != "inkstone/arcrun-rag#4321" {
		t.Fatalf("問題沒了要變已修好：%+v", fx)
	}
}

func r0host(u string) string { return strings.TrimPrefix(u, "http://") }
