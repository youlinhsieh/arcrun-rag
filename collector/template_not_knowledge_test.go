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
	// template 的東西（**沒有隱藏**）。
	// 🔴 2026-08-28（inkstone/Arcrun#180）：內容改成從內嵌快照原樣鋪出來，
	//    不再自己捏一段假字串——判準已經從「路徑前綴」換成「內容與原版逐字相同」
	//    （templateuntouched.go），假內容就不是範本空殼，那是使用者寫的東西。
	//    這也讓這支測試更貼近它要守的事故：**daemon 自己鋪下去的那份**不該被自己吃掉。
	fromSnapshot := func(rel string) string {
		data, err := templateFS.ReadFile(templateFSRoot + "/" + rel)
		if err != nil {
			t.Fatalf("內嵌範本快照裡沒有 %s：%v", rel, err)
		}
		return string(data)
	}
	write("CLAUDE.md", fromSnapshot("CLAUDE.md"))
	write("scripts/sdd-active-check.sh", fromSnapshot("scripts/sdd-active-check.sh"))
	write("system-dev/wiki/status.md", fromSnapshot("system-dev/wiki/status.md"))
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

// TestTemplateShellVsRealContent 釘住 inkstone/Arcrun#180（leo 2026-08-28）新增的那半題：
//
//	「**cards 在 system-dev 下，wiki 就在裡面，所以不允許跳過它**」
//
// 同一棵 `system-dev/` 底下並存兩種東西（`youlinhsieh-test1` 實況）：
//
//	system-dev/wiki/status.md    ← 安裝器鋪的空殼，逐字等於快照 ⇒ 不是知識
//	system-dev/wiki/cards/*.md   ← 使用者資料夾裡真的卡        ⇒ 是知識
//
// 舊的路徑前綴判準把兩者一起丟掉。這支釘的就是「分辨得出來」，
// 而且釘的是**兩個方向**——放行與誤殺都會紅。
func TestTemplateShellVsRealContent(t *testing.T) {
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
	shell, err := templateFS.ReadFile(templateFSRoot + "/system-dev/wiki/status.md")
	if err != nil {
		t.Fatal(err)
	}
	// ① 原封不動的空殼
	write("system-dev/wiki/status.md", string(shell))
	// ② 同一個路徑的另一個檔，但使用者寫過（只差一行）
	write("system-dev/wiki/mistakes.md", string(shell)+"\n2026-08-28：我自己寫的一條。\n")
	// ③ 快照裡根本沒有的真內容——那 9 張卡就是這一種
	write("system-dev/wiki/cards/arcrun-火星座標_短片劇本_v1.md", "# 火星座標\n這是一張真的卡。\n")

	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	res, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, e := range res.Events {
		got[e.Path] = true
	}
	if got["system-dev/wiki/status.md"] {
		t.Error("原封不動的範本空殼被當成知識收了——紅線①「不准變成放行」")
	}
	if !got["system-dev/wiki/mistakes.md"] {
		t.Error("使用者只要寫過一個字就是他的知識，卻被當成範本丟掉")
	}
	if !got["system-dev/wiki/cards/arcrun-火星座標_短片劇本_v1.md"] {
		t.Error("system-dev 底下真的卡沒被收——leo：「cards 在 system-dev 下…所以不允許跳過它」")
	}
}

// 判準不看名字：同一份範本鋪在叫別的名字的資料夾裡，一樣認得出來；
// 而一個剛好也叫 system-dev、裡面是使用者東西的資料夾，不該再被誤殺。
func TestTemplateShell_判準不看資料夾名字(t *testing.T) {
	shell, err := templateFS.ReadFile(templateFSRoot + "/system-dev/wiki/status.md")
	if err != nil {
		t.Fatal(err)
	}
	if TemplateUntouched("我的專案筆記/wiki/status.md", "/nonexistent") {
		t.Error("快照裡沒有這個相對路徑，不該回 true")
	}
	root := t.TempDir()
	p := filepath.Join(root, "system-dev", "wiki", "status.md")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("這個資料夾剛好也叫 system-dev，但裡面是我的東西"), 0o644); err != nil {
		t.Fatal(err)
	}
	if TemplateUntouched("system-dev/wiki/status.md", p) {
		t.Error("名字一樣但內容不一樣，判準不該只看名字")
	}
	if err := os.WriteFile(p, shell, 0o644); err != nil {
		t.Fatal(err)
	}
	if !TemplateUntouched("system-dev/wiki/status.md", p) {
		t.Error("內容逐字等於快照，應該認得出是空殼")
	}
}
