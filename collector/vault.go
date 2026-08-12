// vault.go — 判斷「daemon 要寫的東西，會不會落進使用者的筆記庫（Logseq/Obsidian）」。
//
// 本檔有**兩層**判準，回答兩個不同的問題，混用就是 bug：
//
//	· DetectVaultType(dir)   ＝「**這一層**是不是筆記庫」。逐字對齊 install.sh，
//	                            給「使用者親手指定的那個資料夾」用。
//	· DetectVaultContext(root)＝「這個監看根**在不在**某個筆記庫的範圍內」（會往上找）。
//	  VaultDirUnder(root,dst) ＝「這個寫入目標**會不會踩進**某個子筆記庫」（往下擋）。
//	                            決定「寫哪裡／能不能寫」一律用這一組。
//
// 前兩輪只有第一層，於是「監看根是 vault 底下的子資料夾」整個繞過保護——
// 全文見下方「第三輪」那段。
//
// 🔴 為什麼有這支檔（arcrun-rag#60，2026-08-10 leo 實撞）：
//
//	daemon 把萃取產物（知識卡）寫進了使用者的 Logseq vault，讓 vault 平白多出一堆
//	機器寫的頁面——Logseq/Obsidian 這種筆記軟體，vault 底下每個 .md 都會變成一頁，
//	一般資料夾則不會。daemon 原本沒有這層辨識（改寫成 Go 版時沒把舊邏輯帶過來）。
//
// 判準**逐條抄自** system-dev-template/scripts/install.sh:209-221（「偵測 vault 類型」段）：
//
//	if [ -d "logseq" ]; then      VAULT_TYPE="logseq";   IS_VAULT="yes"
//	elif [ -d ".obsidian" ]; then VAULT_TYPE="obsidian"; IS_VAULT="yes"
//	else                          VAULT_TYPE="docs"      （不是 vault）
//
// 🔴 同一個資料夾，安裝器（bash）與這支 daemon（Go）必須得出同一個答案——兩邊分歧本身
// 就是 bug。之後任一邊改判準，要同步改另一邊（或把判準抽成單一真相源腳本）。
package collector

import (
	"os"
	"path/filepath"
	"strings"
)

// VaultType 是偵測結果的字串常數，值刻意跟 install.sh 的 VAULT_TYPE 用同一組字。
type VaultType string

const (
	VaultNone     VaultType = ""        // 一般資料夾（install.sh 裡叫 "docs"）
	VaultLogseq   VaultType = "logseq"
	VaultObsidian VaultType = "obsidian"
)

// DetectVaultType 判斷 absRoot 是不是筆記軟體的 vault，回傳偵測到的類型。
// 只看 absRoot 這一層（不遞迴往上找），跟 install.sh 在目標資料夾根目錄跑 `[ -d "logseq" ]`
// 語意一致。順序也刻意跟 install.sh 一致：先查 logseq/，再查 .obsidian/。
func DetectVaultType(absRoot string) VaultType {
	if isDir(filepath.Join(absRoot, "logseq")) {
		return VaultLogseq
	}
	if isDir(filepath.Join(absRoot, ".obsidian")) {
		return VaultObsidian
	}
	return VaultNone
}

// IsVault 是 DetectVaultType 的布林簡寫，供只關心「**這一層**是不是 vault」的呼叫端用。
//
// ⚠️ 要決定「daemon 可不可以在這裡寫東西」請**不要**用這支——用 DetectVaultContext。
// 理由見下方 DetectVaultContext 的開頭：監看根不是 vault，不代表它不在別人的 vault 裡面。
func IsVault(absRoot string) bool {
	return DetectVaultType(absRoot) != VaultNone
}

// ─────────────────────────────────────────────────────────────────────────────
// 第三輪（arcrun-rag#60，2026-08-12）：vault 不是「一層」，是「一個範圍」
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 前兩輪的共同盲點：所有判斷都問「**監看根這一層**是不是 vault」，
// 而 daemon 的產物一律落在**監看根底下**。這兩件事只有在「監看根 == vault 根」時
// 才等價——而那正好是前兩輪唯一測過的擺法。
//
// 只要使用者把 vault 底下的**某一層子資料夾**加進監看（`KB/docs`、`KB/pages`、
// Obsidian 庫裡的某個專案夾——這是很自然的用法：「我只想讓它讀這一區」），
// DetectVaultType 就回 VaultNone ⇒ 整套保護退回一般資料夾模式 ⇒ 卡片落在
// `<監看根>/system-dev/wiki/cards/`，而那個路徑**就在使用者的 vault 裡面**，
// 且不是隱藏目錄 ⇒ Logseq/Obsidian 會把每一張卡收編成一頁。
// 前綴（machinemark.go）只擋得住「撞名」，擋不住「多出一堆機器頁」。
//
// ⇒ 正確的問題不是「這個資料夾是不是 vault」，是「**我要寫的東西會不會落進誰的 vault**」。
// 那是一個範圍問題，要往上找（我在不在某個 vault 裡）也要往下擋（我會不會踩進某個子庫）。
//
// 為什麼往上找要用比 DetectVaultType 更嚴的判準（ancestorVaultTypeAt）：
// DetectVaultType 是**使用者親手指定的那一個資料夾**的判準，必須逐字對齊 install.sh；
// 往上找則是**替使用者猜**，而且一次要猜好幾層——同樣的誤判率乘上層數，代價完全不同。
// 一個叫 `logseq` 的普通資料夾（放筆記軟體匯出檔、放腳本的人都有）擺在家目錄或
// 專案目錄裡，就會讓它底下所有監看根被誤判成「在 vault 裡」。所以往上找時
// **要求佐證**：`logseq/config.edn`（Logseq 開過的 graph 一定有）或 `journals/`／`pages/`。
// `.obsidian/` 是點開頭的專用目錄，不存在這種誤判，不必佐證。

// VaultContext 描述「監看根與筆記庫的關係」——daemon 要決定寫哪裡時看的是這個，不是 IsVault。
type VaultContext struct {
	Type VaultType // VaultNone＝這個監看根不在任何筆記庫的範圍內
	Root string    // 筆記庫的根（絕對路徑）；Type==VaultNone 時為空字串
	Self bool      // true＝筆記庫的根就是監看根本身（前兩輪唯一處理到的那條路）
}

// InVault 回答「這個監看根落在某個筆記庫的範圍內嗎」（含監看根自己就是庫的情況）。
func (c VaultContext) InVault() bool { return c.Type != VaultNone }

// DetectVaultContext 從 absRoot 自己開始，一路往上找到最近的筆記庫根。
//
// 順序刻意是「先自己、再往上」：自己這一層用 DetectVaultType（與 install.sh 同一套字），
// 往上才用 ancestorVaultTypeAt（要佐證，理由見上）。
//
// 停止條件兩個，都是為了不要往上猜過頭：
//   - 走到檔案系統根就停（parent == dir）。
//   - 走到使用者家目錄就停，且**不檢查家目錄本身**——`~/logseq` 這種名字的資料夾
//     太常見（Logseq 的 graph 常直接放在那），拿它把整個家目錄判成 vault，
//     會讓家目錄底下每一個監看根都改變行為。代價不對稱：漏判一個「家目錄本身就是
//     筆記庫」的病態擺法，遠比誤判所有人便宜。
func DetectVaultContext(absRoot string) VaultContext {
	absRoot = filepath.Clean(absRoot)
	if vt := DetectVaultType(absRoot); vt != VaultNone {
		return VaultContext{Type: vt, Root: absRoot, Self: true}
	}
	home := ""
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		home = filepath.Clean(h)
	}
	for dir := absRoot; ; {
		parent := filepath.Dir(dir)
		if parent == dir {
			return VaultContext{} // 檔案系統根
		}
		dir = parent
		if home != "" && dir == home {
			return VaultContext{} // 家目錄（含）以上不猜
		}
		if vt := ancestorVaultTypeAt(dir); vt != VaultNone {
			return VaultContext{Type: vt, Root: dir}
		}
	}
}

// ancestorVaultTypeAt 是「往上找／往下擋」共用的**嚴格**判準：
// 不是使用者親手指定的資料夾，就要有佐證才算數（理由見本段開頭的長註解）。
// 優先序與 install.sh 一致：logseq 先於 obsidian。
func ancestorVaultTypeAt(dir string) VaultType {
	if isDir(filepath.Join(dir, "logseq")) && logseqCorroborated(dir) {
		return VaultLogseq
	}
	if isDir(filepath.Join(dir, ".obsidian")) {
		return VaultObsidian
	}
	return VaultNone
}

// logseqCorroborated：除了 `logseq/` 之外，還看得到 Logseq graph 的其他證據嗎。
// config.edn＝Logseq 開過這個 graph 就會有；journals/ 與 pages/ 是 graph 的骨架目錄。
func logseqCorroborated(dir string) bool {
	if isFile(filepath.Join(dir, "logseq", "config.edn")) {
		return true
	}
	return isDir(filepath.Join(dir, "journals")) || isDir(filepath.Join(dir, "pages"))
}

// VaultDirUnder 往**下**擋：從 absRoot 走到 absTarget 的路上，有沒有踩進某個子筆記庫。
// 命中就回傳那個子庫的絕對路徑與類型。
//
// 🔴 這支刻意**只走 absTarget 這一條路徑上的目錄**（幾層而已），不 walk 整棵樹——
// 使用者的筆記庫可能有幾萬個檔，每次落卡掃一遍是不能接受的成本，而且也沒必要：
// 我們只需要知道「**我這次要寫的這個位置**安不安全」，不需要知道樹裡還有哪些庫。
//
// 目前所有寫檔點的目標都錨在監看根（system-dev/wiki/cards 或 .arcrun-rag/wiki/cards），
// 所以這支正常情況下永遠不命中。它存在的意義是**機械閘**：以後誰新增一個
// 「把產物寫在原稿旁邊」之類的寫檔點，會在這裡當場被擋下來，而不是在某個
// 陌生人的筆記庫裡被發現。
func VaultDirUnder(absRoot, absTarget string) (string, VaultType) {
	rel, err := filepath.Rel(filepath.Clean(absRoot), filepath.Clean(absTarget))
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", VaultNone // 目標不在監看根底下，本支不負責
	}
	dir := filepath.Clean(absRoot)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	// 最後一段是檔名，不必檢查；中間每一層目錄都要。
	for _, seg := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, seg)
		if vt := ancestorVaultTypeAt(dir); vt != VaultNone {
			return dir, vt
		}
	}
	return "", VaultNone
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
