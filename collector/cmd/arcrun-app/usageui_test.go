package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
)

func fp(v float64) *float64 { return &v }

// geek6688 2026-10-10 04:47 UTC 的真實數字（CF GraphQL 實測，#246 c18630）。
func geekUsage() *collector.Usage {
	return &collector.Usage{
		Plan: collector.UsagePlanPaid, BaseUSD: 5, DelaySec: 120,
		Brake:    &collector.UsageBrake{On: true, Covers: []string{"d1_write", "d1_read"}},
		Received: time.Date(2026, 10, 10, 4, 47, 0, 0, time.UTC),
		Items: []collector.UsageItem{
			{Key: "ai", Used: 62205, Limit: fp(10000), Period: "day", ResetAt: "2026-10-11T00:00:00Z", RatePerMin: 217, UnitUSD: 0.000011, CostUSD: fp(3.62)},
			{Key: "vec_store", Used: 19954432, Limit: fp(10000000), Period: "month", ResetAt: "2026-10-31T16:00:00Z", UnitUSD: 0.0000000005, CostUSD: fp(0.005)},
			{Key: "vec_query", Used: 285696, Limit: fp(50000000), Period: "month", ResetAt: "2026-10-31T16:00:00Z"},
			{Key: "d1_write", Used: 2097651, Limit: fp(50000000), Period: "month", ResetAt: "2026-10-31T16:00:00Z"},
			{Key: "d1_read", Used: 294391299, Limit: fp(25000000000), Period: "month", ResetAt: "2026-10-31T16:00:00Z"},
			{Key: "cpu", Used: 3079480, Limit: fp(30000000), Period: "month"},
			{Key: "requests", Used: 356837, Limit: fp(10000000), Period: "month"},
			{Key: "zero", Used: 0, Limit: fp(10), Period: "day"},
		},
	}
}

func TestUsageUIGeekPaid(t *testing.T) {
	ui := buildUsageUI(geekUsage(), time.Now())
	if ui.Level != "over" || ui.Top != "ai" || ui.TopPct != 622 {
		t.Fatalf("最吃緊應是 AI 622%% over，得到 %s %s %d", ui.Level, ui.Top, ui.TopPct)
	}
	if len(ui.Items) != 7 {
		t.Fatalf("用量為 0 的不列，應 7 項，得到 %d", len(ui.Items))
	}
	ai := ui.Items[0]
	if !ai.Dollar || ai.Pause || ai.Over != 52205 || ai.Reset != "08:00" {
		t.Fatalf("AI 應亮 $、超出 52205、08:00 歸零：%+v", ai)
	}
	w := ui.Items[3]
	if w.Key != "d1_write" || w.Level != "ok" || w.Dollar || w.Pct != 4 {
		t.Fatalf("D1 寫入應 4%% 還遠、沒有 $：%+v", w)
	}
	if ui.Upgrade != "billing" || ui.MonthUSD < 8.6 || ui.MonthUSD > 8.7 {
		t.Fatalf("本月應約 8.63：%v %s", ui.MonthUSD, ui.Upgrade)
	}
	if ui.Brake != "on" || len(ui.Covers) != 2 {
		t.Fatalf("剎車：%+v", ui)
	}
}

func TestUsageUIFreeNearAndOver(t *testing.T) {
	u := &collector.Usage{Plan: collector.UsagePlanFree, Received: time.Now(), Items: []collector.UsageItem{
		{Key: "d1_write", Used: 85000, Limit: fp(100000), Period: "day", ResetAt: "2026-10-10T16:00:00Z"},
		{Key: "ai", Used: 10000, Limit: fp(10000), Period: "day"},
	}}
	ui := buildUsageUI(u, time.Now())
	if ui.Level != "over" || ui.Items[0].Key != "ai" || !ui.Items[0].Pause || ui.Items[0].Dollar {
		t.Fatalf("免費越線＝暫停、不是 $：%+v", ui.Items[0])
	}
	if ui.Items[1].Level != "near" || ui.Upgrade != "advise" || ui.MonthUSD != 0 {
		t.Fatalf("%+v", ui)
	}
}

func TestUsageUILocalNoMoney(t *testing.T) {
	u := &collector.Usage{Plan: collector.UsagePlanLocal, Received: time.Now(), Items: []collector.UsageItem{
		{Key: "d1_write", Used: 1234567, Period: "day"}, {Key: "ai", Used: 99, Period: "day"},
	}}
	ui := buildUsageUI(u, time.Now())
	if ui.Level != "ok" || ui.Upgrade != "none" || ui.Brake != "na" || ui.MonthUSD != 0 || ui.Top != "" {
		t.Fatalf("地端：沒有線、沒有錢、沒有升級：%+v", ui)
	}
	if !strings.Contains(ui.Items[1].TipNum, "1,234,567") {
		t.Fatal(ui.Items[1].TipNum)
	}
}

func TestCommaInt(t *testing.T) {
	for in, want := range map[float64]string{0: "0", 999: "999", 1000: "1,000", 294391299: "294,391,299", 25000000000: "25,000,000,000"} {
		if got := commaInt(in); got != want {
			t.Errorf("%v → %s，應 %s", in, got, want)
		}
	}
}

// 回給前端的每一個字串都要在字數預算內（hover ≤25、無句號逗號）。
func TestUsageUIWithinTextBudget(t *testing.T) {
	for _, u := range []*collector.Usage{geekUsage()} {
		b, _ := json.Marshal(buildUsageUI(u, time.Now()))
		var v any
		_ = json.Unmarshal(b, &v)
		if bad := budgetViolations(v); len(bad) > 0 {
			t.Fatalf("超出字數預算：%v", bad)
		}
	}
}

func TestUsageUINilWhenUnknown(t *testing.T) {
	if buildUsageUI(nil, time.Now()) != nil {
		t.Fatal("查不到就是 nil，不編數字")
	}
}

// c18653：同一件事只有一個數字——側欄／頁首量表與警示條跟儀表最吃緊那一項一致。
func TestOverlayBatteryMatchesUsage(t *testing.T) {
	old := accountBattery(&collector.Battery{State: collector.BatteryWarn20, RemainingPercent: fp(18), Warn: true})
	ui := buildUsageUI(geekUsage(), time.Now())
	b := overlayUsageOnBattery(old, ui)
	if int(b.Percent) != ui.TopPct || !b.FromUsage || !b.Paid || !b.Billing {
		t.Fatalf("付費越線：量表要是 622%%＋計費中：%+v", b)
	}
	line, warn := batteryShort(b)
	if line != "已用 622%" || warn != "" {
		t.Fatalf("付費越線不再另外警告：%q %q", line, warn)
	}
	free := buildUsageUI(&collector.Usage{Plan: collector.UsagePlanFree, Received: time.Now(), Items: []collector.UsageItem{
		{Key: "ai", Used: 8600, Limit: fp(10000), Period: "day"}}}, time.Now())
	fb := overlayUsageOnBattery(nil, free)
	_, warn = batteryShort(fb)
	if warn != "⚠ 用量 86%" {
		t.Fatalf("免費接近：警示條與儀表同一個 86%%：%q", warn)
	}
	if overlayUsageOnBattery(old, nil) != old {
		t.Fatal("沒有儀表數字就維持原樣")
	}
}
