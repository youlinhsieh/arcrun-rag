package collector

import (
	"regexp"
	"strings"
)

// failureWithUpstream：畫面上那句是給人讀的預設句（「…稍後會自動再試」），它會把上游真正的原因吃掉
// （#240 c18636：32 份「雲端沒有把這一份寫進你的知識庫」，原因全部不明）。
// 記進 manifest 的 LastError 要帶上上游原文（截短、單行），之後診斷檔、停工回報、分類才看得到真因。
// 句子本身不變，原因接在「｜上游原因：」後面。
func failureWithUpstream(sentence, detail string) string {
	d := strings.Join(strings.Fields(detail), " ")
	if d == "" || strings.Contains(sentence, d) {
		return sentence
	}
	r := []rune(d)
	if len(r) > 300 {
		d = string(r[:300]) + "…"
	}
	return sentence + "｜上游原因：" + d
}

var failedNodeRe = regexp.MustCompile(`"failed_node"\s*:\s*"([^"]{1,80})"`)

// failedNodePrefix：雲端回的失敗殼裡，`failed_node`（哪一步失敗）排在 trace 後面，而診斷用的原文只留前 1 KB，
// 於是「是哪個節點回應太大」這種最關鍵的一格永遠被截掉（inkstone/Arcrun#291：geek6688 12 次失敗都看不出是哪一步）。
// 從完整回應裡撈出來，放在原文最前面；撈不到回空字串。
func failedNodePrefix(full string) string {
	m := failedNodeRe.FindStringSubmatch(full)
	if m == nil {
		return ""
	}
	return "失敗節點 " + m[1] + "｜"
}
