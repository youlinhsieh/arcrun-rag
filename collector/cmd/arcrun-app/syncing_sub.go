// syncing_sub.go — 「同步中」底下那一行要講得出做到哪、卡在哪（`inkstone/arcrun-rag#200`）。
//
// 🔴 病（2026-09-13 leo 截圖）：畫面整晚寫「同步中… 正在讀檔並整理成知識卡／
// 請稍候，完成後會顯示整理了幾份」，而 collector.log 裡明明印著
// 「還在等知識庫 leo21c 回覆『送出一份筆記』，已經等了 30 秒」。
// **會說話的那句只寫進了記錄檔，畫面上是一句永遠不變的「請稍候」**——
// 使用者分不出「正在做」和「卡住了」，只能猜。
//
// 資料來源只有一個：collector 一輪途中寫進 status.json 的 in_round（collector/live_status.go）。
// 這裡不判斷任何事，只把它念成一句話。
package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"arcrun-rag/collector"
)

// syncingIdleWarnAfter＝多久沒有任何新寫入，就明講「已經 N 分鐘沒有新進展」。
// 「還在等」每 30 秒會寫一次，所以正常等待不會碰到這條；碰到＝真的沒在動。
const syncingIdleWarnAfter = 5 * time.Minute

const syncingSubFallback = "請稍候，完成後會顯示整理了幾份"

// syncingSub 把「這一輪做到哪」念成一句話。r 為 nil（舊版 collector、剛開工還沒寫）＝沿用原本那句。
// label 把主機名翻成使用者認得的知識庫名字（測試可以換掉）。
func syncingSub(r *collector.RoundProgress, now time.Time, label func(host string) string) string {
	if r == nil {
		return syncingSubFallback
	}
	where := ""
	if r.Account != "" {
		where = label(r.Account)
	}
	if r.Folder != "" {
		name := filepath.Base(r.Folder)
		if where != "" {
			where = fmt.Sprintf("%s（%s）", name, where)
		} else {
			where = name
		}
	}

	// 卡住的時候，只講卡在哪——這是使用者此刻唯一需要知道的事。
	if w := r.Waiting; w != nil && strings.TrimSpace(w.Note) != "" {
		if where != "" {
			return fmt.Sprintf("卡在「%s」：%s", where, w.Note)
		}
		return "卡住了：" + w.Note
	}

	var parts []string
	if where != "" {
		head := "正在處理 " + where
		if r.Step != "" {
			head += "：" + r.Step
		}
		parts = append(parts, head)
	}
	if r.Ingested > 0 {
		parts = append(parts, fmt.Sprintf("這一輪已送上 %d 份", r.Ingested))
	}
	if r.Failed > 0 {
		parts = append(parts, fmt.Sprintf("%d 份沒送成功", r.Failed))
	}
	if t, err := time.Parse(time.RFC3339, r.UpdatedAt); err == nil {
		if idle := now.Sub(t); idle > syncingIdleWarnAfter {
			parts = append(parts, fmt.Sprintf("已經 %d 分鐘沒有新進展", int(idle.Minutes())))
		}
	}
	if len(parts) == 0 {
		return syncingSubFallback
	}
	return strings.Join(parts, " · ")
}

// accountLabelFor 把 status.json 裡的主機名翻成畫面左邊那個知識庫名字（與 UIAccount.Name 同一套）。
func accountLabelFor(host string) string {
	if cfg, err := loadCfg(); err == nil {
		for _, a := range cfg.Accounts {
			if shortHost(a.CypherURL) == host {
				return accountName(a)
			}
		}
	}
	return host
}

// syncWhere＝同步鈕 tooltip 的短標籤「知識庫 · 檔名」（不是整句話）。
// 檔名優先取正在等的那一發（Waiting.File），其次這一發（File），沒有就資料夾名。
func syncWhere(r *collector.RoundProgress, label func(host string) string) string {
	if r == nil {
		return ""
	}
	var parts []string
	acc := r.Account
	if r.Waiting != nil && r.Waiting.Account != "" {
		acc = r.Waiting.Account
	}
	if acc != "" {
		parts = append(parts, label(acc))
	}
	file := r.File
	if r.Waiting != nil && r.Waiting.File != "" {
		file = r.Waiting.File
	}
	switch {
	case file != "":
		parts = append(parts, filepath.Base(file))
	case r.Folder != "":
		parts = append(parts, filepath.Base(r.Folder))
	}
	return strings.Join(parts, " · ")
}

// inRoundFreshFor＝in_round 多久內有更新還算「在做事」。「還在等」每 30 秒寫一次，
// 所以 3 分鐘沒動＝不是在等，是行程被殺留下的殘影，不能讓按鈕永遠轉。
const inRoundFreshFor = 3 * time.Minute

// inRoundFresh：一輪途中的進度檔有沒有在動。r 為 nil（整輪收工了）＝沒有。
func inRoundFresh(r *collector.RoundProgress, now time.Time) bool {
	if r == nil {
		return false
	}
	ts := r.UpdatedAt
	if ts == "" {
		ts = r.StartedAt
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return false
	}
	return now.Sub(t) < inRoundFreshFor
}
