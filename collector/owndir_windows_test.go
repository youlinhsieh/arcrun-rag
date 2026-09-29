//go:build windows

// owndir_windows_test.go — 只有 Windows 跑得到的那一半（inkstone/arcrun-rag#193）：
// ① 屬性真的掛上了、可重複、不洗掉別的屬性；
// ② `inkstone/arcrun-rag#138` 的斷連清理在隱藏目錄上照樣列得到（Go 的 os.ReadDir 不看隱藏屬性）。
// 在 Windows 機上跑：go test -run 'Windows' ./collector/
package collector

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func winAttrs(t *testing.T, p string) uint32 {
	t.Helper()
	u, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		t.Fatal(err)
	}
	a, err := syscall.GetFileAttributes(u)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestWindows_HideOwnDirSetsHiddenAndKeepsOtherAttrs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".wiki")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	before := winAttrs(t, dir)
	if before&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
		t.Fatalf("新建目錄不該一開始就是隱藏：%#x", before)
	}
	markOwnDirHidden(dir)
	after := winAttrs(t, dir)
	if after&syscall.FILE_ATTRIBUTE_HIDDEN == 0 {
		t.Fatalf("沒掛上 Hidden：%#x", after)
	}
	if after&^syscall.FILE_ATTRIBUTE_HIDDEN != before&^syscall.FILE_ATTRIBUTE_HIDDEN {
		t.Fatalf("其他屬性被改了：before=%#x after=%#x", before, after)
	}
	markOwnDirHidden(dir) // 冪等
	if winAttrs(t, dir) != after {
		t.Fatal("第二次掛屬性改變了結果")
	}
	// 隱藏之後，往裡面寫檔、重寫 .gitignore 都要照常（目錄隱藏不影響底下的檔）。
	if err := os.WriteFile(filepath.Join(dir, "卡.md"), []byte("# 卡\n"), 0o644); err != nil {
		t.Fatalf("隱藏目錄底下寫檔失敗：%v", err)
	}
	ensureWikiIgnored(dir)
	if _, err := os.Stat(filepath.Join(dir, ".gitignore")); err != nil {
		t.Fatalf(".gitignore 沒寫進隱藏目錄：%v", err)
	}
}

// #138 的驗收條件之一：清理列舉在 hidden 目錄上照樣列得到。
func TestWindows_CleanupStillEnumeratesHiddenDirs(t *testing.T) {
	root := t.TempDir()
	makeRootManifest(t, root, map[string][]string{
		"":     {".wiki/根卡.md"},
		"docs": {"docs/.wiki/文件卡.md"},
	})
	makeWiki(t, filepath.Join(root, ".wiki"), "根卡.md")
	makeWiki(t, filepath.Join(root, "docs", ".wiki"), "文件卡.md")
	makeWorkspace(t, root)
	cuWriteFile(t, filepath.Join(root, "docs", "使用者的.md"), "# 我的\n")

	// 模擬升級後跑過一輪：帳本點名＋工作區宣告，三個目錄全部掛上 Hidden。
	EnsureWorkspaceIgnored(root)
	for _, d := range knownWikiDirs(root) {
		markOwnDirHidden(d)
	}
	for _, d := range []string{
		filepath.Join(root, ".wiki"),
		filepath.Join(root, "docs", ".wiki"),
		filepath.Join(root, ".arcrun-rag"),
	} {
		if winAttrs(t, d)&syscall.FILE_ATTRIBUTE_HIDDEN == 0 {
			t.Fatalf("%s 沒隱藏", d)
		}
	}

	plan, err := PlanCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	rels := []string{}
	for _, r := range plan.Remove {
		rels = append(rels, r.Rel)
	}
	joined := strings.Join(rels, "\n")
	for _, want := range []string{".wiki", "docs/.wiki", ".arcrun-rag"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("清理清單漏了隱藏目錄 %s：\n%s", want, joined)
		}
	}
	for _, r := range rels {
		if strings.Contains(r, "使用者的") {
			t.Fatalf("清理清單碰到使用者的檔：%s", r)
		}
	}
	// 真的刪：隱藏屬性不擋 RemoveAll。
	if _, res, err := ApplyCleanup(root, nil); err != nil || len(res.Failed) > 0 {
		t.Fatalf("套用清理失敗：err=%v failed=%v", err, res)
	}
	for _, d := range []string{filepath.Join(root, ".wiki"), filepath.Join(root, "docs", ".wiki"), filepath.Join(root, ".arcrun-rag")} {
		if _, err := os.Lstat(d); err == nil {
			t.Fatalf("隱藏目錄沒被清掉：%s", d)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "使用者的.md")); err != nil {
		t.Fatalf("使用者的檔不見了：%v", err)
	}
}

func TestWindows_LongPathPrefix(t *testing.T) {
	short := `C:\Users\leo\KB\.wiki`
	if got := longPath(short); got != short {
		t.Fatalf("短路徑不該動：%s", got)
	}
	long := `C:\` + strings.Repeat(`很長的資料夾名\`, 40) + `.wiki`
	if got := longPath(long); !strings.HasPrefix(got, `\\?\C:\`) {
		t.Fatalf("長路徑沒加前綴：%s", got)
	}
	unc := `\\server\share\` + strings.Repeat(`x\`, 200) + `.wiki`
	if got := longPath(unc); got != unc {
		t.Fatalf("UNC 不該動：%s", got)
	}
}
