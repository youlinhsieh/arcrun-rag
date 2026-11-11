package collector

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// #330：用真的 HTTP 傳輸造出三種失敗，確認「被中途切斷」「等不到回應」不再被講成「網路連不上」。
// 不是拿字串比字串——錯誤文字是 net/http 真的吐出來的。

func ledgerKindOfCall(t *testing.T, call func() error) (string, string) {
	t.Helper()
	err := call()
	if err == nil {
		t.Fatal("應該要失敗")
	}
	msg := err.Error()
	e := map[string]*ManifestEntry{"NRI.pdf": {ContentHash: "h", FailCount: 9, LastError: msg}}
	l := BuildLedgerSummary(e, time.Unix(1, 0))
	if len(l.Reasons) != 1 {
		t.Fatalf("reasons：%+v", l.Reasons)
	}
	return l.Reasons[0].Kind, msg
}

func TestCloudCallErr_中途被切斷不是網路(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		conn.Close() // 收到請求就掛斷：client 看到 EOF
	}))
	defer srv.Close()
	read := cloudImageReader(&http.Client{Timeout: 5 * time.Second}, srv.URL, "k")
	kind, msg := ledgerKindOfCall(t, func() error { _, err := read(ImageReadRequest{PageName: "p", PNG: []byte("x")}); return err })
	if kind != LedgerKindConnectionCut {
		t.Fatalf("被切斷應歸 connection_cut，得 %q（%s）", kind, msg)
	}
	if strings.Contains(msg, "連不上你的知識庫") {
		t.Errorf("被切斷不能講成連不上：%s", msg)
	}
	if !isTransientCloudText(msg) {
		t.Errorf("被切斷要照暫時性錯誤自動續試：%s", msg)
	}
}

func TestCloudCallErr_等不到回應不是網路(t *testing.T) {
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-done }))
	defer srv.Close()
	defer close(done)
	read := cloudImageReader(&http.Client{Timeout: 150 * time.Millisecond}, srv.URL, "k")
	kind, msg := ledgerKindOfCall(t, func() error { _, err := read(ImageReadRequest{PageName: "p", PNG: []byte("x")}); return err })
	if kind != LedgerKindCloudSlow {
		t.Fatalf("逾時應歸 cloud_slow，得 %q（%s）", kind, msg)
	}
}

func TestCloudCallErr_真的連不上才是網路(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close() // 沒人聽的埠：dial 被拒
	read := cloudImageReader(&http.Client{Timeout: 2 * time.Second}, "http://"+addr, "k")
	kind, msg := ledgerKindOfCall(t, func() error { _, err := read(ImageReadRequest{PageName: "p", PNG: []byte("x")}); return err })
	if kind != LedgerKindNetwork {
		t.Fatalf("連線被拒才是 network，得 %q（%s）", kind, msg)
	}
	if !strings.Contains(msg, "連不上你的知識庫") {
		t.Errorf("本機真的連不上，仍要這句：%s", msg)
	}
}
