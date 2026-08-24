package main

// apps_test.go — App 啟動器後端的驗收（inkstone/arcrun-rag#137）
//
// 🔴 這裡的假實例**不是憑印象寫的**：每一支端點的路徑、認證標頭、回應欄位名，
//
//	都是照 `inkstone/Arcrun` 分支 `feat/app-system-v0` 的原始碼抄下來的
//	（`cypher-executor/src/routes/apps.ts`、`routes/portal-data.ts`、
//	 `lib/app-system.ts` 的 summarizeApp／detailApp、`routes/portal.ts` 的 /portal/login）。
//	抄錯了測試就會綠得很假——所以下面每一段都標了它對應上游哪一支。
//
// 這組測試回答的是驗收條件 1 與 2 裡「機器答得出來」的那幾格：
//   - 清單真的來自實例（兩條路都試過），桌面端沒有任何寫死清單
//   - 「問不到」與「一個都沒裝」分得出來
//   - session 過期會被清掉、且清單仍然看得到（退回 API key）
//   - 動作真的打到 /portal/data/apps/:id/action，白名單由實例裁決
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeCfgWithAccount 造一份最小可用的 config.json（一個知識庫）。
func writeCfgWithAccount(t *testing.T, base string, acc accountCfg) {
	t.Helper()
	acc.CypherURL = base
	if acc.Namespace == "" {
		acc.Namespace = "ns-test"
	}
	cfg := map[string]any{
		"manifest": filepath.Join(appDir(), "manifest.json"),
		"accounts": []accountCfg{acc},
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func tempHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

// fakeInstance 是「一台裝了 App 系統的 Arcrun 實例」的最小替身。
type fakeInstance struct {
	// sessionToken＝目前有效的 session；空字串＝任何 Bearer 都算過期。
	sessionToken string
	password     string
	apiKey       string
	// 收到的動作（給測試斷言用）
	gotAction  string
	gotPayload map[string]any
	// 讓測試模擬「實例壞掉」
	listStatus int
}

func (f *fakeInstance) server(t *testing.T) *httptest.Server {
	t.Helper()
	// 上游 summarizeApp 的形狀（lib/app-system.ts）
	summary := []map[string]any{
		{"id": "note", "name": "筆記", "icon": "🗒️", "has_ui": true, "version": "0.1.0"},
		{"id": "weekly", "name": "週報", "icon": "📊", "has_ui": false, "version": "0.2.0"},
	}
	mux := http.NewServeMux()

	// POST /portal/login（routes/portal.ts）
	mux.HandleFunc("/portal/login", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Email, Password string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.Password != f.password {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "email 或密碼錯誤"})
			return
		}
		f.sessionToken = "sess-" + in.Email
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "session_token": f.sessionToken, "session_expires_in": 604800,
		})
	})

	// GET /apps（routes/apps.ts，X-Arcrun-API-Key）
	mux.HandleFunc("/apps", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Arcrun-API-Key") != f.apiKey {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "缺少 X-Arcrun-API-Key header"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"apps": summary, "count": len(summary)})
	})

	// /portal/data/apps*（routes/portal-data.ts，Bearer portal session）
	mux.HandleFunc("/portal/data/apps", func(w http.ResponseWriter, r *http.Request) {
		if !f.authed(r) {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "session 無效或已過期"})
			return
		}
		if f.listStatus != 0 {
			w.WriteHeader(f.listStatus)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "實例內部錯誤"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"apps": summary, "count": len(summary)})
	})
	mux.HandleFunc("/portal/data/apps/", func(w http.ResponseWriter, r *http.Request) {
		if !f.authed(r) {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "session 無效或已過期"})
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/portal/data/apps/")
		if strings.HasSuffix(rest, "/action") {
			id := strings.TrimSuffix(rest, "/action")
			var in struct {
				Action  string         `json:"action"`
				Payload map[string]any `json:"payload"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			// 上游 runAppAction：白名單不中 → 403（K6，裁決點在實例不在呼叫端）
			if id != "note" || in.Action != "notes-create" {
				w.WriteHeader(403)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "這個動作不在這個 App 的白名單內"})
				return
			}
			f.gotAction, f.gotPayload = in.Action, in.Payload
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{"id": "blk_1"}})
			return
		}
		if rest != "note" {
			w.WriteHeader(404)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "找不到這個 App"})
			return
		}
		// 上游 detailApp 的形狀
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "note", "name": "筆記", "icon": "🗒️", "version": "0.1.0",
			"has_ui": true, "ui_html": "<div id=x>hi</div>",
			"workflows": []map[string]string{{"name": "notes-create", "description": "寫入一則筆記"}},
			"actions":   []string{"notes-create"},
		})
	})
	return httptest.NewServer(mux)
}

func (f *fakeInstance) authed(r *http.Request) bool {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return f.sessionToken != "" && tok == f.sessionToken
}

// ── 驗收條件 1：清單來自實例，兩條路都通 ────────────────────────────────

func TestListApps_UsesPortalSessionWhenAvailable(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{
		InstanceName: "我的庫", Email: "a@b.c", APIKey: "ns-test",
		PortalSession: "sess-a", PortalSessionExp: 0,
	})

	got := (&App{}).ListApps(0)
	if got.Error != "" {
		t.Fatalf("不該有錯：%s", got.Error)
	}
	if got.Source != "session" {
		t.Fatalf("該走 portal session，實際走 %q", got.Source)
	}
	if len(got.Apps) != 2 || got.Apps[0].ID != "note" || got.Apps[0].Icon != "🗒️" || !got.Apps[0].HasUI {
		t.Fatalf("清單沒有原樣接住實例的回應：%+v", got.Apps)
	}
	if got.Account != "我的庫" {
		t.Fatalf("知識庫名字不對：%q", got.Account)
	}
}

func TestListApps_FallsBackToApiKeyWithoutSession(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	// 完全沒有 session（＝剛升級上來、或從沒登入過）——九宮格照樣要看得到真資料
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test"})

	got := (&App{}).ListApps(0)
	if got.Error != "" || got.Source != "apikey" || len(got.Apps) != 2 {
		t.Fatalf("沒有 session 時該退回 API key 並照樣列出來：%+v", got)
	}
}

func TestListApps_ExpiredSessionIsClearedAndListStillWorks(t *testing.T) {
	tempHome(t)
	// 實例已經不認這張 session（f.sessionToken 與 config 裡那張不同）
	fi := &fakeInstance{sessionToken: "sess-new", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{
		Email: "a@b.c", APIKey: "ns-test", PortalSession: "sess-old",
	})

	got := (&App{}).ListApps(0)
	if got.Error != "" || got.Source != "apikey" || len(got.Apps) != 2 {
		t.Fatalf("session 過期時清單仍該看得到（退回 API key）：%+v", got)
	}
	// 已知無效的 token 要被丟掉，否則下一次還會再撞一次 401
	cfg, _ := loadCfg()
	if cfg.Accounts[0].PortalSession != "" {
		t.Fatalf("過期的 session 沒有被清掉：%q", cfg.Accounts[0].PortalSession)
	}
}

// 🔴「問不到」不准偽裝成「一個都沒裝」——實例 5xx 時不准悄悄退回 API key 假裝正常。
func TestListApps_InstanceErrorIsNotDisguisedAsEmpty(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", password: "pw", apiKey: "ns-test", listStatus: 500}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", PortalSession: "sess-a"})

	got := (&App{}).ListApps(0)
	if got.Error == "" {
		t.Fatalf("實例回 500 卻沒有回報錯誤：%+v", got)
	}
	if len(got.Apps) != 0 {
		t.Fatalf("出錯時不該給半份清單：%+v", got.Apps)
	}
}

func TestListApps_UnknownAccountSaysSo(t *testing.T) {
	tempHome(t)
	writeCfgWithAccount(t, "https://example.invalid", accountCfg{Email: "a@b.c", APIKey: "k"})
	if got := (&App{}).ListApps(7); got.Error == "" {
		t.Fatalf("越界的索引該回錯，不是空清單")
	}
}

// ── 驗收條件 2：點進去能用 ───────────────────────────────────────────────

func TestGetApp_ReturnsDetailWithUI(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", PortalSession: "sess-a"})

	d := (&App{}).GetApp(0, "note")
	if d.Error != "" || d.NeedsLogin {
		t.Fatalf("不該有錯也不該要登入：%+v", d)
	}
	if !d.HasUI || d.UIHtml != "<div id=x>hi</div>" {
		t.Fatalf("自帶畫面沒接住：%+v", d)
	}
	if len(d.Workflows) != 1 || d.Workflows[0].Name != "notes-create" {
		t.Fatalf("工作流清單沒接住：%+v", d.Workflows)
	}
	if len(d.Actions) != 1 || d.Actions[0] != "notes-create" {
		t.Fatalf("動作白名單沒接住：%+v", d.Actions)
	}
}

// 沒有 session ⇒ 回 NeedsLogin（要長登入框），不是回一句錯誤。
// 這是刻意的：上游的 API key 面**沒有**詳情端點（routes/apps.ts 只有 install/list/delete），
// 所以「看詳情」在協定上就只有 portal session 那一條路。
func TestGetApp_WithoutSessionAsksForLoginNotError(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test"})

	d := (&App{}).GetApp(0, "note")
	if !d.NeedsLogin {
		t.Fatalf("沒有 session 時該回 NeedsLogin：%+v", d)
	}
	if d.Error != "" {
		t.Fatalf("這不是錯誤，是還差一步：%q", d.Error)
	}
	if d.Email != "a@b.c" {
		t.Fatalf("登入框要能預填帳號：%q", d.Email)
	}
}

func TestPortalLogin_StoresSessionNotPassword(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test"})

	if err := (&App{}).PortalLogin(0, "wrong"); err == nil {
		t.Fatalf("密碼錯了應該要失敗")
	}
	if err := (&App{}).PortalLogin(0, "pw"); err != nil {
		t.Fatalf("密碼對了卻失敗：%v", err)
	}
	raw, err := os.ReadFile(configPath())
	if err != nil {
		t.Fatal(err)
	}
	// 🔴 密碼零落地：整份 config 裡不准出現密碼字串
	if strings.Contains(string(raw), "pw\"") || strings.Contains(string(raw), "\"password\"") {
		t.Fatalf("密碼被寫進 config 了：%s", raw)
	}
	cfg, _ := loadCfg()
	if cfg.Accounts[0].PortalSession == "" || cfg.Accounts[0].PortalSessionExp == 0 {
		t.Fatalf("session 沒有存起來：%+v", cfg.Accounts[0])
	}
	// 存了 session 之後，詳情就拿得到了
	if d := (&App{}).GetApp(0, "note"); d.NeedsLogin || d.Error != "" {
		t.Fatalf("登入之後詳情還是拿不到：%+v", d)
	}
}

func TestRunAppAction_HitsInstanceAndCarriesPayload(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", PortalSession: "sess-a"})

	out, err := (&App{}).RunAppAction(0, "note", "notes-create", `{"text":"嗨"}`)
	if err != nil {
		t.Fatalf("動作失敗：%v", err)
	}
	if !strings.Contains(out, "blk_1") {
		t.Fatalf("沒有把實例的結果原樣帶回來：%s", out)
	}
	if fi.gotAction != "notes-create" || fi.gotPayload["text"] != "嗨" {
		t.Fatalf("payload 沒送到：%q %+v", fi.gotAction, fi.gotPayload)
	}
}

// 白名單是**實例**裁決的（K6）——桌面端不複製一份判斷，只負責把實例的話原樣說出來。
func TestRunAppAction_WhitelistIsDecidedByInstance(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", password: "pw", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", PortalSession: "sess-a"})

	_, err := (&App{}).RunAppAction(0, "note", "rm-rf", "")
	if err == nil {
		t.Fatalf("不在白名單的動作該失敗")
	}
	if !strings.Contains(err.Error(), "白名單") {
		t.Fatalf("該把實例的原話帶回來，實際：%v", err)
	}
}

// ── 純函式 ──────────────────────────────────────────────────────────────

func TestParseAppList_FallsBackToIdWhenNameMissing(t *testing.T) {
	apps := parseAppList([]byte(`{"apps":[{"id":"x","name":"","icon":"","has_ui":false,"version":"1"}]}`))
	if len(apps) != 1 || apps[0].Name != "x" {
		t.Fatalf("沒有名字時該退回 id：%+v", apps)
	}
}

func TestUrlPathEscape(t *testing.T) {
	for in, want := range map[string]string{
		"note":   "note",
		"a/b":    "a%2Fb",
		"a b":    "a%20b",
		"../etc": "..%2Fetc",
		"筆記":     "%E7%AD%86%E8%A8%98",
	} {
		if got := urlPathEscape(in); got != want {
			t.Fatalf("urlPathEscape(%q)=%q，想要 %q", in, got, want)
		}
	}
}
