// cardlinks.go — 上雲的文件卡不准留下「指到雲端不存在的卡」的 [[連結]]
// （inkstone/arcrun-rag#280 c21932）。
//
// 🔴 為什麼：direct.go 預設只把文件卡送上雲，概念卡只落本機 .wiki（第⑤環才上雲）。
// 但文件卡的「重點」、「卡片關係」（`[[文件]] >> 整理出 >> [[概念]]`）還寫著 [[概念名]]。
// 結果雲端那張卡指向一張不存在的卡，任何照連結走的 AI 都會讀到 card_not_found，
// 還會反覆重試（大前 n8n 執行 2098802：撞 Max iterations 30、約 59 萬 tokens）。
//
// 規約：**上雲的卡上出現的每個 [[X]]，同庫 get_card(X) 都要讀得到；讀不到就不准有連結。**
// 這一支只動「送出去的副本」，本機 .wiki 的卡不動（那邊概念卡都在，連結是通的）。
// 它不認文件類型：任何一份被拆成「文件卡＋概念卡」、概念卡沒上雲的文件都適用。
package collector

import (
	"path/filepath"
	"regexp"
	"strings"
)

// 機械補句「本文件整理成 N 張概念卡，入口是 [[X]]」：概念卡不在雲端，這句整句不成立。
var conceptCountLineRe = regexp.MustCompile(`^\s*-\s*本文件整理成\s*[0-9]+\s*張概念卡`)

// conceptCardNames 由概念卡的相對路徑取出卡名（檔名去掉副檔名與機器標記）。
func conceptCardNames(conceptRels []string) map[string]bool {
	out := map[string]bool{}
	for _, rel := range conceptRels {
		base := filepath.Base(filepath.FromSlash(rel))
		base = strings.TrimSuffix(base, filepath.Ext(base))
		base = UnmarkName(base)
		if base != "" {
			out[base] = true
		}
	}
	return out
}

// unlinkUnsentConceptCards 回傳給雲端的文件卡副本：
//   - 「本文件整理成 N 張概念卡」那句整行拿掉；
//   - 指向沒上雲概念卡的 `整理出` 三元組整行拿掉（不留指向幽靈的邊）；
//   - 其餘行裡指向沒上雲概念卡的 [[X]] 拆殼成純文字 X（內容與可讀性保留）。
//
// names 為空＝沒有未上雲的概念卡，原樣回傳。
func unlinkUnsentConceptCards(card string, names map[string]bool) string {
	if len(names) == 0 || !strings.Contains(card, "[[") {
		return card
	}
	lines := strings.Split(card, "\n")
	out := make([]string, 0, len(lines))
	for _, ln := range lines {
		if conceptCountLineRe.MatchString(ln) {
			continue
		}
		if isTreeEdgeToUnsent(ln, names) {
			continue
		}
		ln = wikiLinkRe.ReplaceAllStringFunc(ln, func(m string) string {
			inner := wikiLinkRe.FindStringSubmatch(m)[1]
			if names[inner] {
				return inner
			}
			return m
		})
		out = append(out, ln)
	}
	return strings.Join(out, "\n")
}

// isTreeEdgeToUnsent：`- [[文件]] >> 整理出 >> [[概念]]` 且概念沒上雲。
func isTreeEdgeToUnsent(line string, names map[string]bool) bool {
	if !strings.Contains(line, triSep+"整理出"+triSep) {
		return false
	}
	ms := wikiLinkRe.FindAllStringSubmatch(line, -1)
	if len(ms) != 2 {
		return false
	}
	return names[ms[1][1]]
}
