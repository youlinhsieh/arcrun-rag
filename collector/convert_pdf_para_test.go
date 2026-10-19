package collector

import (
	"os"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#277 下一刀（c21809 L7）：一般段落逐字進「原文段落」。
// 夾具是結構相同的補位文字（英文說明段、折行、標題），不是客戶原文；真樣本測試在本檔最後，檔案不在就 Skip。

const paraPage = `2.5 Heat Flow Control
The machine is equipped with a thermal compensation system that keeps the
spindle growth within a few microns during long cycles.
It also monitors the ambient temperature.

2.6 Safety
Dynamic Anti-Collision is available for all axes and stops the machine before
a collision can happen when the operator selects the protection mode.
Standard Configuration:
coolant tank
chip conveyor
work lamp
Footer line`

func TestDetectParagraphs_散文段原字串逐字且折行併回(t *testing.T) {
	ps := detectParagraphs(18, paraPage, nil, nil)
	var all []string
	for _, p := range ps {
		all = append(all, p.Heading+"｜"+p.Text)
	}
	joined := strings.Join(all, "\n")
	for _, want := range []string{
		"2.5 Heat Flow Control｜The machine is equipped with a thermal compensation system that keeps the spindle growth within a few microns during long cycles. It also monitors the ambient temperature.",
		"2.6 Safety｜Dynamic Anti-Collision is available for all axes and stops the machine before a collision can happen when the operator selects the protection mode.",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("缺段落 %q\n實得：\n%s", want, joined)
		}
	}
	// 條列（Standard Configuration 三項）已被「原文條列」收走，不重複
	if strings.Contains(joined, "chip conveyor") {
		t.Errorf("條列收走的行不重複放進段落：\n%s", joined)
	}
}

func TestDetectParagraphs_表格儲存格與頁首頁尾不收(t *testing.T) {
	tables := []PDFTextTable{{Page: 4, Rows: [][]string{{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}, {"Z-axis", "mm", "1,250"}}}}
	txt := "ACME Catalog\n1.2 Specs\nX-axis mm 2,000\nY-axis mm 3,000\nThis table lists the travel of every axis in the standard model.\n12"
	ps := detectParagraphs(4, txt, map[string]bool{"ACME Catalog": true}, tables)
	all := ""
	for _, p := range ps {
		all += p.Heading + "|" + p.Text + "\n"
	}
	if strings.Contains(all, "X-axis") || strings.Contains(all, "ACME") || strings.Contains(all, "|12") {
		t.Errorf("表格列、頁首、頁碼不進段落：%s", all)
	}
	if !strings.Contains(all, "This table lists the travel of every axis in the standard model.") {
		t.Errorf("表格旁的說明句要收：%s", all)
	}
}

func TestDetectParagraphs_拆碎的頁整頁不收(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("a\n")
	}
	if ps := detectParagraphs(7, b.String(), nil, nil); len(ps) != 0 {
		t.Errorf("單字元碎行的頁不放半對半錯的字：%+v", ps)
	}
	if ps := detectParagraphs(7, "Some sentence that is long enough to count as text.", nil, []PDFTextTable{{Page: 7, Garbled: true}}); len(ps) != 0 {
		t.Errorf("同頁有表被認定拆碎，整頁段落不收")
	}
}

func TestDetectParagraphs_目錄行不收(t *testing.T) {
	txt := "Contents\n2.5 Heat Flow Control System........................................ 18\n2.6 Safety and User-Friendly Design ................................ 18\nThe machine keeps its temperature stable during long cycles of work."
	ps := detectParagraphs(2, txt, nil, nil)
	all := ""
	for _, p := range ps {
		all += p.Heading + "|" + p.Text + "\n"
	}
	if strings.Contains(all, "....") || strings.Contains(all, "Heat Flow Control System") {
		t.Errorf("目錄行不進段落：%s", all)
	}
	if !strings.Contains(all, "The machine keeps its temperature stable during long cycles of work.") {
		t.Errorf("目錄旁的內文要收：%s", all)
	}
}

func TestJoinWrapped_中文折行不補空白(t *testing.T) {
	if got := joinWrapped("本機配備熱變位補", "償系統"); got != "本機配備熱變位補償系統" {
		t.Errorf("CJK 之間不補空白：%q", got)
	}
	if got := joinWrapped("使用 Heidenhain", "控制器"); got != "使用 Heidenhain 控制器" {
		t.Errorf("英文與中文之間補一個空白：%q", got)
	}
}

func TestRenderVerbatimParagraphs_附頁碼且有上限(t *testing.T) {
	paras := []PDFTextParagraph{
		{Page: 17, Heading: "2.4.6 Spindle", Text: "Oil mist lubrication is used."},
		{Page: 18, Heading: "2.5 Heat Flow Control", Text: "Thermal compensation."},
	}
	secs, dropped := renderVerbatimParagraphs(paras, func(p int) string { return "" })
	if dropped != 0 || len(secs) != 2 {
		t.Fatalf("secs=%d dropped=%d", len(secs), dropped)
	}
	if secs[0].Title != "PDF 第 17 頁的段落" || !strings.Contains(secs[0].Body, "第 1 段｜2.4.6 Spindle\nOil mist lubrication is used.") {
		t.Errorf("%+v", secs[0])
	}
	// 超過整份上限：不靜默截掉，回報沒收的字數
	big := strings.Repeat("word ", 1000) // 5000 字
	var many []PDFTextParagraph
	for i := 0; i < 8; i++ {
		many = append(many, PDFTextParagraph{Page: i + 1, Text: big})
	}
	secs, dropped = renderVerbatimParagraphs(many, func(p int) string { return "" })
	total := 0
	for _, s := range secs {
		total += len([]rune(s.Body))
		if len([]rune(s.Body)) > paraRunesPerBlock+200 {
			t.Errorf("單塊超過上限：%d", len([]rune(s.Body)))
		}
	}
	if dropped == 0 || total > maxParaRunesPerDoc+maxParaBlocksPerDoc*10 {
		t.Errorf("超過整份上限要擋並回報：total=%d dropped=%d", total, dropped)
	}
	rep := &PDFReadReport{TextParagraphs: many}
	last := rep.VerbatimSections()
	if !strings.Contains(last[len(last)-1].Body, "未收入原文段落") {
		t.Errorf("卡上要明講沒收的部分")
	}
}

func TestRenderDocCard_段落段與其他三段並存且lint排除(t *testing.T) {
	rep := &PDFReadReport{
		TextLists:      []PDFTextList{{Page: 6, Heading: "1.4.1 Standard", Items: []string{"a1", "HEIDENHAIN Handwheel –HR-520", "a3"}}},
		TextParagraphs: []PDFTextParagraph{{Page: 18, Heading: "2.9 DCM", Text: "Dynamic Compensation Module keeps accuracy."}},
	}
	ex := &DocExtract{Gloss: "g", Summary: "s", Verbatim: rep.VerbatimSections()}
	card := renderDocCard(&wikiDoc{Node: "(根)", Path: "x.pdf", DocID: "d1", Card: "x"}, ex, nil, SourceOrigin{}, nil)
	for _, want := range []string{"## 原文條列", "## 原文段落", "Dynamic Compensation Module keeps accuracy."} {
		if !strings.Contains(card, want) {
			t.Errorf("卡上缺 %q", want)
		}
	}
	if strings.Contains(stripVerbatimSection(card), "Dynamic Compensation") {
		t.Errorf("lint 要把原文段落整段拿掉")
	}
}

func TestPlainTextReport_純文字檔也走原文保留(t *testing.T) {
	md := "# 120-0006 (1/2)\n\n**Error message**\n\nConfiguration of soft key not readable\n\n**Cause of error**\n\nThe specified soft key is not contained in the configuration data.\n"
	rep := plainTextReport(nil, md)
	if rep == nil {
		t.Fatal(".md 沒有走原文保留")
	}
	secs := rep.VerbatimSections()
	all := ""
	for _, s := range secs {
		all += s.Body + "\n"
	}
	for _, want := range []string{"Configuration of soft key not readable", "The specified soft key is not contained in the configuration data."} {
		if !strings.Contains(all, want) {
			t.Errorf("缺 %q：\n%s", want, all)
		}
	}
	// 已有盤點（PDF）原樣回傳
	pr := &PDFReadReport{Pages: 3}
	if plainTextReport(pr, md) != pr {
		t.Errorf("有盤點就不覆蓋")
	}
	// 沒有字不產空盤點
	if plainTextReport(nil, "  \n\n ") != nil {
		t.Errorf("空內容回 nil")
	}
}

func TestPDF真樣本_大前規格書散文段進原文段落(t *testing.T) {
	raw, err := os.ReadFile(compactBFixture)
	if err != nil {
		t.Skip("沒有真樣本（雲端 CI 沒有 ken_cnc）")
	}
	_, rep, err := extractPDFDetailed(raw)
	if err != nil {
		t.Fatal(err)
	}
	secs := rep.VerbatimSections()
	var paraBody string
	blocks, runes := 0, 0
	for _, s := range secs {
		if s.Group == paragraphsGroup {
			paraBody += s.Title + "\n" + s.Body + "\n"
			blocks++
			runes += len([]rune(s.Body))
		}
	}
	t.Logf("原文段落：%d 塊、%d 字", blocks, runes)
	// L7 的三處（c21809）：p17 主軸說明、p18 的 2.5–2.9、p21 的 3.3–3.7；用結構相同、不含領域詞的判準驗：
	for _, want := range []string{"Heat Flow Control", "Dynamic Anti-Collision", "only available with Heidenhain"} {
		if !strings.Contains(paraBody, want) {
			t.Errorf("原文段落缺 %q", want)
		}
	}
	// 不破壞 #253 原文表格與 #277 條列
	all := ""
	for _, s := range secs {
		all += s.Body + "\n"
	}
	for _, want := range []string{"X-axis｜mm｜2,000", "HR-520", "NT-A3"} {
		if !strings.Contains(all, want) {
			t.Errorf("既有原文層缺 %q", want)
		}
	}
}
