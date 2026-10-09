package main

import (
	"strings"
	"testing"

	"arcrun-rag/collector"
)

func pf(f float64) *float64 { return &f }

// 畫面上不准出現「電量／電池」字樣（leo 2026-10-08）。
func noBatteryWords(t *testing.T, b *UIBattery) {
	t.Helper()
	for _, s := range []string{b.Line, b.Warning} {
		if strings.Contains(s, "電量") || strings.Contains(s, "電池") || strings.Contains(s, "核能") {
			t.Fatalf("畫面字樣含電量/電池：%q", s)
		}
	}
}

// 五種狀態在畫面上的樣子（#240 c18101）：剩 50%／20%／10%／0%／付費。
func TestAccountUsageFiveStates(t *testing.T) {
	b := accountBattery(&collector.Battery{State: collector.BatteryNormal, RemainingPercent: pf(50)})
	if b == nil || b.Line != "今日剩餘用量 50%" || b.Level != "ok" || b.Warning != "" || b.Saver || b.Cells != 3 || b.Total != 5 {
		t.Fatalf("50%%：%+v", b)
	}
	noBatteryWords(t, b)
	b = accountBattery(&collector.Battery{State: collector.BatteryWarn20, RemainingPercent: pf(20), Warn: true, Message: "電量剩 20%"})
	if b == nil || b.Level != "warn" || !strings.Contains(b.Warning, "今日用量剩 20%") || !strings.Contains(b.Warning, "管理") || b.Saver || b.Cells != 1 {
		t.Fatalf("20%%：%+v", b)
	}
	noBatteryWords(t, b)
	b = accountBattery(&collector.Battery{State: collector.BatterySaver, RemainingPercent: pf(10), Warn: true, Saver: true})
	if b == nil || b.Level != "crit" || !b.Saver || b.Line != "今日剩餘用量 10%" || !strings.Contains(b.Warning, "省著用") || b.Cells != 1 {
		t.Fatalf("10%%：%+v", b)
	}
	noBatteryWords(t, b)
	b = accountBattery(&collector.Battery{State: collector.BatteryEmpty, RemainingPercent: pf(0), Warn: true, Saver: true})
	if b == nil || b.Line != "今日剩餘用量 0%" || b.Level != "crit" || b.Cells != 0 || !strings.Contains(b.Warning, "用完") {
		t.Fatalf("0%%：%+v", b)
	}
	noBatteryWords(t, b)
	// 付費（放行／關掉剎車），雲端沒交 %：只畫 ∞——不編格數、不警告、不省電
	b = accountBattery(&collector.Battery{State: collector.BatteryNuclear})
	if b == nil || !b.Paid || b.PctKnown || b.Cells != 0 || b.Warning != "" || b.Saver || b.Level != "ok" || b.Line != "不限用量" {
		t.Fatalf("付費（無 %%）：%+v", b)
	}
	noBatteryWords(t, b)
	// 付費、雲端有交免費額度剩餘 %：格數＋% 照畫，仍是 ∞、仍不警告
	b = accountBattery(&collector.Battery{State: collector.BatteryNuclear, RemainingPercent: pf(60)})
	if b == nil || !b.Paid || !b.PctKnown || b.Cells != 3 || b.Warning != "" || b.Saver || b.Level != "ok" || !strings.Contains(b.Line, "免費額度今日剩 60%") {
		t.Fatalf("付費（有 %%）：%+v", b)
	}
	noBatteryWords(t, b)
	// 付費、免費額度用完：照常，不換鏽色、不警告（計費中）
	b = accountBattery(&collector.Battery{State: collector.BatteryNuclear, RemainingPercent: pf(0)})
	if b == nil || !b.Paid || b.Cells != 0 || b.Level != "ok" || b.Warning != "" {
		t.Fatalf("付費（0%%）：%+v", b)
	}
	// 問不到雲端：才不顯示
	if accountBattery(nil) != nil {
		t.Fatal("未知不該顯示")
	}
}

// 帳號頁「同步」分頁的數字只能是這個帳號自己的（c18254）：兩個帳號各看各的資料夾，不混。
func TestAccountProgressIsPerAccount(t *testing.T) {
	sync := syncStatus{FolderProgress: map[string]collector.SyncProgress{
		"/a/1": {Total: 10, Done: 4, Pending: 5, Stuck: 1},
		"/a/2": {Total: 5, Done: 5},
		"/b/1": {Total: 100, Done: 1, Pending: 99},
	}}
	a := accountProgress(sync, []string{"/a/1", "/a/2"})
	if a == nil || a.Total != 15 || a.Done != 9 || a.Pending != 5 || a.CantSync != 1 {
		t.Fatalf("帳號 a：%+v", a)
	}
	b := accountProgress(sync, []string{"/b/1"})
	if b == nil || b.Total != 100 || b.Pending != 99 {
		t.Fatalf("帳號 b：%+v", b)
	}
	if accountProgress(sync, []string{"/never-reported"}) != nil {
		t.Fatal("collector 沒回報過的資料夾不該編出 0")
	}
}
