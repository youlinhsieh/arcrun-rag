// passages.go — inkstone/arcrun-rag#296：敘述類原稿「先切段進向量層，不先萃成卡」。
//
// 來源：inkstone/InkStoneCo#275 的 ADR（知識按需沉澱）。一句話：
//
//	敘述類文件＝原稿切段進向量層（有人問到才沉澱成卡）；
//	表格類與被宣告為關鍵的資料夾＝照舊入庫時就預先編譯（錯誤碼走 InkStoneCo#264）。
//
// 這支只管「小幫手這一側」的三件事：
//
//	① 判型（classifyDocKind／passageRouteFor）：這份檔走新路還是舊路。
//	② 切段（chunkNarrative）：把轉好的文字切成帶標題脈絡的段落，機械、不呼叫 LLM。
//	③ 送出（pushPassages／trimPassages）：一批一批打雲端 rag_ingest_passages，
//	   **同一份原稿的段落 id 由路徑決定、與內容無關**——改版就是原地覆寫，不會長出新副本，
//	   舊版比新版長的尾巴由 trim 刪掉；下架就是把 0..n-1 全刪。
//
// 🔴 不變的部分（票上明寫）：技師判型與工班轉 md（convert*.go、ConvertToTextReport）一個字沒動；
// 現有已萃的卡完全不動——**只有「從沒送上去過」的檔才走新路**（見 passageRouteFor）。
// 🔴 重工作在雲端：嵌入（Workers AI／Ollama）由雲端 KBDB 寫入時做，小幫手只切段、只轉發，
// 不持有任何模型金鑰，也不在使用者的 Mac 上跑任何向量運算。
// 🔴 機敏值：段落送出前一樣過 redactSecretText／redactPersonalIDs（#294／#251）——
// 原稿以前是「只送卡、原文不出機」，新路要送段落，所以這一道是新路的第一道閘，不是可選項。
package collector

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// 文件形狀。
type docKind string

const (
	docKindNarrative docKind = "narrative" // 敘述類：走向量層
	docKindTable     docKind = "table"     // 表格類：照舊預先編譯
)

// 路由值（config.narrative_route）。
const (
	narrativeRoutePassages = "passages" // 新檔的敘述類先切段進向量層
	narrativeRouteCards    = "cards"    // 與改版前一致：一律萃卡
)

// passageChunkerRev＝切段規則的世代。改切法時加一，metadata 會記，之後可以只重切舊世代的。
const passageChunkerRev = 1

const (
	// passageTargetRunes＝一段的目標長度（字元，不是位元組）。
	// 依據：bge-m3 對 500～1000 字的中文段落排序最穩；再長一段裡混進多個主題、
	// 再短脈絡不夠。沒有拿真實語料量過，所以是起點不是定論——世代號（passageChunkerRev）就是留給調它用的。
	passageTargetRunes = 700
	// passageMaxRunes＝硬上限：單一段落（沒有空行的一大坨）超過就在句界切開。
	passageMaxRunes = 1100
	// passageMinRunes＝標題換了但前一段還不到這個長度，就先不切（避免一個標題一段的碎屑）。
	passageMinRunes = 150
	// passagesPerCall＝一次呼叫雲端最多寫幾段。雲端每段一個 PUT（引擎對外連線並行 6，
	// 約 0.35 秒／段，見 cardslice.go 的量測），20 段約 7 秒，離 writeBudget 很遠。
	passagesPerCall = 20
	// passageTrimPerCall＝一次呼叫雲端最多刪幾段。
	passageTrimPerCall = 40
)

// Passage＝一段原稿。Idx 從 0 起，段落 id 由（機器、庫、路徑、Idx）決定。
type Passage struct {
	Idx     int    `json:"idx"`
	ID      string `json:"id"`
	Heading string `json:"heading"` // 「頁名 › 章 › 節」，沒有標題層級時只有頁名
	Text    string `json:"text"`    // 要被嵌入與引用的內容（第一行是 Heading）
}

// passageIDPrefix＝同一份原稿（機器＋庫＋路徑）所有段落共用的前綴。
// 用 sha1 前 16 碼：不把路徑明文塞進 id（CJK／斜線進 URL 的麻煩），也讓 id 能被雲端用固定格式驗證。
func passageIDPrefix(machine, library, path string) string {
	h := sha1.Sum([]byte(machine + "\x00" + library + "\x00" + path))
	return "psg-" + hex.EncodeToString(h[:8])
}

// passageID＝第 idx 段的 id。**與內容無關**：改版覆寫同一組 id（見檔頭）。
func passageID(machine, library, path string, idx int) string {
	return fmt.Sprintf("%s-%d", passageIDPrefix(machine, library, path), idx)
}

// ── 判型 ─────────────────────────────────────────────────────────────────

// tableExts＝一看副檔名就知道是表格的格式（convert_table.go 轉的那幾種）。
var tableExts = map[string]bool{".csv": true, ".tsv": true, ".xlsx": true, ".xls": true}

// classifyDocKind 依「副檔名＋轉好的文字長相」判型。
//
// 為什麼只看這兩樣：正式的「技師勘查」（InkStoneCo#264）是在資料夾掛上時由 agent 做的，
// 它的結論要到 #264 落地才會存進設定；在那之前小幫手只認得**結構訊號**——
// 副檔名是表格、或內文大半是表格列。看不出來就當敘述類（錯判成敘述類的代價是
// 「這份表格也能被向量查到原稿段落」，不是資料不見）。
func classifyDocKind(relPath, text string) docKind {
	if tableExts[strings.ToLower(filepath.Ext(relPath))] {
		return docKindTable
	}
	if looksTabular(text) {
		return docKindTable
	}
	return docKindNarrative
}

// looksTabular：非空行裡 ≥ 60% 是 Markdown 表格列（以 | 起頭），且至少 8 列。
func looksTabular(text string) bool {
	rows, total := 0, 0
	for _, ln := range strings.Split(text, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" {
			continue
		}
		total++
		if strings.HasPrefix(t, "|") && strings.Count(t, "|") >= 2 {
			rows++
		}
	}
	return rows >= 8 && rows*100 >= total*60
}

// isCriticalFolder：這份檔所在的位置有沒有被管理者宣告為「關鍵」（照舊預先編譯）。
// critical 裡的項目可以是絕對路徑（資料夾）或相對於監看根的路徑前綴；以路徑邊界比對
// （「財務」不會誤中「財務部備份」）。
func isCriticalFolder(critical []string, absRoot, relPath string) bool {
	rel := strings.Trim(filepath.ToSlash(relPath), "/")
	abs := filepath.ToSlash(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	for _, c := range critical {
		c = strings.TrimSpace(filepath.ToSlash(c))
		if c == "" {
			continue
		}
		c = strings.TrimRight(c, "/")
		if filepath.IsAbs(filepath.FromSlash(c)) {
			if abs == c || strings.HasPrefix(abs, c+"/") {
				return true
			}
			continue
		}
		c = strings.TrimLeft(c, "/")
		if c == "" || rel == c || strings.HasPrefix(rel, c+"/") {
			return true
		}
	}
	return false
}

// passageRouteFor 決定一份檔這一輪走哪條路。回 (true, "") ＝ 新路；(false, 原因) ＝ 照舊萃卡。
//
// 條件缺一不可（任何一個不成立就是舊路，一張卡都不會少）：
//  1. config.narrative_route == "passages"（預設不開：先和大前驗收並行，不改他們眼前的行為）
//  2. 沒被宣告為關鍵資料夾
//  3. 副檔名不是表格
//  4. 這份檔**不是已經走卡片路送上去過的**——「現有已萃的卡完全不動；新機制只用在新丟進來的檔案」
//     （判斷＝manifest 有 IngestedHash 且沒有 PassageMode）。已經走過新路的檔繼續走新路。
//
// 轉好文字之後的第二道判型（內文大半是表格）由呼叫端再看一次 classifyDocKind。
func (c *DirectConfig) passageRouteFor(absRoot, relPath string, e *ManifestEntry) (bool, string) {
	if strings.TrimSpace(c.NarrativeRoute) != narrativeRoutePassages {
		return false, "narrative_route 未設為 passages"
	}
	if isCriticalFolder(c.CriticalFolders, absRoot, relPath) {
		return false, "關鍵資料夾，照舊預先編譯"
	}
	if tableExts[strings.ToLower(filepath.Ext(relPath))] {
		return false, "表格類，照舊預先編譯"
	}
	if e != nil && strings.TrimSpace(e.IngestedHash) != "" && !e.PassageMode {
		return false, "這份檔先前已經萃成卡，不動它"
	}
	return true, ""
}

// ── 切段 ─────────────────────────────────────────────────────────────────

// chunkNarrative 把一份文件的文字切成段落。純函式、不呼叫任何服務。
//
// 規則（對應 passageTargetRunes 等常數）：
//   - 以空行分「區塊」；Markdown 標題行更新「標題路徑」，不單獨成段。
//   - 連續區塊累積到目標長度就收一段；標題路徑一換、且手上已有 passageMinRunes 以上就先收。
//   - 一個區塊本身超過上限，在句界（。！？；.!? 換行）切開，實在沒有句界就硬切。
//   - 表格列、程式碼塊不會被切到一半——它們沒有空行，天然落在同一個區塊裡；
//     區塊過長時才走上一條。
//
// 每段的第一行是標題路徑（「頁名 › 章 › 節」）：向量嵌入的是這一整段，帶著章節脈絡比光禿禿的段落好找。
func chunkNarrative(pageName, text string) []Passage {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	type block struct {
		heading string
		text    string
	}
	var blocks []block
	var heads []string // 目前的標題堆疊（index＝層級-1）
	curHeading := func() string {
		parts := []string{pageName}
		for _, h := range heads {
			if h != "" {
				parts = append(parts, h)
			}
		}
		return strings.Join(parts, " › ")
	}

	var cur []string
	inFence := false
	flush := func() {
		if len(cur) == 0 {
			return
		}
		t := strings.TrimSpace(strings.Join(cur, "\n"))
		cur = nil
		if t != "" {
			blocks = append(blocks, block{heading: curHeading(), text: t})
		}
	}
	for _, ln := range strings.Split(text, "\n") {
		trim := strings.TrimSpace(ln)
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			inFence = !inFence
		}
		if !inFence {
			if lvl, title := mdHeading(trim); lvl > 0 {
				flush()
				if lvl > len(heads) {
					for len(heads) < lvl {
						heads = append(heads, "")
					}
				}
				heads = heads[:lvl]
				heads[lvl-1] = title
				continue
			}
			if trim == "" {
				flush()
				continue
			}
		}
		cur = append(cur, ln)
	}
	flush()

	var out []Passage
	var buf []string
	bufRunes := 0
	bufHeading := ""
	emit := func() {
		if len(buf) == 0 {
			return
		}
		body := strings.Join(buf, "\n\n")
		out = append(out, Passage{Idx: len(out), Heading: bufHeading, Text: bufHeading + "\n" + body})
		buf, bufRunes, bufHeading = nil, 0, ""
	}
	for _, b := range blocks {
		pieces := splitLong(b.text, passageMaxRunes)
		for _, p := range pieces {
			n := utf8.RuneCountInString(p)
			if len(buf) > 0 && (bufRunes+n > passageTargetRunes ||
				(b.heading != bufHeading && bufRunes >= passageMinRunes)) {
				emit()
			}
			if len(buf) == 0 {
				bufHeading = b.heading
			}
			buf = append(buf, p)
			bufRunes += n
		}
	}
	emit()
	return out
}

// mdHeading：`# 標題`～`###### 標題`。回 (層級, 標題)；不是標題回 (0, "")。
func mdHeading(trim string) (int, string) {
	if !strings.HasPrefix(trim, "#") {
		return 0, ""
	}
	n := 0
	for n < len(trim) && trim[n] == '#' {
		n++
	}
	if n > 6 || n >= len(trim) || (trim[n] != ' ' && trim[n] != '\t') {
		return 0, ""
	}
	title := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(trim[n:]), "#"))
	if title == "" {
		return 0, ""
	}
	return n, title
}

// splitLong 把超過 max 字的區塊在句界切開（切不開就硬切）。不超過就原樣回傳。
func splitLong(s string, max int) []string {
	if utf8.RuneCountInString(s) <= max {
		return []string{s}
	}
	var out []string
	var sb strings.Builder
	n := 0
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		sb.WriteRune(rs[i])
		n++
		boundary := rs[i] == '。' || rs[i] == '！' || rs[i] == '？' || rs[i] == '；' || rs[i] == '\n' ||
			((rs[i] == '.' || rs[i] == '!' || rs[i] == '?') && (i+1 >= len(rs) || rs[i+1] == ' ' || rs[i+1] == '\n'))
		// 過了目標長度的 2/3 才認句界（太早切會切出一堆碎片），到上限一定切。
		if (boundary && n >= max*2/3) || n >= max {
			out = append(out, strings.TrimSpace(sb.String()))
			sb.Reset()
			n = 0
		}
	}
	if t := strings.TrimSpace(sb.String()); t != "" {
		out = append(out, t)
	}
	return out
}

// assignPassageIDs 幫切好的段落配上 id（機器＋庫＋路徑決定）。
func assignPassageIDs(ps []Passage, machine, library, path string) {
	for i := range ps {
		ps[i].ID = passageID(machine, library, path, ps[i].Idx)
	}
}

// ── 送出 ─────────────────────────────────────────────────────────────────

// passageBatches 把段落切成每批最多 passagesPerCall 段。
func passageBatches(ps []Passage) [][]Passage {
	var out [][]Passage
	for i := 0; i < len(ps); i += passagesPerCall {
		j := i + passagesPerCall
		if j > len(ps) {
			j = len(ps)
		}
		out = append(out, ps[i:j])
	}
	return out
}

// passageDeleteIDs 回 [from, to) 的段落 id，每批最多 passageTrimPerCall 個。
func passageDeleteIDs(machine, library, path string, from, to int) [][]string {
	var out [][]string
	for i := from; i < to; i += passageTrimPerCall {
		j := i + passageTrimPerCall
		if j > to {
			j = to
		}
		ids := make([]string, 0, j-i)
		for k := i; k < j; k++ {
			ids = append(ids, passageID(machine, library, path, k))
		}
		out = append(out, ids)
	}
	return out
}

// passageWF＝雲端收段落的 workflow 名。
func (c *DirectConfig) passageWF() string {
	if strings.TrimSpace(c.PassageIngestWF) != "" {
		return c.PassageIngestWF
	}
	return "rag_ingest_passages"
}

// passageBody 組一批「寫入」的請求（passages 與 delete_ids 可以同時有，雲端兩件都做）。
func passageBody(path, pageName, library, machine, machineLabel, sourceHash string, total int, batch []Passage, deleteIDs []string) map[string]any {
	items := make([]map[string]any, 0, len(batch))
	for _, p := range batch {
		items = append(items, map[string]any{"id": p.ID, "idx": p.Idx, "heading": p.Heading, "content": p.Text})
	}
	if deleteIDs == nil {
		deleteIDs = []string{} // JSON 送 [] 不送 null，雲端不用猜
	}
	return map[string]any{
		"path":          path,
		"page_name":     pageName,
		"library":       library,
		"machine":       machine,
		"machine_label": machineLabel,
		"source_hash":   sourceHash,
		"chunker_rev":   passageChunkerRev,
		"total":         total,
		"passages":      items,
		"delete_ids":    deleteIDs,
	}
}

// pushPassages 把一份文件的段落送上雲，再把「舊版比新版多出來的尾巴」刪掉。
//
// 送的順序＝**第 0 段最後送**（同 cardslice.go 的「提交標記」想法）：
// 第 0 段帶著這一版的 source_hash，等於整份的「新版已就緒」章；
// 中途斷掉時第 0 段還是舊版，下一輪（manifest 沒蓋章）會整份重送，結果一樣。
// post 由呼叫端傳入（讓測試不必起網路、正式路徑帶上節流與退避）。
func (c *DirectConfig) pushPassages(
	post func(body map[string]any) (int, error),
	path, pageName, library, machine, machineLabel, sourceHash string,
	ps []Passage, prevCount int,
) error {
	batches := passageBatches(ps)
	var tail [][]string
	if prevCount > len(ps) {
		tail = passageDeleteIDs(machine, library, path, len(ps), prevCount)
	}
	// 由後往前送（第 0 批最後）。尾巴的刪除搭在最後一批前面獨立送，確定新段都寫成了再刪舊的。
	for i := len(batches) - 1; i >= 0; i-- {
		if _, err := post(passageBody(path, pageName, library, machine, machineLabel, sourceHash, len(ps), batches[i], nil)); err != nil {
			return fmt.Errorf("送出第 %d/%d 批原稿段落失敗：%w", len(batches)-i, len(batches), err)
		}
	}
	for _, ids := range tail {
		if _, err := post(passageBody(path, pageName, library, machine, machineLabel, sourceHash, len(ps), nil, ids)); err != nil {
			return fmt.Errorf("刪除舊版多出來的段落失敗：%w", err)
		}
	}
	return nil
}

// trimPassages 刪掉一份原稿的 [0, count) 段（下架／改名搬移）。
func (c *DirectConfig) trimPassages(
	post func(body map[string]any) (int, error),
	path, pageName, library, machine, machineLabel string, count int,
) error {
	for _, ids := range passageDeleteIDs(machine, library, path, 0, count) {
		if _, err := post(passageBody(path, pageName, library, machine, machineLabel, "", 0, nil, ids)); err != nil {
			return fmt.Errorf("下架原稿段落失敗：%w", err)
		}
	}
	return nil
}

// passageSourceText 取「要切段的文字」：與萃取同一條轉檔＋讀圖＋遮蔽路（extract_workersai.go 開頭那一段），
// 差別只在這裡不把文字送去 LLM。回傳的文字已過 redactSecretText（#294）。
//
// 讀不出文字（掃描檔、空檔）回錯，由呼叫端照一般失敗處理（退避、顯示原因），不默默略過。
func passageSourceText(cfg *DirectConfig, absRoot, relPath string, raw []byte) (string, error) {
	srcText, readRep, err := ConvertToTextReport(relPath, raw)
	srcText, _ = redactSecretText(srcText, IsPlainText(relPath))
	if (err == nil || isNoTextErr(err)) && readRep != nil && len(readRep.ImagePageNums) > 0 &&
		strings.TrimSpace(cfg.CypherURL) != "" && strings.TrimSpace(cfg.APIKey) != "" {
		rd := cachedImageReader(filepath.Join(wikiDirFor(absRoot, ""), ".imageread-cache"),
			cloudImageReader(imageReadHTTP, workersAIReadImageURL(cfg.CypherURL), cfg.APIKey))
		if res, rerr := readPDFImages(raw, readRep, pageNameOf(relPath), rd); rerr == nil && res != nil {
			if t := res.Text(); t != "" {
				if strings.TrimSpace(srcText) == "" {
					srcText = t
				} else {
					srcText = srcText + "\n\n" + t
				}
				err = nil
			}
		}
	}
	if err != nil {
		return "", fmt.Errorf("轉檔失敗（%s）：%w", relPath, err)
	}
	srcText, _ = redactSecretText(srcText, false) // 讀圖補進來的文字
	srcText, _ = redactPersonalIDs(srcText)
	if strings.TrimSpace(srcText) == "" {
		return "", fmt.Errorf("轉檔後沒有文字（%s）", relPath)
	}
	return srcText, nil
}

// passagePoster 回「把一批請求打到雲端 rag_ingest_passages」的函式（帶節流、退避、逾時記帳，同送卡那條路）。
func (c *DirectConfig) passagePoster(step callStep, file string, retry bool) func(body map[string]any) (int, error) {
	return func(body map[string]any) (int, error) {
		status, _, err := c.postJSONAs(step, c.triggerURL(c.passageWF()), body, retry)
		return status, err
	}
}

// ingestPassagesOf＝新路的整套：取文字（轉檔＋讀圖＋遮蔽）→ 第二道判型 → 切段 → 送出。
// 回 (段數, 判型, 錯誤)。判型為表格時什麼都沒送，呼叫端改走舊路。
func (c *DirectConfig) ingestPassagesOf(step callStep, absRoot, relPath string, raw []byte, sourceHash string, prevCount int, retry bool) (int, docKind, error) {
	text, err := passageSourceText(c, absRoot, relPath, raw)
	if err != nil {
		return 0, docKindNarrative, err
	}
	if classifyDocKind(relPath, text) == docKindTable {
		return 0, docKindTable, nil
	}
	mach := c.machineIdentity()
	lib := c.libraryFor(absRoot)
	ps := chunkNarrative(pageNameOf(relPath), text)
	if len(ps) == 0 {
		return 0, docKindNarrative, fmt.Errorf("切不出任何段落（%s）", relPath)
	}
	assignPassageIDs(ps, mach.ID, lib, relPath)
	err = c.pushPassages(c.passagePoster(step, relPath, retry), relPath, pageNameOf(relPath), lib, mach.ID, mach.Label, sourceHash, ps, prevCount)
	return len(ps), docKindNarrative, err
}
