// tidy_test.go — arcrun-rag#60 驗收條件③：已經寫進去的舊產物要有辦法一次認出來／改名。
package collector

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestMarkName_Idempotent(t *testing.T) {
	if got := MarkName("status.md"); got != "arcrun-status.md" {
		t.Fatalf("MarkName=%q", got)
	}
	// 冪等：daemon 每輪自動跑、tidy 也可能重跑，不准疊成 arcrun-arcrun-。
	twice := MarkName(MarkName("status.md"))
	if twice != "arcrun-status.md" {
		t.Fatalf("重複加標記疊起來了：%q", twice)
	}
	if !IsMarked("arcrun-x.md") || IsMarked("x.md") {
		t.Fatal("IsMarked 判斷錯")
	}
	if got := UnmarkName("arcrun-x.md"); got != "x.md" {
		t.Fatalf("UnmarkName=%q", got)
	}
}

// 舊產物：卡片與備份檔都要被認出來並改名；使用者自己的檔一個都不准動。
func TestTidy_RenamesLegacyCardsOnly(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))

	// 使用者自己的東西（絕對不准動）
	mine := map[string]string{
		"journals/2026_08_10.md": "我的日記",
		"pages/讀書筆記.md":          "我的筆記",
	}
	for rel, body := range mine {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 舊版 daemon 落下的產物（兩個卡片目錄各放一份，加一個備份檔）
	legacy := []string{
		".arcrun-rag/wiki/cards/2026_08_10.md",
		".arcrun-rag/wiki/cards/2026_08_10.md.bak-1723459200000000000",
		"system-dev/wiki/cards/會議記錄.md",
	}
	for _, rel := range legacy {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte("機器寫的"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// ① dry-run：什麼都不該動
	rep, err := Tidy(root, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range legacy {
		if _, serr := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); serr != nil {
			t.Fatalf("dry-run 竟然動了檔案：%s 不見了", rel)
		}
	}
	// 🔴 第三輪（2026-08-12）改了這裡的期望，這是**刻意的行為變更**：
	//
	//	本 fixture 的 root 是 vault，卻有一張卡躺在 `system-dev/wiki/cards/`——那是
	//	**看得見的**目錄，Logseq/Obsidian 會把它當成一頁。第二輪只把它就地改名
	//	（加上 arcrun- 前綴）就算收拾完，於是「不撞名」達成了、「不要在使用者的
	//	筆記庫裡多出機器頁面」沒達成。改名救不了位置。
	//	⇒ 現在位置不對的卡一律**搬**進隱藏的 vaultCardsRelDir，動作是 would-move。
	//	   已經在隱藏目錄、只是少個前綴的，仍然是就地 would-rename（行為不變）。
	var previewed []string
	for _, it := range rep.Items {
		previewed = append(previewed, it.Rel+" → "+it.To+"（"+it.Action+"）")
		if it.Action != TidyActionWillRename && it.Action != TidyActionWillMove {
			t.Fatalf("dry-run 出現非預期動作：%+v", it)
		}
		if strings.HasPrefix(it.To, cardsRelDir+"/") {
			t.Fatalf("vault 裡的卡片被留在看得見的目錄：%+v", it)
		}
	}
	sort.Strings(previewed)
	t.Logf("dry-run 預覽：\n  %s", strings.Join(previewed, "\n  "))
	if len(rep.Items) != len(legacy) {
		t.Fatalf("認出來的舊產物數量不對：got %d want %d（%+v）", len(rep.Items), len(legacy), rep.Items)
	}

	// ② --apply：真的改名
	if _, err := Tidy(root, true); err != nil {
		t.Fatal(err)
	}
	want := []string{
		".arcrun-rag/wiki/cards/arcrun-2026_08_10.md",
		".arcrun-rag/wiki/cards/arcrun-2026_08_10.md.bak-1723459200000000000",
		// 第三輪：這一張本來在 system-dev/wiki/cards/（看得見），現在搬進隱藏目錄。
		".arcrun-rag/wiki/cards/arcrun-會議記錄.md",
	}
	for _, rel := range want {
		if _, serr := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); serr != nil {
			t.Fatalf("改名後的檔案不存在：%s", rel)
		}
	}
	for _, rel := range legacy {
		if _, serr := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); serr == nil {
			t.Fatalf("舊名字還在——應該是改名不是複製：%s", rel)
		}
	}
	// 使用者的檔案原封不動
	for rel, body := range mine {
		data, rerr := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if rerr != nil {
			t.Fatalf("使用者的檔案不見了：%s（%v）", rel, rerr)
		}
		if string(data) != body {
			t.Fatalf("使用者的檔案被改了：%s → %q", rel, data)
		}
	}

	// ③ 冪等：再跑一次沒有東西可做
	rep3, err := Tidy(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep3.Items) != 0 {
		t.Fatalf("第二次跑不該再有動作：%+v", rep3.Items)
	}
}

// vault 裡的 template 殘留（status.md／mistakes.md 那批）＝搬走，不刪。
func TestTidy_VaultTemplateLeftoversAreMovedNotDeleted(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	leftovers := map[string]string{
		"system-dev/wiki/status.md":   "template 的 status",
		"system-dev/wiki/mistakes.md": "template 的 mistakes",
		"scripts/sdd-active-check.sh": "#!/bin/sh",
	}
	for rel, body := range leftovers {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	rep, err := Tidy(root, true)
	if err != nil {
		t.Fatal(err)
	}
	moved := 0
	for _, it := range rep.Items {
		if it.Kind == TidyKindTemplate {
			if it.Action != TidyActionMoved {
				t.Fatalf("vault 裡的 template 殘留應該被搬走：%+v", it)
			}
			moved++
		}
	}
	if moved != len(leftovers) {
		t.Fatalf("搬走的數量不對：got %d want %d", moved, len(leftovers))
	}
	for rel, body := range leftovers {
		// 原位不該還在
		if _, serr := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); serr == nil {
			t.Fatalf("原位的殘留還在：%s", rel)
		}
		// 但**內容必須還找得到**——本指令從不刪東西
		p := filepath.Join(root, filepath.FromSlash(legacyTemplateRelDir), filepath.FromSlash(rel))
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			t.Fatalf("搬過去的檔案讀不到（東西被弄丟了？）：%s（%v）", p, rerr)
		}
		if string(data) != body {
			t.Fatalf("搬移過程中內容變了：%s", rel)
		}
	}
}

// 非 vault（很可能是使用者自己的開發 repo）＝template 只列出來，一個都不准動。
func TestTidy_PlainFolderTemplateOnlyReported(t *testing.T) {
	root := t.TempDir()
	rel := "system-dev/wiki/status.md"
	p := filepath.Join(root, filepath.FromSlash(rel))
	mustMkdir(t, filepath.Dir(p))
	if err := os.WriteFile(p, []byte("這是我 repo 裡真正的 status"), 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Tidy(root, true) // 即使 --apply 也不准動
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) != 1 || rep.Items[0].Action != TidyActionReport {
		t.Fatalf("非 vault 的 template 應該只列出不動手：%+v", rep.Items)
	}
	data, rerr := os.ReadFile(p)
	if rerr != nil || string(data) != "這是我 repo 裡真正的 status" {
		t.Fatalf("非 vault 的 template 被動了：%v / %q", rerr, data)
	}
}

// 目的地已經有同名檔＝跳過並回報，絕不覆蓋（safewrite.go 同一條紅線）。
func TestTidy_DoesNotClobberExistingTarget(t *testing.T) {
	root := t.TempDir()
	cardDir := filepath.Join(root, filepath.FromSlash(cardsRelDir))
	mustMkdir(t, cardDir)
	if err := os.WriteFile(filepath.Join(cardDir, "x.md"), []byte("舊的"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cardDir, "arcrun-x.md"), []byte("新的"), 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Tidy(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) != 1 || rep.Items[0].Action != TidyActionSkipped {
		t.Fatalf("目的地已存在時應跳過：%+v", rep.Items)
	}
	if data, _ := os.ReadFile(filepath.Join(cardDir, "arcrun-x.md")); string(data) != "新的" {
		t.Fatalf("既有目標被覆蓋了：%q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(cardDir, "x.md")); string(data) != "舊的" {
		t.Fatalf("來源被動了：%q", data)
	}
}

// MigrateCardNames（daemon 每輪自動跑的那個）只碰卡片產物區。
func TestMigrateCardNames_TouchesOnlyCardDirs(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	// 卡片區的舊卡（該改名）
	cardDir := filepath.Join(root, filepath.FromSlash(vaultCardsRelDir))
	mustMkdir(t, cardDir)
	if err := os.WriteFile(filepath.Join(cardDir, "舊卡.md"), []byte("c"), 0o644); err != nil {
		t.Fatal(err)
	}
	// template 殘留（自動路不准碰——那要人確認是不是他自己的 repo）
	tplDir := filepath.Join(root, "system-dev", "wiki")
	mustMkdir(t, tplDir)
	if err := os.WriteFile(filepath.Join(tplDir, "status.md"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}

	if n := MigrateCardNames(root); n != 1 {
		t.Fatalf("改名筆數=%d，want 1", n)
	}
	if _, err := os.Stat(filepath.Join(cardDir, "arcrun-舊卡.md")); err != nil {
		t.Fatalf("舊卡沒被改名：%v", err)
	}
	if _, err := os.Stat(filepath.Join(tplDir, "status.md")); err != nil {
		t.Fatalf("自動路不該碰 template 殘留，但它不見了：%v", err)
	}
}
