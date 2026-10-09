package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	setupStalledAccount(t, srv.URL, 5, "雲端沒有把這一份寫進你的知識庫，稍後會自動再試。")

	cfg, _ := loadCfg()
	stalls := uiStalls(cfg)
	if len(stalls) != 1 || stalls[0].Count != 5 || stalls[0].Reported || stalls[0].Account != "geek6688" {
		t.Fatalf("應有 1 張未回報的卡：%+v", stalls)
	}

	a := &App{}
	if err := a.ReportStall(stalls[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	text, _ := f.gotBody["text"].(string)
	for _, want := range []string{"停工份數：5", "geek6688", "cloud_write", "小幫手版本", "錯誤原文", "160-00A_002.md"} {
		if !strings.Contains(text, want) {
			t.Errorf("回報缺「%s」：\n%s", want, text)
		}
	}
	if strings.Contains(text, "error_codes") {
		t.Errorf("不該帶資料夾路徑：\n%s", text)
	}
	if f.gotPath != "/webhooks/named/ns-test/feedback_report/trigger" {
		t.Errorf("應走既有回報通道，got %s", f.gotPath)
	}

	// 回報後：卡片標已回報；再按不再送第二張票
	f.gotPath = ""
	cachedStalls(cfg, true)
	again := uiStalls(cfg)
	if len(again) != 1 || !again[0].Reported {
		t.Fatalf("回報後應標已回報：%+v", again)
	}
	if err := a.ReportStall(stalls[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if f.gotPath != "" {
		t.Fatal("已回報的原因不該再送一次")
	}
}

func TestStalls_SendFailureNotMarkedReported(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusInternalServerError}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	setupStalledAccount(t, srv.URL, 4, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	s := uiStalls(cfg)
	if len(s) != 1 {
		t.Fatalf("%+v", s)
	}
	if err := (&App{}).ReportStall(s[0].Fingerprint); err == nil {
		t.Fatal("送不出去應回錯誤，讓用戶可再按")
	}
	cachedStalls(cfg, true)
	if again := uiStalls(cfg); again[0].Reported {
		t.Fatal("送失敗不能標已回報")
	}
}

func TestStalls_FewFilesNoCard(t *testing.T) {
	tempHome(t)
	setupStalledAccount(t, "http://127.0.0.1:1", 2, "品質未過（不送）：H1: x")
	cfg, _ := loadCfg()
	if s := uiStalls(cfg); len(s) != 0 {
		t.Fatalf("2 份不到門檻：%+v", s)
	}
}
