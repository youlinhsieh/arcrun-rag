// vault.go — 偵測監看根是不是筆記軟體的 vault（Logseq/Obsidian）。
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

// IsVault 是 DetectVaultType 的布林簡寫，供只關心「是不是 vault」的呼叫端用。
func IsVault(absRoot string) bool {
	return DetectVaultType(absRoot) != VaultNone
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
