// vault_test.go — arcrun-rag#60：驗 vault 偵測跟 system-dev-template/scripts/install.sh:209-221
// 的 bash 判準逐條對齊（同一個資料夾兩邊必須得出同一個答案）。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectVaultType_Logseq(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	mustMkdir(t, filepath.Join(root, "pages"))
	mustMkdir(t, filepath.Join(root, "journals"))
	if got := DetectVaultType(root); got != VaultLogseq {
		t.Fatalf("DetectVaultType=%q，want %q", got, VaultLogseq)
	}
	if !IsVault(root) {
		t.Fatal("IsVault 應為 true")
	}
}

func TestDetectVaultType_Obsidian(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, ".obsidian"))
	if got := DetectVaultType(root); got != VaultObsidian {
		t.Fatalf("DetectVaultType=%q，want %q", got, VaultObsidian)
	}
	if !IsVault(root) {
		t.Fatal("IsVault 應為 true")
	}
}

func TestDetectVaultType_PlainFolder(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "docs"))
	if got := DetectVaultType(root); got != VaultNone {
		t.Fatalf("DetectVaultType=%q，want VaultNone（一般資料夾不該被認成 vault）", got)
	}
	if IsVault(root) {
		t.Fatal("IsVault 應為 false")
	}
}

// 兩者都有時，install.sh 用 if/elif（logseq 優先）——Go 這邊也要一樣的優先序。
func TestDetectVaultType_BothPresent_LogseqWins(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	mustMkdir(t, filepath.Join(root, ".obsidian"))
	if got := DetectVaultType(root); got != VaultLogseq {
		t.Fatalf("DetectVaultType=%q，want %q（install.sh 用 if/elif，logseq 優先）", got, VaultLogseq)
	}
}

// 空資料夾也不該被誤判成 vault。
func TestDetectVaultType_EmptyFolder(t *testing.T) {
	root := t.TempDir()
	if got := DetectVaultType(root); got != VaultNone {
		t.Fatalf("DetectVaultType=%q，want VaultNone", got)
	}
}

// install.sh 判準是「-d logseq」——檔案（非目錄）叫這名字不算數。
func TestDetectVaultType_FileNotDir_DoesNotCount(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "logseq"), []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := DetectVaultType(root); got != VaultNone {
		t.Fatalf("DetectVaultType=%q，want VaultNone（logseq 是檔案不是目錄，不該算 vault）", got)
	}
}

// cardsRelDirFor：非 vault 行為不變（回歸），vault 改落隱藏目錄。
func TestCardsRelDirFor(t *testing.T) {
	plain := t.TempDir()
	if got := cardsRelDirFor(plain); got != cardsRelDir {
		t.Fatalf("非 vault：cardsRelDirFor=%q，want %q（既有行為不能變）", got, cardsRelDir)
	}

	vault := t.TempDir()
	mustMkdir(t, filepath.Join(vault, "logseq"))
	if got := cardsRelDirFor(vault); got != vaultCardsRelDir {
		t.Fatalf("vault：cardsRelDirFor=%q，want %q", got, vaultCardsRelDir)
	}
	// vault 目的地必須是隱藏（點開頭）路徑——這是「Logseq/Obsidian/daemon 自己的 scan.go
	// 都不掃描」的唯一保證來源，不能改掉。
	if filepath.Base(filepath.Dir(vaultCardsRelDir))[0] != '.' && vaultCardsRelDir[0] != '.' {
		t.Fatalf("vaultCardsRelDir=%q 不是隱藏路徑，vault 頁面數保護會失效", vaultCardsRelDir)
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}
