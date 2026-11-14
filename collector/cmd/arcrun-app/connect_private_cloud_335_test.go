package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#335：企業私有雲的網址（自訂網域、內網 http、帶埠）要原樣可用；
// CF 雲慣例（portal 網域換 API 網域、沒打協定補 https）照舊。
func TestNormalizePortalURLPrivateCloud(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://10.0.0.5:8081", "http://10.0.0.5:8081"},
		{"HTTP://arcrun.corp.lan:8081/portal/", "http://arcrun.corp.lan:8081"},
		{"https://arcrun.corp.example.com", "https://arcrun.corp.example.com"},
		{"arcrun.corp.example.com", "https://arcrun.corp.example.com"},
		{"arcrun.corp.lan:8081", "https://arcrun.corp.lan:8081"},
		// CF 雲：照舊
		{"https://arcrun-rag-ui.abc.workers.dev/portal/", "https://arcrun-cypher-executor.abc.workers.dev"},
		{"arcrun-cypher-executor.abc.workers.dev", "https://arcrun-cypher-executor.abc.workers.dev"},
	}
	for _, c := range cases {
		got, err := normalizePortalURL(c.in)
		if err != nil || got != c.want {
			t.Errorf("normalizePortalURL(%q)=%q,%v 要 %q", c.in, got, err, c.want)
		}
	}
}

// 用戶貼的是網頁位址、API 在另一個位址：靠 portal 的 /config.js 找到 API。
func TestFetchConfigByLoginDiscoversAPIFromPortal(t *testing.T) {
	var apiHits, portalConfigPosts int
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/portal/daemon/config" {
			http.NotFound(w, r)
			return
		}
		apiHits++
		_ = json.NewEncoder(w).Encode(daemonConfigResp{Success: true, Config: daemonConfig{CypherURL: "http://api.corp.lan:8081", Namespace: "main"}})
	}))
	defer api.Close()
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/config.js":
			fmt.Fprintf(w, `window.ARCRUN_CONFIG = { apiBase: %q };`, api.URL)
		case "/portal/daemon/config":
			portalConfigPosts++
			w.Header().Set("content-type", "text/html")
			fmt.Fprint(w, "<!doctype html><html>portal</html>") // SPA 兜底頁：200 但不是 JSON
		default:
			fmt.Fprint(w, "<html></html>")
		}
	}))
	defer portal.Close()

	r, err := fetchConfigByLogin(portal.URL, "a@corp.test", "pw")
	if err != nil || r.Config.Namespace != "main" {
		t.Fatalf("網頁位址要能找到 API：%+v %v", r, err)
	}
	if apiHits != 1 || portalConfigPosts != 1 {
		t.Fatalf("API 該被打 1 次、網頁該被試 1 次：api=%d portal=%d", apiHits, portalConfigPosts)
	}
}

// 帳密錯是「真的回應」：不可以因此去找別的位址重送一次帳密。
func TestFetchConfigByLoginWrongPasswordNotRetried(t *testing.T) {
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/portal/daemon/config" {
			posts++
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "email 或密碼錯誤"})
			return
		}
		fmt.Fprint(w, `window.ARCRUN_CONFIG = { apiBase: "http://elsewhere.invalid" };`)
	}))
	defer srv.Close()
	_, err := fetchConfigByLogin(srv.URL, "a@corp.test", "bad")
	if err == nil || !strings.Contains(err.Error(), "帳號或密碼不對") || posts != 1 {
		t.Fatalf("要回帳密不對、且只送一次：err=%v posts=%d", err, posts)
	}
}

// 網址根本不是知識庫（沒有 config.js、也不是 API）：照舊的白話錯誤。
func TestFetchConfigByLoginNotArcrun(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<html>hello</html>") }))
	defer srv.Close()
	_, err := fetchConfigByLogin(srv.URL, "a@corp.test", "pw")
	if err == nil || !strings.Contains(err.Error(), "不像是 Arcrun RAG 知識庫") {
		t.Fatalf("err=%v", err)
	}
}
