package main

// chat.go — 小幫手首頁的跨帳號問答（inkstone/arcrun-rag#297）
//
// 薄殼：找卡、合併、答題、帳號互連**全部是雲端那一支**（Arcrun cypher-executor
// `POST /portal/data/ask`，Portal 側欄同一支）。本檔只做三件事：
//
//  1. 問題只送**主帳號**（左欄第一個帳號）的 /portal/data/ask 一次。
//  2. 左欄其他帳號：主帳號還沒連過才自動連（B 發唯讀金鑰 → A 收下），連過不重連；
//     連結碼只在函式的區域變數裡，不進畫面、不進 log、不落地。
//  3. 把回傳整理成畫面要的形狀；沒有有效 portal session 的帳號被標出來（不是整個失敗），
//     後端回錯就把白話錯誤交給畫面。
//
// 紅線：不輪詢（只有按「送出」才打網路）、密碼零落地（只用已存的 portal session）、
// 不另造找卡／合併／第二套帳號連結。
import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 一次問答要等雲端找卡＋LLM 作答，比讀清單久。
const chatTimeout = 90 * time.Second

// ChatTurn＝前一輪對話（讓追問接得上）。
type ChatTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// UIChatCard＝回答附的出處。
type UIChatCard struct {
	N        int    `json:"n"`
	Account  string `json:"account"`
	Library  string `json:"library"`
	PageName string `json:"pageName"`
	Excerpt  string `json:"excerpt"`
	Cited    bool   `json:"cited"`
	// AccIdx＝這張卡屬於左欄第幾個帳號（點出處可開卡）；對不到為 -1。
	AccIdx int `json:"accIdx"`
	// Proxied＝雲端連不到那個帳號，這張卡是小幫手在這台電腦直接查到的（#333）。
	Proxied bool `json:"proxied,omitempty"`
}

// UIChatAccount＝每個帳號這次的查詢結果。OK=false 時 Reason／Detail 講為什麼。
type UIChatAccount struct {
	AccIdx int    `json:"accIdx"` // 左欄的第幾個帳號；雲端回的帳號對不到時為 -1
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Count  int    `json:"count"`
	// Reason：needs_login＝這台電腦沒有它的有效登入；link_failed＝連不進主帳號；其餘照雲端給的
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type UIChatResult struct {
	Answer   string          `json:"answer"`
	Model    string          `json:"model,omitempty"`
	Cards    []UIChatCard    `json:"cards"`
	Accounts []UIChatAccount `json:"accounts"`
	// NeedsLogin＝主帳號本身沒有有效 session（畫面長登入框，不是紅字）。
	NeedsLogin bool   `json:"needsLogin"`
	Error      string `json:"error"`
}

// AskLibraries 是首頁問答框「送出」的入口。
func (a *App) AskLibraries(question string, history []ChatTurn) UIChatResult {
	cfg, _ := loadCfg()
	return askCore(cfg, question, history)
}

type chatLinkRow struct {
	LinkID  string `json:"link_id"`
	Label   string `json:"label"`
	BaseURL string `json:"base_url"`
}

func chatBearer(base, method, path, session string, body any, timeout time.Duration) (int, []byte, error) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, base+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+session)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return appDo(req, timeout)
}

func sameOrigin(a, b string) bool {
	return strings.EqualFold(hostOf(a), hostOf(b))
}

func loginExpiredMsg(name string) string {
	return "「" + name + "」的登入已過期，請輸入密碼登入一次"
}

// askCore＝AskLibraries 的本體（單測直接呼叫）。
func askCore(cfg *directConfig, question string, history []ChatTurn) UIChatResult {
	out := UIChatResult{Cards: []UIChatCard{}, Accounts: []UIChatAccount{}}
	question = strings.TrimSpace(question)
	if question == "" {
		out.Error = "請先輸入想問的問題"
		return out
	}
	if cfg == nil || len(cfg.Accounts) == 0 {
		out.Error = "還沒有連任何知識庫，請先連線一個"
		return out
	}
	primary := cfg.Accounts[0]
	pbase := apiBaseOf(primary)
	pname := accountName(primary)
	if pbase == "" {
		out.Error = "第一個知識庫沒有網址，請重新連線一次"
		return out
	}
	if !sessionValid(primary) {
		out.NeedsLogin = true
		out.Error = loginExpiredMsg(pname)
		return out
	}

	// ① 其他帳號：主帳號沒連過才連（主帳號已連的清單只問一次）
	var skipped []UIChatAccount
	if len(cfg.Accounts) > 1 {
		linked, lerr := listPrimaryLinks(pbase, primary.PortalSession)
		if lerr != nil && lerr.unauthorized {
			clearSession(0)
			out.NeedsLogin = true
			out.Error = loginExpiredMsg(pname)
			return out
		}
		for i := 1; i < len(cfg.Accounts); i++ {
			acc := cfg.Accounts[i]
			name := accountName(acc)
			if sameOrigin(acc.CypherURL, primary.CypherURL) {
				continue // 同一個實例，已經是主帳號本身
			}
			if lerr != nil {
				skipped = append(skipped, UIChatAccount{AccIdx: i, Label: name, Reason: "link_failed", Detail: lerr.msg})
				continue
			}
			if hasLink(linked, acc.CypherURL) {
				continue
			}
			if !sessionValid(acc) {
				skipped = append(skipped, UIChatAccount{AccIdx: i, Label: name, Reason: "needs_login",
					Detail: "這台電腦沒有「" + name + "」的有效登入，請輸入密碼登入一次"})
				continue
			}
			if msg, needLogin, why := linkAccount(pbase, primary.PortalSession, i, acc, name); msg != "" {
				reason := "link_failed"
				if needLogin {
					reason = "needs_login"
				} else if why == "unreachable" || why == "timeout" {
					reason = why // 主帳號的雲端連不到它（例如只開放公司網路）⇒ 之後由小幫手代查
				}
				skipped = append(skipped, UIChatAccount{AccIdx: i, Label: name, Reason: reason, Detail: msg})
			}
		}
	}

	// ② 問題只送主帳號一次
	payload := map[string]any{"question": question}
	if len(history) > 0 {
		payload["history"] = history
	}
	status, raw, err := chatBearer(pbase, http.MethodPost, "/portal/data/ask", primary.PortalSession, payload, chatTimeout)
	if err != nil {
		out.Error = err.Error()
		out.Accounts = skipped
		return out
	}
	if status == http.StatusUnauthorized {
		clearSession(0)
		out.NeedsLogin = true
		out.Error = loginExpiredMsg(pname)
		return out
	}
	var body struct {
		Answer string `json:"answer"`
		Model  string `json:"model"`
		Cards  []struct {
			N        int    `json:"n"`
			Account  string `json:"account"`
			Library  string `json:"library"`
			PageName string `json:"page_name"`
			Excerpt  string `json:"excerpt"`
			Cited    bool   `json:"cited"`
		} `json:"cards"`
		Accounts []struct {
			ID     string `json:"id"`
			Label  string `json:"label"`
			OK     bool   `json:"ok"`
			Count  int    `json:"count"`
			Reason string `json:"reason"`
			Detail string `json:"detail"`
		} `json:"accounts"`
	}
	_ = json.Unmarshal(raw, &body)

	nameIdx := map[string]int{}
	for i, a := range cfg.Accounts {
		nameIdx[accountName(a)] = i
	}
	for _, x := range body.Accounts {
		label, idx := x.Label, -1
		if x.ID == "self" {
			label, idx = pname, 0
		} else if i, ok := nameIdx[label]; ok {
			idx = i
		}
		out.Accounts = append(out.Accounts, UIChatAccount{AccIdx: idx, Label: label, OK: x.OK, Count: x.Count, Reason: x.Reason, Detail: x.Detail})
	}
	out.Accounts = append(out.Accounts, skipped...)
	for _, c := range body.Cards {
		name := c.Account
		if name == "本帳號" {
			name = pname
		}
		ci := -1
		if c.Account == "本帳號" {
			ci = 0
		} else if i, ok := nameIdx[name]; ok {
			ci = i
		}
		out.Cards = append(out.Cards, UIChatCard{N: c.N, Account: name, Library: c.Library, PageName: c.PageName, Excerpt: c.Excerpt, Cited: c.Cited, AccIdx: ci})
	}
	proxyUnreachable(cfg, question, &out)
	if status != http.StatusOK {
		if status == http.StatusNotFound {
			out.Error = "第一個知識庫還沒有跨帳號問答功能（雲端版本較舊，更新後就會有）"
		} else {
			out.Error = appErrMessage(status, raw)
		}
		return out
	}
	out.Answer, out.Model = body.Answer, body.Model
	return out
}

type linkListErr struct {
	msg          string
	unauthorized bool
}

func listPrimaryLinks(pbase, session string) ([]chatLinkRow, *linkListErr) {
	status, raw, err := chatBearer(pbase, http.MethodGet, "/portal/data/links", session, nil, appReadTimeout)
	if err != nil {
		return nil, &linkListErr{msg: err.Error()}
	}
	if status == http.StatusUnauthorized {
		return nil, &linkListErr{msg: "登入已過期", unauthorized: true}
	}
	if status != http.StatusOK {
		return nil, &linkListErr{msg: appErrMessage(status, raw)}
	}
	var b struct {
		Linked []chatLinkRow `json:"linked"`
	}
	if json.Unmarshal(raw, &b) != nil {
		return nil, &linkListErr{msg: "第一個知識庫回的連結清單看不懂"}
	}
	return b.Linked, nil
}

func hasLink(rows []chatLinkRow, otherURL string) bool {
	for _, r := range rows {
		if sameOrigin(r.BaseURL, otherURL) {
			return true
		}
	}
	return false
}

// linkAccount：B（acc）發一把唯讀連結金鑰 → A（主帳號）收下。回傳 ("", false)＝成功。
// 連結碼只存在這個函式內，不回傳、不寫 log。
func linkAccount(pbase, psession string, idx int, acc accountCfg, name string) (msg string, needsLogin bool, reason string) {
	status, raw, err := chatBearer(apiBaseOf(acc), http.MethodPost, "/portal/data/links/issue", acc.PortalSession,
		map[string]any{"label": "小幫手跨帳號問答"}, appReadTimeout)
	if err != nil {
		return "連不上「" + name + "」：" + err.Error(), false, ""
	}
	if status == http.StatusUnauthorized {
		clearSession(idx)
		return loginExpiredMsg(name), true, ""
	}
	var issued struct {
		Code string `json:"code"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &issued) != nil || issued.Code == "" {
		return "「" + name + "」不能被連結：" + appErrMessage(status, raw), false, ""
	}
	status, raw, err = chatBearer(pbase, http.MethodPost, "/portal/data/links", psession,
		map[string]any{"code": issued.Code, "label": name}, appReadTimeout)
	if err != nil {
		return err.Error(), false, ""
	}
	if status != http.StatusOK {
		var why struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(raw, &why)
		return "連結「" + name + "」失敗：" + appErrMessage(status, raw), false, why.Reason
	}
	return "", false, ""
}

// proxyUnreachable：雲端說連不到的帳號（只開放公司網路等），由小幫手用這台電腦的連線直接查
// 一次它自己的 /portal/data/retrieve，把找到的卡補進出處（#333 驗收 2）。
// 只代查「連不到」（unreachable／timeout）；連結被撤銷（revoked）是用戶的決定，不繞過。
// 只有按送出才跑；LLM 作答仍在雲端，所以代查到的卡只列出處、不進答案文字。
func proxyUnreachable(cfg *directConfig, question string, out *UIChatResult) {
	for k := range out.Accounts {
		x := &out.Accounts[k]
		if x.OK || x.AccIdx < 1 || (x.Reason != "unreachable" && x.Reason != "timeout") {
			continue
		}
		acc, err := accountAt(cfg, x.AccIdx)
		if err != nil {
			continue
		}
		name := accountName(acc)
		if !sessionValid(acc) {
			x.Reason, x.Detail = "needs_login", "雲端連不到「"+name+"」，要由這台電腦代查，請輸入密碼登入一次"
			continue
		}
		status, raw, err := chatBearer(apiBaseOf(acc), http.MethodGet, "/portal/data/retrieve?q="+url.QueryEscape(question)+"&limit=5", acc.PortalSession, nil, appReadTimeout)
		if err != nil {
			x.Detail += "；這台電腦也連不上：" + err.Error()
			continue
		}
		if status == http.StatusUnauthorized {
			clearSession(x.AccIdx)
			x.Reason, x.Detail = "needs_login", loginExpiredMsg(name)
			continue
		}
		var b struct {
			Cards []struct {
				Library  string `json:"library"`
				PageName string `json:"page_name"`
				Content  string `json:"content"`
			} `json:"cards"`
		}
		if status != http.StatusOK || json.Unmarshal(raw, &b) != nil {
			x.Detail += "；這台電腦代查也失敗：" + appErrMessage(status, raw)
			continue
		}
		for _, c := range b.Cards {
			ex := []rune(c.Content)
			if len(ex) > 600 {
				ex = append(ex[:600], '…')
			}
			out.Cards = append(out.Cards, UIChatCard{N: len(out.Cards) + 1, Account: name, Library: c.Library,
				PageName: c.PageName, Excerpt: string(ex), AccIdx: x.AccIdx, Proxied: true})
		}
		x.OK, x.Count, x.Reason = true, len(b.Cards), "via_helper"
		x.Detail = "雲端連不到這個帳號，已由這台電腦直接查（只列出處，沒有 AI 整理的答案）"
	}
}
