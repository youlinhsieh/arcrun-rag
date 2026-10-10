package main

// textbudget.go — 畫面字數預算（inkstone/arcrun-rag#240 c18306，leo 2026-10-09）
//
// 規則本體：InkStoneCo `system-dev/wiki/cards/product-principles/說明文字代表設計不良20261009.md`「字數預算」。
//
//	常駐標籤 ≤ 6 字／按鈕 ≤ 4 字／通知標題 ≤ 20 字（主體 · 狀態 · 數字）／
//	通知展開 ≤ 3 行、每行 ≤ 20 字／hover 提示一句 ≤ 25 字；句號逗號一律不准。
//
// 「後端原樣給的字串」不是豁免：collector 與 status.json 裡那些長句子有別的用途（診斷檔、
// 歸類、log），**回給前端的那一份**在 GetState 最後一步經過 compactUI 收成預算內的短字串。
// 前端只認這份短字串，從來拿不到長句。budgetViolations 是機械檢查：
// 任何新加的字串欄位只要超過 25 字或帶句號，測試就擋下，必須明確歸類（短化、或登記為資料）。

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"arcrun-rag/collector"
)

const (
	// 數值的唯一一份是 schemas/text-budget.json（TestTextBudgetMatchesSharedSpec 對照，不准漂）
	budgetTitle  = 20 // 通知標題一行
	budgetHover  = 25 // hover 提示一句
	budgetDetail = 60 // 通知展開：3 行 × 20 字
)

// budgetCount＝計字規則（與 schemas/text-budget.json 的 count 同一條）：去掉空白與「·」。
func budgetCount(s string) int {
	n := 0
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '·' || r == '\u3000' {
			continue
		}
		n++
	}
	return n
}

// clipRunes 截到 n 個字，超過就以「…」收尾（總長仍 ≤ n）。
func clipRunes(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// compactUI 把回給前端的所有「給人看的字串」收進預算。冪等。
func compactUI(st *UIState) {
	if st == nil {
		return
	}
	// 前端已不畫這幾個（首頁大字／時間軸／帳號動態句），不再往前端送
	st.StatusBig, st.StatusSub, st.Steps = "", "", nil
	for i := range st.Accounts {
		a := &st.Accounts[i]
		a.Status.Line = ""
		if a.Trouble != nil {
			a.Trouble.Title = fmt.Sprintf("⚠ 送不上 %d", a.Trouble.Count)
			a.Trouble.Detail = clipRunes(a.Trouble.Detail, budgetDetail)
		}
		if b := a.Battery; b != nil {
			b.Line, b.Warning = batteryShort(b)
		}
		for j := range a.Folders {
			f := &a.Folders[j]
			f.ResyncNote = ""
			f.RetireError = clipRunes(f.RetireError, budgetDetail)
			f.SyncTip = clipRunes(f.SyncTip, budgetHover)
		}
	}
	if k := st.Skipped; k != nil {
		n := len(k.Files) + k.More
		k.Title = fmt.Sprintf("⊘ 讀不了 %d", n)
		k.Note, k.Other = "", ""
	}
	if q := st.Quota; q != nil {
		c := *q
		c.Headline = quotaTitle(&c)
		c.Achievement, c.Usage, c.Guarantee, c.ExitOptions = "", "", "", ""
		st.Quota = &c
	}
	for i := range st.Stalls {
		st.Stalls[i].Label = clipRunes(st.Stalls[i].Label, budgetHover)
	}
	if m := st.QuotaMeter; m != nil {
		// 三句長說明換成短字：沒資料就「尚無資料」，搜尋另計額度
		c := *m
		c.ReadNote = "搜尋另計額度"
		if c.ReadExhausted {
			c.ReadNote = "搜尋額度用完"
		}
		if c.WriteNote != "" {
			c.WriteNote = "尚無資料"
		}
		if c.BatchNote != "" {
			c.BatchNote = "尚無資料"
		}
		st.QuotaMeter = &c
	}
}

// batteryShort：量表旁的 hover（Line）與通知標題（Warning，沒事就空）。
func batteryShort(b *UIBattery) (line, warning string) {
	if b.FromUsage {
		// #246 c18653：數字＝儀表最吃緊那一項的已用 %；付費越線不警告（儀表的 $ 已經在講）
		pct := trimPercent(b.Percent)
		line = "已用 " + pct + "%"
		switch {
		case !b.PctKnown || b.Paid:
		case b.Level == "crit":
			warning = "⏸ 用量用完"
		case b.Saver:
			warning = "⚠ 用量 " + pct + "% · 放慢"
		case b.Level == "warn":
			warning = "⚠ 用量 " + pct + "%"
		}
		return
	}
	pct := trimPercent(b.Percent)
	if b.Paid {
		if b.PctKnown {
			return "∞ 剩 " + pct + "%", ""
		}
		return "∞", ""
	}
	line = "剩 " + pct + "%"
	switch {
	case b.Percent <= 0:
		warning = "⏸ 用量用完"
	case b.Saver:
		warning = "⚠ 用量 " + pct + "% · 放慢"
	case b.Level == "warn":
		warning = "⚠ 用量 " + pct + "%"
	}
	return
}

// quotaTitle：額度卡標題「⏸ 額度用完 · 08:00 恢復」，排隊數由前端接在後面（它有進度數字）。
func quotaTitle(q *collector.QuotaNotice) string {
	what := "額度用完"
	switch q.Kind {
	case "d1_read":
		what = "讀取額度用完"
	case "d1_write":
		what = "寫入額度用完"
	}
	if at, err := time.Parse(time.RFC3339, q.ResumeAt); err == nil {
		return fmt.Sprintf("⏸ %s · %s 恢復", what, at.In(time.FixedZone("Asia/Taipei", 8*3600)).Format("15:04"))
	}
	return "⏸ " + what
}

// ── 機械檢查：走過整份要送給前端的 JSON，列出超出預算的字串 ──────────────────

var (
	// 資料（名稱、路徑、網址、版本、檔名、錯誤原文等）：內容不是我們寫的，不受字數預算。
	budgetDataKey = regexp.MustCompile(`(^|\.)(name|host|path|dismissKey|dismiss_key|email|version|logFolder|fingerprint|account|accIdx|latest|cloudVer\w*|resume_at|category|sync|level|kind|state|engine|id|samples\[\]|files\[\]|skip_reason|reason|reason_label)$`)
	titleKey      = regexp.MustCompile(`(^|\.)(title|headline|warning)$`)
	detailKey     = regexp.MustCompile(`(^|\.)(detail|retireError)$`)
)

// budgetViolations 回傳超出預算的 (路徑, 字串)。walk 的輸入是 json.Unmarshal 出來的 any。
func budgetViolations(v any) []string {
	var out []string
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				p := k
				if path != "" {
					p = path + "." + k
				}
				walk(p, c)
			}
		case []any:
			for _, c := range x {
				walk(path+"[]", c)
			}
		case string:
			n := utf8.RuneCountInString(x)
			if titleKey.MatchString(path) {
				n = budgetCount(x)
			}
			hasPunct := strings.ContainsAny(x, "。，；")
			limit := budgetHover
			switch {
			case budgetDataKey.MatchString(path):
				return
			case titleKey.MatchString(path):
				limit = budgetTitle
			case detailKey.MatchString(path):
				limit = budgetDetail
				hasPunct = false // 展開內容是系統原文，只管長度
			}
			if n > limit || (hasPunct && !detailKey.MatchString(path)) {
				out = append(out, fmt.Sprintf("%s（%d 字，上限 %d）：%s", path, n, limit, x))
			}
		}
	}
	walk("", v)
	return out
}
