package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#389：伺服器把自己的對外網址存成 127.0.0.1（大前試裝 7b／7f），小幫手不能跟著連到「同仁自己的電腦」。
func TestFixLoopbackURL(t *testing.T) {
	cases := []struct{ got, reached, want string }{
		{"http://127.0.0.1:8081", "http://172.18.0.2:8081", "http://172.18.0.2:8081"},
		{"http://localhost:8081", "http://corp-kb.lan:8080", "http://corp-kb.lan:8081"}, // 埠沿用伺服器說的，主機換成連得通的
		{"http://0.0.0.0:8081/", "http://10.1.2.3:8081", "http://10.1.2.3:8081"},
		{"http://192.168.1.20:8081", "http://192.168.1.20:8081", "http://192.168.1.20:8081"}, // 本來就對：不動
		{"http://127.0.0.1:8081", "http://127.0.0.1:8080", "http://127.0.0.1:8081"},          // 同一台機器上試：不動
		{"https://arcrun-cypher-executor.x.workers.dev", "https://arcrun-cypher-executor.x.workers.dev", "https://arcrun-cypher-executor.x.workers.dev"},
		{"", "http://10.1.2.3:8081", ""},
	}
	for _, c := range cases {
		if got := fixLoopbackURL(c.got, c.reached); got != c.want {
			t.Errorf("fixLoopbackURL(%q,%q)=%q 想要 %q", c.got, c.reached, got, c.want)
		}
	}
}

// 網頁的 /config.js 寫 127.0.0.1：discoverAPIBase 要換成我們打進來的主機。
func TestDiscoverAPIBaseLoopbackFixed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`window.ARCRUN_CONFIG = { apiBase: "http://127.0.0.1:8081" };`))
	}))
	defer srv.Close()
	// 打進來的是 localhost 名稱以外的主機名（用 127.0.0.2 代表「另一個位址」不行——都是回送）。
	// 這裡驗「兩邊都是回送時不動」；換主機的行為由 TestFixLoopbackURL 覆蓋。
	got := discoverAPIBase(srv.URL)
	if !strings.HasPrefix(got, "http://127.0.0.1:8081") {
		t.Fatalf("同機試用不該被改：%q", got)
	}
}

// config.js 兩種寫法都要認得（雲端版 `apiBase: "…"`；JSON 寫法 `"apiBase":"…"`）。
func TestDiscoverAPIBaseKeyStyles(t *testing.T) {
	for _, body := range []string{`window.ARCRUN_CONFIG = { apiBase: "http://127.0.0.1:8081" };`, `window.ARCRUN_CONFIG = {"apiBase":"http://127.0.0.1:8081","daemonIndex":"x"};`} {
		b := body
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(b)) }))
		if got := discoverAPIBase(srv.URL); got != "http://127.0.0.1:8081" {
			t.Errorf("%q → %q", b, got)
		}
		srv.Close()
	}
}
