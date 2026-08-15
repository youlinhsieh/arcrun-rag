// repoguard.go — 認出「這個監看根是版本控制中的工作目錄」，並據此把 daemon 的手綁起來
// （arcrun-rag#105，2026-08-14 leo 實撞）。
//
// 🔴 為什麼要有這支檔：
//
//	2026-08-14 21:45，`InkStoneCo` 在看守清單裡，daemon 回報「已把 1 張舊卡片歸位」，
//	實際做的事是把 `system-dev/wiki/cards/autonomy/` 整個子目錄**壓平＋改名**：
//	`cards/autonomy/X.md` → `cards/arcrun-X.md`，**16 個版控中的檔案顯示為刪除**。
//	那些是 leo 自己寫的知識卡，不是 daemon 的產物。
//
//	程式沒有做錯它以為自己在做的事——`MigrateCardNames` 的註解白紙黑字寫著
//	「那兩個目錄從頭到尾只有 daemon 會寫」。**錯的是那個假設**：
//	`system-dev/wiki/cards/` 是 system-dev-template 的規約路徑，而 template 的用途
//	正是「裝進開發者自己的 repo」——所以在**任何裝過 template 的 repo 裡**，
//	那個目錄裡本來就有人家自己的檔案。「只有我們會寫」在 vault 上成立，在 repo 上不成立。
//
// 🔴 判準：`.git` 的存在。這夠不夠？（#105 明著問了這題）
//
//	夠，而且它是我們手上**唯一**不必猜的訊號：
//	`.git` 在＝這裡的每個檔案都有人在追它的歷史，改名／搬移都會變成 `git status` 上的
//	刪除＋新增，使用者一個 `git add -A` 就把我們的手筆 commit 進他的歷史。
//	它會不會漏（hg/svn/沒版控但很珍貴的資料夾）？會。但漏判的代價是「少整理一次」，
//	誤判的代價是「改掉別人版控中的檔案」——**代價不對稱，就往安全那邊倒**。
//
// ⇒ 兩條規則，本檔負責第一條，落點那條在 extract.go：
//
//	① 版控中的資料夾：**一個檔都不自動動**（改名/搬移一律停手，改成報告給使用者）。
//	② daemon 自己要寫的東西（卡片、工作區）：落進 `.arcrun-rag/`，並讓那個目錄
//	   對 git 完全隱形（見 EnsureWorkspaceIgnored）⇒ 跑完一輪 `git status` 是乾淨的。
package collector

import (
	"os"
	"path/filepath"
)

// workspaceRelDir＝daemon 在監看根底下唯一有權寫入的目錄。
// 卡片產物區（vaultCardsRelDir）與收容處（legacyTemplateRelDir）都住在它底下。
const workspaceRelDir = ".arcrun-rag"

// DetectRepoRoot 從 absPath 自己開始往上找最近的版控工作目錄，回傳它的根；
// 找不到回空字串。
//
// 認的是 `.git` **存在**，不分目錄或檔案：
//   - 目錄＝一般 clone。
//   - 檔案＝linked worktree（`git worktree add` 產生，內容是 `gitdir: …`）。
//     那一種同樣是版控中的工作目錄，同樣不能亂動；而且 #104 的實據裡
//     （`.claude/worktrees/…`、`products/arcrun-rag-wt60ship`）滿地都是。
//
// 停止條件與 DetectVaultContext 同一套保守原則：走到檔案系統根或使用者家目錄就停
// （家目錄本身若是個 repo——有人會 `git init ~`——不拿它把底下每個監看根都判成版控，
// 那種病態擺法的漏判，遠比誤判所有人便宜）。
func DetectRepoRoot(absPath string) string {
	dir := filepath.Clean(absPath)
	home := ""
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		home = filepath.Clean(h)
	}
	for {
		if home != "" && dir == home {
			return "" // 家目錄（含）以上不猜
		}
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "" // 檔案系統根
		}
		dir = parent
	}
}

// UnderVersionControl 是 DetectRepoRoot 的布林簡寫。
func UnderVersionControl(absPath string) bool { return DetectRepoRoot(absPath) != "" }

// IsLinkedWorktree 回答「這個目錄是不是 git 的 linked worktree 根」
// （`.git` 是檔案而非目錄）。#104 用它整棵跳過出貨用 worktree——
// 那些是主 repo 的第二份簽出，內容與主 repo 相同，收進去就是同一份收十幾次。
func IsLinkedWorktree(absDir string) bool {
	info, err := os.Lstat(filepath.Join(absDir, ".git"))
	return err == nil && !info.IsDir()
}

// IsRepoRoot 回答「這一層自己就是版控工作目錄的根」（不往上找）。
// #104 用它認出巢狀的子專案：監看根底下的獨立 repo 有自己的知識，
// 但那是**另一個專案**，要收請把它自己加進看守清單。
func IsRepoRoot(absDir string) bool {
	_, err := os.Lstat(filepath.Join(absDir, ".git"))
	return err == nil
}

// workspaceIgnoreBody＝寫進 `.arcrun-rag/.gitignore` 的內容。
//
// `*` 讓這個目錄底下的一切（含 .gitignore 自己）對 git 隱形 ⇒ 整個 `.arcrun-rag/`
// 不會出現在 `git status` 的 untracked 清單裡。**這正是 #105 驗收條件的機制**：
// daemon 要有地方放東西，但使用者的 `git status` 必須乾淨。
//
// 為什麼不去改使用者的 `.gitignore`：那是他版控中的檔案，改它就是我們自己犯的錯
// （同一條紅線）。自帶一份放在自己的目錄裡，git 一樣認，而且他刪掉整個
// `.arcrun-rag/` 就等於把我們留下的痕跡清乾淨，不留殘渣在他的檔案裡。
const workspaceIgnoreBody = "# 這個資料夾是 Arcrun RAG 同步小幫手的工作區，不是你的檔案。\n" +
	"# `*` 讓整個目錄對 git 隱形，你的 git status 不會因為我們跑過而變髒。\n" +
	"# 整個資料夾可以安全刪除（下次同步會重建，已同步的紀錄會重來一次）。\n" +
	"*\n"

// EnsureWorkspaceIgnored 確保 `<absRoot>/.arcrun-rag/.gitignore` 存在。
//
// 只在監看根落在版控範圍內時才需要（非版控資料夾沒有 git status 可弄髒），
// 但無條件呼叫也無害——多一個隱藏檔，不影響 vault（點開頭目錄筆記軟體本來就不掃）。
//
// 冪等且不覆蓋：檔案已存在就什麼都不做（使用者可能自己改過內容）。
// 失敗一律靜默——寫不進去最多是 git status 多一行 untracked，不值得中斷同步。
func EnsureWorkspaceIgnored(absRoot string) {
	dir := filepath.Join(absRoot, workspaceRelDir)
	target := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(target); err == nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(target, []byte(workspaceIgnoreBody), 0o644)
}
