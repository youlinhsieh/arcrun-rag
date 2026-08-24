// remove_folder_cleanup_test.go — arcrun-rag#138：移除資料夾時可以連同硬碟上的
// 隱藏資料夾一起收掉，而且**只收我們自己建的**。
//
// 本檔釘 App 這一半的四件事（認人的判準本身由 collector/cleanup_test.go 釘）：
//  1. 沒勾清理 ⇒ 硬碟上一個檔都不准少（預設不刪，跟 #46 同一條紅線）
//  2. 勾了清理 ⇒ 我們的隱藏資料夾（含巢狀層）沒了，使用者的檔案一個不少
//  3. 另一個還在看守（或還在收回中）的資料夾底下 ⇒ 不碰
//  4. PlanFolderCleanup 只讀不寫，且拿得到「將要刪掉哪些」的清單
package main

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	collector "arcrun-rag/collector"
)

func mkfile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// makeFakeWatched 造一個「daemon 跑過」的資料夾：使用者的原稿＋我們的隱藏產物（兩層）。
func makeFakeWatched(t *testing.T, root string) {
	t.Helper()
	mkfile(t, filepath.Join(root, "我的原稿.md"), "使用者的知識\n")
	mkfile(t, filepath.Join(root, "docs", "設計.md"), "使用者的設計\n")
	// 工作區與各層卡片目錄的內容逐字取自 collector 真正寫下去的那兩份宣告
	mkfile(t, filepath.Join(root, ".arcrun-rag", ".gitignore"), collector.WorkspaceIgnoreBodyForTest())
	for _, node := range []string{"", "docs"} {
		dir := filepath.Join(root, node, ".wiki")
		mkfile(t, filepath.Join(dir, ".gitignore"), collector.WikiIgnoreBodyForTest())
		mkfile(t, filepath.Join(dir, "00-INDEX.md"), "# 00-INDEX\n\n## 文件\n")
		mkfile(t, filepath.Join(dir, "arcrun-一張卡.md"), "# 卡\n")
	}
}

func listFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(out)
	return out
}

// ① 沒勾清理＝行為與從前一字不差：硬碟上一個檔都不准少。
func TestRemoveFolderWithoutCleanupTouchesNothing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	root := filepath.Join(t.TempDir(), "kb")
	makeFakeWatched(t, root)
	newTestCfgWithFolder(t, root)

	before := listFiles(t, root)
	if err := (&App{}).RemoveFolder(0, root, false, false); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	after := listFiles(t, root)
	if len(before) != len(after) {
		t.Fatalf("沒勾清理就不准動硬碟：before=%v after=%v", before, after)
	}
}

// ② 勾了清理：我們的東西沒了，使用者的東西一個不少。
func TestRemoveFolderWithCleanupRemovesOnlyOurs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	root := filepath.Join(t.TempDir(), "kb")
	makeFakeWatched(t, root)
	newTestCfgWithFolder(t, root)

	if err := (&App{}).RemoveFolder(0, root, false, true); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	got := listFiles(t, root)
	want := []string{"docs/設計.md", "我的原稿.md"}
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("清完之後應該只剩使用者的檔\n got=%v\nwant=%v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("清完之後應該只剩使用者的檔\n got=%v\nwant=%v", got, want)
		}
	}
}

// ③ 巢狀在裡面、但**還在收回中**的資料夾 ⇒ 不碰它底下的東西。
func TestRemoveFolderCleanupSkipsRetiringNestedRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	root := filepath.Join(t.TempDir(), "kb")
	inner := filepath.Join(root, "legacy")
	makeFakeWatched(t, root)
	makeFakeWatched(t, inner)

	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL: "https://example.workers.dev", Namespace: "abc", APIKey: "abc",
			WatchFolders:    []string{root},
			RetiringFolders: []string{inner}, // 還在把雲端的資料收回來，別動它的檔
		}},
		Extractor: "workers-ai",
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatal(err)
	}

	if err := (&App{}).RemoveFolder(0, root, false, true); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	for _, p := range []string{
		filepath.Join(inner, ".arcrun-rag", ".gitignore"),
		filepath.Join(inner, ".wiki", "arcrun-一張卡.md"),
		filepath.Join(inner, "docs", ".wiki", "arcrun-一張卡.md"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("還在收回中的資料夾底下的東西被刪了：%s（%v）", p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".wiki")); !os.IsNotExist(err) {
		t.Fatalf("外層自己的 .wiki 該被清掉")
	}
}

// ④ 先看清單：拿得到內容，而且看完之後硬碟一個檔都沒變。
func TestPlanFolderCleanupIsReadOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	root := filepath.Join(t.TempDir(), "kb")
	makeFakeWatched(t, root)
	newTestCfgWithFolder(t, root)

	before := listFiles(t, root)
	plan, err := (&App{}).PlanFolderCleanup(0, root)
	if err != nil {
		t.Fatalf("拿不到清單：%v", err)
	}
	if len(plan.Remove) == 0 {
		t.Fatal("這份擺法應該列得出東西")
	}
	for _, it := range plan.Remove {
		if it.Evidence == "" {
			t.Fatalf("清單上每一筆都要說得出依據：%+v", it)
		}
	}
	if after := listFiles(t, root); len(after) != len(before) {
		t.Fatalf("看清單這個動作動了硬碟：before=%v after=%v", before, after)
	}
}
