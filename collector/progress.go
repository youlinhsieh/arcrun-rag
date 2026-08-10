// progress.go — 「你有幾份、我做完幾份、卡住的是哪幾類」（2026-08-08，Evan 封測 + leo 重新定形）。
//
// 🔴 這一層同時服務兩件事，所以獨立成檔：
//
//	t210 首頁統計（使用者每天看的）
//	t213 診斷檔（出事時唯一能拿到的東西）
//
// 兩邊必須是**同一組數字**——不然又會出現「畫面說 20、檔案說別的」。
//
// ── 為什麼要有分母 ────────────────────────────────────────────────────────
// leo 轉述 Evan：「我有 9000 個檔，雲端只有 101 張卡，畫面卻說『20 份沒送進知識庫』
// ——這幾個數字到底是怎麼回事？是壞了嗎？還是繼續在跑？」
// 病根：首頁每個數字都是**本輪**的（單輪上限 25 筆），使用者問的是**總量**的。
// 兩者永遠對不起來 ⇒ 他無法判斷「還在跑」還是「壞了」＝會不會來找客服的分水嶺。
//
// ── 為什麼是分類而不是逐檔 ────────────────────────────────────────────────
// leo 2026-08-08：「**我不要枚舉每個檔案可能的問題和解法，應該是統計的**，
// 因為客戶的可能性太多了，以後會花很多力氣去想為什麼不能支援」
// ⇒ 分類**收斂且窮舉得完**，多出來的一律進「其他」。畫面不解釋、不給解法，
//
//	細節去 Docs FAQ。這取代 08-06 那套逐檔白話翻譯（humanizeFailure）。
package collector

import "strings"

// SyncProgress＝總量進度。**單位一律是「份檔案」**（使用者丟進資料夾的東西）。
//
// 🔴 單位為什麼不是「張知識卡」（leo 原稿寫的）：地端**算不出**待同步幾張卡——
// 還沒萃取的檔不知道會生出幾張。卡數只有雲端知道。而 leo 最初的痛點原話
// （「他的原檔 9000⋯⋯送到雲端 101/9000」）本來就是檔案單位。
// ⇒ 同一行內單位一致，數字才加得起來；卡與關聯另起一行當成果展示。
//
// 不變式：Total == Done + Pending + Stuck + Unreadable（t210 驗法①，測試守著）
type SyncProgress struct {
	Total      int `json:"total"`      // 看守的資料夾裡，我認得的檔案總數
	Done       int `json:"done"`       // 已送進知識庫且內容沒再變過
	Pending    int `json:"pending"`    // 還沒送，會自動接著做（含退避等待中的）
	Stuck      int `json:"stuck"`      // 連續失敗達上限、已暫停自動重試——**不會自己好**
	Unreadable int `json:"unreadable"` // 格式讀不了，根本沒進 manifest（由呼叫端補進來）
}

// Add 把另一個資料夾／帳號的進度累加進來——首頁與診斷檔講的都是總量。
func (p SyncProgress) Add(o SyncProgress) SyncProgress {
	return SyncProgress{
		Total:      p.Total + o.Total,
		Done:       p.Done + o.Done,
		Pending:    p.Pending + o.Pending,
		Stuck:      p.Stuck + o.Stuck,
		Unreadable: p.Unreadable + o.Unreadable,
	}
}

// Progress 數這份 manifest 的現況。
// manifest 每輪由 Scan() 重建、涵蓋現況所有檔（scan.go 第 7 步「現況檔全數收錄」）
// ⇒ 這裡原地數就是對的，不必另外維護計數器（也就不會有「計數器漂掉」那類病）。
func (m *Manifest) Progress() SyncProgress {
	var p SyncProgress
	for _, e := range m.Entries {
		if e == nil {
			continue
		}
		p.Total++
		switch {
		case e.IngestedHash != "" && e.IngestedHash == e.ContentHash:
			p.Done++
		case e.FailCount >= MaxFailBeforeSkip:
			// 已經放棄自動重試的不能混在 Pending 裡假裝還在排隊——
			// 使用者會一直等一件永遠不會發生的事。
			p.Stuck++
		default:
			p.Pending++
		}
	}
	return p
}

// ── 失敗分類（取代逐檔解釋）──────────────────────────────────────────────
//
// 🔴 收斂原則：這個清單**不准為每個新錯誤一直加**。認不出來的一律進 FailOther，
// 需要細節的人去 Docs FAQ 查。否則就會回到 leo 說的「花很多力氣去想為什麼不能支援」。
const (
	FailUnsupportedFormat = "格式不支援"
	FailQuotaExhausted    = "今天的 AI 額度用完了"
	FailNoTextInFile      = "檔案讀不出文字"
	FailOther             = "其他"
)

// FailCategories 是分類的**固定順序**（畫面與診斷檔都照這個序，不隨 map 迭代跳動）。
var FailCategories = []string{FailUnsupportedFormat, FailQuotaExhausted, FailNoTextInFile, FailOther}

// ClassifyFailure 把 collector／雲端吐出的原始錯誤歸進上面四類。
//
// 判斷用的識別字全部來自實撞紀錄，不是猜的：
//   - `4006` / `neurons`：Cloudflare Workers AI 當日免費額度用完（leo 2026-08-06 從
//     Windows collector.log 挖出來的原文）
//   - `沒有可抽取的文字`：掃描成圖片的 PDF（同日第二例）
//   - `尚未支援的檔案格式`：白名單外的副檔名（G-6.2）
//   - 退避訊息會把上游真因接在「｜原因：」後面（direct.go retrySkipReason）
//     ⇒ 先看得到真因就照真因分類，看不到才落到「其他」
func ClassifyFailure(raw string) string {
	switch {
	case strings.Contains(raw, "neurons"), strings.Contains(raw, "4006"),
		strings.Contains(raw, "額度"),
		// 2026-08-09（P8）：額度用完的檔，錯誤欄位存的是 QuotaNotice 三句話
		// （quota.go Combined()），文案裡刻意沒有「額度」「4006」這些字——
		// 少了這兩個識別字，這批檔會被歸進「其他」，畫面上「今天的 AI 額度用完了」
		// 反而一份都沒有。識別字取三句話裡最不會變動的兩段。
		strings.Contains(raw, "幫你整理了"), strings.Contains(raw, "會自動恢復"):
		return FailQuotaExhausted
	case strings.Contains(raw, "沒有可抽取的文字"):
		return FailNoTextInFile
	case strings.Contains(raw, "尚未支援的檔案格式"), strings.Contains(raw, "不支援"):
		return FailUnsupportedFormat
	}
	return FailOther
}

// FailureBreakdown 是「無法同步 F 份」展開後的內容：只有分類與份數，**沒有檔名、沒有解法**。
// 用固定順序的 slice 而非 map——JSON 輸出穩定、畫面不會每次重排。
type FailureBreakdown struct {
	Total  int            `json:"total"`
	Groups []FailureGroup `json:"groups"`
}

// FailureGroup＝一類與它的份數。
type FailureGroup struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// BuildFailureBreakdown 把一批原始錯誤訊息歸類統計。
// 份數為 0 的分類不出現（沒事就別佔畫面，同 buildSkipped 的慣例）。
func BuildFailureBreakdown(rawErrors []string) FailureBreakdown {
	counts := map[string]int{}
	for _, raw := range rawErrors {
		counts[ClassifyFailure(raw)]++
	}
	b := FailureBreakdown{Total: len(rawErrors)}
	for _, cat := range FailCategories {
		if n := counts[cat]; n > 0 {
			b.Groups = append(b.Groups, FailureGroup{Category: cat, Count: n})
		}
	}
	return b
}
