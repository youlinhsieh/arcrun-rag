package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleErr = "# 145-0010 (2/2)\n\n> Error description 145-0010\n\n**Error message**\n\nIncorrect circular arc\n\n**Cause of error**\n\nThe specified radius is too small to connect the start point and end point.\n\n**Error correction**\n\nCorrect the coordinates.\n\n---\n\n- Error code: `145-0010`\n- Variant: 2 of 2\n"

func TestBlurbFromText_boldSections(t *testing.T) {
	got := blurbFromText(sampleErr)
	if !strings.Contains(got, "Incorrect circular arc") || !strings.Contains(got, "Cause of error") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "Variant") || strings.Contains(got, "Error code:") {
		t.Fatalf("水平線之後的來源資訊不該進說明：%q", got)
	}
}

func TestBlurbFromText_plainAndFrontmatter(t *testing.T) {
	got := blurbFromText("---\ntitle: x\n---\n# 標題\n\n這份文件說明退貨流程與時限。\n\n第二段。\n")
	if !strings.HasPrefix(got, "這份文件說明退貨流程與時限。") {
		t.Fatalf("got %q", got)
	}
	if blurbFromText("") != "" || blurbFromText("# 只有標題\n") != "" {
		t.Fatal("沒內容要回空")
	}
}

func TestBlurbsFor_replacesOnlyGeneric(t *testing.T) {
	root := t.TempDir()
	var docs []wikiDoc
	for _, n := range []string{"145-0010", "145-0011", "145-0012", "145-0013"} {
		os.WriteFile(filepath.Join(root, n+"_002.md"), []byte(strings.ReplaceAll(sampleErr, "Incorrect circular arc", "Msg of "+n)), 0o644)
		docs = append(docs, wikiDoc{Node: wikiRootNodeKey, Path: n + "_002.md", Status: "extracted", Gloss: "錯誤訊息" + n})
	}
	// 有料的 gloss 不動（即使原稿存在）
	os.WriteFile(filepath.Join(root, "a.md"), []byte("# a\n\n原稿內容\n"), 0o644)
	docs = append(docs, wikiDoc{Node: wikiRootNodeKey, Path: "a.md", Status: "extracted", Gloss: "退貨流程與時限"})
	b := blurbsFor(root, "", docs)
	if !strings.Contains(b["145-0011_002.md"], "Msg of 145-0011") {
		t.Fatalf("空話沒被換：%q", b["145-0011_002.md"])
	}
	if b["a.md"] != "退貨流程與時限" {
		t.Fatalf("有料的 gloss 被動到：%q", b["a.md"])
	}
	// 沒有原稿可讀 ⇒ 維持 gloss
	docs[0].Path = "missing.md"
	if blurbsFor(root, "", docs)["missing.md"] != "錯誤訊息145-0010" {
		t.Fatal("讀不到原稿要維持 gloss")
	}
	// absRoot 空 ⇒ 完全不動
	if blurbsFor("", "", docs)["145-0011_002.md"] != "錯誤訊息145-0011" {
		t.Fatal("無根時不該動")
	}
}

func TestBuildIdxCards_longLinesStillSplitBySize(t *testing.T) {
	var es []idxEntry
	long := strings.Repeat("字", 1500)
	for i := 0; i < 90; i++ {
		k := "k" + string(rune('a'+i/26)) + string(rune('a'+i%26))
		es = append(es, idxEntry{Key: k, Lines: "- [[" + k + "]] — " + long + "\n"})
	}
	cards := buildIdxCards(es, idxOpts{RootName: "00-INDEX", NameJoiner: "-", EmptyMsg: "x", Footer: "## 說明\n"})
	if len(cards) < 2 {
		t.Fatalf("90 行 × 4.5KB 應該被拆開，只有 %d 張", len(cards))
	}
	for _, c := range cards {
		if len(c.Content) > idxCardMaxBytes {
			t.Fatalf("%s 超過硬上限：%d", c.Name, len(c.Content))
		}
	}
}

func TestBlurbsFor_sharedShortGlossAcrossDifferentDocs(t *testing.T) {
	root := t.TempDir()
	var docs []wikiDoc
	for i := 0; i < 7; i++ {
		n := string(rune('a' + i))
		os.WriteFile(filepath.Join(root, n+".md"), []byte("# "+n+"\n\n"+n+" 這份在講不同的主題"+strings.Repeat(n, 3)+"\n"), 0o644)
		docs = append(docs, wikiDoc{Node: wikiRootNodeKey, Path: n + ".md", Status: "extracted", Gloss: "說明文件"})
	}
	b := blurbsFor(root, "", docs)
	if !strings.Contains(b["c.md"], "不同的主題") {
		t.Fatalf("7 份內容不同卻共用同一句短說明，應換成節錄：%q", b["c.md"])
	}
	// 同一篇文章的複本共用 gloss ⇒ 不算空話
	root2 := t.TempDir()
	var dup []wikiDoc
	for i := 0; i < 7; i++ {
		n := string(rune('a' + i))
		os.WriteFile(filepath.Join(root2, n+".md"), []byte("同一篇文章的開頭一模一樣而且夠長超過二十四個字，後面才不同"+n+"\n"), 0o644)
		dup = append(dup, wikiDoc{Node: wikiRootNodeKey, Path: n + ".md", Status: "extracted", Gloss: "說明文件"})
	}
	if blurbsFor(root2, "", dup)["c.md"] != "說明文件" {
		t.Fatal("複本不該被當空話")
	}
	// 年份不是代碼：不因為「2026」在檔名裡就換掉
	if glossRestatesName("2026年9月20日任務總結", "2026_09_20") {
		t.Fatal("純數字（年份）不算複述卡名")
	}
	if !glossRestatesName("錯誤145-0005的描述", "145-0005_002") {
		t.Fatal("錯誤碼包一圈字要算複述卡名")
	}
}

func TestBlurbFromText_noMidWordCut(t *testing.T) {
	// 三段都偏長：每一段都要留得到重點，且不斷在半個英文字中間
	text := "**Error message**\n\nIncorrect circular arc was specified in the program block\n\n**Cause of error**\n\nThe specified radius is too small to connect the start point and end point.\n\n**Error correction**\n\nCorrect the coordinates so that the radius is large enough to connect both points.\n"
	got := blurbFromText(text)
	if n := len([]rune(got)); n > blurbMaxRunes {
		t.Fatalf("超過上限 %d：%q", n, got)
	}
	for _, label := range []string{"Error message：", "Cause of error：", "Error correction："} {
		i := strings.Index(got, label)
		if i < 0 {
			t.Fatalf("缺小標 %s：%q", label, got)
		}
		rest := got[i+len(label):]
		if len([]rune(strings.SplitN(rest, "；", 2)[0])) < 15 {
			t.Fatalf("%s 的內容太短（被擠掉）：%q", label, got)
		}
	}
	// 每一段的結尾字要是完整單字（原稿以空白分詞）
	for _, seg := range strings.Split(got, "；") {
		seg = strings.TrimSuffix(seg, "…")
		words := strings.Fields(seg[strings.Index(seg, "：")+len("："):])
		last := strings.TrimRight(words[len(words)-1], ".")
		if !strings.Contains(" "+strings.ReplaceAll(strings.ReplaceAll(text, ".", " "), "\n", " ")+" ", " "+last+" ") {
			t.Fatalf("斷在半個字 %q：%q", last, got)
		}
	}
}

func TestBlurbTrunc_wordBoundary(t *testing.T) {
	if got := blurbTrunc("Correct the coordinates so that the radius works", 30); got != "Correct the coordinates so…" && !strings.HasSuffix(got, "…") {
		t.Fatalf("got %q", got)
	}
	got := blurbTrunc("Correct the coordinates so that the radius works", 30)
	if strings.Contains(got, "radi") && !strings.Contains(got, "radius") {
		t.Fatalf("斷在半個字：%q", got)
	}
	if blurbTrunc("短句", 30) != "短句" {
		t.Fatal("沒超過不動")
	}
}

// inkstone/arcrun-rag#264 c21637：原稿有 Error message ⇒ 目錄行用節錄，不留各說各話的中文空話。
func TestBlurbsFor_errorMessageAlwaysExcerpt(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "140-0002_001.md"),
		[]byte("**Error message**\n\nConfiguration file '%1' cannot be written.\n\n**Cause of error**\n\nThe file cannot be opened.\n- write-protected\n"), 0o644)
	os.WriteFile(filepath.Join(root, "x.md"), []byte("**Cause of error**\n\nfoo\n"), 0o644)
	docs := []wikiDoc{
		{Node: wikiRootNodeKey, Path: "140-0002_001.md", Status: "extracted", Gloss: "錯誤描述檔案寫入失敗"},
		{Node: wikiRootNodeKey, Path: "x.md", Status: "extracted", Gloss: "一份說明"},
	}
	b := blurbsFor(root, "", docs)
	if !strings.HasPrefix(b["140-0002_001.md"], "Error message：Configuration file") {
		t.Fatalf("有 Error message 的原稿應用節錄：%q", b["140-0002_001.md"])
	}
	if b["x.md"] != "一份說明" {
		t.Fatalf("沒有 Error message 的維持 gloss：%q", b["x.md"])
	}
}
