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
//   - 憑證被 Portal 端點拒絕（太舊）時清單仍然看得到（退回舊的 /apps 路）；詳情／動作請用戶重新連線
//   - 🔴 #402：只有 kbdb_key 一把憑證——沒有密碼框、沒有 portal_session、沒有 PortalLogin
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
	// sessionToken＝實例目前認得的同步憑證（kbdb_key，Arcrun#580）；空字串＝任何 Bearer 都不認。
	sessionToken string
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
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "reconnect_required","code":"reconnect_required"})
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
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "reconnect_required","code":"reconnect_required"})
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

func TestListApps_UsesPortalEndpointWithSyncKey(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{
		InstanceName: "我的庫", Email: "a@b.c", APIKey: "ns-test",
		KbdbKey: "sess-a",
	})

	got := (&App{}).ListApps(0)
	if got.Error != "" {
		t.Fatalf("不該有錯：%s", got.Error)
	}
	if got.Source != "portal" {
		t.Fatalf("該走 Portal 端點，實際走 %q", got.Source)
	}
	if len(got.Apps) != 2 || got.Apps[0].ID != "note" || got.Apps[0].Icon != "🗒️" || !got.Apps[0].HasUI {
		t.Fatalf("清單沒有原樣接住實例的回應：%+v", got.Apps)
	}
	if got.Account != "我的庫" {
		t.Fatalf("知識庫名字不對：%q", got.Account)
	}
}

func TestListApps_FallsBackToApiKeyWithoutSyncKey(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	// 完全沒有 kbdb_key（＝舊版連的帳號）——九宮格照樣要看得到真資料
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test"})

	got := (&App{}).ListApps(0)
	if got.Error != "" || got.Source != "apikey" || len(got.Apps) != 2 {
		t.Fatalf("沒有憑證時該退回舊路 並照樣列出來：%+v", got)
	}
}

func TestListApps_StaleKeyFallsBackAndListStillWorks(t *testing.T) {
	tempHome(t)
	// 實例已經不認這把憑證（f.sessionToken 與 config 裡那把不同）
	fi := &fakeInstance{sessionToken: "sess-new", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{
		Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-old",
	})

	got := (&App{}).ListApps(0)
	if got.Error != "" || got.Source != "apikey" || len(got.Apps) != 2 {
		t.Fatalf("憑證太舊時清單仍該看得到（退回舊路）：%+v", got)
	}
	// 憑證只有 config 裡那一把：不准被清掉（清掉＝同步也斷）
	cfg, _ := loadCfg()
	if cfg.Accounts[0].KbdbKey != "sess-old" {
		t.Fatalf("憑證不該被動：%q", cfg.Accounts[0].KbdbKey)
	}
}

// 🔴「問不到」不准偽裝成「一個都沒裝」——實例 5xx 時不准悄悄退回 API key 假裝正常。
func TestListApps_InstanceErrorIsNotDisguisedAsEmpty(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", apiKey: "ns-test", listStatus: 500}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-a"})

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
	fi := &fakeInstance{sessionToken: "sess-a", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-a"})

	d := (&App{}).GetApp(0, "note")
	if d.Error != "" || d.NeedsReconnect {
		t.Fatalf("不該有錯也不該要重新連線：%+v", d)
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

// 沒有憑證／被實例拒絕 ⇒ 回 NeedsReconnect（畫面請用戶重新連線），沒有密碼框。
// 這是刻意的：舊的 /apps 面**沒有**詳情端點，「看詳情」在協定上只有 Portal 端點那一條路。
func TestGetApp_NoKeyOrRejectedAsksToReconnect(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-new", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()

	writeCfgWithAccount(t, srv.URL, accountCfg{InstanceName: "庫", Email: "a@b.c", APIKey: "ns-test"})
	d := (&App{}).GetApp(0, "note")
	if !d.NeedsReconnect || !strings.Contains(d.Error, "重新連線") {
		t.Fatalf("沒有憑證時該請重新連線：%+v", d)
	}

	writeCfgWithAccount(t, srv.URL, accountCfg{InstanceName: "庫", Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-old"})
	d = (&App{}).GetApp(0, "note")
	if !d.NeedsReconnect || strings.Contains(d.Error, "密碼") {
		t.Fatalf("被實例拒絕（401）該請重新連線、且不提密碼：%+v", d)
	}
	// 憑證不准被清掉
	if cfg, _ := loadCfg(); cfg.Accounts[0].KbdbKey != "sess-old" {
		t.Fatalf("憑證不該被動：%q", cfg.Accounts[0].KbdbKey)
	}
}

// 驗收 1（#402）：config 裡沒有 portal_session，詳情／動作照常；舊 config 殘留的 portal_session 載入時被抹掉。
func TestLegacyPortalSessionIsScrubbedAndKeyStillWorks(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "KEY-1", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"manifest":"` + filepath.Join(appDir(), "manifest.json") + `","accounts":[{"cypher_url":"` + srv.URL +
		`","namespace":"ns-test","api_key":"ns-test","kbdb_key":"KEY-1","portal_session":"old-7day","portal_session_exp":1}]}`
	if err := os.WriteFile(configPath(), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	if d := (&App{}).GetApp(0, "note"); d.Error != "" || d.NeedsReconnect || !d.HasUI {
		t.Fatalf("只有 kbdb_key 時詳情該照常：%+v", d)
	}
	raw, _ := os.ReadFile(configPath())
	if strings.Contains(string(raw), "portal_session") {
		t.Fatalf("舊的 portal_session 沒被抹掉：%s", raw)
	}
	if !strings.Contains(string(raw), `"kbdb_key": "KEY-1"`) {
		t.Fatalf("kbdb_key 不該被動：%s", raw)
	}
}

func TestRunAppAction_HitsInstanceAndCarriesPayload(t *testing.T) {
	tempHome(t)
	fi := &fakeInstance{sessionToken: "sess-a", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-a"})

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
	fi := &fakeInstance{sessionToken: "sess-a", apiKey: "ns-test"}
	srv := fi.server(t)
	defer srv.Close()
	writeCfgWithAccount(t, srv.URL, accountCfg{Email: "a@b.c", APIKey: "ns-test", KbdbKey: "sess-a"})

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
