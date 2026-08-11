// safewrite_test.go — arcrun-rag#60 第二條：落卡前不得無條件覆蓋既有檔案。
package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 目標不存在＝正常首次落卡，行為不變。
func TestSafeWriteCard_NewFile(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "sub", "foo.md")
	if err := safeWriteCard(dest, []byte("# foo\n內容")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "# foo\n內容" {
		t.Fatalf("內容不對：%q", got)
	}
}

// 核心紅線：目標已存在且內容不同 → 先備份既有內容，不能無聲蓋掉。
func TestSafeWriteCard_ExistingFile_BacksUpBeforeOverwrite(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "foo.md")
	original := "# foo\n這是使用者原本就有的東西，不是 daemon 寫的"
	if err := os.WriteFile(dest, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := safeWriteCard(dest, []byte("# foo\n機器新產出的卡")); err != nil {
		t.Fatal(err)
	}

	// 新內容確實寫進去了（這是萃取的目的，不是完全拒寫）。
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "# foo\n機器新產出的卡" {
		t.Fatalf("新內容未寫入：%q", got)
	}

	// 但舊內容必須找得到備份，不能憑空消失。
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var backup string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "foo.md.bak-") {
			backup = filepath.Join(dir, e.Name())
		}
	}
	if backup == "" {
		t.Fatalf("沒有找到備份檔，既有內容可能已經被無聲覆蓋。目錄內容：%v", entries)
	}
	backupData, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(backupData) != original {
		t.Fatalf("備份內容不對：%q，want %q", backupData, original)
	}
}

// 內容完全相同（重複萃取同一份卡）＝不必動它，也不必產生垃圾備份。
func TestSafeWriteCard_SameContent_NoOp(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "foo.md")
	content := "# foo\n一樣的內容"
	if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := safeWriteCard(dest, []byte(content)); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("內容沒變不該產生額外檔案，目錄內容：%v", entries)
	}
}
