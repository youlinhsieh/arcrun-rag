package main

// selfupdate.go — 小幫手自我更新（t150，2026-07-29 leo 拍板）
//
// 為什麼一定要做（leo 原話）：
//   「小白不會動不動就刪除再裝新的」
//   「如果有自動更新，就不用讓測試者一直重新下載，他去按一下檢查更新然後更新就好」
//   「**我要他下載多幾次他就放棄了，所以抓到一個客戶後不能讓他有機會離開**」
//
// ⇒ 每一次「請你重新下載」都是流失點。修好的東西到不了用戶手上＝等於沒修
//   （t149 實例：多帳號同步修好了，leo 手上仍是壞的，因為沒有更新機制）。
//
// 設計（leo 選 1+3）：**背景自動更新為主，但一定要有提醒與手動「檢查更新」**——
//   daemon 常駐不重啟，完全自動才符合實際使用；但仍要看得見、按得動，
//   否則使用者不知道發生什麼事（違反「視覺化明示原則」）。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// manifestBase 是 bundle manifest（含 daemon 區塊）。與安裝器同源，不另開發佈通道。
//
// 🔴 t186（2026-08-04）：**改打 raw.githubusercontent，不再用 jsDelivr `@main`。**
//
//	── 這推翻了 t150 二修（07-29 `142f1d5`）的判斷，理由如下 ──
//
//	那一輪的真兇是「jsDelivr 對 `@main` 回 7 天**檔案**快取」，解法是加 `?t=<unix>`。
//	**今天的病不同**：卡住的是「main → 哪個 commit」這層 **ref 解析**，
//	而 `?t=` 與 purge **都清不掉 ref 解析**。08-04 實測三條路同時比對：
//	  @main   → 1.4.9  / v0.15.6   ← 卡住（age 持續增長、purge 回 finished 也沒用）
//	  @<sha>  → 1.4.10 / v0.15.7   ← 正確
//	  raw     → 1.4.10 / v0.15.7   ← 正確
//	`x-cache: MISS, MISS` 卻仍吐舊內容 ⇒ 坐實不是檔案快取，是 ref 解析被快取。
//	同一天發作三次（win zip → mac zip → manifest）。zip 能靠「改帶版本號檔名」繞開，
//	**manifest.json 不行**——檔名寫死在這裡，換不了 ⇒ 只剩「換來源」一條路。
//
//	── D20 合規（t150 那輪否決 raw 的理由是誤判）──
//	舊註解寫「raw 是實名讀 GitHub，受 D20 頻率閘管制」。
//	但 D20 對實名的定義是「URL 帶 `token@`／`user:pass@`、或 clone 自己 private 殼」，
//	**daemon 這個請求不帶任何憑證＝匿名讀**，
//	D20 明列「匿名讀（curl 公開 release…）✅ 放行，不計數」
//	（`system-dev/docs/2-architecture/decisions/D20-github-contact-protocol.md:22`）。
//	repo 是公開的，GitHub 不知道請求者是誰 ⇒ 零 flag 風險。
//
//	仍保留 `?t=<unix>`：擋瀏覽器／中間層快取，成本為零。
const manifestBase = "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/manifest.json"

func manifestURLNoCache() string {
	return manifestBase + "?t=" + strconv.FormatInt(time.Now().Unix(), 10)
}

// updateCheckInterval：背景檢查頻率。守「不輪詢」紅線——這是**單一 CDN 靜態檔**、
// 每天一次、非 GitHub API，不構成 fan-out 或高頻寫入。
const updateCheckInterval = 24 * time.Hour

type daemonRelease struct {
	Version string `json:"version"`
	Built   string `json:"built"`
	Notes   string `json:"notes"`
	Mac     struct {
		File   string `json:"file"`
		SHA256 string `json:"sha256"`
	} `json:"mac"`
	Win struct {
		File   string `json:"file"`
		SHA256 string `json:"sha256"`
	} `json:"win"`
}

type bundleManifest struct {
	Daemon *daemonRelease `json:"daemon,omitempty"`
}

// updateState 是檢查結果（給選單讀）。
type updateState struct {
	Available bool   // 有新版
	Latest    string // 最新版本號
	Notes     string // 更新說明
	CheckedAt time.Time
	Err       string // 檢查失敗原因（顯示用，不擋工作）
}

var currentUpdate updateState

// fetchLatestRelease 抓 manifest 的 daemon 區塊。
func fetchLatestRelease() (*daemonRelease, error) {
	cli := &http.Client{Timeout: 20 * time.Second}
	resp, err := cli.Get(manifestURLNoCache())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("manifest HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var m bundleManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	if m.Daemon == nil || strings.TrimSpace(m.Daemon.Version) == "" {
		return nil, fmt.Errorf("manifest 沒有 daemon 版本欄位")
	}
	return m.Daemon, nil
}

// newerThanCurrent 比較版本。dev（本機隨手編）一律不提示更新——
// 開發中的機器被提示「有新版」只會造成困惑。
func newerThanCurrent(latest string) bool {
	cur := strings.TrimSpace(version)
	if cur == "" || cur == "dev" {
		return false
	}
	return strings.TrimSpace(latest) != cur
}

// checkForUpdate 執行一次檢查並更新 currentUpdate。
func checkForUpdate() updateState {
	st := updateState{CheckedAt: time.Now()}
	rel, err := fetchLatestRelease()
	if err != nil {
		st.Err = err.Error()
		currentUpdate = st
		return st
	}
	st.Latest = rel.Version
	st.Notes = rel.Notes
	st.Available = newerThanCurrent(rel.Version)
	currentUpdate = st
	return st
}

// downloadURLFor 回傳本平台的下載網址。
func downloadURLFor(rel *daemonRelease) string {
	// t186：與 manifestBase 同一個理由改走 raw——`@main` 的 ref 解析會卡住，
	// 抓到舊 zip ⇒ sha256 校驗不符 ⇒ **更新永遠失敗且靜默**（正是 08-04 撞的病）。
	// portal 的下載按鈕本來就走 raw（Mac zip 曾大於 jsDelivr 20MB 單檔上限），
	// 這裡改過來後**兩條下載路徑同源**，不會再出現「下載頁對、檢查更新錯」的分歧。
	base := "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/"
	suffix := "?t=" + strconv.FormatInt(time.Now().Unix(), 10)
	if isWindows() {
		return base + rel.Win.File + suffix
	}
	return base + rel.Mac.File + suffix
}

// updateStagePath 是下載暫存位置（~/.arcrun-rag/updates/）。
func updateStagePath(name string) string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".arcrun-rag", "updates")
	_ = os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, name)
}

// ── 下載與套用（leo 07-29：「如果它都掛着，那準備好就告訴他重啓更新」）─────────
//
// 設計要點：daemon 常駐不重啟 ⇒ **不能中途替換自己正在跑的執行檔**。
// 所以分兩段：① 背景默默下載+驗章，備妥後只改選單文案（不打擾）
//            ② 使用者按「重新啟動以完成更新」才真的替換並重啟。
// ⇒ 使用者**完全不必再下載任何東西**（leo：「我要他下載多幾次他就放棄了」）。

// stagedUpdate 記錄「已下載備妥、等重啟套用」的版本。
type stagedUpdate struct {
	Version string `json:"version"`
	ZipPath string `json:"zip_path"`
	Ready   bool   `json:"ready"`
}

var currentStaged stagedUpdate

// stagedMarkerPath 讓「備妥狀態」跨重啟可見（重啟後才好知道要不要套用）。
func stagedMarkerPath() string { return updateStagePath("staged.json") }

func saveStaged(s stagedUpdate) {
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	_ = os.WriteFile(stagedMarkerPath(), b, 0o644)
}

func loadStaged() stagedUpdate {
	var s stagedUpdate
	b, err := os.ReadFile(stagedMarkerPath())
	if err != nil {
		return s
	}
	_ = json.Unmarshal(b, &s)
	return s
}

// downloadUpdate 下載新版 zip 到暫存區並驗 sha256。
// 驗章失敗＝寧可不更新（壞掉的 .app 會讓小幫手開不起來，比舊版更糟）。
func downloadUpdate(rel *daemonRelease) (string, error) {
	url := downloadURLFor(rel)
	want := rel.Mac.SHA256
	if isWindows() {
		want = rel.Win.SHA256
	}
	cli := &http.Client{Timeout: 10 * time.Minute}
	resp, err := cli.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("下載 HTTP %d", resp.StatusCode)
	}
	// 檔名要用「去掉查詢字串」的網址算，否則會變成 ...zip?t=1785... 這種怪檔名。
	cleanURL := strings.SplitN(url, "?", 2)[0]
	dst := updateStagePath(rel.Version + "-" + filepath.Base(cleanURL))
	f, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	got := hex.EncodeToString(h.Sum(nil))
	if want != "" && got != want {
		_ = os.Remove(dst)
		return "", fmt.Errorf("檔案校驗不符（可能下載不完整），已丟棄")
	}
	return dst, nil
}

// prepareUpdateInBackground：檢查 → 有新版就下載備妥 → 記錄 staged。
// 全程不打擾使用者；備妥後由選單顯示「重新啟動以完成更新」。
func prepareUpdateInBackground() {
	st := checkForUpdate()
	if !st.Available {
		return
	}
	rel, err := fetchLatestRelease()
	if err != nil {
		return
	}
	zip, err := downloadUpdate(rel)
	if err != nil {
		currentUpdate.Err = "自動下載失敗：" + err.Error()
		return
	}
	currentStaged = stagedUpdate{Version: rel.Version, ZipPath: zip, Ready: true}
	saveStaged(currentStaged)
}

// startUpdateWatcher 啟動背景更新檢查（每日一次；啟動後先等 1 分鐘避免搶開機資源）。
func startUpdateWatcher() {
	go func() {
		time.Sleep(time.Minute)
		for {
			prepareUpdateInBackground()
			time.Sleep(updateCheckInterval)
		}
	}()
}

// applyStagedAndRestart 套用已備妥的更新並重啟。
// 只有使用者按下「重新啟動以完成更新」才會走到這裡（不偷偷替換正在跑的自己）。
//
// 做法：解壓到暫存 → 用 ditto 覆蓋 /Applications/Arcrun.app → 重新 open → 結束自己。
// 失敗時保留原版不動（寧可停在舊版，也不要弄出開不起來的 .app）。
func applyStagedAndRestart() error {
	s := loadStaged()
	if !s.Ready || s.ZipPath == "" {
		return fmt.Errorf("沒有已備妥的更新")
	}
	if _, err := os.Stat(s.ZipPath); err != nil {
		return fmt.Errorf("更新檔不見了，請再檢查一次更新")
	}
	if isWindows() {
		// Windows 版走各自的安裝流程（本階段先開資料夾讓使用者取用）。
		return openPath(filepath.Dir(s.ZipPath))
	}
	work := updateStagePath("unpack")
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	if out, err := runCmd("ditto", "-x", "-k", s.ZipPath, work); err != nil {
		return fmt.Errorf("解壓失敗：%v %s", err, out)
	}
	newApp := filepath.Join(work, "Arcrun.app")
	if _, err := os.Stat(newApp); err != nil {
		return fmt.Errorf("更新檔內容不符（找不到 Arcrun.app）")
	}
	// 🔴 t184（leo 08-04 實撞：Oscar 按更新→顯示「新版 v0.15.6 已就緒」→重啟後**又跳回 v0.15.4**）：
	//
	//	原本寫死 `/Applications/Arcrun.app`。但使用者**不一定把 app 放在 Applications**
	//	（Oscar 就是從下載資料夾／桌面直接跑）。這時 `ditto` 會**自動建出**
	//	`/Applications/Arcrun.app` 並**回傳成功**（實測 exit 0，不是報錯）
	//	⇒ 新版被寫到一個他根本沒在跑的路徑，他重開的還是原地那份舊的
	//	⇒ 畫面說「更新完成」、版本卻永遠是舊的＝**靜默失敗**，最難查的那種。
	//
	//	改成更新**當前這個真的在跑的 app**（os.Executable() 往上推 .app）：
	//	放哪都能更新，也不再無中生有一個 /Applications 的副本。
	target, err := runningAppBundlePath()
	if err != nil {
		return err
	}
	if out, err := runCmd("ditto", newApp, target); err != nil {
		return fmt.Errorf("覆蓋失敗（可能需要權限）：%v %s", err, out)
	}
	// 清掉 staged 標記，避免重啟後又提示一次
	_ = os.Remove(stagedMarkerPath())
	currentStaged = stagedUpdate{}
	if out, err := runCmd("open", "-n", target); err != nil {
		return fmt.Errorf("重新啟動失敗：%v %s", err, out)
	}
	go func() { time.Sleep(2 * time.Second); os.Exit(0) }()
	return nil
}

// runningAppBundlePath 回傳**現在正在跑的**那個 .app 路徑（t184）。
//
// 路徑長相：<某處>/Arcrun.app/Contents/MacOS/arcrun-tray
// ⇒ 從執行檔往上三層就是 .app 本體。
//
// 為什麼不寫死 /Applications：使用者常常就地執行（下載資料夾／桌面／隨身碟），
// 寫死會把新版蓋到他沒在跑的地方，而且 ditto 還會「成功」（見 applyStagedAndRestart 的註解）。
// 找不到 .app 結構時**誠實回錯**，不要猜一個路徑亂蓋——蓋錯地方比不更新更難查。
func runningAppBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("找不到自己的執行檔位置：%w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved // 走過 symlink 才是真身
	}
	// .../Arcrun.app/Contents/MacOS/arcrun-tray → 上三層
	app := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if filepath.Ext(app) != ".app" {
		return "", fmt.Errorf("這份 Arcrun RAG 不是從 .app 啟動的（%s）⇒ 請改用下載頁的 .app 版本再更新", exe)
	}
	return app, nil
}

// updateMenuLabel 回傳選單該顯示什麼（三種狀態，使用者一眼看懂要做什麼）。
// 回傳 ("", false) 代表不顯示這個項目。
func updateMenuLabel() (string, bool) {
	if s := loadStaged(); s.Ready {
		return "🟢 新版 " + s.Version + " 已就緒 — 點此重新啟動完成更新", true
	}
	if currentUpdate.Available {
		return "🟠 有新版 " + currentUpdate.Latest + " — 正在背景下載…", true
	}
	return "", false
}

// runCmd 執行外部命令並回傳合併輸出（本檔自用；package 內先前沒有同類 helper）。
func runCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// openPath 用系統預設方式開啟路徑（Windows 版更新暫以「開資料夾」收尾）。
func openPath(p string) error {
	if isWindows() {
		_, err := runCmd("cmd", "/c", "start", "", p)
		return err
	}
	_, err := runCmd("open", p)
	return err
}
