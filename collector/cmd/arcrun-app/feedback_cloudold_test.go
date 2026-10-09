package main

import (
	"net/http"
	"testing"
)

// 雲端沒有 feedback_report（404）＝雲端太舊：回固定代碼 cloud_old，畫面把「回報」換成「更新」，不出整句（#240 c18387）。
func TestSubmitFeedback_OldCloudReturnsCode(t *testing.T) {
	tempHome(t)
	f := &feedbackFakeServer{respStatus: http.StatusNotFound, respBody: "no"}
	srv := newFeedbackFakeServer(f)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Namespace: "ns-test"})
	err := (&App{}).SubmitFeedback("測試", false)
	if err == nil || err.Error() != "cloud_old" {
		t.Fatalf("全部 404 應回 cloud_old，得到 %v", err)
	}
}
