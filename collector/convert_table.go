// convert_table.go — 表格類抽取（.csv / .xlsx）
//
// leo 2026-07-27 定調：
//
//	「企業的 excel 通常不會是 1 萬行，人工做不出這麼多，**但你可以轉結構資料丟進去**。」
//	「要思考 Excel 和 csv 的問題，因為**企業用很多**。」
//
// 這修正了先前「CSV 會變成數字牆、先不做」的判斷——那是拿「機器產生的百萬列資料」
// 當前提，但**人工維護的企業表格**（維修紀錄、報價單、料號表、值班表）
// 通常幾十到幾百列。實測：60 列 × 6 欄 ≈ 2,200 token，對 LLM 完全不是問題。
//
// **為什麼轉成 Markdown 表格**：LLM 對 Markdown 表格的理解遠優於 CSV 原文
//（欄位對齊、標題行明確）；且與現有 .md 卡片格式同語言，萃出來的卡自然帶得走表格。
//
// 防呆：超大表格（機器產生的那種）仍會截斷並明說截斷了——不能讓一個檔案吃掉
// 整個 context，也不能靜默丟資料（靜默是本專案一再犯的病）。
package collector

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// maxTableRows：超過就截斷。
// 依據＝人工維護的表格幾乎不會超過這個量（leo 判斷）；超過多半是機器匯出的原始資料，
// 那種東西整份塞進知識庫本來就沒意義。截斷會在輸出尾端明講。
const maxTableRows = 500

// maxCellRunes：單格過長（有人把整篇文章塞進一格）截斷，避免一格撐爆整張表。
const maxCellRunes = 500

func extractCSV(data []byte) (string, error) {
	// 去 UTF-8 BOM——Excel 另存 CSV 幾乎一定帶 BOM，不去掉第一個欄名會多出看不見的字元，
	// 導致標題對不上（實務上很常見的坑）。
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})

	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1 // 允許每列欄數不同（手工表格常見尾列缺欄）
	r.LazyQuotes = true    // 容忍不規範的引號，別為了格式潔癖整份讀不到

	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// 讀到一半壞掉：保留已讀到的部分而不是整份放棄——
			// 有內容總比沒有好，但要在輸出裡說明。
			if len(rows) == 0 {
				return "", fmt.Errorf("CSV 解析失敗：%w", err)
			}
			rows = append(rows, []string{fmt.Sprintf("（後續內容解析失敗：%v）", err)})
			break
		}
		rows = append(rows, rec)
		if len(rows) > maxTableRows {
			break
		}
	}
	return rowsToMarkdown(rows, len(rows) > maxTableRows), nil
}

// ── .xlsx ────────────────────────────────────────────────────────────────
//
// xlsx 與 docx 同為 Office Open XML（ZIP+XML），但多一層轉折：
// 字串不直接寫在儲存格裡，而是集中放在 sharedStrings.xml，儲存格用索引指過去
//（t="s" 代表這格的值是 sharedStrings 的索引）。所以要先讀字串表再讀工作表。

type xlsxSST struct {
	Items []struct {
		// <si> 底下可能是單一 <t>，也可能被拆成多個 <r><t>（同格內有不同格式時）
		T string   `xml:"t"`
		R []string `xml:"r>t"`
	} `xml:"si"`
}

// 分頁名住在 xl/workbook.xml，靠 r:id 對應到 xl/worksheets/sheetN.xml
//（對應關係在 xl/_rels/workbook.xml.rels）。
//
// **為什麼非做這個對應不可**：企業表格的分頁名本身就是語意——「維修紀錄」「報價單」
// 「2026 Q3 預算」。直接用檔名會輸出 `## sheet1`，LLM 就少掉了「這張表是什麼」的關鍵脈絡。
type xlsxWorkbook struct {
	Sheets []struct {
		Name string `xml:"name,attr"`
		// r:id 帶 namespace。Go 的 encoding/xml 用「namespace URI 空格 屬性名」比對；
		// 寫成 `xml:"id,attr"` 在有 namespace 前綴時抓不到（實測踩過）。
		ID string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	} `xml:"sheets>sheet"`
}

type xlsxRels struct {
	Rels []struct {
		ID     string `xml:"Id,attr"`
		Target string `xml:"Target,attr"`
	} `xml:"Relationship"`
}

type xlsxSheet struct {
	Rows []struct {
		Cells []struct {
			Ref   string `xml:"r,attr"`
			Type  string `xml:"t,attr"`
			Value string `xml:"v"`
			// inlineStr 形態（有些產生器不用 sharedStrings）
			IS struct {
				T string   `xml:"t"`
				R []string `xml:"r>t"`
			} `xml:"is"`
		} `xml:"c"`
	} `xml:"sheetData>row"`
}

func extractXLSX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("xlsx 解壓失敗（可能是舊版 .xls 或檔案損壞）：%w", err)
	}

	var sst xlsxSST
	var wb xlsxWorkbook
	var rels xlsxRels
	sheets := map[string][]byte{}
	for _, f := range zr.File {
		switch {
		case f.Name == "xl/sharedStrings.xml":
			b, err := readZipFile(f)
			if err != nil {
				return "", err
			}
			if err := xml.Unmarshal(b, &sst); err != nil {
				return "", fmt.Errorf("讀 sharedStrings 失敗：%w", err)
			}
		case f.Name == "xl/workbook.xml":
			if b, err := readZipFile(f); err == nil {
				xml.Unmarshal(b, &wb) // 失敗只是拿不到分頁名，退回檔名，不該讓整份失敗
			}
		case f.Name == "xl/_rels/workbook.xml.rels":
			if b, err := readZipFile(f); err == nil {
				xml.Unmarshal(b, &rels)
			}
		case strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml"):
			b, err := readZipFile(f)
			if err != nil {
				return "", err
			}
			sheets[f.Name] = b
		}
	}

	// r:id → 檔案路徑 → 使用者取的分頁名。
	//
	// ⚠️ Target 有兩種寫法，兩種都要吃（openpyxl 用前者、Excel 常用後者，實測踩過）：
	//   絕對：/xl/worksheets/sheet1.xml   → 去掉開頭的 / 就是 zip 內路徑
	//   相對：worksheets/sheet1.xml       → 相對於 xl/，要補前綴
	relTarget := map[string]string{}
	for _, r := range rels.Rels {
		t := r.Target
		if strings.HasPrefix(t, "/") {
			t = strings.TrimPrefix(t, "/")
		} else if !strings.HasPrefix(t, "xl/") {
			t = "xl/" + t
		}
		relTarget[r.ID] = t
	}
	sheetNames := map[string]string{}
	for _, s := range wb.Sheets {
		if p, ok := relTarget[s.ID]; ok && s.Name != "" {
			sheetNames[p] = s.Name
		}
	}
	if len(sheets) == 0 {
		return "", fmt.Errorf("xlsx 找不到任何工作表")
	}

	// 字串表攤平成 []string 供索引
	strs := make([]string, 0, len(sst.Items))
	for _, si := range sst.Items {
		if si.T != "" {
			strs = append(strs, si.T)
		} else {
			strs = append(strs, strings.Join(si.R, ""))
		}
	}

	// 多工作表都輸出，各自標名稱——企業表格常一個檔多個分頁，只取第一頁會漏資料。
	names := sortedKeys(sheets)
	var out strings.Builder
	for _, name := range names {
		var sh xlsxSheet
		if err := xml.Unmarshal(sheets[name], &sh); err != nil {
			continue // 單一工作表壞掉不該讓整份失敗
		}
		var rows [][]string
		truncated := false
		for _, r := range sh.Rows {
			if len(rows) >= maxTableRows {
				truncated = true
				break
			}
			var row []string
			for _, c := range r.Cells {
				row = append(row, xlsxCellText(c.Type, c.Value, strings.Join(append([]string{c.IS.T}, c.IS.R...), ""), strs))
			}
			rows = append(rows, row)
		}
		if len(rows) == 0 {
			continue
		}
		// 分頁名優先用使用者取的（「維修紀錄」），拿不到才退回檔名（sheet1）。
		// 單一工作表也標名稱——那個名字常常就是這張表的主題，對萃卡很有用。
		title := sheetNames[name]
		if title == "" {
			title = sheetTitle(name)
		}
		out.WriteString("\n## " + title + "\n\n")
		out.WriteString(rowsToMarkdown(rows, truncated))
		out.WriteString("\n")
	}
	return out.String(), nil
}

func xlsxCellText(typ, val, inline string, strs []string) string {
	if inline != "" {
		return inline
	}
	if typ == "s" { // sharedStrings 索引
		if i, err := strconv.Atoi(val); err == nil && i >= 0 && i < len(strs) {
			return strs[i]
		}
		return ""
	}
	return val
}

func readZipFile(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("讀 %s 失敗：%w", f.Name, err)
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func sortedKeys(m map[string][]byte) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	// sheet1, sheet2… 字串排序即可（sheet10 會排在 sheet2 前，可接受）
	for i := 0; i < len(ks); i++ {
		for j := i + 1; j < len(ks); j++ {
			if ks[j] < ks[i] {
				ks[i], ks[j] = ks[j], ks[i]
			}
		}
	}
	return ks
}

func sheetTitle(path string) string {
	n := strings.TrimSuffix(strings.TrimPrefix(path, "xl/worksheets/"), ".xml")
	return n
}

// rowsToMarkdown 把二維字串轉成 Markdown 表格。
// 第一列當標題（企業表格慣例）；只有一列時就不畫分隔線。
func rowsToMarkdown(rows [][]string, truncated bool) string {
	if len(rows) == 0 {
		return ""
	}
	width := 0
	for _, r := range rows {
		if len(r) > width {
			width = len(r)
		}
	}
	var b strings.Builder
	for i, r := range rows {
		b.WriteString("|")
		for c := 0; c < width; c++ {
			cell := ""
			if c < len(r) {
				cell = clampCell(r[c])
			}
			b.WriteString(" " + cell + " |")
		}
		b.WriteString("\n")
		if i == 0 && len(rows) > 1 {
			b.WriteString("|")
			for c := 0; c < width; c++ {
				b.WriteString(" --- |")
			}
			b.WriteString("\n")
		}
	}
	if truncated {
		// 明說截斷——靜默丟資料是本專案一再犯的病
		b.WriteString(fmt.Sprintf("\n（表格過大，只取前 %d 列）\n", maxTableRows))
	}
	return b.String()
}

// clampCell 清掉會破壞 Markdown 表格的字元，並限制單格長度。
func clampCell(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|") // 跳脫，否則欄位會錯位
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.TrimSpace(s)
	rs := []rune(s)
	if len(rs) > maxCellRunes {
		return string(rs[:maxCellRunes]) + "…（截斷）"
	}
	return s
}
