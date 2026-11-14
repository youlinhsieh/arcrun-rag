package main

// inkstone/arcrun-rag#334：連線精靈要把雲端回的 config.kbdb_key 存起來，
// 之後打雲端才帶得出 Bearer 憑證；舊雲端不回這欄時不能把已存的憑證洗掉。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	collector "arcrun-rag/collector"
)

func fakeConfigServerWithKey(t *testing.T, key *string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/portal/daemon/config", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(daemonConfigResp{Success: true, Config: daemonConfig{
			CypherURL: "https://instance-k.example.workers.dev", Namespace: "ns-k",
			Email: "k@example.com", InstanceName: "k", KbdbKey: *key,
		}})
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	orig := http.DefaultTransport
	http.DefaultTransport = srv.Client().Transport
	t.Cleanup(func() { http.DefaultTransport = orig })
	return srv
}

func TestConnect_存下kbdb_key_且重連時舊雲端不回也不洗掉(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	key := "deadbeef01"
	srv := fakeConfigServerWithKey(t, &key)
	app := &App{}
	if err := app.Connect(srv.URL, "k@example.com", "pw"); err != nil {
		t.Fatal(err)
	}
	cfg, _ := loadCfg()
	if len(cfg.Accounts) != 1 || cfg.Accounts[0].KbdbKey != "deadbeef01" {
		t.Fatalf("kbdb_key 沒存進 config：%+v", cfg.Accounts)
	}
	// 磁碟上的 config.json 真的有這欄（saveCfg 用 accountCfg 重新序列化，少鏡像欄位會在這裡掉）
	raw, _ := os.ReadFile(configPath())
	if !json.Valid(raw) || !containsStr(string(raw), `"kbdb_key": "deadbeef01"`) {
		t.Fatalf("config.json 沒有 kbdb_key：%s", raw)
	}
	// loadCfg 順手登記：打雲端的請求會帶 Bearer
	if collector.CypherKeyFor("ns-k") != "deadbeef01" {
		t.Fatal("loadCfg 沒有登記憑證")
	}
	r, _ := http.NewRequest("GET", "https://x/apps", nil)
	collector.SetCypherAuth(r, "ns-k")
	if r.Header.Get("Authorization") != "Bearer deadbeef01" {
		t.Fatalf("App 這條線沒帶 Bearer：%v", r.Header)
	}

	// 舊雲端（不回 kbdb_key）重連同一個實例：已存的憑證要留著
	key = ""
	if err := app.Connect(srv.URL, "k@example.com", "pw"); err != nil {
		t.Fatal(err)
	}
	cfg, _ = loadCfg()
	if cfg.Accounts[0].KbdbKey != "deadbeef01" {
		t.Fatalf("舊雲端沒回 kbdb_key 時不該洗掉已存的：%+v", cfg.Accounts[0])
	}
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
