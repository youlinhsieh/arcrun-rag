// quota.go — Workers AI 每日免費額度用完時的人話訊息與全域冷卻（2026-08-07 pacing task）。
//
// 背景（封測事故）：Evan 在自己的免費 Cloudflare 帳號上跑，690 個檔逐檔萃取上傳，
// 每個檔在雲端產生一次工作流執行 ⇒ 1,070 次寫入撞上免費上限 1,000，額度爆掉、整批 429/502，
// 只有 8 個檔成功。雲端那一半（紀錄改走資料層 API）已修好；本檔補的是 daemon 這一半：
// 額度用完時要「說人話＋降速」，不是安靜地重試到死或吐一串技術錯誤碼。
//
// 已知的上游錯誤模式（system-dev/wiki/mistakes.md 2026-08-06）：
//
//	collector.log 出現 `4006: you have used up your daily free allocation of 10,000 neurons`，
//	HTTP 502，額度**每日 UTC 午夜重置**（＝台灣時間早上 8:00）。
//
// leo 定的三句話骨架（缺一不可，且不准出現裸露的錯誤碼）：
//
//	成就：「今天已經幫你整理了 N 份」← 先講做到什麼，不是先講失敗
//	出口：「可以換一個模型，或升級 Cloudflare（每月 5 美元）」← 給選擇不是死路
//	保證：「不花錢也沒關係，明天/今天早上 8 點會自動恢復、會接著跑」
package collector

import (
	"fmt"
	"strings"
	"time"
)

// taiwanTZ：固定 UTC+8 偏移，不吃系統 tzdata（跨平台/Windows 常缺時區資料庫；
// 台灣本身沒有日光節約時間，固定偏移在任何時候都正確——不必依賴 time.LoadLocation）。
var taiwanTZ = time.FixedZone("Asia/Taipei", 8*60*60)

// isQuotaExhausted 辨識「Workers AI 每日免費額度用完」這個已知上游狀況（非 bug）。
// 用子字串比對而非單看 HTTP 狀態碼——502 本身太泛用（也可能是別的暫時性錯誤），
// 這段特定文案才是可靠訊號（見 wiki mistakes.md 2026-08-06 記錄的原文）。
func isQuotaExhausted(errMsg string) bool {
	return strings.Contains(errMsg, "10,000 neurons") ||
		strings.Contains(errMsg, "daily free allocation") ||
		strings.Contains(errMsg, "4006:")
}

// nextQuotaResetTaiwan 回傳下一次 Workers AI 每日額度重置的時間點。
// Cloudflare 在 UTC 午夜重置 ⇒ 下一次 UTC 00:00 就是答案（換算成台灣時間固定是早上 8:00）。
func nextQuotaResetTaiwan(now time.Time) time.Time {
	u := now.UTC()
	nextMidnightUTC := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	return nextMidnightUTC.In(taiwanTZ)
}

// QuotaNotice 是額度用完時要給使用者看的三句話（leo 定的骨架，缺一不可）。
// 三句合起來就是完整訊息，任何管道要顯示都直接串接，不再另外組字串（避免各處措辭漂移）。
type QuotaNotice struct {
	Achievement string `json:"achievement"`  // 今天已經幫你整理了 N 份
	ExitOptions string `json:"exit_options"` // 可以換一個模型，或升級 Cloudflare（每月 5 美元）
	Guarantee   string `json:"guarantee"`    // 不花錢也沒關係，今天/明天早上 8:00 會自動恢復
	ResumeAt    string `json:"resume_at"`    // RFC3339，預期恢復時間（供機器判斷冷卻是否結束）
}

// Combined 把三句話接成一句完整訊息（給只有單一 error 欄位可用的地方，如 DirectResult.Error）。
// 用句號分隔——三句話都要出現，缺一不可，且全程不含任何原始錯誤碼。
func (n QuotaNotice) Combined() string {
	return n.Achievement + "。" + n.ExitOptions + "。" + n.Guarantee
}

// buildQuotaNotice 組出三句話。dailyCount＝今天（UTC 日界，與額度重置同一條線）已成功
// 萃取的份數；resetAt＝nextQuotaResetTaiwan 算出的下一次重置時間。
func buildQuotaNotice(now time.Time, dailyCount int, resetAt time.Time) QuotaNotice {
	return QuotaNotice{
		Achievement: fmt.Sprintf("今天已經幫你整理了 %d 份", dailyCount),
		ExitOptions: "可以換一個模型，或升級 Cloudflare（每月 5 美元）",
		Guarantee:   quotaGuaranteeText(now, resetAt),
		ResumeAt:    resetAt.Format(time.RFC3339),
	}
}

// quotaGuaranteeText 把重置時間換成人話：「今天」或「明天」早上 8:00
// （不能寫死「明天」——若這一刻台灣時間已經過了午夜、還沒到 8 點，重置其實是「今天」）。
func quotaGuaranteeText(now, resetAt time.Time) string {
	nowTW := now.In(taiwanTZ)
	resetTW := resetAt.In(taiwanTZ)
	dayWord := "明天"
	if nowTW.Year() == resetTW.Year() && nowTW.YearDay() == resetTW.YearDay() {
		dayWord = "今天"
	}
	return fmt.Sprintf("不花錢也沒關係，%s早上 8:00 會自動恢復、會接著跑", dayWord)
}

// quotaState 是「這個帳號本輪的額度冷卻」共享狀態，跨同一帳號的多個監看根
// （額度是雲端實例/Cloudflare 帳號層級的，不是單一資料夾的——一個根撞到，
// 同帳號其他根不該還傻傻地繼續撞同一面牆）。由 RunDirectOnce 建立、以指標
// 傳進每個 runDirectOnceRoot 呼叫，狀態在呼叫之間累積。
type quotaState struct {
	CooldownUntil time.Time // 非零值且晚於 now ⇒ 本帳號本輪不再嘗試萃取
	Hit           bool      // 本輪是否新偵測到額度用完（避免同一輪反覆覆寫 CooldownUntil）
	RawReason     string    // 上游原文，只供 log／除錯，不進任何使用者看得到的欄位
	DailyCount    int       // 今天（UTC 日界）已成功萃取的份數，seed 自 status.json 並持續累加
}

// inCooldown 回報現在是否仍在額度冷卻窗口內。
func (qs *quotaState) inCooldown(now time.Time) bool {
	return !qs.CooldownUntil.IsZero() && now.Before(qs.CooldownUntil)
}

// noticeNow 用目前狀態組一份 QuotaNotice。
func (qs *quotaState) noticeNow(now time.Time) QuotaNotice {
	return buildQuotaNotice(now, qs.DailyCount, qs.CooldownUntil)
}

// markHit 記錄「這一刻偵測到額度用完」，只在本輪第一次命中時真正設定冷卻時間
// （之後同一輪的其他失敗不再往後推遲 CooldownUntil，避免因為連續撞牆而不斷延後恢復承諾）。
func (qs *quotaState) markHit(now time.Time, rawReason string) {
	if qs.Hit {
		return
	}
	qs.Hit = true
	qs.RawReason = rawReason
	qs.CooldownUntil = nextQuotaResetTaiwan(now)
}

// todayUTC 回傳 YYYY-MM-DD（UTC），與 Workers AI 額度重置同一條日界線。
func todayUTC(now time.Time) string {
	return now.UTC().Format("2006-01-02")
}
