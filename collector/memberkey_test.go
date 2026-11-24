package collector

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUpgradeMemberKeys(t *testing.T) {
	var gotTenant, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/portal/daemon/key" {
			http.NotFound(w, r)
			return
		}
		gotTenant, gotAuth = r.Header.Get("X-Arcrun-API-Key"), r.Header.Get("Authorization")
		if strings.Contains(gotAuth, "admin-session") {
			w.Write([]byte(`{"success":true,"kbdb_key":"abcdef","scope":"tenant"}`))
			return
		}
		w.Write([]byte(`{"success":true,"kbdb_key":"dk1.bWVAY28.sig","scope":"member"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := &DirectConfig{Accounts: []AccountConfig{
		{CypherURL: srv.URL, Namespace: "co", KbdbKey: "tenantwide", PortalSession: "member-session", PortalSessionExp: time.Now().Add(time.Hour).Unix()},
		{CypherURL: srv.URL, Namespace: "adm", KbdbKey: "tenantwide2", PortalSession: "admin-session"},
		{CypherURL: srv.URL, Namespace: "old", KbdbKey: "keep", PortalSession: "expired", PortalSessionExp: 1},
		{CypherURL: srv.URL, Namespace: "done", KbdbKey: "dk1.x.y", PortalSession: "member-session"},
	}}
	if !upgradeMemberKeys(cfg, path) {
		t.Fatal("一般同仁的帳號該被換成 dk1 憑證")
	}
	if cfg.Accounts[0].KbdbKey != "dk1.bWVAY28.sig" || gotTenant == "" || !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("帳號 0 沒換成綁本人的憑證：%+v tenant=%q auth=%q", cfg.Accounts[0], gotTenant, gotAuth)
	}
	if cfg.Accounts[1].KbdbKey != "tenantwide2" {
		t.Fatal("管理員（scope=tenant）不該被動")
	}
	if cfg.Accounts[2].KbdbKey != "keep" || cfg.Accounts[3].KbdbKey != "dk1.x.y" {
		t.Fatal("session 過期、已是 dk1 的帳號不該被動")
	}
	if CypherKeyFor("co") != "dk1.bWVAY28.sig" {
		t.Fatal("換完要登記進打雲端用的登記簿")
	}
	if b, err := os.ReadFile(path); err != nil || !strings.Contains(string(b), "dk1.bWVAY28.sig") {
		t.Fatalf("要回寫 config：%v", err)
	}
}

func TestUpgradeMemberKeysOldCloud404(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	cfg := &DirectConfig{Accounts: []AccountConfig{{CypherURL: srv.URL, Namespace: "co", KbdbKey: "tenantwide", PortalSession: "s"}}}
	if upgradeMemberKeys(cfg, "") || cfg.Accounts[0].KbdbKey != "tenantwide" {
		t.Fatal("舊雲端沒有這支端點：維持原樣，不擋")
	}
}

func TestMemberACLSentence(t *testing.T) {
	if s := memberACLSentence(403, `{"error":"庫「a」不是你的","code":"library_not_yours"}`); !strings.Contains(s, "不是你的") {
		t.Fatalf("got %q", s)
	}
	if memberACLSentence(403, `{"code":"admin_only"}`) == "" || memberACLSentence(403, `{"code":"library_required"}`) == "" {
		t.Fatal("admin_only／library_required 要有人話")
	}
	if memberACLSentence(500, `{"code":"admin_only"}`) != "" || memberACLSentence(403, `not json`) != "" || memberACLSentence(403, `{"code":"x"}`) != "" {
		t.Fatal("認不出來要回空字串")
	}
}
