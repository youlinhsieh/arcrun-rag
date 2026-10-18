package collector

// inkstone/arcrun-rag#274：型錄（Saber Brochure，InDesign 輸出）的版面文字被認成表，
// 吐出「D｜b｜l｜C｜l｜H…」的單字元亂碼。根因是 PDFium 回報字級 1.0（字框其實 8–12 點高），
// 儲存格斷開門檻變成 0.8 點，每個字母各自成格。客戶文件不進 repo，找不到就跳過。

import (
	"os"
	"strings"
	"testing"
)

const saberFixture = "/Users/youlinhsieh/Documents/tech_projects/ken_cnc/產品手冊/06-Saber Brochure_20250606.pdf"

// 字級回報失真（Size=1.0）的一行字：字框高度照真實字級。
func glyphsBadSize(text string, x, y, realSz float64) []pdfTextRect {
	var out []pdfTextRect
	for _, r := range text {
		w := realSz * 0.5
		if r != ' ' {
			// 真實 PDF：字母之間約 1.5 點間隙，字框高度＝真實字級，回報的 Size 卻是 1.0
			out = append(out, pdfTextRect{Text: string(r), Left: x, Right: x + w, Top: y + realSz*0.8, Bottom: y - realSz*0.2, Size: 1.0})
		}
		x += w + 1.5
	}
	return out
}

func TestNormalizeRectSizes_字級失真時不把每個字母拆成儲存格(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	for _, line := range []string{"Double Column High Torque", "5-Axis Machining Center", "Advanced short column design", "High torque milling head"} {
		rs = append(rs, glyphsBadSize(line, 60, y, 12)...)
		y -= 16
	}
	// 四行橫排內文：修好之後不是表，也不該被標成「拆碎的表」。
	if tabs := detectTextTables(1, rs); len(tabs) != 0 {
		t.Fatalf("橫排內文不該被認成表：%+v", tabs)
	}
	// 字級失真時，每一行應還原成完整的字串，而不是一個字母一格
	rows := clusterRows(normalizeRectSizes(rs))
	if len(rows) != 4 || len(rows[0].cells) != 1 || rows[0].cells[0].text != "Double Column High Torque" {
		t.Fatalf("第一行應還原成一格完整字串，實得 %d 列 %+v", len(rows), rows[0].cells)
	}
}

func TestNormalizeRectSizes_字級正常的頁不動它(t *testing.T) {
	rs := glyphs("Spindle speed", 60, 700, 12)
	got := normalizeRectSizes(rs)
	for i := range rs {
		if got[i].Size != 12 {
			t.Fatalf("字級正常的字被改了：%v", got[i].Size)
		}
	}
}

func TestNormalizeRectSizes_標點的字級也一併修(t *testing.T) {
	// 「-」字框只有 1.3 點高，自己不觸發失真條件；留著 1.0 會把同一行切成兩列。
	rs := glyphsBadSize("Hard-to-cut materials", 60, 700, 12)
	for i, r := range rs {
		if r.Text == "-" {
			rs[i].Top, rs[i].Bottom = r.Bottom+r.Size+2.6, r.Bottom+r.Size+1.3
			rs[i].Top = rs[i].Bottom + 1.3
		}
	}
	rows := clusterRows(normalizeRectSizes(rs))
	if len(rows) != 1 {
		t.Fatalf("同一行字應是 1 列，實得 %d 列", len(rows))
	}
}

func TestOffPage_頁外的字不算(t *testing.T) {
	if !offPage(-366, -362, 709, 704, 595, 842) {
		t.Error("x 為負的隱藏字應判為頁外")
	}
	if offPage(58, 66, 748, 737, 595, 842) {
		t.Error("頁內的字不該判為頁外")
	}
}

func TestTableShattered_大半單字元的表不輸出原字串(t *testing.T) {
	var rows [][]string
	for i := 0; i < 5; i++ {
		rows = append(rows, []string{"D", "b", "l", "C"})
	}
	tb := PDFTextTable{Page: 1, Rows: rows}
	if !tableShattered(tb) {
		t.Fatal("全是單字元的表應判為拆碎")
	}
	real := PDFTextTable{Page: 3, Rows: [][]string{
		{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}, {"Z-axis", "mm", "1,250"},
		{"Table length", "mm", "2,000"}, {"Spindle speed", "rpm", "24,000"},
	}}
	if tableShattered(real) {
		t.Fatal("真規格表不該被判為拆碎")
	}
}

func TestVerbatimSections_拆碎的表明標無法逐字抽取而不輸出亂碼(t *testing.T) {
	rep := &PDFReadReport{TextTables: []PDFTextTable{
		{Page: 9, Garbled: true},
		{Page: 3, Rows: [][]string{{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}, {"Z-axis", "mm", "1,250"}}},
	}}
	var all strings.Builder
	for _, s := range rep.VerbatimSections() {
		all.WriteString(s.Title + "\n" + s.Body + "\n")
	}
	body := all.String()
	if !strings.Contains(body, "無法逐字抽取") || !strings.Contains(body, "第 9 頁") {
		t.Errorf("缺「無法逐字抽取」標示：\n%s", body)
	}
	if !strings.Contains(body, "X-axis｜mm｜2,000") {
		t.Errorf("好的表被連帶丟掉：\n%s", body)
	}
}

func TestPDF真樣本_Saber型錄不再吐單字元亂碼(t *testing.T) {
	data, err := os.ReadFile(saberFixture)
	if err != nil {
		t.Skip("無 Saber 型錄樣本")
	}
	_, rep, err := ConvertToTextReport("saber.pdf", data)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, s := range rep.VerbatimSections() {
		all.WriteString(s.Title + "\n" + s.Body + "\n")
	}
	body := all.String()
	for _, bad := range []string{"D｜b｜l｜C｜l｜H", "o｜u｜e｜o｜u｜m", "g｜q"} {
		if strings.Contains(body, bad) {
			t.Errorf("仍有單字元亂碼 %q", bad)
		}
	}
	// 修後要嘛正確原字串，要嘛明標無法逐字抽取
	if !strings.Contains(body, "無法逐字抽取") {
		t.Errorf("第 9 頁的圖上標籤應被標為無法逐字抽取：\n%s", body)
	}
	// 真的規格列要在（第 7 頁機台尺寸表）
	if !strings.Contains(body, "Distance between column｜mm｜2,400｜3,000") {
		t.Errorf("Saber 第 7 頁的規格列不見了")
	}
}

func TestDetectTextTables_字級失真的真規格表仍逐格還原(t *testing.T) {
	rowsIn := [][3]string{
		{"Specifications", "Unit", "Saber 2840"},
		{"X-axis travel", "mm", "4,000"},
		{"Y-axis travel", "mm", "2,800"},
		{"Z-axis travel", "mm", "800"},
	}
	var rs []pdfTextRect
	y := 700.0
	for _, r := range rowsIn {
		rs = append(rs, cat(glyphsBadSize(r[0], 60, y, 12), glyphsBadSize(r[1], 330, y, 12), glyphsBadSize(r[2], 430, y, 12))...)
		y -= 16
	}
	tabs := detectTextTables(7, rs)
	if len(tabs) != 1 || tabs[0].Garbled {
		t.Fatalf("應還原 1 張好表：%+v", tabs)
	}
	for i, r := range rowsIn {
		got := tabs[0].Rows[i]
		if len(got) != 3 || got[0] != r[0] || got[1] != r[1] || got[2] != r[2] {
			t.Errorf("第 %d 列應逐格原樣 %v，實得 %v", i+1, r, got)
		}
	}
}

func TestVerbatimSections_同頁有拆碎的表時該頁其他表也不輸出(t *testing.T) {
	rep := &PDFReadReport{TextTables: []PDFTextTable{
		{Page: 13, Garbled: true},
		{Page: 13, Rows: [][]string{{"u", "T", "c"}, {"tr", "or", "hi"}}},
		{Page: 3, Rows: [][]string{{"X-axis", "mm", "2,000"}, {"Y-axis", "mm", "3,000"}}},
	}}
	var all strings.Builder
	for _, s := range rep.VerbatimSections() {
		all.WriteString(s.Title + "\n" + s.Body + "\n")
	}
	body := all.String()
	if strings.Contains(body, "u｜T｜c") {
		t.Errorf("同頁殘留的亂碼列被輸出：\n%s", body)
	}
	if !strings.Contains(body, "X-axis｜mm｜2,000") || !strings.Contains(body, "第 13 頁") {
		t.Errorf("好的表或標示不見：\n%s", body)
	}
}
