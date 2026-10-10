// convert_pdf_report.go — PDF 的「頁界」與「讀不到的圖片頁」盤點（inkstone/arcrun-rag#253）。
//
// 公家機關報告的固定形狀是：正文＋貼成圖片的附錄表＋訪談逐字稿。三件事這裡處理兩件（機械、零 LLM）：
//
//  1. **頁界**：每頁文字前插入 〔PDF 第 N 頁〕（讀得到頁尾印刷頁碼就多帶「印刷頁 M」），
//     讓之後每一張卡、每一段原文都引得出頁碼。
//  2. **不再靜默**：表格若是貼進去的圖片，文字層裡只剩「表 N 標題」，PDFium 讀不到表內的字。
//     這裡認出「有大圖的頁＋它的表標題」，產一份清單，文件卡會寫明「這幾張表是圖片、AI 讀不到」。
//     這份清單同時是之後接文字辨識（inkstone/arcrun-rag#251）的工作清單——只送這幾頁，不是整份。
//
// 判準只看結構（頁上有大圖、標題長得像「表 N」），不認任何領域詞，同 candidateRecordLabels 的原則。
package collector

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// bigImageFrac：一張圖佔頁面面積超過這個比例才算「大圖」（小 logo、頁首線不算）。
// 實測 NRI 報告：8% 時 72 頁有大圖，與人工數的 13 張表＋約 59 張圖吻合。
const bigImageFrac = 0.08

// pdfPageInfo 是單頁的原始觀察（純資料，方便不靠真 PDF 就能測判準）。
type pdfPageInfo struct {
	Index     int // 0 起算
	Text      string
	BigImages int
	Failed    bool // 該頁文字讀取失敗
}

// PDFImageTable＝一張貼成圖片的表。
type PDFImageTable struct {
	Caption string // 例：「表 1 美國衛星固定通訊頻段」；找不到標題時為空
	Page    int    // PDF 頁序（1 起算），圖片實際所在頁
}

// PDFReadReport＝一份 PDF「讀不到什麼」的盤點。
type PDFReadReport struct {
	Pages       int
	ImageTables []PDFImageTable // 圖片表（有標題對上的）
	ImagePages  int             // 其他含大圖的頁數（圖表、照片、沒有標題的圖）
	// ImagePageNums＝所有含大圖的頁（PDF 頁序，1 起算，由小到大、不重複），含圖片表所在頁。
	// 這就是讀圖（inkstone/arcrun-rag#251）的工作清單：只送這幾頁，不是整份。
	ImagePageNums []int
	// Extra：讀圖（imageread.go）之後要補進說明的幾行（需人工確認、沒讀到的頁）。
	Extra []string
}

// Empty：沒有任何讀不到的東西，文件卡不必多說什麼。
func (r *PDFReadReport) Empty() bool {
	return r == nil || (len(r.ImageTables) == 0 && r.ImagePages == 0 && len(r.Extra) == 0)
}

var (
	// 「表 1」「表1」「表 3-2」「Table 4」開頭的一行。數字允許全形。
	tableCaptionRe = regexp.MustCompile(`^\s*(?:表|Table)\s*[0-9０-９]+(?:[-－.．][0-9０-９]+)*[\s　:：.．、-]*(.*)$`)
	// 目錄行：結尾是一串點線＋頁碼，不算標題。
	tocTailRe = regexp.MustCompile(`(?:[.．…·‧]{3,}|\s{2,})\s*[0-9０-９ivxIVX]+\s*$`)
	// 頁尾印刷頁碼：整行只有 1–4 位數字。
	footerNumRe = regexp.MustCompile(`^\s*([0-9]{1,4})\s*$`)
)

// captionLines 回傳一頁文字裡所有「表 N …」標題行（已排除目錄行）。
func captionLines(text string) []string {
	var out []string
	for _, ln := range strings.Split(text, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || !tableCaptionRe.MatchString(ln) || tocTailRe.MatchString(ln) {
			continue
		}
		// 標題是短短一行、不是句子：「表 3 顯示……。」這種正文引用不算。
		if len([]rune(ln)) > 80 || strings.HasSuffix(ln, "。") || strings.HasSuffix(ln, "，") || strings.HasSuffix(ln, "；") {
			continue
		}
		out = append(out, ln)
	}
	return out
}

// lastLines 回傳最後 n 個非空行。
func lastNonEmptyLines(text string, n int) []string {
	lines := strings.Split(text, "\n")
	var out []string
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			out = append([]string{s}, out...)
		}
	}
	return out
}

// pageNumberCandidates：一頁開頭 3 行與結尾 3 行裡「整行只有數字」的行。
// 頁碼可能在頁首（實測 NRI 報告是頁首第二行）也可能在頁尾，兩邊都看。
func pageNumberCandidates(text string) []int {
	var lines []string
	for _, ln := range strings.Split(text, "\n") {
		if s := strings.TrimSpace(ln); s != "" {
			lines = append(lines, s)
		}
	}
	seen := map[int]bool{}
	var out []int
	add := func(ln string) {
		if m := footerNumRe.FindStringSubmatch(ln); m != nil {
			n, _ := strconv.Atoi(m[1])
			if !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	for i := 0; i < len(lines) && i < 3; i++ {
		add(lines[i])
	}
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-3; i-- {
		add(lines[i])
	}
	return out
}

// printedPageOffset 從頁首／頁尾「整行只有數字」的頁推出 PDF 頁序與印刷頁碼的差。
// 回 (offset, true) 表示 印刷頁 = PDF頁序 − offset；一致性不夠就回 false（不猜）。
func printedPageOffset(pages []pdfPageInfo) (int, bool) {
	votes := map[int]int{}
	withCand := 0
	for _, p := range pages {
		cands := pageNumberCandidates(p.Text)
		if len(cands) == 0 {
			continue
		}
		withCand++
		offs := map[int]bool{}
		for _, n := range cands {
			offs[(p.Index+1)-n] = true
		}
		for off := range offs {
			votes[off]++
		}
	}
	best, bestN := 0, 0
	for off, n := range votes {
		if n > bestN || (n == bestN && off < best) {
			best, bestN = off, n
		}
	}
	if bestN >= 5 && bestN*10 >= withCand*6 {
		return best, true
	}
	return 0, false
}

// pageMarker＝插在每頁文字前的頁界。印刷頁碼只在確定時才帶。
func pageMarker(idx int, off int, haveOff bool) string {
	if haveOff {
		if printed := (idx + 1) - off; printed >= 1 {
			return fmt.Sprintf("〔PDF 第 %d 頁・印刷頁 %d〕", idx+1, printed)
		}
	}
	return fmt.Sprintf("〔PDF 第 %d 頁〕", idx+1)
}

// renderPDFPages 把逐頁觀察組成帶頁界的全文。
// 🔴 空白頁（含只有空白字元）不插頁界：掃描檔要維持「整份抽不出字 ⇒ ErrNoText」，
// 頁界不能把空內容變成有內容。
func renderPDFPages(pages []pdfPageInfo) string {
	off, haveOff := printedPageOffset(pages)
	var sb strings.Builder
	for _, p := range pages {
		if p.Failed {
			sb.WriteString(fmt.Sprintf("\n（第 %d 頁讀取失敗）\n", p.Index+1))
			continue
		}
		if strings.TrimSpace(p.Text) != "" {
			sb.WriteString(pageMarker(p.Index, off, haveOff))
			sb.WriteString("\n")
		}
		sb.WriteString(p.Text)
		sb.WriteString("\n")
	}
	return sb.String()
}

// buildPDFReport 認出圖片表與其他圖片頁。
//
// 圖片表＝有大圖的頁上的「表標題」：本頁的標題，加上前一頁頁尾沒配到圖的標題。
// 前一頁要看：Word 常把標題留在上一頁底、圖擠到下一頁（實測 NRI 13 張表裡一半如此）。
// 一頁可以有好幾張表（實測 NRI 第 43、48 頁各兩張），所以單位是標題，不是頁。
// 前一頁的標題只認「頁尾 5 行內」，且那一頁本身沒有大圖（有大圖就是它自己的表）。
func buildPDFReport(pages []pdfPageInfo) *PDFReadReport {
	rep := &PDFReadReport{Pages: len(pages)}
	claimed := map[int]bool{} // 標題已被後一頁認領的頁
	for i, p := range pages {
		if p.BigImages == 0 || p.Failed {
			continue
		}
		rep.ImagePageNums = append(rep.ImagePageNums, p.Index+1)
		var captions []string
		if i > 0 && !claimed[i-1] && pages[i-1].BigImages == 0 && !pages[i-1].Failed {
			tail := strings.Join(lastNonEmptyLines(pages[i-1].Text, 5), "\n")
			if cs := captionLines(tail); len(cs) > 0 {
				captions = append(captions, cs...)
				claimed[i-1] = true
			}
		}
		captions = append(captions, captionLines(p.Text)...)
		if len(captions) == 0 {
			rep.ImagePages++
			continue
		}
		for _, c := range captions {
			rep.ImageTables = append(rep.ImageTables, PDFImageTable{Caption: c, Page: p.Index + 1})
		}
	}
	sort.SliceStable(rep.ImageTables, func(i, j int) bool { return rep.ImageTables[i].Page < rep.ImageTables[j].Page })
	return rep
}

// maxListedImageTables：文件卡逐張點名的上限。超過只列前面並講總數（少量點名有資訊量，巨量是噪音）。
const maxListedImageTables = 30

// Notes 回傳要寫進文件卡「讀不到的內容」段的幾行字（人話；不講技術詞）。
func (r *PDFReadReport) Notes() []string {
	if r.Empty() {
		return nil
	}
	out := append([]string(nil), r.Extra...)
	if n := len(r.ImageTables); n > 0 {
		var parts []string
		for i, t := range r.ImageTables {
			if i >= maxListedImageTables {
				break
			}
			parts = append(parts, fmt.Sprintf("%s（PDF 第 %d 頁）", t.Caption, t.Page))
		}
		more := ""
		if n > maxListedImageTables {
			more = fmt.Sprintf("……等共 %d 張", n)
		}
		out = append(out, fmt.Sprintf("本檔有 %d 張表是以圖片貼入，表內的數字與文字目前讀不到：%s%s。被問到這些表時，請說明它是圖片、並請對方查閱原檔該頁，不要憑空補數字。",
			n, strings.Join(parts, "、"), more))
	}
	if r.ImagePages > 0 {
		out = append(out, fmt.Sprintf("另有 %d 頁含大張圖片（圖表或照片），圖裡的字目前讀不到；這些頁的正文照常收錄。", r.ImagePages))
	}
	return out
}
