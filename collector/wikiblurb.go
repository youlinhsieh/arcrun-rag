// wikiblurb.go — 目錄每一行的「說明」要講得出這張卡在講什麼（inkstone/arcrun-rag#264 c19416，leo 2026-10-11）。
//
// 病：目錄行的說明來自卡片 frontmatter 的 gloss（雲端 AI 萃取時寫的）。大批同型文件（錯誤碼）的 gloss 常是
// 「錯誤描述檔案」「錯誤訊息145-0011」這種空話，小模型看目錄挑不出卡，只好一張張下去讀。
//
// 做法（不重新跑 AI 萃取）：用手上已有的東西補——原稿本身。
//   - 同一資料夾裡，把數字／代碼抹成 # 之後被 ≥6 份**內容不同**的原稿共用、而且很短（≤20 字）的 gloss ＝ 空話（共用的句子不可能是在區分文件；同一篇文章的複本不算）。
//   - gloss 只是把卡名裡的代碼包一圈字（「錯誤145-0005的描述」，代碼以外 ≤10 字）＝ 空話（只複述卡名）。
//   - 空話的行改用原稿節錄：有粗體小標（**Error message**）就取「小標：第一段」，否則取第一段正文。
//   - 原稿是「表單型」（兩個以上粗體小標、每個底下恰好一行，如 Error message／Cause／Correction）⇒ 一律用原稿節錄：
//     同型文件的 gloss 各說各話，只有原稿自己的小標與句子才能讓整頁讀起來一致、可比對。
//   - gloss 本來就有料的行維持原樣——其他類型的庫（KB、products）的目錄不會變差。
//
// 純函式＋讀原稿一小段（≤8 KB）；讀不到（非文字檔、檔案被搬走）就維持 gloss，不報錯。
package collector

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

const (
	blurbMaxRunes      = 150  // 一行說明的字數上限
	blurbReadBytes     = 8192 // 讀原稿前幾個位元組
	blurbGenericMaxLen = 20   // 空話都很短；長而具體的 gloss 被複本共用不算空話
	blurbGenericMin    = 6    // 同一資料夾、內容不同的原稿共用幾次以上算空話（複本不算）
)

var (
	blurbCodeRun   = regexp.MustCompile(`[0-9A-Za-z][0-9A-Za-z_\-./]*`)
	blurbBoldLabel = regexp.MustCompile(`^\*\*(.+?)\*\*[:：]?\s*$`)
	blurbMdMark    = regexp.MustCompile("[`*_]|!?\\[([^\\]]*)\\]\\([^)]*\\)")
	blurbNone      = regexp.MustCompile(`(?i)^[(（]?\s*(none|n/a|無|没有|沒有)\b?[^)）]{0,20}[)）]?\.?$`)
	blurbProp      = regexp.MustCompile(`^[A-Za-z][\w-]*::`)
	blurbWikiLink  = regexp.MustCompile(`\[\[([^\]|]*)(?:\|[^\]]*)?\]\]`)
)

// glossShape：把 gloss 的代碼／數字抹成 #、去掉標點空白，用來比「是不是同一句空話」。
func glossShape(g string) string {
	g = blurbCodeRun.ReplaceAllStringFunc(g, func(tok string) string {
		if strings.ContainsAny(tok, "0123456789") {
			return "#" // 只抹含數字的代碼；純英文單字是內容，留著
		}
		return tok
	})
	var b strings.Builder
	for _, r := range g {
		if unicode.IsSpace(r) || unicode.IsPunct(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// genericGlossShapes：這批文件裡，哪些 gloss 形狀是空話。
// 空話＝很短、被 ≥6 份「內容真的不同」的文件共用。內容是否不同看原稿開頭節錄（複本——同一篇文章存了好幾份——
// 節錄一樣，不算；錯誤碼每份節錄都不同，算）。
func genericGlossShapes(docs []wikiDoc, excerpt func(wikiDoc) string) map[string]bool {
	groups := map[string][]wikiDoc{}
	for _, d := range docs {
		sh := glossShape(d.Gloss)
		if len([]rune(sh)) > blurbGenericMaxLen {
			continue
		}
		groups[sh] = append(groups[sh], d)
	}
	out := map[string]bool{}
	for sh, ds := range groups {
		if len(ds) < blurbGenericMin {
			continue
		}
		distinct := map[string]bool{}
		for _, d := range ds {
			ex := []rune(excerpt(d))
			if len(ex) == 0 {
				continue
			}
			if len(ex) > 24 {
				ex = ex[:24]
			}
			distinct[string(ex)] = true
		}
		if len(distinct) >= blurbGenericMin {
			out[sh] = true
		}
	}
	return out
}

// blurbIsCodeLike：像錯誤碼／編號的字串（145-0005、1A0-007A）——要有數字，而且不是純數字（年份不算）。
func blurbIsCodeLike(tok string) bool {
	return strings.ContainsAny(tok, "0123456789") && strings.Trim(tok, "0123456789") != ""
}

// glossRestatesName：gloss 含卡名裡的代碼、而代碼以外只剩幾個字 ⇒ 只是在複述卡名。
func glossRestatesName(gloss, stem string) bool {
	has := false
	rest := blurbCodeRun.ReplaceAllStringFunc(gloss, func(tok string) string {
		if len(tok) >= 4 && blurbIsCodeLike(tok) && strings.Contains(stem, tok) {
			has = true
			return ""
		}
		return tok
	})
	return has && len([]rune(strings.Join(strings.Fields(rest), ""))) <= 10
}

func blurbsFor(absRoot, node string, docs []wikiDoc) map[string]string {
	out := make(map[string]string, len(docs))
	if absRoot == "" { // 沒有監看根＝讀不到原稿，維持 gloss
		for _, d := range docs {
			out[d.Path] = strings.TrimSpace(d.Gloss)
		}
		return out
	}
	type exf struct {
		text string
		form bool
	}
	cache := map[string]exf{}
	get := func(d wikiDoc) exf {
		if e, ok := cache[d.Path]; ok {
			return e
		}
		t, f := sourceBlurb(filepath.Join(absRoot, filepath.FromSlash(node), filepath.FromSlash(d.Path)))
		cache[d.Path] = exf{t, f}
		return cache[d.Path]
	}
	generic := genericGlossShapes(docs, func(d wikiDoc) string { return get(d).text })
	for _, d := range docs {
		g := strings.TrimSpace(d.Gloss)
		out[d.Path] = g
		if d.Status == "no_concept" {
			continue
		}
		e := get(d)
		ex, form := e.text, e.form
		if ex == "" {
			continue
		}
		weak := g == "" || generic[glossShape(g)] || glossRestatesName(g, pageNameOf(d.Path))
		// inkstone/arcrun-rag#264 c21637（補丁，通用修法看 #280）：錯誤碼原稿有 Error message ⇒ 一律用節錄。
		// 雲端 AI 寫的中文 gloss 常是「錯誤描述檔案寫入失敗」「PLC程式錯誤」這類各說各話或掛在十幾個碼上的空話，
		// 而原稿自己的 Error message 才是使用者看到的那句；8,000 多列本來就是節錄，其餘幾百列跟著一致。
		errMsg := strings.HasPrefix(ex, "Error message：")
		if weak || form || errMsg {
			out[d.Path] = ex
		}
	}
	return out
}

// sourceBlurb 讀原稿開頭，節錄成一行說明；第二個回傳值＝原稿是不是表單型。非文字檔／讀不到／沒內容 ⇒ ""。
func sourceBlurb(p string) (string, bool) {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".md", ".markdown", ".txt":
	default:
		return "", false
	}
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer f.Close()
	buf := make([]byte, blurbReadBytes)
	n, _ := f.Read(buf)
	return blurbFromTextForm(string(buf[:n]))
}

func blurbClean(s string) string {
	s = blurbWikiLink.ReplaceAllString(s, "$1")
	s = blurbMdMark.ReplaceAllString(s, "$1")
	return strings.Join(strings.Fields(s), " ")
}

// blurbTrunc：超過 n 字就截斷，但盡量斷在字詞／子句邊界（空白、逗號句號），不斷在半個英文字中間；
// 邊界太靠前（留不到 60%）才退回硬截。截斷時尾端加 …。
func blurbTrunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return "…"
	}
	cut := n - 1 // 留一格給 …
	floor := cut * 6 / 10
	for k := cut; k > floor; k-- {
		// r[k] 是被丟掉的第一個字；r[k-1] 是保留的最後一個字
		if unicode.IsSpace(r[k]) || strings.ContainsRune("，。；、,;.!?！？：:", r[k-1]) {
			cut = k
			break
		}
	}
	out := strings.TrimRight(strings.TrimSpace(string(r[:cut])), "，,;；、:：")
	return out + "…"
}

// blurbFitParts：把「小標：內容」各段塞進 total 字以內，每一段都留得到重點，不讓最後一段被攔腰切掉。
// 做法：短的段落整段保留，長的段落平分剩下的額度（water-filling）；每段各自在字詞邊界截斷。
func blurbFitParts(labels, bodies []string, total int) string {
	n := len(labels)
	if n == 0 {
		return ""
	}
	sep := 1 // "；"
	avail := total - (n-1)*sep
	for _, l := range labels {
		avail -= len([]rune(l)) + 1 // "：" 也算一格
	}
	lens := make([]int, n)
	for i, b := range bodies {
		lens[i] = len([]rune(b))
	}
	share := make([]int, n)
	left := avail
	done := make([]bool, n)
	// 第一段通常是這張卡的「名字」（錯誤訊息、標題句），讀者最先看它：先保留最多 45% 額度，其餘再平分。
	if n > 1 {
		first := lens[0]
		if cap := avail * 45 / 100; first > cap {
			first = cap
		}
		share[0], left, done[0] = first, left-first, true
	}
	for {
		open := 0
		for i := range done {
			if !done[i] {
				open++
			}
		}
		if open == 0 {
			break
		}
		per := left / open
		progressed := false
		for i := range done {
			if !done[i] && lens[i] <= per {
				share[i] = lens[i]
				left -= lens[i]
				done[i] = true
				progressed = true
			}
		}
		if !progressed {
			for i := range done {
				if !done[i] {
					share[i] = per
					done[i] = true
				}
			}
			break
		}
	}
	parts := make([]string, 0, n)
	for i := range labels {
		b := bodies[i]
		if share[i] < 4 { // 額度小到放不下有意義的字：只留小標
			parts = append(parts, labels[i]+"：…")
			continue
		}
		parts = append(parts, labels[i]+"："+blurbTrunc(b, share[i]))
	}
	return strings.Join(parts, "；")
}

// blurbFromText 純函式：原稿文字 → 一行說明。
func blurbFromText(text string) string { s, _ := blurbFromTextForm(text); return s }

func blurbFromTextForm(text string) (string, bool) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	i := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" { // frontmatter
		for j := 1; j < len(lines); j++ {
			if strings.TrimSpace(lines[j]) == "---" {
				i = j + 1
				break
			}
		}
	}
	type sec struct {
		label, body string
		lines       int
	}
	var secs []sec
	var plain []string
	var headings []string
	cur := -1
	seenContent := false
	for ; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		switch {
		case t == "":
			continue
		case t == "---" || t == "***" || t == "___":
			if seenContent { // 水平線之後通常是來源／版本資訊，不是內容
				i = len(lines)
			}
			continue
		case strings.HasPrefix(t, ">"): // 引言列（常是重複標題的一行）
			continue
		case strings.HasPrefix(t, "# "):
			continue
		case strings.HasPrefix(t, "|") || strings.HasPrefix(t, "```") || strings.HasPrefix(t, "<") || strings.HasPrefix(t, "![") || blurbProp.MatchString(t):
			continue // 表格／程式碼／HTML／圖片／Logseq 屬性列不是說明
		case strings.HasPrefix(t, "#"):
			headings = append(headings, blurbClean(strings.TrimLeft(t, "# ")))
			continue
		}
		if m := blurbBoldLabel.FindStringSubmatch(t); m != nil {
			secs = append(secs, sec{label: blurbClean(m[1])})
			cur = len(secs) - 1
			seenContent = true
			continue
		}
		c := blurbClean(strings.TrimLeft(t, "-+* \t"))
		if c == "" {
			continue
		}
		seenContent = true
		if cur >= 0 {
			if secs[cur].body == "" {
				secs[cur].body = c
			}
			secs[cur].lines++
			continue
		}
		plain = append(plain, c)
	}
	var labels, bodies []string
	filled, loose := 0, false
	for _, s := range secs {
		if s.body == "" || blurbNone.MatchString(s.body) {
			continue
		}
		labels = append(labels, s.label)
		bodies = append(bodies, s.body)
		filled++
		if s.lines != 1 || len([]rune(s.label)) > 30 || strings.HasSuffix(s.label, "：") || strings.HasSuffix(s.label, ":") {
			loose = true
		}
	}
	if len(labels) > 0 {
		return blurbFitParts(labels, bodies, blurbMaxRunes), filled >= 2 && !loose
	}
	if len(plain) > 0 {
		return blurbTrunc(strings.Join(plain, " "), blurbMaxRunes), false
	}
	if len(headings) > 0 {
		return blurbTrunc(strings.Join(headings, "／"), blurbMaxRunes), false
	}
	return "", false
}
