// convert_pdf_list.go — PDF 文字層裡的條列段落（標準配備、選配、隨機文件……）逐字存進文件卡
// （inkstone/arcrun-rag#277，母票 #269）。
//
// 為什麼要有這一層：#253 只替「表格」開了零 LLM 的原文路。型錄裡的「1.4.1 Standard Configuration」
// 這種「標題＋一項一行」的條列不是表，AI 萃卡時被壓成摘要句（「具有多種選配功能，包括自動頂棚蓋、
// 油霧收集器等」），HR-520、NT-A3 這種型號原字串在庫裡一個都找不到 ⇒ 只走 MCP 的小模型組不出 BOM。
//
// 做法同 #253：機械、零 LLM、零額度，原字串＋頁碼。判準只看結構，不認領域詞：
//
//	標題行（「1.4.1 Title」「3 Title」「Title:」）＋ 連續 ≥3 行短行（每行一項），遇到下一個標題或長句（散文）就收。
//
// 不做的事（誠實列出）：跨頁延續的條列（下一頁開頭沒有標題的項目不收）、巢狀縮排的層級、
// 版面是表格的頁（那是 convert_pdf_table.go 的事，這裡偵測到「多數行是表格儲存格」就讓出）。
package collector

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// PDFTextList＝文字層裡還原出來的一段條列：標題＋逐行原字串。
type PDFTextList struct {
	Page    int      // PDF 頁序，1 起算
	Heading string   // 標題行原字串（例：「1.4.1 Standard Configuration」）
	Items   []string // 每行一項，已去頭尾空白、壓成單一空白
}

const (
	minListItems       = 3   // 至少幾項才算條列
	maxListItemRunes   = 120 // 單行超過這個長度＝散文，不是條列項
	maxListMeanRunes   = 70  // 平均每項超過這個長度＝散文
	listSentenceFrac   = 40  // 句點結尾的行佔 ≥40%＝散文
	maxListHeadRunes   = 80
	listItemsPerBlock  = 40
	maxListBlocks      = 20
	maxListItemsPerDoc = 600
	// 同一行字出現在 ≥3 頁且 ≥50% 的頁＝頁首頁尾（文件名、公司名），不是內容。
	runningLineMinPages = 3
)

var (
	// 「1.4.1 Title」：至少一層點號 ⇒ 一定是標題。
	dottedHeadRe = regexp.MustCompile(`^(\d+(?:[.．]\d+)+)[.)]?\s+(\S.*)$`)
	// 「3 Title」：單層數字，可能是標題也可能是編號項目，見 splitLists 的接續判斷。
	singleHeadRe = regexp.MustCompile(`^(\d{1,3})[.)]?\s+(\S.*)$`)
	// 「Standard Configuration:」：無編號、冒號結尾的短行。
	colonHeadRe = regexp.MustCompile(`^[^:：]{2,60}[:：]$`)
)

func hasLetter(s string) bool { return strings.IndexFunc(s, unicode.IsLetter) >= 0 }

func endsSentence(s string) bool {
	return strings.HasSuffix(s, "。") || strings.HasSuffix(s, ".") && !strings.HasSuffix(s, "..") && len([]rune(s)) > 40
}

// runningLines 找出每頁都出現的頁首頁尾行。
func runningLines(pages []pdfPageInfo) map[string]bool {
	count := map[string]int{}
	for _, p := range pages {
		seen := map[string]bool{}
		for _, ln := range strings.Split(p.Text, "\n") {
			ln = cleanCellText(ln)
			if ln != "" && !seen[ln] {
				seen[ln] = true
				count[ln]++
			}
		}
	}
	out := map[string]bool{}
	for ln, n := range count {
		if n >= runningLineMinPages && n*2 >= len(pages) {
			out[ln] = true
		}
	}
	return out
}

// tableCellSet：該頁已還原成表的儲存格字串（≥2 字），用來讓出表格頁。
func tableCellSet(tabs []PDFTextTable) map[string]bool {
	m := map[string]bool{}
	for _, t := range tabs {
		for _, r := range t.Rows {
			for _, c := range r {
				if len([]rune(c)) >= 2 {
					m[c] = true
				}
			}
		}
		// 曲線圖的座標刻度表格層不收，但這些字不能因此漏進段落（#280 c21938）
		for _, c := range t.ChartDroppedTexts {
			if len([]rune(c)) >= 2 {
				m[c] = true
			}
		}
	}
	return m
}

func tabularLine(line string, cells map[string]bool) bool {
	if len(cells) == 0 {
		return false
	}
	hit := 0
	for c := range cells {
		if strings.Contains(line, c) {
			hit++
			if hit >= 2 {
				return true
			}
		}
	}
	return false
}

// detectTextLists 從一頁的純文字還原條列段落。純函式，不碰 PDFium。
func detectTextLists(page int, text string, skip map[string]bool, tables []PDFTextTable) []PDFTextList {
	lists, _, _ := scanPageLists(page, text, skip, tables)
	return lists
}

// scanPageLists＝detectTextLists 的本體，多回「這頁清理後的每一行」與「哪幾行已被收進條列」，
// 給一般段落（convert_pdf_para.go）用：條列、表格沒收的字，就是段落要收的字。
// lines 裡的空字串＝原稿的空行（段落分隔）；頁首頁尾與頁碼行不進 lines。
func scanPageLists(page int, text string, skip map[string]bool, tables []PDFTextTable) (out []PDFTextList, lines []string, consumed []bool) {
	cells := tableCellSet(tables)
	var cur *PDFTextList
	var curIdx []int // cur 的標題與各項在 lines 裡的位置
	lastNum := 0     // 目前這段裡「單層數字開頭」的項目已走到幾號
	flush := func() {
		if cur == nil {
			return
		}
		if l, ok := acceptList(*cur, cells); ok {
			out = append(out, l)
			for _, i := range curIdx {
				consumed[i] = true
			}
		}
		cur = nil
		curIdx = nil
	}
	push := func(ln string) int {
		lines = append(lines, ln)
		consumed = append(consumed, false)
		return len(lines) - 1
	}
	open := func(h string, idx int) {
		flush()
		cur = &PDFTextList{Page: page, Heading: h}
		curIdx = []int{idx}
		lastNum = 0
	}
	for _, raw := range strings.Split(text, "\n") {
		ln := cleanCellText(raw)
		if ln == "" {
			if n := len(lines); n > 0 && lines[n-1] != "" {
				push("")
			}
			continue
		}
		if skip[ln] || footerNumRe.MatchString(ln) {
			continue
		}
		idx := push(ln)
		runes := len([]rune(ln))
		isHead := false
		if runes <= maxListHeadRunes && hasLetter(ln) && !endsSentence(ln) {
			switch {
			case dottedHeadRe.MatchString(ln):
				isHead = true
			case colonHeadRe.MatchString(ln):
				isHead = true
			default:
				if m := singleHeadRe.FindStringSubmatch(ln); m != nil {
					n, _ := strconv.Atoi(m[1])
					// 接續目前這段的編號項目（1,2,3…）不是標題；其餘單層數字開頭才當標題
					continues := cur != nil && n == lastNum+1
					isHead = !continues
				}
			}
		}
		if isHead {
			open(ln, idx)
			continue
		}
		if cur == nil {
			continue
		}
		if runes > maxListItemRunes {
			flush() // 長句＝散文，條列到此為止
			continue
		}
		if m := singleHeadRe.FindStringSubmatch(ln); m != nil {
			if n, _ := strconv.Atoi(m[1]); n == lastNum+1 {
				lastNum = n
			}
		}
		cur.Items = append(cur.Items, ln)
		curIdx = append(curIdx, idx)
	}
	flush()
	return out, lines, consumed
}

var (
	numberedItemRe = regexp.MustCompile(`^(?:\d{1,3}[.)]|\(\d{1,3}\))\s*\S`)
	bareNumberRe   = regexp.MustCompile(`^(?:\d{1,3}[.)]|\(\d{1,3}\))$`)
)

// mergeWrapped：編號條列（過半的行以「1.」「(1)」開頭）裡，沒編號的行是上一項折行的下半段，
// 「(6)」這種孤立編號行是下一行的前綴 ⇒ 併回同一項（以單一空白相接），項號才對得上原稿。
// 不是編號條列就原樣回傳。原字串一字不改，只是少切一刀。
func mergeWrapped(items []string) []string {
	numbered := 0
	for _, it := range items {
		if numberedItemRe.MatchString(it) || bareNumberRe.MatchString(it) {
			numbered++
		}
	}
	if numbered*2 < len(items) {
		return items
	}
	var out []string
	pendingBare := ""
	for _, it := range items {
		switch {
		case bareNumberRe.MatchString(it):
			pendingBare = it
		case pendingBare != "":
			out = append(out, pendingBare+" "+it)
			pendingBare = ""
		case numberedItemRe.MatchString(it) || len(out) == 0:
			out = append(out, it)
		default:
			out[len(out)-1] += " " + it
		}
	}
	if pendingBare != "" {
		out = append(out, pendingBare)
	}
	return out
}

// acceptList：項數、散文、表格三道檢查。
func acceptList(l PDFTextList, cells map[string]bool) (PDFTextList, bool) {
	if len(l.Items) < minListItems {
		return l, false
	}
	total, sentences, tabular := 0, 0, 0
	for _, it := range l.Items {
		total += len([]rune(it))
		if endsSentence(it) {
			sentences++
		}
		if tabularLine(it, cells) {
			tabular++
		}
	}
	n := len(l.Items)
	if total/n > maxListMeanRunes || sentences*100 >= listSentenceFrac*n || tabular*2 >= n {
		return l, false
	}
	l.Items = mergeWrapped(l.Items)
	return l, true
}

// detectAllLists：整份文件逐頁偵測。
func detectAllLists(pages []pdfPageInfo) []PDFTextList {
	skip := runningLines(pages)
	var out []PDFTextList
	for _, p := range pages {
		if p.Failed {
			continue
		}
		out = append(out, detectTextLists(p.Index+1, p.Text, skip, p.Tables)...)
	}
	return out
}

// listsGroup＝條列段在 VerbatimSection.Group 的值；空字串＝表格。
const listsGroup = "lists"

// verbatimListsHeading＝文件卡裡條列這一段的 H2 標題。
const verbatimListsHeading = "原文條列"

// renderVerbatimLists 把條列整成卡上的段落：每份條列一段（太長才切），每項寫成「第 N 項｜原字串」。
// 回傳段落與「因上限沒收的項數」。
func renderVerbatimLists(lists []PDFTextList, printed func(page int) string) ([]VerbatimSection, int) {
	var out []VerbatimSection
	budget := maxListItemsPerDoc
	dropped := 0
	for _, l := range lists {
		items := l.Items
		if len(items) > budget {
			dropped += len(items) - budget
			items = items[:budget]
		}
		if len(items) == 0 {
			continue
		}
		budget -= len(items)
		where := fmt.Sprintf("PDF 第 %d 頁", l.Page)
		if p := printed(l.Page); p != "" {
			where += "・印刷頁 " + p
		}
		for start, part := 0, 1; start < len(items); start, part = start+listItemsPerBlock, part+1 {
			end := start + listItemsPerBlock
			if end > len(items) {
				end = len(items)
			}
			title := fmt.Sprintf("%s的條列：%s", where, l.Heading)
			if len(items) > listItemsPerBlock {
				title = fmt.Sprintf("%s（第 %d 段）", title, part)
			}
			var b strings.Builder
			if part > 1 {
				b.WriteString("（接上段）" + l.Heading + "\n")
			}
			for i := start; i < end; i++ {
				fmt.Fprintf(&b, "第 %d 項｜%s\n", i+1, items[i])
			}
			out = append(out, VerbatimSection{Title: title, Body: strings.TrimRight(b.String(), "\n"), Group: listsGroup})
		}
	}
	if len(out) > maxListBlocks {
		for _, v := range out[maxListBlocks:] {
			dropped += strings.Count(v.Body, "\n第 ") + 1
		}
		out = out[:maxListBlocks]
	}
	return out, dropped
}

// imageReadGroup＝讀圖辨識文字在 VerbatimSection.Group 的值。
const imageReadGroup = "imageread"

// verbatimImageReadHeading＝文件卡裡讀圖文字這一段的 H2 標題。
const verbatimImageReadHeading = "讀圖原文"

const maxImageReadRunesPerPage = 8000 // 單頁辨識文字上限，超過截斷並明講（卡片大小、D1 寫入）

// renderImageReads：每個讀成功的圖片頁一段，辨識文字原樣放，不經 LLM。
func renderImageReads(reads []ImagePageRead, printed func(page int) string) []VerbatimSection {
	var out []VerbatimSection
	for _, r := range reads {
		txt := strings.TrimSpace(r.Text)
		if txt == "" {
			continue
		}
		where := fmt.Sprintf("PDF 第 %d 頁", r.Page)
		if p := printed(r.Page); p != "" {
			where += "・印刷頁 " + p
		}
		title := where + "的圖片辨識文字"
		if r.Flagged {
			title += "（需人工確認）"
		}
		if rs := []rune(txt); len(rs) > maxImageReadRunesPerPage {
			txt = string(rs[:maxImageReadRunesPerPage]) + fmt.Sprintf("\n（以下約 %d 字因超過單頁上限未收入，請查原檔）", len(rs)-maxImageReadRunesPerPage)
		}
		out = append(out, VerbatimSection{Title: title, Body: txt, Group: imageReadGroup})
	}
	return out
}
