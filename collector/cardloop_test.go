// cardloop_test.go — 「卡片自我繁殖」迴歸網（inkstone/Arcrun#134 → comment 5025）。
//
// 🔴 2026-08-28 在 leo 的 `~/Desktop/youlinhsieh-test1` 實測到的現象：
// 一份 20 KB 的劇本原稿，`.wiki/` 只落了 4 張卡；而 `system-dev/wiki/cards/` 底下
// 卻在 20 分鐘內從 9 個檔長到 55 個，出現 `arcrun-換柱（arcrun-換柱）.md`
// 這種第三代檔名。那不是萃取品質問題，是**產物被自己的整理程序拖回原稿區**：
//
//	① 萃取寫 `<node>/.wiki/換柱.md`（隱藏目錄，Scan 整棵跳過 ⇒ 不會被當原稿）
//	② MigrateCardNames 每輪自動跑，遞迴掃 `system-dev/wiki/cards/`——
//	   **它沒有跳過隱藏目錄**，於是把 `cards/.wiki/換柱.md`
//	   「歸位」成 `cards/arcrun-換柱.md`
//	③ 那個位置 Scan 看得見 ⇒ 下一輪當成新原稿再萃一次 ⇒ 回到 ①
//
// 每一圈都燒一次 Workers AI 額度、往雲端推一批「卡片的卡片」，而且不會停。
//
// 四支測試各釘住迴圈的一個環節（tidy 自動路／tidy 手動路／收檔判準／claude 路），
// 缺一個就會復發。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMigrateCardNamesLeavesWikiDirAlone：`.wiki/` 是卡片的家，不是「位置不對的舊卡」。
// MigrateCardNames 一個檔都不准動它——動了就等於把產物送回原稿區（迴圈的第②環）。
func TestMigrateCardNamesLeavesWikiDirAlone(t *testing.T) {
	root := t.TempDir()

	// 卡片產物區底下的 `.wiki/`：萃取正常的落點。
	wikiDir := filepath.Join(root, filepath.FromSlash(cardsRelDir), wikiRelDir)
	if err := os.MkdirAll(wikiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	card := filepath.Join(wikiDir, "換柱.md")
	if err := os.WriteFile(card, []byte("# 換柱\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	mig := MigrateCardNames(root)

	if _, err := os.Stat(card); err != nil {
		t.Fatalf("`.wiki/` 裡的卡被搬走了（MigrateCardNames 回報 Moved=%d）——"+
			"它下一輪就會被當成新原稿再萃一次，迴圈就是這樣長出來的", mig.Moved)
	}
	dragged := filepath.Join(root, filepath.FromSlash(cardsRelDir), MarkName("換柱.md"))
	if _, err := os.Stat(dragged); err == nil {
		t.Fatalf("卡片被拖回原稿區：%s", dragged)
	}
	if mig.Moved != 0 {
		t.Fatalf("Moved = %d，期望 0（`.wiki/` 不該有任何東西被搬）", mig.Moved)
	}
}

// TestTidyLeavesWikiDirAlone：手動 `collector tidy --apply` 走的是另一條路，同樣不准碰。
func TestTidyLeavesWikiDirAlone(t *testing.T) {
	root := t.TempDir()
	wikiDir := filepath.Join(root, filepath.FromSlash(cardsRelDir), wikiRelDir)
	if err := os.MkdirAll(wikiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	card := filepath.Join(wikiDir, "官架子.md")
	if err := os.WriteFile(card, []byte("# 官架子\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Tidy(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(card); err != nil {
		t.Fatalf("tidy --apply 搬走了 `.wiki/` 裡的卡；報告列了 %d 項", len(rep.Items))
	}
	for _, it := range rep.Items {
		if it.Kind == TidyKindCard && filepath.Base(filepath.Dir(it.Rel)) == wikiRelDir {
			t.Fatalf("tidy 把 `.wiki/` 裡的卡列成待整理項：%s → %s", it.Rel, it.To)
		}
	}
}

// TestMachineOwnedCardsAreNotIngestedAsSource：curated-wiki 模式收的是「他自己寫的 wiki」，
// 但 `system-dev/wiki/cards/arcrun-*.md` 是 **daemon 上一版親手產的卡**
// （檔名帶 MachineMark 就是它的身分證）。把自己的產物當原稿再萃一次
// ＝迴圈的第③環，也是這次「卡片的卡片」的第一代來源。
func TestMachineOwnedCardsAreNotIngestedAsSource(t *testing.T) {
	plan := IngestPlan{Mode: IngestCuratedWiki, WikiRelDir: "system-dev/wiki"}

	userCard := "system-dev/wiki/cards/我自己寫的.md"
	if !plan.KeepsFile(userCard) {
		t.Fatalf("使用者自己寫的卡被排除了：%s（curated-wiki 要收的就是這個）", userCard)
	}

	machineCard := "system-dev/wiki/cards/" + MarkName("換柱.md")
	if plan.KeepsFile(machineCard) {
		t.Fatalf("daemon 自己產的卡被當成原稿收進去：%s——"+
			"它會被再萃一次，產出「卡片的卡片」", machineCard)
	}
}

// TestSnapshotCardsIgnoresWikiDir：claude 路的同一個洞。
// snapshotCards → diffCards → enforceCardMarks 會把「這一輪新出現的卡」歸位到
// cardRelFor（搬出 `.wiki/`、加前綴）。`.wiki/` 不進快照，就沒有東西可以被搬。
func TestSnapshotCardsIgnoresWikiDir(t *testing.T) {
	root := t.TempDir()
	wikiDir := filepath.Join(root, filepath.FromSlash(cardsRelDir), wikiRelDir)
	if err := os.MkdirAll(wikiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	before := snapshotCards(root)
	if err := os.WriteFile(filepath.Join(wikiDir, "Pixel手機.md"), []byte("# Pixel手機\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed := diffCards(before, snapshotCards(root))
	if len(changed) != 0 {
		t.Fatalf("`.wiki/` 裡的新卡進了快照差集：%v——enforceCardMarks 會把它搬出隱藏目錄", changed)
	}
}
