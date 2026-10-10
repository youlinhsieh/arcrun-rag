package main

// activity_state.go — 帳號與資料夾只有幾種狀態（inkstone/arcrun-rag#240 c18615／c18616，leo 2026-10-10）。
//
// leo 原話：「有在跑就顯示在跑，像呼吸燈那樣在動；沒在跑有 2 種問題：① 有解——他去做什麼事就可以跑起來
// （檔案格式、尺寸…），告訴他問題是什麼，或連到 FAQ；② 無解——這是新問題，我們沒有 FAQ，就有一個回報按鈕。
// 不要的，就是有表達很多符號，但用戶束手無策。」「顯示『!8』，這個字就可以 popup，點擊，告訴你怎麼解決，或是一鍵回報。」
//
//	running     有東西排隊、而且真的有人在做            → 呼吸燈＋已送上/總數
//	done        每一份都送上去了、沒有任何卡住的        → ✓
//	fixable     沒在跑，原因是用戶做得到的事            → !N，點開：問題＋FAQ
//	unsolvable  沒在跑，原因我們沒有 FAQ（新問題）      → !N，點開：一鍵回報
//
// 「排隊但沒在跑」不准長得像在跑：有排隊但額度用完 ⇒ fixable；有排隊、引擎活著、近一小時一份都沒送出 ⇒ unsolvable
// （那是我們的 bug，要回報）；引擎沒活著 ⇒ unsolvable。「已打勾」與「有卡住」不能同時出現：有卡住就不是 done。

import (
	"fmt"
	"path/filepath"

	collector "arcrun-rag/collector"
)

const (
	actRunning    = "running"
	actDone       = "done"
	actFixable    = "fixable"
	actUnsolvable = "unsolvable"
	actUnknown    = "unknown"
)

// activityIn＝判斷一個範圍（帳號或資料夾）狀態所需的事實。
type activityIn struct {
	P        collector.SyncProgress
	Known    bool
	Alive    bool // 同步引擎活著
	Blocked  bool // 這個帳號正在額度冷卻
	SentHour int  // 近一小時送上幾份；-1＝不知道
}

// activityOut＝畫面要的：狀態、一個短標籤（≤6 字）、要顯示在「!」旁的數字。
type activityOut struct {
	State string
	Why   string
	// N＝出錯份數（SyncProgress.Errors，與排隊互斥；#246 c18681）。**不是排隊數**：
	// 排隊但沒在動時狀態仍是 unsolvable，但 N 可以是 0（只有「!」，沒有數字）。
	N int
}

func activityOf(in activityIn) activityOut {
	p := in.P
	if !in.Known {
		return activityOut{State: actUnknown}
	}
	if p.Pending > 0 {
		switch {
		case in.Blocked:
			return activityOut{State: actFixable, Why: "額度用完", N: p.Errors()}
		case !in.Alive:
			return activityOut{State: actUnsolvable, Why: "沒在跑", N: p.Errors()}
		case in.SentHour == 0:
			return activityOut{State: actUnsolvable, Why: "沒在動", N: p.Errors()}
		}
		return activityOut{State: actRunning, N: p.Errors()}
	}
	if p.Stuck > 0 {
		if unk := p.Stuck - p.StuckFix; unk > 0 {
			return activityOut{State: actUnsolvable, Why: "新問題", N: p.Errors()}
		}
		return activityOut{State: actFixable, Why: p.StuckWhy, N: p.Errors()}
	}
	if p.Total > 0 && p.Done >= p.Total {
		return activityOut{State: actDone}
	}
	return activityOut{State: actUnknown}
}

// problemReportText＝「無解」回報的內容：全是結構化事實，沒有文件內容（同 stallReportText 的紅線）。
func problemReportText(accName, host, folder string, p collector.SyncProgress, out activityOut, samples []string, rawErr string) string {
	s := "【自動回報：小幫手沒在跑】用戶按了「回報」。\n\n"
	s += fmt.Sprintf("- 知識庫：%s（%s）\n", accName, host)
	if folder != "" {
		s += fmt.Sprintf("- 資料夾：%s\n", filepath.Base(folder))
	}
	s += fmt.Sprintf("- 狀態：%s（%s）%d 份\n", out.State, out.Why, out.N)
	s += fmt.Sprintf("- 進度：共 %d／已送上 %d／排隊 %d／卡住 %d\n", p.Total, p.Done, p.Pending, p.Stuck)
	if len(samples) > 0 {
		s += fmt.Sprintf("- 檔名樣本：%v\n", samples)
	}
	if rawErr != "" {
		s += "- 錯誤原文：" + redactLocalPaths(rawErr) + "\n"
	}
	s += fmt.Sprintf("- 小幫手版本：%s\n\n（此回報由小幫手自動產生，不含任何文件內容。）", version)
	return s
}
