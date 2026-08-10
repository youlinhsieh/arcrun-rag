package main

// diagnostics_export.go — 檢修孔的 daemon 端（t213 phase 2，InkStoneCo 總管交辦，2026-08-08）。
//
// 為什麼要在這裡做，不在雲端 portal 網頁做（phase 1 調查結論）：
// 舊的「匯出診斷檔給我們看」按鈕住在雲端 RAG Portal 網頁（matrix/arcrun 的
// GET /portal/data/diagnostics），在封測者的**瀏覽器**裡執行；而封測者電腦上跑的
// daemon（本檔所在的 arcrun-app）是完全獨立的另一個行程，瀏覽器對本機檔案系統零
// 存取權——那顆按鈕不管加多少雲端欄位都構不到本機資料。本檔把按鈕搬到 daemon
// 行程本體，本機這半直接讀 status.json，雲端那半改打新增的 X-Arcrun-API-Key 版
// 端點（GET /portal/daemon/diagnostics，免帳密，daemon 背景行程沒有 portal session）。
//
// 🔴 leo 08-08 四條追加規則：
//   ① 首頁與診斷檔必須是同一組數字——本檔**只讀** status.json 裡 t210 已經算好的
//      Progress／FailureBreakdown，不重新掃 manifest、不另算一套。
//   ② 分類名稱字串只准住在 collector/progress.go 的 ClassifyFailure——本檔原樣照抄
//      FailureBreakdown.Groups，不認得任何一個分類名（呼應 app.go buildProgress 的規矩）。
//   ③ 失敗檔名只出 basename，不出完整路徑（完整路徑會洩漏使用者的資料夾結構）——
//      沿用首頁既有的 buildSkipped()：它的 Files 欄位本來就是 filepath.Base()+白話標籤，
//      不是原始路徑，這裡直接借用，不重寫第二套。
//   ④（t213 phase 4，08-08 補）engine.detail／engine.last_error 一樣不准出現本機絕對
//      路徑——同③的理由，只是這次的路徑來源是 supervisor 捕到的 stderr 末行（collector
//      啟動時印的「監看 <資料夾路徑>」那行），不是檔名。做法見 redactLocalPaths()：換成
//      「…/<路徑最後一截>」，不是整句吃掉——「引擎沒在跑、以及為什麼」仍要答得出來。
import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	collector "arcrun-rag/collector"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// diagnosticsHTTP：雲端這半只是一次 GET（只讀查詢，不佔 KV/D1 寫入額度），
// 15s 逾時給雲端冷啟動/LLM 相關端點的餘裕（比照 extract_workersai.go 的精神，
// 但這支端點不碰 AI，通常遠快於此，逾時值只是保底）。
var diagnosticsHTTP = &http.Client{Timeout: 15 * time.Second}

// localDiagnostics＝地端這半：daemon 版本／自我更新狀態＋t210 已算好的總量進度／
// 失敗分類＋讀不了的檔案樣本（basename）＋t213 phase 3 補的 Engine（Q2 缺口）。
type localDiagnostics struct {
	DaemonVersion    string                     `json:"daemon_version"`
	UpdateCheck      UpdateInfo                 `json:"update_check"`      // 現查現答（Q4：Mac 卡在舊版）
	Engine           engineDiagnostics          `json:"engine"`            // t213 phase 3（Q2：還在不在跑）
	Progress         collector.SyncProgress     `json:"progress"`          // 同首頁（Q2 的分母：Total）
	FailureBreakdown collector.FailureBreakdown `json:"failure_breakdown"` // 同首頁（Q3：分類統計）
	// SkippedSample／SkippedMore＝格式讀不了、根本沒進 manifest 的檔案樣本，
	// 沿用 buildSkipped() 既有邏輯（basename＋白話格式標籤，如「舊版報告.doc（舊版 Word）」）；
	// 沒有東西被略過時兩者都是零值，JSON 省略。
	SkippedSample []string `json:"skipped_sample,omitempty"`
	SkippedMore   int      `json:"skipped_more,omitempty"`
}

// engineDiagnostics 回答「這台機器現在到底還有沒有在動」
// （t213 phase 3，2026-08-08 補考卷 Q2 缺口：封測者 Evan 原話「是壞了嗎？還是繼續在跑？」——
// 舊版診斷檔看得到 pending=0，卻分不出「真的做完了」還是「daemon 早就掛了沒人知道」，
// 因為完全沒有任何時間資訊。）
//
// 🔴 不發明第二套判斷法：Alive／Syncing／CrashLooping／Restarts／LastError／Headline／Detail
// 直接借用 supervise.go 既有的 collectorAlive()／collectorSyncing()／collectorFailure()，
// 以及 app.go 首頁狀態列用的 describeStatus()——同一套憑據，這裡只是把它們也寫進 JSON，
// 確保首頁與診斷檔永遠是同一組真相（leo 08-08 紅線①），不是另外重新猜一套「活著嗎」。
type engineDiagnostics struct {
	Alive        bool   `json:"alive"`                // 同步引擎子行程現在活著嗎（supervisor 狀態機，非 pgrep，見 supervise.go collectorAlive() 註解）
	Syncing      bool   `json:"syncing"`              // 這一刻正在跑一輪嗎
	CrashLooping bool   `json:"crash_looping"`        // 一直啟動失敗（≥3 次重試都失敗，見 crashLoopThreshold）
	Restarts     int    `json:"restarts"`             // 累計重試次數
	LastError    string `json:"last_error,omitempty"` // 最近一次啟動失敗的原因
	Headline     string `json:"headline"`             // 同首頁大字，例如「同步引擎沒有在跑」
	Detail       string `json:"detail,omitempty"`     // 同首頁小字

	// LastSync＝最近一輪「心跳」完成時間（RFC3339）。這是每一輪（預設每 5 秒）**不論那輪
	// 有沒有事做都會寫**的欄位（見 collector/direct.go RunDirectOnce 尾端），所以它是心跳，
	// 不是「上次同步到東西」的時間。
	// LastActivityAt＝最近一輪「真的有產出」（成功或失敗都算）的時間，同首頁「已整理 N 份」
	// 那個時間戳（見 collector/sync_status.go CarryForwardActivity）。
	//
	// ⇒ pending=0 但 last_sync 是很久以前 ⇒ 不是「做完了」，是「心跳停了」；
	//    last_sync 很新但 alive=false ⇒ daemon 這一刻已死，last_sync 是死前最後一口氣。
	LastSync             string `json:"last_sync,omitempty"`
	LastActivityAt       string `json:"last_activity_at,omitempty"`
	SecondsSinceLastSync *int64 `json:"seconds_since_last_sync,omitempty"` // generated_at 減 last_sync 的秒數；從沒同步過時省略（不假裝有數字）
}

// accountDiagnostics＝一個雲端帳號（知識庫實例）的雲端那半。
// Cloud 拿不到時填 CloudError（誠實回報，不假裝有數字）——常見原因：舊版雲端沒有
// /portal/daemon/diagnostics（部署還沒到）、網路不通、api key 尚未設定。
type accountDiagnostics struct {
	InstanceName string         `json:"instance_name"`
	Host         string         `json:"host"`
	Cloud        map[string]any `json:"cloud,omitempty"`
	CloudError   string         `json:"cloud_error,omitempty"`
}

// exportedDiagnostics＝按鈕按下去存的那一份完整檔案。
type exportedDiagnostics struct {
	GeneratedAt string               `json:"generated_at"`
	Local       localDiagnostics     `json:"local"`
	Accounts    []accountDiagnostics `json:"accounts"`
}

// fetchCloudDiagnosticsFn 是可在測試中替換的間接呼叫（比照 cloud_version.go 的
// fetchCloudVersion 慣例），讓 mergeDiagnostics 以外的 IO 邊界也能被單測頂替。
var fetchCloudDiagnosticsFn = fetchCloudDiagnostics

// fetchCloudDiagnostics 打雲端新端點 GET {cypherURL}/portal/daemon/diagnostics
// （X-Arcrun-API-Key 認證，matrix/arcrun commit 93b1140）。回應原樣轉存（本身已守住
// 兩條紅線：不含內部概念/不含卡片內容，見 buildDiagnostics 註解），本函式不重新挑欄位。
func fetchCloudDiagnostics(cypherURL, apiKey string) (map[string]any, error) {
	base := strings.TrimSpace(cypherURL)
	if base == "" {
		return nil, fmt.Errorf("這個帳號還沒設定知識庫網址")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("這個帳號還沒有連線金鑰")
	}
	url := strings.TrimSuffix(base, "/") + "/portal/daemon/diagnostics"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Arcrun-API-Key", apiKey)

	resp, err := diagnosticsHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("連不上你的知識庫：%w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusNotFound {
		// 舊實例還沒有這條 route ⇒ 講人話，別讓診斷檔裡出現裸 404（比照 extract_workersai.go 慣例）
		return nil, fmt.Errorf("你的知識庫還是舊版（沒有雲端診斷功能）⇒ 請到 portal 按「立即更新」重裝一次")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("雲端診斷查詢失敗（HTTP %d）：%.300s", resp.StatusCode, string(body))
	}

	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("雲端回應解析失敗：%w", err)
	}
	return out, nil
}

// buildDiagnosticsPayload 只管 IO（讀 status.json／讀 config.json／打網路）；
// 純合併邏輯抽進 mergeDiagnostics（無 IO），方便測試不必真的連網／彈存檔對話框
// 就能涵蓋「同一組數字」「分類原樣照抄」「basename-only」這幾條規則。
func (a *App) buildDiagnosticsPayload() exportedDiagnostics {
	sync := loadSyncStatus()
	skipped := buildSkipped(sync) // 首頁既有邏輯：Files 已是 basename＋白話標籤，直接借用
	update := a.CheckUpdate()     // 現查現答，不用可能過期的背景檢查快取（Q4）

	// t213 phase 3（Q2）：現查現答同步引擎「現在還在不在跑」，直接讀 supervise.go
	// 已經在維護的同一組憑據（供首頁 describeStatus() 用的那套），不重新發明判斷法。
	_, headline, detail := describeStatus(sync)
	alive := collectorAlive()
	lastErr, restarts, looping := collectorFailure()
	engine := engineDiagnostics{
		Alive:        alive,
		Syncing:      collectorSyncing(),
		CrashLooping: looping,
		Restarts:     restarts,
		// t213 phase 4（leo 08-08 追加）：headline／detail 沿用首頁同一套 describeStatus()，
		// 但 detail 在 !alive 時會把 collectorFailure() 的死因原文接進來（見 describeStatus
		// 的「原因：」那幾行）——那句死因常常就是 supervisor 捕到的 stderr 末行，可能帶著
		// 監看資料夾的本機絕對路徑（見下面 redactLocalPaths 的長註解）。這裡只遮蔽「要匯出
		// 成檔案」的這一份，describeStatus() 本身／首頁托盤畫面完全不動。
		Headline: redactLocalPaths(headline),
		Detail:   redactLocalPaths(detail),
	}
	engine.LastError = redactLocalPaths(engineLastErrorFor(alive, looping, lastErr))

	cfg, _ := loadCfg()
	accounts := make([]accountDiagnostics, 0, len(cfg.Accounts))
	for _, acc := range cfg.Accounts {
		ad := accountDiagnostics{InstanceName: accountName(acc), Host: shortHost(acc.CypherURL)}
		key := acc.APIKey
		if strings.TrimSpace(key) == "" {
			key = acc.Namespace // 同 collector/direct.go 的既有 fallback（api_key 空值時退回 namespace）
		}
		cloud, err := fetchCloudDiagnosticsFn(acc.CypherURL, key)
		if err != nil {
			ad.CloudError = err.Error()
		} else {
			ad.Cloud = cloud
		}
		accounts = append(accounts, ad)
	}

	return mergeDiagnostics(sync, skipped, version, update, engine, accounts)
}

// engineLastErrorFor 決定 LastError 要不要出現在診斷檔——只在「真的代表出事」時才附上
// （子行程不活著、或一直啟動失敗）。
//
// 🔴 supervisor 的 LastError 是「最近一行 stderr」，即使子行程健康，開機橫幅那類純資訊
// 也會被記進去（見 supervisor.go runOnce 的 stderr scanner，本身不判斷這行是不是真錯誤——
// 這是既有共用機制的既有行為，不在本次改動範圍）；若不加這道判斷，alive=true 的健康快照裡
// 也會混進一句看起來像錯誤、實際只是啟動訊息的文字，誤導看診斷檔的人。
// 同首頁 describeStatus()：只在「一直失敗」或「沒有在跑」兩種狀態才把這句話端上檯面。
func engineLastErrorFor(alive, crashLooping bool, lastErr string) string {
	if !alive || crashLooping {
		return lastErr
	}
	return ""
}

// redactLocalPaths — t213 phase 4（leo 08-08 追加規則④）。
//
// 背景：`engine.detail`／`engine.last_error` 的內容有一部分來自 collectorFailure() 的
// 死因原文，那句話是 supervisor 捕到的 stderr **末行**（見 supervisor.go runOnce 的
// stderr scanner）——常見的情況是子行程剛啟動就掛，最後一行 stderr 停在
// direct.go RunDirect 印的開機橫幅：「collector direct daemon 啟動：監看 <資料夾絕對路徑>
// → <目的地>」，也可能是任何 os.PathError 形狀的訊息（如「open /Users/x/y: permission
// denied」）。兩種形狀都以本機絕對路徑開頭——這條路徑會洩漏使用者的目錄結構（含帳號名，
// 例如 /Users/<帳號>/... 或 C:\Users\<帳號>\...），跟既有的「失敗檔名只出 basename」
// （見 buildSkipped()）是同一個理由，只是換了個欄位發作。
//
// 怎麼遮：只挖掉「路徑本體」，換成「…/<路徑最後一截>」——資料夾/檔名本身保留，
// 訊息的其餘文字原封不動。這樣「引擎沒在跑、以及為什麼」依然讀得懂（不能把資訊遮成啞巴），
// 只是看不出這是使用者電腦上的哪個帳號、哪層目錄。
//
// 只在這裡（診斷檔匯出的最後一哩）做，不改 direct.go／supervisor.go 的訊息本身，也不改
// describeStatus()／collectorFailure()：那兩支同時也是首頁托盤畫面在用的同一組憑據，
// 動了會連首頁畫面一起變——超出本次「只動診斷檔這一端」的範圍（首頁要不要一起改，
// 留給總管/leo 另外決定，見交接紀錄）。
func redactLocalPaths(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	n := len(r)
	var b strings.Builder
	for i := 0; i < n; {
		// http(s) URL 先放行，原文照抄——避免其中的 `/`（如 .../webhooks/named/...）
		// 被下面的「本機路徑」判斷誤吃（URL 不是本機目錄結構，不在遮蔽範圍內）。
		if j, ok := urlSpanAt(r, i); ok {
			b.WriteString(string(r[i:j]))
			i = j
			continue
		}
		if plen := absPathPrefixLen(r, i); plen > 0 {
			start := i
			j := i + plen
			for j < n && !isPathBoundary(r[j]) {
				j++
			}
			b.WriteString("…/")
			b.WriteString(lastPathSegment(string(r[start:j])))
			i = j
			continue
		}
		b.WriteRune(r[i])
		i++
	}
	return b.String()
}

// urlSpanAt 偵測 i 處是不是 http(s) URL 的起點（必須在字詞邊界上，避免咬到中間），
// 回傳 URL 一路唸到下一個 URL 邊界字元為止的結尾位置。
//
// 🔴 這裡不能直接用 isPathBoundary 當終止點——URL 裡的 `://` scheme 分隔符與
// `:port` 都合法含有冒號，若拿冒號當終止點，`https://` 掃到第一個 `:` 就會被腰斬成
// 「https」，剩下的 `//host/path` 又會被 absPathPrefixLen 誤判成本機路徑（因為冒號
// 本身是 isPathBoundary 認得的邊界字元，讓緊接在後面的 `/` 通過起點檢查）——
// 這正是這支函式存在的理由，用專屬的終止點集合（isPathBoundary 拿掉冒號）。
func urlSpanAt(r []rune, i int) (int, bool) {
	if i > 0 && !isPathBoundary(r[i-1]) {
		return 0, false
	}
	rest := string(r[i:min(i+8, len(r))])
	if !strings.HasPrefix(rest, "http://") && !strings.HasPrefix(rest, "https://") {
		return 0, false
	}
	j := i
	for j < len(r) && !isURLBoundary(r[j]) {
		j++
	}
	return j, true
}

// isURLBoundary＝isPathBoundary 拿掉冒號（URL 合法含冒號，見上面 urlSpanAt 的註解）。
func isURLBoundary(r rune) bool {
	if r == ':' {
		return false
	}
	return isPathBoundary(r)
}

// absPathPrefixLen 判斷 i 是不是一個本機絕對路徑的起點，回傳「路徑根部」本身的字元數
// （Unix `/` 算 1 個；Windows 磁碟代號 `C:\`／`C:/` 算 3 個）。只在「前一個字元是邊界
// 字元（或 i==0）」時才算數——避免把一般文字裡湊巧出現的字元誤判成路徑起點。
func absPathPrefixLen(r []rune, i int) int {
	if i > 0 && !isPathBoundary(r[i-1]) {
		return 0
	}
	if r[i] == '/' {
		return 1
	}
	if i+2 < len(r) && isASCIILetter(r[i]) && r[i+1] == ':' && (r[i+2] == '\\' || r[i+2] == '/') {
		return 3
	}
	return 0
}

func isASCIILetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

// isPathBoundary＝這個字元不可能是路徑本體的一部分，可以拿來當「路徑到這裡結束」的判準
// （空白、中西文標點、箭頭）。本檔目前已知的兩種訊息形狀都靠它正確截斷：
// 「監看 A、B → url」用「、」「→」收尾；`os.PathError` 的「path: 原因」用「:」收尾。
// 刻意不把純空白以外的一般文字字元（含資料夾名裡常見的空格）當終止點以外的東西處理——
// 資料夾名稱裡的空格會讓比對在空格處提早停下，不會吃到後面不相干的文字，這是刻意的保守
// 選擇：寧可少遮一點（漏出資料夾名稱片段），也不要多遮（把後面的說明文字一起吃掉）。
func isPathBoundary(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r',
		'、', '（', '）', '(', ')',
		',', ';', '，', '；', ':', '→',
		'"', '\'', '<', '>':
		return true
	}
	return false
}

// lastPathSegment 取路徑最後一截（跨 `/`、`\` 兩種分隔符，不假設執行平台），
// 拿不到任何一截（例如整條路徑只有根目錄）時回一個看得懂的佔位字，不留空字串。
func lastPathSegment(p string) string {
	p = strings.TrimRight(p, `/\`)
	if idx := strings.LastIndexAny(p, `/\`); idx >= 0 {
		p = p[idx+1:]
	}
	if p == "" {
		return "本機路徑"
	}
	return p
}

// mergeDiagnostics 純函式：把已經各自拿到的本機／雲端資料組成最終輸出形狀，不做任何 IO。
//
//	leo 08-08 規則對照：
//	  ① 同首頁數字——Progress／FailureBreakdown 原樣接住 sync 裡 t210 已算好的值，不重算。
//	  ② 分類名稱只認得 collector/progress.go 的 ClassifyFailure——這裡原樣照抄
//	     sync.FailureBreakdown，本函式不比對/不認得任何一個分類字串。
//	  ③ 失敗檔名只出 basename——skipped.Files 沿用 buildSkipped() 既有輸出（本來就是
//	     filepath.Base()＋白話標籤），本函式不重新處理路徑。
func mergeDiagnostics(sync syncStatus, skipped *UISkipped, daemonVersion string, update UpdateInfo, engine engineDiagnostics, accounts []accountDiagnostics) exportedDiagnostics {
	now := time.Now().UTC()

	// engine.Alive／Syncing／CrashLooping／Restarts／LastError／Headline／Detail 是呼叫端
	// 現查現答傳進來的（IO／即時行程狀態，見 buildDiagnosticsPayload）；這裡只補上
	// 從 status.json 本來就有、原樣接住的兩個時間戳，以及純算術算出的落後秒數。
	engine.LastSync = sync.LastSync
	engine.LastActivityAt = sync.LastActivityAt
	if sync.LastSync != "" {
		if t, err := time.Parse(time.RFC3339, sync.LastSync); err == nil {
			secs := int64(now.Sub(t).Seconds())
			engine.SecondsSinceLastSync = &secs
		}
	}

	local := localDiagnostics{
		DaemonVersion:    daemonVersion,
		UpdateCheck:      update,
		Engine:           engine,
		Progress:         sync.Progress,
		FailureBreakdown: sync.FailureBreakdown,
	}
	if skipped != nil {
		local.SkippedSample = skipped.Files
		local.SkippedMore = skipped.More
	}
	return exportedDiagnostics{
		GeneratedAt: now.Format(time.RFC3339),
		Local:       local,
		Accounts:    accounts,
	}
}

// ExportDiagnostics（前端「疑難排解」按鈕呼叫）：組出診斷內容 → 彈系統存檔對話框 →
// 使用者選好位置就寫檔。回傳實際寫入的路徑（前端顯示「已存到 xxx」）；
// 使用者取消對話框時回傳空字串＋nil（不算錯誤，不彈紅字嚇人）。
func (a *App) ExportDiagnostics() (string, error) {
	payload := a.buildDiagnosticsPayload()
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "匯出診斷檔",
		DefaultFilename: fmt.Sprintf("arcrun-diagnostics-%s.json", time.Now().Format("2006-01-02-15-04-05")),
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // 使用者按了取消
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
