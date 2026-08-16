// grounding.go — 出處落地檢查（InkStoneCo#44，2026-08-16 實測事故）。
//
// 🔴 為什麼有這一層：2026-08-16 同一個 220 bytes 的來源檔、同一個模型（workers-ai）、
// 同一個雲端版本（1.4.46），在 geek6688 上萃出四條全部追得回原文，在 youlin 上萃出
// 八條、其中四條的關鍵詞在原文**零命中**——而那張卡帶著真實存在的 `source_path`。
//
//	⇒ **出處在，內容是編的。引用沒有阻止幻覺，反而讓幻覺更可信。**
//
// 缺的不是「更好的模型」（萃取是機率性的，換模型只會降低頻率、讓它更難被發現），
// 也不是「更嚴的提示詞」（同一件事的較弱版本，且無法驗證）。
// **缺的是一道驗證**：卡片產出之後、寫進知識庫之前，從來沒有任何一步問過
// 「這些宣稱在原文的哪裡」。那個檢查總管當天用 grep 三秒就做完了。
//
// ── 這條線畫在哪（本檔最重要的一段，先讀完再改程式）─────────────────────
//
// ❌ **不是「卡片不准出現原文沒有的字」。** 摘要、換句話說、把 EARS 句翻成人話、
// 把英文原稿寫成正體中文卡——**全部是正當的加工**，而且是本產品的價值本身。
// 真的照抄反而是 H6 在擋的病（D16 精耕非 RAG）。
//
// ✅ **要抓的是「憑空多出來的事實宣稱」。** 判準：
//
//	**改寫改的是「怎麼說」，編造加的是「在說什麼」。**
//
// 一句話的措辭可以整個換掉，但它不會憑空長出一個新的**具體指稱**——
// 一個專名、一個型號、一個數量。所以本檔只檢查「**翻譯與改寫都帶不走的錨點**」：
//
//	錨點① 拉丁字母串（Windows／macOS／Linux／CONSTITUTION.md／OAuth2…）
//	      ——這是**指稱**不是措辭。原文若真的提到它，它會**逐字**在原文裡。
//	錨點② 兩位數以上的數字（30／2026／1.4／80%）
//	      ——「每 30 天檢查一次」裡的 30 不可能是改寫的產物。
//
// 🔴 **刻意不檢查 CJK 詞**：原文可能是英文、卡片是中文（本案就是），
// 逐字比對中文詞會把**忠實的翻譯全部誤判成編造**——那正好違反紅線。
// 代價是「日誌」「敏感資料」這種**純中文的憑空宣稱** H7 抓不到，
// 由 H8 從另一個角度補（見下），且**這個盲區是明說的，不假裝沒有**。
//
// H8（宣稱通膨）走的是完全不同的軸：**數量**。
// 事故的 ⚠️ 那段講得很清楚——「輸入越少，編得越多，而卡片看起來越專業」。
// 改寫可以把原文一句拆成兩句，但拆成四句就是在增添。
// ⇒ 卡片的宣稱數 > 原文自身斷言數 × 2 ＝ 通膨警示。
// 本案：原文 2 條斷言 ⇒ 上限 4；geek6688 4 條（過）、youlin 8 條（不過）。
//
// ── 分級：兩項都是**軟項**，不是硬缺 ──────────────────────────────
//
// 🔴 **不確定就標記，不要靜默丟棄**——使用者的知識被丟掉比被標記可疑更糟。
// 硬缺＝拒收不 POST＝知識被丟掉，所以 H7/H8 一律走軟項：照送、標 `quality: low`
// ＋ `quality_warnings`（direct.go 既有的那條路，不新增第二套寫入路徑）。
// 要讓它們變成擋牆＝跑 `--strict`（測試／CI）。
//
// ── 誠實的限制（照 lint.go 檔頭自陳的規矩寫）──────────────────────
//
//   - 中文數字（「三十天」）不正規化 ⇒ 錨點②漏。
//   - 單一位數不算錨點（卡片自己數東西時太常出現「1」「3」）⇒ 「每 5 次」漏。
//   - 原文若本身就含該拉丁串（哪怕語意完全不同）就算落地 ⇒ 偽陰。
//   - H8 的斷言數是行／句層級的粗估，不是語意單位。
//
// **這一層擋的是「明顯憑空的具體指稱」與「數量上的通膨」，擋不了語意層的曲解。**
package collector

import (
	"regexp"
	"strings"
)

// h8ClaimRatio：卡片宣稱數相對原文斷言數的上限倍率。
//
// 3＝「把原文一句拆成定義＋前提＋結果」是改寫的合理上界；再多就是在增添內容。
// 🔴 為什麼不是 2：本票的兩張真卡把兩邊的距離釘死了——同一份 2 條斷言的原稿，
// **忠實的那張產 4 條、編造的那張產 8 條**。倍率 2（上限 4）會讓忠實的那張
// 剛好卡在線上，任何一張多寫一條的好卡都會被誤標；倍率 3（上限 6）讓兩邊
// 各留 2 條的餘裕。**這個數字是拿事故裡的真實兩端定的，不是憑感覺調的。**
const h8ClaimRatio = 3

// h8MinClaims：宣稱數低於此值不報 H8（原文只有一條斷言時，3 條卡片重點是正常的
// 「拆成定義＋前提＋結果」，報它只會製造雜訊）。
const h8MinClaims = 4

var (
	// 拉丁錨點：字母開頭，可含數字與 . _ - 連接（CONSTITUTION.md／OAuth2／macOS／v1.4）。
	latinAnchorRe = regexp.MustCompile(`[A-Za-z][A-Za-z0-9]*(?:[._\-][A-Za-z0-9]+)*`)
	// 數字錨點：兩位數以上（含小數與百分比）。單一位數雜訊太多，刻意不收。
	numAnchorRe = regexp.MustCompile(`[0-9]{2,}(?:\.[0-9]+)*%?|[0-9]\.[0-9]+`)
	// wikishape 機械補的那一行（renderDocCard 的 linked==0 分支）——它是程式寫的，不是模型的宣稱。
	mechConceptCountRe = regexp.MustCompile(`^-\s*本文件整理成\s*[0-9]+\s*張概念卡`)
	// 麵包屑（← [[上層]]）與 H3 子標題。
	breadcrumbRe = regexp.MustCompile(`^←\s*\[\[`)
	h3HeadingRe  = regexp.MustCompile(`^###\s+(.+?)\s*$`)
	// 句尾（H8 算原文斷言用）。全形標點一律算句尾；半形句點只在**後面接空白或到文末**時
	// 才算——否則 `CONSTITUTION.md`、`v1.4`、`3.5 吋` 會被切成兩句，把原文斷言數灌水，
	// H8 的上限跟著變鬆（實測：本票那份原稿會從 2 條被算成 3 條）。
	sentEndRe = regexp.MustCompile(`[。！？；]+|[.!?;]+(?:\s+|$)`)
	// 條列行（原文與卡片共用）。
	srcBulletRe = regexp.MustCompile(`^\s*(?:[-*+]|[0-9]+[.)])\s+\S`)
)

// GroundingReport 一張卡的落地檢查結果。
type GroundingReport struct {
	// Ungrounded＝卡片上有、原文查不到的具體指稱（去重保序，最多列前幾個）。
	Ungrounded []string `json:"ungrounded,omitempty"`
	// Claims＝卡片做出的事實宣稱數（重點條＋內文知識關係三元組）。
	Claims int `json:"claims"`
	// SrcUnits＝原文自身的斷言數（條列行＋散文句）。
	SrcUnits int `json:"src_units"`
}

// Inflated 回答「宣稱數是否超過原文能支撐的量」。
func (g GroundingReport) Inflated() bool {
	return g.Claims >= h8MinClaims && g.Claims > g.SrcUnits*h8ClaimRatio
}

// CheckGrounding 對一張卡跑落地檢查。source 為空＝無從檢查，回空報告。
//
// 🔴 這是**純函式**：不讀檔、不打網路、不看設定。事故的回歸案例因此可以做成
// 測試夾具離線重放，不必依賴任何線上實例（本票紅線：不得在既有實例上刪改資料）。
func CheckGrounding(card, source string) GroundingReport {
	var g GroundingReport
	if strings.TrimSpace(source) == "" || strings.TrimSpace(card) == "" {
		return g
	}
	body, claims := groundingBody(card)
	g.Claims = claims
	g.SrcUnits = countSourceUnits(source)

	src := normalizeAnchorText(source)
	seen := map[string]bool{}
	for _, a := range anchorsOf(body) {
		if seen[a] {
			continue
		}
		seen[a] = true
		if !strings.Contains(src, a) {
			g.Ungrounded = append(g.Ungrounded, a)
		}
	}
	return g
}

// groundingBody 從卡片切出「該被檢查的那些字」，並順便數出宣稱數。
//
// 排除的全是**機械產物**（wikishape.go 寫的，不是模型的宣稱）：
// frontmatter、標題行、麵包屑、`### 卡片關係`（[[A]] >> 整理出 >> [[B]]）、
// `### 出處`（那一行就是 source_path 本身，拿它比對等於自問自答）、
// 以及「本文件整理成 N 張概念卡」那條補句。
func groundingBody(card string) (body string, claims int) {
	lines := strings.Split(card, "\n")
	var b strings.Builder

	inFrontmatter := false
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		inFrontmatter = true
		lines = lines[1:]
	}
	wikiShape := isWikiShapeCard(card)
	sec, sub := "", ""
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if inFrontmatter {
			if t == "---" {
				inFrontmatter = false
			}
			continue
		}
		if m := h2HeadingRe.FindStringSubmatch(line); m != nil {
			sec, sub = strings.TrimSpace(m[1]), ""
			continue
		}
		if m := h3HeadingRe.FindStringSubmatch(line); m != nil {
			sub = strings.TrimSpace(m[1])
			continue
		}
		if anyHeadingRe.MatchString(line) || t == "" || breadcrumbRe.MatchString(t) {
			continue
		}
		if sub == "出處" || sub == "卡片關係" || mechConceptCountRe.MatchString(t) {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')

		if !bulletRe.MatchString(t) {
			continue
		}
		switch {
		case sec == nsecPts || sec == secPts: // 重點／要點
			claims++
		case sub == "內文知識關係": // 概念卡的三元組（新格式）
			claims++
		case !wikiShape && sec == secRel: // 舊四段格式的「關聯」
			claims++
		}
	}
	return b.String(), claims
}

// countSourceUnits 粗估原文自身的斷言數：條列行一條算一個；散文段落按句子數算。
// 標題行與純標記行（`> [!NOTE]`、`|---|`、圍欄）不是斷言，不計。
// 下限 1（原文再薄也不會是 0，免得除出無限大的比例）。
func countSourceUnits(source string) int {
	n := 0
	inFence := false
	for _, raw := range strings.Split(source, "\n") {
		t := strings.TrimSpace(raw)
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			n++ // 程式碼／表格內容：一行算一條，不再切句
			continue
		}
		// 引言標記剝掉再判斷（`> Inherited from …` 是斷言，`> [!NOTE]` 不是）。
		t = strings.TrimSpace(strings.TrimPrefix(t, ">"))
		if t == "" || anyHeadingRe.MatchString(t) || strings.HasPrefix(t, "---") {
			continue
		}
		if strings.HasPrefix(t, "[!") || strings.HasPrefix(t, "|") {
			continue
		}
		if srcBulletRe.MatchString(t) {
			n++
			continue
		}
		// 散文：以句尾符號切；沒有任何句尾符號的一行仍算一句。
		parts := sentEndRe.Split(t, -1)
		c := 0
		for _, p := range parts {
			if strings.TrimSpace(p) != "" {
				c++
			}
		}
		if c == 0 {
			c = 1
		}
		n += c
	}
	if n < 1 {
		n = 1
	}
	return n
}

// normalizeAnchorText 把文字壓成可比對的形狀：全形數字→半形、拉丁字母→小寫。
// 刻意**不**做斷詞——子字串命中就算落地（`logseq` 命中 `Logseq-plugin`），
// 寧可放過也不要誤殺（本檔的偏誤方向：偽陰可接受，偽陽不可接受）。
func normalizeAnchorText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= '０' && r <= '９':
			b.WriteRune('0' + (r - '０'))
		case r >= 'Ａ' && r <= 'Ｚ':
			b.WriteRune('a' + (r - 'Ａ'))
		case r >= 'ａ' && r <= 'ｚ':
			b.WriteRune('a' + (r - 'ａ'))
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// anchorsOf 抽出一段文字裡的「具體指稱」錨點（已正規化）。
func anchorsOf(text string) []string {
	t := normalizeAnchorText(text)
	var out []string
	seen := map[string]bool{}
	add := func(a string) {
		if a == "" || seen[a] {
			return
		}
		seen[a] = true
		out = append(out, a)
	}
	for _, m := range latinAnchorRe.FindAllString(t, -1) {
		if len([]rune(m)) < 2 || anchorStopwords[m] {
			continue
		}
		add(m)
	}
	for _, m := range numAnchorRe.FindAllString(t, -1) {
		add(m)
	}
	return out
}

// anchorStopwords：不當指稱看的拉丁串。
// 只收**卡片格式自己會產生**或**中文行文的通用連接詞**——不收任何領域名詞
// （API／JSON／OAuth 都是真的指稱，若原文沒有就該被指出來）。
var anchorStopwords = map[string]bool{
	"md": true, "txt": true, "pdf": true, "docx": true, "pptx": true, "xlsx": true, // 副檔名（出處行已排除，這是保險）
	"http": true, "https": true, "www": true, "kb": true,
	"index": true, "tags": true, "gloss": true, "created": true, "updated": true, // frontmatter 鍵（已排除，保險）
	"the": true, "and": true, "or": true, "of": true, "to": true, "in": true, "is": true, "a": true, "an": true,
}

// groundingFindings 把報告攤成 lint 訊息（H7 憑空指稱／H8 宣稱通膨）。
// 回傳 (code, message) 對；空＝全過。
func groundingFindings(g GroundingReport) [][2]string {
	var out [][2]string
	if n := len(g.Ungrounded); n > 0 {
		shown := g.Ungrounded
		if len(shown) > 6 {
			shown = shown[:6]
		}
		msg := "卡上有 " + itoa(n) + " 個原文查不到的具體指稱：" + strings.Join(shown, "、")
		if n > len(shown) {
			msg += "…"
		}
		out = append(out, [2]string{"H7", msg + "（改寫可以換措辭，但不會憑空長出專名或數量）"})
	}
	if g.Inflated() {
		out = append(out, [2]string{"H8",
			"卡片有 " + itoa(g.Claims) + " 條宣稱，原文只有 " + itoa(g.SrcUnits) +
				" 條斷言（上限 " + itoa(g.SrcUnits*h8ClaimRatio) + "）＝輸入貧乏卻產出豐富，是模型拿通用先驗補滿的典型情況"})
	}
	return out
}
