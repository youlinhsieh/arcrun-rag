// direct_pacing.go — 上傳節奏（2026-08-07）：積壓不要一次湧上去，新改的檔優先。
//
// 背景（封測事故）：Evan 在自己的免費 Cloudflare 帳號上跑，監看資料夾裡約 690 個檔，
// daemon 逐檔萃取上傳、每個檔在雲端產生一次工作流執行 ⇒ 1,070 次寫入撞上免費上限
// 1,000，額度爆掉，只有 8 個檔成功。雲端那一半（紀錄改走資料層 API）已修好，
// 但只要積壓一次全湧上去，額度一恢復就會立刻再爆一次——daemon 這一半必須自己有節奏。
//
// 兩個機制，缺一不可：
//  1. 排序：一輪掃到的多個 added/modified/renamed 事件，依檔案 mtime 由新到舊處理
//     （leo 2026-08-07 定的排序判準：「日期最近的最優先，今天寫的一定最近」——
//     一條佇列就夠，不必維護「新檔」「積壓」兩條）。
//  2. 節流：每次觸發雲端（萃取或 POST ingest/removed）之間留最小間隔，
//     且單輪最多處理有限筆——**存量慢慢消化不影響日常使用**，但下一輪 Scan()
//     會立刻看到使用者剛寫的新檔並插到最前面，不會被積壓卡住幾小時才輪到。
package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// directPaceInterval：兩次觸發雲端 workflow 之間的最小間隔。
// 正式執行維持節流；測試會在 init 時歸零（見 direct_pacing_test.go），
// 需要驗證節流本身的測試再自行 save/restore 成一個小的非零值。
var directPaceInterval = 700 * time.Millisecond

// pace 節流：在每次要觸發雲端（萃取 API／postJSON）之前呼叫。
// directPaceInterval<=0 時（測試環境預設）為 no-op。
func pace() {
	if directPaceInterval > 0 {
		time.Sleep(directPaceInterval)
	}
}

// DefaultMaxEventsPerRun：單輪最多處理幾個 added/modified/renamed/removed 事件。
// 選這個數字的理由：搭配預設 700ms 節流，一輪約 17.5 秒完成，遠短於使用者能感知的
// 「卡住」門檻，也讓下一輪 Scan()（PollSec 預設 5s 後）很快就能重新排序、
// 把使用者剛寫的新檔插到隊伍最前面——不會被巨量積壓鎖住好幾小時才輪得到。
const DefaultMaxEventsPerRun = 25

// effectiveMaxEventsPerRun 回傳這份設定實際生效的單輪事件上限（<=0 時用預設）。
func (c *DirectConfig) effectiveMaxEventsPerRun() int {
	if c.MaxEventsPerRun > 0 {
		return c.MaxEventsPerRun
	}
	return DefaultMaxEventsPerRun
}

// mtimeOf 讀檔案的修改時間；讀不到（已被刪除等）回零值，排序時會被當最舊、排到最後。
func mtimeOf(absPath string) time.Time {
	info, err := os.Stat(absPath)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// sortEventsNewestFirst 把一輪的事件依「新改的檔優先」重排。
//
// ⚠️ 刻意不改 Event struct（不加 Mtime 欄位）：collector-trigger.v1.schema.json
// 是凍結版本、additionalProperties:false，欄位變更＝開 v2 新檔（見 schema 檔頭註解）。
// 這裡只重排 direct.go 本機處理佇列的順序，不動送上雲的 payload 形狀。
//
//   - added/modified/renamed：依檔案現在的 mtime 由新到舊；mtime 相同或讀不到時
//     以路徑排序，保持每次呼叫結果一致（好測試、好除錯）。
//   - removed：檔案已經不存在，沒有 mtime 可排，一律排在內容事件之後
//     （下架不急，不該搶在使用者剛寫的新檔前面）。
func sortEventsNewestFirst(absRoot string, events []Event) []Event {
	out := make([]Event, len(events))
	copy(out, events)

	kind := func(ev Event) int {
		if ev.Type == "removed" {
			return 1 // 排在後段
		}
		return 0 // added/modified/renamed
	}
	mt := make(map[string]time.Time, len(out))
	for _, ev := range out {
		if ev.Type != "removed" {
			mt[ev.Path] = mtimeOf(filepath.Join(absRoot, filepath.FromSlash(ev.Path)))
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		ki, kj := kind(out[i]), kind(out[j])
		if ki != kj {
			return ki < kj
		}
		if ki == 1 { // 兩者皆 removed：路徑序，穩定即可
			return out[i].Path < out[j].Path
		}
		ti, tj := mt[out[i].Path], mt[out[j].Path]
		if !ti.Equal(tj) {
			return ti.After(tj) // 新到舊
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// resumeAfterCapMessage 給「這輪因為單輪上限被延後」的事件用的說明——
// 不是失敗，是刻意排隊；不該讓使用者以為程式壞了或漏了這個檔。
func resumeAfterCapMessage(remaining int) string {
	return fmt.Sprintf("已排入佇列，下一輪會繼續處理（本輪上限已到，還有 %d 筆等待）", remaining)
}

// partitionRetryEligible 把「已依 mtime 新到舊排序」的事件分成兩組：
//   - ready：這輪真的會被嘗試（會呼叫 pace()／打雲端）——沒在退避中、沒達重試上限、
//     帳號沒在額度冷卻中。
//   - waiting：這輪不會被嘗試，只是單純交代原因——退避窗口未到、已達
//     MaxFailBeforeSkip、或整個帳號正在額度冷卻。
//
// removed 事件不受退避／額度冷卻管制（下架本來就不看 ShouldRetry，見 direct.go 的
// case "removed"），一律歸 ready，維持既有行為不變。
//
// 🔴 為什麼要在 cap 之前先分這一刀（arcrun-rag#104 comment 4480，t217）：
// 舊版直接對排序後的原始清單套用 perRunCap（`orderedEvents[:perRunCap]`）。
// mtime 不會因為一個檔正在退避就變新或變舊，排序因此是穩定的——只要前 perRunCap
// 名裡有幾個持續失敗的檔案，它們會**每一輪都繼續佔著那幾個名額**（即使這一輪
// 根本不會被嘗試，只是被跳過），排在它們後面、從沒被嘗試過的事件因此永遠排不到，
// 不管跑幾百輪都一樣。這正是 leo 實測「1691→1880→1936 筆從不減少」的真因：
// 不是處理得慢，是那些筆數的候補名單裡，有一大段從頭到尾沒拿到出場機會。
//
// 呼叫端該把 cap 套在這裡回傳的 ready 上，讓「退避中」的事件不佔嘗試名額，
// 把機會讓給排在它們後面、真正還沒被嘗試過的事件。
func partitionRetryEligible(m *Manifest, events []Event, now int64, force bool, coolingDown bool) (ready, waiting []Event) {
	for _, ev := range events {
		if ev.Type == "removed" {
			ready = append(ready, ev)
			continue
		}
		if coolingDown {
			waiting = append(waiting, ev)
			continue
		}
		if m.ShouldRetry(ev.Path, now, force) {
			ready = append(ready, ev)
		} else {
			waiting = append(waiting, ev)
		}
	}
	return ready, waiting
}
