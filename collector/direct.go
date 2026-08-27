// direct.go — daemon「直送萃取、無 R2」同步模式（SDD ingest-hash-trigger task 11）。
//
// 既有 sync 走 collector → R2 → rag_ingest（需 R2 bucket＝綁卡）。direct 模式繞開 R2/Gitea：
// 監看資料夾 → 偵測新增/改動檔（沿用 Scan 的 hash 差異偵測）→ 讀檔內容 inline POST 進實例的
// rag_ingest_direct workflow（LLM 萃卡 → 機械切塊 → 寫 kbdb，全在 Arcrun workflow 裡完成）。
// 刪檔 → 把 removed 事件（collector-trigger.v1）POST 進實例的 rag_ingest workflow removed 分支
// （只按 page_name 讀 kbdb blocks 並標 deprecated，不碰 R2）。
//
// dogfooding（D29 daemon 薄殼豁免）：本檔只做「監看／讀檔／算 hash／HTTP POST」——原生 Go。
// 萃取／切塊／RAG 一律在實例 workflow，daemon 內零 LLM/切塊邏輯。
//
// 用法：
//
//	collector direct --config <config.json> [--once] [--dry-run]
//
// --once：掃一輪就退出（測試/cron 用）；預設常駐輪詢（poll_interval_sec）。
// --dry-run：只列出會送出的動作，不 POST、不寫 manifest。
//
// 跨平台：純 stdlib、輪詢式偵測（不依賴 fsnotify）＝零 CGo，darwin/arm64、windows/amd64 直接交叉編譯。
package collector

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// AccountConfig 單一帳號的連線設定（t104 多帳號同時看守）。
// 每個帳號代表一個 Arcrun 知識庫實例；Extractor/Manifest 等機器層級設定住在 DirectConfig 頂層。
// t126：Extractor/GeminiAPIKey/LLMModel 支援帳號層覆蓋——帳號有值時優先，空值繼承機器層。
type AccountConfig struct {
	InstanceName string            `json:"instance_name,omitempty"`
	Email        string            `json:"email,omitempty"`
	CypherURL    string            `json:"cypher_url"`
	Namespace    string            `json:"namespace"`
	APIKey       string            `json:"api_key,omitempty"`
	WatchFolders []string          `json:"watch_folders,omitempty"` // 此帳號看守的資料夾（多根）
	Libraries    map[string]string `json:"libraries,omitempty"`     // 資料夾→庫對映（t52）
	// RetiringFolders＝使用者已經按下「移除並收回雲端資料」、但雲端還沒撤乾淨的資料夾
	// （arcrun-rag#46）。**App 是唯一寫入者**：它把路徑從 WatchFolders 搬到這裡；
	// collector 只讀，撤乾淨後在 status.json 把該根標成 done，由 App 負責清掉這一筆。
	// 一個寫入者＝不會有兩個行程互相蓋掉對方的設定。
	RetiringFolders []string `json:"retiring_folders,omitempty"`
	// t126：每帳號獨立的萃取設定（空值繼承 DirectConfig 頂層）
	Extractor    string `json:"extractor,omitempty"`
	GeminiAPIKey string `json:"gemini_api_key,omitempty"`
	LLMModel     string `json:"llm_model,omitempty"`
}

// DirectConfig 是 direct 模式的設定檔（JSON）。設定只走檔案/環境，不落 code。
type DirectConfig struct {
	// t104：多帳號清單（新制）。有值時頂層連線欄位僅保留讀取相容——
	// 啟動時若無 Accounts 但有舊的頂層 CypherURL，LoadDirectConfig 自動包成 Accounts[0]。
	Accounts     []AccountConfig `json:"accounts,omitempty"`
	WatchFolder  string          `json:"watch_folder,omitempty"`  // 監看的知識資料夾（單數舊制；與 watch_folders 至少填一）
	WatchFolders []string        `json:"watch_folders,omitempty"` // 監看的知識資料夾清單（daemon-beta task 1 多資料夾）
	// RetiringFolders＝舊制（單帳號）的「移除並收回中」清單；新制走 Accounts[].RetiringFolders。
	RetiringFolders []string `json:"retiring_folders,omitempty"`
	Manifest     string          `json:"manifest"`                // manifest JSON 路徑（必填；多資料夾時為基底名，每根一份帶尾碼）
	CypherURL    string          `json:"cypher_url,omitempty"`    // 實例 cypher base（舊制；新制走 Accounts）
	Namespace    string          `json:"namespace,omitempty"`     // 租戶 namespace（舊制；新制走 Accounts）
	APIKey       string          `json:"api_key,omitempty"`       // X-Arcrun-API-Key（舊制）
	Email        string          `json:"email,omitempty"`         // 實例主身分（舊制）
	InstanceName string          `json:"instance_name,omitempty"` // 暱稱（舊制）
	Library      string          `json:"library"`                 // 藏書地圖歸庫鍵（空＝kb；per-folder 未指定時的後備）
	// t52：每個看守資料夾對應自己的庫（key＝絕對路徑，value＝庫名）；新制走 AccountConfig.Libraries。
	Libraries map[string]string `json:"libraries,omitempty"`
	IngestWF  string            `json:"ingest_workflow"`  // 直送萃取 workflow 名（空＝rag_ingest_direct）
	RemovedWF string            `json:"removed_workflow"` // 下架 workflow 名（空＝rag_takedown_direct）
	// —— 四步定稿（daemon-beta t3/t4/t6）：本地萃卡模式 ——
	Extractor string `json:"extractor,omitempty"` // "workers-ai"（預設，免金鑰）｜"gemma"｜"claude"（已停用）
	// t181：使用者**主動在托盤選過**萃取引擎才為 true。false＝一律走 workers-ai。
	// 判準刻意不是「有沒有金鑰」——leo 08-04：「不管你現在是否有填金鑰」都要先 default
	// Workers AI，否則他得「花在解釋為什麼 Gemini 不管用上」。
	// 有金鑰但沒主動選 ⇒ 金鑰留著不動，之後選 Gemini 立刻可用。
	ExtractorExplicit bool    `json:"extractor_explicit,omitempty"`
	ClaudeBin         string  `json:"claude_bin,omitempty"`           // claude 執行檔（空＝PATH 找 claude）
	GeminiAPIKey      string  `json:"gemini_api_key,omitempty"`       // gemma 路的用戶 key
	LLMModel          string  `json:"llm_model,omitempty"`            // gemma 路模型（空＝gemma-4-31b-it）
	CardIngestWF      string  `json:"card_ingest_workflow,omitempty"` // 收卡 workflow（空＝rag_ingest_card）
	PollSec           int     `json:"poll_interval_sec"`              // 輪詢間隔秒（空/0＝5）
	MaxRemoved        float64 `json:"max_removed_ratio"`              // 大量刪除防呆門檻（空/0＝0.4）
	// MaxEventsPerRun（2026-08-07 pacing task）：單輪最多處理幾個 added/modified/renamed/
	// removed 事件，空/0＝DefaultMaxEventsPerRun。存在理由：巨量積壓（實據 27,164 檔）
	// 不該一輪湧完——搭配節流間隔＋新檔優先排序，讓積壓慢慢消化，不擋今天剛寫的新檔。
	MaxEventsPerRun int `json:"max_events_per_run,omitempty"`

	// ForceSync＝這一輪是使用者按「立刻同步」觸發的（t195）。
	// 為真時忽略失敗退避與次數上限，一律重送——**人明確要求時不該被機器的退避擋住**。
	// 不寫進 config.json（`json:"-"`）：它是單次執行旗標，不是使用者設定。
	ForceSync bool `json:"-"`

	// B2 萃取品質檢查（daemon 端 lint，草案 §3 第一層；分支 work/b2-quality-lint-0726 移入，
	// 2026-08-09 重新接到現行 direct.go——原分支落後 main 130 筆，不能硬併，見
	// wiki status.md:1570-1573）：extractor 模式萃完、POST 前跑。
	// LintStrict＝軟項也擋（測試/CI）；預設 false＝硬缺拒收、軟項照送標 quality:low。
	// CLI `--strict` 會覆蓋成 true。
	LintStrict bool `json:"lint_strict,omitempty"`

	// MachineLabel＝這台機器要在雲端顯示成什麼名字（`inkstone/mira#6`，leo 2026-08-18）。
	// 空＝用 machine.json 鑄好的可讀 ID（`youlinhsieh@Leo-MBA`）。
	// leo：「他再自己去改『教育部 Leo 的 Mac』」——改的是**這一格**，機器 ID 不動，
	// 所以改名不會讓庫裡憑空多出一台機器。
	MachineLabel string `json:"machine_label,omitempty"`

	// machine＝解析好的機器身分快取（不落 config 檔：ID 的家是 machine.json，
	// 這裡只是這一輪的記憶體副本。makeAccountSubConfig 的 `sub := *c` 會一起複製，
	// 所以多帳號同一輪只解析一次、每個帳號送出的值必然一致）。
	machine *MachineIdentity
}

// machineIdentity 回這台機器的身分（第一次呼叫時解析並鑄檔，之後讀快取）。
//
// 身分檔跟著 manifest 放（實務上＝~/.arcrun-rag/）：那是本 daemon 既有的狀態目錄，
// 不另立第二個狀態位置。
func (c *DirectConfig) machineIdentity() MachineIdentity {
	if c.machine != nil {
		return *c.machine
	}
	stateDir := "" // 空＝不落檔（沒設 manifest 的臨時 config 不該把身分檔亂寫進工作目錄）
	if strings.TrimSpace(c.Manifest) != "" {
		stateDir = filepath.Dir(expandHome(c.Manifest))
	}
	id := ResolveMachine(stateDir, c.MachineLabel)
	c.machine = &id
	return id
}

// librarySlug 把資料夾名轉成合法庫名（A-Za-z0-9_-；中文等非 ASCII 轉為底線分段）。
// 空結果（如純中文名）回 ""，由 libraryFor 改生路徑穩定雜湊鍵（t89）。
func librarySlug(folder string) string {
	base := filepath.Base(strings.TrimRight(folder, string(filepath.Separator)))
	var b strings.Builder
	lastUnderscore := false
	for _, r := range base {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_':
			b.WriteRune(r)
			lastUnderscore = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32) // 統一小寫（庫名大小寫不敏感比對較不易出錯）
			lastUnderscore = false
		default:
			if !lastUnderscore && b.Len() > 0 {
				b.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	return strings.Trim(b.String(), "_")
}

// libraryFor 決定某個看守資料夾的資料該蓋哪個庫章（t52）。
// 優先序：config.Libraries 明列 > 資料夾名 slug > 路徑穩定雜湊鍵（t89）。
//
// t89（leo 2026-07-28 實測）：純中文資料夾名（如「官方總圖」）slug 後為空字串，
// 若退到 c.Library/"kb"，兩個不同純中文資料夾會塌縮進同一個庫（靜默混庫）。
// 後端庫名鍵限 A-Za-z0-9_-（Arcrun KBDB 約束），故改生 lib_+sha256(絕對路徑) 前 6 hex——
// 路徑穩定所以鍵穩定；兩個不同路徑必然不同鍵。
func (c *DirectConfig) libraryFor(absRoot string) string {
	if c.Libraries != nil {
		if lib, ok := c.Libraries[absRoot]; ok && strings.TrimSpace(lib) != "" {
			return strings.TrimSpace(lib)
		}
	}
	if slug := librarySlug(absRoot); slug != "" {
		return slug
	}
	sum := sha256.Sum256([]byte(absRoot))
	return "lib_" + hex.EncodeToString(sum[:3])
}

// expandHome 把開頭的 `~/`（或單獨的 `~`）展開成使用者家目錄的絕對路徑。
//
// t39（07-24 安裝器實案）：成功頁下載的 config.json 把 manifest 寫成 `~/.arcrun-rag/manifest.json`——
// 那是給人看的寫法，**Go 不會展開波浪號**，os.ReadFile 會去找一個字面上叫 "~" 的資料夾。
// 修在 daemon 端而不是前端：用戶自己手打 config、或把設定搬到別台機器時，`~/` 都該會動；
// 前端也拿不到用戶的家目錄。展開失敗（拿不到家目錄）就原樣返回，讓後續錯誤照常誠實浮現。
func expandHome(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	return filepath.Join(home, strings.TrimPrefix(p, "~/"))
}

// LoadDirectConfig 讀設定檔並補預設值 + 基本驗證。
// t104 向後相容遷移：若無 Accounts 但有舊的頂層 CypherURL，自動包成 Accounts[0]（記憶體遷移；
// 磁碟回寫由呼叫端在合適時機（如 saveDirectConfig）完成）。
func LoadDirectConfig(path string) (*DirectConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("讀 config 失敗：%w", err)
	}
	var c DirectConfig
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("config JSON 解析失敗：%w", err)
	}
	// t39：路徑欄位一律展開 `~/`（先展開才能正確計算 Folders()）
	c.Manifest = expandHome(c.Manifest)
	c.WatchFolder = expandHome(c.WatchFolder)
	for i, p := range c.WatchFolders {
		c.WatchFolders[i] = expandHome(p)
	}
	for i := range c.Accounts {
		for j, p := range c.Accounts[i].WatchFolders {
			c.Accounts[i].WatchFolders[j] = expandHome(p)
		}
		// arcrun-rag#46：待撤資料夾同樣要展開 `~/`——它與 WatchFolders 是同一種東西
		// （使用者選的路徑），漏掉這裡就會去找一個字面上叫 "~" 的資料夾（t39 那個病）。
		for j, p := range c.Accounts[i].RetiringFolders {
			c.Accounts[i].RetiringFolders[j] = expandHome(p)
		}
	}

	// t104：舊格式遷移——頂層 CypherURL → Accounts[0]（冪等：有 Accounts 就跳過）
	if len(c.Accounts) == 0 && c.CypherURL != "" {
		c.Accounts = []AccountConfig{{
			InstanceName: c.InstanceName,
			Email:        c.Email,
			CypherURL:    c.CypherURL,
			Namespace:    c.Namespace,
			APIKey:       c.APIKey,
			Libraries:    c.Libraries,
			WatchFolders: c.Folders(), // 正規化後的監看清單
			// arcrun-rag#46：待撤清單也要一起遷過來。漏掉這裡＝舊制使用者的
			// retiring_folders 停在頂層、而 makeAccountSubConfig 會用帳號層覆蓋掉它
			// ⇒ 撤除永遠不會發生，而且**沒有任何錯誤訊息**（同 t149 的形狀）。
			RetiringFolders: c.RetiringRoots(),
		}}
	}

	// 🔴 t182 遷移（leo 2026-08-04 拍板，**這條要在 t126 複製之前跑**）：
	//
	//	「如果是我的 config 保持舊的，那新版裝上就要檢查，因為已經是 default worker AI，
	//	 **就要抹除改成用 Workers AI**，如果保持 Gemini 它不會改掉，**那就是失敗的**」
	//
	// 舊版沒有 `extractor_explicit` 這個欄位 ⇒ 老 config 一律是「沒有主動選過」，
	// 但裡頭留著 extractor="gemma"（頂層＋每個帳號各一份，t126 複製過去的）。
	// 只在記憶體裡改預設不夠——**沒寫回檔案**，托盤下次讀 config 還是念 Gemini，
	// 萃取也照舊走 Gemini（leo 08-04 實測：更新到 v0.15.5 後兩個帳號仍顯示 Gemini、
	// 丟 PDF 進去產不出卡，因為根本沒走到 Workers AI 這條路）。
	//
	// ⇒ 沒 explicit 就把**每一層**的舊值抹掉改成 workers-ai，並回寫檔案（見下方 saveDirectConfig）。
	// 金鑰不動：之後他想選 Gemini，貼過的金鑰還在（leo：Gemini 變選配，不是廢除）。
	// 冪等：抹完即與新版一致，重跑不再改動。
	migrated := false
	if !c.ExtractorExplicit {
		if strings.TrimSpace(c.Extractor) != "" && c.Extractor != "workers-ai" {
			c.Extractor = "workers-ai"
			migrated = true
		}
		for i := range c.Accounts {
			if strings.TrimSpace(c.Accounts[i].Extractor) != "" && c.Accounts[i].Extractor != "workers-ai" {
				c.Accounts[i].Extractor = "workers-ai"
				migrated = true
			}
		}
	}

	// t126 遷移：把頂層金鑰複製到每個沒有金鑰的帳號（複製非搬移，頂層保留當預設；冪等）。
	// 帳號已有自己的值（非空）→ 不覆蓋，讓帳號層設定永遠優先。
	for i := range c.Accounts {
		if strings.TrimSpace(c.Accounts[i].Extractor) == "" && strings.TrimSpace(c.Extractor) != "" {
			c.Accounts[i].Extractor = c.Extractor
		}
		if strings.TrimSpace(c.Accounts[i].GeminiAPIKey) == "" && strings.TrimSpace(c.GeminiAPIKey) != "" {
			c.Accounts[i].GeminiAPIKey = c.GeminiAPIKey
		}
		if strings.TrimSpace(c.Accounts[i].LLMModel) == "" && strings.TrimSpace(c.LLMModel) != "" {
			c.Accounts[i].LLMModel = c.LLMModel
		}
	}

	// 驗證
	var missing []string
	if c.Manifest == "" {
		missing = append(missing, "manifest")
	}
	if len(c.Accounts) == 0 {
		missing = append(missing, "accounts（或 cypher_url 連線設定）")
	}
	for i, acc := range c.Accounts {
		if acc.CypherURL == "" {
			missing = append(missing, fmt.Sprintf("accounts[%d] 缺 cypher_url", i))
		}
		if acc.Namespace == "" {
			missing = append(missing, fmt.Sprintf("accounts[%d] 缺 namespace", i))
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("config 缺必填欄位：%s", strings.Join(missing, ", "))
	}

	// 🔴 t182：把抹除**寫回檔案**（leo：「新版裝上就要檢查……就要抹除改成用 Workers AI」）。
	// 只改記憶體不算抹除——托盤是**另一個行程**、自己讀同一份 config.json，
	// 不寫回去它就繼續念「Gemini」，畫面與實際行為又脫鉤（t178 那個病）。
	// 放在驗證通過之後：確定這份 config 是好的才回寫，不把半殘結構蓋掉使用者的檔。
	// 寫失敗不擋啟動（唯讀目錄等）——記憶體裡已是 workers-ai，這輪行為仍正確。
	if migrated {
		if err := saveDirectConfig(path, &c); err != nil {
			fmt.Fprintf(os.Stderr, "⚠ 舊設定已改用雲端 AI，但寫回 config 失敗（不影響本次執行）：%v\n", err)
		}
	}

	// 補各帳號預設值
	for i := range c.Accounts {
		if c.Accounts[i].APIKey == "" {
			c.Accounts[i].APIKey = c.Accounts[i].Namespace
		}
		c.Accounts[i].CypherURL = strings.TrimSuffix(c.Accounts[i].CypherURL, "/")
	}
	// 頂層後備值（舊制相容或被 makeAccountSubConfig 繼承）
	if c.APIKey == "" {
		c.APIKey = c.Namespace
	}
	if c.Library == "" {
		c.Library = "kb"
	}
	if c.IngestWF == "" {
		c.IngestWF = "rag_ingest_direct"
	}
	if c.RemovedWF == "" {
		c.RemovedWF = "rag_takedown_direct"
	}
	if c.CardIngestWF == "" {
		c.CardIngestWF = "rag_ingest_card"
	}
	if c.LLMModel == "" {
		c.LLMModel = defaultLLMModel
	}
	// t182：`workers-ai` 是**現在的預設**，必須列入合法值。
	// （原本漏了它 ⇒ 一旦 config 寫成 workers-ai，載入直接失敗、daemon 起不來。
	//  `claude` 保留在合法清單只為**讀得進舊 config**——RunDirectOnce 會把它正規化成
	//  gemma（t176），不是還支援 claude。）
	if c.Extractor != "" && c.Extractor != "workers-ai" && c.Extractor != "claude" && c.Extractor != "gemma" {
		return nil, fmt.Errorf("extractor 只能是 workers-ai / gemma（或留空走預設），got %q", c.Extractor)
	}
	if c.PollSec <= 0 {
		c.PollSec = 5
	}
	if c.MaxRemoved <= 0 {
		c.MaxRemoved = DefaultMaxRemovedRatio
	}
	if c.CypherURL != "" {
		c.CypherURL = strings.TrimSuffix(c.CypherURL, "/")
	}
	return &c, nil
}

// Folders 回傳監看根清單（正規化：單數舊制併入、去重、保序）。
func (c *DirectConfig) Folders() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	add(c.WatchFolder)
	for _, p := range c.WatchFolders {
		add(p)
	}
	// t149（2026-07-29 leo 實測揪出）：**多帳號的看守資料夾在 Accounts[].WatchFolders**，
	// 先前只讀頂層 ⇒ 只在 accounts[] 設定的用戶，Folders() 回 nil ⇒ 掃描清單空 ⇒
	// 按「立刻同步」毫無反應、log 顯示 "folders": null、results: []（leo 就是這樣卡住的）。
	// 頂層是舊制（單帳號）；新制多帳號一律走 Accounts ⇒ 兩邊都要收。
	for _, a := range c.Accounts {
		for _, p := range a.WatchFolders {
			add(expandHome(p))
		}
	}
	return out
}

// RetiringRoots 回傳「已移除、雲端撤除進行中」的根清單（arcrun-rag#46）。
// 正規化方式與 Folders() 一致（頂層舊制＋Accounts 新制、去重、保序）——刻意照抄
// 而不是只讀 Accounts：t149 的病就是「只讀了其中一層」，一整個新制設定被靜默忽略。
func (c *DirectConfig) RetiringRoots() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	for _, p := range c.RetiringFolders {
		add(expandHome(p))
	}
	for _, a := range c.Accounts {
		for _, p := range a.RetiringFolders {
			add(expandHome(p))
		}
	}
	return out
}

// instanceHostOf extracts the host from a CypherURL to use as a per-instance
// distinguisher in manifest paths (t86b). Falls back to the full URL if parsing fails.
func instanceHostOf(cypherURL string) string {
	u, err := url.Parse(cypherURL)
	if err != nil || u.Host == "" {
		return cypherURL
	}
	return u.Host
}

// manifestPathFor 回傳某根的 manifest 路徑。
// t86b：雜湊改為 sha256(instanceHost + "\n" + absRoot)，讓每個（實例, 資料夾）組合對應
// 獨立帳本——換知識庫實例後同資料夾不再重用舊帳本，避免「全部視為已同步」靜默跳過。
// 舊格式遷移見 migrateManifestIfNeeded：啟動/掃描時若新名不存在但舊名存在則 rename 過來。
func (c *DirectConfig) manifestPathFor(absRoot string) string {
	host := instanceHostOf(c.CypherURL)
	sum := sha256.Sum256([]byte(host + "\n" + absRoot))
	ext := filepath.Ext(c.Manifest)
	return strings.TrimSuffix(c.Manifest, ext) + "-" + hex.EncodeToString(sum[:4]) + ext
}

// oldManifestPaths 回傳 t86b 之前版本對同一個 absRoot 會產生的 manifest 路徑，
// 供遷移時確認是否有舊帳本需要搬移。
// 優先序：①舊多根（只含路徑雜湊）→ ②舊單根（直用 cfg.Manifest）。
func (c *DirectConfig) oldManifestPaths(absRoot string) []string {
	ext := filepath.Ext(c.Manifest)
	base := strings.TrimSuffix(c.Manifest, ext)
	// 舊多根公式：sha256(absRoot only)
	sumPathOnly := sha256.Sum256([]byte(absRoot))
	pathOnlyPath := base + "-" + hex.EncodeToString(sumPathOnly[:4]) + ext
	// 舊單根公式：直用 cfg.Manifest
	return []string{pathOnlyPath, c.Manifest}
}

// migrateManifestIfNeeded 在 newPath 不存在時，把最先找到的舊格式 manifest rename 過來。
// 一次性、冪等：newPath 已存在時直接 return；rename 失敗靜默忽略（最多這一輪重傳，不影響正確性）。
func (c *DirectConfig) migrateManifestIfNeeded(absRoot, newPath string) {
	if _, err := os.Stat(newPath); err == nil {
		return // 新路徑已存在，無需遷移
	}
	for _, oldPath := range c.oldManifestPaths(absRoot) {
		if oldPath == newPath {
			continue
		}
		if _, err := os.Stat(oldPath); err == nil {
			_ = os.Rename(oldPath, newPath)
			return
		}
	}
}

// directHTTP 是 direct 模式共用的 HTTP client（萃取 workflow 可能同步跑 LLM，放寬 timeout）。
var directHTTP = &http.Client{Timeout: 300 * time.Second}

// triggerURL 組出 named-webhook 觸發完整 URL。
func (c *DirectConfig) triggerURL(workflow string) string {
	return fmt.Sprintf("%s/webhooks/named/%s/%s/trigger", c.CypherURL, c.Namespace, workflow)
}

// folderTreeURL 組出「回報資料夾樹」的端點（InkStoneCo#44 線 A）。
//
// 🔴 為什麼不是 named-webhook（也就是不做成一條 workflow）：這件事是**登記**，
// 不是知識萃取——它寫的是 portal 的登記簿（庫目錄＋資料夾節點），與
// `/portal/daemon/extract`（extract_workersai.go:86）、`/portal/daemon/libraries`
// 同一族、同一把 `X-Arcrun-API-Key`。做成 workflow 會為了「把結構化資料寫進登記簿」
// 在 workflow 裡塞一串 code 節點，那正是「表面走 Arcrun、實際整段寫 JS」的腹語術。
func (c *DirectConfig) folderTreeURL() string {
	return c.CypherURL + "/portal/daemon/folder-tree"
}

// countsAsDocument 回答「這筆結果算不算**使用者的一份文件**」——
// 也就是該不該進 status.json 的 `extracted_ok` / `extract_failed`（＝托盤上那句
// 「已整理 N 份 / ⚠ N 份失敗」）。
//
// 🔴 `folder_tree` 不算。它送的是**畫面用的資料夾結構**，不是知識、不是使用者的檔案：
// 收端只寫一把 KV，一份文件都沒有經手。
//
// 📌 這是本分支自己踩到的（InkStoneCo#44）：漏掉這道閘的症狀是**空資料夾**——
// 一個檔都沒有，樹卻照樣要送（那正是 arcrun-rag#106 要的），一旦雲端連不上，
// 使用者的托盤就會顯示「⚠ 1 份失敗」而他根本沒有半份檔案。
// 「講一個假的 1」跟「安靜地少講」對使用者是同一件事（同 #104 那條紅線）。
//
// `inventory`（資料夾總覽卡）刻意**仍然算**：它是真的被寫進知識庫的一張卡，
// 使用者在雲端查得到它——與這裡的樹不是同一種東西。
func countsAsDocument(r DirectResult) bool {
	return r.Type != "folder_tree"
}

// postJSON POST 一個 JSON body 到 url，回傳 HTTP 狀態碼與回應片段。非 2xx 視為錯誤。
func (c *DirectConfig) postJSON(url string, body any) (int, string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Arcrun-API-Key", c.APIKey)
	resp, err := directHTTP.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	// 🔴 讀 64KB 而不是 1KB：觸發端點的回應是一層外殼包著工作流的輸出，
	// 而**失敗的證據住在殼裡面**（見 triggeroutcome.go）。1KB 會把 JSON 切斷 ⇒
	// 永遠解析不了 ⇒ 每一次失敗都被讀成「看不出來」⇒ 下面那道閘等於不存在。
	full, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	snippet := full
	if len(snippet) > 1024 {
		snippet = snippet[:1024]
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, string(snippet), fmt.Errorf("HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	// 🔴 2xx 只證明「請求送到了」，不證明「東西寫進知識庫了」。
	// named-webhook 觸發成功一律回 200，工作流內部失敗藏在 body 裡
	//（2026-08-26 實測 `InkStoneCo`：26 份蓋了「已送達」章，雲端只有 4 份）。
	// 判斷放在這裡而不是各呼叫端：**「忘了接」這個失敗模式不該存在**
	//（同 ingestplan.go 把兩張排除表收成一張的理由）。
	if msg := webhookFailure(string(full)); msg != "" {
		return resp.StatusCode, string(snippet), errors.New(msg)
	}
	return resp.StatusCode, string(snippet), nil
}

// pageNameOf 從相對路徑導出頁名（basename 去副檔名），與 rag_ingest collect_changed 的 pageOf 同語意。
func pageNameOf(relPath string) string {
	base := relPath
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// DirectResult 是單一事件的直送結果（隨每輪 log 輸出）。
type DirectResult struct {
	Account    string `json:"account,omitempty"` // t104: cypher_url host（多帳號標的）
	Root       string `json:"root,omitempty"`    // 多資料夾時標明事件屬於哪個根
	Type       string `json:"type"`
	Path       string `json:"path"`
	Status     string `json:"status"` // ingested | removed | planned | failed | skipped
	HTTPStatus int    `json:"http_status,omitempty"`
	Error      string `json:"error,omitempty"`
}

// makeAccountSubConfig 從帳號設定建出單帳號用的 DirectConfig，繼承機器層級欄位（t104）。
// 用於 RunDirectOnce 逐帳號掃描，每帳號得到獨立的 CypherURL/Namespace/WatchFolders 等。
// t126：帳號層 Extractor/GeminiAPIKey/LLMModel 有值時優先覆蓋機器層（空字串不算「有值」）。
func (c *DirectConfig) makeAccountSubConfig(acc AccountConfig) *DirectConfig {
	sub := *c // 複製機器層級欄位
	sub.Accounts = nil
	sub.CypherURL = strings.TrimSuffix(acc.CypherURL, "/")
	sub.Namespace = acc.Namespace
	sub.APIKey = acc.APIKey
	if sub.APIKey == "" {
		sub.APIKey = sub.Namespace
	}
	sub.Email = acc.Email
	sub.InstanceName = acc.InstanceName
	sub.WatchFolder = ""
	sub.WatchFolders = acc.WatchFolders
	// arcrun-rag#46：撤除中的資料夾同樣逐帳號隔離——撤除要打的是**這個帳號**的雲端實例，
	// 沿用頂層清單會把 A 帳號的待撤資料夾拿去 B 帳號打（同 WatchFolders 的道理）。
	sub.RetiringFolders = acc.RetiringFolders
	sub.Libraries = acc.Libraries
	if sub.Library == "" {
		sub.Library = "kb"
	}
	// t126：帳號層有值時優先（空字串繼承機器層，已由 sub := *c 複製）
	if strings.TrimSpace(acc.Extractor) != "" {
		sub.Extractor = acc.Extractor
	}
	if strings.TrimSpace(acc.GeminiAPIKey) != "" {
		sub.GeminiAPIKey = acc.GeminiAPIKey
	}
	if strings.TrimSpace(acc.LLMModel) != "" {
		sub.LLMModel = acc.LLMModel
	}
	return &sub
}

// RunDirectOnce 對每個帳號的每個監看根掃一輪並彙總結果（t104 多帳號同時看守）。
// 單帳號行為與舊制完全相同（含 manifest 路徑）。回傳彙總結果與退出碼建議（任一根失敗＝1）。
// 額外：
//   - 預檢 extractor 可用性（t92-②），有 fallback 時更新 cfg.ClaudeBin（in-memory，呼叫端存檔）。
//   - 每輪結束寫 ~/.arcrun-rag/status.json（t91 狀態可見性，含 per-account 雲端版本）。
//   - 一個帳號失敗不擋其他帳號繼續同步（t104 隔離）。
func RunDirectOnce(cfg *DirectConfig, dryRun bool) ([]DirectResult, int, *TriggerPayload) {
	results := []DirectResult{}
	exit := 0
	var lastPayload *TriggerPayload
	now := time.Now() // 2026-08-07 pacing task：整輪共用同一個時間點（排序/冷卻判斷一致、好測試）

	// 2026-08-07：提早載入上一輪 status（原本只在函式尾端載入做 CarryForwardActivity）。
	// 額度冷卻與「今天已萃幾份」是**跨輪持續的狀態**（quotaState 見 quota.go），
	// 要在處理帳號之前就知道上一輪冷卻到什麼時候、今天已經算到幾份。
	var prevStatus SyncStatus
	if cfg.Manifest != "" {
		prevStatus, _ = LoadSyncStatus(StatusFilePath(cfg.Manifest)) // 讀不到＝零值，等同「沒有上一輪」
	}

	// t92-②：預檢 extractor（機器層級），有 fallback 路徑時就地更新 cfg.ClaudeBin。
	extractorOK := true
	extractorError := ""
	// t176（leo 08-03 拍板）：**地端先只支援 Gemini**（「地端先限制 Gemini API Key 配合客戶要求」）。
	// 殘留的 extractor:"claude"（雲端舊版下發、或舊 config 殘留）一律當 gemma 處理。
	// 這不是「自動偵測有無 claude」（那是 leo 07-27 已否決的 B 案，見 daemon-beta/tasks.md:641），
	// 而是「claude 路整條先不支援」——之後要裝回來，把這段拿掉即可。
	if cfg.Extractor == "claude" {
		cfg.Extractor = "gemma"
	}
	// 🔴 t181（leo 08-04 最優先）：**所有人一律預設 Workers AI（免金鑰）**。
	// leo：「daemon 的 AI 改用 workers AI」——「這是我的用戶最大障礙，
	// 造成首輪測試用戶的好評或惡評」。
	//
	// ⚠️ 包含**已經填過金鑰的老用戶**（leo 08-04 特別交代）：
	//   「default 用 Workers AI，你要用 Gemini 要**特別去選取**，
	//    不管你現在是否有填金鑰……不然我會有很多質疑，
	//    **花在解釋為什麼 Gemini 不管用上**」
	// ⇒ 判準是 `extractor_explicit`（使用者在托盤主動選過）而不是「有沒有金鑰」。
	//   有金鑰但沒主動選 ⇒ 仍走 Workers AI，金鑰留著不動、之後選 Gemini 立刻可用。
	//   Gemini 仍是選配（leo：「不需要推廣，特定人告訴他怎麼做就好」）。
	if !cfg.ExtractorExplicit {
		cfg.Extractor = "workers-ai"
		// 🔴 t182（leo 08-04 實撞：更新到 v0.15.5 後托盤**兩個帳號都還是顯示 Gemini**）：
		// 只清機器層不夠——`makeAccountSubConfig` 會把**帳號層**的 extractor 蓋回來
		// （t126 的「帳號層優先」規則，direct.go:414）。leo 的 config 正是這樣：
		// 頂層 extractor="gemma"、每個帳號也各自 "gemma"，全都沒有 explicit
		// ⇒ 頂層被改成 workers-ai，跑起來仍逐帳號走 gemma，畫面也照舊念 Gemini。
		// 沒有主動選過就是沒有主動選過，**每一層都要清**，否則預設等於沒改。
		for i := range cfg.Accounts {
			cfg.Accounts[i].Extractor = "workers-ai"
		}
	}
	if cfg.Extractor == "workers-ai" {
		// 這條路要的不是金鑰，是「連得上自己的知識庫」——沒連線才是真的沒法做事。
		//
		// 🔴 2026-08-06 leo Windows 實測：畫面說「還沒連上知識庫」，但**明明連上了**
		//    （側邊欄有 geek6688、庫目錄管理也看得到它的庫）。
		//    真兇：這裡只看**根層**的 cypher_url/api_key，而多帳號設定（現在的常態）
		//    根層是空的 ⇒ 恆判成沒連線。
		//    為什麼 Mac 沒事：leo 的 Mac config 帶著單帳號時代留下的根層欄位
		//    ——**今天第三次「我這台好好的」**（另兩次：config 缺 manifest、log 印錯網址）。
		//    ⇒ 判準改成「**根層有 或 任一帳號有**」。
		if !accountsConnected(cfg) {
			extractorOK = false
			// 🔴 入口寫錯會讓人找不到：托盤選單早就沒有「＋ 新增帳號…」了
			//    （t194 起托盤只剩「結束 Arcrun」，所有設定都在視窗裡）。
			extractorError = "還沒連上知識庫 ⇒ 按左邊「知識庫」下方的「新增知識庫帳號」，輸入網址與帳密"
		}
	}
	if cfg.Extractor == "gemma" {
		if strings.TrimSpace(cfg.GeminiAPIKey) == "" {
			extractorOK = false
			// t178（leo 08-04：封測者是台大資工碩士都卡住 ⇒「一般人就完蛋了」）：
			// 舊訊息「請在設定裡輸入 Gemini API Key」**沒說設定在哪** ⇒ 用戶找不到入口。
			// 錯誤訊息本身就要能當 onboarding：指名選單項、指名去哪申請。
			extractorError = "還沒設定 Gemini API Key ⇒ 點托盤選單的「AI 設定…」貼上金鑰" +
				"（免費申請：aistudio.google.com/apikey）"
		}
	}

	// t104：解出有效帳號清單（向後相容：無 Accounts 但有頂層 CypherURL 時視為單帳號）
	accounts := cfg.Accounts
	if len(accounts) == 0 && cfg.CypherURL != "" {
		accounts = []AccountConfig{{
			InstanceName: cfg.InstanceName,
			Email:        cfg.Email,
			CypherURL:    cfg.CypherURL,
			Namespace:    cfg.Namespace,
			APIKey:       cfg.APIKey,
			Libraries:    cfg.Libraries,
			WatchFolders: cfg.Folders(),
			// arcrun-rag#46：舊制（單帳號、頂層欄位）的待撤資料夾也要帶進來，
			// 否則只有新制 accounts[] 的人撤得掉——t149 那個「只讀了其中一層」的病。
			RetiringFolders: cfg.RetiringRoots(),
		}}
	}

	// G-6.2：跨帳號、跨監看根累積「被略過的檔案」。
	// 用 map 去重——同一個資料夾可能被兩個帳號同時看守（t104 多帳號），
	// 使用者不該因為我們的內部結構而看到同一個檔名列兩次。
	skippedSeen := map[string]SkippedFile{}
	skippedOther := 0
	var skippedOtherNames []string

	// arcrun-rag#104：每個看守資料夾這一輪的收檔策略與「少收了什麼」。
	// key＝資料夾路徑（同一個根被多帳號看守時後寫覆蓋——策略只看資料夾，與帳號無關）。
	folderPlans := map[string]FolderPlanStatus{}

	// `inkstone/InkStoneCo#44`（桌面小幫手那半）：每個看守資料夾這一輪的樹。
	// 與 folderPlans 同一套 key 與同一套覆蓋語意。knownRoots 記「這一輪打算處理哪些根」
	// ——合併時要靠它把已經不看守的根從快照裡刪掉（見 MergeFolderTreeStore ③）。
	folderTrees := map[string]FolderTree{}
	var knownRoots []string

	// t210：跨帳號、跨資料夾累加的總量進度（見 rootProgress 註解）。
	var totalProgress SyncProgress
	var stuckReasons []string

	// arcrun-rag#46：這一輪各個「移除並收回中」資料夾的進度（key＝資料夾路徑）。
	// 每輪重建、照現況重報（level-triggered），App 看到 done 才把設定裡那一筆清掉。
	var retiring map[string]RetiringStatus

	// `inkstone/arcrun-rag#140`：這一輪各個資料夾的「雲端補送」現況（key＝資料夾路徑）。
	// 同 retiring 的 level-triggered 語意：每輪照 manifest 現況重報，補完自然消失。
	var resync map[string]ResyncStatus

	// t215：全域「雲端最新版」只抓一次（自帶節流，見 cloud_latest.go）——
	// 這是所有帳號共用的同一把尺，不是逐帳號各打一次。
	latestRelease, latestOK := FetchLatestCloudRelease()

	accountDetails := map[string]AccountSyncStatus{}
	for _, acc := range accounts {
		if acc.CypherURL == "" || acc.Namespace == "" {
			continue // 跳過設定不完整的帳號
		}
		accCfg := cfg.makeAccountSubConfig(acc)
		accHost := instanceHostOf(acc.CypherURL)

		// t103：per-account 雲端版本偵測
		cloudVer, cloudOK := fetchCloudVersion(accCfg.CypherURL)
		// t215：這個帳號要不要更新——與 portal 版本卡同一套判準（見檔頭）。
		cloudUpd := EvalCloudUpdate(cloudVer, cloudOK, latestRelease, latestOK)
		accSt := AccountSyncStatus{
			LastSync:         time.Now().Format(time.RFC3339),
			CloudVersion:     cloudVer,
			CloudCheckOK:     cloudOK,
			CloudUpdateKnown: cloudUpd.Known,
			CloudUpdateStale: cloudUpd.NeedsUpdate,
			CloudLatest:      cloudUpd.Latest,
		}

		// 🔴 t182（leo 08-04）：「會去**掃一次**看雲端是否裝好，**沒裝好就顯示 workers AI
		// 還沒通，一旦通了就顯示可用**」。
		// 每個帳號各掃各的——雲端實例是**逐帳號**各自更新的（leo 自己就有兩個帳號、
		// 更新進度不同步），一個帳號通了不代表另一個也通。
		// 只在走 workers-ai 這條路時掃；選了 Gemini 的人不需要知道這件事。
		if accCfg.Extractor == "workers-ai" {
			state := ProbeWorkersAI(accCfg.CypherURL, accCfg.APIKey)
			accSt.CloudAIReady = state.Ready
			accSt.CloudAINote = state.Note
			if !state.Ready && state.Note != "" {
				// 浮到頂層讓托盤「狀態：」那行直接看得到，不必展開帳號才發現。
				extractorOK = false
				extractorError = state.Note
			}
		}

		// 2026-08-07：從上一輪 status 復原這個帳號的額度冷卻／今天已萃份數——
		// 這兩件事是**帳號層級、跨輪持續**的狀態，不是單一資料夾的（額度是雲端
		// 實例/Cloudflare 帳號共用的，一個根撞到，同帳號其他根不該還繼續撞牆）。
		qs := &quotaState{}
		if prevAcc, ok := prevStatus.AccountDetails[accHost]; ok {
			if prevAcc.DailyIngestedDate == todayUTC(now) {
				qs.DailyCount = prevAcc.DailyIngestedCount
			}
			if prevAcc.QuotaCooldownUntil != "" {
				if t, perr := time.Parse(time.RFC3339, prevAcc.QuotaCooldownUntil); perr == nil {
					qs.CooldownUntil = t
				}
			}
		}

		multi := len(accCfg.Folders()) > 1
		for _, root := range accCfg.Folders() {
			r, e, p, rp := runDirectOnceRoot(accCfg, root, dryRun, qs, now)
			totalProgress = totalProgress.Add(rp.Progress)
			stuckReasons = append(stuckReasons, rp.StuckReasons...)
			// #44：這一根的樹。**掃壞了（Nodes 空）就不要覆蓋上一輪的好資料**——
			// 合併時沿用舊的（MergeFolderTreeStore ②），畫面不會突然變成「還沒回報」。
			knownRoots = append(knownRoots, root)
			if len(rp.Tree.Nodes) > 0 {
				folderTrees[root] = rp.Tree
			}
			// #140：有話要說才佔畫面（零值＝這個資料夾沒有補送中的事）。
			if rp.Resync.Pending > 0 || rp.Resync.Repaired > 0 || rp.Resync.LastError != "" {
				if resync == nil {
					resync = map[string]ResyncStatus{}
				}
				resync[root] = rp.Resync
			}
			if multi {
				for i := range r {
					r[i].Root = root
				}
			}
			for i := range r {
				r[i].Account = accHost // t104: 標明所屬帳號
				if cfg.Extractor != "" && countsAsDocument(r[i]) {
					switch r[i].Status {
					case "ingested":
						accSt.ExtractedOK++
					case "failed":
						accSt.ExtractFailed++
					}
				}
			}
			results = append(results, r...)
			if e != 0 {
				exit = e // 任一帳號任一根失敗＝整體 exit 1，但不停其他帳號
			}
			if p != nil {
				lastPayload = p
				// G-6.2：這一根掃出來的「讀不了的檔」收進總表。
				// 要在**每一根**都收，不能像 lastPayload 那樣只留最後一根——
				// 多資料夾時前面幾根的檔案會整批消失（t149 那類「只有最後一個生效」的病）。
				for _, sf := range p.Skipped {
					skippedSeen[sf.Path] = sf
				}
				skippedOther += p.SkippedOther
				// 同理，每一根的檔名都要收（上限在寫進 status 時才裁）。
				skippedOtherNames = append(skippedOtherNames, p.SkippedOtherNames...)
				// #104：這一根用了什麼策略、少收了什麼 —— 以前到這裡就被丟掉了
				// （只有 CLI 的 stderr 講得出來，App 走的這條路一個字都不說）。
				folderPlans[root] = FolderPlanStatus{
					Mode:             string(p.Plan.Mode),
					Reason:           p.Plan.Reason,
					ExcludedFiles:    p.ExcludedByPlan,
					ExcludedDirs:     p.ExcludedDirs,
					ExcludedDirCount: p.ExcludedDirCount,
					OtherWikiDirs:    p.Plan.OtherWikiDirs,
				}
			}
		}

		// arcrun-rag#46：把「使用者按了移除並收回」的資料夾撤乾淨。
		// 放在看守資料夾之後：正在用的資料夾優先，收回是善後。
		for _, root := range accCfg.RetiringRoots() {
			r, e, remaining, done := retireRootOnce(accCfg, root, dryRun)
			for i := range r {
				r[i].Root = root
				r[i].Account = accHost
			}
			results = append(results, r...)
			if e != 0 {
				exit = e
			}
			rs := RetiringStatus{Remaining: remaining, Done: done}
			for _, x := range r {
				if x.Status == "failed" && x.Error != "" {
					rs.LastError = shortError(x.Error) // 最後一筆失敗的真因——不然畫面只會說「還在收回」
				}
			}
			if retiring == nil {
				retiring = map[string]RetiringStatus{}
			}
			retiring[root] = rs
		}

		// 2026-08-07：把這輪（可能剛更新過的）額度冷卻／今天已萃份數寫回，
		// 供下一輪 RunDirectOnce（甚至下一次程序啟動——status.json 落地磁碟）復原。
		accSt.DailyIngestedDate = todayUTC(now)
		accSt.DailyIngestedCount = qs.DailyCount
		if qs.inCooldown(now) {
			accSt.QuotaCooldownUntil = qs.CooldownUntil.Format(time.RFC3339)
			notice := qs.noticeNow(now)
			accSt.QuotaMessage = &notice
			// 冷卻中一定代表萃取沒就緒——浮到頂層讓托盤「狀態：」直接看得到，
			// 不必展開帳號才發現「為什麼今天都沒有動靜」。
			extractorOK = false
			extractorError = notice.Combined()
		}
		// 冷卻已過且本輪沒有新命中 ⇒ QuotaCooldownUntil/QuotaMessage 維持零值，
		// 自然清除舊訊息（accSt 每輪重建，不會殘留上一輪的冷卻通知）。

		accountDetails[accHost] = accSt
	}

	// t91：每輪寫狀態檔（含 per-account 雲端版本與萃取計數）。
	if !dryRun && cfg.Manifest != "" {
		st := SyncStatus{
			LastSync:       time.Now().Format(time.RFC3339),
			ExtractorOK:    extractorOK,
			ExtractorError: extractorError,
			AccountDetails: accountDetails,
			Retiring:       retiring, // arcrun-rag#46：移除並收回中的資料夾進度
			Resync:         resync,   // arcrun-rag#140：雲端上找不到、正在自動補送的資料夾
		}
		// G-6.2：把「讀不了的檔」寫進狀態檔，App 首頁才有東西可以講。
		// 排序＝畫面每輪穩定（map 迭代順序隨機，不排的話清單會自己跳動）。
		st.SkippedOtherCount = skippedOther
		// 少量時點名（maxOtherNames 個以內）——leo 08-06 封測：只報「1 個」等於沒說。
		// 🔴 leo 2026-08-06 截圖：「有 2 個檔案沒有被整理」底下同一個檔名出現**兩次**。
		//    真兇：多帳號時同一個資料夾會被掃很多輪，每輪都把檔名 append 進來。
		//    ⇒ 去重（順帶讓總數與清單一致，不然使用者會覺得我們在亂數）。
		seen := map[string]bool{}
		uniq := skippedOtherNames[:0]
		for _, n := range skippedOtherNames {
			if !seen[n] {
				seen[n] = true
				uniq = append(uniq, n)
			}
		}
		skippedOtherNames = uniq
		sort.Strings(skippedOtherNames)
		if len(skippedOtherNames) > maxOtherNames {
			skippedOtherNames = skippedOtherNames[:maxOtherNames]
		}
		st.SkippedOtherNames = skippedOtherNames
		// #104：收檔策略與被排除的東西 —— 使用者要知道「有幾千個檔沒被收、為什麼」。
		if len(folderPlans) > 0 {
			st.FolderPlans = folderPlans
		}
		st.SkippedDocCount = len(skippedSeen)
		for _, sf := range skippedSeen {
			st.SkippedDocs = append(st.SkippedDocs, sf)
		}
		sort.Slice(st.SkippedDocs, func(i, j int) bool { return st.SkippedDocs[i].Path < st.SkippedDocs[j].Path })
		if len(st.SkippedDocs) > MaxSkippedListed {
			st.SkippedDocs = st.SkippedDocs[:MaxSkippedListed] // 總數仍在 SkippedDocCount，UI 說「等 N 個」
		}

		// t210：Unreadable 由呼叫端補進來（progress.go 的欄位註解）——G-6.2 的「讀不了的檔」
		// 根本沒進過 manifest，Progress() 算不到它們。併進 Total 才守得住 leo 08-08 驗法①
		// 「四個數字相加等於總數」（不變式：Total == Done+Pending+Stuck+Unreadable）。
		st.Progress = totalProgress
		st.Progress.Unreadable = st.SkippedDocCount
		st.Progress.Total += st.Progress.Unreadable
		// 「送不上去」＝Stuck＋Unreadable 的分類統計——Stuck 那些的真因已在 stuckReasons，
		// Unreadable 那些**本來就是**格式不支援（G-6.2 掃描白名單擋下的），直接重用
		// convert.go 的 ErrUnsupported 原文過同一個 ClassifyFailure 入口，不在這裡另造
		// 分類字串（t214 之後要把分類改成資料驅動，也只需要動 ClassifyFailure 一個接縫）。
		failReasons := append([]string{}, stuckReasons...)
		for i := 0; i < st.Progress.Unreadable; i++ {
			failReasons = append(failReasons, ErrUnsupported.Error())
		}
		st.FailureBreakdown = BuildFailureBreakdown(failReasons)

		// 頂層彙總（向後相容：單帳號時填頂層欄位讓舊版 tray 仍能讀）
		if cfg.Extractor != "" {
			for _, r := range results {
				if !countsAsDocument(r) {
					continue
				}
				switch r.Status {
				case "ingested":
					st.ExtractedOK++
				case "failed":
					st.ExtractFailed++
					st.Failures = append(st.Failures, ExtractFail{
						Path:  r.Path,
						Error: shortError(r.Error),
					})
				case "skipped":
					// 🔴 leo 2026-08-06：退避期間這個檔**不會**再產生 "failed"，
					//    於是 status.failures 是空的 ⇒ 畫面只剩「⚠ N 份失敗」沒有原因。
					//    退避訊息裡已經帶了上游真因（retrySkipReason），一併收進來，
					//    使用者才看得到「為什麼」而不只是「幾份」。
					// 2026-08-07：額度冷卻的 skip 訊息（quotaState.noticeNow().Combined()）
					// 用「會自動恢復」當識別字——同樣要讓使用者看得到原因，不是只看到「幾份」。
					if strings.Contains(r.Error, "後重試") || strings.Contains(r.Error, "已暫停自動重試") ||
						strings.Contains(r.Error, "會自動恢復") {
						st.Failures = append(st.Failures, ExtractFail{
							Path:  r.Path,
							Error: shortError(r.Error),
						})
					}
				}
			}
		}
		// 2026-08-07：巨量積壓場景（實據 27,164 檔）下 Failures 可能暴增到數千筆，
		// status.json 不該被撐成幾 MB 的清單——裁到跟 SkippedDocs 一樣的上限，
		// 總數仍在 ExtractFailed，UI 可以說「…等 N 個」（同 MaxSkippedListed 的做法）。
		if len(st.Failures) > MaxSkippedListed {
			st.Failures = st.Failures[:MaxSkippedListed]
		}
		// 頂層 cloud version／cloud_check_ok 給「只認得到一份版本號」的舊消費端
		// （向後相容；t103 時代單帳號才有這兩個頂層欄位）。
		//
		// 🔴 arcrun-rag#59 相關實查（2026-08-10，總管／leo 對照 curl，三台 /health 全部 200；
		// 詳見頂層 wiki `system-dev/wiki/status.md`「畫面在說謊」段）：以前這裡**只有剛好
		// 一個帳號**才填，2+ 帳號（leo 自己的常態）時 `st.CloudCheckOK` 停在 Go 零值
		// `false` 沒人填過 ⇒ 讀這個頂層欄位的地方會看到「沒連上雲端」，**即使每一個
		// 帳號都連得上**。改成：不論帳號數，只要**任一**帳號連得上就算連得上；
		// `CloudVersion` 取第一個非空版本代表（按 key 排序，同一份輸入永遠同一個輸出），
		// 不是宣稱所有帳號版本一致——**多帳號時真正該看的是各帳號自己的
		// AccountDetails，這裡只是不讓頂層欄位繼續說反話**。
		if len(accountDetails) > 0 {
			hosts := make([]string, 0, len(accountDetails))
			for h := range accountDetails {
				hosts = append(hosts, h)
			}
			sort.Strings(hosts)
			for _, h := range hosts {
				v := accountDetails[h]
				if v.CloudCheckOK {
					st.CloudCheckOK = true
				}
				if st.CloudVersion == "" && v.CloudVersion != "" {
					st.CloudVersion = v.CloudVersion
				}
			}
		}
		// 🔴 2026-08-05（leo：「自始至終都顯示『等待中』…實際上已經做完了，這個 status 是壞的」）：
		// 本輪有產出就記成「最近一次有做事」；本輪沒事做則把上一輪的原樣帶下來，
		// 不要讓「剛整理完 N 份」這個唯一的完成證據在 15 秒後被歸零抹掉。
		statusPath := StatusFilePath(cfg.Manifest)
		CarryForwardActivity(prevStatus, &st) // 2026-08-07：沿用函式開頭已載入的 prevStatus，不重讀一次
		if serr := SaveSyncStatus(statusPath, st); serr != nil {
			fmt.Fprintf(os.Stderr, "status 寫入失敗（不擋看守）：%v\n", serr)
		}

		// `inkstone/InkStoneCo#44`：本機那份樹快照。
		// 🔴 **刻意不放進 status.json**：桌面小幫手每秒讀一次 status.json（tick），
		//    而一棵樹上限 300 個節點、一台機器可能看守好幾個資料夾
		//    ⇒ 併進去等於讓每一秒都去解析幾百 KB 只有「使用者按開樹」那一刻才要用的資料。
		//    分成兩個檔，讀的人各取所需（小幫手只在展開時才讀這一份）。
		treePath := FolderTreeStorePath(cfg.Manifest)
		prevTrees, _ := LoadFolderTreeStore(treePath) // 讀不到＝沒有上一輪，零值可用
		if terr := SaveFolderTreeStore(treePath, MergeFolderTreeStore(prevTrees, folderTrees, knownRoots, now)); terr != nil {
			fmt.Fprintf(os.Stderr, "資料夾結構寫入失敗（不擋看守）：%v\n", terr)
		}
	}

	return results, exit, lastPayload
}

// shortError 把錯誤字串截為一句話（供 UI 顯示，不要超過 120 字）。
// shortError 限制錯誤訊息長度。
//
// 🔴 2026-08-06 放寬到 240：訊息現在會**帶上游真因**
//
//	（「上次失敗（第 4 次），58m 後重試｜原因：…Workers AI…4006: you have used up
//	  your daily free allocation of 10,000 neurons…」），
//	而真因在**後半段**——砍 120 會把它整段切掉，等於又回到「只說失敗不說原因」。
//	（leo 原則：別人的錯誤一律要顯示給用戶看。）
func shortError(msg string) string {
	const max = 240
	if len([]rune(msg)) <= max {
		return msg
	}
	runes := []rune(msg)
	return string(runes[:max]) + "…"
}

// CheckExtractor 預檢萃取器是否可用（不執行萃取、不打 API）。
// 只檢「可執行檔存在且可執行」或「金鑰非空」。
// extractor 空（舊制直送）一律回 (true, "")。
func CheckExtractor(cfg *DirectConfig) (ok bool, errMsg string) {
	switch cfg.Extractor {
	case "claude":
		// t176：claude 先不支援，等同 gemma（與 RunDirectOnce 的正規化保持一致，避免兩處漂移）。
		fallthrough
	case "gemma":
		if strings.TrimSpace(cfg.GeminiAPIKey) == "" {
			return false, "金鑰是空的——請在設定裡輸入 Gemini API Key"
		}
		return true, ""
	default:
		return true, ""
	}
}

// saveDirectConfig 把 DirectConfig 回寫到 configPath（t92：找到 claude fallback 路徑後持久化）。
// 只寫 claude_bin 等萃取相關欄位不會影響用戶的其他設定（JSON 完整覆蓋整個 config）。
func saveDirectConfig(configPath string, cfg *DirectConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0o600)
}

// drainPendingTakedowns 把 manifest 的「待下架」清單逐筆送去雲端撤除，成功一筆清一筆。
//
// 為什麼抽成共用函式（arcrun-rag#46）：撤除的能力本來就存在且驗過（改名／搬移的舊路徑、
// 被監看資料夾裡被刪掉的檔都走它），缺的只是**「整個資料夾被移除」這條路沒有呼叫它**。
// 修法是把既有那條路叫起來，不是在別的地方再寫一份撤除邏輯——同一件事有兩份實作，
// 就會像 2026-07-24 的 source_uri 鍵那樣各自漂移，而且只有真機 e2e 才抓得到。
//
// 🔴 payload 帶 library（arcrun-rag#46 邊界）：撤除的比對鍵是 (page_name, path)，而 path 是
// **相對於根**的路徑。兩個被監看的資料夾各自有 `notes.md` 時，兩邊的 (page_name, path) 完全
// 相同 ⇒ 撤除其中一個會連坐另一個。library 是逐根導出的（libraryFor），把它一起送上去，
// 雲端才有辦法只殺對的那一份。這與 ingest 送的 library 是**同一個函式**算出來的，
// 守 2026-07-24 那條教訓：成對操作（上架/下架）要用同一把鍵。
func drainPendingTakedowns(
	cfg *DirectConfig, m *Manifest, absRoot, resultType, failPrefix string,
	pace func(), dryRun bool, saveManifest func(),
) ([]DirectResult, int) {
	var results []DirectResult
	exit := 0
	if len(m.PendingTakedowns) == 0 {
		return results, exit
	}
	if dryRun {
		for oldPath := range m.PendingTakedowns {
			results = append(results, DirectResult{Type: resultType, Path: oldPath, Status: "planned"})
		}
		return results, exit
	}
	for oldPath, pageName := range m.PendingTakedowns {
		pace()
		res := DirectResult{Type: resultType, Path: oldPath}
		mach := cfg.machineIdentity()
		status, _, perr := cfg.postJSON(cfg.triggerURL(cfg.RemovedWF), map[string]any{
			"page_name":     pageName,
			"path":          oldPath,
			"library":       cfg.libraryFor(absRoot),
			"machine":       mach.ID,
			"machine_label": mach.Label,
		})
		res.HTTPStatus = status
		if perr != nil {
			res.Status, res.Error = "failed", failPrefix+perr.Error()
			exit = 1
		} else {
			res.Status = "removed"
			m.ClearTakedown(oldPath)
			// 同步清掉本地舊卡（若還存在)——與「removed」分支同一套清理。
			if cfg.Extractor != "" {
				cardAbs := filepath.Join(absRoot, filepath.FromSlash(cardRelFor(absRoot, pageName)))
				if _, serr := os.Stat(cardAbs); serr == nil {
					_ = os.Remove(cardAbs)
				}
				if werr := RemoveWikiDoc(absRoot, oldPath); werr != nil {
					results = append(results, DirectResult{
						Type: "warning", Path: oldPath, Status: "skipped",
						Error: "wiki 卡收走失敗（不擋下架）：" + werr.Error(),
					})
				}
			}
		}
		saveManifest()
		results = append(results, res)
	}
	return results, exit
}

// retireRootOnce 對「使用者已經按下移除並收回、但雲端還沒撤乾淨」的資料夾跑一輪撤除
// （arcrun-rag#46）。回傳結果、exit 建議、還剩幾筆沒撤成功、以及這個根是不是已經收乾淨。
//
// 為什麼不在 App 按下按鈕的當下同步做完：
//   - 一個資料夾可能有上萬筆（實據 27,164 檔），同步做＝畫面凍住；
//   - 雲端剛好掛掉／額度用完時，一次性的動作會**永久遺失**這些待辦——
//     這正是 PendingTakedowns 當初存在的理由（見 manifest.go 該欄位註解）。
//
// ⇒ App 只負責把資料夾搬進 `retiring_folders`（設定檔，App 是唯一寫入者），
// collector 每輪把它排進 manifest 的待辦清單、照既有那條撤除路慢慢送、失敗自動下輪重試。
// 收乾淨了就刪掉該根的 manifest 檔，並在 status.json 把這個根標成 done——
// **level-triggered**（每輪照現況重報，不是只報一次的事件），App 漏看一輪也不會卡住。
func retireRootOnce(cfg *DirectConfig, root string, dryRun bool) (
	results []DirectResult, exit int, remaining int, done bool,
) {
	absRoot, err := filepath.Abs(expandHome(root))
	if err != nil {
		return []DirectResult{{Type: "folder_takedown", Path: root, Status: "failed",
			Error: "解析資料夾路徑失敗：" + err.Error()}}, 1, 0, false
	}
	absManifest, err := filepath.Abs(cfg.manifestPathFor(absRoot))
	if err != nil {
		return []DirectResult{{Type: "folder_takedown", Path: root, Status: "failed",
			Error: "解析帳本路徑失敗：" + err.Error()}}, 1, 0, false
	}
	cfg.migrateManifestIfNeeded(absRoot, absManifest)

	// 沒有帳本＝這個根從來沒同步過（或已經收乾淨了）⇒ 雲端沒有它的東西，直接算完成。
	if _, serr := os.Stat(absManifest); errors.Is(serr, os.ErrNotExist) {
		return nil, 0, 0, true
	}
	m, err := LoadManifest(absManifest, absRoot)
	if err != nil {
		return []DirectResult{{Type: "folder_takedown", Path: root, Status: "failed",
			Error: "讀不了這個資料夾的帳本，暫不撤除（下輪重試）：" + err.Error()}}, 1, 0, false
	}

	// 第一輪：把帳本裡「真的送上去過」的檔案排進待辦，然後清空 entries。
	//
	// 🔴 只排 IngestedHash 非空的：沒成功送上去過的檔案，雲端根本沒有它——為它送一次
	// 撤除是零命中的空打。一個兩萬檔的資料夾裡若只有一百檔真的上去過，差別是 200 倍的
	// 雲端呼叫（而且會跟正常同步搶同一個節流器）。
	//
	// 清空 entries 讓這一步天然冪等：下一輪回來時 entries 已空、只剩沒送成功的待辦，
	// 不會把已經撤掉的又排一次。
	if len(m.Entries) > 0 && !dryRun {
		for path, e := range m.Entries {
			if e != nil && strings.TrimSpace(e.IngestedHash) != "" {
				m.QueueTakedown(path, pageNameOf(path))
			}
		}
		m.Entries = map[string]*ManifestEntry{}
		if serr := m.Save(absManifest); serr != nil {
			return []DirectResult{{Type: "folder_takedown", Path: root, Status: "failed",
				Error: "撤除待辦存檔失敗（下輪重試）：" + serr.Error()}}, 1, len(m.PendingTakedowns), false
		}
	} else if dryRun {
		for path, e := range m.Entries {
			if e != nil && strings.TrimSpace(e.IngestedHash) != "" {
				m.QueueTakedown(path, pageNameOf(path))
			}
		}
	}

	saveManifest := func() {
		if dryRun {
			return
		}
		if serr := m.Save(absManifest); serr != nil {
			results = append(results, DirectResult{Type: "folder_takedown", Path: root,
				Status: "failed", Error: "撤除待辦存檔失敗：" + serr.Error()})
		}
	}
	dr, de := drainPendingTakedowns(cfg, m, absRoot, "folder_takedown",
		"移除資料夾後的雲端撤除失敗（下輪重試）：", pace, dryRun, saveManifest)
	results = append(results, dr...)
	exit = de

	remaining = len(m.PendingTakedowns)
	if remaining == 0 && !dryRun {
		// 全部撤乾淨 ⇒ 帳本沒有存在的理由了。刪不掉不算失敗（下輪再刪；帳本已空，
		// 就算留著也只是個空檔，不會讓資料復活）。
		_ = os.Remove(absManifest)
		done = true
	}
	return results, exit, remaining, done
}

// runDirectOnceRoot 對單一根掃一輪、直送 added/modified/renamed、下架 removed，2xx 後回寫該根 manifest。
// retrySkipReason 產生「為什麼這輪跳過」的人話（t195）。
// 靜默跳過會讓使用者以為檔案被忽略了——狀態要說得出理由（t195 燈號誠實原則同源）。
func retrySkipReason(m *Manifest, path string, now int64) string {
	e, ok := m.Entries[path]
	if !ok {
		return "暫時跳過"
	}
	if e.FailCount >= MaxFailBeforeSkip {
		msg := fmt.Sprintf("連續失敗 %d 次，已暫停自動重試（改檔或按「立刻同步」會再試）", e.FailCount)
		if e.LastError != "" {
			msg += "｜原因：" + e.LastError
		}
		return msg
	}
	wait := e.NextRetry - now
	if wait < 0 {
		wait = 0
	}
	msg := fmt.Sprintf("上次失敗（第 %d 次），%s 後重試", e.FailCount, (time.Duration(wait) * time.Second).String())
	// 🔴 leo 2026-08-06：「別人的錯誤一律要顯示給用戶看，不然就會變成我的錯誤，導致客服」。
	//    只講「幾分鐘後重試」等於把上游的錯（Cloudflare 額度用完、檔案本身沒文字）
	//    藏起來 ⇒ 使用者只看得到我們在失敗。真因要一路帶到畫面上。
	if e.LastError != "" {
		msg += "｜原因：" + e.LastError
	}
	return msg
}

// accountsConnected 回答「這份設定連得上知識庫嗎」——**根層有 或 任一帳號有**。
// 抽成函式是為了測得到（見 multiaccount_connected_test.go）。
func accountsConnected(cfg *DirectConfig) bool {
	if strings.TrimSpace(cfg.CypherURL) != "" && strings.TrimSpace(cfg.APIKey) != "" {
		return true
	}
	for _, a := range cfg.Accounts {
		if strings.TrimSpace(a.CypherURL) != "" && strings.TrimSpace(a.APIKey) != "" {
			return true
		}
	}
	return false
}

// rootProgress＝單一資料夾（一份 manifest）算出來的 t210 統計素材。
//
// 為什麼跟 Progress 綁在一起回傳：兩者都是同一份 Manifest 快照的產物，
// 呼叫端（RunDirectOnce）要跨帳號、跨資料夾把它們累加成總量，缺一不可
// ——Progress 少了 StuckReasons 就湊不出「送不上去」展開後的分類統計。
type rootProgress struct {
	Progress     SyncProgress // 這一根的 Total/Done/Pending/Stuck（Unreadable 由呼叫端補，見 progress.go）
	StuckReasons []string     // 已放棄自動重試那些條目的 LastError 原文，交給 ClassifyFailure 分類
	// Resync＝這一根的「雲端補送」現況（#140）。**從 manifest 現況重算**，不是本輪計數
	// ——後者在沒事做的那輪會歸零，那正是 2026-08-05 leo 實撞的「明明做完了畫面卻寫等待中」。
	// 沒事＝零值，呼叫端不寫進 status.json（不製造常駐噪音）。
	Resync ResyncStatus
	// Tree＝這一根這一輪算出來的資料夾樹（`inkstone/InkStoneCo#44`，桌面小幫手那半）。
	// 🔴 **就是送上雲端的那一棵**（BuildFolderTree 的產物原件），不是為了畫面另算一份。
	//    呼叫端把它落地成 folder-trees.json，小幫手離線也攤得開（理由見 foldertree.go 檔尾）。
	Tree FolderTree
}

// qs：這個帳號本輪共用的額度冷卻狀態（跨同帳號的多個監看根，見 quota.go）。
// runNow：整輪 RunDirectOnce 共用的時間點（排序/冷卻判斷一致、好測試）。
func runDirectOnceRoot(cfg *DirectConfig, root string, dryRun bool, qs *quotaState, runNow time.Time) ([]DirectResult, int, *TriggerPayload, rootProgress) {
	results := []DirectResult{}
	exit := 0

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return append(results, DirectResult{Status: "failed", Error: err.Error()}), 1, nil, rootProgress{}
	}
	absManifest, err := filepath.Abs(cfg.manifestPathFor(absRoot))
	if err != nil {
		return append(results, DirectResult{Status: "failed", Error: err.Error()}), 1, nil, rootProgress{}
	}
	cfg.migrateManifestIfNeeded(absRoot, absManifest) // t86b：一次性遷移舊格式帳本
	// arcrun-rag#60：把上一版 daemon 落下的舊卡歸位——沒帶 arcrun- 標記的改名，
	// 位置不對的（第三輪：監看根在筆記庫裡，卡卻落在看得見的 system-dev/wiki/cards/）搬進隱藏目錄。
	// 自動跑而不是叫人下指令——leo 的紅線：「他不該為了保護自己的筆記去學新選項」。
	// 目標已存在就跳過、永不刪檔，見 tidy.go。
	// template 殘留不在這裡處理：那要人確認「這是不是你自己的 repo」，走 `collector tidy`。
	//
	// 🔴 arcrun-rag#105：監看根在版控裡時**一個檔都不動**（MigrateCardNames 自己擋），
	// 這裡負責把「沒動、以及為什麼沒動」講出來——靜默跳過等於讓使用者猜。
	if !dryRun {
		// daemon 自己的工作區先自我忽略，之後落卡/收容/身分標記檔才不會弄髒使用者的
		// git status（#105 驗收條件就是「跑一輪 git status 必須乾淨」）。
		EnsureWorkspaceIgnored(absRoot)
		mig := MigrateCardNames(absRoot)
		if mig.Moved > 0 {
			results = append(results, DirectResult{
				Type: "warning", Path: absRoot, Status: "skipped",
				Error: fmt.Sprintf("已把 %d 張舊卡片歸位（加上 arcrun- 前綴／搬離筆記軟體看得到的位置）", mig.Moved),
			})
		}
		if mig.Blocked > 0 {
			results = append(results, DirectResult{
				Type: "warning", Path: absRoot, Status: "skipped",
				Error: fmt.Sprintf(
					"這個資料夾在版本控制裡（%s），所以有 %d 個舊卡片我沒有自動整理"+
						"——改名搬移會變成你 git status 上的刪除。要整理請自己跑："+
						"collector tidy --folder %s（先看清單，確認後再加 --apply）",
					mig.RepoRoot, mig.Blocked, absRoot),
			})
		}
	}
	m, err := LoadManifest(absManifest, absRoot)
	if err != nil {
		return append(results, DirectResult{Status: "failed", Error: err.Error()}), 1, nil, rootProgress{}
	}
	// 2026-08-07 task 3（斷點續傳）：每個事件處理完就立刻存檔，不要等整輪跑完。
	// 舊行為＝整個 for 迴圈跑完才 Save 一次——process 在跑到一半被殺掉（重開機、
	// 換版、當機）時，**已經成功的那些也會遺失**，下次重開等於從頭來過，
	// 且已經花掉的額度/請求全部白費（正是 leo 要求「不從頭來」要防的事）。
	// 改成每個事件收工就存一次：kill 在任何一刻，磁碟上的 manifest 都反映
	// 「這一刻之前已確定成功的事」，下一輪只會處理真正還沒做完的。
	//
	// （#140：定義位置從「Scan() 之後」往上搬到這裡，因為雲端對帳跑在 Scan() 之前
	//  也要落盤——拔掉的章沒存進磁碟，process 被殺掉就等於沒對過帳。內容一字未動。）
	saveManifest := func() {
		if dryRun {
			return
		}
		if serr := m.Save(absManifest); serr != nil {
			results = append(results, DirectResult{Status: "failed", Error: "manifest 存檔失敗（斷點續傳可能失效）：" + serr.Error()})
			exit = 1
		}
	}

	// 🔴 雲端對帳（`inkstone/arcrun-rag#140`，2026-08-26）——**必須在 Scan() 之前**。
	// 它做的唯一一件事是把「雲端已經沒有了」的 ingested 章拔掉；拔完之後
	// 下面那個 Scan() 就會因為 `orig[p].IngestedHash == ""` 自然補一發 added 事件
	// （scan.go 步驟 4 的既有語意「上輪偵測過但 ingest 未成功 → 重試」）
	// ⇒ 補送走的是**既有的**萃取路，既有的單輪上限／失敗退避／額度冷卻全部照舊生效。
	// 放在 Scan() 之後就得再等一輪才會動，且要另外發明一條送件路。見 cloud_audit.go。
	auditErr := ""
	if ar := auditCloudLedger(cfg, absRoot, m, dryRun, runNow); ar != nil {
		auditErr = ar.Err
		if ar.Voided > 0 {
			results = append(results, DirectResult{
				Type: "resync", Path: absRoot, Status: "noticed",
				Error: fmt.Sprintf("雲端上找不到 %d 份先前送過的檔案（對帳了 %d 份，知識庫可能重裝過），已排進佇列自動補送", ar.Voided, ar.Checked),
			})
		}
		if ar.Err != "" {
			// 上游錯誤原文照顯示（leo 2026-08-06：「別人的錯誤一律要顯示給用戶看，
			// 不然就會變成我的錯誤」）。對帳失敗**不設 exit**：它是保險絲不是主流程，
			// 連不上雲端時檔案同步照常走。
			results = append(results, DirectResult{
				Type: "resync", Path: absRoot, Status: "noticed",
				Error: "無法跟雲端核對哪些檔案還在（不影響同步，稍後自動再試）：" + ar.Err,
			})
		}
		saveManifest() // 拔掉的章與對帳時間當下就落盤（斷點續傳同款）
	}

	// 2026-08-07 task 3：Scan() 會把 removed 的路徑從 m.Entries 整批拿掉（rebuild 語意，
	// 見 scan.go 步驟 7）——但那只是「偵測到不見了」，不代表下架 POST 已經成功。
	// 沒有這份快照的話，本輪只要有任何一個 added/modified 事件先觸發了下面的
	// incremental saveManifest()，就會把「還沒確認下架成功」的路徑一併存進磁碟，
	// 下一輪 Scan() 兩邊都找不到它 ⇒ 永遠不會再補發 removed 事件、下架永遠不會重試。
	// 先存一份，Scan() 後把這些路徑「暫時放回去」，直到對應的 removed 事件真的成功。
	preScanEntries := make(map[string]*ManifestEntry, len(m.Entries))
	for k, v := range m.Entries {
		preScanEntries[k] = v
	}
	// arcrun-rag#104：走訪之前先問「這個資料夾是什麼」——是開發專案就只讀它整理好的
	// wiki（沒有 wiki 才退到文件區），是一般資料夾／筆記庫才全收。見 ingestplan.go。
	plan := PlanIngest(absRoot)

	// 🔴 2026-08-16：這裡以前還手捏了**第二張**排除表
	//（`skipDirNames := {"system-dev": true}`，daemon-beta task 2 的 template 產物區保護），
	// 而 #104 的排除清單住在 ingestplan.go。**兩張表分居兩處** ⇒ 2026-08-16 讀源碼的人
	// 只看到這一張，就把「排除清單根本沒接上」寫成了真兇——實際上兩張都接上了
	//（下面那行 `Plan: plan` 就是）。誤判本身正是「同一件事有兩個地方管」的代價。
	// ⇒ 那條保護已搬進 IngestPlan（templateOwnedDirNames），連同「curated-wiki 模式
	//   要收的正是 system-dev/wiki」這個例外一起 ⇒ **判準只剩一個地方，沒有第二張表可漏看。**
	payload, err := Scan(absRoot, m, ScanOptions{
		MaxRemovedRatio: cfg.MaxRemoved,
		SkipPaths: map[string]bool{
			absManifest: true,
			// template 代裝的根層 CLAUDE.md 是 CC 設定檔，永遠不是用戶知識（task 2）
			filepath.Join(absRoot, "CLAUDE.md"): true,
		},
		Plan: plan,
	})
	if err != nil {
		return append(results, DirectResult{Status: "failed", Error: err.Error()}), 1, nil, rootProgress{}
	}

	now := runNow.Unix()

	// 結構先行（InkStoneCo#43，2026-08-15）：掃描一結束（純本機、免費、秒級）就先把
	// 「這個資料夾有哪些檔案／最近改了什麼」送上知識庫，**不等 LLM 萃取、不受額度影響**
	// ——走 rag_ingest_card（零 LLM 的機械收口），所以刻意放在：
	//   ① 逐檔萃取迴圈之前——萃取可能要跑幾小時（積壓）甚至幾天（等額度），
	//     結構性問題不該跟它排同一條隊；
	//   ② qs.inCooldown 的閘之外——額度撞牆期間這正是使用者唯一還能問的東西；
	//   ③ 「removed 暫時放回」之前——總覽反映檔案系統**現況**，剛刪掉的檔
	//     不該還列在清單上（放回只是下架重試的記帳，不是現況）。
	// 冪等與失敗處理見 syncInventory 註解；失敗不設 exit（加值層壞了不擋檔案同步）。
	if invRes := syncInventory(cfg, absRoot, m, len(payload.Events) > 0, dryRun, runNow); invRes != nil {
		results = append(results, *invRes)
		if invRes.Status != "planned" {
			saveManifest() // 記住 inventory_hash／失敗退避（斷點續傳同款：當下就落盤）
		}
	}

	// 碎形目錄索引（`inkstone/Arcrun#146`，leo 2026-08-19「每個巢狀資料夾都要有 index，
	// 且每一層指向子層次目錄」）：接在總覽卡後面，同一個理由放在萃取迴圈之前——
	// 目錄結構是本機掃一遍就有的答案，不該跟 LLM 排同一條隊、不該被額度牆擋住。
	// 一卡一關聯（見 folderindex.go 檔頭）⇒ 單一請求恆定 1 條 rel，不受資料夾數量影響。
	if fcRes := syncFolderCards(cfg, absRoot, m, len(payload.Events) > 0, dryRun, runNow); len(fcRes) > 0 {
		results = append(results, fcRes...)
		if fcRes[0].Status != "planned" {
			saveManifest() // 同上：folder_card_hashes 當下就落盤，斷點續傳才接得上
		}
	}

	// InkStoneCo#44 線 A（leo 2026-08-17）：把「這個資料夾長什麼樣、每一層同步了幾份／
	// 總共幾份」送上 portal。與上面的總覽卡刻意分開——那張是給檢索用的 markdown 卡，
	// 這棵是給畫面用的結構化資料，消費者不同（理由全文見 foldertree.go 檔頭）。
	//
	// 位置與總覽卡同一段的三個理由完全通用（不等 LLM／在額度閘之外／反映現況），
	// 再加第四個**只屬於它**的：**空資料夾一個事件都不會有**（arcrun-rag#106 的情境本身），
	// 所以它不能被任何「有事件才做」的閘擋住——分子分母都由現況算出，靜止時
	// 內容雜湊自然擋住重送，不需要事件當第二道閘。
	tree := BuildFolderTree(absRoot, cfg.libraryFor(absRoot), payload.DirStats, m.Entries,
		payload.AllExcludedDirs, plan, runNow)
	if treeRes := syncFolderTree(cfg, absRoot, m, tree, dryRun, runNow); treeRes != nil {
		results = append(results, *treeRes)
		if treeRes.Status != "planned" {
			saveManifest() // 記住 folder_tree_hash／失敗退避
		}
	}

	// 承上：把本輪偵測到的 removed 路徑暫時放回 m.Entries，直到迴圈裡真的處理到它、
	// POST 成功才由「removed」分支明確刪除。失敗或本輪還沒輪到（單輪上限）都維持放回的狀態，
	// 下一輪自然重新偵測、重新嘗試下架——不會因為別的事件先存檔而被誤永久跳過。
	for _, ev := range payload.Events {
		if ev.Type == "removed" {
			if e, ok := preScanEntries[ev.Path]; ok {
				m.Entries[ev.Path] = e
			}
		}
	}

	// InkStoneCo#44 ⑩：改名／搬移後,舊路徑在雲端知識庫裡要跟著下架,否則舊卡永久留著
	// （純改檔名）或同一份文件在庫裡變兩套（搬到別的資料夾,新舊頁名相同）。
	// renamed 事件只在 removed×added 配對到的那一輪出現一次（見 scan.go 步驟 3),
	// 下一輪不會再有機會補發——所以「這個舊路徑要下架」必須在偵測到的當下就
	// 寫進 manifest（QueueTakedown,持久化),不能只靠事件迴圈處理到才記,否則單輪
	// 上限（perRunCap）把它排除在外、或這輪下架失敗時就會永久遺失這個待辦。
	for _, ev := range payload.Events {
		if ev.Type == "renamed" && ev.OldPath != "" {
			m.QueueTakedown(ev.OldPath, pageNameOf(ev.OldPath))
		}
	}
	if len(m.PendingTakedowns) > 0 && !dryRun {
		saveManifest()
	}

	// 2026-08-07 pacing task 1：新改的檔優先＋單輪上限。
	//   - 排序：把 payload.Events 依檔案 mtime 由新到舊重排（不動送雲端的 payload 本身，
	//     只重排這裡的本機處理佇列——見 sortEventsNewestFirst 註解）。
	//   - 上限：巨量積壓（實據 27,164 檔）不該一輪湧完；超過上限的事件本輪不碰，
	//     manifest 未標 ingested ⇒ 下一輪 Scan() 自然重新出現（且若使用者這期間
	//     寫了新檔，新檔的 mtime 更新，下一輪排序會插到最前面，不會被積壓卡住）。
	orderedEvents := sortEventsNewestFirst(absRoot, payload.Events)
	perRunCap := cfg.effectiveMaxEventsPerRun()
	deferredCount := 0
	if len(orderedEvents) > perRunCap {
		deferredCount = len(orderedEvents) - perRunCap
		orderedEvents = orderedEvents[:perRunCap]
	}

	for _, ev := range orderedEvents {
		switch ev.Type {
		case "added", "modified", "renamed":
			// renamed 在 direct 模式視同 added：內容未變但為求 kbdb 有這頁名的卡，重送一次萃取
			//（頁名可能改變＝要新頁名的卡）。新路徑這邊的冪等由 kbdb 端承擔（同頁名覆蓋語意）；
			// 舊路徑那邊不會自動消失——上面已經把 ev.OldPath 排進 m.PendingTakedowns，
			// 這裡送完新卡之後、本函式結尾會補打下架（InkStoneCo#44 ⑩）。
			res := DirectResult{Type: ev.Type, Path: ev.Path}
			// 2026-08-07 pacing task 2：帳號還在額度冷卻中 → 這輪連試都不試。
			// 這不是這個檔的問題（不記 FailCount/退避——那是「這個檔」的病歷，
			// 額度用完是「整個帳號」的狀態，混在一起會讓退避階梯失真）。
			// 放在 ShouldRetry 之前：冷卻是更高層級的條件，沒必要先算退避訊息又蓋掉。
			if qs.inCooldown(runNow) {
				res.Status = "skipped"
				res.Error = qs.noticeNow(runNow).Combined()
				results = append(results, res)
				continue
			}
			// 🔴 t195 止血點：這個檔剛失敗過且還在退避窗口內 → 這輪跳過。
			//   沒有這道閘時的實測災情：`小果被AFTEE詐貸.pdf` 因雲端 401 失敗，
			//   每輪重掃又被當成新檔 ⇒ **1387 輪、跨 11 小時**，且它排在佇列前面，
			//   **整個資料夾的同步被一個壞檔拖住**（leo：「原先萃檔案速度也快，
			//   現在也花了十幾分才萃完」——萃取沒變慢，慢的是重試）。
			//   退避階梯 1m→5m→15m→1h→6h；連續失敗 8 次後暫停自動重試。
			//   使用者改檔（hash 變）或按「立刻同步」時仍會重試，不會永久卡死。
			if !m.ShouldRetry(ev.Path, now, cfg.ForceSync) {
				res.Status = "skipped"
				res.Error = retrySkipReason(m, ev.Path, now)
				results = append(results, res)
				continue
			}
			full := filepath.Join(absRoot, filepath.FromSlash(ev.Path))
			content, rerr := os.ReadFile(full)
			if rerr != nil {
				res.Status, res.Error = "failed", "讀檔失敗："+rerr.Error()
				m.MarkFailed(ev.Path, now, res.Error) // t195：讀不到的檔也退避（權限／被鎖／壞掉的外接碟）
				saveManifest()
				results = append(results, res)
				exit = 1
				continue
			}
			if dryRun {
				res.Status = "planned"
				results = append(results, res)
				continue
			}
			pace() // 2026-08-07：每次要觸發雲端（萃取／POST）之前先節流一下
			if cfg.Extractor != "" {
				// 四步定稿：本地萃卡 → 每張卡 POST rag_ingest_card（原文不出機）
				var cards []string
				var xerr error
				switch cfg.Extractor {
				case "workers-ai":
					// t181（leo 08-04 最優先）：走自己雲端實例的 Workers AI ⇒ **免金鑰**。
					// 用戶不必去 Google 申請、也不受 Google 帳號被 flag 影響。
					// 🔴 t182：雲端還沒更新時**不在這裡默默退回 Gemini**。
					// leo 08-04 指定的設計是「掃一次、把狀態講出來」：
					//   「沒裝好就顯示 workers AI 還沒通，一旦通了就顯示可用」
					// ⇒ 探測在 RunDirectOnce（ProbeWorkersAI），結果寫進 status.json，
					//   托盤那行「狀態：」直接告訴用戶該做什麼。
					// 靜默退回會讓用戶**永遠不知道自己的雲端還沒更新**——正是要避免的黑箱。
					cards, xerr = ExtractWithWorkersAI(cfg.CypherURL, cfg.APIKey, absRoot, ev.Path)
				case "gemma":
					cards, xerr = ExtractWithGemma(cfg.GeminiAPIKey, cfg.LLMModel, absRoot, ev.Path)
				default:
					// t176：claude 路先不支援（RunDirectOnce 開頭已正規化）。
					// 走到這裡代表 config 有沒見過的值——誠實報錯，不要靜默跳過（禁假綠）。
					xerr = fmt.Errorf("不支援的萃取方式 %q（支援：workers-ai／gemma）", cfg.Extractor)
				}
				if xerr != nil {
					// 2026-08-07 task 2：Workers AI 每日免費額度用完是**已知的上游狀況**
					// （wiki mistakes.md 2026-08-06），不是 bug——不能讓使用者看到裸露的
					// 「4006」「HTTP 502」，要換成三句話（成就／出口／保證），且不能再
					// 每輪繼續撞同一面牆（qs.markHit 設定帳號層級的冷卻，下一個事件、
					// 下一輪都會被上面的 qs.inCooldown 擋下，不再嘗試萃取）。
					if isQuotaExhausted(xerr.Error()) {
						qs.markHit(runNow, xerr.Error())
						res.Status, res.Error = "failed", qs.noticeNow(runNow).Combined()
					} else {
						res.Status, res.Error = "failed", "本地萃取失敗："+xerr.Error()
					}
					// t195：萃取階段失敗同樣要記退避。**這條路徑比上傳更早**，
					// 漏記的話（連不上知識庫、金鑰壞、模型錯）照樣每輪重撞。
					m.MarkFailed(ev.Path, now, res.Error)
					saveManifest()
					results = append(results, res)
					exit = 1
					continue
				}
				ok := true
				// InkStoneCo#44 ④（2026-08-15）：gemma 路現在一份文件產「文件卡＋N 張
				// 概念卡」（cards[0]＝文件卡）。雲端 rag_ingest_card 以 page_name upsert、
				// 下架以原稿頁名比對 ⇒ N 張卡都送會互相蓋寫同一頁。
				// ⇒ 本環先只送文件卡（雲端行為與改版前一致）；原子卡與三元組上雲的
				// 形狀是第⑤環（Arcrun#129/#130）的題目，屆時在這裡展開。
				// cards 為空＝該檔被判「無可萃取概念」（00-INDEX 已標「空」），不送雲端。
				for cardIdx, cardRel := range cards {
					cardData, cerr := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(cardRel)))
					if cerr != nil {
						res.Status, res.Error = "failed", "讀卡片失敗："+cerr.Error()
						ok = false
						break
					}
					// B2 品質檢查（草案 §3 第一層）：萃完、POST 前跑。原稿在手＝H6 可做。
					// 硬缺（H1/H2/H5）＝拒收、不 POST、標 failed（manifest 不回寫＝下輪重萃自癒）；
					// 軟項（H3/H4/H6）＝照送但帶 quality:low＋quality_warnings（裁決 T4-C）。
					lr := LintCard(string(cardData), LintOptions{Source: string(content)})
					if lr.Blocks(cfg.LintStrict) {
						res.Status = "rejected"
						res.Error = "品質未過（不送）：" + strings.Join(append(lr.HardMessages(), lr.SoftMessages()...), "；")
						ok = false
						break
					}
					// path 帶「原檔路徑」不是卡片路徑（07-24 真機第五枚坑）：
					// source_uri=kb://<path> 是 takedown 的比對鍵，也是 B4 溯源該指的原文——
					// 帶卡片路徑會讓「刪原檔→下架」永遠 0 命中。
					// 🔴 arcrun-rag#60 第二輪：page_name 必須跟著**原稿**走，不是跟著卡片檔名走。
					//   卡片檔名這一輪加了 `arcrun-` 前綴（machinemark.go），若這裡繼續用
					//   pageNameOf(cardRel)，雲端頁名會變成 `arcrun-<原頁名>`，而下架分支用的是
					//   pageNameOf(ev.Path)（原稿頁名，不帶前綴）⇒ 兩邊從此對不上，
					//   「刪原檔→下架」永遠 0 命中，跟 07-24 那枚 source_uri 的坑同一個形狀。
					//   改成原稿頁名後，**雲端看到的頁名與改版前完全相同**（本次只動本機檔名）。
					if cardIdx > 0 {
						continue // 概念卡先只落本機 .wiki（品質檢查照跑），上雲等第⑤環
					}
					// machine／machine_label（`inkstone/mira#6`）：與 library 同一個位置、
					// 同一個理由——library 分得開「同一台機器的兩個資料夾」，machine 分得開
					// 「兩台機器的同一個相對路徑」。少送這一維，雲端就只能把兩台的同名檔
					// 當成同一份（先到的被後到的蓋掉，而且是無聲的）。
					mach := cfg.machineIdentity()
					cardBody := map[string]any{
						"page_name":     pageNameOf(ev.Path),
						"path":          ev.Path,
						"card_content":  string(cardData),
						"library":       cfg.libraryFor(absRoot),
						"machine":       mach.ID,
						"machine_label": mach.Label,
					}
					if warns := lr.SoftMessages(); len(warns) > 0 {
						cardBody["quality"] = "low"
						cardBody["quality_warnings"] = warns
					}
					status, _, perr := cfg.postJSON(cfg.triggerURL(cfg.CardIngestWF), cardBody)
					res.HTTPStatus = status
					if perr != nil {
						res.Status, res.Error = "failed", perr.Error()
						ok = false
						break
					}
				}
				if ok {
					res.Status = "ingested"
					// 記下是誰萃的（t73/leo 07-27）：換萃取器時才分辨得出哪些卡是舊的。
					m.MarkIngestedBy(ev.Path, ev.SourceHash, now, cfg.Extractor)
					// 🔴 #140：`cards` 為空＝該檔被判「無可萃取概念」，這一輪**一張卡都沒上雲**。
					//   不記下來的話，雲端對帳每天都會查到「雲端沒有它」⇒ 每天重萃一次、
					//   永遠停不下來，而且每次都燒一份 AI 額度。
					if len(cards) == 0 {
						m.MarkNoCloudCard(ev.Path)
					}
					qs.DailyCount++ // 2026-08-07：今天的成就數（額度訊息「今天已經幫你整理了 N 份」用）
				} else {
					// t195：記下失敗並排定退避，否則下輪又把它當新檔重試
					//（實撞：1387 輪 × 11 小時全在撞同一面 401 的牆，還拖住整個佇列）。
					m.MarkFailed(ev.Path, now, res.Error)
					exit = 1
				}
				saveManifest()
				results = append(results, res)
				continue
			}
			// t108 防禦閘：extractor 未設定時，非 .md/.txt 檔禁止直送原文（原文外洩保險絲）。
			// 讓同類 bug 永遠不再變成內容外洩，而是明確的 failed 狀態。
			if ext := strings.ToLower(filepath.Ext(ev.Path)); ext != ".md" && ext != ".txt" {
				res.Status = "failed"
				res.Error = "萃取器未設定，已跳過（不直送原文）"
				results = append(results, res)
				exit = 1
				continue
			}
			// 舊的「原文直送雲端萃取」路（rag_ingest_direct）。它與收卡路送同一組欄位，
			// 免得日後有人比對兩條路時看到「一條有 machine 一條沒有」而以為是 bug。
			// ⚠️ 雲端這支 workflow 本輪**沒有跟著改**（youlin stage 上根本沒部署它，
			// 現役是 rag_ingest_card）——它會忽略這兩個欄位，行為與從前一字不差。
			machDirect := cfg.machineIdentity()
			status, _, perr := cfg.postJSON(cfg.triggerURL(cfg.IngestWF), map[string]any{
				"page_name":     pageNameOf(ev.Path),
				"path":          ev.Path,
				"content":       string(content),
				"library":       cfg.libraryFor(absRoot),
				"machine":       machDirect.ID,
				"machine_label": machDirect.Label,
			})
			res.HTTPStatus = status
			if perr != nil {
				res.Status, res.Error = "failed", perr.Error()
				exit = 1
			} else {
				res.Status = "ingested"
				m.MarkIngested(ev.Path, ev.SourceHash, now) // 2xx 才回寫（下輪不重送）
				qs.DailyCount++
			}
			saveManifest()
			results = append(results, res)

		case "removed":
			res := DirectResult{Type: ev.Type, Path: ev.Path}
			if dryRun {
				res.Status = "planned"
				results = append(results, res)
				continue
			}
			pace() // 2026-08-07：下架一樣是觸發雲端 workflow，同樣節流
			// 下架＝POST {page_name, path} 進 rag_takedown_direct（按 page_name 讀 kbdb blocks
			// 標 deprecated，不碰 R2；獨立於 rag_ingest 的 __CARDS_PREFIX__ 閘——direct 模式檔在
			// 資料夾根，會被 rag_ingest 的前綴閘擋掉，故自帶不含前綴閘的下架 workflow）。
			// machine（`inkstone/mira#6`）：這條分支歷來只送 {page_name, path}
			// （library 是 arcrun-rag#46 只補在 drainPendingTakedowns 那條路上的）。
			// 這裡只補 machine、**不順手補 library**：machine 已足以擋住「A 機器刪檔
			// 連坐殺掉 B 機器同名檔」，而多補一維會改變既有的撤除命中範圍——
			// 那是另一件事，要另外驗（本輪不驗的不做）。
			machRm := cfg.machineIdentity()
			status, _, perr := cfg.postJSON(cfg.triggerURL(cfg.RemovedWF), map[string]any{
				"page_name":     pageNameOf(ev.Path),
				"path":          ev.Path,
				"machine":       machRm.ID,
				"machine_label": machRm.Label,
			})
			res.HTTPStatus = status
			if perr != nil {
				res.Status, res.Error = "failed", perr.Error()
				exit = 1
				// 2026-08-07：下架失敗——保持上面「暫時放回」的狀態，不刪、不存檔。
				// 下一輪 Scan() 會重新偵測到這個檔仍然不見了，自然重新補發 removed 事件。
			} else {
				res.Status = "removed"
				// 2026-08-07 task 3：下架真的成功了，這時才正式從 manifest 拿掉並存檔
				// （不是 Scan() rebuild 時就拿掉——那時只是「偵測到不見了」，不是「已下架」）。
				delete(m.Entries, ev.Path)
				saveManifest()
				// t15：extractor 模式雲端下架成功後，同步清掉本地萃出的卡，保持本地與雲端一致。
				// arcrun-rag#60：清除路徑必須跟落卡路徑**同一個函式**算出來（cardRelFor）——
				// 目錄或檔名任一邊不同步就清不到卡、留下孤兒檔。第一輪對齊了目錄，
				// 第二輪加了檔名前綴，所以連「拼檔名」這件事也一起收進 cardRelFor。
				// 存在才刪；刪失敗只記 warning 不擋（下架本體已成功）。
				if cfg.Extractor != "" {
					cardAbs := filepath.Join(absRoot, filepath.FromSlash(cardRelFor(absRoot, pageNameOf(ev.Path))))
					if _, serr := os.Stat(cardAbs); serr == nil {
						if rerr := os.Remove(cardAbs); rerr != nil {
							results = append(results, DirectResult{
								Type: "warning", Path: cardAbs, Status: "skipped",
								Error: "本地卡刪除失敗（不擋下架）：" + rerr.Error(),
							})
						}
					}
					// InkStoneCo#44 ④：新制 `.wiki/` 的卡（文件卡＋概念卡）＋索引＋manifest
					// 一起收走——鍵同樣是原稿路徑，與上面的舊制清理並存（過渡期兩制都可能有卡）。
					if werr := RemoveWikiDoc(absRoot, ev.Path); werr != nil {
						results = append(results, DirectResult{
							Type: "warning", Path: ev.Path, Status: "skipped",
							Error: "wiki 卡收走失敗（不擋下架）：" + werr.Error(),
						})
					}
				}
			}
			results = append(results, res)
		}
	}

	// InkStoneCo#44 ⑩：補打「改名／搬移後還沒下架成功」的舊路徑——包含本輪剛
	// 上面排進去的，以及之前輪次失敗留下的（同一個待辦清單,一次處理完)。
	// 與 orderedEvents 共用同一個節流器（pace）,避免一輪多筆改名瞬間打爆雲端。
	dr, de := drainPendingTakedowns(cfg, m, absRoot, "renamed_takedown",
		"改名/搬移後舊頁下架失敗（下輪重試）：", pace, dryRun, saveManifest)
	results = append(results, dr...)
	if de != 0 {
		exit = de
	}

	// 防呆警告輪：Scan 已壓下 removed 事件，這裡只回報警告不下架。
	for _, w := range payload.Warnings {
		results = append(results, DirectResult{Type: "warning", Status: "skipped", Error: w.Code + ": " + w.Message})
	}

	// 2026-08-07 pacing task 1：本輪因單輪上限被延後的事件——不是失敗，是刻意排隊，
	// 不佔用 exit（不該讓「積壓還很多」看起來像出錯了）。
	if deferredCount > 0 {
		results = append(results, DirectResult{Type: "info", Status: "skipped", Error: resumeAfterCapMessage(deferredCount)})
	}

	if !dryRun {
		// 2026-08-07：每個事件處理完都已個別呼叫 m.Save（見下方迴圈內），這裡是最後的
		// 安全網——涵蓋防呆警告輪等不對應單一事件的狀態變化，多存一次無害（原子寫入）。
		if err := m.Save(absManifest); err != nil {
			results = append(results, DirectResult{Status: "failed", Error: "manifest 存檔失敗：" + err.Error()})
			exit = 1
		}
	}

	// t210：manifest 走到這裡已經是本輪最終狀態（每個事件處理完就地更新），
	// 原地數一次就是對的（同 SkippedDocCount 那套「現況快照」邏輯，不必另外維護計數器）。
	rp := rootProgress{Progress: m.Progress(), Tree: tree}
	for _, e := range m.Entries {
		if e != nil && e.FailCount >= MaxFailBeforeSkip {
			// LastError 原文交給呼叫端彙總後過 ClassifyFailure——分類判斷只住那一個接縫，
			// 這裡不判斷任何識別字，即使 LastError 是空字串也照樣送（ClassifyFailure("") 落「其他」，
			// 不會漏算份數）。
			rp.StuckReasons = append(rp.StuckReasons, e.LastError)
		}
	}
	// #140：同一套「現況快照」邏輯——補送進度也是原地數出來的，不是本輪計數器。
	if pending, repaired := ResyncSummary(m, runNow); pending > 0 || repaired > 0 || auditErr != "" {
		rp.Resync = ResyncStatus{
			Pending:   pending,
			Repaired:  repaired,
			LastError: auditErr, // 真因原文，不改寫（leo 2026-08-06）
			Note:      resyncNote(pending, repaired, auditErr),
		}
		if m.CloudAuditAt > 0 {
			rp.Resync.CheckedAt = time.Unix(m.CloudAuditAt, 0).UTC().Format(time.RFC3339)
		}
	}
	return results, exit, payload, rp
}

// runDirect 是 `collector direct` 子命令主體。
func runDirect(args []string) int {
	fs := newFlagSet()
	configPath := fs.String("config", "", "direct 模式設定檔（JSON）路徑（必填）")
	once := fs.Bool("once", false, "掃一輪即退出（測試/cron；預設常駐輪詢）")
	dryRun := fs.Bool("dry-run", false, "只列出會送出的動作，不 POST、不寫 manifest")
	strict := fs.Bool("strict", false, "B2 品質檢查嚴格模式：軟項（H3/H4/H6）也擋，不只硬缺")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "錯誤：--config 為必填")
		return 2
	}
	cfg, err := LoadDirectConfig(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "collector direct:", err)
		return 2
	}
	if *strict {
		cfg.LintStrict = true // CLI 旗標覆蓋 config
	}

	// t176：t92 的 claude_bin 回寫已隨 claude 萃取路一併退役——RunDirectOnce 不再解析
	// claude 執行檔，cfg.ClaudeBin 不會被改寫，故沒有東西需要回寫。
	// （留著空轉的回寫邏輯會讓未來的人以為 claude 路還活著＝錯誤的環境信號。）

	runOne := func() int {
		// 🔴 t191（leo 08-04，issue #17）：「按『立刻同步』後**很快就回到「看守中」**，
		//    看起來好像就做完了，這時使用者一看沒做完啊，就覺得是 bug」。
		//
		//    真兇：舊版**只在一輪跑完後**才印 JSON ⇒ 托盤無從得知「正在跑」，
		//    整段工作時間對用戶是隱形的，只看得到前後都是「看守中」。
		//    ⇒ 開工前先印一筆 `phase:"start"`，托盤收到就顯示「同步中…」，
		//      收到 `phase:"done"` 再切回「看守中」。
		//    形狀相容：兩筆都有 `at`，舊版托盤只會多算一次 round，不會壞掉。
		startOut, _ := json.MarshalIndent(struct {
			At    string `json:"at"`
			Phase string `json:"phase"`
		}{time.Now().Format(time.RFC3339), "start"}, "", "  ")
		fmt.Println(string(startOut))

		results, exit, _ := RunDirectOnce(cfg, *dryRun)
		out, _ := json.MarshalIndent(struct {
			At      string         `json:"at"`
			Phase   string         `json:"phase"`
			Folders []string       `json:"folders"`
			Results []DirectResult `json:"results"`
		}{time.Now().Format(time.RFC3339), "done", cfg.Folders(), results}, "", "  ")
		fmt.Println(string(out))
		return exit
	}

	// 🔴 2026-08-06 leo 拍板：**「拿來開發一般人用不到的根本別安裝」**
	//
	//	原本 daemon 會把 system-dev template（`CLAUDE.md`／`scripts/`／`system-dev/`
	//	共 37 檔）代裝進**使用者的文件資料夾**。那是給開發者寫 SDD/wiki 用的東西，
	//	RAG 的一般使用者完全用不到，而且兩層傷害：
	//	  ① 把人家的資料夾弄亂（leo：「他原本的資料夾就不會看起來亂掉」）
	//	  ② 那些檔案會被當成知識吃進去 ⇒ 知識庫長出 `kb`／`t195-watch` 這種
	//	     不是使用者內容的庫（leo 實撞，見庫目錄管理截圖）
	//	⇒ **看守資料夾一律不代裝**。要裝的人自己跑 `collector template-install`
	//	  （子命令仍在，開發者情境不受影響）。
	//
	//	另外還要把「已經被鋪進去的」擋在知識之外——那不是靠隱藏檔判斷，
	//	因為 leo 自己的 repo 裡 template 本來就不是隱藏的。判準是**路徑身分**，見 scan.go。

	if *once {
		return runOne()
	}
	// 常駐輪詢：純 stdlib，跨平台。首輪立即跑。
	// t98：每 1 秒檢查一次訊號檔（SyncNowSignalPath），命中即立刻跑一輪並刪檔；
	// 否則依 PollSec 間隔照舊定時跑。這讓 tray「立刻同步」按鈕能即時觸發，
	// 不需引入 IPC/socket 等平台依賴。
	// 🔴 2026-08-06：這裡以前印 `cfg.triggerURL(...)`，但那是用**根層**的
	//    cypher_url/namespace 組出來的——多帳號設定（現在的常態）根層是空的
	//    ⇒ log 印出 `→ /webhooks/named//rag_ingest/trigger`（沒有網域、雙斜線），
	//    看起來像設定壞了，其實實際工作走的是**每個帳號各自的網址**，功能是好的。
	//    誤導性的 log 比沒有 log 更貴——會害人往錯的方向查（今天就繞了一輪）。
	//    ⇒ 改印真正會用到的：有幾個帳號、各自的目的地。
	dests := make([]string, 0, len(cfg.Accounts))
	for _, a := range cfg.Accounts {
		dests = append(dests, fmt.Sprintf("%s/webhooks/named/%s/%s/trigger",
			a.CypherURL, a.Namespace, cfg.IngestWF))
	}
	if len(dests) == 0 {
		dests = append(dests, cfg.triggerURL(cfg.IngestWF))
	}
	fmt.Fprintf(os.Stderr, "collector direct daemon 啟動：監看 %s → %s（每 %ds 掃一輪）\n",
		strings.Join(cfg.Folders(), "、"), strings.Join(dests, "、"), cfg.PollSec)
	runOne()

	signalPath := SyncNowSignalPath(cfg.Manifest)
	pollInterval := time.Duration(cfg.PollSec) * time.Second
	lastRun := time.Now()
	const checkInterval = time.Second
	for {
		time.Sleep(checkInterval)
		if consumeSyncNowSignal(signalPath) {
			runOne()
			lastRun = time.Now()
			continue
		}
		if time.Since(lastRun) >= pollInterval {
			runOne()
			lastRun = time.Now()
		}
	}
}

// consumeSyncNowSignal 檢查訊號檔是否存在：存在則刪除並回 true（呼叫端立刻跑一輪同步）；
// 不存在回 false。刪除失敗也回 true——確保本輪至少跑一次，下次若殘留再刪。
func consumeSyncNowSignal(path string) bool {
	if _, err := os.Stat(path); err != nil {
		return false
	}
	_ = os.Remove(path)
	return true
}
