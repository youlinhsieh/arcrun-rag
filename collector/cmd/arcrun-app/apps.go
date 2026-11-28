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
// 只有一把憑證（inkstone/arcrun-rag#402，leo 2026-11-28：「同一個軟體卻有兩套登入」）
// ─────────────────────────────────────────────────────────────────────────────
// 小幫手連線時從實例拿到一把不會過期的同步憑證（`config.json` 的 `kbdb_key`，綁本人的 dk1）。
// 雲端 Portal 端點（`/portal/data/*`）直接認它（Arcrun#580），所以九宮格、App 詳情、動作、問答、
// 知識卡、跨帳號互連**全部用這一把**。
//
// 🔴 2026-08-24 #137 當時同步帶的只是租戶名、不是真憑證，所以借了網頁 Portal 的登入票
//    （portal_session，7 天到期，過期就叫用戶輸入密碼）。#334 另造 kbdb_key 之後兩套並存，
//    問答與 App 繼續用會過期的那把。現在整條拿掉：**沒有密碼框、沒有「登入已過期」**。
//    唯一要用戶動手的情況＝這把憑證本身失效（帳號停用／被移出／憑證太舊）⇒ 畫面請他「重新連線」
//    （連線精靈，密碼只在那一刻用來換憑證，不存檔）。
//
// 清單另有一條舊路 `/apps`（X-Arcrun-API-Key，只有清單）：憑證太舊、Portal 端點不認時，
// 清單照樣看得到，詳情與動作才提示重新連線。兩條路帶的是同一把憑證。
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

	collector "arcrun-rag/collector"
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
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon"`
	// Glyph＝實例替這個 App 挑好的字形代號（`summarizeApp.glyph`）。小幫手不自己對照、不自己畫：
	// 字形本體在 UIAppList.Glyphs，由實例提供；兩者任一缺就退回通用圖示（見 glyphs.go）。
	Glyph   string `json:"glyph"`
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
	// Glyphs＝實例提供的圖示字形（代號→SVG 內層標記，24×24 描邊式）。實例沒有這支端點就是 nil，
	// 畫面退回通用圖示——「拿得到就用，拿不到退回通用圖示」（inkstone/arcrun-rag#240 c18275）。
	Glyphs map[string]string `json:"glyphs,omitempty"`
	// Source＝這份清單走的是哪條路（"portal"／"apikey"，帶的都是同一把憑證）。給診斷用，
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
	// NeedsReconnect＝這台電腦對這個知識庫的連線憑證沒有或已失效（帳號停用／被移出／太舊）。
	// 不是一般錯誤——畫面請用戶「重新連線」，不是紅字、也沒有密碼框。
	NeedsReconnect bool   `json:"needsReconnect"`
	Error          string `json:"error"`
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
	case http.StatusUnauthorized:
		return "這個知識庫需要重新連線一次"
	case http.StatusForbidden:
		return "這個知識庫不允許這個動作"
	}
	return fmt.Sprintf("知識庫回了 HTTP %d", status)
}

// ── 同步憑證（小幫手唯一的鑰匙）─────────────────────────────────────────

// syncKey：這個帳號連線時拿到的憑證（kbdb_key）；空字串＝舊版連的帳號，要重新連線一次。
func syncKey(a accountCfg) string { return strings.TrimSpace(a.KbdbKey) }

// reconnectMsg：憑證沒有或被雲端認定失效時，畫面上唯一的話。不提密碼、不提過期。
func reconnectMsg(name string) string {
	return "「" + name + "」需要重新連線一次（這台電腦的連線憑證已失效或太舊）"
}

// portalGet／portalBearer：所有打 `/portal/data/*` 的請求都帶這一把。
func portalBearer(req *http.Request, acc accountCfg) {
	req.Header.Set("Authorization", "Bearer "+syncKey(acc))
}

// ── 前端呼叫的四支 ─────────────────────────────────────────────────────────

// ListApps 回一個知識庫上「實際裝了的」App。
//
// 兩條路的順序與理由見檔頭。**沒有任何寫死的清單**——問不到就誠實說問不到。
func (a *App) ListApps(accIdx int) UIAppList {
	out := a.listAppsCore(accIdx)
	if out.Error == "" {
		if cfg, _ := loadCfg(); cfg != nil {
			if acc, err := accountAt(cfg, accIdx); err == nil {
				out.Glyphs = fetchGlyphs(acc)
			}
		}
	}
	return out
}

func (a *App) listAppsCore(accIdx int) UIAppList {
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

	// ① Portal 端點（與網頁那半同一支、同一份權限）
	if syncKey(acc) != "" {
		req, _ := http.NewRequest(http.MethodGet, base+"/portal/data/apps", nil)
		portalBearer(req, acc)
		status, raw, derr := appDo(req, appReadTimeout)
		switch {
		case derr != nil:
			out.Error = derr.Error()
			return out
		case status == http.StatusOK:
			out.Apps = parseAppList(raw)
			out.Source = "portal"
			return out
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			// Portal 端點不認這把憑證（太舊）⇒ 掉到 ② 去，清單照樣看得到
		default:
			// 其他錯（例如 5xx）**不要**掉到 ②——那會把「實例出問題」偽裝成正常。
			out.Error = appErrMessage(status, raw)
			return out
		}
	}

	// ② 舊路 `/apps`（租戶名＋同一把憑證；只有清單，沒有詳情／動作）
	if strings.TrimSpace(acc.APIKey) == "" {
		out.Error = "這台電腦還沒有這個知識庫的鑰匙，請重新連線一次"
		return out
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/apps", nil)
	collector.SetCypherAuth(req, acc.APIKey)
	status, raw, derr := appDo(req, appReadTimeout)
	if derr != nil {
		out.Error = derr.Error()
		return out
	}
	if status == http.StatusUnauthorized {
		out.Error = reconnectMsg(out.Account)
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
			Glyph   string `json:"glyph"`
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
		apps = append(apps, UIApp{ID: x.ID, Name: name, Icon: x.Icon, Glyph: x.Glyph, HasUI: x.HasUI, Version: x.Version})
	}
	return apps
}

// GetApp 取一個 App 的詳情（自帶畫面／工作流清單／動作白名單）。
//
// 🔴 只有 Portal 端點這一條路——舊的 `/apps` 面**沒有**詳情端點
//
//	（只有列表；見 `cypher-executor/src/routes/apps.ts`）。
//	憑證沒有或被認定失效時回 NeedsReconnect，讓畫面請用戶重新連線，而不是回一句錯誤。
func (a *App) GetApp(accIdx int, id string) UIAppDetail {
	out := UIAppDetail{ID: id}
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if syncKey(acc) == "" {
		out.NeedsReconnect, out.Error = true, reconnectMsg(accountName(acc))
		return out
	}
	base := apiBaseOf(acc)
	req, _ := http.NewRequest(http.MethodGet, base+"/portal/data/apps/"+urlPathEscape(id), nil)
	portalBearer(req, acc)
	status, raw, derr := appDo(req, appReadTimeout)
	if derr != nil {
		out.Error = derr.Error()
		return out
	}
	if status == http.StatusUnauthorized {
		out.NeedsReconnect, out.Error = true, reconnectMsg(accountName(acc))
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
	if syncKey(acc) == "" {
		return "", errors.New(reconnectMsg(accountName(acc)))
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
	portalBearer(req, acc)
	status, raw, derr := appDo(req, appActionTimeout)
	if derr != nil {
		return "", derr
	}
	if status == http.StatusUnauthorized {
		return "", errors.New(reconnectMsg(accountName(acc)))
	}
	if status == http.StatusForbidden {
		// 403 可能是「這個動作不在白名單」——那句話由實例自己講，這裡照抄。
		return "", errors.New(appErrMessage(status, raw))
	}
	if status != http.StatusOK {
		return "", errors.New(appErrMessage(status, raw))
	}
	return string(raw), nil
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
