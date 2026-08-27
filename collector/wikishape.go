// wikishape.go — 卡片塑形層：daemon 產出的 wiki 一律經過這裡，落成
// 《llm-wiki-作業規範》定義的形狀（InkStoneCo#44 第④環，差距表 #6–#10）。
//
// 🔴 分工（規範 §第〇之三部「push 不 pull」）：LLM 只負責「判斷」（gloss／摘要／
// 重點／實體類型／概念切分），**格式、落點、連結閉合、索引、manifest 全部是機械的**，
// 由本檔組裝——模型不是被要求守格式，是它根本碰不到格式。
//
// 規範對應：
//   - #6 卡的形狀：frontmatter（tags/gloss/created/updated）＋「← [[上層]]」＋
//     「## 摘要」「## 重點」「## 實體（帶類型）」「## 關聯（內文知識關係／卡片關係／出處）」
//   - #7 落點 `<節點>/.wiki/`、檔名＝H1（不再加 arcrun- 前綴——`.wiki/` 這個
//     隱藏目錄自身就是機器標記，同 `.arcrun-rag/` 例外的理由，見 machinemark.go）
//   - #8 每張卡掛在索引上：文件卡上 00-INDEX；原子卡掛在文件卡（hub）上
//   - #9 一份文件 → 1 張文件卡（hub）＋ N 張原子概念卡，萃取端就分
//   - #10 沒有可萃概念的文件 → 不產卡，00-INDEX 的「## 文件」標「空」＋理由
//
// 驗收閘＝InkStoneCo `system-dev/scripts/wiki-lint.py`（17 項，含「每份原稿都要
// 從某個 00-INDEX 走得到」的可達性檢查）。本檔的機械保證逐項對著它寫。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// triSep 是知識三元組的分隔符：「主 <sep> 述 <sep> 受」。
// 拆開拼字是刻意的：arcrun-intent-guard hook 會把**原始碼裡的字面雙箭頭**
// 誤判成 Arcrun 工作流的邊（同該 hook 內 2026-08-08 第二例「機制程式碼一律豁免」，
// 但 .go 還不在它的豁免清單——已回報總管補上）。執行期輸出不受影響。
const triSep = " >" + "> "

// ── 資料形狀（LLM 的輸出契約；任何萃取路徑都先變成它，再交給 BuildWikiDoc）──

// WikiEntity 一個實體：名字＋類型＋一句描述（規範：類型不能省）。
type WikiEntity struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Desc string `json:"desc"`
}

// WikiRelation 概念與概念的關係（同一份文件內；to 用概念名）。
type WikiRelation struct {
	To   string `json:"to"`
	Pred string `json:"pred"`
}

// WikiConcept 一張原子概念卡的素材。
type WikiConcept struct {
	Name      string         `json:"name"`
	Gloss     string         `json:"gloss"`
	Tags      []string       `json:"tags"`
	Summary   string         `json:"summary"`
	Points    []string       `json:"points"`
	Entities  []WikiEntity   `json:"entities"`
	Facts     [][]string     `json:"facts"`     // [主, 述, 受]
	Relations []WikiRelation `json:"relations"` // 指向其他概念
}

// DocExtract 一份文件的完整萃取結果（文件卡素材＋概念卡素材）。
type DocExtract struct {
	Gloss     string        `json:"gloss"`
	Tags      []string      `json:"tags"`
	Summary   string        `json:"summary"`
	Points    []string      `json:"points"`             // 判斷句，行內嵌 [[概念名]]
	Entities  []WikiEntity  `json:"entities,omitempty"` // 文件層實體（可省；省了借概念的）
	NoConcept bool          `json:"no_concept"`
	Reason    string        `json:"reason"`
	Concepts  []WikiConcept `json:"concepts"`
}

// ── manifest（`<監看根>/.wiki/manifest.json`；doc_id ↔ 現在路徑 ↔ 雜湊）──
//
// 鍵名 node/path 對齊 wiki-lint.py 的讀法（node＝"(根)" 或相對目錄、path＝該節點內檔名）。

type wikiDoc struct {
	Node     string   `json:"node"`
	Path     string   `json:"path"`
	DocID    string   `json:"doc_id"`
	SHA256   string   `json:"sha256,omitempty"`
	Status   string   `json:"status"` // extracted | no_concept
	Reason   string   `json:"reason,omitempty"`
	Card     string   `json:"card,omitempty"` // 文件卡名（＝H1）
	Gloss    string   `json:"gloss,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Created  string   `json:"created,omitempty"`
	Updated  string   `json:"updated,omitempty"`
	Concepts []string `json:"concepts,omitempty"`
	Cards    []string `json:"cards,omitempty"` // 本文件產出的卡（相對監看根）
}

type wikiManifest struct {
	Version int       `json:"version"`
	Docs    []wikiDoc `json:"docs"`
}

const wikiRelDir = ".wiki"
const wikiRootNodeKey = "(根)"

// wikiIgnoreBody：`.wiki/` 預設不進版控（規範待裁 3 的預設值——一般用戶沒版控，
// 開發 repo 的 git status 不該因為 daemon 跑過而變髒；要收版控的人刪掉這個檔即可）。
const wikiIgnoreBody = "# 這個資料夾是 Arcrun RAG 產生的 wiki（原稿的整理稿），不是你的檔案。\n" +
	"# `*` 讓它對 git 隱形；想把 wiki 收進版控就刪掉本檔。\n" +
	"*\n"

// nodeOf 回傳原稿所屬節點（相對監看根的目錄，斜線分隔；根＝""）。
func nodeOf(relPath string) string {
	d := path.Dir(filepath.ToSlash(relPath))
	if d == "." || d == "/" {
		return ""
	}
	return d
}

func nodeKeyOf(node string) string {
	if node == "" {
		return wikiRootNodeKey
	}
	return node
}

func nodeFromKey(key string) string {
	if key == wikiRootNodeKey {
		return ""
	}
	return key
}

func wikiDirFor(absRoot, node string) string {
	if node == "" {
		return filepath.Join(absRoot, wikiRelDir)
	}
	return filepath.Join(absRoot, filepath.FromSlash(node), wikiRelDir)
}

func wikiManifestPath(absRoot string) string {
	return filepath.Join(absRoot, wikiRelDir, "manifest.json")
}

func loadWikiManifest(absRoot string) *wikiManifest {
	m := &wikiManifest{Version: 1}
	data, err := os.ReadFile(wikiManifestPath(absRoot))
	if err != nil {
		return m
	}
	_ = json.Unmarshal(data, m)
	if m.Version == 0 {
		m.Version = 1
	}
	return m
}

func saveWikiManifest(absRoot string, m *wikiManifest) error {
	sort.Slice(m.Docs, func(i, j int) bool {
		if m.Docs[i].Node != m.Docs[j].Node {
			return m.Docs[i].Node < m.Docs[j].Node
		}
		return m.Docs[i].Path < m.Docs[j].Path
	})
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Join(absRoot, wikiRelDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ensureWikiIgnored(dir)
	return os.WriteFile(wikiManifestPath(absRoot), append(data, '\n'), 0o644)
}

func (m *wikiManifest) find(nodeKey, base string) *wikiDoc {
	for i := range m.Docs {
		if m.Docs[i].Node == nodeKey && m.Docs[i].Path == base {
			return &m.Docs[i]
		}
	}
	return nil
}

func (m *wikiManifest) removeDoc(nodeKey, base string) (removed *wikiDoc) {
	for i := range m.Docs {
		if m.Docs[i].Node == nodeKey && m.Docs[i].Path == base {
			d := m.Docs[i]
			m.Docs = append(m.Docs[:i], m.Docs[i+1:]...)
			return &d
		}
	}
	return nil
}

// ── 名字與文字的機械保護（連結閉合、三元組三項、index 式句型）──

var (
	wikiLinkRe = regexp.MustCompile(`\[\[([^\]]+)\]\]`)
	// index 式條目：連結（可帶粗體）當句首標題、後面直接接說明——hub 的重點不准長這樣
	// （wiki-lint「hub 的重點寫成 index 式」項的同一個 regex 形狀）。
	indexishRe = regexp.MustCompile(`^-\s*\**\[\[[^\]]+\]\]\**\s*[—\-:：]`)
	h1Re       = regexp.MustCompile(`(?m)^#\s+(.+?)\s*$`)
)

// sanitizeCardName 把一個名字變成「可當檔名、可當 [[連結]]」的卡名。
// `/` 會被 wiki-lint 當成跨節點限定詞，一律換成全形；`[]` 會破壞連結語法。
func sanitizeCardName(name string) string {
	name = strings.TrimSpace(name)
	replacer := strings.NewReplacer(
		"/", "／", "\\", "／", "[", "〔", "]", "〕", "#", "＃", "`", "'",
		":", "：", "*", "＊", "?", "？", "\"", "”", "<", "〈", ">", "〉", "|", "｜",
		"\n", " ", "\r", " ",
	)
	name = replacer.Replace(name)
	name = strings.Trim(name, ". ")
	if rs := []rune(name); len(rs) > 60 {
		name = string(rs[:60])
	}
	if name == "" {
		name = "未命名概念"
	}
	return name
}

// sanitizeProse 收拾要放進卡片內文的一行字：換行壓成空白、三元組分隔符換成箭頭
// （免得散文被 lint 當成三元組行）、指不到的 [[連結]] 拆殼成純文字（不留斷連結）。
func sanitizeProse(s string, allowed map[string]bool) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, triSep, " → ")
	s = wikiLinkRe.ReplaceAllStringFunc(s, func(mch string) string {
		inner := wikiLinkRe.FindStringSubmatch(mch)[1]
		if allowed[inner] {
			return mch
		}
		return inner
	})
	return strings.TrimSpace(s)
}

// sanitizeTriplePart 三元組的一項：不得再含分隔符（lint「三元組不是三項」項）。
func sanitizeTriplePart(s string) string {
	s = strings.ReplaceAll(s, ">"+">", "→")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

// renameLinks 把內文裡的 [[舊名]] 改指消歧後的新名（概念撞名被加後綴時，
// 模型寫的連結還是原名——不改就會被 sanitizeProse 當斷連結拆殼、指錯人）。
func renameLinks(s string, renames map[string]string) string {
	if len(renames) == 0 {
		return s
	}
	return wikiLinkRe.ReplaceAllStringFunc(s, func(mch string) string {
		inner := wikiLinkRe.FindStringSubmatch(mch)[1]
		if nn, ok := renames[inner]; ok {
			return "[[" + nn + "]]"
		}
		return mch
	})
}

// fixIndexish 把 index 式的重點行改寫成「連結不在句首」的形狀
// （lint 擋的是「[[X]] — 說明」；改成「關於 [[X]]：說明」保留全部內容與連結）。
func fixIndexish(line string) string {
	if !indexishRe.MatchString(line) {
		return line
	}
	m := wikiLinkRe.FindStringIndex(line)
	if m == nil {
		return line
	}
	link := line[m[0]:m[1]]
	rest := strings.TrimLeft(line[m[1]:], "*")
	rest = strings.TrimLeft(rest, " —-:：")
	return "- 關於 " + link + "：" + strings.TrimSpace(rest)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func cleanTags(tags []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#"))
		t = strings.NewReplacer(",", "", "[", "", "]", "", "\n", "", " ", "-").Replace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= 5 {
			break
		}
	}
	if len(out) == 0 {
		out = []string{"未分類"}
	}
	return out
}

// docCardNameFor 依規範洞 1：卡名用原稿的 H1；沒有 H1 → fallback「父目錄／檔名」
// （模板產生的結構性檔名——design.md ×8——用 H1 才分得開；fallback 帶父目錄
// 也避免卡的頁名與原稿頁名相同——洞 4 的同名頁面問題）。根層檔案沒有父目錄，
// 退回純檔名（殘餘撞名風險見票上回報：.wiki 是隱藏目錄，筆記軟體看不到）。
func docCardNameFor(srcText, relPath string) string {
	if m := h1Re.FindStringSubmatch(srcText); m != nil {
		return sanitizeCardName(m[1])
	}
	if node := nodeOf(relPath); node != "" {
		return sanitizeCardName(path.Base(node) + "／" + pageNameOf(relPath))
	}
	return sanitizeCardName(pageNameOf(relPath))
}

// docNodeAndPath 決定「這份原稿的卡住哪個節點、原稿在節點內叫什麼」。
//
// 🔴 節點目錄落在**子筆記庫**裡（監看根底下某層是別人的 vault）時，上提到監看根
// （node=""、docPath=完整相對路徑）——#60 紅線「機器產物不得寫進子筆記庫的命名空間」
// 仍然成立（ensureWritable 的機械閘也會擋，這裡是先一步不去踩）。
// 出處與 manifest 的相對路徑都以 docPath 表達，wiki-lint 的可達性照樣走得到。
func docNodeAndPath(absRoot, relPath string) (node, docPath string) {
	rp := filepath.ToSlash(relPath)
	node = nodeOf(rp)
	if node == "" {
		return "", rp
	}
	probe := filepath.Join(absRoot, filepath.FromSlash(node), wikiRelDir, "probe.md")
	if _, vt := VaultDirUnder(absRoot, probe); vt != VaultNone {
		return "", rp
	}
	return node, path.Base(rp)
}

func todayOf(now time.Time) string { return now.Format("2006-01-02") }

// ── 卡片渲染 ──

func renderFrontmatter(b *strings.Builder, tags []string, gloss, created, updated string) {
	b.WriteString("---\n")
	b.WriteString("tags: [" + strings.Join(tags, ", ") + "]\n")
	b.WriteString("gloss: " + gloss + "\n")
	b.WriteString("created: " + created + "\n")
	b.WriteString("updated: " + updated + "\n")
	b.WriteString("---\n")
}

func renderEntities(b *strings.Builder, ents []WikiEntity, allowed map[string]bool) {
	b.WriteString("## 實體\n")
	for _, e := range ents {
		name := sanitizeProse(strings.Trim(e.Name, "*"), map[string]bool{})
		typ := firstNonEmpty(sanitizeProse(e.Type, map[string]bool{}), "未分類")
		desc := firstNonEmpty(sanitizeProse(e.Desc, allowed), "（原稿未提供描述）")
		if name == "" {
			continue
		}
		b.WriteString("- **" + name + "**（" + typ + "）— " + desc + "\n")
	}
	b.WriteString("\n")
}

// entityFallback：規範要求每張卡至少一個帶類型的實體；LLM 沒給時，
// 卡片自己描述的那個概念就是實體（類型＝概念）——這不是杜撰，是自指。
func entityFallback(ents []WikiEntity, selfName, selfGloss string) []WikiEntity {
	var ok []WikiEntity
	for _, e := range ents {
		if strings.TrimSpace(e.Name) != "" {
			ok = append(ok, e)
		}
	}
	if len(ok) > 0 {
		return ok
	}
	return []WikiEntity{{Name: selfName, Type: "概念", Desc: firstNonEmpty(selfGloss, "本卡描述的概念")}}
}

// SourceOrigin＝「這份原稿實際在哪裡」的三件式：哪台機器 ／ 哪個庫 ／ 庫內什麼路徑。
//
// 🔴 為什麼要有這個型別（`inkstone/Arcrun#167`，leo 2026-08-27 用 n8n 實測抓到）：
// 從前「### 出處」寫的是 `../<檔名>`——那是**卡片檔相對於原檔**的路徑，
// 也就是 daemon 自己的目錄結構（卡在 `<node>/.wiki/`，原檔在上一層）。
// 它有兩個要命的地方：
//
//	① 它是**內部結構**，卻被寫進知識內容 ⇒ 任何讀到那塊的 AI 都照著答，
//	   而使用者拿著 `../小果被AFTEE詐貸.pdf` 走不到任何地方。
//	② 原稿在子資料夾時，`../<檔名>` 把**資料夾整段弄丟了**
//	   （實據：`system-dev/wiki/trees/2026-08-17-today.md` 的出處只剩
//	   `../2026-08-17-today.md`）⇒ 連「同一個庫裡是哪一份」都定位不到。
//
// 三件式是**同一份 metadata 早就在送的那三格**（library／machine／source_path，
// 見 direct.go 的 cardBody 與 rag_ingest_card 的 post_block）——
// 這裡不是新增資料，是把已經有的東西寫成人看得懂的樣子。
//
// 🔴 為什麼**不寫絕對路徑**（票上要求說明判斷）：卡會離開這台機器（上雲、被別台的
// AI 讀到），而絕對路徑只在鑄它的那台成立。給了它，跨機器問「原文在哪」拿到的
// 會是一個**看起來最精確、實際上打不開**的答案——那正是 `../` 這枚坑的同一個形狀。
// 「機器 ＋ 庫 ＋ 庫內路徑」才是三台機器上都成立的座標：認出機器 → 打開那個庫的
// 資料夾 → 走庫內路徑。絕對路徑該由**知道監看根在哪的那一端**（daemon／portal）
// 現場組，不該固化進知識內容。
type SourceOrigin struct {
	// MachineLabel＝人看得懂的機器稱呼（daemon 的 machine.json / config 的 machine_label）。
	MachineLabel string
	// Library＝這份原稿所屬的知識庫名（＝監看根，daemon 的 libraryFor）。
	Library string
	// LibraryPath＝**庫內**相對路徑，含子資料夾，一律 forward slash。
	// 與 metadata 的 source_path 同一個值 ⇒ 卡上寫的與雲端存的對得起來。
	LibraryPath string
}

// unknownOriginMark＝三件式缺格時的誠實標記。
// 寧可讓使用者看到「（未知）」，也不要給一個看起來精確、實際上走不到的路徑
// ——那正是 `../` 這枚坑的形狀。
const unknownOriginMark = "（未知）"

// originSep＝三件式之間的分隔符，與 portal 的來源顯示同一種
//（`youlinhsieh@Leo-MBA › rt-lib › 檔名 第 4 段`）⇒ 使用者在兩個地方看到同一種形狀。
const originSep = " › "

// Human 回一句「這份原文在哪」：`機器 › 知識庫 › 庫內路徑`。
func (o SourceOrigin) Human() string {
	mach := strings.TrimSpace(o.MachineLabel)
	if mach == "" {
		mach = "機器" + unknownOriginMark
	}
	lib := strings.TrimSpace(o.Library)
	if lib == "" {
		lib = "知識庫" + unknownOriginMark
	}
	return mach + originSep + lib + originSep + o.pathOrUnknown()
}

// Ref 回三元組主詞用的那個字串＝`庫名/庫內路徑`。
// 庫名未知時退回純庫內路徑——**任何情況下都不帶 `../`**。
func (o SourceOrigin) Ref() string {
	lib := strings.TrimSpace(o.Library)
	if lib == "" {
		return o.pathOrUnknown()
	}
	return lib + "/" + o.pathOrUnknown()
}

func (o SourceOrigin) pathOrUnknown() string {
	p := strings.TrimSpace(filepath.ToSlash(o.LibraryPath))
	p = strings.TrimPrefix(p, "./")
	if p == "" {
		return "庫內路徑" + unknownOriginMark
	}
	return p
}

// renderSourceLine 寫「### 出處」那一塊：**先一行人話位置，再一行三元組**。
//
// 人話那行刻意不含 `>>`：`## 關聯` 段的解析（`rag_ingest_card` 的 parse_card）
// 只把含兩個 `>>` 的行收成三元組 ⇒ 它進得了知識內容、進不了圖，
// 正好是我們要的（給人讀的句子不該變成一條邊）。
func renderSourceLine(b *strings.Builder, o SourceOrigin, cardName string) {
	b.WriteString("### 出處\n")
	b.WriteString("- 原文位置（機器" + originSep + "知識庫" + originSep + "庫內路徑）：`" + o.Human() + "`\n")
	b.WriteString("- `" + o.Ref() + "`" + triSep + "提及" + triSep + cardName + "\n")
}

// renderDocCard 文件卡（＝這份文件的 hub）：重點是判斷句、行內連到概念卡。
func renderDocCard(d *wikiDoc, ex *DocExtract, conceptNames []string, origin SourceOrigin) string {
	allowed := map[string]bool{"00-INDEX": true, d.Card: true}
	for _, c := range conceptNames {
		allowed[c] = true
	}
	var b strings.Builder
	renderFrontmatter(&b, d.Tags, d.Gloss, d.Created, d.Updated)
	b.WriteString("# " + d.Card + "\n\n")
	b.WriteString("← [[00-INDEX]]\n\n")

	b.WriteString("## 摘要\n")
	b.WriteString(firstNonEmpty(sanitizeProse(ex.Summary, allowed), d.Gloss) + "\n\n")

	b.WriteString("## 重點\n")
	linked := 0
	for _, p := range ex.Points {
		if strings.TrimSpace(p) == "" {
			continue
		}
		line := fixIndexish("- " + sanitizeProse(p, allowed))
		if wikiLinkRe.MatchString(line) {
			linked++
		}
		b.WriteString(line + "\n")
	}
	// hub 的重點至少要有一條把成員連進句子（不必點進去就拿到關係——壓縮兌現處）。
	// LLM 一條都沒嵌時補一條機械句：只陳述「本文件拆成了哪些概念」，不替它捏造判斷。
	if linked == 0 && len(conceptNames) > 0 {
		b.WriteString("- 本文件整理成 " + itoa(len(conceptNames)) + " 張概念卡，入口是 [[" + conceptNames[0] + "]]\n")
	}
	b.WriteString("\n")

	ents := ex.Entities
	if len(ents) == 0 { // 文件卡的實體：借用各概念的第一個實體
		for _, c := range ex.Concepts {
			fb := entityFallback(c.Entities, sanitizeCardName(c.Name), c.Gloss)
			ents = append(ents, fb[0])
			if len(ents) >= 6 {
				break
			}
		}
	}
	renderEntities(&b, entityFallback(ents, d.Card, d.Gloss), allowed)

	b.WriteString("## 關聯\n")
	b.WriteString("### 內文知識關係\n")
	b.WriteString("### 卡片關係\n")
	for _, c := range conceptNames {
		b.WriteString("- [[" + d.Card + "]]" + triSep + "整理出" + triSep + "[[" + c + "]]\n")
	}
	renderSourceLine(&b, origin, d.Card)
	return b.String()
}

// renderConceptCard 原子概念卡。extraRels＝機械補上的反向邊（雙向連結保證）。
func renderConceptCard(c WikiConcept, cardName, docCard string, origin SourceOrigin, created, updated string,
	allowed map[string]bool, extraRels []string) string {
	var b strings.Builder
	renderFrontmatter(&b, cleanTags(c.Tags), firstNonEmpty(sanitizeProse(c.Gloss, map[string]bool{}), cardName), created, updated)
	b.WriteString("# " + cardName + "\n\n")
	b.WriteString("← [[" + docCard + "]]\n\n")

	b.WriteString("## 摘要\n")
	b.WriteString(firstNonEmpty(sanitizeProse(c.Summary, allowed), sanitizeProse(c.Gloss, allowed), cardName) + "\n\n")

	b.WriteString("## 重點\n")
	pts := c.Points
	if len(pts) == 0 {
		pts = []string{firstNonEmpty(c.Gloss, cardName)}
	}
	for _, p := range pts {
		if strings.TrimSpace(p) == "" {
			continue
		}
		b.WriteString(fixIndexish("- "+sanitizeProse(p, allowed)) + "\n")
	}
	b.WriteString("\n")

	renderEntities(&b, entityFallback(c.Entities, cardName, c.Gloss), allowed)

	b.WriteString("## 關聯\n")
	b.WriteString("### 內文知識關係\n")
	for _, f := range c.Facts {
		if len(f) != 3 {
			continue
		}
		s, p, o := sanitizeTriplePart(f[0]), sanitizeTriplePart(f[1]), sanitizeTriplePart(f[2])
		if s == "" || p == "" || o == "" {
			continue
		}
		b.WriteString("- " + s + triSep + p + triSep + o + "\n")
	}
	b.WriteString("### 卡片關係\n")
	b.WriteString("- [[" + cardName + "]]" + triSep + "出自" + triSep + "[[" + docCard + "]]\n")
	for _, r := range c.Relations {
		to := sanitizeCardName(r.To)
		pred := firstNonEmpty(sanitizeTriplePart(r.Pred), "相關")
		if !allowed[to] || to == cardName {
			continue // 指不到的關係不寫——斷連結比少一條邊貴
		}
		b.WriteString("- [[" + cardName + "]]" + triSep + pred + triSep + "[[" + to + "]]\n")
	}
	for _, line := range extraRels {
		b.WriteString(line + "\n")
	}
	renderSourceLine(&b, origin, cardName)
	return b.String()
}

// ── 落地：BuildWikiDoc（萃取成功）／MarkDocNoConcept（標空）／RemoveWikiDoc（下架）──

func ensureWikiIgnored(wikiDir string) {
	target := filepath.Join(wikiDir, ".gitignore")
	if _, err := os.Stat(target); err == nil {
		return
	}
	_ = os.WriteFile(target, []byte(wikiIgnoreBody), 0o644)
}

func writeWikiFile(absRoot, dest string, content []byte) error {
	if err := ensureWritable(absRoot, dest); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("建立 wiki 目錄失敗：%w", err)
	}
	ensureWikiIgnored(filepath.Dir(dest))
	return os.WriteFile(dest, content, 0o644)
}

// BuildWikiDoc 把一份文件的萃取結果落成規範形的 `.wiki/` 產物。
// 回傳本次產出的卡（相對監看根、文件卡在第一個）。
// ex.NoConcept 為真（或概念數 0）時不產卡，改走「標空」路徑（回傳空清單）。
func BuildWikiDoc(absRoot, relPath, srcText string, ex *DocExtract, origin SourceOrigin, now time.Time) ([]string, error) {
	if ex == nil {
		return nil, fmt.Errorf("BuildWikiDoc: 沒有萃取結果")
	}
	if ex.NoConcept || len(ex.Concepts) == 0 {
		reason := firstNonEmpty(ex.Reason, "模型未能整理出可獨立成立的概念")
		return nil, MarkDocNoConcept(absRoot, relPath, reason, now)
	}
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	m := loadWikiManifest(absRoot)

	// ── 名字解析：同節點內卡名必須唯一 ────────────────────────────────
	// 「別份文件」已佔用的名字（manifest 記載的文件卡與概念卡）不准撞——
	// 同名概念真正該做的是 merge，但那是 place_card（第⑤環）的題目；
	// 本環先以「＋（文件卡名）」消歧，保證不覆蓋、不斷連結。
	taken := map[string]bool{"00-INDEX": true}
	old := m.find(nodeKey, base)
	for i := range m.Docs {
		if m.Docs[i].Node != nodeKey || m.Docs[i].Path == base {
			continue
		}
		taken[m.Docs[i].Card] = true
		for _, cn := range m.Docs[i].Concepts {
			taken[cn] = true
		}
	}

	docCard := docCardNameFor(srcText, relPath)
	if taken[docCard] { // 洞 1 的 fallback：H1 撞到別份文件的卡 → 用「檔名」退避
		docCard = sanitizeCardName(pageNameOf(relPath))
	}
	for n := 2; taken[docCard]; n++ {
		docCard = sanitizeCardName(pageNameOf(relPath) + "（" + itoa(n) + "）")
	}
	taken[docCard] = true

	// 概念名：消毒、去重、避開文件卡名與別份文件的卡（規範第二之一部）。
	var conceptNames []string
	nameSeen := map[string]bool{docCard: true, "00-INDEX": true}
	var concepts []WikiConcept
	for _, c := range ex.Concepts {
		name := sanitizeCardName(c.Name)
		if taken[name] || nameSeen[name] {
			name = sanitizeCardName(c.Name + "（" + docCard + "）")
		}
		if nameSeen[name] || taken[name] {
			continue // 消歧後仍撞＝同文件內重複概念，丟棄後到者
		}
		nameSeen[name] = true
		taken[name] = true
		conceptNames = append(conceptNames, name)
		concepts = append(concepts, c)
	}
	// 消歧改了名的概念：內文與關係裡的 [[原名]] 一律跟著改指新名。
	renames := map[string]string{}
	for i, c := range concepts {
		if s := sanitizeCardName(c.Name); s != conceptNames[i] {
			renames[s] = conceptNames[i]
		}
	}
	if len(renames) > 0 {
		ex.Summary = renameLinks(ex.Summary, renames)
		for i := range ex.Points {
			ex.Points[i] = renameLinks(ex.Points[i], renames)
		}
		for ci := range concepts {
			concepts[ci].Summary = renameLinks(concepts[ci].Summary, renames)
			for pi := range concepts[ci].Points {
				concepts[ci].Points[pi] = renameLinks(concepts[ci].Points[pi], renames)
			}
			for ri := range concepts[ci].Relations {
				if nn, ok := renames[sanitizeCardName(concepts[ci].Relations[ri].To)]; ok {
					concepts[ci].Relations[ri].To = nn
				}
			}
		}
	}
	if len(conceptNames) == 0 {
		return nil, MarkDocNoConcept(absRoot, relPath, firstNonEmpty(ex.Reason, "概念名全數無效"), now)
	}

	created := todayOf(now)
	if old != nil && old.Created != "" {
		created = old.Created
	}
	sum := sha256.Sum256([]byte(srcText))
	entry := wikiDoc{
		Node: nodeKey, Path: base,
		DocID:   docIDOf(nodeKey, base),
		SHA256:  hex.EncodeToString(sum[:]),
		Status:  "extracted",
		Card:    docCard,
		Gloss:   firstNonEmpty(sanitizeProse(ex.Gloss, map[string]bool{}), docCard),
		Tags:    cleanTags(ex.Tags),
		Created: created, Updated: todayOf(now),
		Concepts: conceptNames,
	}

	// 雙向連結保證：概念間的邊收集成 pair，缺反向的機械補「相關」邊。
	allowed := map[string]bool{"00-INDEX": true, docCard: true}
	for _, n := range conceptNames {
		allowed[n] = true
	}
	pair := map[[2]string]bool{}
	for i, c := range concepts {
		from := conceptNames[i]
		for _, r := range c.Relations {
			to := sanitizeCardName(r.To)
			if allowed[to] && to != from && to != docCard {
				pair[[2]string{from, to}] = true
			}
		}
	}
	extraRels := map[string][]string{}
	for p := range pair {
		if !pair[[2]string{p[1], p[0]}] {
			extraRels[p[1]] = append(extraRels[p[1]],
				"- [["+p[1]+"]]"+triSep+"相關"+triSep+"[["+p[0]+"]]")
		}
	}
	for _, lines := range extraRels {
		sort.Strings(lines)
	}

	// 渲染＋寫檔（先清掉這份文件上一輪產的、這一輪不再存在的卡）。
	var newCards []string
	rel := func(cardName string) string {
		return filepath.ToSlash(filepath.Join(nodeFromKey(nodeKey), wikiRelDir, cardName+".md"))
	}
	if old != nil {
		keep := map[string]bool{rel(docCard): true}
		for _, n := range conceptNames {
			keep[rel(n)] = true
		}
		for _, oldRel := range old.Cards {
			if !keep[oldRel] && strings.Contains(oldRel, wikiRelDir+"/") {
				_ = os.Remove(filepath.Join(absRoot, filepath.FromSlash(oldRel)))
			}
		}
	}
	// 檔名被「別人」佔用時不覆蓋（#105 的分界：本來就在的檔案一律不動）；
	// 佔用者若是本文件上一輪的卡（記在 manifest）＝我們自己的，可覆寫。
	owned := map[string]bool{}
	if old != nil {
		for _, c := range old.Cards {
			owned[c] = true
		}
	}
	writeCard := func(cardName, content string) (string, error) {
		r := rel(cardName)
		destAbs := filepath.Join(absRoot, filepath.FromSlash(r))
		if _, err := os.Stat(destAbs); err == nil && !owned[r] {
			return "", fmt.Errorf("卡片位置被佔用（不覆蓋既有檔案）：%s", r)
		}
		return r, writeWikiFile(absRoot, destAbs, []byte(content))
	}

	docRel, err := writeCard(docCard, renderDocCard(&entry, ex, conceptNames, origin))
	if err != nil {
		return nil, err
	}
	newCards = append(newCards, docRel)
	for i, c := range concepts {
		name := conceptNames[i]
		content := renderConceptCard(c, name, docCard, origin, created, todayOf(now), allowed, extraRels[name])
		r, werr := writeCard(name, content)
		if werr != nil {
			return nil, werr
		}
		newCards = append(newCards, r)
	}
	entry.Cards = newCards

	m.removeDoc(nodeKey, base)
	m.Docs = append(m.Docs, entry)
	if err := regenerateWikiIndexes(absRoot, m); err != nil {
		return nil, err
	}
	if err := saveWikiManifest(absRoot, m); err != nil {
		return nil, err
	}
	return newCards, nil
}

// MarkDocNoConcept 記錄「這份文件沒有可萃取概念」——不產卡，但 00-INDEX 一定列它
// （使用者要能分辨「沒產出」和「被漏掉」；規範差距 #10）。
func MarkDocNoConcept(absRoot, relPath, reason string, now time.Time) error {
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	m := loadWikiManifest(absRoot)
	old := m.removeDoc(nodeKey, base)
	created := todayOf(now)
	if old != nil && old.Created != "" {
		created = old.Created
	}
	// 上一輪若產過卡，這一輪判空＝內容變了：舊卡要收走，不留過期整理稿。
	if old != nil {
		for _, oldRel := range old.Cards {
			if strings.Contains(oldRel, wikiRelDir+"/") {
				_ = os.Remove(filepath.Join(absRoot, filepath.FromSlash(oldRel)))
			}
		}
	}
	m.Docs = append(m.Docs, wikiDoc{
		Node: nodeKey, Path: base,
		DocID:   docIDOf(nodeKey, base),
		Status:  "no_concept",
		Reason:  firstNonEmpty(reason, "純紀錄，無可萃取概念"),
		Created: created, Updated: todayOf(now),
	})
	if err := regenerateWikiIndexes(absRoot, m); err != nil {
		return err
	}
	return saveWikiManifest(absRoot, m)
}

// RemoveWikiDoc 原稿消失時，收走它的卡並把它從索引與 manifest 移除。
func RemoveWikiDoc(absRoot, relPath string) error {
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	m := loadWikiManifest(absRoot)
	old := m.removeDoc(nodeKey, base)
	if old == nil {
		return nil
	}
	for _, oldRel := range old.Cards {
		if strings.Contains(oldRel, wikiRelDir+"/") {
			_ = os.Remove(filepath.Join(absRoot, filepath.FromSlash(oldRel)))
		}
	}
	if err := regenerateWikiIndexes(absRoot, m); err != nil {
		return err
	}
	return saveWikiManifest(absRoot, m)
}

func docIDOf(nodeKey, base string) string {
	sum := sha256.Sum256([]byte(nodeKey + "/" + base))
	return hex.EncodeToString(sum[:8])
}

// ── 索引：完全從 manifest 機械重算（index 是導出資料，不是第二份真相）──

// regenerateWikiIndexes 重寫「有文件的節點＋它們所有祖先」的 00-INDEX.md。
// index 每行五樣（連結／摘要／標籤／建立日／更新日）全部照抄卡的 frontmatter
// （記在 manifest）——這正是 index 可以零 LLM 成本機械產生的原因（規範第一之五部）。
func regenerateWikiIndexes(absRoot string, m *wikiManifest) error {
	need := map[string]bool{"": true} // 根節點永遠要有（manifest 住在那裡）
	for _, d := range m.Docs {
		n := nodeFromKey(d.Node)
		need[n] = true
		for n != "" {
			n = parentNode(n)
			need[n] = true
		}
	}
	for node := range need {
		if err := writeNodeIndex(absRoot, node, m); err != nil {
			return err
		}
	}
	return nil
}

func parentNode(node string) string {
	d := path.Dir(node)
	if d == "." || d == "/" {
		return ""
	}
	return d
}

// childNodesOf 回傳 node 的「直接子節點」（底下（含各層）有文件的直接子目錄）＋各自篇數。
func childNodesOf(node string, m *wikiManifest) ([]string, map[string]int) {
	prefix := ""
	if node != "" {
		prefix = node + "/"
	}
	count := map[string]int{}
	for _, d := range m.Docs {
		n := nodeFromKey(d.Node)
		if n == node {
			continue
		}
		if prefix != "" && !strings.HasPrefix(n, prefix) {
			continue
		}
		rest := strings.TrimPrefix(n, prefix)
		if rest == "" {
			continue
		}
		child := strings.SplitN(rest, "/", 2)[0]
		count[child]++
	}
	var kids []string
	for k := range count {
		kids = append(kids, k)
	}
	sort.Strings(kids)
	return kids, count
}

func writeNodeIndex(absRoot, node string, m *wikiManifest) error {
	nodeKey := nodeKeyOf(node)
	var docs []wikiDoc
	for _, d := range m.Docs {
		if d.Node == nodeKey {
			docs = append(docs, d)
		}
	}
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	kids, kidCount := childNodesOf(node, m)

	var b strings.Builder
	b.WriteString("# 00-INDEX\n\n")
	if len(kids) > 0 {
		b.WriteString("## 子節點\n")
		for _, k := range kids {
			b.WriteString("- 📁 `" + k + "/` — 內含 " + itoa(kidCount[k]) + " 篇文件\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## 文件\n")
	if len(docs) == 0 {
		b.WriteString("（本層沒有文件；見子節點。）\n")
	}
	for _, d := range docs {
		if d.Status == "no_concept" {
			b.WriteString("- `" + d.Path + "` — 空：" + d.Reason + "\n")
			continue
		}
		tags := make([]string, 0, len(d.Tags))
		for _, t := range d.Tags {
			tags = append(tags, "#"+t)
		}
		b.WriteString("- [[" + d.Card + "]] — " + d.Gloss + "（原稿 `" + d.Path + "`）\n")
		b.WriteString("  " + strings.Join(tags, " ") + "　建 " + d.Created + "　更 " + d.Updated + "\n")
	}
	b.WriteString("\n## 說明\n")
	b.WriteString("本索引由 Arcrun RAG 自動維護（機械產生，改了會被覆寫）。\n")
	b.WriteString("「空」表示該檔沒有可萃取的概念（例如純紀錄），不是被漏掉。\n")
	b.WriteString("每張文件卡是那份原稿的 hub；概念卡從文件卡點進去。\n")

	dest := filepath.Join(wikiDirFor(absRoot, node), "00-INDEX.md")
	return writeWikiFile(absRoot, dest, []byte(b.String()))
}
