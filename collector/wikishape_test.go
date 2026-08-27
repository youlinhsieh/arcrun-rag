// wikishape_test.go — 塑形層的格式保證（InkStoneCo#44 ④，逐項對著 wiki-lint.py 寫）。
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var wsNow = time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

func wsExtract() *DocExtract {
	return &DocExtract{
		Gloss:   "測試文件的一句話",
		Tags:    []string{"測試", "規範"},
		Summary: "一段給只需要知道大概的人看的摘要。",
		Points:  []string{"整份文件的重心其實在 [[概念甲]]，其餘是背景", "而 [[概念乙]] 是它的反例"},
		Concepts: []WikiConcept{
			{
				Name: "概念甲", Gloss: "甲的一句話", Tags: []string{"測試"},
				Summary: "甲的摘要。", Points: []string{"甲的第一個判斷"},
				Entities:  []WikiEntity{{Name: "甲", Type: "概念", Desc: "主角"}},
				Facts:     [][]string{{"甲", "屬於", "測試域"}},
				Relations: []WikiRelation{{To: "概念乙", Pred: "對照"}},
			},
			{
				Name: "概念乙", Gloss: "乙的一句話",
				Summary: "乙的摘要。", Points: []string{"乙的判斷"},
			},
		},
	}
}

// 格式逐項：frontmatter 四欄／← 上層／四段／實體帶類型／關聯三小節／出處指得到原稿。
func TestBuildWikiDoc_CardShapeMatchesSpec(t *testing.T) {
	root := t.TempDir()
	src := "# 測試文件\n\n內文若干"
	mustWrite(t, filepath.Join(root, "測試文件.md"), src)

	cards, err := BuildWikiDoc(root, "測試文件.md", src, wsExtract(), wsOrigin("測試文件.md"), wsNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 3 || cards[0] != ".wiki/測試文件.md" {
		t.Fatalf("cards=%v", cards)
	}
	doc := mustRead(t, filepath.Join(root, ".wiki", "測試文件.md"))
	for _, want := range []string{
		"tags: [測試, 規範]", "gloss: 測試文件的一句話", "created: 2026-08-15", "updated: 2026-08-15",
		"# 測試文件", "← [[00-INDEX]]", "## 摘要", "## 重點", "## 實體", "## 關聯",
		"### 內文知識關係", "### 卡片關係", "### 出處",
		"[[概念甲]]", "[[概念乙]]",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("文件卡缺「%s」：\n%s", want, doc)
		}
	}
	// 🔴 `inkstone/Arcrun#167`：出處寫的是「哪台機器／哪個庫／庫內什麼路徑」，
	// **不再是 `../`**（那是卡片檔相對原檔的內部結構，使用者拿著它走不到任何地方）。
	if !strings.Contains(doc, "`test@Machine \u203a test-lib \u203a 測試文件.md`") {
		t.Fatalf("出處沒寫成「機器 › 庫 › 庫內路徑」：\n%s", doc)
	}
	if !strings.Contains(doc, "`test-lib/測試文件.md`"+triSep+"提及") {
		t.Fatalf("出處三元組主詞不是庫內定位：\n%s", doc)
	}
	if strings.Contains(doc, "../") {
		t.Fatalf("出處仍帶內部相對路徑 `../`：\n%s", doc)
	}
	ca := mustRead(t, filepath.Join(root, ".wiki", "概念甲.md"))
	for _, want := range []string{
		"← [[測試文件]]",
		"- **甲**（概念）— 主角", // 實體帶類型（規範：類型不能省）
	} {
		if !strings.Contains(ca, want) {
			t.Fatalf("概念卡缺「%s」：\n%s", want, ca)
		}
	}
	// 乙沒給實體 → 自指 fallback（每張卡至少一個帶類型的實體）
	cb := mustRead(t, filepath.Join(root, ".wiki", "概念乙.md"))
	if !strings.Contains(cb, "- **概念乙**（概念）—") {
		t.Fatalf("概念乙缺實體 fallback：\n%s", cb)
	}
}

// 雙向連結保證：甲→乙有邊、乙沒回邊 → 機械補「相關」反向邊（lint「單向連結」項）。
// 出自／整理出 這對也天然雙向（lint 孤島卡項）。
func TestBuildWikiDoc_EdgesAreBidirectional(t *testing.T) {
	root := t.TempDir()
	src := "# 測試文件\n內文"
	mustWrite(t, filepath.Join(root, "測試文件.md"), src)
	if _, err := BuildWikiDoc(root, "測試文件.md", src, wsExtract(), wsOrigin("測試文件.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	cb := mustRead(t, filepath.Join(root, ".wiki", "概念乙.md"))
	if !strings.Contains(cb, "[[概念乙]]"+triSep+"相關"+triSep+"[[概念甲]]") {
		t.Fatalf("缺機械補上的反向邊：\n%s", cb)
	}
}

// 連結閉合：指不到的 [[連結]] 拆殼；index 式重點行被改寫（lint 斷連結／hub index 式兩項）。
func TestBuildWikiDoc_LinksClosedAndIndexishFixed(t *testing.T) {
	root := t.TempDir()
	src := "# 文件\n內文"
	mustWrite(t, filepath.Join(root, "文件.md"), src)
	ex := wsExtract()
	ex.Points = []string{"[[概念甲]] — 這行是 index 式，要被改寫", "這裡提到 [[不存在的卡]] 應拆殼"}
	if _, err := BuildWikiDoc(root, "文件.md", src, ex, wsOrigin("文件.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	doc := mustRead(t, filepath.Join(root, ".wiki", "文件.md"))
	if strings.Contains(doc, "[[不存在的卡]]") {
		t.Fatalf("留下了斷連結：\n%s", doc)
	}
	if !strings.Contains(doc, "- 關於 [[概念甲]]：") {
		t.Fatalf("index 式重點行沒被改寫：\n%s", doc)
	}
}

// 標空（差距 #10）：no_concept 不產卡，但 00-INDEX 的「## 文件」一定列它＋理由。
func TestMarkDocNoConcept_ListedOnIndex(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "發票.txt"), "金額 100")
	ex := &DocExtract{NoConcept: true, Reason: "純紀錄（發票），沒有可獨立成立的判斷"}
	cards, err := BuildWikiDoc(root, "發票.txt", "金額 100", ex, wsOrigin("發票.txt"), wsNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 0 {
		t.Fatalf("標空不該產卡：%v", cards)
	}
	idx := mustRead(t, filepath.Join(root, ".wiki", "00-INDEX.md"))
	if !strings.Contains(idx, "## 文件") || !strings.Contains(idx, "- `發票.txt` — 空：純紀錄（發票）") {
		t.Fatalf("00-INDEX 沒把空檔列出來：\n%s", idx)
	}
}

// 巢狀節點：卡落在 `<節點>/.wiki/`；祖先鏈的 00-INDEX 有「## 子節點」；
// manifest 的 node/path 用 wiki-lint 讀得懂的鍵。
func TestBuildWikiDoc_NestedNodeAndAncestors(t *testing.T) {
	root := t.TempDir()
	rel := filepath.Join("專案", "會議")
	mustMkdir(t, filepath.Join(root, rel))
	src := "# 週會決議\n內容"
	mustWrite(t, filepath.Join(root, rel, "週會.md"), src)

	if _, err := BuildWikiDoc(root, "專案/會議/週會.md", src, wsExtract(), wsOrigin("專案/會議/週會.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "專案", "會議", ".wiki", "週會決議.md")); err != nil {
		t.Fatalf("卡沒落在節點的 .wiki：%v", err)
	}
	for _, p := range []string{
		filepath.Join(root, ".wiki", "00-INDEX.md"),
		filepath.Join(root, "專案", ".wiki", "00-INDEX.md"),
		filepath.Join(root, "專案", "會議", ".wiki", "00-INDEX.md"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("祖先索引缺：%s（%v）", p, err)
		}
	}
	rootIdx := mustRead(t, filepath.Join(root, ".wiki", "00-INDEX.md"))
	if !strings.Contains(rootIdx, "## 子節點") || !strings.Contains(rootIdx, "`專案/`") {
		t.Fatalf("根索引缺子節點導覽：\n%s", rootIdx)
	}
	var man wikiManifest
	data := mustRead(t, filepath.Join(root, ".wiki", "manifest.json"))
	if err := json.Unmarshal([]byte(data), &man); err != nil {
		t.Fatal(err)
	}
	if len(man.Docs) != 1 || man.Docs[0].Node != "專案/會議" || man.Docs[0].Path != "週會.md" {
		t.Fatalf("manifest 鍵不對：%+v", man.Docs)
	}
}

// 重萃同一份文件：舊卡被收走、索引不重複、卡名變了也不留孤兒。
func TestBuildWikiDoc_ReextractCleansOldCards(t *testing.T) {
	root := t.TempDir()
	src := "# 文件\n內文"
	mustWrite(t, filepath.Join(root, "文件.md"), src)
	if _, err := BuildWikiDoc(root, "文件.md", src, wsExtract(), wsOrigin("文件.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	// 第二輪：概念換名
	ex2 := wsExtract()
	ex2.Concepts = []WikiConcept{{Name: "全新概念", Gloss: "新的一句話", Summary: "新摘要", Points: []string{"新判斷"}}}
	ex2.Points = []string{"重點換成 [[全新概念]] 了"}
	if _, err := BuildWikiDoc(root, "文件.md", src, ex2, wsOrigin("文件.md"), wsNow.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".wiki", "概念甲.md")); !os.IsNotExist(err) {
		t.Fatal("上一輪的舊概念卡沒被收走")
	}
	if _, err := os.Stat(filepath.Join(root, ".wiki", "全新概念.md")); err != nil {
		t.Fatal("新概念卡沒落地")
	}
	// created 保留第一輪、updated 是第二輪
	doc := mustRead(t, filepath.Join(root, ".wiki", "文件.md"))
	if !strings.Contains(doc, "created: 2026-08-15") || !strings.Contains(doc, "updated: 2026-08-16") {
		t.Fatalf("created/updated 不對：\n%.200s", doc)
	}
}

// 下架：原稿消失 → 卡、索引條目、manifest 條目一起收走。
func TestRemoveWikiDoc_CleansEverything(t *testing.T) {
	root := t.TempDir()
	src := "# 文件\n內文"
	mustWrite(t, filepath.Join(root, "文件.md"), src)
	if _, err := BuildWikiDoc(root, "文件.md", src, wsExtract(), wsOrigin("文件.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	if err := RemoveWikiDoc(root, "文件.md"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"文件.md", "概念甲.md", "概念乙.md"} {
		if _, err := os.Stat(filepath.Join(root, ".wiki", name)); !os.IsNotExist(err) {
			t.Fatalf("%s 沒被收走", name)
		}
	}
	idx := mustRead(t, filepath.Join(root, ".wiki", "00-INDEX.md"))
	if strings.Contains(idx, "文件.md") {
		t.Fatalf("索引還列著已下架的文件：\n%s", idx)
	}
}

// 不同文件、同名概念：後到者消歧（＋文件卡名），不覆蓋先到者（merge 是第⑤環的題目）。
func TestBuildWikiDoc_SameConceptFromTwoDocsDisambiguated(t *testing.T) {
	root := t.TempDir()
	srcA := "# 甲文\n內文"
	srcB := "# 乙文\n內文"
	mustWrite(t, filepath.Join(root, "a.md"), srcA)
	mustWrite(t, filepath.Join(root, "b.md"), srcB)
	ex := func() *DocExtract {
		return &DocExtract{Gloss: "一句話", Summary: "摘要",
			Points:   []string{"重點連到 [[迭代]]"},
			Concepts: []WikiConcept{{Name: "迭代", Gloss: "同名概念", Summary: "摘要", Points: []string{"判斷"}}}}
	}
	if _, err := BuildWikiDoc(root, "a.md", srcA, ex(), wsOrigin("a.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildWikiDoc(root, "b.md", srcB, ex(), wsOrigin("b.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	first := mustRead(t, filepath.Join(root, ".wiki", "迭代.md"))
	if !strings.Contains(first, "← [[甲文]]") {
		t.Fatalf("先到者被動過：\n%.200s", first)
	}
	if _, err := os.Stat(filepath.Join(root, ".wiki", "迭代（乙文）.md")); err != nil {
		t.Fatalf("後到者沒有消歧落地：%v", err)
	}
	// 乙文的重點連結要指向消歧後的名字（不留斷連結、不指錯人）
	docB := mustRead(t, filepath.Join(root, ".wiki", "乙文.md"))
	if strings.Contains(docB, "[[迭代]]") || !strings.Contains(docB, "[[迭代（乙文）]]") {
		t.Fatalf("乙文的連結沒有跟著消歧改名：\n%s", docB)
	}
}

// index 每行五樣（連結／摘要／標籤／建立日／更新日），全部照抄 frontmatter（lint idx_thin 項）。
func TestNodeIndex_FiveFieldsPerDocLine(t *testing.T) {
	root := t.TempDir()
	src := "# 測試文件\n內文"
	mustWrite(t, filepath.Join(root, "測試文件.md"), src)
	if _, err := BuildWikiDoc(root, "測試文件.md", src, wsExtract(), wsOrigin("測試文件.md"), wsNow); err != nil {
		t.Fatal(err)
	}
	idx := mustRead(t, filepath.Join(root, ".wiki", "00-INDEX.md"))
	if !strings.Contains(idx, "- [[測試文件]] — 測試文件的一句話（原稿 `測試文件.md`）") {
		t.Fatalf("index 行缺連結／摘要／原稿名：\n%s", idx)
	}
	if !strings.Contains(idx, "#測試 #規範　建 2026-08-15　更 2026-08-15") {
		t.Fatalf("index 行缺標籤／日期：\n%s", idx)
	}
}

func mustWrite(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
