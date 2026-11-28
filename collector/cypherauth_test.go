package collector

// inkstone/arcrun-rag#334：打雲端的請求要帶 Bearer 憑證。
// 用一個「相容期已關」的假 cypher：只有 租戶名＋對的 Bearer 才 200，其餘 401（與 Arcrun#399 行為一致）。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	t334Tenant = "ns-334"
	t334Key    = "a1b2c3d4e5f6" // 假憑證：測試只關心「有沒有帶、帶對」
)

type t334Seen struct {
	mu   sync.Mutex
	rows []string // "METHOD path 狀態"
}

func (s *t334Seen) add(r string) { s.mu.Lock(); s.rows = append(s.rows, r); s.mu.Unlock() }

func t334Server(t *testing.T, seen *t334Seen) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := r.Header.Get("X-Arcrun-API-Key") == t334Tenant && r.Header.Get("Authorization") == "Bearer "+t334Key
		if !ok {
			seen.add(r.Method + " " + r.URL.Path + " 401")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		seen.add(r.Method + " " + r.URL.Path + " 200")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"entries":[],"items":[],"plan":"free","ready":true}`))
	}))
}

func resetCypherKeys() { cypherKeys.Range(func(k, _ any) bool { cypherKeys.Delete(k); return true }) }

func TestSetCypherAuth_有登記就帶Bearer_沒登記只帶租戶名(t *testing.T) {
	resetCypherKeys()
	r, _ := http.NewRequest("GET", "http://x/kbdb/entries", nil)
	SetCypherAuth(r, t334Tenant)
	if r.Header.Get("X-Arcrun-API-Key") != t334Tenant || r.Header.Get("Authorization") != "" {
		t.Fatalf("沒登記時只該帶租戶名，got %v", r.Header)
	}
	RegisterCypherKey(t334Tenant, t334Key)
	r2, _ := http.NewRequest("GET", "http://x/kbdb/entries", nil)
	SetCypherAuth(r2, t334Tenant)
	if r2.Header.Get("Authorization") != "Bearer "+t334Key {
		t.Fatalf("登記後該帶 Bearer，got %v", r2.Header)
	}
	// 呼叫端自己放了 Authorization（例如 portal session）⇒ 不蓋掉
	r3, _ := http.NewRequest("GET", "http://x/portal/data/apps", nil)
	r3.Header.Set("Authorization", "Bearer session")
	SetCypherAuth(r3, t334Tenant)
	if r3.Header.Get("Authorization") != "Bearer session" {
		t.Fatalf("不該蓋掉呼叫端自己的 Authorization，got %v", r3.Header)
	}
	// 空 key 不清掉既有登記（舊精靈不回 kbdb_key 的情況）
	RegisterCypherKey(t334Tenant, "")
	if CypherKeyFor(t334Tenant) != t334Key {
		t.Fatal("空 key 不該洗掉既有登記")
	}
}

func TestLoadDirectConfig_讀進kbdb_key並登記_舊config沒這欄照常(t *testing.T) {
	resetCypherKeys()
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	man := filepath.Join(dir, "m.json")
	// 新制：accounts[].kbdb_key
	p := write("new.json", `{"manifest":"`+man+`","accounts":[{"cypher_url":"https://c.example","namespace":"`+t334Tenant+`","kbdb_key":"`+t334Key+`","watch_folders":["`+dir+`"]}]}`)
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Accounts[0].KbdbKey != t334Key || CypherKeyFor(t334Tenant) != t334Key {
		t.Fatalf("新制 kbdb_key 沒讀進／沒登記：%+v", c.Accounts[0])
	}
	// 舊制：頂層（會被包成 Accounts[0]，kbdb_key 要跟著走）
	resetCypherKeys()
	p2 := write("old.json", `{"manifest":"`+man+`","cypher_url":"https://c.example","namespace":"`+t334Tenant+`","kbdb_key":"`+t334Key+`","watch_folder":"`+dir+`"}`)
	c2, err := LoadDirectConfig(p2)
	if err != nil {
		t.Fatal(err)
	}
	if c2.Accounts[0].KbdbKey != t334Key || CypherKeyFor(t334Tenant) != t334Key {
		t.Fatalf("舊制頂層 kbdb_key 沒跟進 Accounts[0]／沒登記：%+v", c2.Accounts[0])
	}
	// 舊 config 完全沒有 kbdb_key：照常載入、不登記（相容期內只帶租戶名）
	resetCypherKeys()
	p3 := write("legacy.json", `{"manifest":"`+man+`","cypher_url":"https://c.example","namespace":"`+t334Tenant+`","watch_folder":"`+dir+`"}`)
	if _, err := LoadDirectConfig(p3); err != nil {
		t.Fatal(err)
	}
	if CypherKeyFor(t334Tenant) != "" {
		t.Fatal("沒有 kbdb_key 不該憑空登記")
	}
}

// 小幫手打雲端的各條路（對帳／用量／電量／雲端 AI 探測／憑證查詢）對「相容期已關」的 cypher 都要通。
func TestSetCypherAuth_各條打雲端的路對相容期已關的cypher都通(t *testing.T) {
	resetCypherKeys()
	RegisterCypherKey(t334Tenant, t334Key)
	seen := &t334Seen{}
	srv := t334Server(t, seen)
	defer srv.Close()

	// 回傳值不是這支測試要驗的（假伺服器回的形狀不一定合），以「伺服器端收到的請求有沒有被放行」為準。
	_ = UsageNow(srv.URL, t334Tenant, "acc")
	if _, st, err := probeWorkersAIWithStatus(context.Background(), srv.URL, t334Tenant); err != nil || st == http.StatusUnauthorized {
		t.Errorf("雲端 AI 探測（/portal/daemon/extract）被拒：status=%d err=%v", st, err)
	}
	// 沒登記憑證的對照組：同一台伺服器必須回 401（證明上面的 200 是 Bearer 的功勞，不是假伺服器太鬆）
	resetCypherKeys()
	if _, st, _ := probeWorkersAIWithStatus(context.Background(), srv.URL, t334Tenant); st != http.StatusUnauthorized {
		t.Errorf("對照組：沒帶憑證應 401，got %d", st)
	}
	var j []string
	seen.mu.Lock()
	j = append(j, seen.rows...)
	seen.mu.Unlock()
	b, _ := json.Marshal(j)
	t.Logf("伺服器看到的請求：%s", b)
	if len(j) < 3 {
		t.Fatalf("預期至少 3 發請求（用量、AI 探測、對照組），got %v", j)
	}
	for _, row := range j[:len(j)-1] {
		if len(row) < 3 || row[len(row)-3:] != "200" {
			t.Errorf("帶憑證的請求被拒：%s", row)
		}
	}
}

// inkstone/arcrun-rag#402：小幫手只有 kbdb_key 一把憑證。舊 config 殘留的 portal_session 讀到就忽略：
// 不登記成 Bearer、collector 回寫時也不再保留。
func TestLoadDirectConfig_殘留的portal_session被忽略(t *testing.T) {
	resetCypherKeys()
	dir := t.TempDir()
	man := filepath.Join(dir, "m.json")
	exp := time.Now().Unix() + 3600
	p := filepath.Join(dir, "c.json")
	body := `{"manifest":"` + man + `","accounts":[{"cypher_url":"https://c.example","namespace":"` + t334Tenant + `","portal_session":"sess-9","portal_session_exp":` + strconv.FormatInt(exp, 10) + `,"watch_folders":["` + dir + `"]}]}`
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := http.NewRequest("GET", "http://x/kbdb/entries", nil)
	SetCypherAuth(r, t334Tenant)
	if got := r.Header.Get("Authorization"); got != "" {
		t.Fatalf("沒有 kbdb_key 時不該憑空帶 portal_session，got %q", got)
	}
	out, _ := json.Marshal(c.Accounts[0])
	if strings.Contains(string(out), `"portal_session"`) {
		t.Fatalf("collector 回寫時不該再保留 portal_session：%s", out)
	}
}
