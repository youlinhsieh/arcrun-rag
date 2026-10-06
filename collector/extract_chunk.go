// extract_chunk.go — 把過長的純文字切成幾段、以及把幾段各自的萃取結果併回同一份
// DocExtract。任何萃取路（現只有 workers-ai）共用同一套切法與併法。
//
// 出處：本檔的切段／併卡邏輯移植自 `claude/213-large-file-chunking`（commit `49ce014`）
// 的 `extract_workersai_chunk.go`——`inkstone/arcrun-rag#213` c10625 核可時點名
// 「可取這條分支的切行工具」。那個分支本身（`extractLargeViaChunks`：一次呼叫裡
// 把全部段落同步跑完）**不採用**：c10627 leo 定向要「分次讀、本機存書籤、隔天接著
// 讀」，同步跑完整份大檔在額度只夠幾段的日子會直接整發失敗、一張卡都送不出去。
// 續傳的排程邏輯在 extract_resume.go；本檔只留兩件可重用的機械工具：切段＋併卡。
package collector

import (
	"strings"
	"unicode/utf8"
)

// chunkForWorkersAI 把過長的純文字切成幾段，每段位元組數 ≤ limit。
// 盡量在換行處切（保留段落邊界，模型比較讀得懂），且**永不切斷一個 UTF-8 字元**。
// 只有「單一一行就已經超過 limit」時才會對那一行在字元邊界硬切。
func chunkForWorkersAI(s string, limit int) []string {
	if limit <= 0 || len(s) <= limit {
		return []string{s}
	}
	var chunks []string
	var b strings.Builder
	flush := func() {
		if b.Len() > 0 {
			chunks = append(chunks, b.String())
			b.Reset()
		}
	}
	// SplitAfter 保留每行結尾的 "\n"，重組後與原文逐位元組相同。
	for _, ln := range strings.SplitAfter(s, "\n") {
		if ln == "" {
			continue
		}
		if len(ln) > limit {
			// 單行過長：先把手上累積的收掉，再對這行做字元邊界硬切。
			flush()
			chunks = append(chunks, splitOnRuneBoundary(ln, limit)...)
			continue
		}
		if b.Len()+len(ln) > limit {
			flush()
		}
		b.WriteString(ln)
	}
	flush()
	if len(chunks) == 0 {
		return []string{s}
	}
	return chunks
}

// splitOnRuneBoundary 把字串切成每段 ≤ limit 位元組，切點退到 UTF-8 字元邊界。
func splitOnRuneBoundary(s string, limit int) []string {
	var out []string
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		if cut == 0 { // 極端保護：單一字元就比 limit 大（理論上不會發生）
			cut = limit
		}
		out = append(out, s[:cut])
		s = s[cut:]
	}
	if len(s) > 0 {
		out = append(out, s)
	}
	return out
}

// mergeDocExtract 把 src 併進 dst：文件層欄位取聯集，概念以（正規化後的）名字去重合併。
func mergeDocExtract(dst, src *DocExtract) {
	if src == nil {
		return
	}
	if strings.TrimSpace(dst.Gloss) == "" {
		dst.Gloss = src.Gloss
	}
	if strings.TrimSpace(dst.Summary) == "" {
		dst.Summary = src.Summary
	}
	if strings.TrimSpace(dst.Reason) == "" {
		dst.Reason = src.Reason
	}
	dst.Tags = appendStringsDedup(dst.Tags, src.Tags)
	dst.Points = appendStringsDedup(dst.Points, src.Points)
	dst.Entities = appendEntitiesDedup(dst.Entities, src.Entities)
	for _, c := range src.Concepts {
		if i := indexConcept(dst.Concepts, c.Name); i >= 0 {
			dst.Concepts[i] = mergeConcept(dst.Concepts[i], c)
		} else {
			dst.Concepts = append(dst.Concepts, c)
		}
	}
	// 任一段有可萃概念，整份就不是 no_concept。
	if len(dst.Concepts) > 0 {
		dst.NoConcept = false
	}
}

// indexConcept 回傳同名概念在 list 中的位置（以 sanitizeCardName 正規化比對），無則 -1。
func indexConcept(list []WikiConcept, name string) int {
	key := sanitizeCardName(name)
	for i := range list {
		if sanitizeCardName(list[i].Name) == key {
			return i
		}
	}
	return -1
}

// mergeConcept 併兩張同名概念卡：字串欄位取聯集，一句話定義／摘要保留先到的非空值。
func mergeConcept(dst, src WikiConcept) WikiConcept {
	if strings.TrimSpace(dst.Gloss) == "" {
		dst.Gloss = src.Gloss
	}
	if strings.TrimSpace(dst.Summary) == "" {
		dst.Summary = src.Summary
	}
	dst.Tags = appendStringsDedup(dst.Tags, src.Tags)
	dst.Points = appendStringsDedup(dst.Points, src.Points)
	dst.Entities = appendEntitiesDedup(dst.Entities, src.Entities)
	dst.Facts = appendFactsDedup(dst.Facts, src.Facts)
	dst.Relations = appendRelationsDedup(dst.Relations, src.Relations)
	return dst
}

func appendStringsDedup(dst, src []string) []string {
	seen := map[string]bool{}
	for _, s := range dst {
		seen[strings.TrimSpace(s)] = true
	}
	for _, s := range src {
		k := strings.TrimSpace(s)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		dst = append(dst, s)
	}
	return dst
}

func appendEntitiesDedup(dst, src []WikiEntity) []WikiEntity {
	seen := map[string]bool{}
	for _, e := range dst {
		seen[sanitizeCardName(e.Name)] = true
	}
	for _, e := range src {
		k := sanitizeCardName(e.Name)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		dst = append(dst, e)
	}
	return dst
}

func appendFactsDedup(dst, src [][]string) [][]string {
	seen := map[string]bool{}
	for _, f := range dst {
		seen[strings.Join(f, "\x1f")] = true
	}
	for _, f := range src {
		k := strings.Join(f, "\x1f")
		if seen[k] {
			continue
		}
		seen[k] = true
		dst = append(dst, f)
	}
	return dst
}

func appendRelationsDedup(dst, src []WikiRelation) []WikiRelation {
	seen := map[string]bool{}
	for _, r := range dst {
		seen[r.To+"\x1f"+r.Pred] = true
	}
	for _, r := range src {
		k := r.To + "\x1f" + r.Pred
		if seen[k] {
			continue
		}
		seen[k] = true
		dst = append(dst, r)
	}
	return dst
}
