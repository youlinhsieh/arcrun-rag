// convert_pdf_table.go — PDF 文字層裡的表格：用字元座標還原成「列 × 儲存格」，逐字原樣存進文件卡
// （inkstone/arcrun-rag#253，雲端總管 2026-10-14 實例：工具機規格表收進庫後，客服機器人查不到任何一列）。
//
// 為什麼要有這一層（實測，樣本＝大前科技 Machine Feature PDF，第 3–4 頁有文字層的規格表）：
//
//	PDFium 的純文字把一列抽成一行字，欄位之間只剩一個空白；整份丟給 LLM 萃卡時，
//	「禁止整句照抄原稿」的指示（extract_prompt.go）會把 40 列數值摘要成判斷句，
//	而且概念卡只落本機（direct.go：非續讀的文件只送文件卡）⇒ 雲端庫裡一列都沒有。
//	客服機器人只能透過 MCP 讀卡／搜尋，查不到 X-axis 是多少 mm、主軸轉速是多少 rpm。
//
// 這裡做的事全部是機械的、零 LLM、零額度：
//
//  1. 用 PDFium 的文字矩形（同一行、同一字型的連續字）還原列與儲存格——
//     同一行裡相鄰兩段字的間隙大於字級的 0.8 倍＝換儲存格。
//  2. 認表：連續 ≥3 列有 ≥2 個儲存格（中間允許夾最多 2 列單格的分組標題，如「Travel」「Table」）。
//     判準只看結構，不認領域詞，同 candidateRecordLabels 的原則。
//  3. 還原後的每一列逐字寫進文件卡「原文表格」段（見 renderVerbatimTables），
//     每個標題段＝雲端一個 block，所以 kbdb_search 搜得到、kbdb_get_card 讀得到。
//
// 不做的事（誠實列出）：合併儲存格的欄位對齊（分組標題獨立成一列、跨列的單位併進最近的那列）、
// 旋轉的表、圖片裡的表（那是 imageread.go 的事）。
package collector

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// pdfTextRect＝PDFium 回的一個字元（字元模式）。座標是 PDF 點，y 往上增加（Top > Bottom）。
//
// 為什麼用字元模式、不用 PDFium 的「文字矩形」模式（實測 c20342 樣本）：
// 矩形模式在字型切換處會重複吐字（「Distance between T-slot」變成「T-T-slot」、
// 「Torque」變成「ToTorque」），對「逐字原樣存」是致命的；字元模式乾淨。
type pdfTextRect struct {
	Text                     string
	Left, Right, Top, Bottom float64
	Size                     float64 // 字級；0＝PDFium 沒回
}

// PDFTextTable＝文字層裡還原出來的一張表。
type PDFTextTable struct {
	Page int // PDF 頁序，1 起算
	// Garbled＝這裡看起來有一張表，但文字層的字被拆成單字元（垂直排版、字級回報失真），還原出來的列是亂碼。
	// 不輸出亂碼，改在文件卡明說「無法逐字抽取，請查原檔」（inkstone/arcrun-rag#274）。Rows 為空。
	Garbled bool
	Caption string     // 表正上方那一行單格文字（例：「1.2 Machine Specifications」）；沒有就空
	Rows    [][]string // 每列的儲存格（已去頭尾空白）
}

// 表格判準的常數。數字都是用樣本實測定的，不是拍腦袋：
const (
	// 儲存格斷開的間隙＝字級 × 這個值。樣本裡欄間距最小約 80 點（字級 12），
	// 同一格內相鄰片段的間隙 ≤4 點；0.8 倍＝約 10 點，兩邊都離得夠遠。
	cellGapFactor = 0.8
	// 至少幾列有 ≥2 個儲存格才算表。
	minMultiRows = 3
	// 表內單格列（分組標題）最多連續幾列。
	maxSingleRun = 2
	// 相鄰兩列的垂直間距上限＝字級 × 這個值（超過＝中間有空白，不是同一張表）。
	rowPitchFactor = 3.2
	// 儲存格平均長度超過這個字數＝散文（雙欄排版的兩欄文字），不是表。
	maxMeanCellRunes = 45
	// 單張表、單份文件收進卡的列數上限（超過明說，不靜默截掉）。
	maxTableRowsPerTable  = 500
	maxVerbatimRowsPerDoc = 800
)

type tcell struct {
	text        string
	left, right float64
}

type trow struct {
	cells       []tcell
	top, bottom float64
	size        float64
}

func (r *trow) cy() float64 { return (r.top + r.bottom) / 2 }

// rowCenterTol：同一列的字，垂直中心相差不超過字級 × 這個值。
// 實測：同一列裡有升部（b、d）、降部（g、y、逗號）的字，中心最多差約 0.33 倍字級；
// 上下兩行（例：單位「rpm」與其下的「（360°/S）」）中心差 ≥0.7 倍。
const rowCenterTol = 0.45

// 字與字之間的間隙超過字級 × 這個值，就補一個空白（同一格內的詞間距約 0.25–0.35 倍）。
const wordGapFactor = 0.2

// clusterRows 把字元依垂直位置分成列（由上而下），再依水平間隙切成儲存格。
func clusterRows(rects []pdfTextRect) []*trow {
	gl := make([]pdfTextRect, 0, len(rects))
	for _, r := range rects {
		if strings.TrimSpace(r.Text) == "" || r.Top <= r.Bottom || r.Right <= r.Left {
			continue
		}
		gl = append(gl, r)
	}
	sort.SliceStable(gl, func(i, j int) bool {
		return (gl[i].Top + gl[i].Bottom) > (gl[j].Top + gl[j].Bottom)
	})
	type rowAcc struct {
		sumCy float64
		n     int
		items []pdfTextRect
	}
	sizeOf := func(r pdfTextRect) float64 {
		if r.Size > 0 {
			return r.Size
		}
		return r.Top - r.Bottom
	}
	var rows []*rowAcc
	for _, r := range gl {
		cy := (r.Top + r.Bottom) / 2
		if k := len(rows) - 1; k >= 0 {
			a := rows[k]
			if d := a.sumCy/float64(a.n) - cy; d <= rowCenterTol*sizeOf(r) && d >= -rowCenterTol*sizeOf(r) {
				a.items = append(a.items, r)
				a.sumCy += cy
				a.n++
				continue
			}
		}
		rows = append(rows, &rowAcc{sumCy: cy, n: 1, items: []pdfTextRect{r}})
	}
	out := make([]*trow, 0, len(rows))
	for _, a := range rows {
		sort.SliceStable(a.items, func(i, j int) bool { return a.items[i].Left < a.items[j].Left })
		size, top, bottom := 0.0, a.items[0].Top, a.items[0].Bottom
		for _, it := range a.items {
			if sz := sizeOf(it); sz > size {
				size = sz
			}
			if it.Top > top {
				top = it.Top
			}
			if it.Bottom < bottom {
				bottom = it.Bottom
			}
		}
		tr := &trow{top: top, bottom: bottom, size: size}
		// 先依大間隙切成儲存格（各格保留逐字元），再為每一格決定詞間空白
		var groups [][]pdfTextRect
		var prevRight float64
		for gi, it := range a.items {
			sz := sizeOf(it)
			if gi == 0 || it.Left-prevRight > cellGapFactor*sz {
				groups = append(groups, []pdfTextRect{it})
			} else {
				groups[len(groups)-1] = append(groups[len(groups)-1], it)
			}
			if gi == 0 || it.Right > prevRight {
				prevRight = it.Right
			}
		}
		rowBase := medianGap(groups...)
		for _, g := range groups {
			text, left, right := buildCellText(g, rowBase)
			tr.cells = append(tr.cells, tcell{text: text, left: left, right: right})
		}
		kept := tr.cells[:0]
		for _, c := range tr.cells {
			c.text = cleanCellText(c.text)
			if c.text != "" {
				kept = append(kept, c)
			}
		}
		tr.cells = kept
		if len(tr.cells) > 0 {
			out = append(out, tr)
		}
	}
	return out
}


// medianGap：一列（或一格）裡相鄰字元間隙的基線（下四分位數，≥0；函式名沿用 #279 的 medianGap）。字距被加寬的排版（型錄的 tracking）
// 與窄字寬的數字字型，字與字之間的「正常間隙」本來就比 0.2 倍字級大；拿中位數當基線，
// 詞間空白才不會補進字中間（inkstone/arcrun-rag#279：`1 0,000`、`Z- axi s Ad o pt`）。
func medianGap(groups ...[]pdfTextRect) float64 {
	var gaps []float64
	for _, g := range groups {
		var pr float64
		for i, it := range g {
			if i > 0 {
				if d := it.Left - pr; d > 0 {
					gaps = append(gaps, d)
				} else {
					gaps = append(gaps, 0)
				}
			}
			if i == 0 || it.Right > pr {
				pr = it.Right
			}
		}
	}
	if len(gaps) == 0 {
		return 0
	}
	sort.Float64s(gaps)
	// 取下四分位而非中位數：短格（「60 / 60 / 50」）有一半間隙是詞間空白，中位數會把詞間空白當成字距基線，
	// 空白就被吃掉（大前規格書 X/Y/Z-axis rapid feedrate 那一列）。
	return gaps[len(gaps)/4]
}

// 表格數字字型是等寬的，「1」的墨跡窄、右側留白大，量出來的間隙像詞間空白。
const narrowInkDigitGapFactor = 0.45

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// buildCellText 把一格的字元接成字串，回傳文字與左右緣。base＝該列的間隙中位數。
func buildCellText(g []pdfTextRect, base float64) (string, float64, float64) {
	if len(g) == 0 {
		return "", 0, 0
	}
	cellBase := base
	if len(g) >= 6 { // 字夠多，用本格自己的基線
		cellBase = medianGap(g)
	}
	var sb strings.Builder
	left, right := g[0].Left, g[0].Right
	prevRight := g[0].Right
	sb.WriteString(g[0].Text)
	for i := 1; i < len(g); i++ {
		it := g[i]
		sz := it.Size
		if sz <= 0 {
			sz = it.Top - it.Bottom
		}
		gap := it.Left - prevRight
		thr := wordGapFactor * sz
		// 字距被加寬的排版，字間「正常間隙」本身就大，門檻要跟著墊高；
		// 但墊太高會把正常排版的詞間空白吃掉（大前規格書：中位數 0.11 倍字級、詞間 0.28 倍，
		// 「Distance between spindle nose to table surface」整句黏成 nosetotablesurface）。
		// ⇒ 用 1.5 倍中位數＋0.05 倍字級，不是「中位數＋0.2 倍字級」。
		if cellBase > 0 {
			if adaptive := 1.5*cellBase + 0.05*sz; adaptive > thr {
				thr = adaptive
			}
		}
		if gap > thr {
			pr, nr := lastRune(sb.String()), firstRune(it.Text)
			space := needSpace(pr, nr)
			// 「1」後面接數字：墨跡窄造成的間隙，不是空白（「1 0,000」「Ø1 25」「1 5」）
			if space && pr == '1' && isDigit(nr) && gap <= narrowInkDigitGapFactor*sz {
				space = false
			}
			if space {
				sb.WriteString(" ")
			}
		}
		sb.WriteString(it.Text)
		if it.Right > right {
			right = it.Right
		}
		if it.Right > prevRight {
			prevRight = it.Right
		}
	}
	return sb.String(), left, right
}

// 抽出來仍帶字內拆字特徵的儲存格——寧可明說讀不出，也不輸出錯字串（業務會引用數字）。
const cellUnreadable = "（無法逐字抽取）"

var splitDigitRe = regexp.MustCompile(`(?:^|\s)[Ø⌀]?\d\s+\d`)

// suspectSplitCell：兩個以上單獨的小寫字母（a 除外）＝字母被空白拆開；或單一數字後面緊接數字。
func suspectSplitCell(s string) bool {
	if splitDigitRe.MatchString(s) {
		return true
	}
	singles := 0
	for _, tok := range strings.Fields(s) {
		rs := []rune(tok)
		if len(rs) == 1 && unicode.IsLower(rs[0]) && rs[0] < 0x250 && rs[0] != 'a' {
			singles++
		}
	}
	return singles >= 2
}

func lastRune(s string) rune {
	rs := []rune(s)
	if len(rs) == 0 {
		return 0
	}
	return rs[len(rs)-1]
}

func firstRune(s string) rune {
	for _, r := range s {
		return r
	}
	return 0
}

// isCJKish：中日韓字與全形標點——這些字之間不補空白（全形標點的字框自帶留白，不是詞間距）。
func isCJKish(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) ||
		(r >= 0x3000 && r <= 0x303F) || (r >= 0xFF00 && r <= 0xFFEF)
}

// needSpace：兩個字元之間的間隙夠寬時，要不要補空白。
func needSpace(prev, next rune) bool {
	if strings.ContainsRune("（([{【「『〈《", prev) || strings.ContainsRune("）)]}】」』〉》,，。、:：;；!！?？", next) {
		return false
	}
	if isCJKish(prev) && isCJKish(next) {
		return false
	}
	return true
}

// cleanCellText：與全文同一套正規化（NFKC、去控制字元），再把連續空白壓成一個。
func cleanCellText(s string) string {
	s = normalizeText(s)
	// 私用區字元（Word 項目符號 U+F0B7 之類）看不見也沒意義，丟掉
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Co, r) {
			return -1
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// detectTextTables 從一頁的文字矩形還原表格。page 為 PDF 頁序（1 起算）。純函式，不碰 PDFium。
func detectTextTables(page int, rects []pdfTextRect) []PDFTextTable {
	rects = normalizeRectSizes(rects)
	rows := clusterRows(rects)
	if len(rows) < minMultiRows {
		return nil
	}
	pitchOK := func(a, b *trow) bool {
		sz := a.size
		if b.size > sz {
			sz = b.size
		}
		return a.bottom-b.top <= rowPitchFactor*sz // 上一列底到下一列頂的距離
	}
	var out []PDFTextTable
	i := 0
	for i < len(rows) {
		if len(rows[i].cells) < 2 {
			i++
			continue
		}
		// 從第 i 列（多格）開始往下延伸
		start, last := i, i
		multi := 1
		j := i + 1
		for j < len(rows) {
			if !pitchOK(rows[j-1], rows[j]) {
				break
			}
			if len(rows[j].cells) >= 2 {
				multi++
				last = j
				j++
				continue
			}
			// 單格列：只在「後面很快又有多格列」時併入（分組標題、跨列的單位片段）
			k := j
			for k < len(rows) && len(rows[k].cells) < 2 && k-j < maxSingleRun+1 {
				if !pitchOK(rows[k-1], rows[k]) {
					k = len(rows)
					break
				}
				k++
			}
			if k < len(rows) && len(rows[k].cells) >= 2 && k-j <= maxSingleRun && pitchOK(rows[k-1], rows[k]) {
				j = k
				continue
			}
			break
		}
		if multi >= minMultiRows {
			// 往上吃：表頭常是垂直置中的多行儲存格（例：「Milling head B&C axis」「K2(A63)」「rpm」），
			// 各自落在不同的列，只有主列是多格。短行（≤40 字）、間距正常的，最多往上併 4 列。
			first := start
			for first > 0 && start-first < 4 {
				prev := rows[first-1]
				if !pitchOK(prev, rows[first]) || rowRunes(prev) > 40 {
					break
				}
				first--
			}
			region := rows[first : last+1]
			for _, sub := range splitSideBySide(region) {
				if t, ok := buildTextTable(page, sub); ok {
					if tableShattered(t) {
						out = append(out, PDFTextTable{Page: page, Garbled: true})
					} else {
						t = takeCaption(t)
						out = append(out, t)
					}
				}
			}
		}
		i = last + 1
	}
	return out
}

// offPage：字的框完全落在頁面外（含 2 點容差）。
func offPage(left, right, top, bottom, w, h float64) bool {
	const tol = 2.0
	return right < -tol || left > w+tol || top < -tol || bottom > h+tol
}

// normalizeRectSizes：有些 PDF（InDesign 輸出、字型矩陣縮放）讓 PDFium 回報字級 1.0，字框卻有 8–12 點高。
// 儲存格斷開的門檻是「字級 × 0.8」，字級失真成 1 就變成 0.8 點——每個字母之間的間隙都超過它，
// 整頁每個字元各自成格，一般橫排的內文被認成表、吐出「D｜b｜l｜C｜l｜H」（inkstone/arcrun-rag#274，Saber 型錄）。
// 字級不可能小於字框高度的 60%（小寫 x 高約為字級的 0.5–0.7，含升降部更高），小於就是失真：
// 改用本頁字框高度的第 75 百分位 × 1.3 當字級（只改失真的字，字級正常的字照舊）。
func normalizeRectSizes(rects []pdfTextRect) []pdfTextRect {
	var hs []float64
	bad := false
	for _, r := range rects {
		h := r.Top - r.Bottom
		if h <= 0 || strings.TrimSpace(r.Text) == "" {
			continue
		}
		hs = append(hs, h)
		if r.Size > 0 && r.Size < 0.6*h {
			bad = true
		}
	}
	if !bad || len(hs) == 0 {
		return rects
	}
	sort.Float64s(hs)
	est := hs[len(hs)*3/4] * 1.3 // 第 75 百分位＝大寫／升部的高度（小寫 x 高會低估）
	out := make([]pdfTextRect, len(rects))
	copy(out, rects)
	for i := range out {
		h := out[i].Top - out[i].Bottom
		// 字框矮的標點（「-」「•」「,」）自己不會觸發上面的條件，但同樣被回報成 1.0——
		// 留著 1.0 會讓這個字的列容差縮到 0.45 點、把同一行切成兩列，所以一併改用本頁估值。
		if out[i].Size > 0 && (out[i].Size < 0.6*h || out[i].Size < 0.4*est) {
			out[i].Size = est
		}
	}
	return out
}

// tableShattered：還原出來的表，大半儲存格只有一個字元＝文字層被拆碎了（垂直排版或其他失真），
// 這樣的列不是原字串。門檻：≥12 格、單字元格 ≥35%（實測：真規格表最高 25%；圖上標籤、直排拆碎的落在 37–70%）。
func tableShattered(t PDFTextTable) bool {
	n, single := 0, 0
	for _, r := range t.Rows {
		for _, c := range r {
			n++
			if len([]rune(c)) == 1 {
				single++
			}
		}
	}
	return n >= 12 && single*100 >= n*35
}

func rowRunes(r *trow) int {
	n := 0
	for _, c := range r.cells {
		n += len([]rune(c.text))
	}
	return n
}

var captionRowRe = regexp.MustCompile(`^(?:\d+(?:\.\d+)*[.．)]?|表\s*[0-9０-９]+(?:[-－.．][0-9０-９]+)*|Table\s*\d+(?:[-.]\d+)*)(?:\s|[:：.．、-])`)

// takeCaption：第一列若像標題（「1.2 Machine Specifications」「表 3 …」）就拿來當表名，從列裡拿掉
// （標題會寫在區塊標題上，一樣搜得到）。
func takeCaption(t PDFTextTable) PDFTextTable {
	if len(t.Rows) < 2 || len(t.Rows[0]) > 2 {
		return t
	}
	joined := strings.Join(t.Rows[0], " ")
	if len([]rune(joined)) > 60 || !captionRowRe.MatchString(joined+" ") {
		return t
	}
	// 標題列的最後一格若全是數字與單位（資料列），不是標題
	last := t.Rows[0][len(t.Rows[0])-1]
	if strings.IndexFunc(last, unicode.IsLetter) < 0 {
		return t
	}
	t.Caption = joined
	t.Rows = t.Rows[1:]
	return t
}

// buildTextTable 把一段列整成表：併入跨列的單位片段、檢查是不是散文。
func buildTextTable(page int, region []*trow) (PDFTextTable, bool) {
	// 第一欄的左緣＝多格列的第一格左緣的眾數（四捨五入到 2 點）
	votes := map[int]int{}
	for _, r := range region {
		if len(r.cells) >= 2 {
			votes[int(r.cells[0].left/2)]++
		}
	}
	bestK, bestN := 0, -1
	for k, n := range votes {
		if n > bestN || (n == bestN && k < bestK) {
			bestK, bestN = k, n
		}
	}
	col0 := float64(bestK) * 2
	isFirstCol := func(c tcell, sz float64) bool {
		d := c.left - col0
		if d < 0 {
			d = -d
		}
		return d <= 1.5*sz+2
	}

	// 孤立的非第一欄片段（例：單位「rpm」、「（360°/S）」被排在數值列的上下方）→ 併進最近的多格列
	type merged struct {
		row   *trow
		cells []tcell
	}
	var ms []*merged
	for _, r := range region {
		ms = append(ms, &merged{row: r, cells: append([]tcell(nil), r.cells...)})
	}
	var keep []*merged
	var frags []*merged
	for _, m := range ms {
		if len(m.cells) == 1 && !isFirstCol(m.cells[0], m.row.size) {
			frags = append(frags, m)
		} else {
			keep = append(keep, m)
		}
	}
	for _, f := range frags {
		var anchor *merged
		best := 1e18
		for _, m := range keep {
			if len(m.cells) < 2 {
				continue
			}
			d := f.row.cy() - m.row.cy()
			if d < 0 {
				d = -d
			}
			if d < best {
				best, anchor = d, m
			}
		}
		if anchor == nil || best > 2.5*anchor.row.size {
			keep = append(keep, f) // 找不到可併的列＝自成一列，不丟字
			continue
		}
		fc := f.cells[0]
		joined := false
		for ci := range anchor.cells {
			ac := &anchor.cells[ci]
			if fc.left < ac.right && fc.right > ac.left { // 同一欄（水平有重疊）
				if f.row.cy() > anchor.row.cy() {
					ac.text = fc.text + " " + ac.text
				} else {
					ac.text = ac.text + " " + fc.text
				}
				joined = true
				break
			}
		}
		if !joined {
			anchor.cells = append(anchor.cells, fc)
			sort.SliceStable(anchor.cells, func(a, b int) bool { return anchor.cells[a].left < anchor.cells[b].left })
		}
	}
	sort.SliceStable(keep, func(a, b int) bool { return keep[a].row.cy() > keep[b].row.cy() })

	t := PDFTextTable{Page: page}
	totalRunes, nCells := 0, 0
	for _, m := range keep {
		var cells []string
		for _, c := range m.cells {
			txt := cleanCellText(c.text)
			if txt == "" {
				continue
			}
			if suspectSplitCell(txt) {
				txt = cellUnreadable
			}
			cells = append(cells, txt)
			totalRunes += len([]rune(txt))
			nCells++
		}
		if len(cells) > 0 {
			t.Rows = append(t.Rows, cells)
		}
	}
	if nCells == 0 || totalRunes/nCells > maxMeanCellRunes {
		return PDFTextTable{}, false // 儲存格平均很長＝雙欄排版的散文
	}
	// 項目符號清單（「• 文字」「1. 文字」）：第一格只有符號、第二格是整句 ⇒ 是清單不是表。
	listLike, multiRows := 0, 0
	for _, r := range t.Rows {
		if len(r) >= 2 {
			multiRows++
		}
		if len(r) == 2 && len([]rune(r[0])) <= 4 && len([]rune(r[1])) >= 12 {
			listLike++
		}
	}
	if multiRows > 0 && listLike*10 >= multiRows*6 {
		return PDFTextTable{}, false
	}
	// 清單的項目符號是私用區字元，清理後第一格會變成空字串：整列只剩一格＝不是表
	if multiRows < minMultiRows {
		return PDFTextTable{}, false
	}
	return t, true
}

// VerbatimSection＝要逐字寫進文件卡的一段（標題＋內文）。內文不經 LLM。
type VerbatimSection struct {
	Title string
	Body  string
	// Group＝這一段屬於哪一組：空字串＝表格（「原文表格」段）、listsGroup＝條列（「原文條列」段，#277）。
	Group string
}

// verbatimTablesHeading＝文件卡裡這一段的 H2 標題。lint 靠它把這一段從「疑似整段照抄」的檢查裡排除
// （這一段本來就是逐字，是機器放的，不是 LLM 抄的）。
const verbatimTablesHeading = "原文表格"

// 一個標題段＝雲端一個 block＝一次寫入子請求。雲端單次呼叫的子請求有上限（#196），
// 所以一頁的表合成一段，太長才切；整份文件的列數與段數都設上限，超過明說、不靜默截掉。
const (
	verbatimRowsPerBlock = 40
	maxVerbatimBlocks    = 20
)

// renderVerbatimTables 把表整成卡上的段落：每頁一段「PDF 第 N 頁的表格」，一頁有好幾張表就依序列在同一段，
// 每列寫成「第 N 列｜儲存格｜儲存格」，N 是該表內的列號——AI 引得出「第幾頁、哪張表、第幾列」。
// 一段超過 40 列才切，切在表中間時下一段會重複表名與表頭（該表第 1 列），讓每個 block
// 單獨被搜到時也看得出欄位的意思。回傳段落與「因上限沒收的列數」。
func renderVerbatimTables(tables []PDFTextTable, printed func(page int) string) ([]VerbatimSection, int) {
	var out []VerbatimSection
	rowBudget := maxVerbatimRowsPerDoc
	dropped := 0

	byPage := map[int][]PDFTextTable{}
	var pages []int
	// 同一頁只要有一張表被認定拆碎，該頁文字層不可信：同頁其他表（常夾著亂碼或 U+FFFD）一併不輸出，
	// 業務只會看到「無法逐字抽取」的標示，不會拿到半對半錯的列（inkstone/arcrun-rag#274，Rotor 第 7、13 頁實測）。
	garbledPage := map[int]bool{}
	for _, t := range tables {
		if t.Garbled {
			garbledPage[t.Page] = true
		}
	}
	for _, t := range tables {
		if t.Garbled || garbledPage[t.Page] {
			continue
		}
		if _, ok := byPage[t.Page]; !ok {
			pages = append(pages, t.Page)
		}
		byPage[t.Page] = append(byPage[t.Page], t)
	}
	sort.Ints(pages)

	for _, pg := range pages {
		where := fmt.Sprintf("PDF 第 %d 頁", pg)
		if p := printed(pg); p != "" {
			where += "・印刷頁 " + p
		}
		var b strings.Builder
		dataRows, part := 0, 1
		flush := func(more bool) {
			if b.Len() == 0 {
				return
			}
			title := where + "的表格"
			if part > 1 || more {
				title = fmt.Sprintf("%s（第 %d 段）", title, part)
			}
			out = append(out, VerbatimSection{Title: title, Body: strings.TrimRight(b.String(), "\n")})
			b.Reset()
			dataRows = 0
			part++
		}
		for ti, t := range byPage[pg] {
			rows := t.Rows
			if len(rows) > maxTableRowsPerTable {
				dropped += len(rows) - maxTableRowsPerTable
				rows = rows[:maxTableRowsPerTable]
			}
			if len(rows) > rowBudget {
				dropped += len(rows) - rowBudget
				rows = rows[:rowBudget]
			}
			if len(rows) == 0 {
				continue
			}
			rowBudget -= len(rows)
			name := t.Caption
			if name == "" {
				name = fmt.Sprintf("表格 %d", ti+1)
			}
			head := func(repeatHeader bool) {
				fmt.Fprintf(&b, "【%s】\n", name)
				if repeatHeader {
					b.WriteString("表頭（第 1 列）：" + strings.Join(rows[0], "｜") + "\n")
				}
			}
			head(false)
			for ri, r := range rows {
				if dataRows >= verbatimRowsPerBlock {
					flush(true)
					head(ri > 0)
				}
				cells := make([]string, len(r))
				for ci, c := range r {
					cells[ci] = strings.ReplaceAll(c, "｜", "|")
				}
				fmt.Fprintf(&b, "第 %d 列｜%s\n", ri+1, strings.Join(cells, "｜"))
				dataRows++
			}
			b.WriteString("\n")
		}
		flush(false)
	}
	// 段數上限：超過的整段不收，列數併入 dropped
	if len(out) > maxVerbatimBlocks {
		for _, v := range out[maxVerbatimBlocks:] {
			dropped += strings.Count(v.Body, "\n第 ") + 1
		}
		out = out[:maxVerbatimBlocks]
	}
	return out, dropped
}

// VerbatimSections 回傳要寫進文件卡「原文表格」段的內容；沒有表就回 nil。
func (r *PDFReadReport) VerbatimSections() []VerbatimSection {
	if r == nil || (len(r.TextTables) == 0 && len(r.TextLists) == 0 && len(r.TextParagraphs) == 0 && len(r.ImageReads) == 0) {
		return nil
	}
	printed := func(p int) string {
		if r.printedOff == nil {
			return ""
		}
		if v := p - *r.printedOff; v >= 1 {
			return fmt.Sprintf("%d", v)
		}
		return ""
	}
	var secs []VerbatimSection
	if len(r.TextTables) > 0 {
		var garbledPages []string
		seen := map[int]bool{}
		for _, t := range r.TextTables {
			if t.Garbled && !seen[t.Page] {
				seen[t.Page] = true
				garbledPages = append(garbledPages, fmt.Sprintf("%d", t.Page))
			}
		}
		var dropped int
		secs, dropped = renderVerbatimTables(r.TextTables, printed)
		if dropped > 0 {
			secs = append(secs, VerbatimSection{
				Title: "未收入的表格列",
				Body:  fmt.Sprintf("另有約 %d 列因超過單份文件上限（%d 列、%d 段）未收入原文表格，請查原檔。", dropped, maxVerbatimRowsPerDoc, maxVerbatimBlocks),
			})
		}
		if len(garbledPages) > 0 {
			secs = append(secs, VerbatimSection{
				Title: "無法逐字抽取的表格",
				Body:  fmt.Sprintf("PDF 第 %s 頁疑似有表格，但文字層的字被拆成單字元，無法逐字抽取，請查原檔（不要引用這幾頁的表格數值）。", strings.Join(garbledPages, "、")),
			})
		}
	}
	if len(r.TextLists) > 0 {
		ls, dropped := renderVerbatimLists(r.TextLists, printed)
		secs = append(secs, ls...)
		if dropped > 0 {
			secs = append(secs, VerbatimSection{
				Title: "未收入的條列項",
				Body:  fmt.Sprintf("另有約 %d 項因超過單份文件上限（%d 項、%d 段）未收入原文條列，請查原檔。", dropped, maxListItemsPerDoc, maxListBlocks),
				Group: listsGroup,
			})
		}
	}
	if len(r.TextParagraphs) > 0 {
		ps, dropped := renderVerbatimParagraphs(r.TextParagraphs, printed)
		secs = append(secs, ps...)
		if dropped > 0 {
			secs = append(secs, VerbatimSection{
				Title: "未收入的段落",
				Body:  fmt.Sprintf("另有約 %d 字因超過單份文件上限（%d 字、%d 塊）未收入原文段落，請查原檔。", dropped, maxParaRunesPerDoc, maxParaBlocksPerDoc),
				Group: paragraphsGroup,
			})
		}
	}
	secs = append(secs, renderImageReads(r.ImageReads, printed)...)
	return secs
}

// stripVerbatimSection 把卡上的「原文表格」整段拿掉（回傳其餘部分）。
// 給 lint 用：這一段是機器逐字放的，不該被算進「LLM 疑似整段照抄」的相似度與落地檢查。
func stripVerbatimSection(card string) string {
	lines := strings.Split(card, "\n")
	var out []string
	skip := false
	for _, ln := range lines {
		if h2HeadingRe.MatchString(ln) {
			m := h2HeadingRe.FindStringSubmatch(ln)
			h := ""
			if m != nil {
				h = strings.TrimSpace(m[1])
			}
			skip = h == verbatimTablesHeading || h == verbatimListsHeading || h == verbatimParagraphsHeading || h == verbatimImageReadHeading
		}
		if !skip {
			out = append(out, ln)
		}
	}
	return strings.Join(out, "\n")
}

// 左右並排的兩張表（型錄常見的雙欄版面）被當成同一張表時，每一列會把兩張表的儲存格接在一起
// （inkstone/arcrun-rag#279：`X-axis travel｜mm｜5 000 / 6 000｜4,000 / 5,000 / 6,000｜E｜working table…`）。
// 判準只看結構：整個區域裡，有一條垂直走道沒有任何儲存格跨過、走道寬度遠大於其他任何欄間距，
// 且走道兩側各自都夠格成表（≥3 列有 ≥2 格）。普通多欄表的欄間距彼此接近，不會被切。
const (
	gutterVsOtherGap = 3.0 // 走道寬 ≥ 其他最寬欄間距的幾倍
	gutterMinSize    = 3.0 // 走道寬 ≥ 字級的幾倍
)

func splitSideBySide(region []*trow) [][]*trow {
	one := [][]*trow{region}
	multi := 0
	var minL, maxR, size float64
	first := true
	for _, r := range region {
		if len(r.cells) >= 2 {
			multi++
		}
		if r.size > size {
			size = r.size
		}
		for _, c := range r.cells {
			if first || c.left < minL {
				minL = c.left
			}
			if first || c.right > maxR {
				maxR = c.right
			}
			first = false
		}
	}
	if multi < minMultiRows || size <= 0 {
		return one
	}
	// 所有儲存格覆蓋區間的聯集 → 空隙
	type iv struct{ l, r float64 }
	var ivs []iv
	for _, r := range region {
		for _, c := range r.cells {
			ivs = append(ivs, iv{c.left, c.right})
		}
	}
	sort.Slice(ivs, func(i, j int) bool { return ivs[i].l < ivs[j].l })
	var gaps []iv
	curR := ivs[0].r
	for _, v := range ivs[1:] {
		if v.l > curR {
			gaps = append(gaps, iv{curR, v.l})
		}
		if v.r > curR {
			curR = v.r
		}
	}
	if len(gaps) < 2 {
		return one
	}
	best, second := 0, -1
	for i := range gaps {
		if gaps[i].r-gaps[i].l > gaps[best].r-gaps[best].l {
			best = i
		}
	}
	for i := range gaps {
		if i != best && (second < 0 || gaps[i].r-gaps[i].l > gaps[second].r-gaps[second].l) {
			second = i
		}
	}
	w := gaps[best].r - gaps[best].l
	if w < gutterMinSize*size || w < gutterVsOtherGap*(gaps[second].r-gaps[second].l) {
		return one
	}
	mid := (gaps[best].l + gaps[best].r) / 2
	var left, right []*trow
	lm, rm := 0, 0
	for _, r := range region {
		lr, rr := &trow{top: r.top, bottom: r.bottom, size: r.size}, &trow{top: r.top, bottom: r.bottom, size: r.size}
		for _, c := range r.cells {
			if (c.left+c.right)/2 < mid {
				lr.cells = append(lr.cells, c)
			} else {
				rr.cells = append(rr.cells, c)
			}
		}
		if len(lr.cells) > 0 {
			left = append(left, lr)
			if len(lr.cells) >= 2 {
				lm++
			}
		}
		if len(rr.cells) > 0 {
			right = append(right, rr)
			if len(rr.cells) >= 2 {
				rm++
			}
		}
	}
	if lm < minMultiRows || rm < minMultiRows {
		return one
	}
	return [][]*trow{left, right}
}
