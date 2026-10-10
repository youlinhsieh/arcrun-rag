// imageread.go — 讀圖：掃描頁、圖片表、圖表、照片，寫入時送雲端多模態模型讀一次、存成文字
// （inkstone/arcrun-rag#251，leo 2026-10-10 改裁「要做」）。
//
// 鐵律：
//   - 讀一次、存成文字（附 PDF 頁碼），查詢時不重讀。
//   - 桌面小幫手不持有任何 LLM 金鑰：圖畫好後送自己雲端的 /portal/daemon/read-image，
//     用哪個模型由雲端決定（Arcrun#300）；這裡只說「第一次讀」或「核對讀」（pass）。
//   - 數字表直接採信不行（c18787 實測最準的模型也會錯一個字）：同一頁讀兩次（兩個不同模型），
//     數字對不上就標「需人工確認」，不靜默入庫。
//   - 舊雲端沒有這條 route（404）⇒ 退回改動前的行為（說明讀不到），不讓萃取失敗。
package collector

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// maxImageReadPages：一個檔單次最多讀幾頁圖。以每頁約 US$0.0013 計，60 頁約 US$0.16（核對讀再 ×2）。
// 超過的頁在文件卡明講沒讀，不是靜默漏掉。
const maxImageReadPages = 60

// 讀圖的兩個 pass 名（雲端依此選不同模型，雲端的對照見 Arcrun#300）。
const (
	ImagePassPrimary = "primary"
	ImagePassCheck   = "check"
)

// ErrImageReadUnsupported：雲端還沒有讀圖入口（舊版）。
var ErrImageReadUnsupported = errors.New("你的知識庫還不支援讀圖，請到 portal 按「立即更新」")

// ImageReadRequest 是對雲端的一次讀圖請求。
type ImageReadRequest struct {
	PageName string
	Page     int // PDF 頁序，1 起算
	Caption  string
	Pass     string
	PNG      []byte
}

// ImageReader 讀一頁圖，回文字。測試用假的，正式走 cloudImageReader。
type ImageReader func(ImageReadRequest) (string, error)

// ImagePageRead＝一頁讀圖結果。
type ImagePageRead struct {
	Page    int
	Text    string
	Flagged bool     // 兩次讀到的數字不一致
	Diff    []string // 不一致的數字（最多 8 個）
	Caption string
}

// ImageReadResult＝一個檔的讀圖總結。
type ImageReadResult struct {
	Reads   []ImagePageRead
	Skipped []int         // 超過上限沒讀的頁
	Failed  map[int]error // 讀失敗的頁
}

func (r *ImageReadResult) readPages() map[int]bool {
	m := map[int]bool{}
	if r != nil {
		for _, p := range r.Reads {
			m[p.Page] = true
		}
	}
	return m
}

var numTokenRe = regexp.MustCompile(`[0-9０-９]+(?:[.．,，][0-9０-９]+)*`)

// numberSet 取出一段文字裡所有數字（去千分位、轉半形；單一位數略過——頁碼、註記常見，噪音大）。
func numberSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, m := range numTokenRe.FindAllString(s, -1) {
		m = strings.NewReplacer("，", "", ",", "", "．", ".").Replace(m)
		var b strings.Builder
		for _, r := range m {
			if r >= '０' && r <= '９' {
				r = r - '０' + '0'
			}
			b.WriteRune(r)
		}
		m = b.String()
		if len(m) >= 2 {
			out[m] = true
		}
	}
	return out
}

// numberDiff 回兩次讀取數字集合的對稱差（排序、最多 8 個）。空＝一致。
func numberDiff(a, b string) []string {
	sa, sb := numberSet(a), numberSet(b)
	var d []string
	for k := range sa {
		if !sb[k] {
			d = append(d, k)
		}
	}
	for k := range sb {
		if !sa[k] {
			d = append(d, k)
		}
	}
	sort.Strings(d)
	if len(d) > 8 {
		d = d[:8]
	}
	return d
}

// textSimilarity：兩次讀取的字（去空白與標記符號）以相鄰兩字為單位的重疊比例（0–1）。
// 數字對得上但字差很多（例：姓名讀成不同的人）時，數字比對抓不到，用它補一道。
func textSimilarity(a, b string) float64 {
	grams := func(s string) map[string]bool {
		var rs []rune
		for _, r := range s {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				rs = append(rs, r)
			}
		}
		m := map[string]bool{}
		for i := 0; i+1 < len(rs); i++ {
			m[string(rs[i:i+2])] = true
		}
		return m
	}
	ga, gb := grams(a), grams(b)
	if len(ga) == 0 || len(gb) == 0 {
		return 0
	}
	inter := 0
	for k := range ga {
		if gb[k] {
			inter++
		}
	}
	small := len(ga)
	if len(gb) < small {
		small = len(gb)
	}
	return float64(inter) / float64(small)
}

// minTextSimilarity：低於這個比例就視為兩次讀到的不是同一份內容。
const minTextSimilarity = 0.6

// trimRepetition 偵測模型「重複亂轉」（同一小段字無限重複直到用完字數上限，c18787 後的實測：
// mistral-small-3.1 讀勾選框很多的掃描表單時，同一頁會出現幾千個「吸 [ ]」）。
// 一行裡某個 1–12 字的單位連續重複 ≥ 6 次 ⇒ 從重複開始處截斷（保留一個單位）並回報 true。
func trimRepetition(s string) (string, bool) {
	const minRepeats = 6
	lines := strings.Split(s, "\n")
	hit := false
	for li, ln := range lines {
		r := []rune(ln)
		if len(r) < minRepeats {
			continue
		}
		for p := 1; p <= 12 && !hit; p++ {
			run := 0
			for i := p; i < len(r); i++ {
				if r[i] == r[i-p] {
					run++
					if run >= p*(minRepeats-1) {
						start := i - run + 1 - p // 重複區起點（含第一個單位之前）
						if start < 0 {
							start = 0
						}
						lines[li] = string(r[:start+p])
						hit = true
						break
					}
				} else {
					run = 0
				}
			}
		}
		if hit {
			return strings.Join(lines[:li+1], "\n"), true
		}
	}
	return s, false
}

// readPDFImages 把 pages（PDF 頁序）逐頁畫圖、讀兩次、比對。
// 雲端不支援讀圖（ErrImageReadUnsupported）⇒ 回 (nil, 該錯誤)，呼叫端退回舊行為。
func readPDFImages(data []byte, rep *PDFReadReport, pageName string, rd ImageReader) (*ImageReadResult, error) {
	if rep == nil || len(rep.ImagePageNums) == 0 {
		return nil, nil
	}
	pages := rep.ImagePageNums
	res := &ImageReadResult{Failed: map[int]error{}}
	// 圖片表所在頁優先讀（超過上限時，被略過的是圖表／照片，不是數字表）。
	tablePage := map[int]bool{}
	for _, t := range rep.ImageTables {
		tablePage[t.Page] = true
	}
	// 整份都是圖（掃描檔）⇒ 每頁都當要確認的內容；否則只有圖片表讀兩次，圖表與照片讀一次。
	wholeScan := rep.Pages > 0 && len(pages) >= rep.Pages
	if len(pages) > maxImageReadPages {
		var first, rest []int
		for _, p := range pages {
			if tablePage[p] {
				first = append(first, p)
			} else {
				rest = append(rest, p)
			}
		}
		ordered := append(first, rest...)
		kept := ordered[:maxImageReadPages]
		res.Skipped = append(res.Skipped, ordered[maxImageReadPages:]...)
		sort.Ints(kept)
		sort.Ints(res.Skipped)
		pages = kept
	}
	pngs, rfail, err := renderPDFPagesPNG(data, pages, imageReadDPI)
	if err != nil {
		return nil, err
	}
	for p, e := range rfail {
		res.Failed[p] = e
	}
	caps := map[int]string{}
	for _, t := range rep.ImageTables {
		if caps[t.Page] == "" {
			caps[t.Page] = t.Caption
		} else {
			caps[t.Page] += "；" + t.Caption
		}
	}
	for _, p := range pages {
		png, ok := pngs[p]
		if !ok {
			continue
		}
		req := ImageReadRequest{PageName: pageName, Page: p, Caption: caps[p], Pass: ImagePassPrimary, PNG: png}
		a, err := readOnceMore(rd, req)
		if errors.Is(err, ErrImageReadUnsupported) {
			return nil, err
		}
		if err != nil {
			res.Failed[p] = err
			continue
		}
		a, loopA := trimRepetition(a)
		if strings.TrimSpace(a) == "" {
			continue // 該頁沒有可讀的字（純照片等）
		}
		if !wholeScan && !tablePage[p] {
			// 圖表、照片：讀一次就收（總管 c18860 裁示，成本減半）；不做兩次核對。
			res.Reads = append(res.Reads, ImagePageRead{Page: p, Text: strings.TrimSpace(a), Caption: caps[p], Flagged: loopA, Diff: loopNote(loopA)})
			continue
		}
		req.Pass = ImagePassCheck
		b, err := readOnceMore(rd, req)
		if errors.Is(err, ErrImageReadUnsupported) {
			return nil, err
		}
		pr := ImagePageRead{Page: p, Text: strings.TrimSpace(a), Caption: caps[p]}
		b, loopB := trimRepetition(b)
		if err != nil {
			// 核對讀失敗＝沒有核對過 ⇒ 一樣標需人工確認，不當成已確認
			pr.Flagged = true
			pr.Diff = []string{"（核對讀取失敗）"}
		} else if d := numberDiff(a, b); len(d) > 0 {
			pr.Flagged = true
			pr.Diff = d
		}
		if err == nil && textSimilarity(a, b) < minTextSimilarity {
			pr.Flagged = true
			pr.Diff = append(pr.Diff, "（兩次辨識的文字差異很大）")
		}
		if loopA || loopB {
			// 模型重複亂轉：已從重複處截斷，後半頁可能沒讀到 ⇒ 不當成已確認
			pr.Flagged = true
			pr.Diff = append(pr.Diff, "（辨識途中重複亂轉，已截斷，後面的內容可能沒讀到）")
		}
		res.Reads = append(res.Reads, pr)
	}
	sort.Slice(res.Reads, func(i, j int) bool { return res.Reads[i].Page < res.Reads[j].Page })
	return res, nil
}

// Text 把讀圖結果組成要併進原稿的文字（每頁一段，帶頁界）。
func (r *ImageReadResult) Text() string {
	if r == nil || len(r.Reads) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, p := range r.Reads {
		if p.Flagged {
			// 只留短標記：說明文字交給文件卡「讀不到的內容」段（機械產生）。
			// 以前這裡塞一整句解釋，萃取模型把它當內容、長出「圖片辨識結果存疑」之類的垃圾卡（真雲端實測）。
			fmt.Fprintf(&sb, "〔PDF 第 %d 頁・圖片辨識・需人工確認〕\n", p.Page)
		} else {
			fmt.Fprintf(&sb, "〔PDF 第 %d 頁・圖片辨識〕\n", p.Page)
		}
		sb.WriteString(p.Text)
		sb.WriteString("\n\n")
	}
	return strings.TrimSpace(sb.String())
}

// Notes 回傳要加進文件卡「讀不到的內容」段的人話（需人工確認、沒讀到的頁）。
func (r *ImageReadResult) Notes() []string {
	if r == nil {
		return nil
	}
	var out []string
	var flagged []string
	for _, p := range r.Reads {
		if p.Flagged {
			flagged = append(flagged, fmt.Sprintf("PDF 第 %d 頁", p.Page))
		}
	}
	if len(r.Reads) > 0 {
		out = append(out, fmt.Sprintf("有 %d 頁是圖片，已由機器辨識成文字收進來（原稿裡標〔圖片辨識〕）。", len(r.Reads)))
	}
	if len(flagged) > 0 {
		out = append(out, fmt.Sprintf("其中 %s 的圖片辨識有疑點（兩次數字對不上或辨識途中亂轉），需人工確認；引用這些頁的數字時請說明未經確認，並請對方查原檔。", strings.Join(flagged, "、")))
	}
	if n := len(r.Skipped); n > 0 {
		out = append(out, fmt.Sprintf("另有 %d 頁圖片超過單次讀圖上限（%d 頁）尚未讀，從 PDF 第 %d 頁起。", n, maxImageReadPages, r.Skipped[0]))
	}
	if n := len(r.Failed); n > 0 {
		var ps []int
		for p := range r.Failed {
			ps = append(ps, p)
		}
		sort.Ints(ps)
		var s []string
		for _, p := range ps {
			s = append(s, fmt.Sprintf("第 %d 頁", p))
		}
		out = append(out, fmt.Sprintf("PDF %s 的圖片讀取失敗，內容讀不到。", strings.Join(s, "、")))
	}
	return out
}

// afterRead 回傳扣掉「已讀成功」頁之後的盤點（讀不到的說明只講還讀不到的）。
func (r *PDFReadReport) afterRead(res *ImageReadResult) *PDFReadReport {
	if r == nil {
		return nil
	}
	done := res.readPages()
	out := &PDFReadReport{Pages: r.Pages, ImagePageNums: r.ImagePageNums}
	tablePages := map[int]bool{}
	for _, t := range r.ImageTables {
		tablePages[t.Page] = true
		if !done[t.Page] {
			out.ImageTables = append(out.ImageTables, t)
		}
	}
	for _, p := range r.ImagePageNums {
		if !tablePages[p] && !done[p] {
			out.ImagePages++
		}
	}
	out.Extra = res.Notes()
	return out
}

// ── 雲端呼叫 ──

// workersAIReadImageURL＝讀圖端點，與萃取同一族。
func workersAIReadImageURL(cypherURL string) string {
	return strings.TrimSuffix(strings.TrimSpace(cypherURL), "/") + "/portal/daemon/read-image"
}

// cloudImageReader 回傳打自己雲端 /portal/daemon/read-image 的 ImageReader。
// 契約（暫定，以 Arcrun#300 交件為準）：
//
//	POST {page_name, page, caption, pass, mime:"image/png", image_base64}
//	→ {success, output, model}
func cloudImageReader(client *http.Client, url, apiKey string) ImageReader {
	return func(r ImageReadRequest) (string, error) {
		body, _ := json.Marshal(map[string]any{
			"page_name":    r.PageName,
			"page":         r.Page,
			"caption":      r.Caption,
			"pass":         r.Pass,
			"mime":         "image/png",
			"image_base64": base64.StdEncoding.EncodeToString(r.PNG),
		})
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Arcrun-API-Key", apiKey)
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("連不上你的知識庫：%w", err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if resp.StatusCode == http.StatusNotFound {
			return "", ErrImageReadUnsupported
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", fmt.Errorf("雲端讀圖失敗（HTTP %d）：%.200s", resp.StatusCode, string(b))
		}
		var parsed struct {
			Success bool   `json:"success"`
			Output  string `json:"output"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(b, &parsed); err != nil {
			return "", fmt.Errorf("雲端讀圖回應解析失敗：%w", err)
		}
		if !parsed.Success {
			return "", fmt.Errorf("雲端讀圖失敗：%s", parsed.Error)
		}
		return parsed.Output, nil
	}
}

var imageReadHTTP = &http.Client{Timeout: 120 * time.Second}

// readOnceMore：讀圖失敗（逾時、5xx）再試一次。真雲端實測：NRI 第 38 頁（約 40 列合併格的大表）
// 有一次整頁「讀取失敗」，同一頁重打就讀得出來（inkstone/arcrun-rag#251 c18845）。
// 「雲端不支援讀圖」不重試。
func readOnceMore(rd ImageReader, req ImageReadRequest) (string, error) {
	out, err := rd(req)
	if err != nil && !errors.Is(err, ErrImageReadUnsupported) {
		return rd(req)
	}
	return out, err
}

// cachedImageReader 把讀圖結果存在本機（dir 底下，以圖片內容＋pass 為鍵），同一張圖不重讀。
// 為什麼要有：大檔走「分段、每天接著讀」，每次接著讀都會重新轉檔、重新讀圖；
// 模型每次讀出來的字不完全一樣 ⇒ 原稿指紋變 ⇒ 書籤作廢、整份重來，而且再花一次讀圖費。
// 只存成功的結果；失敗不存（下次還會再試）。
func cachedImageReader(dir string, rd ImageReader) ImageReader {
	return func(r ImageReadRequest) (string, error) {
		sum := sha256.Sum256(r.PNG)
		path := filepath.Join(dir, hex.EncodeToString(sum[:16])+"-"+r.Pass+".txt")
		if b, err := os.ReadFile(path); err == nil {
			return string(b), nil
		}
		out, err := rd(r)
		if err == nil {
			if os.MkdirAll(dir, 0o755) == nil {
				_ = os.WriteFile(path, []byte(out), 0o644)
			}
		}
		return out, err
	}
}

func loopNote(loop bool) []string {
	if !loop {
		return nil
	}
	return []string{"（辨識途中重複亂轉，已截斷，後面的內容可能沒讀到）"}
}
