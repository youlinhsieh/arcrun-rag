// arcrun-tray — Arcrun RAG 桌面托盤殼（CP-1 第 6 關 daemon 產品化，leo 2026-07-21 定 fyne）。
//
// 目的：讓「不開 terminal 的人」也能裝、開關、選資料夾——一個選單列/系統匣 icon 就是全部。
// 它看守 `collector direct`（子行程，見 supervisor 套件的誠實界定）並顯示狀態。
//
// ⚠️ 本檔是 fyne GUI（CGo＋系統 webview/GL），**無法在無螢幕 sandbox build/驗**——
//
//	build/簽章/公證/TCC 授權＝leo/地端在真機做（紅線②③）。純邏輯（看守/config）已抽到
//	supervisor 套件並在 sandbox `go test` 驗過。
//
// 真機 build：
//
//	cd collector/cmd/arcrun-tray && go mod tidy
//	go run fyne.io/fyne/v2/cmd/fyne@latest package -os darwin -icon icon.png -name "Arcrun RAG"
//	（Windows：-os windows；簽章/公證另見同目錄 README）
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"arcrun-rag/collector/supervisor"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/widget"
)

// 版本資訊（leo 2026-07-27：「daemon 要加上版本編號」）。
//
// 為什麼需要：在此之前**沒有任何辦法從畫面看出裝的是哪一版**——07-27 花了大半天在對帳
// 「leo 手上／鏡像上／剛編的」是不是同一顆，只能靠 shasum 比對 binary。使用者更不可能做這件事，
// 回報問題時我們也無法確認他跑的是哪版（修好的東西他可能根本沒拿到，見 t63 三層落差）。
//
// 怎麼帶值：build 時用 -ldflags "-X main.version=… -X main.buildTime=…" 注入（見 build-mac.sh／
// build-windows.sh）。沒注入時顯示 dev，代表「本機隨手編的、非發佈品」——這本身就是有用的資訊。
var (
	version   = "dev"
	buildTime = ""
)

// versionLabel 給托盤選單顯示用：正式版顯示「v1.2.3」，開發版額外標出建置時間好辨識。
func versionLabel() string {
	if version == "dev" && buildTime != "" {
		return "dev (" + buildTime + ")"
	}
	return version
}

// accountCfg 是單一帳號的連線設定（t104 多帳號同時看守）。
// t126：Extractor/GeminiAPIKey/LLMModel 支援帳號層覆蓋——帳號有值時優先，空值繼承機器層。
type accountCfg struct {
	InstanceName string            `json:"instance_name,omitempty"`
	Email        string            `json:"email,omitempty"`
	CypherURL    string            `json:"cypher_url"`
	Namespace    string            `json:"namespace"`
	APIKey       string            `json:"api_key,omitempty"`
	WatchFolders []string          `json:"watch_folders,omitempty"`
	Libraries    map[string]string `json:"libraries,omitempty"` // t52：資料夾→庫對映
	// t126：每帳號獨立的萃取設定（空值繼承機器層）
	Extractor    string `json:"extractor,omitempty"`
	GeminiAPIKey string `json:"gemini_api_key,omitempty"`
	LLMModel     string `json:"llm_model,omitempty"`
}

// directConfig 是 collector direct 的設定（與 collector/direct.go 的 DirectConfig 同結構）。
type directConfig struct {
	// t104：多帳號清單（新制）。有值時頂層連線欄位僅保留讀取相容。
	Accounts     []accountCfg `json:"accounts,omitempty"`
	WatchFolder  string       `json:"watch_folder,omitempty"`  // 單數舊制（第一個資料夾的鏡像，維持相容）
	WatchFolders []string     `json:"watch_folders,omitempty"` // 多資料夾（舊制）
	Manifest     string       `json:"manifest"`
	CypherURL    string       `json:"cypher_url,omitempty"`    // 舊制（新制走 Accounts）
	Namespace    string       `json:"namespace,omitempty"`     // 舊制
	APIKey       string       `json:"api_key,omitempty"`
	Email        string       `json:"email,omitempty"`
	InstanceName string       `json:"instance_name,omitempty"`
	Library      string       `json:"library,omitempty"`
	Extractor    string            `json:"extractor,omitempty"`            // "workers-ai"（預設，免金鑰）｜"gemma"
	// t181：使用者主動在「AI 設定…」選過才 true。false／舊 config 沒這欄 ⇒ 一律走 workers-ai。
	// leo 08-04：「只要更新版本，就已經 default workers AI 了，
	// 除非去一個地方切換你指定的 AI 來源」。
	ExtractorExplicit bool `json:"extractor_explicit,omitempty"`
	ClaudeBin    string            `json:"claude_bin,omitempty"`           // t92：collector fallback 找到後回寫
	GeminiAPIKey string            `json:"gemini_api_key,omitempty"`       // t108：gemma 路 key
	LLMModel     string            `json:"llm_model,omitempty"`            // gemma 路模型
	CardIngestWF string            `json:"card_ingest_workflow,omitempty"` // 收卡 workflow
	Libraries    map[string]string `json:"libraries,omitempty"`            // t52 舊制：資料夾→庫對映
	IngestWF     string            `json:"ingest_workflow,omitempty"`
	RemovedWF    string            `json:"removed_workflow,omitempty"`
	PollSec      int               `json:"poll_interval_sec,omitempty"`
	MaxRemoved   float64           `json:"max_removed_ratio,omitempty"`
}

// ── t91 萃取狀態可見性 ──────────────────────────────────────────────────────────

// trayAccountStatus 對映 per-account 狀態（來自 status.json account_details）。
type trayAccountStatus struct {
	CloudVersion string `json:"cloud_version,omitempty"`
	CloudCheckOK bool   `json:"cloud_check_ok"`
}

// traySyncStatus 對映 collector 寫出的 ~/.arcrun-rag/status.json（僅含托盤需要的欄位）。
type traySyncStatus struct {
	LastSync       string          `json:"last_sync,omitempty"`
	ExtractedOK    int             `json:"extracted_ok"`
	ExtractFailed  int             `json:"extract_failed"`
	Failures       []trayExtFail   `json:"failures,omitempty"`
	ExtractorOK    bool            `json:"extractor_ok"`
	ExtractorError string          `json:"extractor_error,omitempty"`
	// 頂層雲端欄位（向後相容，單帳號時有值）
	CloudVersion string `json:"cloud_version,omitempty"`
	CloudCheckOK bool   `json:"cloud_check_ok"`
	// t104：per-account 狀態（key = cypher_url host）
	AccountDetails map[string]trayAccountStatus `json:"account_details,omitempty"`
}

// ── t103 雲端版本偵測 ──────────────────────────────────────────────────────────

// trayMinCloudBuilt 是**舊格式**（YYYY-MM-DD+sha）最低相容建置日期；
// trayMinCloudRelease 是 semver 世代的最低相容版本。
// 與 collector/cloud_version.go 的 minCloudBuilt／minCloudRelease 保持同值——**兩處一起升**。
const trayMinCloudBuilt = "2026-07-28"
const trayMinCloudRelease = "1.4.0"

// trayCloudVersionStale 判斷雲端是否需要更新（同 collector/cloudVersionStale 邏輯）。
//
// 🔴 2026-08-02 修（leo 實撞：兩個帳號都已更新到 1.4.1，卻**都**顯示「知識庫需要更新」
//
//	且更新幾次都消不掉）：原本 `version.split("+")[0] < trayMinCloudBuilt`
//	看似日期比較，**實為字串比較**。雲端版本改 semver 後 "1.4.1" < "2026-07-28" 恆為真
//	⇒ 最新版被判過舊。兩種格式並存期間必須兩種都認。
//	⚠️ 這個 bug 有**兩份**（本函式＋collector/cloud_version.go），只修一份另一份照樣誤判
//	（t164 才踩過「只修一條路，另一條路的用戶照樣中」）。
//
// checkOK=false（/health 不可達）時回 false——**呼叫端負責顯示「查不到版本」**，
// 不可把「連不上」呈現成「不用更新」（會讓真正壞掉的機器安靜無聲）。
func trayCloudVersionStale(version string, checkOK bool) bool {
	if !checkOK {
		return false
	}
	if version == "" {
		return true
	}
	head := strings.SplitN(version, "+", 2)[0]
	if isSemverLike(head) {
		return compareSemver(head, trayMinCloudRelease) < 0
	}
	return head < trayMinCloudBuilt
}

// isSemverLike／compareSemver：與 collector/cloud_version.go 同義。
// tray 與 collector 是兩支獨立編譯的 main package，無法共用符號，故此處複製一份。
// **改動時兩處必須同步**（同 trayMinCloud* 常數的規矩）。
func isSemverLike(v string) bool {
	if v == "" || v[0] < '0' || v[0] > '9' {
		return false
	}
	dot := strings.Index(v, ".")
	dash := strings.Index(v, "-")
	if dot < 0 {
		return false
	}
	return dash < 0 || dot < dash
}

// compareSemver 逐段以整數比較（不可字串比較，否則 "1.10.0" < "1.9.0"）。
func compareSemver(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(as) {
			ai, _ = strconv.Atoi(strings.TrimSpace(as[i]))
		}
		if i < len(bs) {
			bi, _ = strconv.Atoi(strings.TrimSpace(bs[i]))
		}
		if ai != bi {
			if ai < bi {
				return -1
			}
			return 1
		}
	}
	return 0
}

type trayExtFail struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// appStatusFilePath 回傳狀態檔路徑：~/.arcrun-rag/status.json。
func appStatusFilePath() string { return filepath.Join(appDir(), "status.json") }

// loadAppSyncStatus 讀取狀態檔；檔不存在或解析失敗回零值（托盤自行降級）。
func loadAppSyncStatus() traySyncStatus {
	var s traySyncStatus
	data, err := os.ReadFile(appStatusFilePath())
	if err != nil {
		return s
	}
	_ = json.Unmarshal(data, &s)
	return s
}

// syncStatusLabel 依萃取狀態決定要在「看守中」後面追加什麼文案。
// hasExtractor＝config 有設定 extractor（claude/gemma），才有萃取計數的語意。
func syncStatusLabel(sync traySyncStatus, hasExtractor bool) string {
	if !hasExtractor {
		return ""
	}
	if !sync.ExtractorOK && sync.ExtractorError != "" {
		return "" // extractor 錯誤由 buildStatusLabel 整體處理，這裡不加
	}
	if sync.ExtractedOK > 0 {
		return fmt.Sprintf(" · 已萃 %d 檔", sync.ExtractedOK)
	}
	return ""
}

// appDir 是設定與 manifest 落地處：~/.arcrun-rag/
func appDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".arcrun-rag")
}

// syncNowSignalPath 回傳立刻同步訊號檔路徑（~/.arcrun-rag/sync-now）。
// tray 寫入此檔，collector 的主迴圈（1 秒間隔）偵測到後立刻跑一輪同步並刪除它（t98）。
func syncNowSignalPath() string { return filepath.Join(appDir(), "sync-now") }

func configPath() string { return filepath.Join(appDir(), "config.json") }

// defaultWatchFolder 預設 ~/ArcrunRAG——**刻意避開 ~/Documents**：macOS launchd 背景程序碰
// ~/Documents 會被 TCC 擋（07-19 實撞）。預設在非 TCC 禁區＝零授權即可用；用戶要改到 Documents
// 才需走 TCC 同意流（見 README）。
func defaultWatchFolder() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "ArcrunRAG")
}

func loadConfig() *directConfig {
	c := &directConfig{}
	if data, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(data, c)
	}
	// t104：舊格式遷移——頂層 CypherURL → Accounts[0]（冪等）
	if len(c.Accounts) == 0 && strings.TrimSpace(c.CypherURL) != "" {
		c.Accounts = []accountCfg{{
			InstanceName: c.InstanceName,
			Email:        c.Email,
			CypherURL:    c.CypherURL,
			Namespace:    c.Namespace,
			APIKey:       c.APIKey,
			Libraries:    c.Libraries,
			WatchFolders: c.legacyFolders(),
		}}
		// 寫回磁碟（冪等：下次讀 Accounts 已存在就不再遷移）
		_ = saveConfig(c)
	}

	// t126 遷移：把頂層金鑰複製到每個沒有金鑰的帳號（複製非搬移，頂層保留當預設；冪等）。
	// 帳號已有自己的值（非空）→ 不覆蓋，讓帳號層設定永遠優先。
	t126Migrated := false
	for i := range c.Accounts {
		if strings.TrimSpace(c.Accounts[i].Extractor) == "" && strings.TrimSpace(c.Extractor) != "" {
			c.Accounts[i].Extractor = c.Extractor
			t126Migrated = true
		}
		if strings.TrimSpace(c.Accounts[i].GeminiAPIKey) == "" && strings.TrimSpace(c.GeminiAPIKey) != "" {
			c.Accounts[i].GeminiAPIKey = c.GeminiAPIKey
			t126Migrated = true
		}
		if strings.TrimSpace(c.Accounts[i].LLMModel) == "" && strings.TrimSpace(c.LLMModel) != "" {
			c.Accounts[i].LLMModel = c.LLMModel
			t126Migrated = true
		}
	}
	if t126Migrated {
		_ = saveConfig(c)
	}

	if len(c.Accounts) == 0 && c.WatchFolder == "" && len(c.WatchFolders) == 0 {
		c.WatchFolder = defaultWatchFolder() // 尚未連線的預設值（不觸發遷移）
	}
	if c.Manifest == "" {
		c.Manifest = filepath.Join(appDir(), "manifest.json")
	}
	return c
}

// legacyFolders 回傳頂層（舊制）監看根清單（不含 accounts，供遷移使用）。
func (c *directConfig) legacyFolders() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" || seen[p] { return }
		seen[p] = true
		out = append(out, p)
	}
	add(c.WatchFolder)
	for _, f := range c.WatchFolders { add(f) }
	return out
}

// addWatchFolder 把資料夾加進監看清單（去重、保序），並維持單數欄位＝第一根的鏡像。
// 完整的「勾選/移除」UI 是 task 7；本函式先保證資料層正確。
func addWatchFolder(c *directConfig, p string) {
	if p == "" {
		return
	}
	if len(c.WatchFolders) == 0 && c.WatchFolder != "" && c.WatchFolder != defaultWatchFolder() {
		c.WatchFolders = []string{c.WatchFolder}
	}
	for _, f := range c.WatchFolders {
		if f == p {
			return
		}
	}
	c.WatchFolders = append(c.WatchFolders, p)
	c.WatchFolder = c.WatchFolders[0]
}

// Folders 回傳監看根清單（t104：多帳號時彙整所有帳號資料夾；舊制時回頂層清單）。
// 供 registerLibraries 等跨帳號操作使用。
func (c *directConfig) Folders() []string {
	if len(c.Accounts) > 0 {
		seen := map[string]bool{}
		var out []string
		for _, acc := range c.Accounts {
			for _, f := range acc.WatchFolders {
				if f != "" && !seen[f] {
					seen[f] = true
					out = append(out, f)
				}
			}
		}
		return out
	}
	return c.legacyFolders()
}

// removeWatchFolder 把資料夾移出監看清單，並維持單數欄位＝第一根鏡像（清單空＝兩欄皆空）。
func removeWatchFolder(c *directConfig, p string) {
	if len(c.WatchFolders) == 0 && c.WatchFolder == p {
		c.WatchFolder = ""
		return
	}
	var out []string
	for _, f := range c.WatchFolders {
		if f != p {
			out = append(out, f)
		}
	}
	c.WatchFolders = out
	if len(out) > 0 {
		c.WatchFolder = out[0]
	} else {
		c.WatchFolder = ""
	}
}

func saveConfig(c *directConfig) error {
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath(), data, 0o600)
}

// collectorBinPath 找可用的 collector 執行檔。
// Windows 上先嘗試從內嵌位元組解壓到 ~/.arcrun-rag/bin/（embed_windows.go；t77-lite），
// 解壓失敗才 fallback 同層目錄；Mac 直接走同層路徑，完全不受影響。
func collectorBinPath() string {
	if p, err := ensureEmbeddedCollector(); err == nil && p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return "arcrun-collector"
	}
	name := "arcrun-collector"
	if isWindows() {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(exe), name)
}

func isWindows() bool { return os.PathSeparator == '\\' }

// connectionStatusLabel 決定托盤選單頂列「連線中：…」顯示什麼身分（t26 leo 拍板）：
// 暱稱（InstanceName）優先於 email，兩者都空才顯示「未設定」——CF/cypher 全程不入此字串。
func connectionStatusLabel(instanceName, email string) string {
	name := strings.TrimSpace(instanceName)
	if name == "" {
		name = strings.TrimSpace(email)
	}
	if name == "" {
		name = "未設定"
	}
	return "連線中：" + name
}

// shortCypherHost 把 cypher_url 縮成純 host 給第二行 disabled 選單項看（fyne MenuItem 無 tooltip，
// 取捨＝直接多一行而非塞進同一行——選單寬度有限，host 通常已夠長）。解析失敗就原樣回傳（不隱藏錯誤設定）。
func shortCypherHost(cypherURL string) string {
	u := strings.TrimSpace(cypherURL)
	if u == "" {
		return ""
	}
	if parsed, err := neturl.Parse(u); err == nil && parsed.Host != "" {
		return parsed.Host
	}
	return u
}

// ── t54（leo 2026-07-25：「最好的就是把它的帳密直接輸入」）─────────────────────
// 首次啟動不再需要用戶去網站下載 config.json 丟進隱藏資料夾：
// 輸入「知識庫網址 + 帳號密碼」→ 打 /portal/daemon/config → 設定自動寫好。
// 用戶只需要記得他剛在網站設的那組帳密（他本來就記得）。

// daemonConfig 是 /portal/daemon/config 回應的設定欄位。
// t126：加入 GeminiAPIKey / LLMModel——server 若下發金鑰，直接寫進帳號層。
type daemonConfig struct {
	CypherURL    string `json:"cypher_url"`
	Namespace    string `json:"namespace"`
	Library      string `json:"library"`
	Extractor    string `json:"extractor"`
	GeminiAPIKey string `json:"gemini_api_key,omitempty"` // t126
	LLMModel     string `json:"llm_model,omitempty"`      // t126
	Email        string `json:"email"`
	InstanceName string `json:"instance_name"`
}

// daemonConfigResp 是 /portal/daemon/config 的回應（只含連線設定，不含知識內容）。
type daemonConfigResp struct {
	Success bool         `json:"success"`
	Config  daemonConfig `json:"config"`
	Error   string       `json:"error"`
}

// normalizePortalURL 把用戶貼的東西變成可打的 origin：
// 允許貼完整 portal 網址（.../portal/）、只貼主機名、或大小寫/尾斜線不一致。
func normalizePortalURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("請貼上你的知識庫網址")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := neturl.Parse(s)
	if err != nil || u.Host == "" {
		return "", errors.New("網址看起來不太對，請從信裡或瀏覽器網址列複製整段")
	}
	// portal（GUI）與 cypher（API）是不同子域：用戶手上的是 portal，這裡換算成 API 位址。
	host := u.Host
	if strings.HasPrefix(host, "arcrun-rag-ui.") {
		host = "arcrun-cypher-executor." + strings.TrimPrefix(host, "arcrun-rag-ui.")
	}
	return "https://" + host, nil
}

// fetchConfigByLogin 用帳密向實例換取這台機器該用的設定。
func fetchConfigByLogin(portalURL, email, password string) (*daemonConfigResp, error) {
	base, err := normalizePortalURL(portalURL)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"email": strings.TrimSpace(email), "password": password})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/daemon/config", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("連不上這個網址——請確認網址正確、網路正常")
	}
	defer res.Body.Close()
	var out daemonConfigResp
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, errors.New("這個網址不像是 Arcrun RAG 知識庫，請再確認一次")
	}
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, errors.New("帳號或密碼不對——用你在知識庫網站設定的那組")
	}
	if !out.Success {
		if out.Error != "" {
			return nil, errors.New(out.Error)
		}
		return nil, errors.New("連線失敗，請稍後再試一次")
	}
	return &out, nil
}

// instanceChanged 比對兩個 cypher_url 的 host；host 不同代表換了知識庫實例。
// 只比 host 不比 scheme/path——同實例改密碼時 URL 完全不變，不觸發資料夾清空。
// 兩端有任一為空（首次設定或異常值）時回 false，不誤觸清空。
//
// t86（leo 2026-07-28 實測：youlin 時代的資料夾被同步進 geek6688 新實例—個資外洩）。
func instanceChanged(oldURL, newURL string) bool {
	parseHost := func(s string) string {
		u, err := neturl.Parse(strings.TrimSpace(s))
		if err != nil || u.Host == "" {
			return strings.TrimSpace(s)
		}
		return u.Host
	}
	oldHost := parseHost(oldURL)
	newHost := parseHost(newURL)
	return oldHost != "" && newHost != "" && oldHost != newHost
}

// applyRemoteConfig 把換到的設定寫進本地 config。
// 回傳 true 代表換了知識庫實例（host 不同）：此時已清空 WatchFolders/WatchFolder，
// 呼叫端應提示用戶重新選擇資料夾，避免舊資料夾誤傳到新知識庫（t86）。
func applyRemoteConfig(cfg *directConfig, r *daemonConfigResp) bool {
	// t86：換了實例（host 改變）就清空資料夾清單——在寫入新 URL 之前比對，
	// 確保比的是「舊 host vs 新 host」而非「新 vs 新」。
	switched := instanceChanged(cfg.CypherURL, r.Config.CypherURL)
	if switched {
		cfg.WatchFolders = nil
		cfg.WatchFolder = ""
	}
	cfg.CypherURL = r.Config.CypherURL
	cfg.Namespace = r.Config.Namespace
	if r.Config.Library != "" {
		cfg.Library = r.Config.Library
	}
	if r.Config.Extractor != "" {
		cfg.Extractor = r.Config.Extractor
	}
	cfg.Email = r.Config.Email
	if r.Config.InstanceName != "" {
		cfg.InstanceName = r.Config.InstanceName
	}
	if cfg.Manifest == "" {
		cfg.Manifest = filepath.Join(appDir(), "manifest.json")
	}
	return switched
}

// registerLibraries 把「這台機器看守的資料夾各自對應的庫」報上雲端自動登記（t52）。
// leo 2026-07-26：「用戶可以看到我有 2 個庫，地端雲端都是 2 個，如果只有一個一定被罵。」
// 只在連線精靈那一刻做（那時手上才有帳密；daemon 平時不存密碼）。失敗不擋連線。
func registerLibraries(portalURL, email, password string, cfg *directConfig) error {
	base, err := normalizePortalURL(portalURL)
	if err != nil {
		return err
	}
	type libItem struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
	}
	var libs []libItem
	seen := map[string]bool{}
	for _, folder := range cfg.Folders() {
		name := libraryNameFor(cfg, folder)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		libs = append(libs, libItem{Name: name, DisplayName: filepath.Base(folder)})
	}
	if len(libs) == 0 {
		return nil
	}
	body, _ := json.Marshal(map[string]any{"email": strings.TrimSpace(email), "password": password, "libraries": libs})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/daemon/libraries", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("庫登記回 HTTP %d", res.StatusCode)
	}
	return nil
}

// libraryNameFor 與 collector/direct.go 的 libraryFor 同規則（資料夾名 slug；空則退回 library）。
func libraryNameFor(cfg *directConfig, folder string) string {
	if cfg.Libraries != nil {
		if v, ok := cfg.Libraries[folder]; ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	base := filepath.Base(strings.TrimRight(folder, string(filepath.Separator)))
	var b strings.Builder
	lastUnderscore := false
	for _, r := range base {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_':
			b.WriteRune(r)
			lastUnderscore = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
			lastUnderscore = false
		default:
			if !lastUnderscore && b.Len() > 0 {
				b.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	if slug := strings.Trim(b.String(), "_"); slug != "" {
		return slug
	}
	if cfg.Library != "" {
		return cfg.Library
	}
	return "kb"
}

// isConnected 判斷「這台機器已經連上某個知識庫」——沒有就該跳連線精靈。
func isConnected(cfg *directConfig) bool {
	if len(cfg.Accounts) > 0 {
		for _, acc := range cfg.Accounts {
			if strings.TrimSpace(acc.CypherURL) != "" && strings.TrimSpace(acc.Namespace) != "" {
				return true
			}
		}
		return false
	}
	return strings.TrimSpace(cfg.CypherURL) != "" && strings.TrimSpace(cfg.Namespace) != ""
}

// addOrUpdateAccount 把連線精靈取回的設定加入（或更新）accounts 清單（t104）。
// 同 host 已存在 → 更新連線欄位，WatchFolders 保留不動；不同 host → append 新帳號。
// 回傳 true 代表是全新帳號（首次加入）。
// t126：Extractor/GeminiAPIKey/LLMModel 寫進帳號層，不覆蓋機器層（機器層只留使用者手動設的預設）。
func addOrUpdateAccount(cfg *directConfig, r *daemonConfigResp) bool {
	newHost := shortCypherHost(r.Config.CypherURL)
	for i := range cfg.Accounts {
		if shortCypherHost(cfg.Accounts[i].CypherURL) == newHost {
			// 更新現有帳號（保留 WatchFolders 與 Libraries）
			cfg.Accounts[i].CypherURL = strings.TrimSuffix(strings.TrimSpace(r.Config.CypherURL), "/")
			cfg.Accounts[i].Namespace = r.Config.Namespace
			cfg.Accounts[i].Email = r.Config.Email
			if r.Config.InstanceName != "" {
				cfg.Accounts[i].InstanceName = r.Config.InstanceName
			}
			// t176（leo 08-03 翻案）：**不再接受雲端下發的 LLM 設定**。
			// 地端用哪個模型／哪把金鑰，一律由使用者在托盤「AI 設定…」自己填。
			// t126 的「每帳號一份萃取設定」照舊保留（欄位還在、讀取仍帳號層優先），
			// 這裡拔掉的只是「值**從雲端來**」這條來源——t126 修的是存在哪一層，本次改的是值從哪來。
			// 為什麼拔（08-03 實證）：雲端 extractor_config 是**全租戶共用一把 KV**
			// （arcrun:portal.ts:43 portalTenant 為 worker 層級變數，不分用戶），
			// 任一處設了 claude → 所有人的 daemon 都收到；沒裝 Claude Code 的機器萃取全滅，
			// 而 portal 的 claude 勾選框又恆 disabled ⇒ 用戶自己解不開（awindhon 實證：零張卡）。
			// leo：「地端要用什麼模型就在 daemon 上輸入 API Key 設置，而不是雲端設置後控制地端」
			return false
		}
	}
	// 新帳號：只寫連線欄位。t176——LLM 設定不吃雲端下發（見上方同批註解），
	// 由使用者在托盤「AI 設定…」自己填；欄位留白時讀取端會繼承機器層。
	acc := accountCfg{
		InstanceName: r.Config.InstanceName,
		Email:        r.Config.Email,
		CypherURL:    strings.TrimSuffix(strings.TrimSpace(r.Config.CypherURL), "/"),
		Namespace:    r.Config.Namespace,
	}
	if acc.APIKey == "" {
		acc.APIKey = acc.Namespace
	}
	cfg.Accounts = append(cfg.Accounts, acc)
	if cfg.Manifest == "" {
		cfg.Manifest = filepath.Join(appDir(), "manifest.json")
	}
	return true
}

// addAccountWatchFolder 把資料夾加進指定帳號的監看清單（t104）。
func addAccountWatchFolder(cfg *directConfig, accIdx int, p string) {
	if p == "" || accIdx >= len(cfg.Accounts) {
		return
	}
	acc := &cfg.Accounts[accIdx]
	for _, f := range acc.WatchFolders {
		if f == p {
			return
		}
	}
	acc.WatchFolders = append(acc.WatchFolders, p)
}

// removeAccountWatchFolder 把資料夾從指定帳號的監看清單移出（t104）。
func removeAccountWatchFolder(cfg *directConfig, accIdx int, p string) {
	if accIdx >= len(cfg.Accounts) {
		return
	}
	acc := &cfg.Accounts[accIdx]
	var out []string
	for _, f := range acc.WatchFolders {
		if f != p {
			out = append(out, f)
		}
	}
	acc.WatchFolders = out
}

// accountEngineLabel 依帳號或全局預設 extractor 產生「· 引擎名」後綴（t126 托盤可見性）。
// 帳號層有值時優先；兩者皆空回空字串。
//
// 🔴 t182：`explicit` ＝使用者有沒有在「AI 設定…」**主動選過**引擎。
// 沒主動選過 ⇒ 一律念「雲端 AI」（回空字串），不管 config 裡殘留什麼舊值。
// 這是 t178 那個病的**通則版**：t178 只把 `claude` 這一個殘留值導向 Gemini，
// 但殘留 `gemma` 一樣會脫鉤——leo 08-04 實撞：更新到 v0.15.5 後托盤**兩個帳號
// 都還是顯示 Gemini**，因為他 config 的帳號層留著 extractor="gemma"、explicit 沒設。
// 判準必須與 `direct.go` 的預設邏輯**同一條**（沒 explicit 就是 workers-ai），
// 否則又回到「畫面說 A、實際跑 B」。
func accountEngineLabel(acc accountCfg, defaultExtractor string, explicit bool) string {
	if !explicit {
		return ""
	}
	extractor := strings.TrimSpace(acc.Extractor)
	if extractor == "" {
		extractor = strings.TrimSpace(defaultExtractor)
	}
	switch extractor {
	// t181：走雲端 Workers AI（**免金鑰，新的預設**）。
	// 空值也走這條——`direct.go` 的預設邏輯：沒設 extractor＝新用戶＝走 workers-ai，
	// 標籤跟著一致，才不會重演 t178「畫面說 A、實際跑 B」的矛盾。
	// t181（leo 08-04）：「上方如果用 workers AI 就**不顯示**，如果用 Gemini 會顯示 Gemini」
	// ⇒ 預設路徑不佔版面（那是常態，不需要標註）；只有主動選了別的引擎才標出來。
	// 空值也走這條——沒設 extractor＝新用戶＝走 workers-ai（direct.go 預設邏輯）。
	case "workers-ai", "":
		return ""
	// t178（leo 08-04 實撞：朋友的托盤顯示「oscar · Claude」，但他根本沒有 Claude）：
	// `claude` 也顯示 Gemini——因為 **direct.go 早就把 claude 正規化成 gemma**
	// （t176：地端先只支援 Gemini）。標籤若照著 config 的舊字串念，就與實際行為不符
	// ⇒ 用戶看到 Claude、卻收到「Gemini 金鑰是空的」，兩個訊息互相矛盾、更難懂。
	// 舊值來源＝雲端舊版下發後留在 config.json 的殘留（t176 擋了新寫入，沒洗掉舊的）。
	//
	// 📌 Gemini 仍是**選配**（leo 08-04：「客戶說他要用 Gemini，但現在變成選配，
	//    不需要推廣，特定人告訴他怎麼做就好」）⇒ 已填金鑰的用戶維持這條路、標籤照實顯示。
	case "gemma", "claude":
		return " · Gemini"
	}
	return ""
}

// accountDisplayName 回傳帳號顯示名稱（暱稱 > email > host）。
func accountDisplayName(acc accountCfg) string {
	if n := strings.TrimSpace(acc.InstanceName); n != "" {
		return n
	}
	if e := strings.TrimSpace(acc.Email); e != "" {
		return e
	}
	return shortCypherHost(acc.CypherURL)
}

func main() {
	// t176：一台機器只跑一個托盤（leo 08-03「點選多次後托盤產生多個 icon」）。
	// 必須在建 fyne app 之前擋——一旦 app 起來就會掛上第二個托盤 icon。
	ok, releaseInstance := acquireSingleInstance()
	if !ok {
		fmt.Fprintln(os.Stderr, "Arcrun RAG 已經在執行中（系統匣裡找找看），這次不重複開啟。")
		return
	}
	defer releaseInstance()

	a := app.NewWithID("dev.arcrun.rag.tray")
	cfg := loadConfig()

	// 設定視窗（平時隱藏；選資料夾/看說明時開）
	win := a.NewWindow("Arcrun RAG")
	win.SetCloseIntercept(func() { win.Hide() }) // 關窗只隱藏，不結束 app（托盤續跑）
	win.Resize(fyne.NewSize(420, 220))

	sup := supervisor.New(collectorBinPath(), configPath())

	// 狀態列（tray 選單第一項，只讀）
	statusItem := fyne.NewMenuItem("狀態：尚未開始", nil)
	statusItem.Disabled = true

	desk, hasTray := a.(desktop.App)

	// rebuildTray 依現況重建整個 tray 選單（daemon-beta t7 多資料夾）：
	// 每個列入的資料夾一列（點＝在 Finder 打開）＋各自的「刪除這個知識庫」項；
	// 重設選單＝刷新（比 (*Menu).Refresh() 跨版本更穩）。
	var rebuildTray func()


	restartWatch := func() {
		sup.Stop()
		sup.Start()
	}

	// t54 連線精靈：輸入知識庫網址＋帳密 → 換設定 → 寫檔 → 開始看守。
	// 沒連線過的機器一開 app 就自動跳；之後也能從選單「重新連線…」再開。
	// t75（2026-07-28，leo 同事真機實測）：**連線失敗重試時必須把使用者剛打的內容帶回來**。
	//
	// 原本的寫法是失敗後直接呼叫 `showConnectWizard()`，註解寫著「不要把他丟回空白畫面」——
	// **但行為與註解相反**：它重建整個對話框、`urlEntry` 是全新的，而 `cfg.CypherURL`
	// 因為連線失敗根本沒被寫入 ⇒ 欄位就是空的 ⇒ **使用者得整段重打**。
	// leo 原話：「貼上網址後說這不是個網址然後清空內容，**很糟糕**」。
	// ⇒ 改成帶入上次輸入（prefill）。密碼不帶回（打錯密碼時重打比較安全，也避免把密碼留在記憶體更久）。
	var showConnectWizard func()
	var showAISettings func() // t176：地端 AI 設定（Gemini 金鑰）
	var showConnectWizardWith func(prevURL, prevEmail string)
	showConnectWizard = func() { showConnectWizardWith("", "") }
	showConnectWizardWith = func(prevURL, prevEmail string) {
		urlEntry := widget.NewEntry()
		urlEntry.SetPlaceHolder("https://…workers.dev/portal/")
		// 優先用「使用者剛才打的」，其次才是已存的設定——重試時他要看到的是自己的輸入。
		if prevURL != "" {
			urlEntry.SetText(prevURL)
		} else if cfg.CypherURL != "" {
			urlEntry.SetText(cfg.CypherURL)
		}
		emailEntry := widget.NewEntry()
		emailEntry.SetPlaceHolder("你的 Email")
		if prevEmail != "" {
			emailEntry.SetText(prevEmail)
		} else if cfg.Email != "" {
			emailEntry.SetText(cfg.Email)
		}
		pwEntry := widget.NewPasswordEntry()
		pwEntry.SetPlaceHolder("你在知識庫設定的密碼")
		hint := widget.NewLabel("")
		hint.Wrapping = fyne.TextWrapWord

		form := container.NewVBox(
			widget.NewLabel("連上你的知識庫"),
			widget.NewLabel("貼上網址，再輸入你在網站上設定的帳號密碼："),
			urlEntry, emailEntry, pwEntry, hint,
		)
		d := dialog.NewCustomConfirm("Arcrun RAG", "連線", "取消", form, func(ok bool) {
			if !ok {
				return
			}
			hint.SetText("連線中…")
			go func() {
				r, err := fetchConfigByLogin(urlEntry.Text, emailEntry.Text, pwEntry.Text)
				if err != nil {
					dialog.ShowError(err, win)
					// t75：把剛才打的網址與 email 帶回去，讓他只改錯的那個字，不必整段重打。
					showConnectWizardWith(urlEntry.Text, emailEntry.Text)
					return
				}
				// t104：append 新帳號或更新同 host 帳號——不清空其他帳號資料夾（t86 切換清空退役）
				isNew := addOrUpdateAccount(cfg, r)
				if err := saveConfig(cfg); err != nil {
					dialog.ShowError(err, win)
					return
				}
				// t52：把本機資料夾對應的庫報上去自動登記
				if lerr := registerLibraries(urlEntry.Text, emailEntry.Text, pwEntry.Text, cfg); lerr != nil {
					fmt.Println("庫登記略過：", lerr) // 不擋連線（可能是還沒選資料夾）
				}
				restartWatch()
				rebuildTray()
				accName := strings.TrimSpace(r.Config.InstanceName)
				if accName == "" {
					accName = strings.TrimSpace(r.Config.Email)
				}
				if accName == "" {
					accName = shortCypherHost(r.Config.CypherURL)
				}
				if isNew {
					dialog.ShowInformation("帳號已加入", "已加入「"+accName+"」。\n接下來用該帳號底下的「＋ 新增知識資料夾…」選擇要同步的資料夾就好。", win)
				} else {
					dialog.ShowInformation("帳號已更新", "「"+accName+"」的連線設定已更新。", win)
				}
			}()
		}, win)
		d.Resize(fyne.NewSize(460, 320))
		win.Show()
		win.RequestFocus()
		d.Show()
	}

	// t176（leo 08-03 架構翻案）：AI 設定住在地端，不再由雲端下發。
	// 現階段**只支援 Gemini**（leo：「地端先限制 Gemini API Key 配合客戶要求」）；
	// 之後要擴充成「任何用戶想用的模型」時，這裡加 provider 選單即可（欄位已預留 LLMModel）。
	// ⚠️ 這是「緊急先加上輸入位置」的版本——leo 已指出托盤下拉選單塞不下未來的設定量
	//（30+ 資料夾根本認不出），後續走本地 HTML 設定頁（像 Google Drive）。
	// t181（leo 08-04）：這裡是「**唯一可以切換 AI 來源的地方**」。
	// leo：「只要更新版本，就已經 default workers AI 了，除非**去一個地方切換**你指定的 AI 來源」
	//      「default 用 Workers AI，你要用 Gemini 要**特別去選取**，不管你現在是否有填金鑰」
	// ⇒ 預設選項固定在「雲端 AI」，除非使用者**主動**改選 Gemini（才寫 ExtractorExplicit=true）。
	//   Gemini 是選配、不推廣（leo：「特定人告訴他怎麼做就好」），故文案不慫恿、只說明。
	showAISettings = func() {
		const (
			optCloud  = "雲端 AI（推薦・不必申請任何金鑰）"
			optGemini = "Google Gemini（需要自己申請金鑰）"
		)
		keyEntry := widget.NewPasswordEntry()
		keyEntry.SetPlaceHolder("貼上你的 Gemini API Key")
		keyEntry.SetText(cfg.GeminiAPIKey) // 帶入現值，讓他看得到「已經設過了」
		note := widget.NewLabel("")
		note.Wrapping = fyne.TextWrapWord

		// 只有「主動選過 Gemini」才預選 Gemini；其餘一律停在雲端 AI（含已填金鑰但沒選過的人）
		selected := optCloud
		if cfg.ExtractorExplicit && cfg.Extractor == "gemma" {
			selected = optGemini
		}
		radio := widget.NewRadioGroup([]string{optCloud, optGemini}, func(s string) {
			if s == optGemini {
				keyEntry.Show()
				note.SetText("到 aistudio.google.com/apikey 免費申請。\n" +
					"若顯示 Billing Tier: Unavailable，代表那個 Google 帳號被 Google 限制了，換一個帳號申請。")
			} else {
				keyEntry.Hide()
				note.SetText("用你自己 Cloudflare 帳號內建的 AI，不需要任何金鑰、不必去別的網站申請。")
			}
		})
		radio.SetSelected(selected)

		form := container.NewVBox(
			widget.NewLabel("用哪個 AI 幫你整理文件？"),
			radio, keyEntry, note,
		)
		d := dialog.NewCustomConfirm("AI 設定", "儲存", "取消", form, func(ok bool) {
			if !ok {
				return
			}
			useGemini := radio.Selected == optGemini
			key := strings.TrimSpace(keyEntry.Text)
			if useGemini && key == "" {
				dialog.ShowError(errors.New("選了 Gemini 就要貼上金鑰；不想申請的話請改選「雲端 AI」"), win)
				return
			}
			engine := "workers-ai"
			if useGemini {
				engine = "gemma"
			}
			// 🔴 t190（leo 08-04 實撞）：「我切到 Gemini 把內容刪掉，再切回 Workers AI，
			//    儲存，回去發現 **Gemini Key 還在**」。
			//
			//    舊版把 `cfg.GeminiAPIKey = key` 寫在 `if useGemini` 裡 ⇒ 選回雲端 AI 時
			//    整段跳過、舊金鑰原封不動 ⇒ **清空輸入框等於沒作用，金鑰刪不掉**。
			//    leo 要求：「如果他不想留 Key 了，**要可以刪除**」。
			//
			//    改成**無條件以輸入框為準**（清空＝刪除），才符合使用者的心智模型：
			//    我把欄位清空並按儲存，它就該不見。
			cfg.GeminiAPIKey = key
			// 機器層寫一份當預設；各帳號層一併寫，避免舊 config 殘留的空欄位繼承到別的值。
			cfg.Extractor = engine
			cfg.ExtractorExplicit = true // ← 使用者主動選過，之後不再被預設覆蓋
			for i := range cfg.Accounts {
				cfg.Accounts[i].Extractor = engine
				cfg.Accounts[i].GeminiAPIKey = key // 同上：帳號層也要能被清空
			}
			if err := saveConfig(cfg); err != nil {
				dialog.ShowError(err, win)
				return
			}
			restartWatch() // 立刻生效，不必等下一輪
			rebuildTray()
			msg := "接下來的同步會用你自己 Cloudflare 帳號內建的 AI 整理文件（不需要金鑰）。"
			if useGemini {
				msg = "接下來的同步會用 Google Gemini 整理文件。"
			}
			dialog.ShowInformation("已儲存", msg, win)
		}, win)
		d.Resize(fyne.NewSize(520, 320))
		win.Show()
		win.RequestFocus()
		d.Show()
	}

	addAction := func() {
		win.Show()
		win.RequestFocus()
		dialog.ShowFolderOpen(func(uri fyne.ListableURI, err error) {
			if err != nil || uri == nil {
				return
			}
			// t104：多帳號模式加進第一個帳號；無帳號時走舊制
			if len(cfg.Accounts) > 0 {
				addAccountWatchFolder(cfg, 0, uri.Path())
			} else {
				addWatchFolder(cfg, uri.Path())
			}
			if err := saveConfig(cfg); err != nil {
				dialog.ShowError(err, win)
				return
			}
			restartWatch()
			rebuildTray()
			win.Hide()
		}, win)
	}

	// 🔴 t192（leo 08-04，issue #18）：主視窗——「daemon 設定項越來越多，
	//    **不可能統統塞在下拉選單**」「參考 Google Drive 設定畫面：點擊 daemon
	//    就開一個視窗，佔螢幕約 1/2」「資料夾清單要**可捲動**」。
	//    托盤選單保留（快速動作），但**主入口改成這個視窗**。
	//    所有動作都**複用既有 handler**，不在視窗那邊重寫一份邏輯。
	mw := newMainWindow(a)
	mw.sup = sup
	mw.cfg = cfg
	mw.reload = func() *directConfig { return cfg }
	mw.onAddAccount = func() { showConnectWizard() }
	mw.onAddFolder = func(accIdx int) {
		dialog.ShowFolderOpen(func(uri fyne.ListableURI, err error) {
			if err != nil || uri == nil {
				return
			}
			addAccountWatchFolder(cfg, accIdx, uri.Path())
			if serr := saveConfig(cfg); serr != nil {
				dialog.ShowError(serr, mw.win)
				return
			}
			restartWatch()
			rebuildTray()
			mw.refresh()
		}, mw.win)
	}
	mw.onDelFolder = func(accIdx int, folder string) {
		removeAccountWatchFolder(cfg, accIdx, folder)
		if serr := saveConfig(cfg); serr != nil {
			dialog.ShowError(serr, mw.win)
			return
		}
		restartWatch()
		rebuildTray()
		mw.refresh()
	}
	mw.onAISettings = func() { showAISettings() }
	mw.onSyncNow = func() {
		_ = os.MkdirAll(appDir(), 0o755)
		_ = os.WriteFile(syncNowSignalPath(), []byte{}, 0o644)
		mw.refresh()
	}
	mw.onCheckUpdate = func() {
		go func() {
			st := checkForUpdate()
			switch {
			case st.Err != "":
				dialog.ShowInformation("檢查更新", "暫時連不上更新伺服器：\n"+st.Err, mw.win)
			case st.Available:
				go prepareUpdateInBackground()
				dialog.ShowInformation("有新版本",
					"發現新版 "+st.Latest+"，正在背景下載。\n下載完成後會出現「重新啟動完成更新」。", mw.win)
			default:
				dialog.ShowInformation("檢查更新", "你已經是最新版本（"+versionLabel()+"）。", mw.win)
			}
		}()
	}
	mw.build()
	mw.startAutoRefresh()

	// t98：立刻同步——寫訊號檔觸發 collector 立即跑一輪，無需等下一個定時週期。
	// syncNowItem 宣告在 rebuildTray 外，確保 click handler 的 goroutine 能還原標籤後重建選單。
	var syncNowItem *fyne.MenuItem
	syncNowItem = fyne.NewMenuItem("立刻同步", func() {
		_ = os.MkdirAll(appDir(), 0o755)
		_ = os.WriteFile(syncNowSignalPath(), []byte{}, 0o644)
		syncNowItem.Label = "同步中…"
		syncNowItem.Disabled = true
		rebuildTray()
		// 還原標籤：8 秒後 collector 已完成本輪（含狀態檔更新），順手刷新一次 tray 讓時間戳更新。
		go func() {
			time.Sleep(8 * time.Second)
			syncNowItem.Label = "立刻同步"
			syncNowItem.Disabled = false
			rebuildTray()
		}()
	})

	rebuildTray = func() {
		if !hasTray {
			return
		}
		// t91：每次重建選單時讀最新狀態，確保看守中的萃取結果即時反映。
		sync := loadAppSyncStatus()
		supStatus := sup.Status()
		statusItem.Label = "狀態：" + buildStatusLabel(supStatus, sync, cfg.Extractor)

		versionItem := fyne.NewMenuItem("版本 "+versionLabel(), nil)
		versionItem.Disabled = true

		// t150（leo 07-29）：更新提示＋一鍵完成。
		// leo：「我要他下載多幾次他就放棄了，所以抓到一個客戶後不能讓他有機會離開」
		//      「如果它都掛着，那準備好就告訴他重啓更新」
		// ⇒ 背景自動下載備妥，這裡只呈現結果；使用者**完全不必再下載**，按一下重啟即完成。
		var updateItem *fyne.MenuItem
		if lbl, show := updateMenuLabel(); show {
			updateItem = fyne.NewMenuItem(lbl, func() {
				if st := loadStaged(); st.Ready {
					if err := applyStagedAndRestart(); err != nil {
						dialog.ShowError(err, win)
					}
					return
				}
				// 尚在下載中：告知狀態，不重複觸發下載
				dialog.ShowInformation("更新下載中",
					"新版正在背景下載，完成後這裡會變成「點此重新啟動完成更新」。", win)
			})
		}

		// 手動「檢查更新」（leo：「他去按一下檢查更新然後更新就好」）——
		// 自動檢查每日一次，但使用者想立刻確認時要按得到，不必等。
		checkUpdateItem := fyne.NewMenuItem("檢查更新…", func() {
			go func() {
				st := checkForUpdate()
				switch {
				case st.Err != "":
					dialog.ShowInformation("檢查更新", "暫時連不上更新伺服器：\n"+st.Err, win)
				case st.Available:
					go prepareUpdateInBackground()
					dialog.ShowInformation("有新版本",
						"發現新版 "+st.Latest+"，正在背景下載。\n下載完成後，選單會出現「點此重新啟動完成更新」。", win)
				default:
					dialog.ShowInformation("檢查更新", "你已經是最新版本（"+versionLabel()+"）。", win)
				}
			}()
		})

		var items []*fyne.MenuItem

		// 🔴 t192：主視窗入口放**選單第一項**——leo 點破過同一個病兩次：
		//    「能力做出來了，入口沒出現在用戶會看的地方」
		//    （docs 建好卻沒連結／MCP 端點活著卻零處提及）。做完就要看得見。
		items = append(items,
			fyne.NewMenuItem("開啟 Arcrun…", func() { mw.showAndRefresh() }),
			fyne.NewMenuItemSeparator(),
		)

		// t104：per-account 分組——每個帳號獨立一段（帳號名稱標題 + 資料夾 + 新增按鈕）。
		if len(cfg.Accounts) > 0 {
			for ai, acc := range cfg.Accounts {
				accIdx := ai // capture by value，供 closure 正確引用
				accHost := shortCypherHost(acc.CypherURL)

				// 帳號標題（不可點）；t126 附引擎名（如「geek6688 · Gemini」）
				headerItem := fyne.NewMenuItem("◉ "+accountDisplayName(acc)+accountEngineLabel(acc, cfg.Extractor, cfg.ExtractorExplicit), nil)
				headerItem.Disabled = true
				items = append(items, headerItem)

				// t103 per-account：雲端版本過舊時顯示更新提示（帶帳號識別）
				if accSt, ok := sync.AccountDetails[accHost]; ok && trayCloudVersionStale(accSt.CloudVersion, accSt.CloudCheckOK) {
					items = append(items, fyne.NewMenuItem("  ⚠ 知識庫需要更新（點我）", func() {
						if u, err := neturl.Parse("https://install.arcrun.dev/"); err == nil {
							_ = a.OpenURL(u)
						}
					}))
				}

				// 此帳號的資料夾（t101：子選單「刪除這個知識庫」作用於正確帳號）
				for _, f := range acc.WatchFolders {
					folder := f     // capture
					aidx := accIdx // capture
					it := fyne.NewMenuItem("  📁 "+filepath.Base(folder), func() {
						if u, err := neturl.Parse("file://" + folder); err == nil {
							_ = a.OpenURL(u)
						}
					})
					it.ChildMenu = fyne.NewMenu("",
						fyne.NewMenuItem("刪除這個知識庫", func() {
							removeAccountWatchFolder(cfg, aidx, folder)
							if err := saveConfig(cfg); err != nil {
								dialog.ShowError(err, win)
								return
							}
							restartWatch()
							rebuildTray()
						}),
					)
					items = append(items, it)
				}

				// 此帳號的「＋ 新增知識資料夾…」
				aidxAdd := accIdx // capture
				items = append(items, fyne.NewMenuItem("  ＋ 新增知識資料夾…", func() {
					win.Show()
					win.RequestFocus()
					dialog.ShowFolderOpen(func(uri fyne.ListableURI, err error) {
						if err != nil || uri == nil {
							return
						}
						addAccountWatchFolder(cfg, aidxAdd, uri.Path())
						if err := saveConfig(cfg); err != nil {
							dialog.ShowError(err, win)
							return
						}
						restartWatch()
						rebuildTray()
						win.Hide()
					}, win)
				}))
				items = append(items, fyne.NewMenuItemSeparator())
			}
		} else {
			// 尚未連線（accounts 空）——簡化顯示
			notConn := fyne.NewMenuItem("未連線到任何知識庫", nil)
			notConn.Disabled = true
			items = append(items, notConn, fyne.NewMenuItemSeparator())
		}

		items = append(items, statusItem)
		// t91：有萃取失敗時加警告項，點開顯示哪些檔出了什麼問題（白話）。
		if cfg.Extractor != "" && sync.ExtractFailed > 0 {
			syncSnapshot := sync // 捕獲，避免 closure 讀到更新後的值
			failItem := fyne.NewMenuItem(fmt.Sprintf("⚠ 萃取失敗 %d 檔", sync.ExtractFailed), func() {
				var sb strings.Builder
				sb.WriteString(fmt.Sprintf("本輪有 %d 個檔案沒有成功進知識庫：\n\n", syncSnapshot.ExtractFailed))
				for _, f := range syncSnapshot.Failures {
					sb.WriteString("• " + f.Path + "\n  " + f.Error + "\n\n")
				}
				dialog.ShowInformation("萃取失敗詳情", strings.TrimSpace(sb.String()), win)
			})
			items = append(items, failItem)
		}
		// t103 向後相容（單帳號舊 status.json 仍有頂層 CloudVersion）：若無 AccountDetails 則看頂層
		if len(sync.AccountDetails) == 0 && trayCloudVersionStale(sync.CloudVersion, sync.CloudCheckOK) {
			items = append(items, fyne.NewMenuItem("⚠ 知識庫需要更新（點我）", func() {
				if u, err := neturl.Parse("https://install.arcrun.dev/"); err == nil {
					_ = a.OpenURL(u)
				}
			}))
		}
		// t150：有更新才插這一項（沒新版時不佔位、不干擾）
		if updateItem != nil {
			items = append(items, fyne.NewMenuItemSeparator(), updateItem)
		}
		items = append(items,
			fyne.NewMenuItemSeparator(),
			syncNowItem, // t98：立刻同步
			// t104：「連上知識庫」改為「新增帳號」——精靈成功後 append 到 accounts，不換掉舊帳號
			fyne.NewMenuItem("＋ 新增帳號…", func() { showConnectWizard() }),
			// t176：AI 設定移到地端（leo 08-03：「地端要用什麼模型就在 daemon 上輸入 API Key 設置」）
			fyne.NewMenuItem("AI 設定…", func() { showAISettings() }),
			fyne.NewMenuItemSeparator(),
			versionItem,
			checkUpdateItem, // t150：手動檢查更新（leo：「他去按一下檢查更新然後更新就好」）
			// t110 二修（leo 真機：v0.14.1 拿掉自訂項後選單「兩個都沒有」＝
			// 「fyne 會自動附 Quit」是錯誤前提，桌面截圖才是權威）：自訂結束項加回，
			// 這是唯一的結束入口。若某環境 fyne 真的又附了 Quit（v0.14.0 曾見雙項），
			// 屆時以抑制 fyne 端為方向，不能再拿掉這項。
			fyne.NewMenuItem("結束 Arcrun RAG", func() {
				sup.Stop()
				a.Quit()
			}),
		)
		desk.SetSystemTrayMenu(fyne.NewMenu("Arcrun RAG", items...))
	}

	if hasTray {
		desk.SetSystemTrayIcon(trayIcon()) // 品牌 icon（見 trayicon.go：mac 走 template 單色、Windows 走墨底完整版）
	}
	rebuildTray() // 開機即建初始選單（否則第一次狀態回呼前選單是空的）
	// 托盤唯一指示器（leo 07-24 裁決）：NSApp 起來後把 activation policy 切 Accessory
	//（plist LSUIElement 會被 fyne/glfw 蓋掉——07-24 真機實測第三枚坑，見 dock_darwin.go）
	a.Lifecycle().SetOnStarted(func() { hideDockIcon() })
	refreshTray := rebuildTray

	// 狀態變更 → 刷新 tray 選單（回呼在 supervisor goroutine，切回 UI thread）。
	// t91：label 設定統一在 rebuildTray 裡做（同時讀取 status.json）；
	// 此版 fyne 無 fyne.Do，tray label 更新直接做即可（2026-07-21 真機 build 實測修正）。
	sup.SetOnChange(func(s supervisor.Status) {
		refreshTray()
	})

	// 設定視窗內容：說明現況 + 選資料夾按鈕（給會開窗的人；不會開的人靠 tray 選單）
	win.SetContent(container.NewVBox(
		widget.NewLabelWithStyle("Arcrun RAG 知識同步", fyne.TextAlignCenter, fyne.TextStyle{Bold: true}),
		widget.NewLabel("把檔案丟進你選的資料夾，就會自動進你的知識庫。\n這個程式會待在選單列/系統匣，關掉視窗它仍在背景看守。"),
		widget.NewButton("新增知識資料夾…", func() { addAction() }),
	))

	// 開機即看守（若已連上知識庫）
	if isConnected(cfg) {
		sup.Start()
	} else {
		// t54：沒連過就直接跳連線精靈（輸入網址＋帳密），不再要用戶去下載 config.json。
		statusItem.Label = "狀態：尚未連線"
		showConnectWizard()
	}

	// t150：背景更新檢查（每日一次，啟動後延遲 1 分鐘避免搶開機資源）。
	// 有新版就默默下載備妥，選單自動變成「點此重新啟動完成更新」——
	// 使用者不必再下載任何東西（leo：「我要他下載多幾次他就放棄了」）。
	startUpdateWatcher()

	a.Lifecycle().SetOnStopped(func() { sup.Stop() })
	a.Run()
}

// humanStatus 把狀態機轉成白話（給不懂內部的人）。
// 需要考慮萃取狀態時，改用 buildStatusLabel。
func humanStatus(s supervisor.Status) string {
	return buildStatusLabel(s, loadAppSyncStatus(), "")
}

// buildStatusLabel 合併 supervisor 狀態與萃取狀態，產出托盤顯示文字。
// extractor 空字串代表 config 未設定 extractor（舊制直送），此時不顯示萃取計數。
func buildStatusLabel(s supervisor.Status, sync traySyncStatus, extractor string) string {
	hasExtractor := extractor != ""
	switch s.State {
	case supervisor.StateWatching:
		// t92：extractor 預檢失敗時，直接換掉「看守中」文案
		if hasExtractor && !sync.ExtractorOK && sync.ExtractorError != "" {
			return "⚠ 萃取引擎未就緒：" + sync.ExtractorError
		}
		base := "看守中"
		if !s.LastRoundAt.IsZero() {
			base = fmt.Sprintf("看守中 · 上次同步 %s", s.LastRoundAt.Local().Format("15:04"))
		}
		return base + syncStatusLabel(sync, hasExtractor)
	// 🔴 t191（leo 08-04，issue #17）：正在跑就要**看得出來在跑**。
	// leo：「如果它顯示『萃取中』、『同步中』⋯⋯而不是看起來好像就做完了，
	//        這時使用者一看沒做完啊，就覺得是 bug」「這是不讓用戶誤解的方法」。
	case supervisor.StateSyncing:
		return "同步中… 正在讀檔並整理成知識卡"
	case supervisor.StateStarting:
		return "啟動中…"
	case supervisor.StateError:
		return "暫時出錯，正在自動重試"
	default:
		return "尚未開始"
	}
}
