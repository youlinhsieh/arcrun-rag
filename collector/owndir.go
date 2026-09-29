// owndir.go — 對作業系統宣告「這個資料夾是 Arcrun RAG 自己建的」（inkstone/arcrun-rag#193）。
//
// 為什麼需要（leo 2026-09-10）：「Windows 沒有在資料夾前加「.」就隱藏嗎？
// 需要對 Windows 版另外處理讓資料夾隱形？」
//
// `.wiki/`、`.arcrun-rag/` 用點開頭，是為了讓 Logseq／Obsidian／daemon 自己的 Scan 三邊都跳過
// （extract.go 那段註解），**不是為了對作業系統隱形**。點開頭＝隱藏是 Unix／macOS 的慣例；
// Windows 檔案總管認的是檔案系統屬性 `FILE_ATTRIBUTE_HIDDEN`，所以同一份 code 在 Windows 上
// 會把每一層的 `.wiki` 全部亮出來，使用者以為自己的資料夾被塞了東西。
//
// 這裡只做一件事：daemon 每次「宣告某個資料夾是我們的」（寫 .gitignore 的那兩個 chokepoint）
// 時，順手把作業系統層的隱藏屬性也掛上。**只掛在我們自己建的目錄上**——`.wiki/` 與
// `.arcrun-rag/` 本身——使用者的檔案與資料夾一個屬性都不碰（票的紅線）。
//
// 可逆：檔案總管「顯示隱藏的項目」打開就看得到；沒有改名、沒有搬家。
// 非 Windows 平台是 no-op（owndir_other.go），mac 行為零改變。
package collector

import (
	"os"
	"sort"
	"sync"
)

// hideOwnDir 是平台實作的掛鉤點：Windows 掛 FILE_ATTRIBUTE_HIDDEN，其他平台什麼都不做。
// 做成變數是為了讓跨平台測試能在 Linux／mac 上驗「哪些目錄被宣告過」（owndir_test.go），
// 不必等到有 Windows 機器才知道接線有沒有斷。
var hideOwnDir = hideOwnDirPlatform

// markOwnDirHidden 把 dir 標成「作業系統層隱藏」。
//
// 失敗一律靜默：跟 ensureWikiIgnored／EnsureWorkspaceIgnored 同一個原則——
// 隱不隱藏是外觀問題，不值得為它中斷同步；最壞情況就是回到本版之前的樣子（看得到）。
// 只對**目錄**做，而且目錄不存在就不做（不替別人建目錄）。
func markOwnDirHidden(dir string) {
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() {
		return
	}
	_ = hideOwnDir(dir)
}

// hideKnownWikiDirs 把監看根底下**已經存在**的每一層 `.wiki/` 補上隱藏屬性。
//
// 為什麼要有這一支：chokepoint 只在「這一輪有寫到那個 .wiki」時才會掛屬性；
// 升級前就長出來的幾十上百層 `.wiki`（本版之前在 Windows 上全部看得見），
// 若沒有任何文件重萃，永遠輪不到它們。
// 不走訪整棵樹：監看根的 `.wiki/manifest.json`（wiki 帳本）記著每一份文件屬於哪個節點，
// 有 `.wiki` 的節點就是帳本上出現過的節點——直接照帳本點名，成本＝節點數個 stat。
// 非 Windows 平台整支直接 return，連帳本都不讀。
// 一個行程對同一個監看根只掃一次（sweptRoots）：之後新長出來的 .wiki 由 chokepoint 掛，
// 而使用者若自己把某個 .wiki 的隱藏屬性拿掉，我們不會每五秒把它掛回去。
func hideKnownWikiDirs(absRoot string) {
	if !ownDirHidingSupported {
		return
	}
	if _, done := sweptRoots.LoadOrStore(absRoot, true); done {
		return
	}
	for _, dir := range knownWikiDirs(absRoot) {
		markOwnDirHidden(dir)
	}
}

var sweptRoots sync.Map

// knownWikiDirs 照 wiki 帳本列出監看根底下**存在**的 `.wiki/` 目錄（含根層），去重、固定順序。
// 拆成獨立函式是為了讓非 Windows 平台也測得到「點名點對了沒」——掛屬性那半只有 Windows 跑得到。
func knownWikiDirs(absRoot string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(node string) {
		dir := wikiDirFor(absRoot, node)
		if seen[dir] {
			return
		}
		seen[dir] = true
		if st, err := os.Lstat(dir); err == nil && st.IsDir() {
			out = append(out, dir)
		}
	}
	add("") // 根層那個（帳本自己就住在裡面）
	for _, d := range loadWikiManifest(absRoot).Docs {
		add(nodeFromKey(d.Node))
	}
	sort.Strings(out)
	return out
}
