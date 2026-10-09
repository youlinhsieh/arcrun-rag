package main

import (
	"strings"
	"testing"
)

// 額度用完的卡（#240 c18306）：一行標題「⏸ 額度用完 · 08:00 恢復」＋排隊數＋「升級」＋「?」。
// 標題由 Go 側 compactUI 組好（含種類與恢復時間），前端不再自己寫句子，也不再有「爆掉的是哪個帳號」
// 那一行——這張卡本來就只出現在爆掉的那個帳號自己的分頁。
func TestCardQuotaIsOneLineWithQueueAndUpgrade(t *testing.T) {
	js := mainJS(t)
	if !strings.Contains(js, "cardQuota(s.quota, a.progress, s.accounts)") {
		t.Fatal("tabSync 要把 s.quota 與這個帳號自己的進度交給 cardQuota")
	}
	if !strings.Contains(js, "function cardQuota(q, p, accounts)") {
		t.Fatal("cardQuota 簽章被改了")
	}
	for _, must := range []string{"q.headline", "排隊", "升級", `class="qmark"`} {
		if !strings.Contains(js, must) {
			t.Fatalf("額度卡缺「%s」", must)
		}
	}
	for _, banned := range []string{"q.usage", "q.guarantee", "q.exit_options", "急著要的話"} {
		if strings.Contains(js, banned) {
			t.Fatalf("額度卡不准再畫長句欄位：%s", banned)
		}
	}
}
