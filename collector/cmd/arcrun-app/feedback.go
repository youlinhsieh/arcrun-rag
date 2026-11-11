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
	"regexp"
	"runtime"
	"strconv"
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
	// EventKey（#309）：同一個事件（知識庫＋檔／資料夾＋原因）永遠同一個 key；AHub 收到第二次起
	// 不開新票，併成第一張的留言。空字串＝省略（不當成事件、照舊開票）。
	EventKey string `json:"event_key,omitempty"`
	// Compared（#309）：AHub 開票前比對到相近的票會回 409；自動回報以事件鍵區分事件，
	// 所以第一次回報被擋時，小幫手帶著逐張交代重送（見 postFeedback）。
	Compared []feedbackCompared `json:"compared,omitempty"`
}

type feedbackCompared struct {
	Ref    string `json:"ref"`
	Reason string `json:"reason"`
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
//
// 🔴 inkstone/arcrun-rag#255：以前一律取 Accounts[0]，多帳號時（leo21c 的回報被標成 geek6688、
// #250 的 youlin 也被標成 geek6688）收件的人會查錯實例。現在由「回報是針對哪台知識庫」的呼叫端
// 帶 host 進來（forHost）；沒帶（純手打回報、不屬於任何一台）才退回第一個帳號。
func feedbackInstanceLabel() string { return feedbackInstanceLabelFor("") }

func feedbackInstanceLabelFor(forHost string) string {
	cfg, err := loadCfg()
	if err != nil || len(cfg.Accounts) == 0 {
		return "（尚未連上知識庫）"
	}
	acc := cfg.Accounts[0]
	if h := strings.TrimSpace(forHost); h != "" {
		for _, a := range cfg.Accounts {
			if shortHost(a.CypherURL) == h {
				acc = a
				break
			}
		}
	}
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
	return a.submitFeedbackFor(text, attachDiagnostics, "", "")
}

// submitFeedbackFor：forHost＝這則回報針對的知識庫主機（空＝不屬於任何一台）；
// eventKey＝這個事件的鍵（#309，空＝自由文字，用「知識庫＋這段話」算一個）。
func (a *App) submitFeedbackFor(text string, attachDiagnostics bool, forHost, eventKey string) error {
	_, err := a.submitFeedbackRef(text, attachDiagnostics, nil, forHost, eventKey)
	return err
}

// submitFeedbackRef＝submitFeedbackFor，另外回票號（空＝收件端沒告訴我們）。
// diag 非 nil＝用呼叫端已經組好（而且已經給用戶看過）的診斷資料，**不再重組**——
// 給用戶看的就是寄出去的（#330：同意才寄出，寄的必須是他看過的）。
func (a *App) submitFeedbackRef(text string, attachDiagnostics bool, diag any, forHost, eventKey string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("請先寫下你遇到的狀況再送出")
	}
	now := time.Now()
	if !feedbackAllow(now) {
		return "", fmt.Errorf("一小時內送了太多則回報，請稍後再試（你寫的內容還在，不會消失）")
	}

	if eventKey == "" {
		h := strings.TrimSpace(forHost)
		if h == "" {
			h = feedbackInstanceLabelFor("")
		}
		eventKey = textEventKey(h, text)
	}
	payload := feedbackPayload{
		Text:     text,
		Version:  version,
		Instance: feedbackInstanceLabelFor(forHost),
		OS:       runtime.GOOS,
		EventKey: eventKey,
	}
	if diag != nil {
		payload.Diagnostics = diag
	} else if attachDiagnostics {
		payload.Diagnostics = a.buildDiagnosticsPayload()
	}
	ref, err := postFeedbackRef(payload)
	if err != nil {
		return "", err
	}
	feedbackRecord(now)
	return ref, nil
}

// postFeedback 送到我們的收件端。回給學員的錯誤字串一律是人話，不含伺服器回應原文
// （可能夾帶開發者指令）。
func postFeedback(payload feedbackPayload) error {
	_, err := postFeedbackRef(payload)
	return err
}

// postFeedbackRef＝postFeedback，另外回「開（或併進）的是哪一張票」（inkstone/arcrun-rag#330：
// 用戶同意通報後要看得到票號）。回應看不出票號＝回空字串，不算失敗（票確實開了）。
func postFeedbackRef(payload feedbackPayload) (string, error) {
	ref, err := postFeedbackOnceRef(payload)
	// #309：AHub 開票前比對到相近的票會擋下（工作流把候選編在錯誤訊息裡）。
	// 自動回報用事件鍵區分事件：事件鍵還沒有票＝這是新事件，帶著逐張交代重送一次。
	if refs := duplicateCandidates(err); len(refs) > 0 && payload.EventKey != "" && len(payload.Compared) == 0 {
		payload.Compared = comparedForEvent(payload.EventKey, refs)
		return postFeedbackOnceRef(payload)
	}
	return ref, err
}

var dupRefRe = regexp.MustCompile(`[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+`)

// duplicateCandidates 從「開票被當成重複」的錯誤取出候選票（工作流標記 `重複候選=`）。
func duplicateCandidates(err error) []string {
	if err == nil {
		return nil
	}
	msg := err.Error()
	i := strings.Index(msg, "重複候選=")
	if i < 0 {
		return nil
	}
	return dupRefRe.FindAllString(msg[i:], -1)
}

// comparedForEvent：每一張候選各一句不同的理由（AHub 要求逐張、各不相同、不是只抄標題）。
func comparedForEvent(key string, refs []string) []feedbackCompared {
	var out []feedbackCompared
	seen := map[string]bool{}
	for _, r := range refs {
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, feedbackCompared{Ref: r, Reason: fmt.Sprintf(
			"小幫手自動回報以事件鍵區分事件：事件鍵 %s（知識庫＋檔案或資料夾＋原因）還沒有任何票，%s 不是同一個事件鍵，所以這是新事件、另開一張", key, r)})
	}
	return out
}

func postFeedbackOnce(payload feedbackPayload) error {
	_, err := postFeedbackOnceRef(payload)
	return err
}

// feedbackReadMax＝回應最多讀多少來找票號。工作流成功時回的是一小包，但引擎有時回整份執行紀錄
// （inkstone/Arcrun#311 在瘦身），2KB 常常切在 JSON 中間；多讀一些，仍設上限。
const feedbackReadMax = 256 << 10

func postFeedbackOnceRef(payload feedbackPayload) (string, error) {
	body, merr := json.Marshal(payload)
	if merr != nil {
		return "", fmt.Errorf("組回報內容失敗：%w", merr)
	}
	req, rerr := http.NewRequest(http.MethodPost, feedbackInboxURL(), bytes.NewReader(body))
	if rerr != nil {
		return "", fmt.Errorf("沒送出去，請再試一次（%v）", rerr)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, derr := feedbackHTTP.Do(req)
	if derr != nil {
		return "", fmt.Errorf("沒送出去，請再試一次（網路錯誤：%v）", derr)
	}
	defer resp.Body.Close()
	full, _ := io.ReadAll(io.LimitReader(resp.Body, feedbackReadMax))
	snippet := full
	if len(snippet) > 2048 {
		snippet = snippet[:2048]
	}
	// #309：工作流失敗時引擎回 HTTP 500，但「被當成相近票」的候選在回應本文裡——要先取出來，
	// 不然下面只會看到一個代碼 500，永遠沒機會帶逐張交代重送。（只取 ref，不把伺服器原文給學員。）
	if i := bytes.Index(snippet, []byte("重複候選=")); i >= 0 {
		refs := dupRefRe.FindAllString(string(snippet[i:]), -1)
		if len(refs) > 0 {
			return "", fmt.Errorf("沒送出去：這個問題跟已經有的票太像了（重複候選=%s）", strings.Join(refs, " "))
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("沒送出去，請再試一次（回報服務暫時有問題，代碼 %d）", resp.StatusCode)
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
			return "", fmt.Errorf("沒送出去：%s", msg)
		}
	}
	return feedbackTicketRef(full), nil
}

// feedbackTicketRef 從工作流的回應找出票號（`finalize` 回 {repo, number, url}；同事件第二次起回的是第一張的票號）。
// 回「inkstone/arcrun-rag#N」；找不到回空字串。回應可能是巢狀信封，也可能被截在半途，所以兩條路：
// 先走 JSON 找同時有 number 與 repo 的物件，不行再用正規式撿。
func feedbackTicketRef(body []byte) string {
	var v any
	if json.Unmarshal(body, &v) == nil {
		// 先找同時有 repo 與 number 的（finalize 的形狀），才不會撿到執行紀錄裡別的欄位叫 number 的東西
		if repo, n := findTicket(v, 0, true); n > 0 {
			return repo + "#" + strconv.Itoa(n)
		}
		if repo, n := findTicket(v, 0, false); n > 0 {
			return repo + "#" + strconv.Itoa(n)
		}
	}
	m := ticketNumRe.FindSubmatch(body)
	if m == nil {
		return ""
	}
	n, _ := strconv.Atoi(string(m[1]))
	repo := feedbackDefaultRepo
	if r := ticketRepoRe.FindSubmatch(body); r != nil {
		repo = string(r[1])
	}
	if n <= 0 {
		return ""
	}
	return repo + "#" + strconv.Itoa(n)
}

// 收件端開票的 repo（feedback_report 工作流 prep 的預設）。
const feedbackDefaultRepo = "inkstone/arcrun-rag"

var (
	ticketNumRe  = regexp.MustCompile(`"number"\s*:\s*([0-9]+)`)
	ticketRepoRe = regexp.MustCompile(`"repo"\s*:\s*"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"`)
)

func findTicket(v any, depth int, needRepo bool) (string, int) {
	if depth > 8 {
		return "", 0
	}
	switch x := v.(type) {
	case map[string]any:
		if nf, ok := x["number"].(float64); ok && nf > 0 {
			repo, _ := x["repo"].(string)
			if repo != "" || !needRepo {
				if repo == "" {
					repo = feedbackDefaultRepo
				}
				return repo, int(nf)
			}
		}
		for _, c := range x {
			if r, n := findTicket(c, depth+1, needRepo); n > 0 {
				return r, n
			}
		}
	case []any:
		for _, c := range x {
			if r, n := findTicket(c, depth+1, needRepo); n > 0 {
				return r, n
			}
		}
	}
	return "", 0
}
