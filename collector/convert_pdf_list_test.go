package collector

import (
	"strings"
	"testing"
)

// 夾具說明（誠實）：票上只給了 CompactB-3020 第 6 頁 19 項、第 19 頁 9 項「裡面有」的原字串
// （HEIDENHAIN Handwheel –HR-520／BLUM Laser Tool Measuring System (NT-A3)／TC-60／HR-550），
// 沒有給全部 28 行，且雲端這台拿不到原檔。其餘項目是結構相同的補位行（以 FILL 開頭），
// 用來驗「項數、順序、頁碼、逐字」；地端用真檔重收才是 #277 的最終驗收。
const (
	fixtureP6Head  = "1.4.1 Standard Configuration"
	fixtureP19Head = "3 Optional Configuration"
)

func fixturePage6() string {
	var b strings.Builder
	b.WriteString("1.3 Control System\nHEIDENHAIN TNC640 5-axis control\n\n")
	b.WriteString(fixtureP6Head + "\r\n")
	items := []string{"FILL standard item 01", "HEIDENHAIN Handwheel –HR-520"}
	for i := 3; i <= 19; i++ {
		items = append(items, "FILL standard item "+itoa(i))
	}
	b.WriteString(strings.Join(items, "\r\n") + "\r\n")
	b.WriteString("1.4.2 Documents Along with Shipment\nFILL doc A\nFILL doc B\nFILL doc C\n")
	b.WriteString("6\n")
	return b.String()
}

func fixturePage19() string {
	items := []string{"BLUM Laser Tool Measuring System (NT-A3)", "BLUM Touch Probe (TC-60)", "HEIDENHAIN Handwheel (HR-550)"}
	for i := 4; i <= 9; i++ {
		items = append(items, "FILL option "+itoa(i))
	}
	return fixtureP19Head + "\n" + strings.Join(items, "\n") + "\n19\n"
}

func TestDetectTextLists_條列逐字且附頁碼(t *testing.T) {
	pages := []pdfPageInfo{
		{Index: 5, Text: fixturePage6()},
		{Index: 18, Text: fixturePage19()},
	}
	rep := buildPDFReport(pages)
	var std, doc, opt *PDFTextList
	for i := range rep.TextLists {
		l := &rep.TextLists[i]
		switch l.Heading {
		case fixtureP6Head:
			std = l
		case "1.4.2 Documents Along with Shipment":
			doc = l
		case fixtureP19Head:
			opt = l
		}
	}
	if std == nil || len(std.Items) != 19 || std.Page != 6 || std.Items[1] != "HEIDENHAIN Handwheel –HR-520" {
		t.Fatalf("標準配備要有 19 項、第 6 頁、原字串：%+v", std)
	}
	if doc == nil || len(doc.Items) != 3 {
		t.Fatalf("隨機文件要收：%+v", doc)
	}
	if opt == nil || len(opt.Items) != 9 || opt.Page != 19 || opt.Items[0] != "BLUM Laser Tool Measuring System (NT-A3)" {
		t.Fatalf("選配要有 9 項、第 19 頁、原字串：%+v", opt)
	}
	for _, l := range rep.TextLists {
		if l.Heading == "1.3 Control System" {
			t.Errorf("只有 1 項的不是條列：%+v", l)
		}
	}
	secs := rep.VerbatimSections()
	all := ""
	for _, s := range secs {
		if s.Group != listsGroup {
			t.Errorf("條列段要標 Group：%+v", s)
		}
		all += s.Title + "\n" + s.Body + "\n"
	}
	for _, want := range []string{"HEIDENHAIN Handwheel –HR-520", "BLUM Laser Tool Measuring System (NT-A3)", "TC-60", "HR-550", "PDF 第 6 頁的條列：1.4.1 Standard Configuration", "PDF 第 19 頁的條列：3 Optional Configuration", "第 19 項｜FILL standard item 19"} {
		if !strings.Contains(all, want) {
			t.Errorf("卡上缺 %q：\n%s", want, all)
		}
	}
}

func TestDetectTextLists_編號項目不被當成標題(t *testing.T) {
	text := "2 Accessories\n1 Chip conveyor\n2 Coolant tank\n3 Work lamp\n4 Air gun\n"
	ls := detectTextLists(3, text, nil, nil)
	if len(ls) != 1 || ls[0].Heading != "2 Accessories" || len(ls[0].Items) != 4 || ls[0].Items[0] != "1 Chip conveyor" {
		t.Fatalf("編號 1,2,3… 是項目：%+v", ls)
	}
}

func TestDetectTextLists_散文與表格頁讓出(t *testing.T) {
	prose := "1.1 Overview\nThis machine is designed for heavy duty cutting of aluminium parts in aerospace shops.\nIt offers excellent rigidity and thermal stability across the whole working range.\n"
	if ls := detectTextLists(1, prose, nil, nil); len(ls) != 0 {
		t.Errorf("散文不是條列：%+v", ls)
	}
	tab := "1.2 Machine Specifications\nX-axis mm 2,000\nY-axis mm 3,000\nZ-axis mm 1,250\nSpindle rpm 24,000\n"
	tables := []PDFTextTable{{Page: 4, Rows: [][]string{{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}, {"Z-axis", "mm", "1,250"}, {"Spindle", "rpm", "24,000"}}}}
	if ls := detectTextLists(4, tab, nil, tables); len(ls) != 0 {
		t.Errorf("已還原成表的頁不重複收成條列（#253 原文表格不被破壞）：%+v", ls)
	}
}

func TestDetectAllLists_頁首頁尾不算項目(t *testing.T) {
	var pages []pdfPageInfo
	for i := 0; i < 6; i++ {
		txt := "ACME Machine Catalog\n"
		if i == 2 {
			txt += "Standard Features:\nitem a\nitem b\nitem c\n"
		}
		pages = append(pages, pdfPageInfo{Index: i, Text: txt})
	}
	ls := detectAllLists(pages)
	if len(ls) != 1 || len(ls[0].Items) != 3 {
		t.Fatalf("每頁都有的頁首不進條列：%+v", ls)
	}
}

func TestRenderDocCard_條列段與表格段並存且lint排除(t *testing.T) {
	rep := &PDFReadReport{
		TextTables: []PDFTextTable{{Page: 4, Rows: [][]string{{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}, {"Z-axis", "mm", "1,250"}}}},
		TextLists:  []PDFTextList{{Page: 6, Heading: fixtureP6Head, Items: []string{"a1", "HEIDENHAIN Handwheel –HR-520", "a3"}}},
	}
	ex := &DocExtract{Gloss: "g", Summary: "s", Verbatim: rep.VerbatimSections()}
	card := renderDocCard(&wikiDoc{Node: "(根)", Path: "x.pdf", DocID: "d1", Card: "x"}, ex, nil, SourceOrigin{}, nil)
	for _, want := range []string{"## 原文表格", "第 1 列｜X-axis｜mm｜2,000", "## 原文條列", "第 2 項｜HEIDENHAIN Handwheel –HR-520"} {
		if !strings.Contains(card, want) {
			t.Errorf("卡上缺 %q", want)
		}
	}
	if strings.Index(card, "## 原文表格") > strings.Index(card, "## 原文條列") {
		t.Errorf("表格段在前")
	}
	if strings.Contains(card, "第 1 項｜X-axis") || strings.Contains(card, "第 1 列｜a1") {
		t.Errorf("兩組不可混放")
	}
	plain := stripVerbatimSection(card)
	if strings.Contains(plain, "HR-520") || strings.Contains(plain, "2,000") {
		t.Errorf("lint 前兩段都要拿掉")
	}
}

// minimalPDF 手刻一份單頁、每行一個 Tj 的 PDF（Helvetica），給端到端測 PDFium 真的讀得到條列。
func minimalPDF(lines []string) []byte {
	var content strings.Builder
	content.WriteString("BT /F1 12 Tf 14 TL 72 740 Td\n")
	for _, l := range lines {
		l = strings.NewReplacer(`\`, `\\`, "(", `\(`, ")", `\)`).Replace(l)
		content.WriteString("(" + l + ") Tj T*\n")
	}
	content.WriteString("ET")
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Length " + itoa(content.Len()) + " >>\nstream\n" + content.String() + "\nendstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var b strings.Builder
	b.WriteString("%PDF-1.4\n")
	offs := make([]int, len(objs))
	for i, o := range objs {
		offs[i] = b.Len()
		b.WriteString(itoa(i+1) + " 0 obj\n" + o + "\nendobj\n")
	}
	x := b.Len()
	b.WriteString("xref\n0 " + itoa(len(objs)+1) + "\n0000000000 65535 f \n")
	for _, o := range offs {
		s := itoa(o)
		b.WriteString(strings.Repeat("0", 10-len(s)) + s + " 00000 n \n")
	}
	b.WriteString("trailer\n<< /Size " + itoa(len(objs)+1) + " /Root 1 0 R >>\nstartxref\n" + itoa(x) + "\n%%EOF\n")
	return []byte(b.String())
}

func TestExtractPDFDetailed_真PDF的條列進原文條列(t *testing.T) {
	data := minimalPDF([]string{
		"1.4.1 Standard Configuration",
		"Coolant tank",
		"HEIDENHAIN Handwheel -HR-520",
		"Chip conveyor",
		"1.4.2 Documents Along with Shipment",
		"Foundation plans",
		"Operation manual",
		"Wiring diagram",
	})
	_, rep, err := extractPDFDetailed(data)
	if err != nil {
		t.Fatal(err)
	}
	secs := rep.VerbatimSections()
	all := ""
	for _, s := range secs {
		all += s.Title + "\n" + s.Body + "\n"
	}
	for _, want := range []string{"PDF 第 1 頁的條列：1.4.1 Standard Configuration", "第 2 項｜HEIDENHAIN Handwheel -HR-520", "Foundation plans"} {
		if !strings.Contains(all, want) {
			t.Errorf("缺 %q：\n%s", want, all)
		}
	}
}

// 真檔（CompactB 第 6、19 頁）的折行：第 18 項折成兩行、「(6)」「(7)」編號獨立一行 ⇒ 項號要對得上原稿。
func TestMergeWrapped_折行併回同一項(t *testing.T) {
	items := []string{
		"17. Waterproof work light",
		"18. Electrical cabinet with a variety of electrical protection, filtration and ventilation installations and",
		"air-conditioning systems",
		"19. Machine standard color",
	}
	got := mergeWrapped(items)
	if len(got) != 3 || !strings.HasSuffix(got[1], "installations and air-conditioning systems") || got[2] != "19. Machine standard color" {
		t.Fatalf("第 18 項折行沒併回：%q", got)
	}
	opt := []string{"Optional item", "(5) Coolant Through Spindle 20 / 30 / 40 / 50 Bar", "(6)", "Automatic Kinematics Compensation System",
		"Include: small ball gauge", "(7)", "GPS (Global Program Settings) Function", "(8) Oil Mist Collection"}
	g2 := mergeWrapped(opt)
	if len(g2) != 5 || g2[2] != "(6) Automatic Kinematics Compensation System Include: small ball gauge" || g2[3] != "(7) GPS (Global Program Settings) Function" {
		t.Fatalf("(6)(7) 孤立編號沒併回下一行：%q", g2)
	}
	plain := []string{"Operation manual", "NC program manual", "Circuit diagram"}
	if g3 := mergeWrapped(plain); len(g3) != 3 {
		t.Fatalf("非編號條列不該動：%q", g3)
	}
}

// 讀圖辨識文字落卡（c21651）：afterRead 後條列不消失，辨識文字原樣進「讀圖原文」段，說明指向該段。
func TestAfterRead_辨識文字落卡且條列不丟(t *testing.T) {
	rep := &PDFReadReport{Pages: 20, ImagePageNums: []int{19}, TextLists: []PDFTextList{{Page: 6, Heading: "1.4.1 Standard Configuration", Items: []string{"1. a", "2. b", "3. c"}}}}
	res := &ImageReadResult{Reads: []ImagePageRead{{Page: 19, Text: "BLUM Laser Tool Measuring System (NT-A3)\nHR-550"}, {Page: 20, Text: "TC-60", Flagged: true}}}
	out := rep.afterRead(res)
	if len(out.TextLists) != 1 {
		t.Fatalf("afterRead 把文字層條列丟了")
	}
	secs := out.VerbatimSections()
	var got []string
	for _, v := range secs {
		if v.Group == imageReadGroup {
			got = append(got, v.Title+"\n"+v.Body)
		}
	}
	if len(got) != 2 || !strings.Contains(got[0], "NT-A3") || !strings.Contains(got[0], "HR-550") || !strings.Contains(got[1], "需人工確認") {
		t.Fatalf("讀圖原文段不對：%q", got)
	}
	if n := strings.Join(out.Extra, ""); !strings.Contains(n, "讀圖原文") {
		t.Fatalf("說明沒指向落卡的段：%q", n)
	}
}
