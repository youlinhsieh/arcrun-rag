// routebackoff.go — 雲端某條路持續失敗時，跨輪退避（`inkstone/arcrun-rag#121` comment 6923）。
//
// 病（2026-09-13 leo Mac 實測）：雲端 rag_ingest_card 每一發都回 HTTP 500
// （`list_old_blocks` 缺 credential），而那個節點是全表掃。daemon 每 5 秒一輪、
// 每一輪都把同一面牆重撞一次：出處修正（Arcrun#167）一輪最多 20 發、資料夾索引一發、
// 每個新檔再各一發——youlin 的免費 D1 一小時被讀掉 600 萬列、當天知識庫停擺。
//
// 既有的閘為什麼都沒擋住：
//   - 逐檔退避（manifest FailCount）管的是「這個檔壞了」，一批沒試過的新檔每個都會先撞一次；
//   - roundGuard（stallguard.go）只管「等到超時」，而且每輪歸零；
//   - 額度冷卻只認得 Workers AI 的額度訊息。
//
// ⇒ 缺的是「**這條路**壞了」這一層：同一台知識庫的同一個端點連續失敗，
//
//	就整條路停一段時間，時間一次比一次長；有一發成功就立刻恢復。
//
// 判準（什麼算「路壞了」）：
//   - HTTP 5xx、429、連不上／逾時 ⇒ 算。
//   - HTTP 2xx 但 body 裡寫著工作流失敗 ⇒ **不算**：路是通的，失敗可能只屬於那一份內容，
//     把它算成整條路壞掉會讓一份怪檔拖住所有人（逐檔退避會照顧它）。
//   - 其他 4xx ⇒ 不算（多半是那一發本身的問題，不是路的問題）。
//
// 🔴 什麼時候判「路壞了」（而不是「那一份內容壞了」）：
//   - 單看狀態碼分不出來——工作流任何節點失敗都回 500，不管是路壞還是那張卡怪。
//   - 所以要**連續 routeStrikesBeforeBackoff 發「第一次送」的請求都失敗**才停。
//     「第一次送」＝逐檔病歷上沒有失敗紀錄的檔，以及出處修正／總覽／目錄索引／下架這類系統件。
//   - 已經失敗過的檔再重試又失敗 ⇒ **不算數也不歸零**：那是它自己的病（逐檔退避在管），
//     不准拿它把整條路關掉——否則一池壞檔會輪流把健康的檔擋在外面（t217 餓死病換個形狀回來）。
//
// 使用者按「立刻同步」（ForceSync）＝這一輪不看退避，照打（與逐檔退避同一個語意）。
//
// 狀態只活在這個行程裡：行程重開＝從零開始，最壞代價是重開後第一輪多撞一發就重新停下。
package collector

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

// routeBackoffLadder＝同一條路連續失敗第 N 次之後要停多久。
// 第一格 1 分鐘：一次偶發的 500 不該讓使用者等太久；
// 上限 30 分鐘：雲端修好之後，最慢半小時內自己接上，不必重開小幫手。
var routeBackoffLadder = []time.Duration{
	1 * time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 30 * time.Minute,
}

// routeStrikesBeforeBackoff＝同一條路連續幾發「第一次送」都失敗，才判定是路壞了。
//
// 為什麼是 4 而不是 1：一次 500 可能只是那一份內容的問題，下一輪就該照常重試
// （既有測試守著：下架失敗下一輪補、收回失敗下一輪補、總覽退避到期就補、
// 單輪上限 3 份全是壞檔時健康檔下一輪要遞補得上來）。
// 為什麼不是更多：2026-09-13 的實況，一輪開頭的出處修正＋總覽＋目錄索引＋第一個新檔
// 就是 4 發——第一輪之內就停得下來。之後每次窗口到期只會再撞 1 發。
const routeStrikesBeforeBackoff = 4

type routeState struct {
	fails int
	until time.Time
}

type routeBreaker struct {
	mu     sync.Mutex
	routes map[string]*routeState
}

// cloudRoutes＝整個行程共用的一份（跨輪、跨帳號；key 自帶主機名，帳號之間不會互相牽連）。
var cloudRoutes = &routeBreaker{routes: map[string]*routeState{}}

// routeBackoffError＝「這一發根本沒打出去，因為這條路正在退避」。
// 呼叫端用 isRouteBackoff 認它：這不是那個檔的錯，不准記進逐檔病歷。
type routeBackoffError struct{ note string }

func (e *routeBackoffError) Error() string { return e.note }

func isRouteBackoff(err error) bool {
	_, ok := err.(*routeBackoffError)
	return ok
}

// routeKey＝主機＋路徑（不含查詢字串）。同一台知識庫的不同工作流是不同的路。
func routeKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Host + u.Path
}

// routeLabel＝給人看的「哪一條路」。只取工作流名，不出現網址與狀態碼。
func routeLabel(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "雲端"
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	// /webhooks/named/<ns>/<workflow>/trigger
	if len(parts) >= 5 && parts[0] == "webhooks" && parts[len(parts)-1] == "trigger" {
		return parts[len(parts)-2]
	}
	switch u.Path {
	case "/portal/daemon/extract":
		return "雲端 AI 整理文件"
	case "/portal/daemon/folder-tree":
		return "回報資料夾結構"
	}
	return u.Path
}

// note 回「這條路現在正在退避」的白話；空＝可以打。
func (b *routeBreaker) note(raw string, now time.Time) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.routes[routeKey(raw)]
	if st == nil || !now.Before(st.until) {
		return ""
	}
	wait := st.until.Sub(now).Round(time.Second)
	// 🔴 結尾「稍後會自動恢復」是 explainsWhySkipped 的識別字（sync_status.go），不要改掉。
	// 不帶上游原文（HTTP 碼／JSON）：這句會出現在畫面上；原文在失敗那一發的結果裡已經留著。
	return fmt.Sprintf("雲端「%s」這條路連續失敗 %d 次，先停 %s 再試，避免一直重撞把雲端額度用光；稍後會自動恢復。",
		routeLabel(raw), st.fails, humanWait(wait))
}

// record 記一發的結果。status＝HTTP 狀態碼（0＝沒拿到回應）；transportErr＝連線層錯誤；
// retry＝這份內容先前就失敗過（逐檔病歷上有紀錄）——它失敗不算路壞，見檔頭。
func (b *routeBreaker) record(raw string, now time.Time, status int, transportErr error, retry bool) {
	failed := transportErr != nil || status >= 500 || status == 429
	b.mu.Lock()
	defer b.mu.Unlock()
	key := routeKey(raw)
	if !failed {
		if status >= 200 && status < 300 {
			delete(b.routes, key) // 通了就全部歸零
		}
		return
	}
	if retry {
		return // 有前科的內容再失敗：它自己的病，不算數也不歸零
	}
	st := b.routes[key]
	if st == nil {
		st = &routeState{}
		b.routes[key] = st
	}
	st.fails++
	if st.fails < routeStrikesBeforeBackoff {
		return
	}
	idx := st.fails - routeStrikesBeforeBackoff
	if idx >= len(routeBackoffLadder) {
		idx = len(routeBackoffLadder) - 1
	}
	st.until = now.Add(routeBackoffLadder[idx])
}

// reset 清空全部狀態（測試用）。
func (b *routeBreaker) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.routes = map[string]*routeState{}
}

func humanWait(d time.Duration) string {
	if d >= time.Minute {
		return fmt.Sprintf("%d 分鐘", int((d+time.Minute-1)/time.Minute))
	}
	return fmt.Sprintf("%d 秒", int(d/time.Second))
}

// routeNote＝打某條路之前先問「它現在在退避嗎」。按「立刻同步」的這一輪一律照打。
//
// arcrun-rag#197：雲端資料庫今天的免費額度用完 ⇒ 這台知識庫的每一條路都不打，
// **連「立刻同步」也不打**——恢復前每一發只會拿到同一個錯；而「立刻同步」那一輪
// cloudVersionThrottled 會強制重問 /health，額度真的恢復了這裡自然就放行。
func (c *DirectConfig) routeNote(raw string) string {
	if note := d1QuotaNote(c.CypherURL, directNow()); note != "" {
		return note
	}
	if c.ForceSync {
		return ""
	}
	return cloudRoutes.note(raw, directNow())
}
