package main

// cards_test.go — 看卡（庫→目錄→整張卡）與公司網路帳號代查的驗收（inkstone/arcrun-rag#333）
//
// 假實例的路徑與欄位照 Arcrun `portal-data.ts` 的 /portal/data/map、/library-cards、/card、
// /retrieve 與 kbdb `library-index.ts` 的回傳形狀抄。
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newFakeCards(t *testing.T, session string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	guard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+session {
				w.WriteHeader(401)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "未登入"})
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/portal/data/map", guard(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "count": 2, "libraries": []map[string]any{
			{"library": "筆記", "entry_count": 3}, {"library": "公司庫", "entry_count": nil}}})
	}))
	mux.HandleFunc("/portal/data/library-cards", guard(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("library") == "不存在" {
			w.WriteHeader(404)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "library": "公司庫", "total": 2, "has_index_card": false,
			"cards": []map[string]any{
				{"page_name": "請假規則", "block_count": 2, "gloss": "特休七天", "source_path": "hr/leave.md", "updated_at": 1760000000},
				{"page_name": "出差", "block_count": 1, "gloss": nil, "source_path": nil, "updated_at": 1760000001}}})
	}))
	mux.HandleFunc("/portal/data/card", guard(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "count": 2,
			"entries": []map[string]any{
				{"content": "第二段", "metadata_json": `{"source":"kb://hr/leave.md#2"}`},
				{"content": "第一段", "metadata_json": `{"source":"kb://hr/leave.md#1"}`}},
			"location": map[string]any{"machine": "leo@mac", "full_path": "/docs/hr/leave.md", "source_path": "hr/leave.md"}})
	}))
	mux.HandleFunc("/portal/data/retrieve", guard(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "cards": []map[string]any{
			{"library": "內網庫", "page_name": "錯誤碼 E42", "content": "E42 是壓力過高", "found_by": "index"}}})
	}))
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func saveAcc(t *testing.T, accs ...accountCfg) {
	t.Helper()
	if err := saveCfg(&directConfig{Accounts: accs}); err != nil {
		t.Fatal(err)
	}
}

func TestCards_BrowseLibrariesCatalogAndCard(t *testing.T) {
	tempHome(t)
	srv := newFakeCards(t, "s1")
	saveAcc(t, sessAcc("公司", srv.URL, "s1"))
	app := &App{}

	libs := app.ListCardLibraries(0)
	if libs.Error != "" || len(libs.Libraries) != 2 || libs.Libraries[0].Name != "公司庫" || libs.Libraries[0].Entries != -1 || libs.Libraries[1].Entries != 3 {
		t.Fatalf("庫清單: %+v", libs)
	}
	cat := app.ListLibraryCards(0, "公司庫")
	if cat.Error != "" || len(cat.Cards) != 2 || cat.Cards[0].Gloss != "特休七天" || cat.Cards[1].Gloss != "" || cat.Cards[1].Source != "" || cat.Total != 2 {
		t.Fatalf("目錄（沒摘要的卡 gloss 要空，不編）: %+v", cat)
	}
	card := app.GetLibraryCard(0, "公司庫", "請假規則")
	if card.Error != "" || len(card.Blocks) != 2 || card.Blocks[0] != "第一段" || card.Blocks[1] != "第二段" {
		t.Fatalf("整張卡要照原稿段落排序: %+v", card)
	}
	if card.Origin != "leo@mac › /docs/hr/leave.md" {
		t.Fatalf("原文位置: %q", card.Origin)
	}
}

func TestCards_NoSessionAsksForLoginAndExpiredSessionIsCleared(t *testing.T) {
	tempHome(t)
	srv := newFakeCards(t, "good")
	saveAcc(t, accountCfg{InstanceName: "公司", CypherURL: srv.URL})
	if r := (&App{}).ListCardLibraries(0); !r.NeedsLogin || r.Error == "" {
		t.Fatalf("沒 session 要長登入框: %+v", r)
	}
	saveAcc(t, sessAcc("公司", srv.URL, "stale"))
	r := (&App{}).ListLibraryCards(0, "公司庫")
	if !r.NeedsLogin {
		t.Fatalf("後端 401 要轉成要登入: %+v", r)
	}
	cfg, _ := loadCfg()
	if cfg.Accounts[0].PortalSession != "" {
		t.Fatal("無效 session 要丟掉")
	}
}

func TestCards_NotFoundAndBadAccountArePlain(t *testing.T) {
	tempHome(t)
	srv := newFakeCards(t, "s1")
	saveAcc(t, sessAcc("公司", srv.URL, "s1"))
	if r := (&App{}).ListLibraryCards(0, "不存在"); !strings.Contains(r.Error, "找不到這個庫") {
		t.Fatalf("%+v", r)
	}
	if r := (&App{}).ListCardLibraries(5); r.Error == "" {
		t.Fatal("帳號索引越界要有提示")
	}
}

// 驗收 2：雲端連不到的帳號（只開放公司網路），小幫手代查拿得到卡；連得到的帳號不代查。
func TestAsk_ProxiesAccountTheCloudCannotReach(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	inner := newFakeCards(t, "sb") // B：只有這台電腦連得到
	// A 的 /ask 回報 B「連不到」
	a.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/portal/data/links":
			_ = json.NewEncoder(w).Encode(map[string]any{"linked": []map[string]any{{"link_id": "L1", "label": "內網", "base_url": inner.URL}}})
		case "/portal/data/ask":
			_ = json.NewEncoder(w).Encode(map[string]any{"answer": "沒找到", "cards": []any{}, "accounts": []map[string]any{
				{"id": "self", "label": "本帳號", "ok": true, "count": 0},
				{"id": "L1", "label": "內網", "ok": false, "reason": "unreachable", "detail": "連不上"}}})
		}
	})
	a.server.Config.Handler = authWrap(a.server.Config.Handler, "sa")
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("A", a.server.URL, "sa"), sessAcc("內網", inner.URL, "sb")}}
	r := askCore(cfg, "E42 是什麼", nil)
	if r.Error != "" {
		t.Fatalf("%+v", r)
	}
	var got *UIChatCard
	for i := range r.Cards {
		if r.Cards[i].Proxied {
			got = &r.Cards[i]
		}
	}
	if got == nil || got.Account != "內網" || got.PageName != "錯誤碼 E42" || got.AccIdx != 1 {
		t.Fatalf("要拿到內網帳號的卡: %+v", r.Cards)
	}
	if r.Accounts[1].Reason != "via_helper" || !r.Accounts[1].OK {
		t.Fatalf("帳號列要說明是代查: %+v", r.Accounts)
	}
}

func authWrap(h http.Handler, session string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+session {
			w.WriteHeader(401)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func TestAsk_ProxyNeedsLoginWhenNoSessionAndSkipsRevoked(t *testing.T) {
	tempHome(t)
	a := newFakeChat(t, "sa")
	inner := newFakeCards(t, "sb")
	a.server.Config.Handler = authWrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/portal/data/links":
			_ = json.NewEncoder(w).Encode(map[string]any{"linked": []map[string]any{
				{"link_id": "L1", "label": "內網", "base_url": inner.URL}, {"link_id": "L2", "label": "撤銷", "base_url": "http://x.invalid"}}})
		case "/portal/data/ask":
			_ = json.NewEncoder(w).Encode(map[string]any{"answer": "x", "cards": []any{}, "accounts": []map[string]any{
				{"id": "self", "label": "本帳號", "ok": true, "count": 0},
				{"id": "L1", "label": "內網", "ok": false, "reason": "timeout", "detail": "8 秒沒回應"},
				{"id": "L2", "label": "撤銷", "ok": false, "reason": "revoked", "detail": "已撤銷"}}})
		}
	}), "sa")
	cfg := &directConfig{Accounts: []accountCfg{sessAcc("A", a.server.URL, "sa"),
		{InstanceName: "內網", CypherURL: inner.URL}, sessAcc("撤銷", inner.URL, "sb")}}
	r := askCore(cfg, "問", nil)
	if r.Accounts[1].Reason != "needs_login" {
		t.Fatalf("沒 session 的連不到帳號要請登入: %+v", r.Accounts)
	}
	if r.Accounts[2].Reason != "revoked" || r.Accounts[2].OK {
		t.Fatalf("被撤銷的連結不繞過: %+v", r.Accounts)
	}
}
