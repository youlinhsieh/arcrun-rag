package main

// usageui.go — 用量分頁的畫面資料（inkstone/arcrun-rag#246，設計 c18630／c18638／c18642）。
//
// 判準只有一處：這裡。前端只畫，一個算式都沒有（除了把數字往前推的「跳動」）。
// 三態：ok 還遠（<80%）／near 接近（80–100%）／over 越線。
//   · 付費帳號越線＝已在收費（亮 $）；免費帳號越線＝今天用完（亮暫停）；地端沒有線，永遠 ok。
// 所有字串都 ≤25 字、無句號逗號（字數預算，textbudget.go 會擋）。

import (
	"fmt"
	"math"
	"strings"
	"time"

	"arcrun-rag/collector"
)

type UIUsageItem struct {
	Key   string  `json:"key"`
	Used  float64 `json:"used"`            // 已用（千分位由前端 toLocaleString）
	Limit float64 `json:"limit,omitempty"` // 線；0＝沒有線
	Over  float64 `json:"over,omitempty"`  // 超出量
	Pct   int     `json:"pct"`             // 0–999
	Level string  `json:"level"`           // ok／near／over
	Per   string  `json:"per"`             // day／month
	Reset string  `json:"reset,omitempty"` // 歸零時間：每天「08:00」、每月「11/01」
	Rate  float64 `json:"rate,omitempty"`  // 每分鐘增加量（往前推用）
	Cost  float64 `json:"cost,omitempty"`  // 本月估計超出費用 US$（只有付費）
	// CostRate＝越線之後每分鐘多花的錢 US$（跳動用）
	CostRate float64 `json:"costRate,omitempty"`
	Dollar   bool    `json:"dollar,omitempty"`
	Pause    bool    `json:"pause,omitempty"`
	// hover 短句（各 ≤25 字）
	TipName  string `json:"tipName"`
	TipNum   string `json:"tipNum"`
	TipReset string `json:"tipReset,omitempty"`
	TipCost  string `json:"tipCost,omitempty"`
}

type UIUsage struct {
	Plan     string        `json:"plan"` // free／paid／local
	Level    string        `json:"level"`
	Top      string        `json:"top,omitempty"` // 最吃緊那一項的 key
	TopPct   int           `json:"topPct"`
	Items    []UIUsageItem `json:"items"`
	MonthUSD float64       `json:"monthUsd,omitempty"`
	Upgrade  string        `json:"upgrade"`              // none／advise／billing／upgrade
	UpgradeN string        `json:"upgradeTip,omitempty"` // hover
	Brake    string        `json:"brake"`                // on／off／na
	Covers   []string      `json:"covers,omitempty"`
	TipBrake string        `json:"tipBrake"`
	TipTop   string        `json:"tipTop"`
	TipMonth string        `json:"tipMonth,omitempty"`
	// 取得時刻（ms）與延遲：前端用它把數字往前推、並在過舊時降低可信度
	AtMs     int64  `json:"atMs"`
	DelaySec int    `json:"delaySec,omitempty"`
	TipFresh string `json:"tipFresh"`
	Stale    bool   `json:"stale,omitempty"`
}

var usageNames = map[string]string{
	collector.UsageAI:       "AI 萃取 neurons",
	collector.UsageVecStore: "向量儲存 維度",
	collector.UsageVecQuery: "向量查詢 維度",
	collector.UsageD1Write:  "資料庫寫入 列",
	collector.UsageD1Read:   "資料庫讀取 列",
	collector.UsageCPU:      "運算時間 ms",
	collector.UsageRequests: "請求數",
	collector.UsageDisk:     "磁碟",
}

var taipei = time.FixedZone("Asia/Taipei", 8*3600)

// commaInt＝千分位整數。
func commaInt(v float64) string {
	n := int64(math.Round(v))
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprintf("%d", n)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func usdText(v float64) string {
	if v > 0 && v < 0.01 {
		return "US$<0.01"
	}
	return fmt.Sprintf("US$%.2f", v)
}

func levelOf(pct float64) string {
	switch {
	case pct >= 100:
		return "over"
	case pct >= 80:
		return "near"
	}
	return "ok"
}

func rankLevel(l string) int {
	switch l {
	case "over":
		return 2
	case "near":
		return 1
	}
	return 0
}

// buildUsageUI 把雲端交來的快照轉成畫面資料。nil＝查不到（前端畫「—」，不編數字）。
// brakeOn：目前剎車是否開著（來自既有的電池狀態：核能＝放行／關閉剎車）。
func buildUsageUI(u *collector.Usage, now time.Time) *UIUsage {
	if u == nil {
		return nil
	}
	ui := &UIUsage{Plan: u.Plan, Level: "ok", Items: []UIUsageItem{}, AtMs: u.Received.UnixMilli(), DelaySec: u.DelaySec}
	if u.Received.IsZero() {
		ui.AtMs = now.UnixMilli()
	}
	paid := u.Plan == collector.UsagePlanPaid
	collector.SortUsageItems(u.Items) // 位置固定：不管雲端怎麼排，畫面都是同一個順序
	for _, it := range u.Items {
		if it.Used <= 0 {
			continue // 只列有用到的
		}
		per := it.Period
		if per != "month" {
			per = "day"
		}
		x := UIUsageItem{Key: it.Key, Used: it.Used, Per: per, Level: "ok", Rate: it.RatePerMin}
		name := usageNames[it.Key]
		if name == "" {
			name = it.Key
		}
		x.TipName = name
		if at, err := time.Parse(time.RFC3339, it.ResetAt); err == nil {
			if per == "day" {
				x.Reset = at.In(taipei).Format("15:04")
				x.TipReset = "每天 " + x.Reset + " 歸零"
			} else {
				x.Reset = at.In(taipei).Format("01/02")
				x.TipReset = "每月 " + x.Reset + " 歸零"
			}
		}
		if it.Limit != nil && *it.Limit > 0 && u.Plan != collector.UsagePlanLocal {
			lim := *it.Limit
			x.Limit = lim
			p := it.Used / lim * 100
			x.Pct = int(math.Min(999, math.Round(p)))
			x.Level = levelOf(p)
			if it.Used > lim {
				x.Over = it.Used - lim
			}
			if x.Level == "over" {
				if paid {
					x.Dollar = true
					cost := x.Over * it.UnitUSD
					if it.CostUSD != nil {
						cost = *it.CostUSD
					}
					x.Cost = cost
					x.CostRate = it.RatePerMin * it.UnitUSD
					x.TipCost = "本月約 " + usdText(cost)
				} else {
					x.Pause = true
				}
			}
			if x.Over > 0 {
				x.TipNum = "額度" + commaInt(lim) + " 超" + commaInt(x.Over)
			} else {
				x.TipNum = "線 " + commaInt(lim)
			}
		} else {
			x.TipNum = "已用 " + commaInt(x.Used)
		}
		if rankLevel(x.Level) > rankLevel(ui.Level) {
			ui.Level = x.Level
		}
		if x.Limit > 0 && (ui.Top == "" || x.Pct > ui.TopPct) {
			ui.Top, ui.TopPct = x.Key, x.Pct
		}
		if paid && x.Cost > 0 {
			ui.MonthUSD += x.Cost
		}
		ui.Items = append(ui.Items, x)
	}
	if ui.Top != "" {
		ui.TipTop = fmt.Sprintf("最吃緊 %s %d%%", usageNames[ui.Top], ui.TopPct)
		if ui.Top != "" && usageNames[ui.Top] == "" {
			ui.TipTop = fmt.Sprintf("最吃緊 %s %d%%", ui.Top, ui.TopPct)
		}
	} else {
		ui.TipTop = "沒有會爆的項目"
	}
	// 第二格：要不要升級
	switch u.Plan {
	case collector.UsagePlanPaid:
		ui.MonthUSD += u.BaseUSD
		ui.Upgrade = "billing"
		ui.TipMonth = "本月約 " + usdText(ui.MonthUSD)
		ui.UpgradeN = "到 Cloudflare 看帳單"
	case collector.UsagePlanFree:
		if ui.Level != "ok" {
			ui.Upgrade, ui.UpgradeN = "advise", "建議升級 Cloudflare"
		} else {
			ui.Upgrade, ui.UpgradeN = "upgrade", "先不用 要時可升級"
		}
	default:
		ui.Upgrade = "none"
	}
	// 第三格：剎車
	switch {
	case u.Plan == collector.UsagePlanLocal:
		ui.Brake, ui.TipBrake = "na", "地端不需要剎車"
	case u.Brake == nil:
		ui.Brake, ui.TipBrake = "na", "查不到剎車狀態"
	case u.Brake.On:
		ui.Brake, ui.Covers, ui.TipBrake = "on", u.Brake.Covers, "剎車已開 接近線自動放慢"
	default:
		ui.Brake, ui.Covers, ui.TipBrake = "off", u.Brake.Covers, "剎車已關 不會自動放慢"
	}
	// 新鮮度
	delay := u.DelaySec
	if delay <= 0 {
		delay = 120
	}
	ui.TipFresh = fmt.Sprintf("來自 Cloudflare 約 %d 分鐘前", (delay+59)/60)
	if u.Plan == collector.UsagePlanLocal {
		ui.TipFresh = "本機自行計量"
	}
	return ui
}

// overlayUsageOnBattery（#246 c18653）：有儀表數字時，側欄／頁首的量表與警示條改用**同一個數字**
// （最吃緊那一項的已用 %）。以前它們畫的是 KBDB 閘口自己數的 D1「剩餘 %」，
// 與儀表（CF 的數字、涵蓋 AI／向量）說的是不同的事——geek 的畫面同時寫「用量 18%」與「AI 622%」。
// 省電旗標（Saver）仍沿用雲端剎車的判斷，那是行為不是數字。
func overlayUsageOnBattery(old *UIBattery, u *UIUsage) *UIBattery {
	if u == nil {
		return old
	}
	b := &UIBattery{Total: usageCells, PctKnown: true, FromUsage: true, Level: "ok"}
	if old != nil {
		b.Saver = old.Saver
	}
	if u.Top == "" {
		b.PctKnown = false
		b.Paid = u.Plan != collector.UsagePlanFree
		b.Line = u.TipTop
		return b
	}
	b.Percent = float64(u.TopPct)
	b.Cells = usageCellsFor(math.Min(100, b.Percent))
	b.Paid = u.Plan == collector.UsagePlanPaid
	switch u.Level {
	case "over":
		b.Level = "crit"
		b.Billing = b.Paid
	case "near":
		b.Level = "warn"
	}
	b.Line = u.TipTop
	b.DismissKey = "usage-" + u.Top + "-" + u.Level
	return b
}
