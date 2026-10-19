package collector

// inkstone/arcrun-rag#280 c21938：型錄的扭矩／功率曲線圖，座標刻度（90／180 Nm、60／90 kW、0／6,000…）
// 被還原成「表格列」逐字進卡，下游小模型把刻度當規格值（28K 主軸扭矩寫成 90 (180) Nm，正解 55 (75)）。
// 這裡全用合成資料（自己產一份帶曲線圖座標的小 PDF），不碰客戶檔案。

import (
	"fmt"
	"strings"
	"testing"
)

// pdfItem＝一段要畫在頁面上的字（左下角 x,y；PDF 點）。
type pdfItem struct {
	x, y float64
	size float64
	text string
}

// buildTestPDF 產一份單頁、Helvetica、只有文字的最小 PDF。
func buildTestPDF(items []pdfItem) []byte {
	var content strings.Builder
	for _, it := range items {
		esc := strings.NewReplacer(`\`, `\\`, `(`, `\(`, `)`, `\)`).Replace(it.text)
		fmt.Fprintf(&content, "BT /F1 %.1f Tf %.2f %.2f Td (%s) Tj ET\n", it.size, it.x, it.y, esc)
	}
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", content.Len(), content.String()),
	}
	var b strings.Builder
	b.WriteString("%PDF-1.4\n")
	offs := make([]int, len(objs))
	for i, o := range objs {
		offs[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, o := range offs {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return []byte(b.String())
}

// 一頁：上面是曲線圖的座標（左軸 Nm、右軸 kW、橫軸 rpm），下面是圖例的規格列。
func chartPageItems() []pdfItem {
	var it []pdfItem
	y := 700.0
	add := func(x, y float64, s string) { it = append(it, pdfItem{x: x, y: y, size: 10, text: s}) }
	add(60, y, "Nm")
	add(320, y, "kW")
	y -= 16
	for _, p := range [][2]string{{"90", "180"}, {"80", "160"}, {"70", "140"}, {"60", "120"}, {"50", "100"}, {"40", "80"}} {
		add(60, y, p[0])
		add(320, y, p[1])
		y -= 16
	}
	// 橫軸刻度
	for i, v := range []string{"0", "6,000", "12,000", "18,000", "24,000"} {
		add(60+float64(i)*70, y, v)
	}
	y -= 16
	add(60, y, "rpm")
	y -= 24
	// 圖例的真規格列
	add(60, y, "Spindle power S1-100% (S6-40%)")
	add(280, y, "kW")
	add(340, y, "42 (55)")
	y -= 16
	add(60, y, "Spindle torque S1-100% (S6-40%)")
	add(280, y, "Nm")
	add(340, y, "55 (75)")
	y -= 16
	add(60, y, "Spindle speed")
	add(280, y, "rpm")
	add(340, y, "24,000")
	return it
}

func TestPDF曲線圖的座標刻度不當成規格列進卡(t *testing.T) {
	_, rep, err := ConvertToTextReport("chart.pdf", buildTestPDF(chartPageItems()))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, s := range rep.VerbatimSections() {
		all.WriteString(s.Title + "\n" + s.Body + "\n")
	}
	body := all.String()
	// 真正的規格列逐字都在
	for _, want := range []string{
		"Spindle power S1 -100% (S6-40%)｜kW｜42 (55)",
		"Spindle torque S1 -100% (S6-40%)｜Nm｜55 (75)",
		"Spindle speed｜rpm｜24,000",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("真規格列不見了：%q\n%s", want, body)
		}
	}
	// 刻度不得以「列」的樣子出現：左右軸成對的 90｜180、橫軸的 0｜6,000｜12,000
	for _, bad := range []string{"90｜180", "80｜160", "0｜6,000", "6,000｜12,000", "12,000｜18,000"} {
		if strings.Contains(body, bad) {
			t.Errorf("曲線圖的刻度被當成表格列：%q\n%s", bad, body)
		}
	}
	// 沒有靜默：卡上要說這裡有圖、座標沒收
	if !strings.Contains(body, "曲線圖") || !strings.Contains(body, "未收錄") {
		t.Errorf("卡上沒有說明曲線圖座標未收：\n%s", body)
	}
	// 刻度也不得漏到原文段落去
	for _, s := range rep.VerbatimSections() {
		if s.Group == paragraphsGroup && (strings.Contains(s.Body, "12,000") || strings.Contains(s.Body, "180")) {
			t.Errorf("刻度漏進原文段落：%s", s.Body)
		}
	}
}

// 控制組：同樣是純數字欄、同樣等差，但每一列都有項目名的真資料表，原樣保留。
func TestDetectTextTables_有項目名的數字表不被當成圖(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	for _, r := range [][]string{
		{"Year", "Revenue", "Headcount"},
		{"2020", "1,200", "30"},
		{"2021", "1,500", "35"},
		{"2022", "1,800", "40"},
		{"2023", "2,100", "45"},
		{"2024", "2,400", "50"},
	} {
		for ci, c := range r {
			rs = append(rs, glyphs(c, 60+float64(ci)*120, y, 12)...)
		}
		y -= 16
	}
	tabs := detectTextTables(1, rs)
	if len(tabs) != 1 || tabs[0].ChartCellsDropped != 0 || len(tabs[0].Rows) != 6 {
		t.Fatalf("真資料表被當成圖或被吃掉：%+v", tabs)
	}
	if got := strings.Join(tabs[0].Rows[3], "｜"); got != "2022｜1,800｜40" {
		t.Fatalf("第 4 列被改了：%q", got)
	}
}

// 控制組：整張表都是數字、沒有任何項目名、也沒有等差刻度（隨機數據）→ 不是圖，不動。
func TestDropChartTicks_沒有刻度證據就不動(t *testing.T) {
	mk := func(vals ...string) []tcell {
		var out []tcell
		for i, v := range vals {
			out = append(out, tcell{text: v, left: float64(i) * 50, right: float64(i)*50 + 20})
		}
		return out
	}
	rows := [][]tcell{mk("3", "17", "9"), mk("41", "8", "26"), mk("12", "5", "33"), mk("7", "29", "14")}
	got, n := dropChartTicks(rows)
	if len(n) != 0 || len(got) != 4 {
		t.Fatalf("沒有刻度證據卻動了：n=%d rows=%d", len(n), len(got))
	}
}

// c21950：餵給 AI 的是整頁純文字，刻度在那裡也不能有（否則模型把刻度寫成「主軸功率 >> 是 >> 90 kW」）。
func TestPDF曲線圖的刻度不出現在餵給AI的純文字(t *testing.T) {
	txt, _, err := ConvertToTextReport("chart.pdf", buildTestPDF(chartPageItems()))
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"90 180", "80 160", "70 140", "60 120", "50 100", "40 80", "6,000", "12,000", "18,000", "Nm kW", "\nrpm\n"} {
		if strings.Contains(txt, bad) {
			t.Errorf("刻度還在純文字裡：%q\n%s", bad, txt)
		}
	}
	for _, want := range []string{"42 (55)", "55 (75)", "Spindle speed rpm 24,000", "Spindle power", "Spindle torque", "曲線圖", "未收錄"} {
		if !strings.Contains(txt, want) {
			t.Errorf("真規格或說明不見了：%q\n%s", want, txt)
		}
	}
}

// 沒有圖的頁，純文字一個字不動。
func TestStripChartTicksFromText_沒有刻度就原樣(t *testing.T) {
	in := "Spindle speed rpm 24,000\n90 180\n"
	if got := stripChartTicksFromText(in, nil); got != in {
		t.Fatalf("沒有刻度卻動了：%q", got)
	}
}
