// tidy_wiki_untouched_test.go — 舊制的「卡片歸位」不准動新制 `.wiki/` 裡的卡
// （inkstone/Arcrun#180，2026-08-28 實撞）。
//
// 為什麼需要這一張網：`MigrateCardNames` 是 **daemon 每輪自動跑**的（direct.go
// runDirectOnceRoot 開頭），而它掃的目錄與新制卡的家在某些資料夾上**完全重疊**——
// 使用者把整理好的卡放在 `system-dev/wiki/cards/`，那些卡自己就是原稿，
// 萃出來的新卡於是落在 `system-dev/wiki/cards/.wiki/`。
//
// 兩條規則撞上的當下沒有人會看到錯誤訊息：舊制默默把卡搬走並改名，
// 萃取端下一步才報「讀卡片失敗」，而那句話指向的是**它自己一秒前寫出來的檔**。
// ⇒ 這種 bug 只有機械網抓得到，靠讀程式碼讀不出來（本票就是這樣被繞了三輪）。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

func mustWriteFile(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateCardNames_不准把新制wiki裡的卡拖出來(t *testing.T) {
	root := t.TempDir()
	// leo 的 youlinhsieh-test1 的形狀：整理好的卡住在 system-dev/wiki/cards/，
	// 它們自己被當原稿萃過一輪，新卡落在同一層的 .wiki/。
	mustWriteFile(t, root, "system-dev/wiki/cards/arcrun-火星座標_短片劇本_v1.md", "# 火星座標\n")
	mustWriteFile(t, root, "system-dev/wiki/cards/.wiki/火星座標_短片劇本_v1.md", "# 火星座標\n")
	mustWriteFile(t, root, "system-dev/wiki/cards/.wiki/官架子.md", "# 官架子\n")
	mustWriteFile(t, root, "system-dev/wiki/cards/.wiki/00-INDEX.md", "# 00-INDEX\n")
	mustWriteFile(t, root, "system-dev/wiki/cards/.wiki/.gitignore", "*\n")

	MigrateCardNames(root)

	for _, rel := range []string{
		"system-dev/wiki/cards/.wiki/火星座標_短片劇本_v1.md",
		"system-dev/wiki/cards/.wiki/官架子.md",
		"system-dev/wiki/cards/.wiki/00-INDEX.md",
		"system-dev/wiki/cards/.wiki/.gitignore",
	} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Errorf("%s 不見了——舊制的歸位又走進 .wiki/ 了：%v", rel, err)
		}
	}
	// 反面：不准在上一層生出帶前綴的複本（那正是「卡萃卡」增生的起點）。
	for _, rel := range []string{
		"system-dev/wiki/cards/arcrun-官架子.md",
		"system-dev/wiki/cards/arcrun-00-INDEX.md",
		"system-dev/wiki/cards/arcrun-.gitignore",
	} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
			t.Errorf("多出了 %s——`.wiki/` 裡的東西被拖出來改名了", rel)
		}
	}
}

// 上一輪（#60 第三輪）的修復不准被這次的「跳過點開頭目錄」關掉：
// `.arcrun-rag/wiki/cards/` 這個**收容處自己**是隱藏路徑，它仍然要被掃到。
func TestMigrateCardNames_收容處自己仍然掃得到(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, root, ".arcrun-rag/wiki/cards/沒帶標記的舊卡.md", "# 舊卡\n")

	mig := MigrateCardNames(root)

	if mig.Moved != 1 {
		t.Fatalf("收容處裡沒帶標記的舊卡應該仍然被認出來（#60 第三輪的行為），實際 moved=%d", mig.Moved)
	}
	if _, err := os.Stat(filepath.Join(root, ".arcrun-rag/wiki/cards/沒帶標記的舊卡.md")); err == nil {
		t.Fatal("它應該已經歸位了，原位置不該還在")
	}
}
