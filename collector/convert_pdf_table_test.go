package collector

// inkstone/arcrun-rag#253 c20342：工具機規格表（PDF 有文字層）收進庫後，客服機器人只靠 MCP 讀卡／搜尋
// 查不到任何一列。真樣本＝大前科技 Machine Feature PDF（23 頁）。客戶文件不進 repo（同 NRI 樣本），
// 只在 leo 的 Mac 上有；找不到就跳過。雲端驗證紀錄見 inkstone/arcrun-rag#253 c20357。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const compactBFixture = "/Users/youlinhsieh/Documents/tech_projects/ken_cnc/業務單位產品方案/CompactB-3020(Z1250)+K2 (A63)24K-Machine Features.pdf"

// 一個字元一個矩形的簡易建構：從 (x,y) 起，字級 sz，每字寬 sz*0.5。
func glyphs(text string, x, y, sz float64) []pdfTextRect {
	var out []pdfTextRect
	for _, r := range text {
		w := sz * 0.5
		if r != ' ' {
			out = append(out, pdfTextRect{Text: string(r), Left: x, Right: x + w, Top: y + sz*0.8, Bottom: y - sz*0.2, Size: sz})
		}
		x += w + 0.3
	}
	return out
}

func cat(parts ...[]pdfTextRect) []pdfTextRect {
	var out []pdfTextRect
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func TestDetectTextTables_三欄規格表逐格還原(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	rowsIn := [][3]string{
		{"Specifications", "Unit", "Compact B-3020"},
		{"X-axis", "mm", "2,000"},
		{"Y-axis", "mm", "3,000"},
		{"Spindle speed", "rpm", "24,000"},
	}
	for _, r := range rowsIn {
		rs = append(rs, cat(glyphs(r[0], 60, y, 12), glyphs(r[1], 330, y, 12), glyphs(r[2], 430, y, 12))...)
		y -= 16
	}
	tabs := detectTextTables(3, rs)
	if len(tabs) != 1 {
		t.Fatalf("應認出 1 張表，實得 %d", len(tabs))
	}
	got := tabs[0]
	if got.Page != 3 || len(got.Rows) != 4 {
		t.Fatalf("頁碼／列數不對：%+v", got)
	}
	for i, r := range rowsIn {
		if len(got.Rows[i]) != 3 || got.Rows[i][0] != r[0] || got.Rows[i][1] != r[1] || got.Rows[i][2] != r[2] {
			t.Errorf("第 %d 列應逐格原樣 %v，實得 %v", i+1, r, got.Rows[i])
		}
	}
}

func TestDetectTextTables_單位片段畫在數值列上下方要併回那一列(t *testing.T) {
	// 真樣本第 4 頁的形狀：「rpm」與「(360°/S)」是跨兩行的單位，垂直置中夾在數值列上下方
	var rs []pdfTextRect
	rs = append(rs, cat(glyphs("Rotation speed", 60, 731, 12), glyphs("50 / 50", 440, 731, 12))...)
	rs = append(rs, glyphs("rpm", 328, 742, 12)...)
	rs = append(rs, glyphs("(360/S)", 314, 720, 12)...)
	rs = append(rs, cat(glyphs("Max. acceleration", 60, 705, 12), glyphs("rad/s2", 324, 705, 12), glyphs("30 / 30", 440, 705, 12))...)
	rs = append(rs, cat(glyphs("Max. torque", 60, 689, 12), glyphs("Nm", 330, 689, 12), glyphs("1,422 / 1,396", 426, 689, 12))...)
	rs = append(rs, cat(glyphs("Clamping torque", 60, 673, 12), glyphs("Nm", 330, 673, 12), glyphs("5,000 / 5,000", 426, 673, 12))...)
	tabs := detectTextTables(4, rs)
	if len(tabs) != 1 {
		t.Fatalf("應認出 1 張表，實得 %d", len(tabs))
	}
	var first []string
	for _, r := range tabs[0].Rows {
		if strings.HasPrefix(r[0], "Rotation") {
			first = r
		}
	}
	if len(first) != 3 || first[1] != "rpm (360/S)" || first[2] != "50 / 50" {
		t.Errorf("跨行的單位應併回數值那一列（rpm (360/S)），實得 %v", first)
	}
}

func TestDetectTextTables_清單與雙欄散文不是表(t *testing.T) {
	// 項目符號清單：符號＋整句
	var list []pdfTextRect
	y := 700.0
	for _, s := range []string{
		"Include 5-axes the entire axis closed loop.",
		"Include a USB interface network card transmission.",
		"Have the forward looking function in the system.",
		"Include sample interpolation function for the user.",
	} {
		list = append(list, cat(glyphs("1.", 60, y, 12), glyphs(s, 100, y, 12))...)
		y -= 16
	}
	if tabs := detectTextTables(1, list); len(tabs) != 0 {
		t.Errorf("項目符號清單不該被當成表：%+v", tabs)
	}
	// 雙欄散文：每行兩段長句
	var cols []pdfTextRect
	y = 700
	for i := 0; i < 5; i++ {
		cols = append(cols, cat(
			glyphs("This is a long prose column left side sentence", 50, y, 10),
			glyphs("And this is the right side column running prose text", 330, y, 10))...)
		y -= 13
	}
	if tabs := detectTextTables(1, cols); len(tabs) != 0 {
		t.Errorf("雙欄散文不該被當成表：%+v", tabs)
	}
}

func TestRenderVerbatimTables_列號表頭與分段(t *testing.T) {
	rows := [][]string{{"Item", "Unit", "Value"}}
	for i := 1; i <= 55; i++ {
		rows = append(rows, []string{"Row" + itoa(i), "mm", itoa(i * 100)})
	}
	secs, dropped := renderVerbatimTables([]PDFTextTable{{Page: 3, Caption: "1.2 Machine Specifications", Rows: rows}},
		func(p int) string { return "1" })
	if dropped != 0 || len(secs) != 2 {
		t.Fatalf("56 列應分 2 段（每段 40 列）、不丟列：段=%d 丟=%d", len(secs), dropped)
	}
	if secs[0].Title != "PDF 第 3 頁・印刷頁 1的表格（第 1 段）" {
		t.Errorf("標題要有頁碼與段次：%q", secs[0].Title)
	}
	if !strings.Contains(secs[0].Body, "【1.2 Machine Specifications】") || !strings.Contains(secs[0].Body, "第 1 列｜Item｜Unit｜Value") ||
		!strings.Contains(secs[0].Body, "第 2 列｜Row1｜mm｜100") {
		t.Errorf("每段要有表名、每列帶列號、儲存格用全形直線隔開：\n%s", secs[0].Body)
	}
	if !strings.Contains(secs[1].Body, "【1.2 Machine Specifications】\n表頭（第 1 列）：Item｜Unit｜Value") ||
		!strings.Contains(secs[1].Body, "第 41 列｜Row40｜mm｜4000") || !strings.Contains(secs[1].Body, "第 56 列｜Row55｜mm｜5500") {
		t.Errorf("切在表中間時，下一段要重複表名與表頭、列號接續：\n%s", secs[1].Body)
	}
}

func TestRenderVerbatimTables_同一頁多張表合成一段(t *testing.T) {
	tabs := []PDFTextTable{
		{Page: 8, Caption: "甲表", Rows: [][]string{{"a", "1"}, {"b", "2"}}},
		{Page: 8, Rows: [][]string{{"c", "3"}, {"d", "4"}}},
		{Page: 9, Rows: [][]string{{"e", "5"}}},
	}
	secs, _ := renderVerbatimTables(tabs, func(int) string { return "" })
	if len(secs) != 2 || secs[0].Title != "PDF 第 8 頁的表格" || secs[1].Title != "PDF 第 9 頁的表格" {
		t.Fatalf("同一頁的表合成一段（每段＝一次寫入子請求）：%+v", secs)
	}
	if !strings.Contains(secs[0].Body, "【甲表】") || !strings.Contains(secs[0].Body, "【表格 2】") {
		t.Errorf("無表名的表要有代稱：\n%s", secs[0].Body)
	}
}

func TestRenderVerbatimTables_超過上限要明說(t *testing.T) {
	rows := make([][]string, 600)
	for i := range rows {
		rows[i] = []string{"r", itoa(i)}
	}
	rep := &PDFReadReport{TextTables: []PDFTextTable{{Page: 1, Rows: rows}}}
	secs := rep.VerbatimSections()
	last := secs[len(secs)-1]
	if last.Title != "未收入的表格列" || !strings.Contains(last.Body, "未收入") {
		t.Errorf("超過上限要明說（%d 列／表、%d 列／文件）：%+v", maxTableRowsPerTable, maxVerbatimRowsPerDoc, last)
	}
}

func TestStripVerbatimSection(t *testing.T) {
	card := "# 卡\n\n## 摘要\n甲\n\n## 原文表格\n說明\n\n### 表（PDF 第 1 頁）\n第 1 列｜X｜2,000\n\n## 實體\n乙\n"
	got := stripVerbatimSection(card)
	if strings.Contains(got, "2,000") || strings.Contains(got, "原文表格") || !strings.Contains(got, "## 實體") || !strings.Contains(got, "甲") {
		t.Errorf("只該拿掉原文表格整段：\n%s", got)
	}
}

// ── 版面底圖 ──

func TestDropTemplateImages_每頁同一張底圖不算圖片頁(t *testing.T) {
	text := strings.Repeat("這一頁有很多字可以讀。", 10)
	var pages []pdfPageInfo
	for i := 0; i < 8; i++ {
		pages = append(pages, pdfPageInfo{Index: i, Text: text, BigImages: 1, ImageSigs: []string{"bg"}})
	}
	pages[3].BigImages, pages[3].ImageSigs = 2, []string{"bg", "photo"} // 第 4 頁另有一張真的照片
	dropTemplateImages(pages)
	for i, p := range pages {
		want := 0
		if i == 3 {
			want = 1
		}
		if p.BigImages != want {
			t.Errorf("第 %d 頁大圖數應為 %d，實得 %d", i+1, want, p.BigImages)
		}
	}
}

func TestDropTemplateImages_沒有字的頁與只出現兩次的圖不扣(t *testing.T) {
	var pages []pdfPageInfo
	for i := 0; i < 6; i++ { // 掃描檔：每頁一張圖、沒有文字層
		pages = append(pages, pdfPageInfo{Index: i, Text: "", BigImages: 1, ImageSigs: []string{"same-blank"}})
	}
	dropTemplateImages(pages)
	for i, p := range pages {
		if p.BigImages != 1 {
			t.Errorf("沒有文字層的頁不能被扣成 0（掃描檔會變成讀不出）：第 %d 頁 %d", i+1, p.BigImages)
		}
	}
	two := []pdfPageInfo{
		{Index: 0, Text: strings.Repeat("字", 100), BigImages: 1, ImageSigs: []string{"fig"}},
		{Index: 1, Text: strings.Repeat("字", 100), BigImages: 1, ImageSigs: []string{"fig"}},
		{Index: 2, Text: strings.Repeat("字", 100)},
	}
	dropTemplateImages(two)
	if two[0].BigImages != 1 || two[1].BigImages != 1 {
		t.Error("只出現在 2 頁的圖是內容，不是底圖")
	}
}

// ── 真樣本（大前科技 Machine Feature，第 3、4、5、8 頁）──

func TestPDF真樣本_大前規格表每一列逐字進原文表格(t *testing.T) {
	data, err := os.ReadFile(compactBFixture)
	if err != nil {
		t.Skip("無大前 CompactB-3020 樣本")
	}
	_, rep, err := ConvertToTextReport("CompactB-3020 Machine Features.pdf", data)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, s := range rep.VerbatimSections() {
		all.WriteString(s.Title + "\n" + s.Body + "\n")
	}
	body := all.String()
	// 驗收：客服機器人要查的每一列，項目｜單位｜數值的原字串都在（ticket c20342 點名的三列＋各區塊代表列）
	for _, want := range []string{
		"X-axis｜mm｜2,000",
		"Y-axis｜mm｜3,000",
		"Z-axis｜mm｜1,250",
		"Distance between spindle nose to table surface｜mm｜250~1,500",
		"Distance between columns｜mm｜3,895",
		"Table length｜mm｜2,000",
		"X/Y/Z-axis rapid feedrate｜m/min｜60 / 60 / 50",
		"Positioning accuracy X/Y/Z axis｜Full travel/mm｜0.0084 / 0.0112 / 0.0063",
		"Repeat positioning accuracy X/Y/Z axis｜Full travel/mm｜0.0050 / 0.0062 / 0.0042",
		"Spindle speed｜rpm｜24,000",
		"Spindle power S1-100% (S6-40%)｜kW｜42 (55)",
		"Tool magazine capacity｜pcs｜30",
		"Max. tool dimensions (Adj.pocket empty)｜mm｜Ø 75 (Ø 125)",
		"Rotation speed｜B/C｜rpm (360°/S)｜50 / 50",
		"Max. torque:｜B/C (S6-40%)｜Nm｜1,422 / 1,396",
		"Air pressure requirement (minimum)｜kg/cm2｜6~7",
		"G｜Distance between spindle nose to spindle nose (X-Direction)｜1,480",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("原文表格缺這一列：%q", want)
		}
	}
	// 表名與頁碼要在區塊標題上（單獨被搜到也看得出是哪張表、哪一頁）
	if !strings.Contains(body, "PDF 第 3 頁的表格") || !strings.Contains(body, "【1.2 Machine Specifications】") {
		t.Errorf("頁碼／表名不在段落裡：\n%s", body[:300])
	}
	// 沒有重複吐字（矩形模式的病：T-T-slot、ToTorque）
	for _, bad := range []string{"T-T-slot", "ToTorque", "TyType"} {
		if strings.Contains(body, bad) {
			t.Errorf("出現重複字 %q", bad)
		}
	}
}

func TestPDF真樣本_有文字層的規格頁不再被當圖片頁讀兩遍(t *testing.T) {
	data, err := os.ReadFile(compactBFixture)
	if err != nil {
		t.Skip("無大前 CompactB-3020 樣本")
	}
	_, rep, err := ConvertToTextReport("m.pdf", data)
	if err != nil {
		t.Fatal(err)
	}
	// 修之前：23 頁全被當圖片頁（每頁都鋪同一張整頁底圖），整份被當掃描檔、每頁讀兩次圖
	if len(rep.ImagePageNums) == 0 || len(rep.ImagePageNums) >= rep.Pages {
		t.Errorf("只有真的圖頁該被當圖片頁，實得 %v／共 %d 頁", rep.ImagePageNums, rep.Pages)
	}
	for _, p := range rep.ImagePageNums {
		if p == 3 || p == 4 {
			t.Errorf("1.2 規格表所在的第 3、4 頁不該被當圖片頁，實得 %v", rep.ImagePageNums)
		}
	}
}

// 端到端：轉檔 → 假雲端萃取（回一張概念卡）→ 落地的文件卡要有逐字表格；讀圖只送真的圖片頁；
// 品質檢查不能因為這一大段逐字文字把卡打成 quality:low。
func TestExtractWithWorkersAI_規格表逐字進文件卡且讀圖只送圖片頁(t *testing.T) {
	root := t.TempDir()
	data, err := os.ReadFile(compactBFixture)
	if err != nil {
		t.Skip("無大前 CompactB-3020 樣本")
	}
	const rel = "CompactB-3020 Machine Features.pdf"
	if err := os.WriteFile(filepath.Join(root, rel), data, 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var readPages []int
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/read-image") {
			var body struct {
				Page int `json:"page"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			readPages = append(readPages, body.Page)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "機器照片"})
			return
		}
		out, _ := json.Marshal(map[string]any{
			"gloss": "龍門五軸加工機規格", "summary": "CompactB-3020 的機台規格。", "points": []string{"行程 [[行程規格]]"},
			"concepts": []map[string]any{{"name": "行程規格", "gloss": "三軸行程", "summary": "X/Y/Z 行程。", "points": []string{"X 軸行程"}}},
		})
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": string(out)})
	})
	defer closeFn()

	cards, err := extractWithWorkersAI(url, "k", root, rel, testOrigin(), false)
	if err != nil {
		t.Fatal(err)
	}
	hub, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(cards[0])))
	if err != nil {
		t.Fatal(err)
	}
	card := string(hub)
	for _, want := range []string{"## 原文表格", "第 3 列｜X-axis｜mm｜2,000", "Spindle speed｜rpm｜24,000", "### PDF 第 3 頁的表格"} {
		if !strings.Contains(card, want) {
			t.Errorf("文件卡缺 %q", want)
		}
	}
	if i, j, k := strings.Index(card, "## 重點"), strings.Index(card, "## 原文表格"), strings.Index(card, "## 關聯"); !(i < j && j < k) {
		t.Errorf("原文表格段應在重點之後、關聯之前")
	}
	// 品質檢查：用同一份轉檔文字當原稿，逐字表格不能讓卡變 quality:low
	src, _, _ := ConvertToTextReport(rel, data)
	if lr := LintCard(card, LintOptions{Source: src}); len(lr.SoftMessages()) > 0 || len(lr.HardMessages()) > 0 {
		t.Errorf("逐字表格不該觸發品質警告：硬=%v 軟=%v", lr.HardMessages(), lr.SoftMessages())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(readPages) == 0 {
		t.Errorf("真的圖頁還是要送讀圖，實得 %v", readPages)
	}
	for _, p := range readPages {
		if p == 3 || p == 4 {
			t.Errorf("1.2 規格表所在的第 3、4 頁不該送讀圖，實得 %v", readPages)
		}
	}
}

// inkstone/arcrun-rag#279：型錄排版下，字元間隙被拉寬或數字字型窄，舊邏輯把空白補進字中間。

// gl 與 glyphs 相同，但可指定字距（gap）與逐字寬度規則。
func glTracked(text string, x, y, sz, gap float64, widthOf func(r rune) float64) []pdfTextRect {
	var out []pdfTextRect
	for _, r := range text {
		w := widthOf(r)
		if r != ' ' {
			out = append(out, pdfTextRect{Text: string(r), Left: x, Right: x + w, Top: y + sz*0.8, Bottom: y - sz*0.2, Size: sz})
		}
		if r == ' ' {
			x += sz * 0.28
			continue
		}
		x += w + gap
	}
	return out
}

func cellsOf(t *testing.T, rs []pdfTextRect) [][]string {
	t.Helper()
	var rows [][]string
	for _, r := range clusterRows(rs) {
		var cs []string
		for _, c := range r.cells {
			cs = append(cs, c.text)
		}
		rows = append(rows, cs)
	}
	return rows
}

func TestClusterRows_數字1的墨跡窄不補空白(t *testing.T) {
	// 等寬數字字型：「1」墨跡窄 → 它右邊量出約 0.3 倍字級的間隙
	narrow := func(r rune) float64 {
		if r == '1' {
			return 12 * 0.2
		}
		return 12 * 0.5
	}
	build := func(text string) []pdfTextRect {
		var out []pdfTextRect
		x := 100.0
		for _, r := range text {
			w := narrow(r)
			out = append(out, pdfTextRect{Text: string(r), Left: x, Right: x + w, Top: 109.6, Bottom: 97.6, Size: 12})
			if r == '1' {
				x += w + 12*0.3
			} else {
				x += w + 0.3
			}
		}
		return out
	}
	for _, want := range []string{"10,000", "Ø125", "24/24/15"} {
		rows := cellsOf(t, build(want))
		if len(rows) != 1 || len(rows[0]) != 1 || rows[0][0] != want {
			t.Errorf("應逐字還原 %q，實得 %v", want, rows)
		}
	}
}

func TestClusterRows_字距加寬的英文不拆字但詞間空白留著(t *testing.T) {
	w := func(r rune) float64 { return 6 }
	// tracking：每個字之間 2.4 點（0.2 倍字級），詞間空白再加
	rs := glTracked("Z-axis Adopt Box Guideway", 60, 700, 12, 2.6, w)
	rows := cellsOf(t, rs)
	if len(rows) != 1 || len(rows[0]) != 1 || rows[0][0] != "Z-axis Adopt Box Guideway" {
		t.Fatalf("應為 Z-axis Adopt Box Guideway，實得 %q", rows)
	}
}

func TestSuspectSplitCell_殘留的拆字寧可標無法逐字抽取(t *testing.T) {
	for _, bad := range []string{"Z- axi s Ad o pt B ox G u i d eway", "1 0,000", "Ø1 25", "24 / 24 / 1 5"} {
		if !suspectSplitCell(bad) {
			t.Errorf("%q 該被判為疑似拆字", bad)
		}
	}
	for _, ok := range []string{"10,000", "Ø125", "24 / 24 / 15", "5,000 / 6,000", "Z-axis Adopt Box Guideway", "X-axis travel", "E"} {
		if suspectSplitCell(ok) {
			t.Errorf("%q 不該被判為疑似拆字", ok)
		}
	}
}

func TestBuildTextTable_殘留拆字的格輸出無法逐字抽取不輸出錯字串(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	rowsIn := [][3]string{
		{"Item", "Unit", "Value"},
		{"X-axis", "mm", "1 0,000"},
		{"Y-axis", "mm", "3,000"},
		{"Spindle", "rpm", "24,000"},
	}
	for _, r := range rowsIn {
		rs = append(rs, cat(glyphs(r[0], 60, y, 12), glyphs(r[1], 330, y, 12), glyphs(r[2], 430, y, 12))...)
		y -= 16
	}
	tabs := detectTextTables(1, rs)
	if len(tabs) != 1 {
		t.Fatalf("應有 1 張表，實得 %d", len(tabs))
	}
	if got := tabs[0].Rows[1][2]; got != cellUnreadable {
		t.Errorf("疑似拆字的格應標 %q，實得 %q", cellUnreadable, got)
	}
	if got := tabs[0].Rows[2][2]; got != "3,000" {
		t.Errorf("正常格要原樣，實得 %q", got)
	}
}

func TestDetectTextTables_左右並排的兩張表要分開不混成同一列(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	left := [][2]string{{"Item", "Unit"}, {"X-axis travel", "mm"}, {"Y-axis travel", "mm"}, {"Z-axis travel", "mm"}}
	right := [][2]string{{"Option", "Table"}, {"Opt. E", "working table"}, {"Opt. F", "rotary table"}, {"Opt. G", "tilting table"}}
	for i := range left {
		rs = append(rs, cat(glyphs(left[i][0], 40, y, 10), glyphs(left[i][1], 130, y, 10),
			glyphs(right[i][0], 320, y, 10), glyphs(right[i][1], 380, y, 10))...)
		y -= 14
	}
	tabs := detectTextTables(7, rs)
	if len(tabs) != 2 {
		t.Fatalf("左右並排應切成 2 張表，實得 %d：%+v", len(tabs), tabs)
	}
	if len(tabs[0].Rows[1]) != 2 || tabs[0].Rows[1][0] != "X-axis travel" || tabs[0].Rows[1][1] != "mm" {
		t.Errorf("左表第 2 列不對：%v", tabs[0].Rows[1])
	}
	if len(tabs[1].Rows[1]) != 2 || tabs[1].Rows[1][0] != "Opt. E" || tabs[1].Rows[1][1] != "working table" {
		t.Errorf("右表第 2 列不對：%v", tabs[1].Rows[1])
	}
}

func TestDetectTextTables_欄距相近的多欄表不被當成並排(t *testing.T) {
	var rs []pdfTextRect
	y := 700.0
	rows := [][4]string{{"Spec", "Unit", "Model A", "Model B"}, {"X-axis", "mm", "2,000", "3,000"}, {"Y-axis", "mm", "1,500", "2,500"}, {"Z-axis", "mm", "1,250", "1,250"}}
	for _, r := range rows {
		rs = append(rs, cat(glyphs(r[0], 40, y, 10), glyphs(r[1], 160, y, 10), glyphs(r[2], 260, y, 10), glyphs(r[3], 380, y, 10))...)
		y -= 14
	}
	tabs := detectTextTables(2, rs)
	if len(tabs) != 1 || len(tabs[0].Rows[1]) != 4 || tabs[0].Rows[1][3] != "3,000" {
		t.Fatalf("四欄表不該被切開：%+v", tabs)
	}
}
