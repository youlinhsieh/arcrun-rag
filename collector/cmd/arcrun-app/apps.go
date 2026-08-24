package main

// apps.go — 桌面小幫手的 App 啟動器後端（inkstone/arcrun-rag#137）
//
// ─────────────────────────────────────────────────────────────────────────────
// 這個檔案在解什麼
// ─────────────────────────────────────────────────────────────────────────────
// leo 2026-08-24：「所有的 App 需要有一個類似 Android/iOS 的九宮格啟動界面，
// 每個 App 有一個 icon，**這會運行在 portal 及 daemon**。」
//
// 桌面這半沒有自己的 KBDB，也**不准**在本機另存一份 App 清單
// （上游 `inkstone/Arcrun#82` 已定「安裝態只有一份真相源」＝實例的 `{tenant}:app:{id}`）。
// ⇒ 本檔做的事只有一件：**去使用者連的那個實例問**，把答案原樣交給畫面。
// 沒有任何預設清單、沒有快取到磁碟、沒有第二份 schema。
//
// ─────────────────────────────────────────────────────────────────────────────
// 為什麼是「兩條路」而不是一條（這是本票的規格判斷，理由寫在這裡不寫在票上）
// ─────────────────────────────────────────────────────────────────────────────
// 上游同一份安裝態有兩個對外面：
//
//	① `/portal/data/apps*`      認 **portal session**（Bearer）——Portal 那半走這條，
//	   清單／詳情（含畫面 HTML）／動作三支齊全。
//	② `/apps`                   認 **X-Arcrun-API-Key**（＝實例 namespace）——CLI／操盤 AI 走這條，
//	   **只有清單**，沒有詳情、沒有動作。
//
// 小幫手手上本來就有 ②的鑰匙（`config.json` 的 `api_key`，連線時實例自己下發的），
// 但**沒有**①的 session（密碼刻意零落地，見 connect.go）。
//
// 所以：
//   - **清單一律先走①、拿不到就退回②**。兩支回的都是 `summarizeApp` 的同一個形狀
//     （id/name/icon/has_ui/version），所以九宮格**在完全沒登入的情況下也是真資料**。
//   - **詳情與動作只有①有**，所以那兩件需要一次 portal 登入。連線精靈當下順手換一張
//     session（`Connect` 已經有密碼在手，見 connect.go 的呼叫點），使用者通常不會再被問。
//     session 過期（實例預設 7 天）才會在 App 頁上出現一次登入框。
//
// 🔴 密碼仍然零落地：存的是 session token，不是密碼（與 connect.go 同一條紅線）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 不做輪詢
// ─────────────────────────────────────────────────────────────────────────────
// 畫面每秒打一次 `GetState()`，但**本檔的任何函式都不掛在那條線上**——
// App 清單只在「打開啟動器」與「按重新整理」時才去問實例一次。
// 把網路請求塞進每秒的 tick 等於自己造一個輪詢器，那是明令禁止的形狀。
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// appHTTPTimeout：App 動作背後是一整條工作流（可能打 LLM），比單純讀清單久得多。
// 清單／詳情用短的，動作用長的——不讓「讀清單」被一條慢工作流的預算拖著。
const (
	appReadTimeout   = 20 * time.Second
	appActionTimeout = 120 * time.Second
)

// ── 前端要的形狀 ───────────────────────────────────────────────────────────

// UIApp＝九宮格上的一格。逐欄對應上游 `summarizeApp`，不多不少——
// 多一欄就是在桌面端發明一個實例不認得的概念。
type UIApp struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	HasUI   bool   `json:"hasUi"`
	Version string `json:"version"`
}

// UIAppList＝一個知識庫的啟動器內容。
//
// 🔴 Error 與「空清單」是兩件事，不准混成同一句話（arcrun-rag#10「寧可明顯失敗」）：
//   - `Error != ""`  ⇒ 問不到（連不上／實例太舊沒有這支端點）——畫面要說「問不到」
//   - `Error == "" && len(Apps) == 0` ⇒ 真的一個都沒裝——畫面要說「還沒有 App」
//
// 兩者長得像，但使用者該做的事完全相反。
type UIAppList struct {
	AccIdx  int     `json:"accIdx"`
	Account string  `json:"account"` // 知識庫顯示名（畫面上的切換器用）
	Host    string  `json:"host"`
	Apps    []UIApp `json:"apps"`
	Error   string  `json:"error"`
	// Source＝這份清單是用哪把鑰匙問到的（"session"／"apikey"）。給診斷用，
	// 畫面不依它分支——兩條路的內容是同一份安裝態。
	Source string `json:"source"`
}

// UIAppWorkflow＝App 的一條工作流（沒有自帶畫面的 App 就靠這個列表當預設畫面，
// 與 Portal 的 renderAppView 同一套呈現，不另立第二種）。
type UIAppWorkflow struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// UIAppDetail＝點進一個 App 之後要的全部東西。
type UIAppDetail struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Icon      string          `json:"icon"`
	Version   string          `json:"version"`
	HasUI     bool            `json:"hasUi"`
	UIHtml    string          `json:"uiHtml"`
	Workflows []UIAppWorkflow `json:"workflows"`
	Actions   []string        `json:"actions"`
	// NeedsLogin＝這台機器沒有（或已過期）這個知識庫的 portal session。
	// 不是錯誤，是「還差一步」——畫面要長出登入框，不是紅字。
	NeedsLogin bool   `json:"needsLogin"`
	Email      string `json:"email"` // 登入框預填（帳號本來就存在 config 裡）
	Error      string `json:"error"`
}

// ── 內部：HTTP 小工具 ─────────────────────────────────────────────────────

// apiBaseOf 回傳這個帳號的 API base（cypher origin）。
// 連線精靈存進來的 CypherURL 已經是 API 位址（normalizePortalURL 換算過），
// 這裡只做去尾斜線，**不重新發明第二套換算**。
func apiBaseOf(a accountCfg) string {
	return strings.TrimRight(strings.TrimSpace(a.CypherURL), "/")
}

// accountAt 取第 idx 個帳號；越界回錯（前端傳來的索引可能落後於剛改過的設定）。
func accountAt(cfg *directConfig, idx int) (accountCfg, error) {
	if cfg == nil || idx < 0 || idx >= len(cfg.Accounts) {
		return accountCfg{}, errors.New("找不到這個知識庫")
	}
	return cfg.Accounts[idx], nil
}

// appDo 送一個請求並讀回 body。回傳 (status, body, err)；err 只代表「連不上」，
// HTTP 4xx/5xx 一律當成「連得上但被拒絕」由呼叫端判讀——
// 把兩者混成一個 error 就分不出「網路斷了」與「密碼過期了」。
func appDo(req *http.Request, timeout time.Duration) (int, []byte, error) {
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return 0, nil, errors.New("連不上這個知識庫——請確認網路正常")
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20)) // App 自帶畫面可能不小，但給上限
	return res.StatusCode, b, nil
}

// appErrMessage 從實例回的 JSON 撈 error 欄位；撈不到就用狀態碼講人話。
func appErrMessage(status int, body []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && strings.TrimSpace(e.Error) != "" {
		return e.Error
	}
	switch status {
	case http.StatusNotFound:
		return "這個知識庫還沒有 App 功能（實例版本較舊，更新後就會出現）"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "這個知識庫的登入已過期"
	}
	return fmt.Sprintf("知識庫回了 HTTP %d", status)
}

// ── portal session（詳情與動作唯一的鑰匙）────────────────────────────────

// sessionValid：留 60 秒安全邊際，免得剛好在請求路上過期。
func sessionValid(a accountCfg) bool {
	return strings.TrimSpace(a.PortalSession) != "" &&
		(a.PortalSessionExp == 0 || time.Now().Unix() < a.PortalSessionExp-60)
}

// portalLogin 用帳密換一張 portal session token。
//
// 🔴 這支是**唯一**碰密碼的地方，而且密碼只活在參數裡：換完就丟，不寫檔、不 log。
func portalLogin(base, email, password string) (token string, expiresIn int64, err error) {
	body, _ := json.Marshal(map[string]string{
		"email":    strings.ToLower(strings.TrimSpace(email)),
		"password": password,
	})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/login", bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	status, raw, err := appDo(req, appReadTimeout)
	if err != nil {
		return "", 0, err
	}
	var out struct {
		Success        bool   `json:"success"`
		SessionToken   string `json:"session_token"`
		SessionExpires int64  `json:"session_expires_in"`
		Error          string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if status != http.StatusOK || !out.Success || out.SessionToken == "" {
		if strings.TrimSpace(out.Error) != "" {
			return "", 0, errors.New(out.Error)
		}
		return "", 0, errors.New(appErrMessage(status, raw))
	}
	return out.SessionToken, out.SessionExpires, nil
}

// storeSession 把換到的 session 寫回設定（只存 token 與到期時間，不存密碼）。
func storeSession(idx int, token string, expiresIn int64) error {
	cfg, err := loadCfg()
	if err != nil {
		return err
	}
	if idx < 0 || idx >= len(cfg.Accounts) {
		return errors.New("找不到這個知識庫")
	}
	cfg.Accounts[idx].PortalSession = token
	if expiresIn > 0 {
		cfg.Accounts[idx].PortalSessionExp = time.Now().Unix() + expiresIn
	} else {
		cfg.Accounts[idx].PortalSessionExp = 0
	}
	return saveCfg(cfg)
}

// clearSession 在實例說「這張 session 不算數」時把它丟掉。
// 留著一張已知無效的 token 只會讓下一次再撞一次 401，然後畫面又閃一下錯誤。
func clearSession(idx int) {
	cfg, err := loadCfg()
	if err != nil || idx < 0 || idx >= len(cfg.Accounts) {
		return
	}
	if cfg.Accounts[idx].PortalSession == "" && cfg.Accounts[idx].PortalSessionExp == 0 {
		return
	}
	cfg.Accounts[idx].PortalSession = ""
	cfg.Accounts[idx].PortalSessionExp = 0
	if err := saveCfg(cfg); err != nil {
		appLog("清掉過期的知識庫登入失敗：%v", err)
	}
}

// tryStoreSessionFromLogin 在連線精靈成功之後順手換一張 session（connect.go 呼叫）。
// **失敗不算連線失敗**——沒有 session 只是「App 詳情要再登入一次」，
// 而資料夾同步這條主線根本用不到它。
func tryStoreSessionFromLogin(cfg *directConfig, idx int, email, password string) {
	if idx < 0 || idx >= len(cfg.Accounts) {
		return
	}
	token, exp, err := portalLogin(apiBaseOf(cfg.Accounts[idx]), email, password)
	if err != nil {
		appLog("連線成功但沒換到知識庫的 App 登入（不影響同步）：%v", err)
		return
	}
	cfg.Accounts[idx].PortalSession = token
	if exp > 0 {
		cfg.Accounts[idx].PortalSessionExp = time.Now().Unix() + exp
	}
}

// ── 前端呼叫的四支 ─────────────────────────────────────────────────────────

// ListApps 回一個知識庫上「實際裝了的」App。
//
// 兩條路的順序與理由見檔頭。**沒有任何寫死的清單**——問不到就誠實說問不到。
func (a *App) ListApps(accIdx int) UIAppList {
	out := UIAppList{AccIdx: accIdx}
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Account = accountName(acc)
	out.Host = shortHost(acc.CypherURL)
	base := apiBaseOf(acc)
	if base == "" {
		out.Error = "這個知識庫沒有網址，請重新連線一次"
		return out
	}

	// ① portal session（與 Portal 那半同一支端點、同一份權限）
	if sessionValid(acc) {
		req, _ := http.NewRequest(http.MethodGet, base+"/portal/data/apps", nil)
		req.Header.Set("Authorization", "Bearer "+acc.PortalSession)
		status, raw, derr := appDo(req, appReadTimeout)
		switch {
		case derr != nil:
			out.Error = derr.Error()
			return out
		case status == http.StatusOK:
			out.Apps = parseAppList(raw)
			out.Source = "session"
			return out
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			clearSession(accIdx) // 過期了 ⇒ 掉到 ② 去，清單照樣看得到
		default:
			// 其他錯（例如 5xx）**不要**掉到 ②——那會把「實例出問題」偽裝成正常。
			out.Error = appErrMessage(status, raw)
			return out
		}
	}

	// ② 實例 API key（小幫手本來就有的那把；只有清單，沒有詳情／動作）
	if strings.TrimSpace(acc.APIKey) == "" {
		out.Error = "這台電腦還沒有這個知識庫的鑰匙，請重新連線一次"
		return out
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/apps", nil)
	req.Header.Set("X-Arcrun-API-Key", acc.APIKey)
	status, raw, derr := appDo(req, appReadTimeout)
	if derr != nil {
		out.Error = derr.Error()
		return out
	}
	if status != http.StatusOK {
		out.Error = appErrMessage(status, raw)
		return out
	}
	out.Apps = parseAppList(raw)
	out.Source = "apikey"
	return out
}

// parseAppList 讀 `{apps:[…]}`。兩支端點回的都是 summarizeApp 的形狀，所以只有一份解析。
// 純函式（單測用）。
func parseAppList(raw []byte) []UIApp {
	var body struct {
		Apps []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Icon    string `json:"icon"`
			HasUI   bool   `json:"has_ui"`
			Version string `json:"version"`
		} `json:"apps"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	apps := make([]UIApp, 0, len(body.Apps))
	for _, x := range body.Apps {
		name := x.Name
		if strings.TrimSpace(name) == "" {
			name = x.ID
		}
		apps = append(apps, UIApp{ID: x.ID, Name: name, Icon: x.Icon, HasUI: x.HasUI, Version: x.Version})
	}
	return apps
}

// GetApp 取一個 App 的詳情（自帶畫面／工作流清單／動作白名單）。
//
// 🔴 只有 portal session 這一條路——上游的 API key 面**沒有**詳情端點
//
//	（`/apps` 只有列表；見 `cypher-executor/src/routes/apps.ts`）。
//	所以沒有 session 時回 NeedsLogin，讓畫面長一次登入框，而不是回一句錯誤。
func (a *App) GetApp(accIdx int, id string) UIAppDetail {
	out := UIAppDetail{ID: id}
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Email = acc.Email
	if !sessionValid(acc) {
		out.NeedsLogin = true
		return out
	}
	base := apiBaseOf(acc)
	req, _ := http.NewRequest(http.MethodGet, base+"/portal/data/apps/"+urlPathEscape(id), nil)
	req.Header.Set("Authorization", "Bearer "+acc.PortalSession)
	status, raw, derr := appDo(req, appReadTimeout)
	if derr != nil {
		out.Error = derr.Error()
		return out
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		clearSession(accIdx)
		out.NeedsLogin = true
		return out
	}
	if status != http.StatusOK {
		out.Error = appErrMessage(status, raw)
		return out
	}
	var d struct {
		ID        string   `json:"id"`
		Name      string   `json:"name"`
		Icon      string   `json:"icon"`
		Version   string   `json:"version"`
		HasUI     bool     `json:"has_ui"`
		UIHtml    string   `json:"ui_html"`
		Actions   []string `json:"actions"`
		Workflows []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"workflows"`
	}
	if json.Unmarshal(raw, &d) != nil {
		out.Error = "這個知識庫回的內容看不懂（版本可能不相容）"
		return out
	}
	out.ID, out.Name, out.Icon, out.Version = d.ID, d.Name, d.Icon, d.Version
	out.HasUI, out.UIHtml, out.Actions = d.HasUI, d.UIHtml, d.Actions
	for _, w := range d.Workflows {
		out.Workflows = append(out.Workflows, UIAppWorkflow{Name: w.Name, Description: w.Description})
	}
	if strings.TrimSpace(out.Name) == "" {
		out.Name = out.ID
	}
	return out
}

// RunAppAction 觸發 App 的一個白名單動作，回傳實例給的結果 JSON（原樣字串）。
//
// 🔴 白名單由**實例**裁決，不在這裡複製一份判斷（K6：前端／桌面端都不是裁決點）。
//
//	這裡不認得任何 action 名稱，只負責把使用者按的那顆按鈕送出去。
//
// payloadJSON 是前端組好的 JSON 物件字串；空字串＝沒有 payload。
func (a *App) RunAppAction(accIdx int, id, action, payloadJSON string) (string, error) {
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(action) == "" {
		return "", errors.New("沒有指定要做什麼")
	}
	if !sessionValid(acc) {
		return "", errors.New("這個知識庫的登入已過期，請在畫面上重新登入一次")
	}
	var payload any = map[string]any{}
	if s := strings.TrimSpace(payloadJSON); s != "" {
		if err := json.Unmarshal([]byte(s), &payload); err != nil {
			return "", errors.New("送出的內容格式不對")
		}
	}
	body, _ := json.Marshal(map[string]any{"action": action, "payload": payload})
	req, err := http.NewRequest(http.MethodPost,
		apiBaseOf(acc)+"/portal/data/apps/"+urlPathEscape(id)+"/action", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+acc.PortalSession)
	status, raw, derr := appDo(req, appActionTimeout)
	if derr != nil {
		return "", derr
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		// 403 也可能是「這個動作不在白名單」——那句話由實例自己講，這裡照抄。
		if status == http.StatusUnauthorized {
			clearSession(accIdx)
		}
		return "", errors.New(appErrMessage(status, raw))
	}
	if status != http.StatusOK {
		return "", errors.New(appErrMessage(status, raw))
	}
	return string(raw), nil
}

// PortalLogin 讓使用者在 App 頁上補一次登入（session 過期時）。
// email 用 config 裡存的那個（就是他連線時用的帳號），只問密碼。
func (a *App) PortalLogin(accIdx int, password string) error {
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		return err
	}
	if strings.TrimSpace(acc.Email) == "" {
		return errors.New("這個知識庫沒有記錄帳號，請用「新增知識庫帳號」重新連一次")
	}
	token, exp, err := portalLogin(apiBaseOf(acc), acc.Email, password)
	if err != nil {
		return err
	}
	return storeSession(accIdx, token, exp)
}

// urlPathEscape：App id 的字元集上游已限死 `^[a-z][a-z0-9_-]{0,63}$`，
// 但我們是**收方**不是**發方**——照樣 escape，不假設對面永遠守規矩。
func urlPathEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == '~':
			b.WriteRune(r)
		default:
			for _, c := range []byte(string(r)) {
				fmt.Fprintf(&b, "%%%02X", c)
			}
		}
	}
	return b.String()
}
