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
//   - HTTP 5xx、429、等不到回應（逾時）、連上之後被切斷 ⇒ 算。
//   - 🔴 **這台電腦根本沒連出去**（DNS 查不到、網路不通、連線被本機拒絕）⇒ **不算**
//     （`inkstone/arcrun-rag#201`）：請求沒離開這台電腦，雲端一分額度都沒花，
//     斷路器存在的理由（別把雲端額度燒光）在這裡不成立。2026-09-16 leo 的 log 裡
//     這一類錯誤有 1849 筆（Mac 睡醒、網路還沒好的那幾秒），把它們算成「雲端壞了」
//     只會讓網路一恢復，小幫手反而還停在「先停 26 分鐘」。
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
// 🔴 「連續」要是真的連續（`inkstone/arcrun-rag#201`）：
//   舊版只有「2xx 才歸零」，而空 text 的探測通了刻意不記、有前科的檔成功之前都不會回 2xx
//   ⇒ 一個所有檔都卡住的帳號，計數器**從行程啟動那一刻起只增不減**。
//   2026-09-16 geek6688 那句「連續失敗 11 次」其實是 09-14 17:22 開 App 之後兩天內零星的
//   11 發（最後一發＝17:48:42 探測等了 20 秒），不是剛剛連撞 11 次。
//   ⇒ 距離上一次失敗超過 routeFailMemory 還沒再失敗，就當作路早就好了，重新算起。
//
// 每一次「算進去」的失敗都會印一行帶時間的紀錄（phase:"route_failure"，見 routeFailureLog），
// 事後看得出「這 N 次是哪一種、依序發生在什麼時候」——以前 log 只有整輪結果重印，沒有時間。
//
// 使用者按「立刻同步」（ForceSync）＝這一輪不看退避，照打（與逐檔退避同一個語意）。
//
// 狀態只活在這個行程裡：行程重開＝從零開始，最壞代價是重開後第一輪多撞一發就重新停下。
package collector

import (
	"errors"
	"fmt"
	"net"
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

// routeFailMemory＝上一次失敗之後多久沒再失敗，就不再把它算進「連續」。
// 取階梯上限（30 分鐘）的兩倍：退避中的路窗口到期會再試一發，所以真的一直壞的路
// 最慢 30 分鐘就會再記一次失敗，不會被這條規則洗掉；只有「好幾個小時才偶發一次」
// 的零星失敗才會重新算起。
const routeFailMemory = time.Hour

type routeState struct {
	fails     int
	until     time.Time
	lastFail  time.Time
	lastCause string // 給人看的「最近一次是怎麼失敗的」，不含狀態碼與網址
}

// RouteFailure＝一次被算進斷路器的失敗（印進 collector.log 的那一行）。
type RouteFailure struct {
	Route        string `json:"route"`                   // 給人看的路名（例：雲端 AI 整理文件）
	Account      string `json:"account"`                 // 知識庫主機
	Fails        int    `json:"fails"`                   // 算進這一發之後的連續失敗數
	Cause        string `json:"cause"`                   // 白話的失敗種類
	HTTPStatus   int    `json:"http_status,omitempty"`   // 0＝沒拿到回應
	Detail       string `json:"detail,omitempty"`        // 連線層錯誤原文（有才帶）
	BackoffUntil string `json:"backoff_until,omitempty"` // 這一發讓整條路停到什麼時候（沒停＝空）
}

// routeFailureLog＝每算進一次失敗就呼叫一次。預設不做事（測試不想被印一堆）；
// `collector direct` 主程式會把它接到 stdout（→ supervisor tee 進 collector.log）。
var routeFailureLog = func(at time.Time, f RouteFailure) {}

// announceRouteFailure 把一次失敗印成 stdout 上一個完整的 JSON 值（與其他播報共用鎖）。
func announceRouteFailure(at time.Time, f RouteFailure) {
	printJSONLine(struct {
		At    string `json:"at"`
		Phase string `json:"phase"`
		RouteFailure
	}{at.Format(time.RFC3339), "route_failure", f})
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

// isLocalNetworkErr＝「這一發根本沒離開這台電腦」：DNS 查不到、網路不通、連線被拒。
//
// 🔴 刻意不含逾時（包括連線階段的逾時）：等到超時的那一發，雲端可能已經在處理了，
// 那是 stallguard.go 的事，也照樣算進斷路器。
// 字串比對是給**舊病歷**用的：manifest 裡存的 LastError 是字串，不是 error 物件。
func isLocalNetworkErr(err error) bool {
	if err == nil {
		return false
	}
	if isStallError(err) {
		return false
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	return isLocalNetworkText(err.Error())
}

// isLocalNetworkText＝isLocalNetworkErr 的字串版（manifest 的 LastError 只剩字串）。
func isLocalNetworkText(msg string) bool {
	if msg == "" {
		return false
	}
	for _, mark := range []string{
		"no such host",
		"network is unreachable",
		"no route to host",
		"connection refused",
		"server misbehaving", // 本機 DNS 伺服器回壞答案
	} {
		if strings.Contains(msg, mark) {
			return true
		}
	}
	return false
}

// routeFailCause＝給人看的「這一發是怎麼失敗的」。不帶狀態碼（畫面上的話不裸露上游代碼）。
func routeFailCause(status int, transportErr error) string {
	switch {
	case transportErr != nil && isStallError(transportErr):
		return "等不到回應"
	case transportErr != nil:
		return "連線中途斷掉"
	case status == 429:
		return "雲端說請求太多"
	default:
		return "雲端回報內部錯誤"
	}
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

// note 回「這條路現在正在退避」的白話；空＝可以打。知識庫以主機名稱呼（見 noteFor）。
func (b *routeBreaker) note(raw string, now time.Time) string {
	return b.noteFor(raw, "", now)
}

// noteFor＝note，另帶「哪一台知識庫」的稱呼（帳號名）。
//
// 🔴 `inkstone/arcrun-rag#201`：舊句子只講「雲端『雲端 AI 整理文件』這條路」——
// 小幫手連著三個知識庫，而這句會被浮到首頁頂端。2026-09-16 那句其實是 geek6688 的，
// leo 看的是 leo21c，於是查錯了帳號。⇒ 句子裡一定要點名是哪一台，
// 也要講最近一次是哪一種失敗、什麼時候（「連續失敗 11 次」本身說不出原因）。
func (b *routeBreaker) noteFor(raw, who string, now time.Time) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.routes[routeKey(raw)]
	if st == nil || !now.Before(st.until) {
		return ""
	}
	if strings.TrimSpace(who) == "" {
		who = instanceHostOf(raw)
	}
	wait := st.until.Sub(now).Round(time.Second)
	last := ""
	if st.lastCause != "" && !st.lastFail.IsZero() {
		last = fmt.Sprintf("（最近一次 %s：%s）", st.lastFail.Local().Format("15:04"), st.lastCause)
	}
	// 🔴 結尾「稍後會自動恢復」是 explainsWhySkipped 的識別字（sync_status.go），不要改掉。
	// 不帶上游原文（HTTP 碼／JSON）：這句會出現在畫面上；原文在 collector.log 的 route_failure 那幾行。
	return fmt.Sprintf("知識庫「%s」的「%s」這條路連續失敗 %d 次%s，先停 %s 再試，避免一直重撞把雲端額度用光；稍後會自動恢復。",
		who, routeLabel(raw), st.fails, last, humanWait(wait))
}

// record 記一發的結果。status＝HTTP 狀態碼（0＝沒拿到回應）；transportErr＝連線層錯誤；
// retry＝這份內容先前就失敗過（逐檔病歷上有紀錄）——它失敗不算路壞，見檔頭。
func (b *routeBreaker) record(raw string, now time.Time, status int, transportErr error, retry bool) {
	// #201：請求根本沒離開這台電腦 ⇒ 雲端沒花任何額度，不算數也不歸零。
	if transportErr != nil && isLocalNetworkErr(transportErr) {
		return
	}
	failed := transportErr != nil || status >= 500 || status == 429
	b.mu.Lock()
	key := routeKey(raw)
	if !failed {
		if status >= 200 && status < 300 {
			delete(b.routes, key) // 通了就全部歸零
		}
		b.mu.Unlock()
		return
	}
	if retry {
		b.mu.Unlock()
		return // 有前科的內容再失敗：它自己的病，不算數也不歸零
	}
	st := b.routes[key]
	if st == nil {
		st = &routeState{}
		b.routes[key] = st
	}
	// #201：上一次失敗太久以前 ⇒ 那不是「連續」，重新算起。
	if st.fails > 0 && !st.lastFail.IsZero() && now.Sub(st.lastFail) > routeFailMemory {
		st.fails = 0
	}
	st.fails++
	st.lastFail = now
	st.lastCause = routeFailCause(status, transportErr)
	entry := RouteFailure{
		Route:      routeLabel(raw),
		Account:    instanceHostOf(raw),
		Fails:      st.fails,
		Cause:      st.lastCause,
		HTTPStatus: status,
	}
	if transportErr != nil {
		entry.Detail = transportErr.Error()
	}
	if st.fails >= routeStrikesBeforeBackoff {
		idx := st.fails - routeStrikesBeforeBackoff
		if idx >= len(routeBackoffLadder) {
			idx = len(routeBackoffLadder) - 1
		}
		st.until = now.Add(routeBackoffLadder[idx])
		entry.BackoffUntil = st.until.Format(time.RFC3339)
	}
	b.mu.Unlock()
	routeFailureLog(now, entry) // 鎖外呼叫：印 stdout 要拿另一把鎖，別疊在一起
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
	return cloudRoutes.noteFor(raw, c.InstanceName, directNow())
}
