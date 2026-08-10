// lint.go — daemon 端知識卡品質檢查（B2 萃取品質驗收標準）。
//
// 真相源＝InkStoneCo 頂層卷 `system-dev/docs/3-specs/daemon-beta/b2-quality-standard-draft.md`
// （§1 硬標準 H1–H6、§6 總管自裁 2026-07-26 commit 39bbdd2：T1-T5 定案＋施工順序）。
//
// 落點（草案 §3 第一層「品質迴路」）：插在 extract 之後、POST rag_ingest_card 之前。
// 手上有原稿（H6 相似度只有這裡能做）；不過的分級依 §6 裁決 T4-C：
//   - 硬缺（H1 段名／H2 一句話定義／H5 機敏值）＝結構壞或洩密 → 拒收（不 POST）。
//   - 軟項（H3 要點條數／H4 關聯漂移／H6 相似度）＝現行管線會產生的正常瑕疵 → 照送、標 quality:low。
//   - --strict：軟項也擋（測試／CI 用，讓「形檢天花板」外的問題全部現形）。
//
// 誠實限制（抄 wiki-secret-scan.sh 的自陳）：H5 regex 偵測有偽陰/偽陽，擋的是「明顯特徵的
// 機敏字串被自動抄進卡」，擋不了刻意混淆；H3/H4/H6 是形檢，擋形不擋神（草案 §H3 ZZ-T7 天花板）。
package collector

import (
	"regexp"
	"strings"
)

// daemon 形卡片四段名（rag-extract-file.md 規約，一字不差）。
const (
	secDef = "一句話定義"
	secPts = "要點"
	secEnt = "關鍵實體"
	secRel = "關聯"
)

// H2 一句話定義長度上限（全形字＝rune）；草案 §H2「建議加長度上限 ≤ 80」。
const defMaxRunes = 80

// H6 相似度門檻（草案 §H6）：8-gram 重疊率上限、卡片字數對原稿比例上限、絕對字數上限。
const (
	h6GramSize     = 8
	h6OverlapRatio = 0.40
	h6MaxCardRunes = 4000
	h6SrcRatio     = 0.60
)

// LintFinding 一條檢查結果（附 H 代號，方便回報與分級）。
type LintFinding struct {
	Code    string `json:"code"`    // H1..H6
	Message string `json:"message"` // 白話說明
}

// LintResult 一張卡的品質檢查結果。
//   - Hard：硬缺（拒收）——H1/H2/H5。
//   - Soft：軟項（收但標 quality:low）——H3/H4/H6。
type LintResult struct {
	Hard []LintFinding `json:"hard,omitempty"`
	Soft []LintFinding `json:"soft,omitempty"`
}

func (r LintResult) addHard(code, msg string) LintResult {
	r.Hard = append(r.Hard, LintFinding{code, msg})
	return r
}

func (r LintResult) addSoft(code, msg string) LintResult {
	r.Soft = append(r.Soft, LintFinding{code, msg})
	return r
}

// Blocks 回傳這張卡是否該被擋下不 POST。
// 非 strict：只有硬缺擋。strict：硬缺或軟項任一即擋。
func (r LintResult) Blocks(strict bool) bool {
	if len(r.Hard) > 0 {
		return true
	}
	return strict && len(r.Soft) > 0
}

// Messages 把 findings 攤成訊息清單（回報用）。
func messagesOf(fs []LintFinding) []string {
	out := make([]string, 0, len(fs))
	for _, f := range fs {
		out = append(out, f.Code+": "+f.Message)
	}
	return out
}

// HardMessages / SoftMessages 供 direct.go 組回報訊息與 quality_warnings。
func (r LintResult) HardMessages() []string { return messagesOf(r.Hard) }
func (r LintResult) SoftMessages() []string { return messagesOf(r.Soft) }

// LintOptions 檢查旁路資訊。
type LintOptions struct {
	Source string // 原稿內容；空＝跳過 H6（rag_ingest_card 側天生收不到原稿）
}

// cardSection 一個 `## 段名` 區塊：名稱、出現序、段內原始行（不含標題行本身）。
type cardSection struct {
	name  string
	order int
	lines []string
}

var (
	h2HeadingRe  = regexp.MustCompile(`^##\s+(.+?)\s*$`)
	anyHeadingRe = regexp.MustCompile(`^#{1,6}\s`)
	bulletRe     = regexp.MustCompile(`^-\s+(.+?)\s*$`)
	boldNameRe   = regexp.MustCompile(`\*\*(.+?)\*\*`)
	// 關聯三元組：`- 主詞 >> 謂詞 >> 受詞`（>> 前後空白寬鬆）。
	relTripleRe = regexp.MustCompile(`^-\s+(.+?)\s*>>\s*(.+?)\s*>>\s*(.+?)\s*$`)
)

// parseSections 抽出所有 `## ` 段落（保序），供 H1/H2/H3/H4 用。
func parseSections(card string) []cardSection {
	var secs []cardSection
	var cur *cardSection
	order := 0
	for _, line := range strings.Split(card, "\n") {
		if m := h2HeadingRe.FindStringSubmatch(line); m != nil {
			secs = append(secs, cardSection{name: strings.TrimSpace(m[1]), order: order})
			cur = &secs[len(secs)-1]
			order++
			continue
		}
		if cur != nil {
			cur.lines = append(cur.lines, line)
		}
	}
	return secs
}

// sectionByName 找指定段名（一字不差）；回傳指標與是否存在。
func sectionByName(secs []cardSection, name string) (*cardSection, bool) {
	for i := range secs {
		if secs[i].name == name {
			return &secs[i], true
		}
	}
	return nil, false
}

// nonEmptyLines 過濾空白行（trim 後為空）。
func nonEmptyLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

// runeLen 全形字數（rune 計數）。
func runeLen(s string) int { return len([]rune(s)) }

// LintCard 對一張 daemon 形知識卡跑 H1–H6，回傳分級結果（B2 §1＋§6 T4-C）。
func LintCard(card string, opts LintOptions) LintResult {
	var r LintResult
	secs := parseSections(card)

	// ── H1　段名齊全且順序正確（硬）──────────────────────────────
	required := []string{secDef, secPts, secEnt, secRel}
	idx := map[string]int{}
	var missing []string
	for _, name := range required {
		if s, ok := sectionByName(secs, name); ok {
			idx[name] = s.order
		} else {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		r = r.addHard("H1", "缺段名："+strings.Join(missing, "、")+"（四段須齊：一句話定義→要點→關鍵實體→關聯）")
	} else if !(idx[secDef] < idx[secPts] && idx[secPts] < idx[secEnt] && idx[secEnt] < idx[secRel]) {
		r = r.addHard("H1", "段名順序錯（須依序：一句話定義→要點→關鍵實體→關聯）")
	}

	// ── H2　一句話定義恰一行；> 80 全形字＝軟提醒（硬/軟）─────────────
	if def, ok := sectionByName(secs, secDef); ok {
		body := nonEmptyLines(def.lines)
		switch {
		case len(body) == 0:
			r = r.addHard("H2", "一句話定義段是空的")
		case len(body) > 1:
			r = r.addHard("H2", "一句話定義有 "+itoa(len(body))+" 行（須恰一行；多行＝那是摘要不是定義）")
		default:
			if n := runeLen(strings.TrimSpace(body[0])); n > defMaxRunes {
				r = r.addSoft("H2", "一句話定義 "+itoa(n)+" 全形字（建議 ≤80，過長像小作文）")
			}
		}
	}

	// ── H3　要點 3–12 條、不夾散文（軟）───────────────────────────
	if pts, ok := sectionByName(secs, secPts); ok {
		body := nonEmptyLines(pts.lines)
		bullets := 0
		prose := false
		for _, l := range body {
			if bulletRe.MatchString(l) {
				bullets++
			} else {
				prose = true
			}
		}
		if prose {
			r = r.addSoft("H3", "要點段夾了非列點的散文行（要點應為 - 開頭的 bullet）")
		}
		if bullets < 3 || bullets > 12 {
			r = r.addSoft("H3", "要點 "+itoa(bullets)+" 條（應 3–12 條；太少該併回定義、太多是沒消化的地毯複製）")
		}
	}

	// ── H4　關聯行形＋端點閉合（軟；草案裁決 T4-C 全歸軟）──────────
	if rel, ok := sectionByName(secs, secRel); ok {
		entities := entityNames(secs)
		body := nonEmptyLines(rel.lines)
		valid := 0
		for _, l := range body {
			m := relTripleRe.FindStringSubmatch(l)
			if m == nil {
				r = r.addSoft("H4", "關聯行不合三元組形（須「- 主詞 >> 謂詞 >> 受詞」）："+trimForMsg(l))
				continue
			}
			valid++
			subj, obj := strings.TrimSpace(m[1]), strings.TrimSpace(m[3])
			for _, end := range []string{subj, obj} {
				// H1 缺關鍵實體段時 entities 為空，端點檢查會全報漂移＝雜訊，故僅在有實體清單時查。
				if len(entities) > 0 && !entities[end] {
					r = r.addSoft("H4", "關聯端點「"+end+"」不在關鍵實體清單（會長出無 gloss 的孤兒節點）")
				}
			}
		}
		if valid < 3 || valid > 8 {
			r = r.addSoft("H4", "關聯 "+itoa(valid)+" 條合法三元組（應 3–8 條）")
		}
	}

	// ── H5　不含機敏值（硬）───────────────────────────────────────
	if hits := scanSecrets(card); len(hits) > 0 {
		r = r.addHard("H5", "疑似機敏值："+strings.Join(hits, "、")+"（依規約該段應改寫成描述，不得照抄）")
	}

	// ── H6　不整段複製原文（軟；只有拿得到原稿時做）──────────────
	if opts.Source != "" {
		if msg := checkSimilarity(card, opts.Source); msg != "" {
			r = r.addSoft("H6", msg)
		}
	}

	return r
}

// entityNames 從「關鍵實體」段抽出粗體正規名集合（H4 端點閉合用）。
func entityNames(secs []cardSection) map[string]bool {
	set := map[string]bool{}
	ent, ok := sectionByName(secs, secEnt)
	if !ok {
		return set
	}
	for _, l := range ent.lines {
		if m := boldNameRe.FindStringSubmatch(l); m != nil {
			set[strings.TrimSpace(m[1])] = true
		}
	}
	return set
}

// cardBody 取卡片非標題行（H6 比對用；標題行不算複製原文）。
func cardBody(card string) string {
	var b strings.Builder
	for _, l := range strings.Split(card, "\n") {
		if anyHeadingRe.MatchString(l) {
			continue
		}
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String()
}

// checkSimilarity 粗檢卡片是否整段複製原文（草案 §H6 (b) 8-gram 重疊＋絕對字數上限）。
// 回傳非空＝命中（訊息）；空＝過。
func checkSimilarity(card, source string) string {
	body := cardBody(card)
	cardRunes := runeLen(strings.TrimSpace(body))
	srcRunes := runeLen(source)

	// 絕對上限：卡片字數 ≤ min(4000, 原稿字數 × 60%)——防「萃取失敗就整檔照抄」。
	limit := h6MaxCardRunes
	if byRatio := int(float64(srcRunes) * h6SrcRatio); byRatio < limit {
		limit = byRatio
	}
	if cardRunes > limit {
		return "卡片 " + itoa(cardRunes) + " 全形字，超過上限 " + itoa(limit) + "（min(4000, 原稿×60%)）＝疑似整段照抄"
	}

	// 8-gram 重疊率。
	cardGrams := runeGrams(body, h6GramSize)
	if len(cardGrams) == 0 {
		return ""
	}
	srcSet := gramSet(source, h6GramSize)
	matched := 0
	for g := range cardGrams {
		if srcSet[g] {
			matched++
		}
	}
	ratio := float64(matched) / float64(len(cardGrams))
	if ratio >= h6OverlapRatio {
		return "卡片與原稿 8-gram 重疊率 " + pct(ratio) + "（上限 " + pct(h6OverlapRatio) + "）＝地毯複製，違 D16 精耕非 RAG"
	}
	return ""
}

// runeGrams 回傳去重後的 rune n-gram 集合（跳過純空白 gram）。
func runeGrams(s string, n int) map[string]bool {
	set := map[string]bool{}
	rs := []rune(s)
	for i := 0; i+n <= len(rs); i++ {
		g := string(rs[i : i+n])
		if strings.TrimSpace(g) == "" {
			continue
		}
		set[g] = true
	}
	return set
}

// gramSet 同 runeGrams（別名，語意上是「原稿的 gram 索引」）。
func gramSet(s string, n int) map[string]bool { return runeGrams(s, n) }

// ── H5 機敏值 pattern（移植 .claude/hooks/wiki-secret-scan.sh，不重造輪子）──
// 每條一個標籤＋regexp；行內含 wiki-secret-ok 標記者略過。RE2 無 backref，原 pattern 皆不需要。
type secretPattern struct {
	label string
	re    *regexp.Regexp
}

var secretPatterns = []secretPattern{
	{"密碼/密鑰賦值", regexp.MustCompile(`(?i)(pass(word)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|priv(ate)?[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]<>"']{6,}`)},
	{"私鑰 PEM 區塊", regexp.MustCompile(`-----BEGIN[[:space:]].*PRIVATE KEY-----`)},
	{"服務金鑰特徵", regexp.MustCompile(`(AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{20,}|sk_(live|test)_[0-9A-Za-z]{16,})`)},
	{"JWT token", regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)},
	{"連線字串內嵌帳密", regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^[:space:]:/@]+:[^[:space:]:/@]+@`)},
	{"台灣身分證字號", regexp.MustCompile(`(^|[^A-Za-z0-9])[A-Z][12][0-9]{8}([^0-9]|$)`)},
	{"疑似信用卡號", regexp.MustCompile(`(^|[^0-9])[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{0,4}([^0-9]|$)`)},
}

// scanSecrets 逐行掃機敏特徵（與 shell hook 的 line-oriented grep 同語意），回傳命中標籤（去重保序）。
func scanSecrets(card string) []string {
	var hits []string
	seen := map[string]bool{}
	for _, line := range strings.Split(card, "\n") {
		if strings.Contains(line, "wiki-secret-ok") {
			continue // 行內豁免（示範格式）
		}
		for _, p := range secretPatterns {
			if seen[p.label] {
				continue
			}
			if p.re.MatchString(line) {
				hits = append(hits, p.label)
				seen[p.label] = true
			}
		}
	}
	return hits
}

// ── 小工具（避免拉進 strconv/fmt 只為兩個轉換）──
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// pct 把 0–1 比例轉成百分比整數字串（如 0.4→"40%"）。
func pct(f float64) string { return itoa(int(f*100+0.5)) + "%" }

// trimForMsg 截斷過長的行文於訊息中（避免整段原文塞進回報）。
func trimForMsg(s string) string {
	s = strings.TrimSpace(s)
	if runeLen(s) > 40 {
		return string([]rune(s)[:40]) + "…"
	}
	return s
}
