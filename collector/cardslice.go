// cardslice.go — inkstone/arcrun-rag#255：「送出一份筆記」不再撞逾時。
//
// 量到的事實（youlin stage 實送、leo21c／geek6688 的 /workflows/rag_ingest_card/executions）：
//
//	① 雲端寫一條三元組約 2 秒，引擎對外連線硬上限 6 條並行 ⇒ 牆鐘約 0.35 秒／條。
//	   148 條的 NRI 文件卡＝59 秒（stage）；1,218 條的錯誤碼總表＝28 分鐘。收的人 300 秒就放棄。
//	② 一份文件的文件卡與概念卡共用同一個 source_uri（kb://<原稿路徑>），雲端卻按 source_uri
//	   整批撈「舊的三元組」⇒ 每張卡都把同一份文件其他卡的三元組當自己的舊資料刪光再重寫
//	   （實證：leo21c 上 NRI 的概念卡 block 都在、三元組是 0；每張概念卡 110～140 秒）。
//
// 所以：
//
//	· 概念卡的三元組有自己的名字（triplet_scope＝c.<頁名>），文件卡本人沿用 ''（與從前一樣）。
//	· 關係條數多的卡切成幾段送（rel_offset／rel_limit），每一段各有自己的名字（s1、s2…），
//	  一次呼叫的雲端工作量就有上限，不靠拉長逾時硬等。
//	· **送的順序是從最後一段往前，第一段最後送**：第一段負責 block，block 上的指紋就是整份的
//	  「提交標記」——中途斷掉時標記還沒蓋，下一輪各段都會被判成有變而重寫（見
//	  workflows/rag-ingest-card.local.yaml 的 pick_stale）。
//
// 舊版雲端（還沒有這個工作流）看不懂 rel_offset／rel_limit：切段送過去每一段都會把整張卡
// 全寫一遍。所以切段只在雲端版本夠新時才做；不夠新就跟從前一樣整張一發。
package collector

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// relsPerCall＝一次呼叫最多寫幾條關係。
//
// 為什麼是 50（youlin stage 實送 NRI 文件卡，同一份卡 148 條）：
//
//	第一次寫 100 條（含 10 個 block）          53 秒
//	內容改過、要「刪 110 條再寫 110 條」        134 秒  ← 決定上限的是這個，不是第一次寫
//
// 正式版的雲端慢約 1.8 倍（同樣的小卡 stage 14 秒、leo21c 25 秒），所以 100 條的重寫約 240 秒，
// 離 writeBudget（300 秒）只剩一點點；50 條的重寫約 120 秒，有 2.5 倍餘裕。
// 切得更細就是每段的固定成本（撈舊資料＋四個常數格，約 5 秒）被放大，得不償失。
const relsPerCall = 50

// slicedNoteRelease＝雲端第一個看得懂 triplet_scope／rel_offset／rel_limit 的版本。
const slicedNoteRelease = "1.4.103"

// cloudHasSlicedNotes＝這個雲端版本能接分段的卡（""、舊日期格式、比 1.4.103 舊 ⇒ false）。
func cloudHasSlicedNotes(version string) bool {
	head := strings.TrimSpace(strings.SplitN(version, "+", 2)[0])
	return isSemverLike(head) && compareSemver(head, slicedNoteRelease) >= 0
}

var (
	// 與 workflows/rag-ingest-card.local.yaml 的 parse_card／prep 同一條規則：
	//   `##\s*關聯\s*\n([\s\S]*?)(?=\n#{1,2}(?!#)\s|\n---|$)`
	// Go 沒有 lookahead，所以先找標題、再找結尾。`\n#{1,2}(?!#)\s` ＝換行＋1～2 個 # ＋空白字元。
	relHeadRe = regexp.MustCompile(`##\s*關聯\s*\n`)
	relEndRe  = regexp.MustCompile(`\n(?:#{1,2}\s|---)`)
	relLineRe = regexp.MustCompile(`^\s*(?:[-*]\s*)?(.+?)\s*>>\s*(.+?)\s*>>\s*(.+?)\s*$`)
)

// countCardRelations＝雲端會從這張卡解析出幾條三元組（「## 關聯」底下的 A >> B >> C，
// 加上雲端自己補的一條 part_of）。
func countCardRelations(md string) int {
	n := 1 // part_of
	loc := relHeadRe.FindStringIndex(md)
	if loc == nil {
		return n
	}
	body := md[loc[1]:]
	if end := relEndRe.FindStringIndex(body); end != nil {
		body = body[:end[0]]
	}
	for _, ln := range strings.Split(body, "\n") {
		if relLineRe.MatchString(ln) {
			n++
		}
	}
	return n
}

// cardSlice＝一次送往雲端的呼叫。Scope 空＝不帶 triplet_scope；Limit 0＝寫到最後。
type cardSlice struct {
	Offset int
	Limit  int
	Scope  string
}

// baseTripletScope＝這張卡三元組的名字：文件卡本人（cardIdx 0）是 ”，概念卡是 c.<頁名>。
func baseTripletScope(cardIdx int, pageName string) string {
	if cardIdx == 0 {
		return ""
	}
	return "c." + pageName
}

// sliceScope＝第 k 段（k≥1）的名字。
func sliceScope(base string, k int) string {
	if base == "" {
		return "s" + strconv.Itoa(k)
	}
	return base + ".s" + strconv.Itoa(k)
}

// sliceCount＝這張卡要切成幾段（至少 1）。
func sliceCount(md string) int {
	total := countCardRelations(md)
	if total <= relsPerCall {
		return 1
	}
	return (total + relsPerCall - 1) / relsPerCall
}

// planCardSlices 回這張卡要送的呼叫，**依送出順序**排好（最後一段在前、第一段最後）。
// canSlice＝雲端版本看得懂分段；不行就只回一發（Offset 0、Limit 0＝整張），跟從前一樣。
func planCardSlices(md string, cardIdx int, pageName string, canSlice bool) []cardSlice {
	base := baseTripletScope(cardIdx, pageName)
	n := 1
	if canSlice {
		n = sliceCount(md)
	}
	if n <= 1 {
		return []cardSlice{{Offset: 0, Limit: 0, Scope: base}}
	}
	out := make([]cardSlice, 0, n)
	for k := n - 1; k >= 0; k-- {
		sl := cardSlice{Offset: k * relsPerCall, Limit: relsPerCall, Scope: base}
		if k > 0 {
			sl.Scope = sliceScope(base, k)
		}
		if k == n-1 {
			sl.Limit = 0 // 最後一段寫到最後：雲端數到的條數跟這裡有出入時也不漏
		}
		out = append(out, sl)
	}
	return out
}

// body 回這一段要送的 JSON：沒有分段／命名的卡原樣回傳 base（與從前逐位元組相同）。
func (sl cardSlice) body(base map[string]any) map[string]any {
	if sl.Scope == "" && sl.Offset == 0 && sl.Limit == 0 {
		return base
	}
	out := make(map[string]any, len(base)+3)
	for k, v := range base {
		out[k] = v
	}
	if sl.Scope != "" {
		out["triplet_scope"] = sl.Scope
	}
	if sl.Offset > 0 {
		out["rel_offset"] = sl.Offset
	}
	if sl.Limit > 0 {
		out["rel_limit"] = sl.Limit
	}
	return out
}

// takedownCall＝下架時除了「文件卡本人那一發」之外還要補的一發。
type takedownCall struct {
	PageName string
	Scope    string
}

// planTakedownCalls 回下架一份走過續讀的文件時，除了 hub 既有的那一發之外要補的呼叫：
//   - 每張概念卡一發（頁名＋它自己的三元組名字）；
//   - 任何一張卡若曾被切段，每個多出來的段各一發（頁名同該卡，只刪那一批三元組）。
//
// **雲端版本不在這裡判斷**：對雲端來說「沒這一批」只是撈到 0 條，無害；
// 而升級前後本機判斷的版本可能不同，漏下架比多打一發代價高。
// 要在 RemoveWikiDoc 清掉卡檔**之前**呼叫（要讀卡才數得出切成幾段）。
//
// withConcepts＝這份文件的概念卡有上雲（走過續讀機制，見 docWentThroughResumable）。
// 沒走過的文件概念卡只落本機、雲端沒有，不必下架。
func planTakedownCalls(absRoot, relPath string, withConcepts bool) []takedownCall {
	return planTakedownCallsFrom(absRoot, relPath, WikiDocCardRels(absRoot, relPath), withConcepts)
}

// planTakedownCallsFrom＝planTakedownCalls，卡名單由呼叫端給（測試不必架整套 wiki manifest）。
func planTakedownCallsFrom(absRoot, relPath string, cardRels []string, withConcepts bool) []takedownCall {
	var out []takedownCall
	for i, rel := range cardRels {
		if i > 0 && !withConcepts {
			break
		}
		pn := pageNameOf(rel)
		if i == 0 {
			pn = pageNameOf(relPath) // hub 的頁名跟原稿走
		}
		base := baseTripletScope(i, pn)
		if i > 0 {
			out = append(out, takedownCall{PageName: pn, Scope: base})
		}
		raw, err := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		for k := 1; k < sliceCount(string(raw)); k++ {
			out = append(out, takedownCall{PageName: pn, Scope: sliceScope(base, k)})
		}
	}
	return out
}

// currentTripletRev＝三元組送法的世代。1＝每張卡各有自己的 triplet_scope（arcrun-rag#255）。
const currentTripletRev = 1

// requeueSharedSourceDocs：改版前走過續讀（文件卡＋概念卡）的檔，概念卡的三元組已被後送的卡刪光，
// 而內容沒變、小幫手會判「送過了」永遠不補。雲端夠新時，把這些檔的章拔掉一次，
// Scan() 會自然補一發 added（續讀書籤已讀完，重組卡片不再用 AI），用新送法重送。
// 回被排回佇列的檔數。蓋章時 TripletRev 會升到 currentTripletRev，所以只會發生一次。
func requeueSharedSourceDocs(cfg *DirectConfig, absRoot string, m *Manifest) int {
	if cfg.Extractor == "" || !cloudHasSlicedNotes(cfg.CloudVersion) {
		return 0
	}
	n := 0
	for path, e := range m.Entries {
		if e == nil || strings.TrimSpace(e.IngestedHash) == "" || e.NoCloudCard || e.TripletRev >= currentTripletRev {
			continue
		}
		if !docWentThroughResumable(absRoot, path) {
			e.TripletRev = currentTripletRev // 單卡文件沒受害，不必重送
			continue
		}
		e.IngestedHash, e.IngestedAt = "", 0
		n++
	}
	return n
}
