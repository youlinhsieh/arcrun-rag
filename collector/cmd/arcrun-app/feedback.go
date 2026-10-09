package main

// feedback.go — 學員打字回報（inkstone/arcrun-rag#210）
//
// 目標（leo 2026-09-20 原話）：「他們不會用 github issues，所以要在 portal 有地方回報，
// 而且在明顯的位置……裡面是 FAQ 或是直接寫內容給我，不然多少人測試也不知道有什麼需要改的。」
// 一個不懂技術的學員，在小幫手裡三秒內找得到「我要回報」，寫完按送出就到 leo 手上。
//
// 🔴 2026-10-09 改版（inkstone/arcrun-rag#235 c18393）：**回報不再經過用戶自己的實例。**
// 舊版 POST 到用戶自己雲端的 feedback_report 工作流——那條工作流要用我們的 gitea_token，
// 而用戶不會有、也不該有我們的金鑰；而且那條工作流從沒被裝進任何實例（三台實測 404，
// 一張票都沒開出）。leo 規格：「用戶就是免設定發給我們訊息，直接塞進票即可」。
// ⇒ 現在小幫手把回報直接 POST 到**我們自己的收件端**（youlin 上的 feedback_report，
// namespace 走 URL path＝Arcrun 的公開表單形態），開票用的金鑰只住在那台，
// `{{credential.gitea_token}}` 由那邊回填。用戶實例完全不參與：不讀、不寫、不需任何金鑰，
// 連「還沒連上任何知識庫」的人也送得出去。
//
// 回報不帶任何 namespace／金鑰／email／電腦名稱：「實例」欄只放顯示名或網址主機名。
// 防濫用：本機每小時最多 feedbackMaxPerHour 則（送出成功才計；見 feedbackAllow），
// 超過就人話回「送太頻繁，請稍後再試」，不碰網路。
//
import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// feedbackPayload 是送給 feedback_report 工作流的 trigger body。
// Diagnostics 故意用 interface{}：附診斷檔時直接塞 buildDiagnosticsPayload() 的原始結構
// （不重複 json.Marshal 成字串再塞一次），沒附時整欄省略。
type feedbackPayload struct {
	Text        string      `json:"text"`
	Version     string      `json:"version"`
	Instance    string      `json:"instance"`
	OS          string      `json:"os"`
	Diagnostics interface{} `json:"diagnostics,omitempty"`
}

var feedbackHTTP = &http.Client{Timeout: 30 * time.Second}

// 我們自己的收件端：youlin（stage，leo 2026-10-09 裁決 B，#235 c18468）上，
// 專屬 namespace 底下的 feedback_report。namespace 走 URL path ＝ 公開表單形態
// （webhooks-named.ts `/webhooks/named/:ns/:name/trigger`，設計給公開表單用）。
// 這個 namespace 底下**只放這一條工作流與 gitea_token 一把金鑰**，不是任何用戶的租戶。
// 測試／換環境走環境變數 ARCRUN_FEEDBACK_INBOX（完整 trigger 網址），不改程式碼。
const (
	feedbackInboxBase  = "https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev"
	feedbackInboxNS    = "inbox-feedback"
	feedbackMaxPerHour = 5
)

// feedbackInboxURL 回收件端的完整 trigger 網址。
func feedbackInboxURL() string {
	if u := strings.TrimSpace(os.Getenv("ARCRUN_FEEDBACK_INBOX")); u != "" {
		return u
	}
	return fmt.Sprintf("%s/webhooks/named/%s/feedback_report/trigger",
		strings.TrimSuffix(feedbackInboxBase, "/"), feedbackInboxNS)
}

// feedbackSentPath 記「最近成功送出的時間」，只為本機速率上限；與 config 分開，壞了不影響設定。
func feedbackSentPath() string { return filepath.Join(appDir(), "feedback-sent.json") }

// feedbackAllow 檢查本機一小時內送出的則數；回 (還能送, 目前則數)。
func feedbackAllow(now time.Time) bool {
	return len(feedbackRecent(now)) < feedbackMaxPerHour
}

func feedbackRecent(now time.Time) []int64 {
	var all []int64
	if b, err := os.ReadFile(feedbackSentPath()); err == nil {
		_ = json.Unmarshal(b, &all)
	}
	cut := now.Add(-time.Hour).Unix()
	var keep []int64
	for _, ts := range all {
		if ts > cut && ts <= now.Unix()+60 {
			keep = append(keep, ts)
		}
	}
	return keep
}

func feedbackRecord(now time.Time) {
	keep := append(feedbackRecent(now), now.Unix())
	if b, err := json.Marshal(keep); err == nil {
		_ = os.MkdirAll(appDir(), 0o755)
		_ = os.WriteFile(feedbackSentPath(), b, 0o600)
	}
}

// feedbackInstanceLabel：回報裡「實例」欄放什麼。只放顯示名或網址主機名，
// 🔴 不放 namespace（self-hosted 下 namespace 就是 API key）。
func feedbackInstanceLabel() string {
	cfg, err := loadCfg()
	if err != nil || len(cfg.Accounts) == 0 {
		return "（尚未連上知識庫）"
	}
	acc := cfg.Accounts[0]
	if n := strings.TrimSpace(acc.InstanceName); n != "" {
		return n
	}
	if u, perr := url.Parse(strings.TrimSpace(acc.CypherURL)); perr == nil && u.Host != "" {
		return u.Host
	}
	return "unknown"
}

// SubmitFeedback 是前端「打字回報」按送出時呼叫的唯一入口。
// attachDiagnostics=true 時順便把匯出診斷檔同一份資料（只有統計數字，不含使用者
// 任何文件內容）一起帶上，不必使用者自己另外匯出、另外找地方附加。
func (a *App) SubmitFeedback(text string, attachDiagnostics bool) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("請先寫下你遇到的狀況再送出")
	}
	now := time.Now()
	if !feedbackAllow(now) {
		return fmt.Errorf("一小時內送了太多則回報，請稍後再試（你寫的內容還在，不會消失）")
	}

	payload := feedbackPayload{
		Text:     text,
		Version:  version,
		Instance: feedbackInstanceLabel(),
		OS:       runtime.GOOS,
	}
	if attachDiagnostics {
		payload.Diagnostics = a.buildDiagnosticsPayload()
	}
	if err := postFeedback(payload); err != nil {
		return err
	}
	feedbackRecord(now)
	return nil
}

// postFeedback 送到我們的收件端。回給學員的錯誤字串一律是人話，不含伺服器回應原文
// （可能夾帶開發者指令）。
func postFeedback(payload feedbackPayload) error {
	body, merr := json.Marshal(payload)
	if merr != nil {
		return fmt.Errorf("組回報內容失敗：%w", merr)
	}
	req, rerr := http.NewRequest(http.MethodPost, feedbackInboxURL(), bytes.NewReader(body))
	if rerr != nil {
		return fmt.Errorf("沒送出去，請再試一次（%v）", rerr)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, derr := feedbackHTTP.Do(req)
	if derr != nil {
		return fmt.Errorf("沒送出去，請再試一次（網路錯誤：%v）", derr)
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("沒送出去，請再試一次（回報服務暫時有問題，代碼 %d）", resp.StatusCode)
	}

	var out struct {
		Success bool `json:"success"`
		Data    struct {
			Success bool   `json:"success"`
			Error   string `json:"error"`
		} `json:"data"`
	}
	// 回應解析失敗不視為送出失敗——HTTP 已經是 2xx，工作流真的跑過了；
	// 解析只是想抓「內層其實回報失敗」這種狀況（外層 success:true、內層卻失敗的坑，
	// 見票 #210 comment 10305）。
	if json.Unmarshal(snippet, &out) == nil {
		if !out.Success || (out.Data.Error != "" && !out.Data.Success) {
			msg := out.Data.Error
			if msg == "" {
				msg = "工作流回報失敗"
			}
			return fmt.Errorf("沒送出去：%s", msg)
		}
	}
	return nil
}
