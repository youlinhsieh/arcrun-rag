// convert_pdf_para.go — 一般段落（散文）也逐字存進文件卡「原文段落」段（inkstone/arcrun-rag#277 下一刀，
// A/B 重測 L7：arcrun-rag#280 c21809）。
//
// 為什麼要有這一層：#253 的表格、#277 的條列都有零 LLM 的原文路，但兩者之外的字——主軸說明、熱流控制、
// 安全規範、合約條款、論文方法段、會議紀錄的敘述——只剩 AI 摘要。條列偵測把「句子長」的段落判成散文丟掉
// （acceptList），丟掉之後就沒有任何一層收它 ⇒ 只讀卡的小模型答不出「Dynamic Anti-Collision 是什麼」。
//
// 做法：表格、條列都沒收的字，就是段落要收的字。判準只看結構（標題行、空行、被表格／條列收走的行），
// 不認領域詞，也不認檔名。逐頁：標題行起新段，空行與被收走的行切斷段落，段內折行以單一空白併回（CJK 之間不補空白），
// 原字串一字不改。
//
// 純文字檔（.md/.txt/.rst…）沒有頁、也沒有文字層可還原：以空行切段，段內換行原樣保留（markdown 語法原樣）。
//
// 不做的事（誠實列出）：頁首頁尾與頁碼行不收；被判成表格儲存格的行不收（那是原文表格的事）；
// 文字層被拆成單字元的頁（#274）整頁不收，不放半對半錯的字；單份文件超過字數上限的部分不收、卡上明講。
package collector

import (
	"fmt"
	"strings"
	"unicode"
)

// PDFTextParagraph＝一段原文。Page=0 表示來源沒有頁（純文字檔）。
type PDFTextParagraph struct {
	Page    int
	Heading string // 標題行原字串；沒有標題的段落為空
	Text    string // 內文（段內折行已併回）；純文字檔則保留原換行
}

const (
	// paragraphsGroup＝段落在 VerbatimSection.Group 的值。
	paragraphsGroup = "paragraphs"
	// verbatimParagraphsHeading＝文件卡裡段落這一段的 H2 標題。
	verbatimParagraphsHeading = "原文段落"

	// 一個標題段＝雲端一個 block＝一次寫入（D1 一列）。每塊字數與整份上限都要卡，
	// 卡片太大會撞上 MCP 回應上限（~64KB，見 wiki/mistakes.md），所以整份上限留在 48KB 以內。
	paraRunesPerBlock   = 2500
	maxParaRunesPerDoc  = 24000
	maxParaBlocksPerDoc = 30
)

func isCJKRune(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) ||
		(r >= 0x3000 && r <= 0x303F) || (r >= 0xFF00 && r <= 0xFFEF)
}

// joinWrapped 把折行的下半段併回上半段：兩邊都是 CJK 就直接相接，其餘補一個空白。
func joinWrapped(a, b string) string {
	if a == "" {
		return b
	}
	ra := []rune(a)
	rb := []rune(b)
	if isCJKRune(ra[len(ra)-1]) && isCJKRune(rb[0]) {
		return a + b
	}
	return a + " " + b
}

// shatteredLines：文字層被拆成單字元的頁（#274）——一半以上的行 ≤2 字且行數夠多，整頁不可信。
func shatteredLines(lines []string) bool {
	n, tiny := 0, 0
	for _, ln := range lines {
		if ln == "" {
			continue
		}
		n++
		if len([]rune(ln)) <= 2 {
			tiny++
		}
	}
	return n >= 20 && tiny*2 >= n
}

func isParaHeading(ln string) bool {
	if len([]rune(ln)) > maxListHeadRunes || !hasLetter(ln) || endsSentence(ln) {
		return false
	}
	return dottedHeadRe.MatchString(ln) || colonHeadRe.MatchString(ln) || singleHeadRe.MatchString(ln)
}

// detectParagraphs 從一頁的純文字還原段落：條列與表格沒收走的字。純函式，不碰 PDFium。
func detectParagraphs(page int, text string, skip map[string]bool, tables []PDFTextTable) []PDFTextParagraph {
	_, lines, consumed := scanPageLists(page, text, skip, tables)
	if shatteredLines(lines) {
		return nil
	}
	for _, t := range tables {
		if t.Garbled {
			return nil // 同頁有表被認定拆碎＝該頁文字層不可信（#274）
		}
	}
	cells := tableCellSet(tables)
	var out []PDFTextParagraph
	var cur *PDFTextParagraph
	flush := func() {
		if cur != nil && (cur.Heading != "" || cur.Text != "") {
			out = append(out, *cur)
		}
		cur = nil
	}
	for i, ln := range lines {
		// 目錄行（結尾一串點線＋頁碼）是版面的索引，不是內容；它的標題本文在各章節裡已逐字收了
		if ln == "" || consumed[i] || cells[ln] || tabularLine(ln, cells) || tocTailRe.MatchString(ln) {
			flush()
			continue
		}
		if isParaHeading(ln) {
			flush()
			cur = &PDFTextParagraph{Page: page, Heading: ln}
			continue
		}
		if cur == nil {
			cur = &PDFTextParagraph{Page: page}
		}
		cur.Text = joinWrapped(cur.Text, ln)
	}
	flush()
	return out
}

// detectAllParagraphs：整份文件逐頁偵測。
func detectAllParagraphs(pages []pdfPageInfo) []PDFTextParagraph {
	skip := runningLines(pages)
	var out []PDFTextParagraph
	for _, p := range pages {
		if p.Failed {
			continue
		}
		out = append(out, detectParagraphs(p.Index+1, p.Text, skip, p.Tables)...)
	}
	return out
}

// detectTextParagraphs：純文字檔以空行切段，段內換行原樣保留。
func detectTextParagraphs(text string) []PDFTextParagraph {
	var out []PDFTextParagraph
	for _, blk := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		blk = strings.TrimSpace(blk)
		if blk == "" {
			continue
		}
		out = append(out, PDFTextParagraph{Text: blk})
	}
	return out
}

// plainTextReport 給純文字檔（沒有 PDF 盤點）一份只帶「原文段落」的盤點，讓它也走原文保留。
// 已經有盤點（PDF）就原樣回傳。
func plainTextReport(rep *PDFReadReport, srcText string) *PDFReadReport {
	if rep != nil {
		return rep
	}
	paras := detectTextParagraphs(srcText)
	if len(paras) == 0 {
		return nil
	}
	return &PDFReadReport{TextParagraphs: paras}
}

// splitRunes 把過長的一段在空白（或 CJK 邊界）處切成每塊 ≤n 字。
func splitRunes(s string, n int) []string {
	rs := []rune(s)
	var out []string
	for len(rs) > n {
		cut := n
		for k := n; k > n*2/3; k-- {
			if unicode.IsSpace(rs[k-1]) || (k < len(rs) && isCJKRune(rs[k-1]) && isCJKRune(rs[k])) {
				cut = k
				break
			}
		}
		out = append(out, strings.TrimSpace(string(rs[:cut])))
		rs = rs[cut:]
	}
	if t := strings.TrimSpace(string(rs)); t != "" {
		out = append(out, t)
	}
	return out
}

// renderVerbatimParagraphs：每頁（或純文字檔整份）的段落合成幾塊，每塊 ≤paraRunesPerBlock 字，
// 每段寫成「第 k 段｜標題\n內文」。回傳段落與「因上限沒收的字數」。
func renderVerbatimParagraphs(paras []PDFTextParagraph, printed func(page int) string) ([]VerbatimSection, int) {
	var out []VerbatimSection
	budget := maxParaRunesPerDoc
	dropped := 0

	type unit struct {
		page int
		text string
	}
	var units []unit
	k := 0
	last := -1
	for _, p := range paras {
		if p.Page != last {
			k = 0
			last = p.Page
		}
		k++
		body := p.Text
		if p.Heading != "" && body != "" {
			body = p.Heading + "\n" + body
		} else if p.Heading != "" {
			body = p.Heading
		}
		line := fmt.Sprintf("第 %d 段｜%s", k, body)
		if rs := []rune(line); len(rs) > paraRunesPerBlock {
			for i, piece := range splitRunes(line, paraRunesPerBlock) {
				if i > 0 {
					piece = "（接上段）" + piece
				}
				units = append(units, unit{p.Page, piece})
			}
			continue
		}
		units = append(units, unit{p.Page, line})
	}

	flushPage := func(page int, items []string) {
		if len(items) == 0 {
			return
		}
		where := "原稿"
		if page > 0 {
			where = fmt.Sprintf("PDF 第 %d 頁", page)
			if pr := printed(page); pr != "" {
				where += "・印刷頁 " + pr
			}
		}
		var b strings.Builder
		runes, part := 0, 1
		emit := func() {
			if b.Len() == 0 {
				return
			}
			out = append(out, VerbatimSection{Title: fmt.Sprintf("%s的段落（第 %d 塊）", where, part), Body: strings.TrimRight(b.String(), "\n"), Group: paragraphsGroup})
			b.Reset()
			runes = 0
			part++
		}
		for _, it := range items {
			n := len([]rune(it))
			if runes > 0 && runes+n > paraRunesPerBlock {
				emit()
			}
			b.WriteString(it + "\n\n")
			runes += n
		}
		emit()
		// 只有一塊就不標「第 1 塊」
		if part == 2 {
			s := &out[len(out)-1]
			s.Title = strings.TrimSuffix(s.Title, "（第 1 塊）")
		}
	}

	var pageItems []string
	curPage := -1
	for _, u := range units {
		n := len([]rune(u.text))
		if n > budget {
			dropped += n
			continue
		}
		budget -= n
		if u.page != curPage {
			flushPage(curPage, pageItems)
			pageItems = nil
			curPage = u.page
		}
		pageItems = append(pageItems, u.text)
	}
	flushPage(curPage, pageItems)

	if len(out) > maxParaBlocksPerDoc {
		for _, v := range out[maxParaBlocksPerDoc:] {
			dropped += len([]rune(v.Body))
		}
		out = out[:maxParaBlocksPerDoc]
	}
	return out, dropped
}
