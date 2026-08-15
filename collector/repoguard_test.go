// repoguard_test.go — arcrun-rag#105 的驗收網：**把一個 git repo 加進看守清單跑一輪，
// git status 必須乾淨。**
//
// 這張網刻意分兩層：
//   - 單元層（不需要 git 執行檔）：MigrateCardNames 在版控資料夾裡一個檔都沒動。
//     這是 2026-08-14 那件事的直接迴歸——當時被壓平改名的正是
//     `system-dev/wiki/cards/autonomy/*.md`。
//   - 端到端層（需要 git）：真的 `git init`、真的 commit、真的跑一輪同步、
//     真的 `git status --porcelain` ⇒ 必須是空的。沒有 git 就 skip，不假裝驗過。
package collector

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// gitOrSkip 準備一個「已 commit 乾淨」的 repo；環境沒有 git 就 skip。
func gitOrSkip(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("這台機器沒有 git，跳過端到端層（單元層仍然有跑）")
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
		{"add", "-A"},
		{"commit", "-q", "-m", "初始"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失敗：%v\n%s", args, err, out)
		}
	}
}

func gitStatus(t *testing.T, dir string) []string {
	t.Helper()
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git status 失敗：%v\n%s", err, out)
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	return lines
}

// 🔴 2026-08-14 21:45 那件事的直接迴歸：leo 的 `InkStoneCo` 在看守清單裡，
// daemon 把 `system-dev/wiki/cards/autonomy/` 整個子目錄壓平改名，
// 16 個版控中的檔案顯示為刪除。
func TestMigrateCardNames_VersionedRepoUntouched(t *testing.T) {
	root := t.TempDir()
	// leo 自己寫的知識卡，住在 template 規約的卡片產物區底下（還有自己開的子目錄）。
	writeFixture(t, root, map[string]string{
		"system-dev/wiki/cards/autonomy/自動派工心法.md": "# 我自己寫的",
		"system-dev/wiki/cards/autonomy/接關術.md":    "# 我自己寫的",
		"system-dev/wiki/cards/決策紀錄.md":            "# 我自己寫的",
	})
	// 這個資料夾在版控裡（只放 .git 目錄就夠——判準不需要 git 執行檔）。
	mustMkdir(t, filepath.Join(root, ".git"))

	before := snapshotTree(t, root)
	mig := MigrateCardNames(root)
	after := snapshotTree(t, root)

	if mig.Moved != 0 {
		t.Fatalf("在版控資料夾裡動了 %d 個檔——這正是 #105 的病", mig.Moved)
	}
	if mig.RepoRoot != root {
		t.Fatalf("沒認出這是版控資料夾（RepoRoot=%q，want %q）", mig.RepoRoot, root)
	}
	// Blocked 只算「確定是我們寫的」——使用者自己的卡不該被算進去報一個假數字。
	if mig.Blocked != 0 {
		t.Fatalf("Blocked=%d，但這三張都是使用者自己的卡（沒帶 arcrun- 標記），"+
			"報進去等於告訴他「有 3 個舊卡片沒整理」，那是假訊息", mig.Blocked)
	}

	if len(before) != len(after) {
		t.Fatalf("檔案數變了：%d → %d", len(before), len(after))
	}
	for rel, want := range before {
		got, still := after[rel]
		if !still {
			t.Fatalf("版控中的檔案不見了：%s（這就是 leo 看到的那 16 個刪除）", rel)
		}
		if got.hash != want.hash {
			t.Fatalf("版控中的檔案被改了：%s", rel)
		}
	}
}

// 我們自己寫的卡（帶標記、只是位置舊）在版控資料夾裡同樣不自動動，
// 但**要被算進 Blocked 並講給使用者聽**——那個數字是誠實的，因為那些確實是我們的。
func TestMigrateCardNames_VersionedRepoReportsOwnCards(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"system-dev/wiki/cards/arcrun-舊卡.md": "# 我們寫的，位置舊了",
		"system-dev/wiki/cards/他自己的卡.md":     "# 使用者的",
	})
	mustMkdir(t, filepath.Join(root, ".git"))

	mig := MigrateCardNames(root)
	if mig.Moved != 0 {
		t.Fatalf("版控資料夾裡不該動任何檔，卻動了 %d 個", mig.Moved)
	}
	if mig.Blocked != 1 {
		t.Fatalf("Blocked=%d，want 1（只有那張帶 arcrun- 標記的是我們的）", mig.Blocked)
	}
}

// 非版控資料夾的行為必須與 #60 第三輪完全一致——本次改動不准把那兩輪的成果弄壞。
func TestMigrateCardNames_NonRepoStillMigrates(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"system-dev/wiki/cards/舊卡.md": "# 舊",
	})
	mig := MigrateCardNames(root)
	if mig.Moved != 1 {
		t.Fatalf("非版控資料夾應照舊自動歸位，Moved=%d want 1", mig.Moved)
	}
	if _, err := os.Stat(filepath.Join(root, "system-dev", "wiki", "cards", "arcrun-舊卡.md")); err != nil {
		t.Fatalf("舊卡沒被改名：%v", err)
	}
}

// 🔴 #105 的驗收條件本身：**把一個 git repo 加進看守清單跑一輪，git status 必須乾淨。**
func TestSyncOnce_GitRepoStaysClean(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"system-dev/wiki/cards/autonomy/自動派工心法.md": "# 我自己寫的知識卡",
		"system-dev/wiki/status.md":                "# 現況",
		"docs/請假規則.md":                             "# 特休 14 天",
		"README.md":                                "# 這個專案",
		"main.go":                                  "package main",
	})
	gitOrSkip(t, root)

	if dirty := gitStatus(t, root); len(dirty) > 0 {
		t.Fatalf("前置條件就不乾淨：%v", dirty)
	}

	runSyncOnce(t, root)

	if dirty := gitStatus(t, root); len(dirty) > 0 {
		sort.Strings(dirty)
		t.Fatalf("跑完一輪後 git status 髒了（#105 的驗收條件就是這個）：\n%s",
			strings.Join(dirty, "\n"))
	}
}
