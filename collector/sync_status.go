// sync_status.go — 每輪同步後的彙總狀態（t91 狀態可見性）。
// 寫成 JSON 供托盤讀取，讓使用者第一眼看到萃取是否正常。
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// AccountSyncStatus 彙總單一帳號的每輪同步結果（t104 多帳號看守）。
// key in SyncStatus.AccountDetails = instanceHostOf(cypher_url)。
type AccountSyncStatus struct {
	LastSync     string `json:"last_sync,omitempty"`
	CloudVersion string `json:"cloud_version,omitempty"` // t103 per-account
	CloudCheckOK bool   `json:"cloud_check_ok"`
	// t215（2026-08-08，leo：「在每個知識庫上顯示是否要更新」）：這個帳號的雲端知識庫
	// 有沒有新版可以裝——與 portal 版本卡同一套判準（EvalCloudUpdate，cloud_latest.go），
	// **不是**上面 CloudVersion/CloudCheckOK 搭配 t103 cloudVersionStale 那把尺
	// （那把量的是「太舊會不相容」的協定底線，這裡量的是「有沒有更新版可以裝」）。
	CloudUpdateKnown bool   `json:"cloud_update_known"`
	CloudUpdateStale bool   `json:"cloud_update_stale"`
	CloudLatest      string `json:"cloud_latest,omitempty"` // 已知的最新版（供畫面顯示「最新版 x.y.z」）
	ExtractedOK      int    `json:"extracted_ok"`
	ExtractFailed    int    `json:"extract_failed"`
	// t182（leo 08-04：「沒裝好就顯示 workers AI 還沒通，一旦通了就顯示可用」）：
	// 這個帳號的雲端實例有沒有 /portal/daemon/extract。**逐帳號**各自記——
	// 用戶可能有多個實例、更新進度不同步。只在走 workers-ai 這條路時探測。
	CloudAIReady bool   `json:"cloud_ai_ready"`
	CloudAINote  string `json:"cloud_ai_note,omitempty"` // 還沒通時的白話說明（含該做什麼）

	// ── 額度冷卻（2026-08-07 pacing task 2）───────────────────────────────────
	// Workers AI 每日免費額度用完時，不能每輪繼續撞同一面牆——這裡記「冷卻到什麼時候」
	// 與「今天已經做了幾份」，跨輪讀回（見 direct.go RunDirectOnce 開頭載入 prevStatus）。
	DailyIngestedDate  string `json:"daily_ingested_date,omitempty"`  // YYYY-MM-DD（UTC，與額度重置同一條日界線）
	DailyIngestedCount int    `json:"daily_ingested_count"`           // 今天已成功萃取的份數
	QuotaCooldownUntil string `json:"quota_cooldown_until,omitempty"` // RFC3339；非空且未到＝本帳號本輪不再嘗試萃取
	// QuotaMessage＝額度冷卻中要給使用者看的三句話（見 quota.go QuotaNotice）。
	// 冷卻結束且本輪沒有新命中 ⇒ 每輪重建的 AccountSyncStatus 不會再設它，自然清除。
	QuotaMessage *QuotaNotice `json:"quota_message,omitempty"`
}

// RetiringStatus＝某個「已移除、雲端撤除進行中」資料夾的現況（arcrun-rag#46）。
//
// 為什麼要有這個欄位：撤除可能跨好幾輪（節流＋單輪上限＋雲端可能剛好掛掉），
// 使用者按下「移除並收回」之後如果畫面什麼都不說，他會以為又是一顆沒作用的按鈕
// ——那正是這張票的病。⇒ 進度與**失敗的真因**都要看得見
// （leo 2026-08-06：「別人的錯誤一律要顯示給用戶看，不然就會變成我的錯誤」）。
type RetiringStatus struct {
	Remaining int    `json:"remaining"`            // 還有幾筆沒撤成功
	Done      bool   `json:"done"`                 // 已經收乾淨（App 看到才把設定裡那一筆清掉）
	LastError string `json:"last_error,omitempty"` // 最後一次失敗的真因（原文，不改寫）
}

// ResyncStatus＝某個監看資料夾的「雲端補送」現況（`inkstone/arcrun-rag#140`）。
//
// 🔴 為什麼一定要有畫面：這張票的病不只是「該送的沒送」，還有
// 「**沒有任何地方會說話**」——使用者看到檔案在資料夾裡、AI 卻查不到，
// 而且查不出為什麼。所以修法不能靜悄悄地重送：他要看得見
// 「有 N 份在補送、不是你弄壞的、你不必做任何事」。
//
// 與 Retiring／FolderPlans 同族：**每輪照 manifest 現況重算的快照**，
// 不進 CarryForwardActivity——補完就自然歸零，不必有人去清它。
type ResyncStatus struct {
	Pending   int    `json:"pending"`              // 章已拔掉、還沒補送成功的份數
	Repaired  int    `json:"repaired"`             // 最近一天內已補送成功的份數
	CheckedAt string `json:"checked_at,omitempty"` // 最近一次對帳時間（RFC3339）
	Note      string `json:"note,omitempty"`       // 給使用者看的一句人話
	LastError string `json:"last_error,omitempty"` // 對帳本身失敗的真因（原文，不改寫）
}

// SyncStatus 彙總每輪同步的萃取結果，持久化至 ~/.arcrun-rag/status.json。
// 托盤依此決定顯示「已萃 N 檔」、「⚠ 萃取失敗 M 檔」還是「⚠ 萃取引擎未就緒」。
type SyncStatus struct {
	LastSync       string        `json:"last_sync,omitempty"`       // RFC3339，最近一輪完成時間
	ExtractedOK    int           `json:"extracted_ok"`              // 本輪萃取成功件數（跨帳號累計）
	ExtractFailed  int           `json:"extract_failed"`            // 本輪萃取失敗件數（跨帳號）
	Failures       []ExtractFail `json:"failures,omitempty"`        // 失敗清單（路徑＋白話原因）
	ExtractorOK    bool          `json:"extractor_ok"`              // 萃取器本身是否就緒（預檢，機器層級）
	ExtractorError string        `json:"extractor_error,omitempty"` // 未就緒的白話原因
	// 🔴 最近一輪「真的有做事」的結果（2026-08-05，leo 實撞）。
	// ExtractedOK/ExtractFailed 是**本輪**計數、每輪覆寫 ⇒ 沒事做的那輪就歸零。
	// leo 拖檔進資料夾，萃取上傳都跑完了，但下一輪（15 秒後）把數字歸零
	// ⇒ 首頁「上一輪 N 份」永遠空白，看起來像從頭到尾什麼都沒發生。
	// ⇒ 另存一組「上次有產出的那輪」，沒事做的輪次原樣往下帶，不被清掉。
	LastActivityAt     string `json:"last_activity_at,omitempty"` // RFC3339，上次有產出那輪的完成時間
	LastActivityOK     int    `json:"last_activity_ok"`           // 那一輪成功幾份
	LastActivityFailed int    `json:"last_activity_failed"`       // 那一輪失敗幾份
	// 頂層 cloud 欄位保留向後相容（同時填頂層＋AccountDetails；不論帳號數——
	// arcrun-rag#59 相關實查修過，見 direct.go 寫入處註解：以前只有剛好一個帳號
	// 才填，2+ 帳號時這裡恆為零值 false，讀這個頂層欄位的地方會看到「沒連上雲端」
	// 即使每個帳號都連得上）。CloudCheckOK＝任一帳號連得上；CloudVersion＝第一個
	// 非空版本代表，不代表所有帳號版本一致。
	CloudVersion string `json:"cloud_version,omitempty"` // bundle_version（有連得上的帳號時填）
	CloudCheckOK bool   `json:"cloud_check_ok"`          // 任一帳號 /health 可達即為 true
	// t104：per-account 狀態（key = instanceHostOf(cypher_url)）
	AccountDetails map[string]AccountSyncStatus `json:"account_details,omitempty"`

	// arcrun-rag#46：「移除並收回中」的資料夾進度（key＝資料夾路徑）。
	// 與 SkippedDocs 同族——每輪照現況重算的快照，不進 CarryForwardActivity。
	Retiring map[string]RetiringStatus `json:"retiring,omitempty"`

	// `inkstone/arcrun-rag#140`：雲端上找不到、正在自動補送的資料夾（key＝資料夾路徑）。
	// 與 Retiring 同族的現況快照，見 ResyncStatus 註解。
	Resync map[string]ResyncStatus `json:"resync,omitempty"`

	// 🔴 G-6.2「不准安靜地略過」（2026-08-06）：副檔名不在 allowedExt 的檔案，
	// 以前在 scan.go 的白名單閘就 `return nil` 蒸發了——沒事件、沒紀錄、沒畫面。
	// 使用者丟一份 .doc 進資料夾，得到的回應是**完全的沉默**。
	// ⇒ 每輪把它們帶出來，讓 App 首頁講一句人話。
	//
	// ⚠️ 與 ExtractedOK 不同，**這三個欄位不進 CarryForwardActivity**：
	// 它們是每輪重走檔案系統算出來的「現況快照」，不是「本輪做了幾件事」的計數
	//（後者才會在沒事做的那輪被歸零＝db17f28 修的那個病）。
	// 檔案還躺在資料夾裡，每輪都會被重新數到，所以原地重算就是對的。
	SkippedDocs       []SkippedFile `json:"skipped_docs,omitempty"` // 逐檔點名（已排序，上限 MaxSkippedListed）
	SkippedDocCount   int           `json:"skipped_doc_count"`      // 文件類被略過的**總數**（可能大於清單長度）
	SkippedOtherCount int           `json:"skipped_other_count"`    // 其餘非文件檔（圖片/影音/程式碼…）總數
	// 少量時附上檔名（上限 maxOtherNames）。只報總數在「1 個」時等於沒說——
	// leo 08-06 封測者放了 .md 說「無法通過」，畫面只有「有 1 個不是文件的檔案」，
	// 沒人判斷得出那到底是什麼檔。
	SkippedOtherNames []string `json:"skipped_other_names,omitempty"`

	// FolderPlans＝每個看守資料夾這一輪的收檔策略與少收了什麼（key＝資料夾路徑）。
	// 與 SkippedDocs 同族：每輪照現況重算的快照，**不進 CarryForwardActivity**。
	FolderPlans map[string]FolderPlanStatus `json:"folder_plans,omitempty"`

	// ── t210 統計層（2026-08-08，Evan 封測：「9000 個檔，雲端只有 101 張卡，
	//    畫面卻說 20 份沒送——這幾個數字到底是怎麼回事？」）──────────────────────
	//
	// Progress＝總量進度快照（見 progress.go 的 SyncProgress／(*Manifest).Progress()）。
	// 由 RunDirectOnce 跨帳號、跨資料夾 Add() 累加，並把 G-6.2 的 SkippedDocCount
	// 併進 Unreadable／Total（Progress() 算不到「根本沒進 manifest」的檔）。
	//
	// FailureBreakdown＝「送不上去」（Stuck+Unreadable）展開後的分類統計——
	// 只有分類與份數，沒有檔名、沒有解法（取代 08-06 那套逐檔 humanizeFailure）。
	//
	// ⚠️ 與 SkippedDocCount 同類，**都不進 CarryForwardActivity**：manifest 每輪
	// 重建、涵蓋現況所有檔，這裡原地算出來就是對的——也因此斷網/閒置一輪後
	// 不會被清成 0（現況快照，不是本輪計數）。
	Progress         SyncProgress     `json:"progress"`
	FailureBreakdown FailureBreakdown `json:"failure_breakdown"`

	// Stalls＝這一輪「等太久」的事（`inkstone/arcrun-rag#153`）。
	//
	// 為什麼要有這一格：2026-08-28 實撞的畫面是**小幫手開著、沒有錯誤訊息、
	// 什麼都不動**——同步停在一發等不到回覆的請求上，而使用者看得到的每一個
	// 數字都還是上一輪的。**靜默的等待跟當掉對使用者是同一件事**，
	// 所以「哪個帳號、哪件事、等了多久」要有地方講。
	//
	// 與 SkippedDocs 同族：每輪重算的現況快照，不進 CarryForwardActivity
	//（上一輪等太久不代表這一輪也在等，帶下來就會變成一個永遠擦不掉的警告）。
	Stalls []StalledCall `json:"stalls,omitempty"`
}

// FolderPlanStatus＝某個看守資料夾這一輪用了什麼收檔策略、據此少收了什麼
// （arcrun-rag#104，2026-08-16 補接線）。
//
// 🔴 為什麼補這個：#104 第一階段的收工留言宣稱「策略、理由、擋掉幾個檔…
// 都經 TriggerPayload.Plan 走進 status.json」，**但那從來沒有發生過**——
// `ExcludedByPlan` 與 `Plan` 在整個 repo 裡只有 `main.go`（CLI，走 stderr）讀過，
// daemon（`direct.go`，也就是 App 真正在跑的那條路）拿到 payload 之後直接把這兩欄丟掉。
// ⇒ 使用者接上一個兩千檔的專案、只看到九份進度，畫面**一個字都不會解釋**。
//
// 這是與本票真兇同一天、同一個形狀的第四例：**東西做好了，但不在會被執行的那條路上。**
// 差別只在前三例是「沒接上」，這一例是「接了一半——CLI 有，使用者走的那條沒有」。
type FolderPlanStatus struct {
	Mode   string `json:"mode"`   // all／curated-wiki／docs-only
	Reason string `json:"reason"` // 一句話講給使用者聽的「為什麼只收這些」
	// ExcludedFiles＝走進去了但逐檔被策略擋下的數量。
	ExcludedFiles int `json:"excluded_files"`
	// ExcludedDirs／ExcludedDirCount＝整棵被剪掉的目錄與理由（清單有上限，總數看 Count）。
	ExcludedDirs     []ExcludedDir `json:"excluded_dirs,omitempty"`
	ExcludedDirCount int           `json:"excluded_dir_count"`
	// OtherWikiDirs＝底下其他子專案自己的知識庫，刻意不收但一定要講。
	OtherWikiDirs []string `json:"other_wiki_dirs,omitempty"`
}

// MaxSkippedListed：status.json 裡最多逐檔列幾個。
// 超過的只反映在 SkippedDocCount，UI 說「…等 N 個」——避免整批舊 Office 檔
// 把狀態檔撐大，也避免畫面變成一面看不完的檔名牆。
const MaxSkippedListed = 20

// ExtractFail 記一筆萃取失敗（路徑＋白話原因）。
type ExtractFail struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// StatusFilePath 回傳狀態檔路徑：與 manifest 同目錄的 status.json。
func StatusFilePath(manifestPath string) string {
	return filepath.Join(filepath.Dir(manifestPath), "status.json")
}

// SaveSyncStatus 寫入（覆蓋）狀態檔。失敗只印 stderr，不擋看守本體。
func SaveSyncStatus(path string, s SyncStatus) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(path, data, 0o644)
}

// CarryForwardActivity 決定「最近一次有做事」那三個欄位的值。
//
// 🔴 2026-08-05 leo 實撞：「拖新檔進資料夾，完成本地萃取、上傳，但自始至終 daemon 的
// 首頁都顯示『等待中』…實際上已經做完了，這個 status 是壞的」。
// 真兇：ExtractedOK/ExtractFailed 是**本輪**計數，每輪覆寫整個 status.json
// ⇒ 做完事的那輪寫下 N，下一輪（十幾秒後）沒事做就把它蓋成 0，
// 使用者看到的畫面永遠是「什麼都沒發生」。
//
// 規則：本輪有產出 → 記本輪；本輪沒事做 → 原樣沿用上一輪的（不清空）。
func CarryForwardActivity(prev SyncStatus, st *SyncStatus) {
	if st.ExtractedOK > 0 || st.ExtractFailed > 0 {
		st.LastActivityAt = st.LastSync
		st.LastActivityOK = st.ExtractedOK
		st.LastActivityFailed = st.ExtractFailed
		return
	}
	st.LastActivityAt = prev.LastActivityAt
	st.LastActivityOK = prev.LastActivityOK
	st.LastActivityFailed = prev.LastActivityFailed
}

// LoadSyncStatus 讀取狀態檔；不存在或解析失敗回零值＋error（托盤自行降級）。
func LoadSyncStatus(path string) (SyncStatus, error) {
	var s SyncStatus
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

// SyncNowSignalPath 回傳立刻同步訊號檔路徑：與 manifest 同目錄的 sync-now。
// tray 寫入此檔 → collector 偵測到後立刻跑一輪同步並刪除它。
func SyncNowSignalPath(manifestPath string) string {
	return filepath.Join(filepath.Dir(manifestPath), "sync-now")
}

// explainsWhySkipped 回答：「這一則 `skipped` 的訊息，講得出**為什麼**嗎？」
// 講得出 ⇒ 收進 status.json 的失敗清單，畫面才有原因可講；講不出 ⇒ 不佔畫面。
//
// 🔴 為什麼要抽成具名函式（`inkstone/arcrun-rag#153` 第三輪，2026-08-28 差點實撞）：
// 這個判準本來是**寫死在 direct.go 裡的三個字串比對**，而產生那些訊息的地方在別的檔。
// 我改了斷路器的措辭（「會自動恢復」→「稍後會自動再試」），兩邊當場對不上——
// 後果不是報錯，是**那 9 個被跳過的檔會連一句原因都沒有地從畫面上消失**，
// 正是這個 repo 一再修的「安靜地略過」。
//
// 抽成一個函式解不掉「字串比對很脆」這件事，但它解掉了**兩邊會各自漂走**：
// 現在只有一個地方定義「講得出原因」，而且有測試守著（sync_status_test.go）。
// 新增訊息時，讓它通過這個函式，或把新的識別字加在這裡——不要在別處另開一張表。
func explainsWhySkipped(msg string) bool {
	for _, mark := range []string{
		"後重試",     // 退避中：「上次失敗（第 N 次），X 後重試」
		"已暫停自動重試", // 連續失敗到上限
		"會自動恢復",   // 額度冷卻／帳號暫時打不通，之後自己會好
	} {
		if strings.Contains(msg, mark) {
			return true
		}
	}
	return false
}
