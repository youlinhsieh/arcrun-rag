package main

// ⚠️ 本檔**逐字取自 arcrun-tray/selfupdate.go**（只拿掉 fyne 專屬的選單函式）。
// 理由：那裡面有踩過坑才長出來的東西——jsDelivr @main 的 ref 解析會卡死（t186 改走 raw）、
// 自更新要蓋「正在跑的那個 .app」而非寫死 /Applications（t184，Oscar 靜默失敗的真兇）。
// **兩邊哪天要改就兩邊一起改。**

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
// 做法（Mac）：解出 .app（見 extractAppFrom）→ 用 ditto 覆蓋正在跑的那份 → 重新 open → 結束自己。
// 做法（Windows）：見 applyWindowsUpdateAndRestart（rename 正在跑的 exe，標準自我更新手法）。
// 失敗時保留原版不動（寧可停在舊版，也不要弄出開不起來/開不動的執行檔）。
func applyStagedAndRestart() error {
	s := loadStaged()
	if !s.Ready || s.ZipPath == "" {
		return fmt.Errorf("沒有已備妥的更新")
	}
	if _, err := os.Stat(s.ZipPath); err != nil {
		return fmt.Errorf("更新檔不見了，請再檢查一次更新")
	}
	if isWindows() {
		return applyWindowsUpdateAndRestart(s.ZipPath)
	}
	work := updateStagePath("unpack")
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	newApp, err := extractAppFrom(s.ZipPath, work)
	if err != nil {
		return err
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

// extractAppFrom 從更新檔解出 Arcrun.app，回傳其路徑。依副檔名分流。
//
// 🔴 2026-08-08（leo 真機實測撞到）：出貨格式從 zip 換成了 dmg（t194 `build-dmg.sh`），
//
//	但這裡原本**只認 zip**（`ditto -x -k` 是解 zip 專用的參數）
//	⇒ 拿 dmg 餵它 ⇒ `ditto: Couldn't read PKZip signature`
//	⇒ 「檢查更新」從 v0.18.5 斷到 v0.18.22，至少七代都沒人發現
//	（詳見 wiki mistakes.md「出貨格式換了，消費它的程式沒換」）。
//	⇒ 依副檔名分流，兩種格式都吃得下——manifest 未來換回 zip 也不會再斷。
func extractAppFrom(path, work string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".dmg":
		return extractAppFromDMG(path, work)
	case ".zip":
		if out, err := runCmd("ditto", "-x", "-k", path, work); err != nil {
			return "", fmt.Errorf("解壓失敗：%v %s", err, out)
		}
		app := filepath.Join(work, "Arcrun.app")
		if _, err := os.Stat(app); err != nil {
			return "", fmt.Errorf("更新檔內容不符（找不到 Arcrun.app）")
		}
		return app, nil
	default:
		return "", fmt.Errorf("不認得的更新檔格式（%s）：非 .dmg 也非 .zip", filepath.Ext(path))
	}
}

// extractAppFromDMG 掛載 dmg、把裡面的 Arcrun.app 複製到 work 目錄下、卸載。
// 掛載點用固定路徑（`-mountpoint`），不必解析 hdiutil 的文字輸出去猜掛去哪。
func extractAppFromDMG(dmgPath, work string) (string, error) {
	mount := filepath.Join(work, "mnt")
	if err := os.MkdirAll(mount, 0o755); err != nil {
		return "", err
	}
	if out, err := runCmd("hdiutil", "attach", dmgPath, "-nobrowse", "-noautoopen", "-mountpoint", mount); err != nil {
		return "", fmt.Errorf("掛載 DMG 失敗：%v %s", err, out)
	}
	defer func() { _, _ = runCmd("hdiutil", "detach", mount, "-quiet") }()
	src := filepath.Join(mount, "Arcrun.app")
	if _, err := os.Stat(src); err != nil {
		return "", fmt.Errorf("DMG 裡找不到 Arcrun.app")
	}
	dst := filepath.Join(work, "Arcrun.app")
	if out, err := runCmd("ditto", src, dst); err != nil {
		return "", fmt.Errorf("從 DMG 複製失敗：%v %s", err, out)
	}
	return dst, nil
}

// runCmd 執行外部命令並回傳合併輸出（本檔自用；package 內先前沒有同類 helper）。
func runCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ── Windows 自我更新（2026-08-08，leo 補充事實後改寫）─────────────────────────
//
// 舊版本這裡只是「開資料夾讓使用者取用」，理由寫著「Windows 版走各自的安裝流程」。
// leo 08-08 點破：那是併檔前（v0.18.9 之前）的殘留假設——
//
//	「Windows 沒有資料夾，它現在是 exe，單一的。」
//
// v0.18.9（4a26856）已把 collector 併進同一支執行檔，磁碟上只有單一 Arcrun.exe。
// 「開資料夾」現在等於叫使用者自己去找那支 exe 手動換掉——正是要消滅的手動步驟。
//
// Windows 不能覆寫「正在執行中」的 exe（內容被鎖），但**可以 rename 它**——
// 執行中的映像檔預設以 FILE_SHARE_DELETE 開啟，rename/delete 不受阻，
// 這是 Windows 自我更新程式的標準手法（VSCode／Chrome 等同款做法）：
//  1. 把正在跑的 Arcrun.exe rename 成 Arcrun.exe.old（不影響正在跑的行程）
//  2. 把新版 exe 搬到原本的路徑
//  3. 用原路徑重新啟動 → 結束自己
//  4. 下次啟動時清掉殘留的 .old（此時舊行程已結束、沒人持鎖，見 cleanupOldExe）
//
// 任一步失敗就誠實回錯、盡量復原，不留「舊的不見了、新的沒建好」的半套狀態。
func applyWindowsUpdateAndRestart(newExePath string) error {
	cur, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到自己的執行檔位置：%w", err)
	}
	if resolved, err := filepath.EvalSymlinks(cur); err == nil {
		cur = resolved
	}
	old := cur + ".old"
	_ = os.Remove(old) // 清掉上一輪沒清乾淨的殘留（不擋主流程）
	if err := os.Rename(cur, old); err != nil {
		return fmt.Errorf("換掉正在跑的執行檔失敗（rename）：%w", err)
	}
	if err := moveFile(newExePath, cur); err != nil {
		// 盡量復原，不留「舊的不見了、新的沒建好」的半套狀態
		_ = os.Rename(old, cur)
		return fmt.Errorf("寫入新版執行檔失敗：%w", err)
	}
	_ = os.Remove(stagedMarkerPath())
	currentStaged = stagedUpdate{}
	// `cmd /c start` 只負責喚起新行程就回傳，不會等新行程跑完（與 mac 的 `open -n` 同款行為）。
	if out, err := runCmd("cmd", "/c", "start", "", cur); err != nil {
		// 復原：新版已經在原路徑了，重啟失敗至少別把舊的删了拿不回來
		return fmt.Errorf("重新啟動失敗：%v %s（新版已就緒於 %s，可手動雙擊開啟）", err, out, cur)
	}
	go func() { time.Sleep(2 * time.Second); os.Exit(0) }()
	return nil
}

// cleanupOldExe 清掉上一輪更新留下的 `<exe>.old`（Windows 專用）。
// 呼叫時機＝App 啟動時：這時**新行程剛啟動、舊行程已經結束**，.old 不再被任何人持鎖，
// 才是唯一保證刪得掉的時間點（更新當下 rename 完就想刪，舊行程還沒真的死，會失敗）。
// 找不到／刪不掉都不當錯誤處理——它只是暫存垃圾，留著不影響功能，別讓清理步驟擋住啟動。
func cleanupOldExe() {
	if !isWindows() {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	_ = os.Remove(exe + ".old")
}

// moveFile 把 src 搬到 dst：同磁碟區走 os.Rename（原子、快），
// 跨磁碟區（rename 回傳 err，例如更新暫存區跟安裝目錄不同槽）退回複製後砍來源。
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Remove(src)
	return nil
}
