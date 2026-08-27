// stallguard.go — 一發等不到回覆的請求，不可以讓整台機器的同步停下來
// （`inkstone/arcrun-rag#153`）。
//
// 一輪同步是**一條線**走完的：帳號 → 看守資料夾 → 一件件事。整條線上每一發
// HTTP 都是同步的，所以只要其中一發停在那裡不回來，它後面的所有帳號、所有
// 資料夾就一起停擺——而且是**安靜地**停擺：日誌只有開工那一行，畫面上的
// 資料夾結構永遠停在上一版，沒有任何錯誤訊息。
//
// 為什麼不是「把 300 秒調小」：那只改變**卡多久**，沒改變「一發卡住就全停」。
// 一個階段可以連續打二十發（見 sourcerepair.go 的 sourceRepairBatch），
// 每發都等到超時的話，60 秒的上限一樣會把一輪拖成二十分鐘。
//
// 這支檔把「等待」變成三件有邊界、會說話的事：
//
//	① **每一發自己的上限**——按「這一發實際上在做什麼」給（會同步跑 AI 萃取的
//	   那一發本來就慢，機械收口的那些不該也享有五分鐘），而且用 context 帶進
//	   請求裡，不是只靠 client 那一把套用全部的總閘。
//	② **同一個帳號連續等不到回覆 ⇒ 這一輪不再打它**（斷路器）。一發卡住的代價
//	   從「整輪停擺」降成「這個帳號這一輪跳過」，其他帳號、其他資料夾照常跑完。
//	③ **等待要有話說**——超過 stallNoticeEvery 就往 stdout 播一句
//	   「哪個帳號、哪件事、等了多久」，並在收工時寫進 status.json。
//	   靜默的等待跟當掉對使用者是同一件事。
//
// 🔴 播報用 `phase:"waiting"`，**不能沿用既有的兩種**：supervisor 把任何
// 非 `start` 的 JSON 值都當成「一輪跑完了」（supervisor.go 的 decode 迴圈），
// 沿用會讓托盤在同步途中跳回「看守中」——正是 t191 修掉的那個病。
package collector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

// callStep 描述「這一發網路呼叫在做什麼」。
//
// Name 會出現在日誌與畫面上，所以它是**產品文案**：講使用者認得的那件事，
// 不出現 workflow 名、狀態碼、模型名。
type callStep struct {
	Name   string
	Budget time.Duration
}

const (
	// llmCallBudget＝那一發會在雲端同步跑完 AI 萃取才回來（原本 directHTTP 那把
	// 300 秒就是為它放寬的），維持不變。
	llmCallBudget = 300 * time.Second
	// plainCallBudget＝零 LLM 的機械收口（收卡／下架／登記結構）。這不是「把 300
	// 調小」——這些請求從來就不跑模型，給它們五分鐘只是讓卡住的代價變大。
	plainCallBudget = 60 * time.Second
)

var (
	stepIngestDoc    = callStep{"整理一份文件", llmCallBudget}
	stepIngestCard   = callStep{"送出一份筆記", plainCallBudget}
	stepExtractDoc   = callStep{"請雲端讀一份文件", llmCallBudget}
	stepRepairOrigin = callStep{"更新舊筆記的原文位置", plainCallBudget}
	stepTakedown     = callStep{"把刪掉的檔案從雲端下架", plainCallBudget}
	stepRetire       = callStep{"收回這個資料夾在雲端的資料", plainCallBudget}
	stepFolderTree   = callStep{"回報資料夾結構", plainCallBudget}
	stepInventory    = callStep{"送出資料夾總覽", plainCallBudget}
	stepFolderCard   = callStep{"送出目錄索引", plainCallBudget}
	// stepProbeAI＝每輪每個帳號的第一發（探測雲端 AI 通了沒）。它同時是最早
	// 能認出「這個帳號今天不回應」的位置——認出來，這個帳號其餘的工作就都省了。
	stepProbeAI = callStep{"確認雲端 AI 可不可以用", 20 * time.Second}
	// stepCloudAudit＝跟雲端核對「先前送過的檔案還在不在」。唯讀查詢，
	// 一輪可能連打 cloudAuditBatch 發——正是「一發卡住的代價會被乘上批次大小」的例子。
	stepCloudAudit = callStep{"跟雲端核對哪些檔案還在", 20 * time.Second}
)

// stallNoticeEvery＝等多久開口說一次「還在等」。變數而非常數：測試要把它調快。
var stallNoticeEvery = 30 * time.Second

// stallStrikesBeforeSkip＝同一個帳號連續幾發等到超時，就這一輪不再打它。
//
// 為什麼是 2 而不是 1：一次偶發的逾時不該讓整個帳號這一輪停手。
// 為什麼不是更多：每多一次就是多等一個 Budget，而這正是本票要砍掉的成本。
var stallStrikesBeforeSkip = 2

// StalledCall＝這一輪「等太久」的一件事，寫進 status.json 讓畫面講得出
// 「哪個帳號、哪件事、等了多久」。
type StalledCall struct {
	Account   string `json:"account"`        // 知識庫網址的主機名（使用者在畫面上看得到的那個）
	Step      string `json:"step"`           // 白話的「哪件事」
	WaitedSec int    `json:"waited_sec"`     // 等了幾秒
	Skipped   bool   `json:"skipped"`        // 這一輪之後不再打這個帳號
	Note      string `json:"note,omitempty"` // 給使用者看的一句話
}

// accountStall＝某個帳號在這一輪的「等待帳」。
type accountStall struct {
	strikes int
	skip    string // 非空＝這一輪不再打它，內容是給使用者看的理由
}

// roundGuard 一輪一份，掛在 DirectConfig 上。
// makeAccountSubConfig 的 `sub := *c` 會把這個**指標**一起帶過去
// ⇒ 同一輪所有帳號、所有資料夾寫進同一份紀錄，斷路器才跨得了資料夾。
type roundGuard struct {
	mu       sync.Mutex
	accounts map[string]*accountStall
	stalls   []StalledCall
	// announce＝把「還在等」播出去。測試會換掉它（預設寫 stdout）。
	announce func(StalledCall)
}

func newRoundGuard() *roundGuard {
	return &roundGuard{accounts: map[string]*accountStall{}, announce: announceStall}
}

// stdoutMu 保護 stdout 上的「一個 JSON 值」不被另一條 goroutine 插進去切成兩半。
//
// 🔴 為什麼非有不可：播報是在**另一條 goroutine** 上跑的，而每輪結束那筆
// `phase:"done"` 可能有幾十 KB（results 逐筆展開）——超過管線的原子寫入大小之後，
// 兩邊就會交錯。而 supervisor 的 json.Decoder 一旦讀到壞掉的值就
// `io.Copy(io.Discard)` 跳出迴圈（supervisor.go）⇒ **那個行程接下來所有的
// start／done 都不會再被看到**，托盤從此停在錯的狀態。
// 機率很小，代價是整條狀態線靜默死掉——這種比例的東西要用鎖解決，不是賭。
var stdoutMu sync.Mutex

// printJSONLine 把一個值印成 stdout 上完整的一行（與播報共用同一把鎖）。
func printJSONLine(v any) {
	line, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	_, _ = os.Stdout.Write(append(line, '\n'))
}

// announceStall 把一句「還在等」印成 stdout 上的一個 JSON 值。
// 一次寫完整一個值：supervisor 那邊是 json.Decoder 逐值解，寫一半會炸掉整條線。
func announceStall(s StalledCall) {
	line, err := json.Marshal(struct {
		At    string `json:"at"`
		Phase string `json:"phase"`
		StalledCall
	}{time.Now().Format(time.RFC3339), "waiting", s})
	if err != nil {
		return // 播不出去也不能擋住本體
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	_, _ = os.Stdout.Write(append(line, '\n'))
}

// skipReason 回「這個帳號這一輪已經被判定沒有回應」的白話理由；空＝照常打。
func (g *roundGuard) skipReason(host string) string {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if a := g.accounts[host]; a != nil {
		return a.skip
	}
	return ""
}

// Stalls 回這一輪等太久的清單（順序＝發生順序）。
func (g *roundGuard) Stalls() []StalledCall {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]StalledCall(nil), g.stalls...)
}

// strike 記一發「等到超時」，必要時讓這個帳號這一輪停手。回傳給使用者看的那句話。
func (g *roundGuard) strike(host string, step callStep, waited time.Duration) string {
	g.mu.Lock()
	a := g.accounts[host]
	if a == nil {
		a = &accountStall{}
		g.accounts[host] = a
	}
	a.strikes++
	tripped := a.strikes >= stallStrikesBeforeSkip && a.skip == ""
	if tripped {
		a.skip = fmt.Sprintf(
			"知識庫「%s」現在沒有回應（連續 %d 件事都等不到回覆），這一輪先跳過它；"+
				"其他資料夾照常同步，等它回來之後會自動恢復。",
			host, a.strikes)
	}
	note := fmt.Sprintf("「%s」等了 %d 秒，知識庫「%s」還是沒有回應；這一輪先跳過，"+
		"其他資料夾照常同步，等它回來之後會自動恢復。",
		step.Name, int(waited.Seconds()), host)
	g.stalls = append(g.stalls, StalledCall{
		Account: host, Step: step.Name, WaitedSec: int(waited.Seconds()),
		Skipped: tripped, Note: note,
	})
	announce, skip := g.announce, a.skip
	g.mu.Unlock()

	if announce != nil {
		announce(StalledCall{Account: host, Step: step.Name,
			WaitedSec: int(waited.Seconds()), Skipped: tripped, Note: note})
	}
	// 🔴 把連線池裡那條可能已經死掉的連線丟掉。
	// 實撞的形狀（2026-08-28）：行程活著、CPU 0%、`lsof` 一條 TCP 都沒有，
	// 而堆疊停在 HTTP/2 的 roundTrip——連線在作業系統那層已經沒了，
	// 連線池裡的殼卻還在，後面每一發都會被指派到同一個殼上、一發一發地等到超時。
	// 丟掉之後下一發會重新建立連線，而不是繼續排在一條死掉的連線後面。
	directHTTP.CloseIdleConnections()

	if skip != "" {
		return skip
	}
	return note
}

// unreachableNote 回「這個帳號這一輪已經被判定沒有回應」的白話理由；空＝照常打。
//
// 呼叫端用它在**打之前**就掉頭，而不是打下去等到超時再說——那正是「一發卡住
// 就整輪停擺」的成本來源：不掉頭的話，一個沒有回應的帳號會讓這一輪的每一件事
// 各自再等一個 Budget。
func (c *DirectConfig) unreachableNote() string {
	return c.guard.skipReason(instanceHostOf(c.CypherURL))
}

// callGate＝一發網路呼叫的閘。用法（三行，缺一不可）：
//
//	gate := cfg.openGate(stepXxx)
//	defer gate.release()                     // 停掉播報、放掉 context
//	if note := gate.blocked(); note != "" { … 這一輪不再打這個帳號 … }
//	… 真的去打 …
//	if err != nil { return gate.record(err) } // 逾時才會被記帳，其餘原樣回
type callGate struct {
	g       *roundGuard
	host    string
	step    callStep
	started time.Time
	ctx     context.Context
	cancel  context.CancelFunc
	stop    chan struct{}
	once    sync.Once
	skip    string
	// notice＝多久播報一次。**在 openGate 就抄成自己的一份**，播報那條 goroutine
	// 不再去讀套件層的變數——那條 goroutine 的生命週期比呼叫端長一點點，
	// 讀共用變數就是一個真的資料競爭（-race 抓到的）。
	notice time.Duration
}

// openGate 開一發呼叫的閘。guard 為 nil（測試直接呼叫低層函式）時仍回一個可用的
// 閘：有 context deadline、不記帳、不播報——「沒裝 guard」不該變成「沒有上限」。
func (c *DirectConfig) openGate(step callStep) *callGate {
	host := instanceHostOf(c.CypherURL)
	gate := &callGate{g: c.guard, host: host, step: step, started: time.Now(),
		stop: make(chan struct{}), notice: stallNoticeEvery}
	if c.guard != nil {
		gate.skip = c.guard.skipReason(host)
	}
	gate.ctx, gate.cancel = context.WithTimeout(context.Background(), step.Budget)
	if gate.skip != "" {
		return gate // 已經跳閘：不必播報，呼叫端會立刻回頭
	}
	go gate.keepTalking()
	return gate
}

// keepTalking 在等待期間每隔 stallNoticeEvery 播一句「還在等」。
// 這是本票驗收條件②：卡住的那一發要有話說，而不是靜默。
func (gate *callGate) keepTalking() {
	if gate.g == nil {
		return
	}
	t := time.NewTicker(gate.notice)
	defer t.Stop()
	for {
		select {
		case <-gate.stop:
			return
		case now := <-t.C:
			waited := int(now.Sub(gate.started).Seconds())
			gate.g.mu.Lock()
			announce := gate.g.announce
			gate.g.mu.Unlock()
			if announce != nil {
				announce(StalledCall{
					Account: gate.host, Step: gate.step.Name, WaitedSec: waited,
					Note: fmt.Sprintf("還在等知識庫「%s」回覆「%s」，已經等了 %d 秒。",
						gate.host, gate.step.Name, waited),
				})
			}
		}
	}
}

// blocked 回「這一輪已經不打這個帳號了」的理由；空＝可以打。
func (gate *callGate) blocked() string { return gate.skip }

// release 停掉播報並放掉 context。**一定要 defer**：context 活到呼叫端讀完回應
// 之後才釋放，所以不能在讀 body 之前呼叫。
func (gate *callGate) release() {
	gate.once.Do(func() { close(gate.stop) })
	gate.cancel()
}

// record 記一發失敗。只有「等到超時」才進帳（連線被拒之類的錯是**很快**回來的，
// 不是本票要修的病，記進去只會讓正常的斷網把帳號誤判成沒有回應）。
// 回傳要交給呼叫端的錯誤：逾時換成白話，其餘原樣。
//
// 可以在 release 之後呼叫——它不碰 context。
func (gate *callGate) record(err error) error {
	if err == nil || !isStallError(err) {
		return err
	}
	waited := time.Since(gate.started)
	if gate.g == nil {
		return fmt.Errorf("「%s」等了 %d 秒，知識庫「%s」沒有回應；稍後會自動再試。",
			gate.step.Name, int(waited.Seconds()), gate.host)
	}
	return errors.New(gate.g.strike(gate.host, gate.step, waited))
}

// isStallError 回答「這個錯誤是**等到超時**嗎」。
//
// 三種都要認得：我們自己的 context deadline、client.Timeout 包出來的
// `*url.Error{Timeout:true}`、以及被 `%w` 包過好幾層之後的同一個東西
//（萃取那條路會加上「連不上你的知識庫：」再包一層）。
func isStallError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	return false
}
