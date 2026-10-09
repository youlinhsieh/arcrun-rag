package main

// feedback.go — 學員打字回報（inkstone/arcrun-rag#210）
//
// 目標（leo 2026-09-20 原話）：「他們不會用 github issues，所以要在 portal 有地方回報，
// 而且在明顯的位置……裡面是 FAQ 或是直接寫內容給我，不然多少人測試也不知道有什麼需要改的。」
// 一個不懂技術的學員，在小幫手裡三秒內找得到「我要回報」，寫完按送出就到 leo 手上。
//
// 走法（總管在票上定案，comment 10309）：回報變成 inkstone/arcrun-rag 的一張票
// （label user + s/triage），開票這件事整個交給一條 Arcrun 工作流（feedback_report，
// workflows/feedback-report.yaml）去做——本檔不自己拼「開票」邏輯，只做組 payload、
// POST 給該 workflow 的 named-webhook、把結果誠實回報給前端（守「什麼都叫 Arcrun」，
// 不腹語術）。與 collector/trigger.go 打 rag_ingest 是同一個模式：POST named-webhook，
// 2xx 才算成功；非 2xx／網路錯 一律回錯誤讓學員知道要再試一次（票上：
// 「① 失敗才算送出失敗，學員要看到『沒送出去，請再試一次』」）。
//
// 🔴 Telegram 通知（票上②）完全在 workflow 內部處理，本檔不知道、也不需要知道
// 它成功與否——那一步失敗不該讓學員以為自己的回報沒送到（票已經真的開成了）。
//
// 🔴 多帳號時依序試每個已連線帳號，第一個送得到的就算成功（不再寫死 accounts[0]：
// 該帳號雲端版本太舊沒有 feedback_report 時會 404，2026-09-29 Mac 實測撞到）。
// 回報的是小幫手本身或某個知識庫的問題，不是特定資料夾，走哪個帳號都不影響票會不會開成。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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

// errCloudOld＝這個知識庫的雲端還沒有回報通道（404），要先更新雲端。前端認這個代碼。
var errCloudOld = errors.New("cloud_old")

var feedbackHTTP = &http.Client{Timeout: 30 * time.Second}

// feedbackWorkflowURL 组出 feedback_report 這條 named-webhook 的觸發網址——
// 與 collector/direct.go 的 (*DirectConfig).triggerURL 同一條公式，這裡是 App 端
// 獨立一份是因為 App 讀的是 accountCfg 不是 DirectConfig（兩邊帳號結構本來就分開存，
// 見 app.go accountCfg 檔頭註解），不是重新發明。
func feedbackWorkflowURL(cypherURL, namespace string) string {
	return fmt.Sprintf("%s/webhooks/named/%s/feedback_report/trigger",
		strings.TrimSuffix(cypherURL, "/"), namespace)
}

// SubmitFeedback 是前端「打字回報」按送出時呼叫的唯一入口。
// attachDiagnostics=true 時順便把匯出診斷檔同一份資料（只有統計數字，不含使用者
// 任何文件內容）一起帶上，不必使用者自己另外匯出、另外找地方附加。
func (a *App) SubmitFeedback(text string, attachDiagnostics bool) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("請先寫下你遇到的狀況再送出")
	}

	cfg, err := loadCfg()
	if err != nil || len(cfg.Accounts) == 0 {
		return fmt.Errorf("還沒連上任何知識庫，沒有地方可以送出（先在左側「連上知識庫」）")
	}

	// 🔴 不再寫死 accounts[0]（2026-09-29 Mac 實測：accounts[0] 的雲端版本太舊、
	// 沒有 feedback_report → 404，而且原本把伺服器回應原文（含「請先執行 acr push」
	// 這種開發者指令）直接丟給學員）。改成依序試每個帳號：某個帳號送不出去（雲端太舊、
	// 暫時連不上⋯）就換下一個，只要有一個送到就算成功；全部都不行才回錯誤，
	// 且錯誤一律是人話、不帶伺服器原文。
	var lastErr error
	usable := 0
	allNotInstalled := true
	for _, acc := range cfg.Accounts {
		if strings.TrimSpace(acc.CypherURL) == "" || strings.TrimSpace(acc.Namespace) == "" {
			continue
		}
		usable++
		payload := feedbackPayload{
			Text:     text,
			Version:  version,
			Instance: firstNonEmptyFeedback(acc.InstanceName, acc.Namespace),
			OS:       runtime.GOOS,
		}
		if attachDiagnostics {
			payload.Diagnostics = a.buildDiagnosticsPayload()
		}
		err, notInstalled := postFeedback(acc, payload)
		if err == nil {
			return nil
		}
		lastErr = err
		if !notInstalled {
			allNotInstalled = false
		}
	}
	if usable == 0 {
		return fmt.Errorf("這個知識庫帳號設定不完整，無法送出——請重新連線一次")
	}
	if allNotInstalled {
		// 不出整句：回傳固定代碼，畫面把「回報」鈕換成能動手的「更新」（開該帳號 Portal）（#240 c18387）
		return errCloudOld
	}
	return lastErr
}

// postFeedback 送一個帳號。notInstalled=true 代表該帳號的雲端沒有 feedback_report
// （404，通常是雲端版本比小幫手舊），呼叫端可以換別的帳號試。
// 回給學員的錯誤字串不含伺服器回應原文（可能夾帶開發者指令）。
func postFeedback(acc accountCfg, payload feedbackPayload) (err error, notInstalled bool) {
	body, merr := json.Marshal(payload)
	if merr != nil {
		return fmt.Errorf("組回報內容失敗：%w", merr), false
	}
	req, rerr := http.NewRequest(http.MethodPost, feedbackWorkflowURL(acc.CypherURL, acc.Namespace), bytes.NewReader(body))
	if rerr != nil {
		return fmt.Errorf("沒送出去：請求錯誤"), false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Arcrun-API-Key", acc.Namespace)

	resp, derr := feedbackHTTP.Do(req)
	if derr != nil {
		return fmt.Errorf("沒送出去：網路"), false
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode == http.StatusNotFound {
		return errCloudOld, true
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("沒送出去：HTTP %d", resp.StatusCode), false
	}

	var out struct {
		Success bool `json:"success"`
		Data    struct {
			Success bool   `json:"success"`
			Error   string `json:"error"`
		} `json:"data"`
	}
	// 回應解析失敗不視為送出失敗——HTTP 已經是 2xx，工作流真的跑過了；
	// 解析只是想抓「內層其實回報失敗」這種狀況（同 wiki agent-memory.md 記過的
	// notify_leo 那個「外層 success:true、內層卻失敗」坑，見票 comment 10305）。
	if json.Unmarshal(snippet, &out) == nil {
		if !out.Success || (out.Data.Error != "" && !out.Data.Success) {
			msg := out.Data.Error
			if msg == "" {
				msg = "工作流回報失敗"
			}
			return fmt.Errorf("沒送出去：%s", msg), false
		}
	}
	return nil, false
}

func firstNonEmptyFeedback(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return "unknown"
}
