// cloudquota.go — 雲端資料庫（Cloudflare D1）每日免費額度用完時，講明白、且不再重打
// （`inkstone/arcrun-rag#197`，母票 `inkstone/InkStoneCo#132`）。
//
// 病（2026-09-13 實撞，youlin 與 geek6688 兩台免費帳號同一天）：
// D1 當日讀取額度用完，雲端每一件事都失敗。使用者在小幫手上看到的是
// 「缺少 credential: kbdb_internal_token」（假的，`inkstone/Arcrun#216` c7066 已查證）
// 與「連續失敗 N 次，已暫停自動重試」——**沒有任何一處說「額度用完了」**。
//
// 而雲端其實早就知道：cypher `/health` 的 `data_layer.probe_error` 當下寫著
//
//	D1_ERROR: Your account has exceeded D1's free tier daily row read limit.
//	Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.
//
// 小幫手每分鐘本來就在打這支 `/health`（cloudcheck.go），只是只讀了版本號。
// ⇒ 本檔把「知道的地方」接到「用戶看得到的地方」，並且在額度恢復前**整個帳號不再打雲端寫入**
// （恢復前每一發都只會拿到同一個錯，還會讓免費帳號的其他額度一起被燒）。
//
// 🔴 用量數字：Cloudflare 只在帳號層的 GraphQL 分析 API 給得出「今天用了幾列」，
// 而小幫手身上沒有任何 Cloudflare 金鑰，安裝器要的授權範圍也沒有分析讀取權限
// （installer/oauth-prototype/worker.js `OAUTH_SCOPES`）。所以這一版**不假裝查得到**：
// 上限是官方公開的固定值（developers.cloudflare.com/d1/platform/pricing/，
// Workers Free：每天讀 500 萬列、寫 10 萬列，00:00 UTC 重置），
// 而「已經用到上限」是錯誤訊息本身證明的事實——兩句都是真的，不必查。
package collector

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// D1 免費方案每日上限（Cloudflare 官方定價頁，2026-09-13 查）。
const (
	d1FreeRowsReadPerDay    = 5_000_000
	d1FreeRowsWrittenPerDay = 100_000
)

// QuotaNotice.Kind 的值。空字串＝舊的 Workers AI 額度（向後相容 status.json）。
const (
	QuotaKindD1Read  = "d1_read"
	QuotaKindD1Write = "d1_write"
)

// d1QuotaKind 從任何一段上游文字認出「D1 每日免費額度用完」，回 read／write／""。
// 只認 Cloudflare 錯誤原文裡的固定片段——「D1_ERROR」單獨出現不算（別的 D1 錯誤也帶它）。
func d1QuotaKind(text string) string {
	t := strings.ToLower(text)
	if !strings.Contains(t, "free tier") && !strings.Contains(t, "daily") {
		return ""
	}
	switch {
	case strings.Contains(t, "row read limit"), strings.Contains(t, "rows read"):
		return QuotaKindD1Read
	case strings.Contains(t, "row write limit"), strings.Contains(t, "rows written"), strings.Contains(t, "row written"):
		return QuotaKindD1Write
	}
	return ""
}

// d1QuotaFromHealth 讀 cypher `/health` 的回應，回它回報的 D1 額度狀況（""＝沒有）。
// 舊版雲端（沒有 data_layer 區塊，例如 1.4.46）一律回 ""——認不出來就不編故事。
func d1QuotaFromHealth(body []byte) string {
	var payload struct {
		DataLayer *struct {
			OK         bool   `json:"ok"`
			ProbeError string `json:"probe_error"`
			Summary    string `json:"summary"`
		} `json:"data_layer"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.DataLayer == nil || payload.DataLayer.OK {
		return ""
	}
	if k := d1QuotaKind(payload.DataLayer.ProbeError); k != "" {
		return k
	}
	return d1QuotaKind(payload.DataLayer.Summary)
}

type d1QuotaState struct {
	kind  string
	seen  time.Time // 最後一次親眼看到額度用完的時間
	until time.Time // 下一次 00:00 UTC——過了就一定不再相信這筆紀錄
}

var (
	d1QuotaMu   sync.Mutex
	d1QuotaSeen = map[string]d1QuotaState{} // key＝cloudCheckKey(cypherURL)
)

func resetD1Quota() {
	d1QuotaMu.Lock()
	defer d1QuotaMu.Unlock()
	d1QuotaSeen = map[string]d1QuotaState{}
}

// noteD1Quota 記下「這台知識庫此刻的 D1 額度狀況」。kind==""＝雲端親口說資料層正常 ⇒ 清掉。
func noteD1Quota(cypherURL, kind string, now time.Time) {
	key := cloudCheckKey(cypherURL)
	d1QuotaMu.Lock()
	defer d1QuotaMu.Unlock()
	if kind == "" {
		delete(d1QuotaSeen, key)
		return
	}
	d1QuotaSeen[key] = d1QuotaState{kind: kind, seen: now, until: nextQuotaResetTaiwan(now)}
}

// activeD1Quota 回這台知識庫現在是否處於 D1 額度用完（過了重置時間的舊紀錄一律丟掉）。
func activeD1Quota(cypherURL string, now time.Time) (d1QuotaState, bool) {
	key := cloudCheckKey(cypherURL)
	d1QuotaMu.Lock()
	defer d1QuotaMu.Unlock()
	st, ok := d1QuotaSeen[key]
	if !ok {
		return d1QuotaState{}, false
	}
	if !now.Before(st.until) {
		delete(d1QuotaSeen, key)
		return d1QuotaState{}, false
	}
	return st, true
}

// buildD1QuotaNotice 組出給用戶看的話。欄位沿用 QuotaNotice（App 首頁那張卡、托盤狀態列都吃它）。
//
// 用戶要知道的四件事（票上的驗收條件）：哪一種額度／用了多少、上限多少／台北幾點恢復／恢復後要不要做事。
func buildD1QuotaNotice(kind string, now, resetAt time.Time) QuotaNotice {
	what, limit := "讀取", fmt.Sprintf("每天 %s列", humanRows(d1FreeRowsReadPerDay))
	if kind == QuotaKindD1Write {
		what, limit = "寫入", fmt.Sprintf("每天 %s列", humanRows(d1FreeRowsWrittenPerDay))
	}
	return QuotaNotice{
		Kind:        kind,
		Headline:    fmt.Sprintf("你的雲端知識庫今天的免費%s額度用完了", what),
		Usage:       fmt.Sprintf("Cloudflare 免費方案的資料庫%s上限是%s，今天已經用到上限（這不是小幫手或你的檔案壞掉）", what, limit),
		Achievement: fmt.Sprintf("雲端資料庫今天的免費%s額度用完了", what),
		ExitOptions: "升級 Cloudflare Workers 付費方案（每月 5 美元起）就沒有每日上限",
		Guarantee: fmt.Sprintf("台北時間%s早上 8:00 恢復，恢復後小幫手會自動接著傳，你不用做任何事",
			quotaResetDayWord(now, resetAt)),
		ResumeAt: resetAt.Format(time.RFC3339),
	}
}

func humanRows(n int) string {
	if n >= 10_000 && n%10_000 == 0 {
		return fmt.Sprintf("%d 萬", n/10_000)
	}
	return fmt.Sprintf("%d", n)
}

// d1QuotaNote＝「這一發不打，因為雲端資料庫額度用完」的一句話；空＝可以打。
//
// 🔴 結尾「會自動恢復」是 explainsWhySkipped 的識別字（sync_status.go）——被擋下的檔
// 要帶著這句話出現在畫面上，不能安靜消失。
func d1QuotaNote(cypherURL string, now time.Time) string {
	st, ok := activeD1Quota(cypherURL, now)
	if !ok {
		return ""
	}
	n := buildD1QuotaNotice(st.kind, now, st.until)
	return n.Headline + "，先不送，避免白白重打；" + n.Guarantee + "（會自動恢復）。"
}
