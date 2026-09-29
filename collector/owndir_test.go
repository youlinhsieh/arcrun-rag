// owndir_test.go — 「對作業系統宣告這是我們的資料夾」的接線測試（inkstone/arcrun-rag#193）。
//
// 這支在每個平台都跑。它驗的不是隱藏屬性本身（那只有 Windows 驗得到，見 owndir_windows_test.go），
// 而是**接線**：daemon 建 `.wiki/`、`.arcrun-rag/` 的每一條路都有經過宣告點，
// 而且宣告點**只**被拿來指我們自己的目錄——票的紅線是「使用者的檔案與資料夾一個屬性都不准碰」，
// 這條紅線在 Linux／mac 上就要守住，不能等 Windows 機器。
package collector

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// recordHiddenDirs 把平台掛鉤換成錄音機，回傳「被宣告過的目錄」清單（去重排序）。
func recordHiddenDirs(t *testing.T) func() []string {
	t.Helper()
	orig := hideOwnDir
	seen := map[string]bool{}
	hideOwnDir = func(dir string) error { seen[dir] = true; return nil }
	t.Cleanup(func() { hideOwnDir = orig })
	return func() []string {
		out := make([]string, 0, len(seen))
		for d := range seen {
			out = append(out, d)
		}
		sort.Strings(out)
		return out
	}
}

func TestOwnDir_EveryWikiLayerAndWorkspaceGetsDeclared(t *testing.T) {
	root := t.TempDir()
	got := recordHiddenDirs(t)

	rel := filepath.Join("專案", "會議")
	mustMkdir(t, filepath.Join(root, rel))
	src := "# 週會決議\n內容"
	mustWrite(t, filepath.Join(root, rel, "週會.md"), src)
	if _, err := BuildWikiDoc(root, "專案/會議/週會.md", src, wsExtract(), wsOrigin("專案/會議/週會.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	EnsureWorkspaceIgnored(root)

	want := []string{
		filepath.Join(root, ".arcrun-rag"),
		filepath.Join(root, ".wiki"),
		filepath.Join(root, "專案", ".wiki"),
		filepath.Join(root, "專案", "會議", ".wiki"),
	}
	sort.Strings(want)
	dirs := got()
	if len(dirs) != len(want) {
		t.Fatalf("宣告過的目錄不對：\n得到 %v\n想要 %v", dirs, want)
	}
	for i := range want {
		if dirs[i] != want[i] {
			t.Fatalf("宣告過的目錄不對：\n得到 %v\n想要 %v", dirs, want)
		}
	}
	// 每一個被宣告的都真的存在、而且是目錄（不替別人建目錄、不對檔案掛屬性）。
	for _, d := range dirs {
		st, err := os.Lstat(d)
		if err != nil || !st.IsDir() {
			t.Fatalf("宣告了一個不存在或不是目錄的路徑：%s（%v）", d, err)
		}
	}
}

// 紅線：宣告點只准指 `.wiki` 與 `.arcrun-rag` 本身——不是使用者的資料夾、不是它們底下的子目錄。
func TestOwnDir_NeverTouchesUserFoldersOrNestedPaths(t *testing.T) {
	root := t.TempDir()
	got := recordHiddenDirs(t)

	mustMkdir(t, filepath.Join(root, "使用者資料夾", "子層"))
	src := "# 筆記\n內容"
	mustWrite(t, filepath.Join(root, "使用者資料夾", "子層", "筆記.md"), src)
	if _, err := BuildWikiDoc(root, "使用者資料夾/子層/筆記.md", src, wsExtract(), wsOrigin("使用者資料夾/子層/筆記.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	if err := MarkDocNoConcept(root, "使用者資料夾/子層/筆記.md", "純紀錄", wsNow); err != nil {
		t.Fatal(err)
	}
	if err := RemoveWikiDoc(root, "使用者資料夾/子層/筆記.md"); err != nil {
		t.Fatal(err)
	}
	EnsureWorkspaceIgnored(root)
	EnsureWorkspaceIgnored(root) // 第二次（.gitignore 已在）也只准指同一個目錄

	for _, d := range got() {
		base := filepath.Base(d)
		if base != wikiRelDir && base != workspaceRelDir {
			t.Fatalf("宣告點指到了不是我們的目錄：%s", d)
		}
	}
	if len(got()) == 0 {
		t.Fatal("一個目錄都沒宣告——接線斷了")
	}
}

// 不存在的目錄不宣告（markOwnDirHidden 不替別人建目錄）。
func TestOwnDir_MissingDirIsNotDeclared(t *testing.T) {
	got := recordHiddenDirs(t)
	markOwnDirHidden(filepath.Join(t.TempDir(), "不存在", ".wiki"))
	if n := len(got()); n != 0 {
		t.Fatalf("對不存在的目錄也宣告了：%v", got())
	}
}

// 升級補掛：照 wiki 帳本點名，帳本上有的節點才點、目錄真的在才算，根層一定包含。
func TestKnownWikiDirs_FollowsManifestAndSkipsMissing(t *testing.T) {
	root := t.TempDir()
	makeRootManifest(t, root, map[string][]string{
		"":              {".wiki/根卡.md"},
		"docs":          {"docs/.wiki/文件卡.md", "docs/.wiki/文件卡二.md"},
		"legacy/backup": {"legacy/backup/.wiki/舊卡.md"},
		"已經被刪掉的節點":      {"已經被刪掉的節點/.wiki/x.md"},
	})
	makeWiki(t, filepath.Join(root, ".wiki"), "根卡.md")
	makeWiki(t, filepath.Join(root, "docs", ".wiki"), "文件卡.md")
	makeWiki(t, filepath.Join(root, "legacy", "backup", ".wiki"), "舊卡.md")
	mustMkdir(t, filepath.Join(root, "使用者自己的資料夾")) // 不在帳本上、也不是 .wiki → 不點

	want := []string{
		filepath.Join(root, ".wiki"),
		filepath.Join(root, "docs", ".wiki"),
		filepath.Join(root, "legacy", "backup", ".wiki"),
	}
	sort.Strings(want)
	got := knownWikiDirs(root)
	if len(got) != len(want) {
		t.Fatalf("點名不對：\n得到 %v\n想要 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("點名不對：\n得到 %v\n想要 %v", got, want)
		}
	}
}
