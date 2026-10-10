// filelane.go — 同一個帳號內「同時處理幾份檔」的閘（inkstone/Arcrun#297）。
//
// 背景（geek 9,000+ 檔，2026-10-10 c18564 實測）：D1 讀取量修完之後，每小時送出的卡數只穩定在
// 約 100 張，每張約 36 秒——因為 direct.go 對同一個帳號的檔是**一份做完才換下一份**，
// 萃取（請雲端 AI 讀）與收卡（送上知識庫）每一發都是同步等回覆。
// 並行只能加在這裡：帳號之間早就各跑各的（maxParallelAccounts），檔與檔之間沒有。
//
// 兩個數字，缺一不可：
//
//	① 上限（max）：預設 defaultFileConcurrency，使用者可用 config 的 file_concurrency 調，
//	   但硬上限 hardMaxFileConcurrency。選 4 的理由是**算出來的**，不是感覺——
//	   Cloudflare 官方文件寫文字生成模型預設 300 次/分鐘，付費模型 20 次/分鐘（Workers AI
//	   「Limits」頁）；一份檔每次萃取約 20～40 秒，4 路並行 ≈ 6～12 次/分鐘，
//	   連最嚴的 20 次/分鐘都吃不滿，硬上限 8 路也只到約 12～24 次/分鐘（長檔分段會多打幾發，
//	   所以硬上限不再往上開）。總 token 數不變——並行只改「什麼時候送」，不改「送什麼」。
//	② 慢啟動：一輪從 1 路開始，每成功一份就多放 1 路直到上限——雲端壞著（額度用完、路在退避、
//	   帳號沒回應）時，只有第一份檔去撞牆，其餘的進門就被既有的閘擋下，不會 N 份一起撞
//	   （N 路同時起跑的話，牆上就多挨 N-1 發）。上一輪不久前才順利跑完的帳號，
//	   下一輪直接從上次的並行數起跑（laneMemoryTTL 內），不用每輪重新爬。
//	③ 自動收斂（cur）：雲端喊慢（HTTP 429／額度用完）、等到超時、路進入退避時，目前並行數**減半**
//	   （最低 1），之後每連續成功 fileLaneRecoverAfter 份才加回 1 路——撞限就退，慢慢爬回來，
//	   不是撞一次就永遠變慢。額度冷卻、帳號沒回應、路退避這三道既有的閘仍照舊
//	   在每份檔進門時檢查（共用狀態），所以退的同時，後面排隊的檔也會直接被擋下，不會一起去撞。
package collector

import (
	"sync"
	"time"
)

const (
	// defaultFileConcurrency＝同一個帳號、同一個資料夾內同時處理幾份檔（見檔頭算式）。
	defaultFileConcurrency = 4
	// hardMaxFileConcurrency＝config 再怎麼寫也不超過。
	hardMaxFileConcurrency = 8
	// fileLaneRecoverAfter＝連續成功幾份才把並行數加回 1 路。
	fileLaneRecoverAfter = 3
)

// effectiveFileConcurrency 回這份設定實際生效的同時處理份數。
//   - 省電模式＝1（電量吃緊時不要加碼，維持舊制一次一份）。
//   - dry-run＝1（只列計畫，不需要並行，也讓輸出順序與舊制一致）。
//   - <=0＝預設值；超過硬上限＝硬上限。
func (c *DirectConfig) effectiveFileConcurrency(dryRun bool) int {
	if dryRun || c.SaverMode {
		return 1
	}
	n := c.FileConcurrency
	if n <= 0 {
		n = defaultFileConcurrency
	}
	if n > hardMaxFileConcurrency {
		n = hardMaxFileConcurrency
	}
	return n
}

// fileLane 控制同時在途的份數：max 是上限，cur 是目前允許的（會被 pressure 減半、被 good 加回）。
type fileLane struct {
	mu       sync.Mutex
	cond     *sync.Cond
	max      int
	cur      int
	inFlight int
	okStreak int
	ramping  bool // 冷啟動中：每成功一份就加 1 路（遇到 pressure 就結束，之後改成連續成功才加）
}

// newFileLane：max＝上限；start＝起跑並行數（1＝冷啟動慢爬；其他＝沿用上一輪）。
func newFileLane(max, start int) *fileLane {
	if max < 1 {
		max = 1
	}
	if start < 1 {
		start = 1
	}
	if start > max {
		start = max
	}
	l := &fileLane{max: max, cur: start, ramping: start == 1 && max > 1}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// enter 等到目前允許的份數有空位才放行。
func (l *fileLane) enter() {
	l.mu.Lock()
	for l.inFlight >= l.cur {
		l.cond.Wait()
	}
	l.inFlight++
	l.mu.Unlock()
}

func (l *fileLane) leave() {
	l.mu.Lock()
	l.inFlight--
	l.cond.Broadcast()
	l.mu.Unlock()
}

// pressure：雲端喊慢／額度／超時／路退避——並行數減半（最低 1），並把「連續成功」歸零。
func (l *fileLane) pressure() {
	l.mu.Lock()
	l.cur /= 2
	if l.cur < 1 {
		l.cur = 1
	}
	l.okStreak = 0
	l.ramping = false
	l.mu.Unlock()
}

// good：一份檔成功送上去。連續 fileLaneRecoverAfter 份就加回 1 路（不超過上限）。
func (l *fileLane) good() {
	l.mu.Lock()
	if l.ramping {
		if l.cur < l.max {
			l.cur++
			l.cond.Broadcast()
		}
		l.mu.Unlock()
		return
	}
	l.okStreak++
	if l.okStreak >= fileLaneRecoverAfter && l.cur < l.max {
		l.cur++
		l.okStreak = 0
		l.cond.Broadcast()
	}
	l.mu.Unlock()
}

// current 回目前允許的份數（測試與日誌用）。
func (l *fileLane) current() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cur
}

// laneMemoryTTL：多久之內算「上一輪剛跑完」。超過就當冷啟動（雲端狀況可能已變）。
const laneMemoryTTL = 15 * time.Minute

var laneMemory = struct {
	sync.Mutex
	m map[string]laneMem
}{m: map[string]laneMem{}}

type laneMem struct {
	cur int
	at  time.Time
}

// laneStartFor 回這個帳號這一輪的起跑並行數：上一輪不久前留下的，否則 1（冷啟動）。
func laneStartFor(host string, max int, now time.Time) int {
	laneMemory.Lock()
	defer laneMemory.Unlock()
	if mem, ok := laneMemory.m[host]; ok && now.Sub(mem.at) < laneMemoryTTL && mem.cur > 1 {
		if mem.cur > max {
			return max
		}
		return mem.cur
	}
	return 1
}

// rememberLane 收工時記下這一輪結束時的並行數（被 pressure 壓低的也照記，下一輪不會一開跑就又衝高）。
func rememberLane(host string, cur int, now time.Time) {
	laneMemory.Lock()
	laneMemory.m[host] = laneMem{cur: cur, at: now}
	laneMemory.Unlock()
}
