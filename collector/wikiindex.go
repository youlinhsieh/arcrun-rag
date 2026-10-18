// wikiindex.go — 大資料夾的目錄**分層**（inkstone/arcrun-rag#264，leo 2026-10-11）。
//
// 病：`.wiki/00-INDEX.md` 把一個資料夾裡所有文件平鋪成一份（error_codes 六千多張卡＝950 KB）。
// LLM 讀不完、雲端單一區塊也收不下，AI 從目錄走不到任何一張卡。
//
// 規則：
//   - 文件數 ≤ idxLeafMax：維持原樣（一張 00-INDEX，格式與以前逐字相同）。
//   - 超過：00-INDEX 只列「分組」，每組一張子目錄卡（`00-INDEX-<前綴>`），
//     組內仍太大就再往下分，直到每張卡都在 LLM 一次讀得完、雲端收得下的範圍。
//   - 分組依「卡名（原稿檔名）的共同前綴」自然分群（錯誤碼 120-／145-／280- …），
//     前綴分不開（同名／前綴過多）才退回依序等分成區間。
//
// 本檔純函式、零 IO；本機（.wiki/）與雲端（sync 上傳）共用同一套分層，只差連結名字。
package collector

import (
	"fmt"
	"sort"
	"strings"
)

const (
	// idxLeafMax＝一張葉子目錄卡最多列幾份文件（每份約 2 行、≈250 B ⇒ ≈30 KB 以內）。
	idxLeafMax = 100
	// idxFanoutMax＝一張目錄卡最多列幾個分組。
	idxFanoutMax = 40
	// idxCardMaxBytes＝單張目錄卡的硬上限（雲端單一 block 吃不下 64 KB，留餘裕）。
	idxCardMaxBytes = 48 * 1024
	// idxLeafBytesMax＝葉子目錄卡的「列文字」總量上限；說明變長（原稿節錄）時，份數沒超也要再往下分，卡才不會逼近硬上限。
	idxLeafBytesMax = 36 * 1024
)

// idxEntry＝目錄裡的一份文件。Key＝分組用的排序鍵（原稿檔名去副檔名）；Lines＝已排好的列文字（含換行）。
type idxEntry struct {
	Key   string
	Lines string
}

// idxCard＝一張目錄卡。
type idxCard struct {
	Name    string
	Content string
}

type idxGroup struct {
	Label string
	Items []idxEntry
}

// idxOpts＝兩種目錄（本機／雲端）的差異。
type idxOpts struct {
	RootName   string // 根目錄卡名（本機 "00-INDEX"；雲端依節點）
	Preface    string // 根卡開頭的「## 子節點」整段（含結尾空行）；沒有就空
	EmptyMsg   string // 沒有任何文件時的說明（本機沿用舊文字）
	Footer     string // 「## 說明」整段
	WithGloss  bool   // 每張分層卡加「## 一句話定義」（雲端用）
	NameJoiner string // 子卡名 = 父前綴 + joiner + label
}

func idxSanitizeLabel(s string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", "[", "(", "]", ")", "|", "_", "#", "_", "^", "_",
		":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "\n", "_", "\r", "_", "\t", "_")
	s = strings.TrimSpace(r.Replace(s))
	if s == "" {
		return "_"
	}
	return s
}

// buildIdxCards 把一個節點的文件（已依本機慣例排序）做成目錄卡。第一張一定是根卡。
func buildIdxCards(entries []idxEntry, o idxOpts) []idxCard {
	if idxFitsLeaf(entries) {
		return []idxCard{{Name: o.RootName, Content: renderIdxLeaf(o.RootName, "", o, entries, true)}}
	}
	sorted := append([]idxEntry(nil), entries...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Key < sorted[j].Key })
	var out []idxCard
	used := map[string]bool{o.RootName: true}
	var walk func(name, parent string, items []idxEntry, isRoot bool)
	walk = func(name, parent string, items []idxEntry, isRoot bool) {
		if idxFitsLeaf(items) {
			out = append(out, idxCard{Name: name, Content: renderIdxLeaf(name, parent, o, items, isRoot)})
			return
		}
		groups := splitIdx(items)
		type child struct {
			name string
			g    idxGroup
		}
		kids := make([]child, 0, len(groups))
		for _, g := range groups {
			// label 是完整前綴（不是相對上一層），所以同一節點內天然唯一、名字一看就知道範圍。
			cn := o.RootName + o.NameJoiner + idxSanitizeLabel(g.Label)
			for n := 2; used[cn]; n++ {
				cn = fmt.Sprintf("%s%s%s-%d", o.RootName, o.NameJoiner, idxSanitizeLabel(g.Label), n)
			}
			used[cn] = true
			kids = append(kids, child{cn, g})
		}
		var b strings.Builder
		b.WriteString("# " + name + "\n\n")
		if parent != "" {
			b.WriteString("← [[" + parent + "]]\n\n")
		}
		if o.WithGloss {
			b.WriteString(fmt.Sprintf("## 一句話定義\n目錄分層：本頁把 %d 份文件分成 %d 組，點進各組再找到卡片。\n\n", len(items), len(kids)))
		}
		if isRoot && o.Preface != "" {
			b.WriteString(o.Preface)
		}
		b.WriteString("## 分組\n")
		for _, k := range kids {
			first, last := k.g.Items[0].Key, k.g.Items[len(k.g.Items)-1].Key
			span := first
			if last != first {
				span = first + " ～ " + last
			}
			line := fmt.Sprintf("- [[%s]] — %d 篇（%s）", k.name, len(k.g.Items), span)
			if d := idxGroupDigest(k.g.Items); d != "" {
				line += "：" + d
			}
			b.WriteString(line + "\n")
		}
		b.WriteString("\n" + o.Footer)
		out = append(out, idxCard{Name: name, Content: b.String()})
		for _, k := range kids {
			walk(k.name, name, k.g.Items, false)
		}
	}
	walk(o.RootName, "", sorted, true)
	return out
}

// idxFitsLeaf：份數與列文字總量都在葉子卡的範圍內（只剩 1 份時不能再分，照放）。
func idxFitsLeaf(items []idxEntry) bool {
	if len(items) <= idxLeafMax && len(items) >= 1 {
		n := 0
		for _, it := range items {
			n += len(it.Lines)
		}
		return n <= idxLeafBytesMax || len(items) < 2
	}
	return len(items) == 0
}

func renderIdxLeaf(name, parent string, o idxOpts, items []idxEntry, isRoot bool) string {
	var b strings.Builder
	b.WriteString("# " + name + "\n\n")
	if parent != "" {
		b.WriteString("← [[" + parent + "]]\n\n")
	}
	if o.WithGloss {
		b.WriteString(fmt.Sprintf("## 一句話定義\n目錄：本頁列出 %d 份文件，每份連到它的卡片。\n\n", len(items)))
	}
	if isRoot && o.Preface != "" {
		b.WriteString(o.Preface)
	}
	b.WriteString("## 文件\n")
	if len(items) == 0 {
		b.WriteString(o.EmptyMsg + "\n")
	}
	for _, it := range items {
		b.WriteString(it.Lines)
	}
	b.WriteString("\n" + o.Footer)
	return b.String()
}

// splitIdx 把（依 Key 排序的）一批文件分成若干組：先依共同前綴自然分群，分不開才等分區間。
func splitIdx(items []idxEntry) []idxGroup {
	keys := make([][]rune, len(items))
	maxLen := 0
	for i, it := range items {
		keys[i] = []rune(it.Key)
		if len(keys[i]) > maxLen {
			maxLen = len(keys[i])
		}
	}
	common := 0
	for common < len(keys[0]) {
		same := true
		for _, k := range keys {
			if common >= len(k) || k[common] != keys[0][common] {
				same = false
				break
			}
		}
		if !same {
			break
		}
		common++
	}
	for p := common + 1; p <= maxLen; p++ {
		var groups []idxGroup
		for i, it := range items {
			l := p
			if l > len(keys[i]) {
				l = len(keys[i])
			}
			lab := string(keys[i][:l])
			if n := len(groups); n > 0 && groups[n-1].Label == lab {
				groups[n-1].Items = append(groups[n-1].Items, it)
			} else {
				groups = append(groups, idxGroup{Label: lab, Items: []idxEntry{it}})
			}
		}
		if len(groups) >= 2 {
			groups = mergeSmallIdxGroups(groups)
			if len(groups) >= 2 && len(groups) <= idxFanoutMax {
				return groups
			}
			break // 組太多（或併成一組）：改用等分區間
		}
	}
	// 等分區間：每組至少塞滿到「組數 ≤ idxFanoutMax」
	size := (len(items) + idxFanoutMax - 1) / idxFanoutMax
	if size < 1 {
		size = 1 // 份數不多但列文字太長時也要能分開（idxFitsLeaf）
	}
	var groups []idxGroup
	for i := 0; i < len(items); i += size {
		j := i + size
		if j > len(items) {
			j = len(items)
		}
		part := items[i:j]
		lab := part[0].Key
		if part[len(part)-1].Key != lab {
			lab += "～" + part[len(part)-1].Key
		}
		groups = append(groups, idxGroup{Label: lab, Items: part})
	}
	return groups
}

// mergeSmallIdxGroups 把相鄰的小組併起來（總數 ≤ idxLeafMax），避免一堆只有幾篇的碎卡。
// 併出來的組以「起～迄」標示範圍；單獨一組維持原前綴。
func mergeSmallIdxGroups(groups []idxGroup) []idxGroup {
	var out []idxGroup
	var cur *idxGroup
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, g := range groups {
		if cur != nil && len(cur.Items)+len(g.Items) <= idxLeafMax {
			first := cur.Label
			if i := strings.Index(first, "～"); i >= 0 {
				first = first[:i]
			}
			cur.Label = first + "～" + g.Label
			cur.Items = append(cur.Items, g.Items...)
			continue
		}
		flush()
		gg := g
		cur = &gg
	}
	flush()
	return out
}

// idxDigestMax＝分組那行「主題摘要」最多幾個字。
const idxDigestMax = 150

// idxGroupDigest：把一組文件的「這組在講什麼」濃縮成一句（inkstone/arcrun-rag#264 c21583）。
// 病：上層分組只有編號範圍（145-0001 ～ 145-003A），沒給代碼只描述症狀的人（AI）無從選分支，
// 只好每條都點進去。解：取組內各份說明的第一段（錯誤碼＝Error message 的標題），依出現次數排，
// 排到字數上限為止。組內文件說明用的是同一份 Lines，所以本機與雲端目錄共用，不多讀任何檔。
func idxGroupDigest(items []idxEntry) string {
	count := map[string]int{}
	var order []string
	for _, it := range items {
		t := idxFirstClause(it.Lines)
		if t == "" {
			continue
		}
		if count[t] == 0 {
			order = append(order, t)
		}
		count[t]++
	}
	// 「System error」這類到處都有的標題對挑分支沒幫助：排到最後，只在沒別的可說時才用。
	generic := func(t string) bool {
		l := strings.ToLower(t)
		return strings.HasPrefix(l, "system error") || strings.HasPrefix(l, "system warning") ||
			strings.HasPrefix(l, "internal software error") || l == "系統錯誤" || l == "錯誤"
	}
	sort.SliceStable(order, func(i, j int) bool {
		gi, gj := generic(order[i]), generic(order[j])
		if gi != gj {
			return gj
		}
		return count[order[i]] > count[order[j]]
	})
	var parts []string
	n := 0
	for _, t := range order {
		l := len([]rune(t))
		if n+l > idxDigestMax && len(parts) > 0 {
			break
		}
		parts = append(parts, t)
		n += l + 1
	}
	return strings.Join(parts, "、")
}

// idxFirstClause：取一份文件列文字的說明第一段；去掉「Error message：」之類標籤與「（原稿 …）」尾註。
func idxFirstClause(lines string) string {
	first := lines
	if i := strings.IndexByte(first, '\n'); i >= 0 {
		first = first[:i]
	}
	i := strings.Index(first, "] — ")
	if i < 0 {
		return ""
	}
	t := first[i+len("] — "):]
	if j := strings.Index(t, "（原稿"); j >= 0 {
		t = t[:j]
	}
	if j := strings.Index(t, "；"); j >= 0 {
		t = t[:j]
	}
	t = strings.TrimSpace(t)
	if j := strings.Index(t, "："); j >= 0 && j <= 24 {
		t = strings.TrimSpace(t[j+len("："):])
	}
	r := []rune(strings.TrimRight(t, "…"))
	if len(r) < 2 {
		return ""
	}
	if len(r) > 32 {
		t = string(r[:32]) + "…"
	}
	return t
}
