package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testOrigin＝測試用的三件式（機器／庫／庫內路徑）。
// 內容不重要，重要的是**每個呼叫端都必須交出它**——`inkstone/Arcrun#167` 的教訓是
// 「出處寫的是什麼」不能靠預設值，得由知道自己在哪一台、哪個庫的那一端說出來。
func testOrigin() SourceOrigin {
	return SourceOrigin{MachineLabel: "test@Machine", Library: "test-lib", LibraryPath: "測試文件.md"}
}

// wsOrigin＝wikishape 測試用：庫名／機器固定，庫內路徑跟著受測的 relPath 走
//（子資料夾的檔要驗「資料夾沒被弄丟」，所以這一格不能寫死）。
func wsOrigin(relPath string) SourceOrigin {
	return SourceOrigin{MachineLabel: "test@Machine", Library: "test-lib", LibraryPath: relPath}
}

// TestSourceOriginNeverEmitsInternalPath 是 `inkstone/Arcrun#167` 的迴歸閘。
//
// leo 2026-08-27 用 n8n 實測：問「原文 wiki 的位置在哪裏？」，AI 照著卡片內文答
// `../小果被AFTEE詐貸.pdf`——**使用者拿著它走不到任何地方**。
// 這裡把那個形狀鎖死：不管三件式缺哪一格，輸出都不准出現 `../`。
func TestSourceOriginNeverEmitsInternalPath(t *testing.T) {
	cases := []struct {
		name   string
		origin SourceOrigin
		want   []string
	}{
		{
			"三件齊全",
			SourceOrigin{MachineLabel: "youlinhsieh@Leo-MBA", Library: "youlinhsieh-test1", LibraryPath: "小果被AFTEE詐貸.pdf"},
			[]string{"youlinhsieh@Leo-MBA › youlinhsieh-test1 › 小果被AFTEE詐貸.pdf", "`youlinhsieh-test1/小果被AFTEE詐貸.pdf`"},
		},
		{
			// 🔴 票上的驗收條件三：子資料夾裡的檔要定位得到。
			// 舊寫法 `../<檔名>` 會把整段資料夾弄丟（實據：inkstoneco 庫的
			// system-dev/wiki/trees/2026-08-17-today.md 出處只剩 `../2026-08-17-today.md`）。
			"子資料夾不准被弄丟",
			SourceOrigin{MachineLabel: "youlinhsieh@Leo-MBA", Library: "inkstoneco", LibraryPath: "system-dev/wiki/trees/2026-08-17-today.md"},
			[]string{"inkstoneco › system-dev/wiki/trees/2026-08-17-today.md", "`inkstoneco/system-dev/wiki/trees/2026-08-17-today.md`"},
		},
		{
			"機器未知也要誠實，不得退回相對路徑",
			SourceOrigin{Library: "kb", LibraryPath: "a/b.md"},
			[]string{"機器（未知） › kb › a/b.md"},
		},
		{
			"庫未知",
			SourceOrigin{MachineLabel: "m", LibraryPath: "a/b.md"},
			[]string{"m › 知識庫（未知） › a/b.md", "`a/b.md`"},
		},
		{
			"路徑未知",
			SourceOrigin{MachineLabel: "m", Library: "kb"},
			[]string{"m › kb › 庫內路徑（未知）"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var b strings.Builder
			renderSourceLine(&b, c.origin, "某卡")
			got := b.String()
			if strings.Contains(got, "../") {
				t.Fatalf("出處帶內部相對路徑：\n%s", got)
			}
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Fatalf("出處少了「%s」：\n%s", w, got)
				}
			}
			// 人話那行不准變成三元組（`## 關聯` 的解析只收含兩個分隔符的行）。
			human := strings.Split(strings.TrimSpace(got), "\n")[1]
			if strings.Contains(human, triSep) {
				t.Fatalf("人話位置那行含三元組分隔符，會被當成一條邊：%s", human)
			}
		})
	}
}

// TestBuildWikiDocSourceLocatesSubfolderDoc 走完整落地路徑（不是只測 renderer）：
// 子資料夾裡的原稿，產出的文件卡與概念卡都要寫得出「庫內完整路徑」。
func TestBuildWikiDocSourceLocatesSubfolderDoc(t *testing.T) {
	root := t.TempDir()
	rel := "專案/會議/週會.md"
	if err := os.MkdirAll(filepath.Join(root, "專案", "會議"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := "# 週會\n\n甲和乙討論了進度。\n"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(rel)), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	ex := &DocExtract{
		Gloss: "週會記錄", Summary: "甲乙討論進度", Points: []string{"討論了進度"},
		Concepts: []WikiConcept{{Name: "進度", Gloss: "專案進度", Summary: "專案進度的討論"}},
	}
	origin := SourceOrigin{MachineLabel: "youlinhsieh@Leo-MBA", Library: "inkstoneco", LibraryPath: rel}
	cards, err := BuildWikiDoc(root, rel, src, ex, origin, time.Date(2026, 8, 27, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) == 0 {
		t.Fatal("沒產出卡")
	}
	for _, c := range cards {
		body, rerr := os.ReadFile(filepath.Join(root, filepath.FromSlash(c)))
		if rerr != nil {
			t.Fatal(rerr)
		}
		card := string(body)
		if strings.Contains(card, "../") {
			t.Fatalf("%s 仍帶 `../`：\n%s", c, card)
		}
		if !strings.Contains(card, "inkstoneco › 專案/會議/週會.md") {
			t.Fatalf("%s 的出處定位不到子資料夾：\n%s", c, card)
		}
	}
}
