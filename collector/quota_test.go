// quota_test.go — 額度用完人話訊息（2026-08-07 pacing task 2）。
package collector

import (
	"strings"
	"testing"
	"time"
)

func TestIsQuotaExhausted(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"本地萃取失敗：雲端萃取失敗（HTTP 502）：4006: you have used up your daily free allocation of 10,000 neurons", true},
		{"雲端萃取失敗：exceeded daily free allocation", true},
		{"連不上你的知識庫：dial tcp: connection refused", false},
		{"檔案裡沒有可抽取的文字", false},
		{"雲端萃取失敗（HTTP 500）：internal error", false},
	}
	for _, c := range cases {
		if got := isQuotaExhausted(c.msg); got != c.want {
			t.Errorf("isQuotaExhausted(%q)=%v want %v", c.msg, got, c.want)
		}
	}
}

// UTC 午夜重置＝台灣時間固定早上 8:00。
func TestNextQuotaResetTaiwan(t *testing.T) {
	// 2026-08-07 15:00 UTC = 2026-08-07 23:00 台灣 → 下次重置 2026-08-08 00:00 UTC = 08-08 08:00 台灣
	now := time.Date(2026, 8, 7, 15, 0, 0, 0, time.UTC)
	got := nextQuotaResetTaiwan(now)
	want := time.Date(2026, 8, 8, 8, 0, 0, 0, taiwanTZ)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// 三句話缺一不可，且絕不含裸露的錯誤碼（4006／502／HTTP）。
func TestBuildQuotaNotice_NoRawErrorCode(t *testing.T) {
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)
	resetAt := nextQuotaResetTaiwan(now)
	notice := buildQuotaNotice(now, 42, resetAt)

	if !strings.Contains(notice.Achievement, "42") {
		t.Errorf("成就句沒帶到份數：%q", notice.Achievement)
	}
	if !strings.Contains(notice.ExitOptions, "升級") || !strings.Contains(notice.ExitOptions, "換") {
		t.Errorf("出口句缺選項：%q", notice.ExitOptions)
	}
	if !strings.Contains(notice.Guarantee, "自動恢復") {
		t.Errorf("保證句沒講自動恢復：%q", notice.Guarantee)
	}
	combined := notice.Combined()
	for _, banned := range []string{"4006", "502", "HTTP", "neurons"} {
		if strings.Contains(combined, banned) {
			t.Errorf("三句話不該出現裸露的錯誤碼 %q：%q", banned, combined)
		}
	}
}

// 「今天」vs「明天」：現在台灣時間若已過午夜還沒到 8 點，重置其實是「今天」。
func TestQuotaGuaranteeText_TodayVsTomorrow(t *testing.T) {
	// 台灣時間 08-08 02:00（= UTC 08-07 18:00）→ 下次重置 08-08 08:00 台灣 → 同一天 → 「今天」
	now := time.Date(2026, 8, 7, 18, 0, 0, 0, time.UTC)
	resetAt := nextQuotaResetTaiwan(now)
	got := quotaGuaranteeText(now, resetAt)
	if !strings.Contains(got, "今天") {
		t.Fatalf("應該是「今天」：%q（now台灣=%v resetAt台灣=%v）", got, now.In(taiwanTZ), resetAt.In(taiwanTZ))
	}

	// 台灣時間 08-07 23:00（= UTC 08-07 15:00）→ 下次重置 08-08 08:00 台灣 → 隔天 → 「明天」
	now2 := time.Date(2026, 8, 7, 15, 0, 0, 0, time.UTC)
	resetAt2 := nextQuotaResetTaiwan(now2)
	got2 := quotaGuaranteeText(now2, resetAt2)
	if !strings.Contains(got2, "明天") {
		t.Fatalf("應該是「明天」：%q", got2)
	}
}

// arcrun-rag#59（2026-08-10 leo 實查）：dailyCount==0 時三句話原本會自相矛盾——
// 「今天已經幫你整理了 0 份」搭「可以換一個模型」，一份都沒成功那額度是誰用掉的？
// 真兇是嵌入（向量化）與萃取共用同一份 Workers AI 額度（不受萃取模型選擇影響）——
// 這支測試釘住：dailyCount==0 時不准再建議換模型，且仍照實講「整理了 0 份」（不假裝有成果）。
func TestBuildQuotaNotice_ZeroDailyCount_NoModelSwitchSuggestion(t *testing.T) {
	now := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC)
	resetAt := nextQuotaResetTaiwan(now)
	notice := buildQuotaNotice(now, 0, resetAt)

	if !strings.Contains(notice.Achievement, "0") {
		t.Errorf("成就句仍要照實講 0 份：%q", notice.Achievement)
	}
	// 注意：文案裡允許出現「換」這個字（要誠實講「換模型救不了」），
	// 禁的是舊版那句**推薦**換模型的措辭「可以換一個模型」。
	if strings.Contains(notice.ExitOptions, "可以換一個模型") {
		t.Errorf("dailyCount==0 時不該再建議換模型（結構上做不到：嵌入不管選哪個萃取模型都走 "+
			"Workers AI）：%q", notice.ExitOptions)
	}
	if !strings.Contains(notice.ExitOptions, "升級") {
		t.Errorf("升級 Cloudflare 是這個情境下唯一真的有效的出口，不該被拿掉：%q", notice.ExitOptions)
	}
	// 三句話合起來仍要能被 ClassifyFailure 歸進額度分類（靠 Achievement 句的
	// 「幫你整理了」字樣，不靠 Guarantee 句的「會自動恢復」——這個分支刻意不承諾自動恢復）。
	if got := ClassifyFailure(notice.Combined()); got != FailQuotaExhausted {
		t.Fatalf("dailyCount==0 的三句話也該歸進額度分類，got %q（訊息：%s）", got, notice.Combined())
	}
	// 絕不含裸露錯誤碼（沿用既有骨架的紅線）。
	for _, banned := range []string{"4006", "502", "HTTP", "neurons"} {
		if strings.Contains(notice.Combined(), banned) {
			t.Errorf("不該出現裸露的錯誤碼 %q：%q", banned, notice.Combined())
		}
	}
}

// dailyCount>0（單純量大用完，非「額度被別的事吃光」那種矛盾）維持原三句話——
// 這種情境換模型確實能讓萃取那一半少吃一點、多處理幾份，不該被拿掉。
func TestBuildQuotaNotice_PositiveDailyCount_KeepsModelSwitchSuggestion(t *testing.T) {
	now := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC)
	resetAt := nextQuotaResetTaiwan(now)
	notice := buildQuotaNotice(now, 105, resetAt)

	if !strings.Contains(notice.ExitOptions, "換") || !strings.Contains(notice.ExitOptions, "升級") {
		t.Errorf("dailyCount>0（單純量大）應維持原本的三句話，含換模型與升級兩個選項：%q", notice.ExitOptions)
	}
	if !strings.Contains(notice.Guarantee, "自動恢復") {
		t.Errorf("dailyCount>0 時應維持原本「會自動恢復」的保證句：%q", notice.Guarantee)
	}
}

func TestQuotaState_MarkHitOnlyFirstTimeSetsCooldown(t *testing.T) {
	qs := &quotaState{}
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)
	qs.markHit(now, "第一次原因")
	first := qs.CooldownUntil

	later := now.Add(90 * time.Minute)
	qs.markHit(later, "第二次原因（同一輪另一個檔也撞到）")
	if !qs.CooldownUntil.Equal(first) {
		t.Fatalf("第二次命中不該再往後推遲冷卻時間：first=%v got=%v", first, qs.CooldownUntil)
	}
	if qs.RawReason != "第一次原因" {
		t.Fatalf("RawReason 應保留第一次的：%q", qs.RawReason)
	}
}

func TestQuotaState_InCooldown(t *testing.T) {
	qs := &quotaState{}
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)
	if qs.inCooldown(now) {
		t.Fatal("從沒命中過不該在冷卻中")
	}
	qs.markHit(now, "x")
	if !qs.inCooldown(now) {
		t.Fatal("剛命中應立刻在冷卻中")
	}
	if qs.inCooldown(qs.CooldownUntil.Add(time.Second)) {
		t.Fatal("過了冷卻時間應該解除")
	}
}

// P8（2026-08-09）：額度三句話會被存進檔案的失敗欄位（direct.go res.Error），
// 再流進 FailureBreakdown 分類。三句話文案刻意不含「額度」「4006」——
// 若 ClassifyFailure 認不得它，畫面上「今天的 AI 額度用完了」那類反而 0 份、
// 全部掉進「其他」。這支測試釘住「三句話 → 額度分類」這條線。
func TestClassifyFailure_QuotaNoticeCombined(t *testing.T) {
	now := time.Date(2026, 8, 9, 3, 0, 0, 0, time.UTC)
	notice := buildQuotaNotice(now, 105, nextQuotaResetTaiwan(now))
	if got := ClassifyFailure(notice.Combined()); got != FailQuotaExhausted {
		t.Fatalf("三句話應歸進額度分類，got %q（訊息：%s）", got, notice.Combined())
	}
	// 退避訊息會把三句話接在「｜原因：」後（direct.go retrySkipReason）——同樣要認得
	wrapped := "上次失敗（第 2 次），58m 後重試｜原因：" + notice.Combined()
	if got := ClassifyFailure(wrapped); got != FailQuotaExhausted {
		t.Fatalf("包在退避訊息裡也應歸進額度分類，got %q", got)
	}
}
