package main

// chat_test.go — 首頁跨帳號問答的驗收（inkstone/arcrun-rag#297）
//
// 假實例的端點路徑與回應欄位照 Arcrun `cypher-executor/src/routes/portal-data.ts`
// 的 /portal/data/ask、/portal/data/links、/portal/data/links/issue 抄（不是憑印象）。
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeChat struct {
	session   string
	asks      int32
	issues    int32
	saves     int32
	linked    []map[string]any
	askStatus int
	lastAsk   map[string]any
	server    *httptest.Server
}

func newFakeChat(t *testing.T, session string) *fakeChat {
	t.Helper()
	f := &fakeChat{session: session, askStatus: 200}
	mux := http.NewServeMux()
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+f.session {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "未登入"})
			return false
		}
		return true
	}
	mux.HandleFunc("/portal/data/ask", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		atomic.AddInt32(&f.asks, 1)
		_ = json.NewDecoder(r.Body).Decode(&f.lastAsk)
		if f.askStatus != 200 {
			w.WriteHeader(f.askStatus)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "AI 回答失敗：額度用完", "accounts": []any{}, "cards": []any{}})
			return
		}
		accounts := []map[string]any{{"id": "self", "label": "本帳號", "ok": true, "count": 1}}
		cards := []map[string]any{{"n": 1, "account": "本帳號", "library": "公司庫", "page_name": "請假規則", "excerpt": "特休…", "cited": true}}
		for _, l := range f.linked {
			accounts = append(accounts, map[string]any{"id": l["link_id"], "label": l["label"], "ok": true, "count": 1})
			cards = append(cards, map[string]any{"n": 2, "account": l["label"], "library": "筆記", "page_name": "出差", "excerpt": "…", "cited": false})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"answer": "特休是 7 天[1]", "model": "m", "cards": cards, "accounts": accounts})
	})
	mux.HandleFunc("/portal/data/links", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"linked": f.linked, "issued": []any{}, "max": 8})
			return
		}
		var in struct{ Code, Label string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		atomic.AddInt32(&f.saves, 1)
		f.linked = append(f.linked, map[string]any{"link_id": "L" + in.Label, "label": in.Label, "base_url": in.Code})
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})
	mux.HandleFunc("/portal/data/links/issue", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		atomic.AddInt32(&f.issues, 1)
		// 假碼：直接用自己的網址，讓 A 的假 save 能存成 base_url 對得上
		_ = json.NewEncoder(w).Encode(map[string]any{"code": f.server.URL, "key_id": "k"})
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func sessAcc(name, url, sess string) accountCfg {
	return accountCfg{InstanceName: name, CypherURL: url, PortalSession: sess, PortalSessionExp: time.Now().Unix() + 3600}
}

func TestAsk_SingleAccountSendsOneAskAndMapsCards(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("公司", a.server.URL, "sa")}}
	r := askCore(cfg, "特休幾天？", []ChatTurn{{Role: "user", Content: "hi"}})
	if r.Error != "" || r.Answer == "" {
		t.Fatalf("應有答案: %+v", r)
	}
	if a.asks != 1 || a.issues != 0 || a.saves != 0 {
		t.Fatalf("單帳號只該 ask 一次: asks=%d issues=%d saves=%d", a.asks, a.issues, a.saves)
	}
	if len(r.Cards) != 1 || r.Cards[0].Account != "公司" || r.Cards[0].PageName != "請假規則" || !r.Cards[0].Cited {
		t.Fatalf("出處不對（本帳號要換成帳號名）: %+v", r.Cards)
	}
	if h, _ := a.lastAsk["history"].([]any); len(h) != 1 {
		t.Fatalf("history 沒帶: %+v", a.lastAsk)
	}
}

func TestAsk_AutoLinksOtherAccountOnceThenNeverAgain(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	b := newFakeChat(t, "sb")
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("A", a.server.URL, "sa"), sessAcc("B", b.server.URL, "sb")}}
	// 假 code 是 B 的網址；A 存成 base_url
	r1 := askCore(cfg, "問", nil)
	if r1.Error != "" || a.asks != 1 {
		t.Fatalf("第一次: %+v asks=%d", r1, a.asks)
	}
	if b.issues != 1 || a.saves != 1 || b.asks != 0 {
		t.Fatalf("第一次要連一次且不直接問 B: issues=%d saves=%d bAsks=%d", b.issues, a.saves, b.asks)
	}
	// A 的 base_url 存的是 code（假碼＝B 的網址）⇒ hasLink 以來源比對
	askCore(cfg, "再問", nil)
	if b.issues != 1 || a.saves != 1 || a.asks != 2 {
		t.Fatalf("第二次不該重連: issues=%d saves=%d asks=%d", b.issues, a.saves, a.asks)
	}
	// 畫面拿到兩個帳號的出處，且 AccIdx 對得上
	if len(r1.Accounts) != 2 || r1.Accounts[1].AccIdx != 1 || !r1.Accounts[1].OK {
		t.Fatalf("帳號列: %+v", r1.Accounts)
	}
}

func TestAsk_AccountWithoutSessionIsFlaggedNotFatal(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	b := newFakeChat(t, "sb")
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("A", a.server.URL, "sa"), {InstanceName: "B", CypherURL: b.server.URL}}}
	r := askCore(cfg, "問", nil)
	if r.Error != "" || r.Answer == "" {
		t.Fatalf("沒 session 的帳號不該讓整個失敗: %+v", r)
	}
	var found bool
	for _, x := range r.Accounts {
		if x.AccIdx == 1 && x.Reason == "needs_login" && !x.OK && strings.Contains(x.Detail, "B") {
			found = true
		}
	}
	if !found || b.issues != 0 {
		t.Fatalf("要標出 B 需要登入: %+v issues=%d", r.Accounts, b.issues)
	}
}

func TestAsk_PrimaryWithoutSessionAsksForLogin(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	cfg := &directConfig{Accounts: []accountCfg{{InstanceName: "A", CypherURL: a.server.URL}}}
	r := askCore(cfg, "問", nil)
	if !r.NeedsLogin || r.Error == "" || a.asks != 0 {
		t.Fatalf("%+v asks=%d", r, a.asks)
	}
}

func TestAsk_BackendErrorBecomesPlainMessage(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	a.askStatus = 502
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("A", a.server.URL, "sa")}}
	r := askCore(cfg, "問", nil)
	if r.Answer != "" || !strings.Contains(r.Error, "額度用完") {
		t.Fatalf("要拿到後端白話錯誤: %+v", r)
	}
}

func TestAsk_EmptyQuestionAndNoAccount(t *testing.T) {
	if r := askCore(&directConfig{}, "  ", nil); r.Error == "" {
		t.Fatal("空問題要有提示")
	}
	if r := askCore(&directConfig{}, "x", nil); r.Error == "" {
		t.Fatal("沒帳號要有提示")
	}
}
