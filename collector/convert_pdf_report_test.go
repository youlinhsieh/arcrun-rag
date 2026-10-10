package collector

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

const nriPDF = "/Users/youlinhsieh/Documents/tech_projects/InkStoneCo/polaris/mira/leo-graph/assets/20221216-NRI-國際低軌通訊衛星政策與發展動向調查委辦案-期中報告書_vF_1698034343630_0.pdf"

// 判準只看結構：同頁標題＋大圖、前一頁頁尾標題＋下一頁大圖、目錄行不算標題、無標題的大圖歸「其他圖片頁」。
func TestBuildPDFReport_圖片表認法(t *testing.T) {
	pages := []pdfPageInfo{
		{Index: 0, Text: "目錄\n表 1 頻段表 ........ 3\n表 2 比較表 ........ 4"}, // 目錄：不是標題
		{Index: 1, Text: "正文一段\n表 1 頻段表\n資料來源：某某", BigImages: 2},       // 同頁標題＋圖
		{Index: 2, Text: "正文一段\n更多正文\n表 2 比較表"},                        // 標題在頁尾，圖擠到下一頁
		{Index: 3, Text: "資料來源：某某", BigImages: 1},                      // 前一頁標題的圖
		{Index: 4, Text: "這頁只有一張照片", BigImages: 1},                     // 無標題的大圖
		{Index: 5, Text: "純文字頁"},
	}
	rep := buildPDFReport(pages)
	if len(rep.ImageTables) != 2 {
		t.Fatalf("應認出 2 張圖片表，實得 %+v", rep.ImageTables)
	}
	if rep.ImageTables[0].Page != 2 || !strings.HasPrefix(rep.ImageTables[0].Caption, "表 1") {
		t.Errorf("表 1 應在 PDF 第 2 頁：%+v", rep.ImageTables[0])
	}
	if rep.ImageTables[1].Page != 4 || !strings.HasPrefix(rep.ImageTables[1].Caption, "表 2") {
		t.Errorf("表 2 的標題在前一頁，圖在 PDF 第 4 頁：%+v", rep.ImageTables[1])
	}
	if rep.ImagePages != 1 {
		t.Errorf("無標題大圖頁應為 1，實得 %d", rep.ImagePages)
	}
	notes := strings.Join(rep.Notes(), "\n")
	for _, want := range []string{"2 張表是以圖片貼入", "PDF 第 4 頁", "不要憑空補數字", "1 頁含大張圖片"} {
		if !strings.Contains(notes, want) {
			t.Errorf("說明缺 %q：\n%s", want, notes)
		}
	}
}

func TestBuildPDFReport_同一標題不配兩張圖(t *testing.T) {
	pages := []pdfPageInfo{
		{Index: 0, Text: "x\n表 1 某表"},
		{Index: 1, Text: "", BigImages: 1},
		{Index: 2, Text: "", BigImages: 1},
	}
	rep := buildPDFReport(pages)
	if len(rep.ImageTables) != 1 || rep.ImagePages != 1 {
		t.Errorf("標題只配第一張圖，第二張算其他圖片頁：%+v", rep)
	}
}

func TestBuildPDFReport_沒有大圖就沒有清單(t *testing.T) {
	rep := buildPDFReport([]pdfPageInfo{{Index: 0, Text: "表 1 某表\n內容"}, {Index: 1, Text: "內容"}})
	if !rep.Empty() || rep.Notes() != nil {
		t.Errorf("純文字 PDF 不該有任何讀不到的說明：%+v", rep)
	}
	var nilRep *PDFReadReport
	if nilRep.Notes() != nil || !nilRep.Empty() {
		t.Error("nil 盤點必須安全（非 PDF 檔沒有盤點）")
	}
}

func TestBuildPDFReport_點名上限(t *testing.T) {
	var pages []pdfPageInfo
	for i := 0; i < 40; i++ {
		pages = append(pages, pdfPageInfo{Index: i, Text: fmt.Sprintf("表 %d 某表", i+1), BigImages: 1})
	}
	n := strings.Join(buildPDFReport(pages).Notes(), "")
	if !strings.Contains(n, "等共 40 張") {
		t.Errorf("超過上限要講總數：%s", n)
	}
}

func TestPrintedPageOffset(t *testing.T) {
	var pages []pdfPageInfo
	for i := 0; i < 20; i++ {
		txt := fmt.Sprintf("正文 %d", i)
		if i >= 8 {
			txt += fmt.Sprintf("\n%d", i-7) // 第 9 個 PDF 頁起，頁尾印刷頁碼 1,2,3…
		}
		pages = append(pages, pdfPageInfo{Index: i, Text: txt})
	}
	off, ok := printedPageOffset(pages)
	if !ok || off != 8 {
		t.Fatalf("應推出差 8，實得 %d %v", off, ok)
	}
	got := renderPDFPages(pages)
	if !strings.Contains(got, "〔PDF 第 10 頁・印刷頁 2〕") {
		t.Errorf("頁界應帶印刷頁碼：\n%s", got)
	}
	if !strings.Contains(got, "〔PDF 第 3 頁〕") {
		t.Errorf("封面段（無頁碼）只帶 PDF 頁序：\n%s", got)
	}
}

func TestPrintedPageOffset_不一致不猜(t *testing.T) {
	var pages []pdfPageInfo
	for i := 0; i < 20; i++ {
		pages = append(pages, pdfPageInfo{Index: i, Text: fmt.Sprintf("x\n%d", (i*7)%13+1)})
	}
	if _, ok := printedPageOffset(pages); ok {
		t.Error("頁尾數字對不上就不能猜印刷頁碼")
	}
}

// 🔴 頁界不能把空內容變成有內容：掃描檔必須維持 ErrNoText。
func TestRenderPDFPages_空白頁不插頁界(t *testing.T) {
	got := renderPDFPages([]pdfPageInfo{{Index: 0, Text: "  \n"}, {Index: 1, Text: ""}})
	if strings.TrimSpace(got) != "" {
		t.Errorf("全空白頁不得出現頁界：%q", got)
	}
	if strings.Contains(renderPDFPages([]pdfPageInfo{{Index: 0, Failed: true}}), "〔") {
		t.Error("讀取失敗頁只留痕跡，不插頁界")
	}
}

func TestRenderDocCard_讀不到的內容段(t *testing.T) {
	d := &wikiDoc{Card: "某報告", Gloss: "g", Created: "2026-10-10", Updated: "2026-10-10"}
	ex := &DocExtract{Summary: "s", Unreadable: []string{"本檔有 2 張表是以圖片貼入"}}
	out := renderDocCard(d, ex, []string{"概念甲"}, testOrigin())
	i, j, k := strings.Index(out, "## 重點"), strings.Index(out, "## 讀不到的內容"), strings.Index(out, "## 關聯")
	if !(i >= 0 && j > i && k > j) || !strings.Contains(out, "- 本檔有 2 張表是以圖片貼入") {
		t.Errorf("「讀不到的內容」段應在重點之後、關聯之前：\n%s", out)
	}
	if strings.Contains(renderDocCard(d, &DocExtract{Summary: "s"}, []string{"概念甲"}, testOrigin()), "讀不到的內容") {
		t.Error("沒有讀不到的東西就不該有這一段")
	}
}

// ── 真樣本（檔不在就跳過；不用自己造的）──

func TestPDF真樣本_NRI期中報告_13張圖片表全認出(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	txt, rep, err := ConvertToTextReport("nri.pdf", data)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("頁數 %d；圖片表 %d；其他圖片頁 %d", rep.Pages, len(rep.ImageTables), rep.ImagePages)
	for _, it := range rep.ImageTables {
		t.Logf("  PDF 第 %d 頁：%s", it.Page, it.Caption)
	}
	if len(rep.ImageTables) != 13 {
		t.Errorf("施工驗收標準 13/13，實得 %d", len(rep.ImageTables))
	}
	for _, want := range []string{"〔PDF 第 38 頁・印刷頁 30〕", "〔PDF 第 87 頁・印刷頁 79〕"} {
		if !strings.Contains(txt, want) {
			t.Errorf("缺頁界 %q", want)
		}
	}
	if strings.Count(txt, "〔PDF 第 ") < 230 {
		t.Errorf("240 頁的報告頁界太少：%d", strings.Count(txt, "〔PDF 第 "))
	}
}

// 通用性：非 NRI 的真文件不能被誤判（#253 c18765 施工驗收條件）。
func TestPDF真樣本_非NRI文件不誤報(t *testing.T) {
	cases := map[string]bool{ // 路徑 → 是否可能含圖片表（只檢查不 panic、輸出合理）
		"/Users/youlinhsieh/Downloads/Manus_vs_n8n_vs_OpenClaw_平台綜合對比分析報告.pdf": true,
		"/Users/youlinhsieh/Downloads/現場作業流程.pdf":                              true,
	}
	ran := 0
	for p := range cases {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		ran++
		txt, rep, err := ConvertToTextReport("x.pdf", data)
		if err != nil {
			t.Logf("%s：%v", p, err)
			continue
		}
		t.Logf("%s：%d 頁；圖片表 %d；其他圖片頁 %d；頁界 %d 個", p, rep.Pages, len(rep.ImageTables), rep.ImagePages, strings.Count(txt, "〔PDF 第 "))
		if !strings.Contains(txt, "〔PDF 第 1 頁") {
			t.Errorf("%s：缺第一頁頁界", p)
		}
	}
	if ran == 0 {
		t.Skip("無非 NRI 樣本")
	}
}

func TestPDF真樣本_掃描檔仍回ErrNoText(t *testing.T) {
	data, err := os.ReadFile("/Users/youlinhsieh/Downloads/已掃描_20260727-2302.pdf")
	if err != nil {
		t.Skip("無掃描樣本")
	}
	_, _, err = ConvertToTextReport("scan.pdf", data)
	t.Logf("掃描樣本結果：%v", err)
	if err == nil {
		t.Error("掃描檔加了頁界之後不能變成有內容")
	}
}
