// quotameter.go — 常駐的用量表：「今天用了多少、還剩多少、這批還要幾天送完」
// （`inkstone/arcrun-rag#209`；「還要幾天」那一格的約束來自 `inkstone/InkStoneCo#143`）。
//
// ── 這支檔和 cloudquota.go 是兩件事，不要混 ──────────────────────────────────
//
//	cloudquota.go（#197）  **爆掉之後**講明白：哪一種額度、幾點恢復、你不用做事
//	quotameter.go（#209）  **還沒爆的時候**就看得到數字：用了多少、剩多少、這批要幾天
//
// leo 2026-09-20 原話：「我覺得**不是告訴他爆了**，而是告訴他你現在的還要多久完成，
// 比如 5 天，那就 **1/5、2/5** 就是現在不能立刻完成就有進度條⋯⋯
// CF 給一個儀表板，我們也要，他隨時可以看到用了多少剩下多少，
// 而且**看到他查詢不會像大量寫入那樣爆掉**。」
//
// ── 數字從哪裡來（這是本票最難的一格，不是文案問題）──────────────────────────
//
// 兩個來源，**沒有第三個**：
//
//	① 雲端親口講的  ——「送一張卡要付多少寫入列」。只有寫的人知道，見下面 WriteCost。
//	② 本機自己數的  ——「今天送出去幾張卡」「還有幾張沒送」。送卡的是這台，它當然數得出來。
//
// 🔴 **不准自己去打 Cloudflare 的分析 API 算用量**（#209 紅線）。而且也打不到：
// 小幫手身上沒有任何 Cloudflare 金鑰，安裝器的授權範圍（`installer/oauth-prototype/worker.js`
// `OAUTH_SCOPES`）沒有分析讀取權限——`inkstone/arcrun-rag#197` 當時就裁過「不假裝查得到用量」，
// `#198` 記著「要加那個權限就得讓所有已裝的用戶重新授權一次」。
//
// 🔴 **「每卡幾列」不准寫死在這裡**（`inkstone/InkStoneCo#143` 的紅線）。
// 那個數字**每改一次索引就變**：同一張卡在資料層第 11 代是 1,156 列、第 12 代是 732 列
// （`inkstone/InkStoneCo#140` c10239）。寫死就等著它悄悄說謊——而說謊的方式是
// 「天數變少」，看起來像個答案，所以沒有人會去查。
// ⇒ 它住在雲端的世代表裡（`kbdb/src/actions/schema-generation.ts` 的 `rows_per_card`），
// 由 `kbdb/tests/card-rows-written-gate.test.ts` 現場量、現場對帳，
// 經 `/health` 的 `data_layer.write_cost` 送過來。**這台只負責收，不負責記。**
//
// 🔴 **雲端沒報就說算不出來**，不拿別的數字頂替（同票驗收條件）。
package collector

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

// WriteCost＝雲端親口講的「送一張卡要付多少寫入列」，逐字接住 `/health` 的
// `data_layer.write_cost`（真身在 `kbdb/src/actions/schema-generation.ts`）。
//
// 🔴 這裡**不重新定義**任何一格、也不給預設值：少一格就是雲端沒講，
// 沒講就是算不出來。給預設值＝把「不知道」偽裝成「知道」。
type WriteCost struct {
	RowsPerCard   int    `json:"rows_per_card"`   // 這台的資料層那一代，送一張卡的 rows_written（實測）
	FreeDailyRows int    `json:"free_daily_rows"` // Workers Free 每日寫入上限（UTC 00:00 重置＝台北 08:00）
	Generation    int    `json:"generation"`      // 量的是第幾代——落後的實例付的是它自己那一代的價錢
	MeasuredBy    string `json:"measured_by"`     // 量它的那支閘，出處可追
}

// usable 回報這份回報是不是真的能拿來算。
// 兩個數字都要是正的——雲端給了 0 或負數就是它自己也不知道，照「算不出來」處理。
func (w *WriteCost) usable() bool {
	return w != nil && w.RowsPerCard > 0 && w.FreeDailyRows > 0
}

// cardsPerDay＝免費額度一天送得了幾張卡。無條件捨去：**寧可少估，不可多估**——
// 多估出來的那一張永遠送不掉，而使用者會一直等它。
func (w *WriteCost) cardsPerDay() int {
	if !w.usable() {
		return 0
	}
	n := w.FreeDailyRows / w.RowsPerCard
	if n < 1 {
		return 1 // 一天連一張都送不完＝這台的資料層有別的問題，但天數至少要算得出來
	}
	return n
}

// CardCount＝「幾張卡」與「幾份檔」的換算（`inkstone/InkStoneCo#143` 工人實測）。
//
// 🔴 **一個資料夾不等於一張卡**：小幫手除了內容卡，**每一層資料夾各送一張卡**
// （`folderindex.go`），再加一張整個監看根的總覽卡（`inventory.go`）。
// 端到端實測：1 資料夾 ＋ 3 檔 ⇒ **4 張卡**。
// ⇒ 分母是 `檔數 ＋ 目錄數 ＋ 1`。拿檔數當卡數會低估天數，而低估比算不出來更糟。
type CardCount struct {
	Files   int `json:"files"`   // 檔案卡：一份檔一張
	Folders int `json:"folders"` // 資料夾卡：一層一張（BuildFolderCards）
	Roots   int `json:"roots"`   // 總覽卡：一個監看根一張（syncInventory）
}

// Total＝這一批總共幾張卡。
func (c CardCount) Total() int { return c.Files + c.Folders + c.Roots }

// Add 把另一個監看根／帳號的卡數累加進來（同 SyncProgress.Add 的用法）。
func (c CardCount) Add(o CardCount) CardCount {
	return CardCount{Files: c.Files + o.Files, Folders: c.Folders + o.Folders, Roots: c.Roots + o.Roots}
}

// QuotaMeter＝首頁那張常駐卡要畫的全部東西。
//
// 🔴 **讀取與寫入是兩組數字，不准合併**（leo：「看到他查詢不會像大量寫入那樣爆掉」）。
// 合成一個百分比會讓人以為「這產品就是會爆」，而事實正好相反：
// 會卡的只有第一次灌存量那一段的**寫入**，搜尋（讀取）的額度寬鬆得多。
//
// 🔴 **所有 `*Known` 為 false 的格子都必須有對應的 `*Note` 講出為什麼**——
// 這張卡寧可寫「算不出來」，也不放一個編出來的數字。
type QuotaMeter struct {
	// Account＝這組數字是哪一台知識庫的（多帳號時挑最吃緊的那一台，見 pickQuotaMeter）。
	Account string `json:"account,omitempty"`

	// ── 寫入（送卡）：本機數得出來的那一半 ──────────────────────────────
	WriteKnown bool `json:"write_known"` // 雲端有報 write_cost ⇒ 下面幾格才有意義
	// WriteUsedRows＝今天送出去的卡換算成寫入列。**是估算值**：本機數的是卡數，
	// 每卡列數是雲端給的——兩個都是量到的，但乘起來仍是估算（每張卡的段數與三元組數不同）。
	WriteUsedRows    int    `json:"write_used_rows"`
	WriteLimitRows   int    `json:"write_limit_rows"`
	WriteCardsToday  int    `json:"write_cards_today"`
	WriteRowsPerCard int    `json:"write_rows_per_card"`
	WriteGeneration  int    `json:"write_generation"`
	WriteExhausted   bool   `json:"write_exhausted"` // 雲端親口說今天的寫入額度用完了
	WriteNote        string `json:"write_note,omitempty"`

	// ── 讀取（搜尋）：本機**數不出來**，只講得出上限與現況 ─────────────────
	//
	// 🔴 為什麼沒有「已用多少」：搜尋是使用者在網頁上做的，不經過這台小幫手
	// ⇒ 它數不到。而唯一數得到的地方是 Cloudflare 的分析 API，那個打不到（見檔頭）。
	// ⇒ 誠實講「這台算不到」，不放一個假的分子。
	ReadLimitRows int    `json:"read_limit_rows"`
	ReadExhausted bool   `json:"read_exhausted"` // 雲端親口說今天的讀取額度用完了
	ReadNote      string `json:"read_note,omitempty"`

	// ── 這批還要幾天（leo 要的 1/5、2/5）───────────────────────────────
	BatchKnown        bool   `json:"batch_known"`
	BatchTotalDays    int    `json:"batch_total_days"`    // 這批全部送完要幾天
	BatchDayNo        int    `json:"batch_day_no"`        // 今天是第幾天（1 起算）
	BatchPendingCards int    `json:"batch_pending_cards"` // 還沒送的卡
	BatchTotalCards   int    `json:"batch_total_cards"`   // 這批總共幾張卡
	BatchCardsPerDay  int    `json:"batch_cards_per_day"` // 免費額度一天送得了幾張
	BatchNote         string `json:"batch_note,omitempty"`

	// ResetAt＝下一次額度重置（RFC3339）。與 cloudquota.go 同一條日界線（UTC 00:00＝台北 08:00）。
	ResetAt string `json:"reset_at,omitempty"`
}

// meterInput＝算一張 QuotaMeter 要的全部輸入。
// 刻意做成一個純資料結構：算式是純函式，測試不必生一整份 status.json。
type meterInput struct {
	Account        string
	Cost           *WriteCost // 雲端報的（nil＝沒報）
	CardsToday     int        // 本機今天送出去幾張卡
	Pending        CardCount  // 還沒送的
	Total          CardCount  // 這一批總共幾張
	ReadExhausted  bool
	WriteExhausted bool
	Now            time.Time
}

// d1FreeRowsReadPerDayFallback＝雲端沒報時，讀取上限用哪個數字。
// 它與 cloudquota.go 的 `d1FreeRowsReadPerDay` 是**同一個公開常數**
// （Cloudflare 定價頁），不是第二套來源——所以直接引用那一個，不另外宣告。
func buildQuotaMeter(in meterInput) QuotaMeter {
	m := QuotaMeter{
		Account:        in.Account,
		ReadLimitRows:  d1FreeRowsReadPerDay,
		ReadExhausted:  in.ReadExhausted,
		WriteExhausted: in.WriteExhausted,
		ResetAt:        nextQuotaResetTaiwan(in.Now).Format(time.RFC3339),
	}

	// ── 讀取 ──────────────────────────────────────────────────────────
	// 「已用多少」這台答不出來，所以這一行講的是**上限與現況**，並說清楚為什麼沒有分子。
	if in.ReadExhausted {
		m.ReadNote = "今天的搜尋額度用完了"
	} else {
		m.ReadNote = "搜尋用的是另一份額度，比上傳寬鬆得多（這台看不到你搜了幾次，那是在網頁上做的）"
	}

	// ── 寫入 ──────────────────────────────────────────────────────────
	if !in.Cost.usable() {
		m.WriteNote = "這台雲端還沒有回報「一張卡要花多少額度」，所以算不出用量——更新雲端之後就會有"
		m.BatchNote = m.WriteNote
		return m
	}
	m.WriteKnown = true
	m.WriteRowsPerCard = in.Cost.RowsPerCard
	m.WriteLimitRows = in.Cost.FreeDailyRows
	m.WriteGeneration = in.Cost.Generation
	m.WriteCardsToday = in.CardsToday
	m.WriteUsedRows = in.CardsToday * in.Cost.RowsPerCard
	// 撞頂之後本機數到的卡數乘起來通常小於上限（雲端還有別的寫入，例如背景補索引）。
	// 這時候**以雲端親口說的為準**——它說爆了就是爆了，畫面不該顯示「才用了 60%」。
	if in.WriteExhausted && m.WriteUsedRows < m.WriteLimitRows {
		m.WriteUsedRows = m.WriteLimitRows
		m.WriteNote = "雲端說今天的寫入額度已經用完（除了送卡，雲端自己也會用掉一些）"
	}
	if m.WriteUsedRows > m.WriteLimitRows {
		m.WriteUsedRows = m.WriteLimitRows
	}

	// ── 這批還要幾天 ───────────────────────────────────────────────────
	perDay := in.Cost.cardsPerDay()
	m.BatchCardsPerDay = perDay
	m.BatchPendingCards = in.Pending.Total()
	m.BatchTotalCards = in.Total.Total()
	if m.BatchPendingCards <= 0 {
		m.BatchNote = "沒有排隊中的檔案"
		return m
	}
	m.BatchKnown = true
	m.BatchTotalDays = daysFor(m.BatchTotalCards, perDay)
	remaining := daysFor(m.BatchPendingCards, perDay)
	// 今天是第幾天＝總天數扣掉剩下的天數再加一。
	// 這樣它**每天會自己往前走**（明天待送少了一天的量 ⇒ remaining 少 1 ⇒ 第幾天 +1），
	// 不必記「這批是哪天開始的」——那種紀錄一旦漂掉就再也對不回來。
	m.BatchDayNo = m.BatchTotalDays - remaining + 1
	if m.BatchDayNo < 1 {
		m.BatchDayNo = 1
	}
	if m.BatchDayNo > m.BatchTotalDays {
		m.BatchDayNo = m.BatchTotalDays
	}
	return m
}

// daysFor＝這麼多張卡，照一天 perDay 張要幾天（無條件進位，至少 1 天）。
func daysFor(cards, perDay int) int {
	if cards <= 0 {
		return 0
	}
	if perDay <= 0 {
		return 0
	}
	return int(math.Ceil(float64(cards) / float64(perDay)))
}

// WriteUsageLine＝leo 要的那個形狀：`90332/100000`。**一個數字、一條斜線，不加句子。**
// leo 2026-09-20：「數字應該簡單不要囉嗦」。
func (m QuotaMeter) WriteUsageLine() string {
	if !m.WriteKnown {
		return ""
	}
	return fmt.Sprintf("%d/%d", m.WriteUsedRows, m.WriteLimitRows)
}

// BatchProgressLine＝leo 要的 `1/5`。同上，不加句子。
func (m QuotaMeter) BatchProgressLine() string {
	if !m.BatchKnown {
		return ""
	}
	return fmt.Sprintf("%d/%d", m.BatchDayNo, m.BatchTotalDays)
}

// ── 雲端報來的 write_cost 放哪裡 ─────────────────────────────────────────────
//
// 與 cloudquota.go 的 `d1QuotaSeen` 同一個形狀、同一把 key（`cloudCheckKey(cypherURL)`）：
// 每輪 `/health` 回來時記一次，一台一筆。**連不上時保留上一次的**——
// 「一張卡幾列」是那台資料層的性質，不會因為這一次沒連上就變了；
// 真的變了（升級／降級）下一次連上就會被蓋掉。
var (
	writeCostMu   sync.Mutex
	writeCostSeen = map[string]WriteCost{}
)

func resetWriteCost() {
	writeCostMu.Lock()
	defer writeCostMu.Unlock()
	writeCostSeen = map[string]WriteCost{}
}

// noteWriteCost 記下這台雲端報的每卡寫入成本。nil／不可用＝這一次沒報，**不動既有的**
// （舊版雲端沒有這一格，不能因此把上一次問到的答案清掉）。
func noteWriteCost(cypherURL string, c *WriteCost) {
	if !c.usable() {
		return
	}
	writeCostMu.Lock()
	defer writeCostMu.Unlock()
	writeCostSeen[cloudCheckKey(cypherURL)] = *c
}

// knownWriteCost 取這台雲端最後一次報的成本；沒有就是 nil ⇒ 畫面說「算不出來」。
func knownWriteCost(cypherURL string) *WriteCost {
	writeCostMu.Lock()
	defer writeCostMu.Unlock()
	c, ok := writeCostSeen[cloudCheckKey(cypherURL)]
	if !ok {
		return nil
	}
	return &c
}

// writeCostFromHealth 從 `/health` 的整份回應挖出 `data_layer.write_cost`。
// 挖不到（舊版雲端、不是 JSON、欄位缺）一律回 nil——**認不出來就不編故事**
// （同 d1QuotaFromHealth 的自我約束）。
func writeCostFromHealth(body []byte) *WriteCost {
	var payload struct {
		DataLayer *struct {
			WriteCost *WriteCost `json:"write_cost"`
		} `json:"data_layer"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.DataLayer == nil {
		return nil
	}
	if !payload.DataLayer.WriteCost.usable() {
		return nil
	}
	return payload.DataLayer.WriteCost
}

// pickQuotaMeter 從每輪重建的 per-account 狀態組出首頁那張常駐卡。
//
// 多帳號時挑**最吃緊的那一台**（不是加總）：額度是逐個 Cloudflare 帳號各自算的，
// 把兩台的用量加起來會得到一個在現實中不存在的數字。而使用者真正要知道的是
// 「會不會卡住」——那取決於最先撞牆的那一台。
//
// 排序是確定的（先照 key 排），同一份輸入永遠得到同一張卡——畫面不會自己跳動。
//
// 卡數（總量／待送）用的是**跨帳號的總量**：使用者丟進來的是資料夾，
// 他問的是「我這批要幾天」，不是「這批在第二個知識庫上要幾天」。
func pickQuotaMeter(details map[string]AccountSyncStatus, total, pending CardCount, now time.Time) *QuotaMeter {
	if len(details) == 0 {
		return nil
	}
	keys := make([]string, 0, len(details))
	for k := range details {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	type cand struct {
		key   string
		acc   AccountSyncStatus
		rank  int // 越大越吃緊
		usage int // 今天送了幾張卡（同 rank 時比這個）
	}
	var best *cand
	for _, k := range keys {
		acc := details[k]
		c := cand{key: k, acc: acc, usage: acc.CardsSentCount}
		switch quotaKindOf(acc) {
		case QuotaKindD1Write:
			c.rank = 3 // 寫入爆了最吃緊：他丟進來的東西現在送不出去
		case QuotaKindD1Read:
			c.rank = 2
		default:
			if acc.WriteCost.usable() {
				c.rank = 1 // 至少講得出數字，勝過一台什麼都不知道的
			}
		}
		if best == nil || c.rank > best.rank || (c.rank == best.rank && c.usage > best.usage) {
			b := c
			best = &b
		}
	}
	if best == nil {
		return nil
	}
	kind := quotaKindOf(best.acc)
	m := buildQuotaMeter(meterInput{
		Account:        best.key,
		Cost:           best.acc.WriteCost,
		CardsToday:     best.acc.CardsSentCount,
		Pending:        pending,
		Total:          total,
		ReadExhausted:  kind == QuotaKindD1Read,
		WriteExhausted: kind == QuotaKindD1Write,
		Now:            now,
	})
	return &m
}

// quotaKindOf 回這個帳號現在是哪一種 D1 額度用完（""＝沒有）。
// 只認 cloudquota.go 寫進去的 Kind，**不在這裡重新判斷任何字串**——
// 「哪一種額度」的判準只住那一個接縫（同 ClassifyFailure 的慣例）。
func quotaKindOf(acc AccountSyncStatus) string {
	if acc.QuotaMessage == nil {
		return ""
	}
	return acc.QuotaMessage.Kind
}
