package collector

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTemplateFilesAreNotKnowledge 釘住 leo 2026-08-06 的兩條裁決：
//
//	①「拿來開發一般人用不到的**根本別安裝**」
//	②「它也不能只看隱藏檔內，因為 **template 在我所有的 repo 裡不是隱藏的**」
//
// 事故：daemon 把 system-dev template（CLAUDE.md／scripts/／system-dev/，37 檔）
// 代裝進使用者的文件資料夾，然後又把它們當知識吃進去
// ⇒ 知識庫長出 `kb`／`t195-watch` 這種不是使用者內容的庫（leo 實撞）。
//
// 這支測試刻意把 template 檔**放成不隱藏**（就像 leo 的 repo），驗它仍被排除。
func TestTemplateFilesAreNotKnowledge(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// template 的東西（**沒有隱藏**）
	write("CLAUDE.md", "開發用設定")
	write("scripts/sdd-active-check.sh", "#!/bin/sh")
	write("system-dev/wiki/status.md", "開發用 wiki")
	// 使用者真正的內容
	write("我的筆記.md", "這是我要搜尋的東西")

	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	res, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatalf("掃描失敗：%v", err)
	}

	got := map[string]bool{}
	for _, e := range res.Events {
		got[e.Path] = true
	}
	if !got["我的筆記.md"] {
		t.Error("使用者自己的檔案不見了——排除規則太寬")
	}
	for _, dev := range []string{"CLAUDE.md", "scripts/sdd-active-check.sh", "system-dev/wiki/status.md"} {
		if got[dev] {
			t.Errorf("%s 是 template 的開發用檔，不該被當成使用者知識", dev)
		}
	}
	// 也不該計進「有 N 個檔案沒有被整理」——那欄是給使用者看他自己的檔案的
	if res.SkippedOther > 0 {
		t.Errorf("template 檔不該計進『沒被整理』（會佔用使用者的注意力），實得 %d：%v",
			res.SkippedOther, res.SkippedOtherNames)
	}
}
