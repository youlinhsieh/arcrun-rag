package main

// app.go — Arcrun 桌面 App 的後端（t193）
//
// 🔴 為什麼從 fyne 換到 Wails（leo 2026-08-04 看過 v0.16.0 畫面後拍板）：
//
//	leo：「功能都有了，但**美感非常糟糕**……**跟 CIS 完全無關**，
//	      每個功能都開一個小小的 popup 視窗，**非常缺乏整體感**，
//	      這要理解的是**原始的技術選擇是否出錯**？」
//	      「我的要求是**符合 CIS**，在風格上**跟 portal 一樣**」
//
//	fyne 的哲學＝所有 UI 自己用 OpenGL 畫 ⇒ 不像 Mac、不像 Windows、**也不像 portal**，
//	CSS 套不進去、popup 外觀無法控制 ⇒ **CIS 這個硬要求在 fyne 上做不到**。
//	Wails 是 WebView 殼 ⇒ 前端就是 HTML/CSS ⇒ **可以直接用 portal 那份色票與 lockup**。
//	（此結論 07-27 就查過並寫進 decisions-summary.md D-daemon-UI，我卻沒在動工前提醒。）
//
// 邊界：本檔只做「把既有能力接到 UI」——config 讀寫、狀態、資料夾增刪都對齊
// collector 既有的檔案協定（~/.arcrun-rag/），不另發明一套。
import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	runtime2 "runtime"
	"sort"
	"strings"
	"time"

	collector "arcrun-rag/collector"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App 是 Wails 綁定的後端物件；前端呼叫的方法都掛在它身上。
type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// ── 與 collector 共用的資料位置（路徑規則與 collector/direct.go 一致）──

func appDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".arcrun-rag")
}
func configPath() string    { return filepath.Join(appDir(), "config.json") }
func statusPath() string    { return filepath.Join(appDir(), "status.json") }
func syncNowSignal() string { return filepath.Join(appDir(), "sync-now") }

// ── config 結構（欄位與 collector/direct.go 的 DirectConfig 對齊）──

type accountCfg struct {
	InstanceName string   `json:"instance_name,omitempty"`
	Email        string   `json:"email,omitempty"`
	CypherURL    string   `json:"cypher_url"`
	Namespace    string   `json:"namespace"`
	APIKey       string   `json:"api_key,omitempty"`
	WatchFolders []string `json:"watch_folders,omitempty"`
	// RetiringFolders＝已按「移除並收回」、雲端還沒撤乾淨的資料夾（arcrun-rag#46）。
	//
	// 🔴 t108 那條教訓的直接適用：saveCfg 會把整個 accounts 陣列**用這個 struct 重新序列化**
	//    ⇒ 這裡少一個欄位，寫在 config 裡的那一欄下次存檔就靜默消失（Go omitempty 直接不見）。
	//    凡是 collector 的 AccountConfig 有、而 App 會改到的欄位，兩份必須鏡像。
	RetiringFolders []string `json:"retiring_folders,omitempty"`
	Extractor       string   `json:"extractor,omitempty"`
	GeminiAPIKey    string   `json:"gemini_api_key,omitempty"`
	// PortalSession／PortalSessionExp＝這台電腦對這個知識庫的 portal 登入憑證
	// （arcrun-rag#137 App 啟動器用；App 詳情與動作只有 portal session 那條路有，
	// 見 apps.go 檔頭）。**這是 session token 不是密碼**——密碼仍然零落地。
	//
	// 🔴 這兩欄是 App 端獨有的（collector 的 AccountConfig 沒有）：collector 讀 config
	//    時會忽略不認得的欄位，所以加在這裡是安全的；反過來（collector 有而這裡沒有）
	//    才是上面那條註解講的、會靜默掉欄位的方向。
	PortalSession    string `json:"portal_session,omitempty"`
	PortalSessionExp int64  `json:"portal_session_exp,omitempty"`
}

type directConfig struct {
	Accounts          []accountCfg `json:"accounts,omitempty"`
	WatchFolders      []string     `json:"watch_folders,omitempty"`
	Manifest          string       `json:"manifest"`
	Extractor         string       `json:"extractor,omitempty"`
	ExtractorExplicit bool         `json:"extractor_explicit,omitempty"`
	GeminiAPIKey      string       `json:"gemini_api_key,omitempty"`
	raw               map[string]any
}

// syncStatus 對映 collector 寫的 status.json（只取 UI 要的欄位）。
type syncStatus struct {
	LastSync       string `json:"last_sync,omitempty"`
	ExtractorOK    bool   `json:"extractor_ok"`
	ExtractorError string `json:"extractor_error,omitempty"`
	// 「上次真的有做事」那一輪（2026-08-05）——本輪計數會被下一輪歸零，
	// 只靠它顯示成果，使用者在同步完成 15 秒後就看不到任何證據（leo 實撞）。
	LastActivityAt     string `json:"last_activity_at,omitempty"`
	LastActivityOK     int    `json:"last_activity_ok"`
	LastActivityFailed int    `json:"last_activity_failed"`
	// G-6.2（2026-08-06）：collector 讀不了、因此整個跳過的檔案。
	// 以前這些檔在 scan 的白名單閘就無聲蒸發，使用者只看到「什麼都沒發生」。
	SkippedDocs       []skippedDoc `json:"skipped_docs,omitempty"`
	SkippedDocCount   int          `json:"skipped_doc_count"`
	SkippedOtherCount int          `json:"skipped_other_count"`
	SkippedOtherNames []string     `json:"skipped_other_names"`
	// t210（2026-08-08）：總量進度快照＋無法同步的分類統計——**同一組數字**
	// 供首頁與診斷檔（t213）共用，不再各算各的。兩者的形狀（欄位、JSON tag）
	// 都定義在 collector/progress.go，這裡只是原樣接住 status.json 裡的那一份，
	// 不重新定義結構，避免兩邊的欄位定義漂移。
	Progress         collector.SyncProgress     `json:"progress"`
	FailureBreakdown collector.FailureBreakdown `json:"failure_breakdown"`
	// t215（2026-08-08）：per-account 雲端版本狀態——collector.AccountSyncStatus 已經是
	// GetState 要的形狀（含 t215 新欄位 CloudUpdateKnown/CloudUpdateStale/CloudLatest），
	// 直接原樣接住，不重新定義一份會漂移的結構。key = instanceHostOf(cypher_url)
	// （與 UIAccount.Host 同一套算法，見 shortHost）。
	AccountDetails map[string]collector.AccountSyncStatus `json:"account_details,omitempty"`
	// arcrun-rag#46：「移除並收回中」的資料夾進度（key＝資料夾路徑）。
	// 形狀定義在 collector/sync_status.go，這裡原樣接住不另定義一份會漂移的結構。
	Retiring map[string]collector.RetiringStatus `json:"retiring,omitempty"`
}

type skippedDoc struct {
	Path string `json:"path"`
	Ext  string `json:"ext"`
}

// extLabel 把副檔名翻成使用者認得的東西。
// 使用者不會因為看到「.pages」就懂，但看到「Pages」會——那是他自己按存檔時的名字。
func extLabel(ext string) string {
	switch strings.ToLower(ext) {
	case ".doc":
		return "舊版 Word"
	case ".xls":
		return "舊版 Excel"
	case ".ppt":
		return "舊版 PowerPoint"
	case ".pages":
		return "Pages"
	case ".numbers":
		return "Numbers"
	case ".key":
		return "Keynote"
	case ".odt", ".ods", ".odp":
		return "OpenDocument"
	case ".rtf":
		return "RTF"
	case ".epub":
		return "EPUB"
	case ".msg", ".eml":
		return "郵件檔"
	case ".wpd":
		return "WordPerfect"
	}
	return strings.TrimPrefix(ext, ".")
}

// loadCfg 同時保留原始 map ⇒ 回寫時**不會弄丟我們沒宣告的欄位**
// （config 裡還有 poll_interval_sec、libraries 等，漏寫就等於幫用戶刪設定）。
func loadCfg() (*directConfig, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return &directConfig{raw: map[string]any{}}, err
	}
	c := &directConfig{}
	if err := json.Unmarshal(b, c); err != nil {
		return &directConfig{raw: map[string]any{}}, err
	}
	_ = json.Unmarshal(b, &c.raw)
	// 🔴 自我修復：舊版存出來的 config 可能少了 collector 的必填欄位。
	//    只補進記憶體不夠——collector 讀的是**磁碟上那份**，所以要寫回去。
	if fillRequired(c.raw) {
		if out, err := json.MarshalIndent(c.raw, "", "  "); err == nil {
			_ = os.WriteFile(configPath(), out, 0o600)
		}
		if m, ok := c.raw["manifest"].(string); ok {
			c.Manifest = m
		}
		appLog("設定檔缺必填欄位，已自動補上 manifest=%v", c.raw["manifest"])
	}
	return c, nil
}

// fillRequired 補上 collector 的必填欄位，回報有沒有真的補過。
//
// 🔴 leo 2026-08-06 兩輪教訓：
//
//	第一輪：`saveCfg` 從來不寫 `manifest`（collector 必填）⇒ 全新安裝一啟動就 exit 2。
//	第二輪（**我第一次修錯**）：只在 saveCfg 補 ⇒ **已經存在的壞設定永遠修不好**——
//	  App 開起來只是**讀** config 然後啟動引擎，saveCfg 根本沒被呼叫。
//	  leo 的 v0.18.12 實測仍是同一句「缺必填欄位：manifest」，重試 30 次。
//	  他的 config 剛好只有 saveCfg 寫的那四個鍵 ⇒ 鐵證。
//	⇒ 補必填要在**讀取時**做（升級路徑），存檔時也做（新建路徑），兩條都要。
func fillRequired(raw map[string]any) bool {
	changed := false
	if v, ok := raw["manifest"].(string); !ok || strings.TrimSpace(v) == "" {
		raw["manifest"] = filepath.Join(appDir(), "manifest.json")
		changed = true
	}
	return changed
}

func saveCfg(c *directConfig) error {
	if c.raw == nil {
		c.raw = map[string]any{}
	}
	// 只覆寫我們改過的鍵，其餘原樣保留
	accs, _ := json.Marshal(c.Accounts)
	var accAny any
	_ = json.Unmarshal(accs, &accAny)
	c.raw["accounts"] = accAny
	c.raw["extractor"] = c.Extractor
	c.raw["extractor_explicit"] = c.ExtractorExplicit
	c.raw["gemini_api_key"] = c.GeminiAPIKey
	// 🔴 2026-08-06 leo Windows 封測的真兇：`manifest` 是 collector 的**必填欄位**
	//    （direct.go 的驗證：`if c.Manifest == "" { missing = append(missing, "manifest") }`），
	//    而這支從來沒寫過它 ⇒ **全新安裝的機器**（config 從零長出來）永遠缺這一欄
	//    ⇒ collector 一啟動就 `exit status 2`、supervisor 無限重拉
	//    ⇒ 畫面在「看守中／沒有在跑」之間閃、加資料夾也沒反應。
	//    為什麼開發機沒撞到：leo 的 Mac config 是舊版留下的、早就有這一欄
	//    ——**「我這台好好的」正是這個 bug 能活到封測的原因**。
	fillRequired(c.raw)

	out, err := json.MarshalIndent(c.raw, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(configPath(), out, 0o600)
}

// ── 前端要的資料形狀 ──

type UIFolder struct {
	Path   string `json:"path"`
	AccIdx int    `json:"accIdx"`
	// arcrun-rag#46：這個資料夾已經被移除，正在把雲端的資料收回來。
	Retiring        bool   `json:"retiring,omitempty"`
	RetireRemaining int    `json:"retireRemaining,omitempty"` // 還剩幾筆
	RetireError     string `json:"retireError,omitempty"`     // 失敗真因（原文，不改寫）
}
type UIAccount struct {
	Name    string     `json:"name"`
	Host    string     `json:"host"`
	Folders []UIFolder `json:"folders"`
	// t215（2026-08-08，leo：「在每個知識庫上顯示是否要更新，如果要，加開啓 install 頁的
	// 連結」）——一個使用者可能連著不只一個知識庫，之前只有小幫手自己的版本會提示更新，
	// 每個知識庫各自的雲端版本完全沒有畫面。判準與 portal 版本卡同一套
	// （collector.EvalCloudUpdate，不是 t103 的相容底線），這裡只翻成人話，不重新判斷。
	CloudVerKnown  bool   `json:"cloudVerKnown"`            // false＝查不到（連不上／還沒查過），前端要老實說「查不到」
	CloudVerStale  bool   `json:"cloudVerStale"`            // true＝有新版可更新
	CloudVerMine   string `json:"cloudVerMine,omitempty"`   // 這個知識庫目前的版本（可能連 Known=false 時也有值）
	CloudVerLatest string `json:"cloudVerLatest,omitempty"` // 已知的最新版
	Email          string `json:"email,omitempty"`          // 供「前往安裝頁更新」預填帳號（同 portal 版本卡的做法）
}
type UIState struct {
	Version   string      `json:"version"`
	StatusBig string      `json:"statusBig"`
	StatusSub string      `json:"statusSub"`
	Syncing   bool        `json:"syncing"`
	Accounts  []UIAccount `json:"accounts"`
	Engine    string      `json:"engine"`    // "workers-ai" | "gemma"
	GeminiKey string      `json:"geminiKey"` // 只回遮罩，不回真值
	Steps     []Step      `json:"steps"`     // 首頁狀態時間軸（leo #6）
	Skipped   *UISkipped  `json:"skipped"`   // 讀不了的檔（沒有就是 null，前端不畫）
	// EngineTrouble＝同步引擎有問題（沒在跑／一直啟動失敗）⇒ 前端才長出「回報問題」卡。
	// 沒事時不顯示，避免把「哪裡看 log」變成常駐噪音。
	EngineTrouble bool       `json:"engineTrouble"`
	Progress      UIProgress `json:"progress"` // 首頁「你的檔案」那行（t210）
	LogFolder     string     `json:"logFolder"`
	// Quota＝「今天的 AI 額度用完了」那張卡（P8，2026-08-09）。
	//
	// 🔴 存在理由：collector 這半（quota.go）2026-08-07 就把 leo 定的三句話
	// （成就／出口／保證）寫進 status.json 的 quota_message 了，但 App 端從來沒接——
	// 使用者撞到額度時只看得到「送不上去 N 份」，正是封測者 Evan 把額度用完
	// 讀成「這個 AI 沒效」的那個黑箱（歸錯因、罵錯對象）。
	// 這裡原樣接住 collector 組好的三句話，不重新組字串（避免措辭漂移）。
	// nil＝現在不在額度冷卻中，前端不畫這張卡。
	Quota *collector.QuotaNotice `json:"quota"`
}

// UISkipped＝首頁那張「這些檔案現在還處理不了」的卡。
//
// 🔴 存在理由（J-1/S6 考題 G-6.2）：
//
//	「Given 我丟進去的是 PDF 或 Word／When 我搜它的內容／
//	  Then 我一樣找得到——**或當場被告知這種檔案還不支援**，不准安靜地略過。」
//
// 後半句在這裡兌現。文字一律白話：講「你的哪個檔沒進去」「你要不要做什麼」，
// 不講 allowedExt、副檔名白名單、extractor 這些系統內部詞。
type UISkipped struct {
	Title string   `json:"title"` // 「有 3 個檔案現在還讀不了」
	Note  string   `json:"note"`  // 該不該做什麼——這裡的答案是「不用，之後會自動補上」
	Files []string `json:"files"` // 「舊版報告.doc（舊版 Word）」
	More  int      `json:"more"`  // 沒列出來的還有幾個
	Other string   `json:"other"` // 非文件檔的一行說明（沒有就空字串）
}

// UIProgress＝首頁「你的檔案」那張卡（t210，2026-08-08，取代 08-06 的逐檔白話翻譯）。
//
// 🔴 存在理由（leo 轉述封測者 Evan 08-08 原話）：「我有 9000 個檔，雲端只有 101 張卡，
// 畫面卻說『20 份沒送進知識庫』——這幾個數字到底是怎麼回事？是壞了嗎？還是繼續在跑？」
// ⇒ 首頁要能一次講完「你有幾份、我做完幾份、剩下幾份會自動接著做」，
//
//	單位一律是「份檔案」，Total/Done/Pending/CantSync 四個數字相加要等於 Total
//	（leo 08-08 驗法①，源頭不變式見 collector/progress.go）。
//
// 🔴 leo 08-08 追加約束（t214 預留）：**分類判斷只住在 collector/progress.go 的
// ClassifyFailure 一個接縫**——這裡與前端 main.js 都不准認得任何一個分類名稱字串，
// Groups 原樣照後端給的 category/count 陣列畫，順序也照後端給的（FailCategories）。
// 之後把分類改成資料驅動時，才只需要動那一個檔。
type UIProgress struct {
	Total    int           `json:"total"`    // 你的檔案，共幾份
	Done     int           `json:"done"`     // 已送上去
	Pending  int           `json:"pending"`  // 排隊中（會自動接著做）
	CantSync int           `json:"cantSync"` // 送不上去（=卡住＋讀不了，預設摺疊，展開看 Groups）
	Groups   []UIFailGroup `json:"groups"`   // 「送不上去」展開後的分類統計；沒有就是空陣列
}

// UIFailGroup＝一個分類與它的份數，逐字接住 collector.FailureGroup（不重新判斷）。
type UIFailGroup struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// buildProgress 把 collector 已經算好的 SyncProgress／FailureBreakdown
// 轉成前端要的形狀——只搬資料，不重新判斷任何分類。
func buildProgress(s syncStatus) UIProgress {
	p := s.Progress
	u := UIProgress{
		Total:    p.Total,
		Done:     p.Done,
		Pending:  p.Pending,
		CantSync: p.Stuck + p.Unreadable,
	}
	for _, g := range s.FailureBreakdown.Groups {
		u.Groups = append(u.Groups, UIFailGroup{Category: g.Category, Count: g.Count})
	}
	return u
}

// pickQuotaNotice 從 status.json 的 per-account 狀態裡挑出「現在還有效」的額度三句話。
//
// 有效＝ResumeAt 還沒到：collector 每輪重建 AccountSyncStatus，冷卻過了自然不再寫
// quota_message，但 daemon 若整夜沒跑（電腦闔蓋），status.json 會停在昨天的快照——
// 額度其實已經恢復了，這時再顯示「明天早上 8 點恢復」就是在說謊，所以以 ResumeAt 判生死。
// 多帳號同時冷卻時挑最早恢復的那份（key 排序保證同一份輸入永遠同一個輸出，好測試）。
func pickQuotaNotice(s syncStatus, now time.Time) *collector.QuotaNotice {
	keys := make([]string, 0, len(s.AccountDetails))
	for k := range s.AccountDetails {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var best *collector.QuotaNotice
	var bestAt time.Time
	for _, k := range keys {
		q := s.AccountDetails[k].QuotaMessage
		if q == nil {
			continue
		}
		at, err := time.Parse(time.RFC3339, q.ResumeAt)
		if err != nil || !at.After(now) {
			continue // 解析不了或已恢復 ⇒ 過期快照，不畫（下一輪 collector 會清掉）
		}
		if best == nil || at.Before(bestAt) {
			best, bestAt = q, at
		}
	}
	return best
}

// buildSkipped 把 status.json 的三個欄位翻成首頁看得懂的一張卡。
// 完全沒有東西被略過時回 nil ⇒ 前端不畫這張卡（沒事就別佔畫面）。
func buildSkipped(s syncStatus) *UISkipped {
	if s.SkippedDocCount == 0 && s.SkippedOtherCount == 0 {
		return nil
	}
	u := &UISkipped{}
	for _, d := range s.SkippedDocs {
		u.Files = append(u.Files, fmt.Sprintf("%s（%s）", filepath.Base(d.Path), extLabel(d.Ext)))
	}
	if n := s.SkippedDocCount - len(s.SkippedDocs); n > 0 {
		u.More = n
	}
	if s.SkippedDocCount > 0 {
		u.Title = fmt.Sprintf("有 %d 個檔案現在還讀不了", s.SkippedDocCount)
		// 誠實地告訴他「這不是你的錯，也不用你動手」——否則使用者會反覆重丟同一個檔。
		u.Note = "這些格式我們還沒支援，所以沒有進你的知識庫。等支援了會自動補上，你不用重丟。" +
			"急著要的話，先用原本的軟體另存成 PDF 或 Word（.docx）放進同一個資料夾就行。"
		// 兩種都有時，非文件檔那句用「另外」接在讀不了的檔之後（見下）。
		if s.SkippedOtherCount > 0 {
			u.Other = fmt.Sprintf("另外有 %d 個不是文件的檔案（圖片、影片、壓縮檔之類）也沒有處理。",
				s.SkippedOtherCount)
		}
	} else {
		// 只有非文件檔的情況（例如整個資料夾都是照片）——不需要驚動他，但也不能不說。
		//
		// 🔴 2026-08-06 leo 封測截圖：這張卡長成
		//      「看起來不是文件，所以跳過了。」（底下空的）
		//      「**另外**有 1 個不是文件的檔案（圖片、影片、壓縮檔之類）也沒有處理。」
		//    兩個病：① 同一件事講兩次 ② 「另外」前面沒有東西可以「另外」——
		//    因為 Files 是空的（非文件檔不逐檔點名），通用句下面什麼都沒有。
		//    ⇒ 這個分支**只講一句**，把數量與例子併進來，且不留 Other。
		u.Title = fmt.Sprintf("有 %d 個檔案沒有被整理", s.SkippedOtherCount)
		u.Note = "看起來不是文件（圖片、影片、壓縮檔之類），所以跳過了。這是正常的，你不用做什麼。"
		// 🔴 少量時把檔名列出來（leo 08-06 封測）：封測者放了 .md 進去說「無法通過」，
		//    而畫面只寫「有 1 個不是文件的檔案」——沒說是哪一個，誰都判斷不出發生什麼事。
		//    `.md` 明明在支援清單裡 ⇒ 看到檔名才知道真相（副檔名被 Windows 藏起來、存錯格式…）。
		u.Files = append(u.Files, s.SkippedOtherNames...)
		if n := s.SkippedOtherCount - len(s.SkippedOtherNames); n > 0 {
			u.More = n
		}
	}
	return u
}

// Step 是首頁狀態時間軸的一格。
// 🔴 leo 08-04：「首頁要顯示的應該是 status，如果**看守、發現變化、萃取、上傳…
//
//	不同 status 在哪裡顯示**？」
//
// ⇒ 把一輪同步拆成四步，讓使用者看得到「現在走到哪」，而不是只有一句「看守中」。
type Step struct {
	Title string `json:"title"`
	Meta  string `json:"meta,omitempty"`
	State string `json:"state"` // "done"（已完成）｜"now"（進行中）｜""（還沒輪到）
}

// buildSteps 依 status.json 與訊號檔推出四步的狀態。
// 誠實邊界：collector 目前回報的是「整輪」而非逐檔階段，所以同步中時
// 「發現變化→萃取→上傳」一起標進行中；不假裝有更細的進度。
func buildSteps(s syncStatus, syncing bool) []Step {
	watch := Step{Title: "看守資料夾", Meta: "有變動就自動開始", State: "done"}
	if syncing {
		return []Step{
			watch,
			{Title: "發現變化", State: "done"},
			{Title: "用 AI 整理成知識卡", Meta: "進行中", State: "now"},
			{Title: "上傳到你的知識庫", State: ""},
		}
	}
	// 🔴 2026-08-05：這三步以前只要「跑過任何一輪」（LastSync 非空）就全標綠，
	// 而 meta 用的是**本輪**計數（下一輪歸零）⇒ 綠燈與實際進度脫鉤、數字又永遠空白，
	// 正是 leo 說的「都顯示綠燈沒動，實際上已經做完了」。
	// ⇒ 綠燈只在「真的有整理過東西」時才亮，且亮的是上次有產出那輪的數字＋時間。
	done := ""
	if s.LastActivityOK > 0 || s.LastActivityFailed > 0 {
		done = "done"
	}
	found := "等待中"
	if done != "" {
		if t, err := time.Parse(time.RFC3339, s.LastActivityAt); err == nil {
			found = "上次 " + t.Local().Format("15:04")
		} else {
			found = "已處理"
		}
	}
	meta := ""
	if s.LastActivityOK > 0 {
		meta = fmt.Sprintf("上次 %d 份", s.LastActivityOK)
	}
	up := Step{Title: "上傳到你的知識庫", Meta: meta, State: done}
	if s.LastActivityFailed > 0 {
		up.Meta = strings.TrimPrefix(fmt.Sprintf("%s · ⚠ %d 份失敗", meta, s.LastActivityFailed), " · ")
	}
	return []Step{
		watch,
		{Title: "發現變化", Meta: found, State: done},
		{Title: "用 AI 整理成知識卡", State: done},
		up,
	}
}

// GetState 是前端每秒拉一次的單一入口。
func (a *App) GetState() UIState {
	st := UIState{Version: version}
	cfg, _ := loadCfg()

	// 預設庫的實體資料夾若已經被使用者刪掉，把 config 裡的殘留引用清掉——
	// 不留幽靈資料、也不會讓 collector 每輪都對著不存在的資料夾報錯（見 default_library.go）。
	// 資料夾本身「會不會長回來」由 seedDefaultLibraryIfFirstEver 的 marker 檔擋住，這裡不會重種。
	if pruneMissingDefaultLibrary(cfg) {
		if err := saveCfg(cfg); err != nil {
			appLog("清理已刪除的預設庫引用失敗：%v", err)
		} else {
			restartWatch()
		}
	}

	sync := loadSyncStatus()

	// arcrun-rag#46：collector 說收乾淨了的資料夾，這裡才真的從設定裡消失
	// （App 是 config.json 的唯一寫入者，見 pruneFinishedRetirements）。
	if pruneFinishedRetirements(cfg, sync) {
		if err := saveCfg(cfg); err != nil {
			appLog("清理已收回的資料夾失敗：%v", err)
		} else {
			restartWatch()
		}
	}

	for i, acc := range cfg.Accounts {
		ui := UIAccount{Name: accountName(acc), Host: shortHost(acc.CypherURL), Email: acc.Email}
		for _, f := range acc.WatchFolders {
			ui.Folders = append(ui.Folders, UIFolder{Path: f, AccIdx: i})
		}
		// 收回中的資料夾照樣列出來，只是標成「收回中」——不然按下移除之後它立刻消失，
		// 使用者無從知道撤除還在跑、更看不到失敗的原因（那正是這張票的病的另一面）。
		for _, f := range acc.RetiringFolders {
			uf := UIFolder{Path: f, AccIdx: i, Retiring: true}
			if st, ok := sync.Retiring[f]; ok {
				uf.RetireRemaining = st.Remaining
				uf.RetireError = st.LastError
			}
			ui.Folders = append(ui.Folders, uf)
		}
		// t215：per-account 雲端版本狀態——key 與 Host 同一套算法（shortHost），
		// 對應 collector 寫入 status.json 時用的 instanceHostOf（兩者對一般 https URL 同值）。
		if accSt, ok := sync.AccountDetails[ui.Host]; ok {
			ui.CloudVerKnown = accSt.CloudUpdateKnown
			ui.CloudVerStale = accSt.CloudUpdateStale
			ui.CloudVerMine = accSt.CloudVersion
			ui.CloudVerLatest = accSt.CloudLatest
		}
		st.Accounts = append(st.Accounts, ui)
	}

	st.Engine = cfg.Extractor
	if !cfg.ExtractorExplicit || st.Engine == "" {
		st.Engine = "workers-ai" // 與 direct.go 的預設判準一致
	}
	if strings.TrimSpace(cfg.GeminiAPIKey) != "" {
		st.GeminiKey = "••••••••"
	}

	st.Syncing, st.StatusBig, st.StatusSub = describeStatus(sync)
	st.Steps = buildSteps(sync, st.Syncing)
	st.Skipped = buildSkipped(sync)
	st.Progress = buildProgress(sync)
	st.Quota = pickQuotaNotice(sync, time.Now()) // P8：額度冷卻中 ⇒ 首頁畫三句話卡
	// 引擎有問題才把「回報問題」卡叫出來（含記錄檔路徑）。
	// 沒事時不顯示——否則「哪裡看 log」會變成常駐噪音，真出事時反而沒人看。
	st.EngineTrouble = !collectorAlive()
	st.LogFolder = appDir()
	return st
}

func loadSyncStatus() syncStatus {
	var s syncStatus
	if b, err := os.ReadFile(statusPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

// describeStatus 產生狀態文案。
// 🔴 t195（leo 08-05 實撞：「燈號是真的還是假的？」——**是假的**）：
//
//	舊版只看「sync-now 訊號檔存不存在」就顯示「同步中…」。
//	但那只代表**排隊了**，不代表有人在處理：leo 的 collector 在 11:25 死掉，
//	他 11:38 按同步 ⇒ 訊號檔沒人消化 ⇒ 畫面一直說「正在整理知識卡」，
//	實際上 13 分鐘沒跑過任何一輪、也不會產卡。**這比沒有燈號更糟——它在說謊。**
//
//	⇒ 燈號改成有憑有據：
//	  · collector 沒在跑 → 明說「同步引擎沒有在跑」，不要假裝在整理
//	  · 有訊號檔且引擎活著 → 才是真的「同步中」
//	  · 其餘 → 看守中
//
// 🔴 2026-08-05 第二修（leo：「拖新檔進資料夾…自始至終都顯示『等待中』，
//
//	實際上已經做完了，這個 status 是壞的」）——t195 只補了「引擎活著」那半，
//	「同步中」仍靠 sync-now 訊號檔判斷，那是錯的判準，兩個理由：
//	  ① 訊號檔**只有手動按「立刻同步」才會產生**；leo 這次是拖檔進資料夾
//	     （自動觸發），整輪從頭到尾沒有訊號檔 ⇒ 畫面永遠停在「看守中／等待中」。
//	  ② 就算是手動按的，collector 是**先刪檔再跑**（consumeSyncNowSignal），
//	     所以真正在跑的那段時間訊號檔早就不見了。
//	⇒ 改用 t191 已經做好的機制：collector 開工印 phase:"start"、跑完印 "done"，
//	  supervisor 據此維護 StateSyncing（supervisor.go）。**那條線本來就在，
//	  Wails 版換代時沒接上而已**——不要再自己發明第三種判斷法。
func describeStatus(s syncStatus) (syncing bool, big, sub string) {
	// 🔴 一直啟動失敗（crash loop）要**優先**判，而且不受 collectorAlive 影響——
	//    重起過程中狀態會短暫變成 Starting（alive=true），若照順序判就會與
	//    「沒有在跑」交替出現 ⇒ 就是 leo 08-06 在 Windows ARM 看到的閃爍。
	//    這裡讓失敗訊息**黏住**，畫面才會穩定，也才說得出死因。
	if msg, n, looping := collectorFailure(); looping {
		sub := fmt.Sprintf("已自動重試 %d 次都失敗，所以重新開啟也沒有用。", n)
		if msg != "" {
			sub += "原因：" + msg
		} else {
			sub += "詳細訊息請看記錄檔 app.log。"
		}
		return false, "同步引擎一直啟動失敗", sub
	}
	if !collectorAlive() {
		msg, n, _ := collectorFailure()
		// 🔴 2026-08-06：以前這裡寫「請結束 Arcrun 再重新開啟」——
		//    那是**把系統的無能推給使用者**（真正該做的是自己啟動，已在 restartWatch 修）。
		//    留這句當保底文案時也不要叫人重開，而是說「正在啟動」——
		//    因為修完之後，唯一還會短暫看到這個狀態的時機就是剛啟動那幾秒。
		sub := "正在啟動同步引擎，請稍候…"
		if c, err := loadCfg(); err != nil || len(c.Accounts) == 0 {
			sub = "還沒連上知識庫 ⇒ 按「新增知識庫帳號」就會開始"
		}
		if msg != "" {
			sub = fmt.Sprintf("原因：%s（已重試 %d 次）", msg, n)
		}
		return false, "同步引擎沒有在跑", sub
	}
	if collectorSyncing() {
		return true, "同步中… 正在讀檔並整理成知識卡", "請稍候，完成後會顯示整理了幾份"
	}
	if s.ExtractorError != "" && !s.ExtractorOK {
		return false, "需要你處理一下", "⚠ " + s.ExtractorError
	}
	parts := []string{}
	if t, err := time.Parse(time.RFC3339, s.LastSync); err == nil {
		parts = append(parts, "上次檢查 "+t.Local().Format("15:04"))
	}
	// 用「上次真的有做事」那輪的數字，不用本輪計數——後者每輪歸零，
	// 會讓剛整理完的成果在十幾秒後從畫面上消失（就是 leo 撞到的那個「壞掉的 status」）。
	if s.LastActivityOK > 0 || s.LastActivityFailed > 0 {
		when := ""
		if t, err := time.Parse(time.RFC3339, s.LastActivityAt); err == nil {
			when = t.Local().Format("15:04") + " "
		}
		if s.LastActivityOK > 0 {
			parts = append(parts, fmt.Sprintf("%s已整理 %d 份", when, s.LastActivityOK))
		}
		if s.LastActivityFailed > 0 {
			parts = append(parts, fmt.Sprintf("⚠ %d 份失敗", s.LastActivityFailed))
		}
	}
	if len(parts) == 0 {
		return false, "看守中 · 資料夾有變動就會自動整理", "還沒有同步紀錄"
	}
	return false, "看守中 · 資料夾有變動就會自動整理", strings.Join(parts, " · ")
}

func accountName(a accountCfg) string {
	if s := strings.TrimSpace(a.InstanceName); s != "" {
		return s
	}
	if s := strings.TrimSpace(a.Email); s != "" {
		return s
	}
	return shortHost(a.CypherURL)
}

func shortHost(u string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	return strings.TrimSuffix(strings.SplitN(s, "/", 2)[0], "/")
}

// ── 動作（前端按鈕直接呼叫）──

// SyncNow 寫訊號檔讓 collector 立刻跑一輪（沿用 t98 的機制，不新增 IPC）。
func (a *App) SyncNow() error {
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(syncNowSignal(), []byte{}, 0o644)
}

// PickFolder 用**系統原生**資料夾選擇器。
// 🔴 這是換 Wails 的另一個實質好處（D-daemon-UI 已記）：macOS 的 powerbox 機制
// 會在使用者用原生面板選資料夾時**自動授予該資料夾存取權**；fyne 自繪的 picker 拿不到。
// 未來要上 Mac App Store 或開沙箱時，原生 picker 是硬需求。
func (a *App) PickFolder() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "選一個要自動整理的資料夾",
	})
}

func (a *App) AddFolder(accIdx int, path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	cfg, err := loadCfg()
	if err != nil {
		return err
	}
	if accIdx < 0 || accIdx >= len(cfg.Accounts) {
		return fmt.Errorf("找不到這個知識庫帳號")
	}
	for _, f := range cfg.Accounts[accIdx].WatchFolders {
		if f == path {
			return nil // 已經在看守了，不重複加
		}
	}
	// arcrun-rag#46：正在收回中的資料夾不能同時又加回來看守——那會變成
	// 「一邊撤除、一邊重新上傳同一批檔」，兩條路互相打架，結果不可預測。
	// 擋一次比事後對帳容易解釋，訊息要告訴使用者現在是什麼狀況、該怎麼辦。
	for _, f := range cfg.Accounts[accIdx].RetiringFolders {
		if f == path {
			return fmt.Errorf("這個資料夾正在從雲端收回資料，等它收完再加回來（可在畫面上看到進度）")
		}
	}
	cfg.Accounts[accIdx].WatchFolders = append(cfg.Accounts[accIdx].WatchFolders, path)
	sort.Strings(cfg.Accounts[accIdx].WatchFolders)
	if err := saveCfg(cfg); err != nil {
		return err
	}
	restartWatch() // 立刻生效，不必等下一輪
	return nil
}

// RemoveFolder 把資料夾從清單移除。
//
// 🔴 arcrun-rag#46（leo 2026-08-16 實撞）：「我去把 Logseq plugin 刪掉以後，
//
//	**採集的 wiki 沒消失**。」——移除之後那個資料夾的內容在雲端一筆都沒少，
//	照樣搜得到、照樣是已嵌入狀態、AI 照樣拿它回答。
//
// 真兇：這支函式原本只做三件事（從 WatchFolders 拿掉、存檔、重啟看守），
// **一次都沒碰撤除**。撤除的能力本身是好的、有測試、也真的被部署，只是
// 「整個資料夾從清單移除」這條路從來不呼叫它——
// **在使用者眼裡是同一件事（我不要這份資料了），在程式裡是兩條完全不同的路。**
//
// takedown＝使用者在對話框上明確選的那一個：
//   - true ：連同雲端已經整理好的知識一起收回（資料夾搬進 retiring_folders，
//     由 collector 逐筆撤除；進度與失敗原因走 status.json 回到畫面）
//   - false：只停止同步，雲端保留（＝這支函式原本的行為）
//
// 為什麼做成使用者選、而不是我們替他決定：兩種都是合理的需求（換電腦／重整資料夾
// vs 我不要這份資料了），而**猜錯任何一邊都是不可逆的**——猜「保留」則產品承諾的
// 「資料所有權完全屬於使用者」是假的；猜「收回」則整理好的知識被誤刪。
// ⇒ 在動作的當下把兩個後果講清楚、讓他自己挑（見前端 confirmRemove 的文案）。
func (a *App) RemoveFolder(accIdx int, path string, takedown bool) error {
	cfg, err := loadCfg()
	if err != nil {
		return err
	}
	if accIdx < 0 || accIdx >= len(cfg.Accounts) {
		return fmt.Errorf("找不到這個知識庫帳號")
	}
	keep := []string{}
	found := false
	for _, f := range cfg.Accounts[accIdx].WatchFolders {
		if f != path {
			keep = append(keep, f)
		} else {
			found = true
		}
	}
	cfg.Accounts[accIdx].WatchFolders = keep
	if takedown && found {
		// 只在「本來真的在看守」時排撤除——否則重複按會排出一堆重複待辦。
		already := false
		for _, f := range cfg.Accounts[accIdx].RetiringFolders {
			if f == path {
				already = true
			}
		}
		if !already {
			cfg.Accounts[accIdx].RetiringFolders = append(cfg.Accounts[accIdx].RetiringFolders, path)
		}
	}
	if err := saveCfg(cfg); err != nil {
		return err
	}
	restartWatch()
	if takedown {
		// 不必等下一輪輪詢——使用者剛按下按鈕，他期待「現在就開始」。
		// 沿用既有的 sync-now 訊號檔，不新發明一套 IPC。
		_ = a.SyncNow()
	}
	return nil
}

// pruneFinishedRetirements 把「collector 已回報收乾淨」的資料夾從設定裡清掉。
//
// 為什麼由 App 清而不是 collector 自己清：config.json 的寫入者只有 App 一個，
// 兩個行程都寫同一個檔＝互相蓋掉對方的設定（t108 那類靜默掉欄位的病的另一種形狀）。
// collector 只在 status.json 說「這個根收乾淨了」，且**每輪都照現況重說**
// （level-triggered）——App 關著沒看到也不會卡住，下次開起來照樣清得掉。
func pruneFinishedRetirements(cfg *directConfig, sync syncStatus) bool {
	changed := false
	for i := range cfg.Accounts {
		keep := cfg.Accounts[i].RetiringFolders[:0:0]
		for _, f := range cfg.Accounts[i].RetiringFolders {
			if st, ok := sync.Retiring[f]; ok && st.Done {
				changed = true
				continue
			}
			keep = append(keep, f)
		}
		if len(keep) != len(cfg.Accounts[i].RetiringFolders) {
			cfg.Accounts[i].RetiringFolders = keep
		}
	}
	return changed
}

// SetAI 存 AI 設定。
// 🔴 t190：金鑰**無條件以輸入框為準**（清空＝刪除）——leo 實撞過「金鑰刪不掉」。
func (a *App) SetAI(useGemini bool, key string) error {
	cfg, err := loadCfg()
	if err != nil {
		return err
	}
	engine := "workers-ai"
	if useGemini {
		engine = "gemma"
		if strings.TrimSpace(key) == "" {
			return fmt.Errorf("選了 Gemini 就要貼上金鑰；不想申請的話請改選「雲端 AI」")
		}
	}
	cfg.Extractor = engine
	cfg.ExtractorExplicit = true
	cfg.GeminiAPIKey = key
	for i := range cfg.Accounts {
		cfg.Accounts[i].Extractor = engine
		cfg.Accounts[i].GeminiAPIKey = key
	}
	if err := saveCfg(cfg); err != nil {
		return err
	}
	restartWatch()
	return nil
}

// OpenURL 用系統瀏覽器開網址（下載頁／說明文件）。
func (a *App) OpenURL(u string) { runtime.BrowserOpenURL(a.ctx, u) }

// OpenLogFolder 在檔案總管／Finder 裡打開記錄檔資料夾。
//
// 🔴 leo 2026-08-06：「不能用一個 debug mode，就是它會把 log 寫在一個檔案？」
//
//	答：**log 一直都有寫**（`~/.arcrun-rag/` 下的 collector.log 與 app.log，
//	collector 的 stderr 也以 `[stderr]` 開頭落在裡面）。
//	缺的不是「有沒有寫」，是**使用者找不到**——出事時他只看得到畫面上那句話，
//	沒有任何入口把他帶到檔案。這次 Windows 事故就卡在這：真正的死因
//	（config 缺 manifest）一直躺在 collector.log 裡，沒人看得到。
//	⇒ 不做「debug mode 開關」（多一個要教使用者的東西），而是**永遠寫、一鍵打開**。
func (a *App) OpenLogFolder() error {
	dir := appDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	switch runtime2.GOOS {
	case "windows":
		// explorer 開啟後回傳非 0 是常態（它不等視窗關閉），所以不看 error。
		_ = exec.Command("explorer", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
	return nil
}

// LogFolderPath 給畫面顯示用（讓使用者就算按鈕失效也知道去哪找）。
func (a *App) LogFolderPath() string { return appDir() }

// ── 托盤會呼叫的兩個動作（t194）──

// ShowWindow 把主視窗叫出來並帶到前景。
// 🔴 leo 2026-08-05：「**點擊托盤的 icon 就立刻展開界面**」
// ⇒ 左鍵不彈選單、直接開窗（Google Drive 的行為）。
func (a *App) ShowWindow() {
	// 🔴 leo 實測③：「第一次點擊可以開啟，然後再點擊托盤就**不再跳出**」。
	//    真兇有二：(a) 選單建了 ⇒ 滑鼠事件失效（見 setupTray 的 SetMenuNil）
	//              (b) 視窗其實還在、只是被蓋住或最小化 ⇒ 只呼叫 WindowShow 沒有效果。
	//    ⇒ 三個都做：取消最小化、顯示、**強制帶到最前面**。
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	runtime.WindowSetAlwaysOnTop(a.ctx, false) // 只用來搶焦點，不真的釘在最上層
}

// Quit 真的結束程式（＝停止看守）。只有托盤右鍵那一項會呼叫。
//
// 🔴 leo 實測④：「**用強制結束把它關掉才能測試**」——代表沒有一條正常的結束路徑。
//
//	這裡先停掉 collector 子行程再關 App，否則子行程會變孤兒繼續跑。
func (a *App) Quit() {
	// 🔴 2026-08-06：先舉旗再喊退。沒有這一步，OnBeforeClose 會把 runtime.Quit()
	//    當成「按 ×」攔下來（Wails frontend.go:364 兩者共用同一個回呼）
	//    ⇒ leo 實撞：托盤右鍵「結束 Arcrun」點了沒反應，只能強制結束，
	//      導致下載的新版覆蓋不掉還活著的舊版。
	beginQuit()
	stopSupervisor()
	runtime.Quit(a.ctx)
}
