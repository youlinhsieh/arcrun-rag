package main

// feedback_eventkey.go — 回報的「事件鍵」（inkstone/arcrun-rag#309）
//
// leo 2026-11-11：「在 GitHub 如果有人提了一個已有的票，會有人說 duplicate 指向該票，
// 現在就會讓兩個都存在」。小幫手的「回報」以前每按一次就新開一張票（11-11 大清查併掉 6 張）。
// AHub 0.18.0（inkstone/Arcrun#377）開票支援 event_key：同一個 key 第二次起回 200 merged，
// 內容併成第一張票的留言。這裡負責「key 怎麼組」。
//
// 規則：同一個事件 ＝ 同一個知識庫（host）＋同一個範圍（整個帳號／一個資料夾／一份檔）＋同一類原因。
// 不同事件（換一份檔、換資料夾、換原因）key 就不同，照樣各開各的票。
//
// 🔴 key 只收 AHub 認的字元 [A-Za-z0-9_.:@/~-]、≤120 字。檔名／資料夾名常含中文與空白：
//    一律轉成「可讀的 ASCII 部分＋原文雜湊」，既穩定（同一份檔永遠同一個 key）又不外洩原文。
// 🔴 key 不含 namespace／金鑰／電腦名稱（同回報本文的紅線）；host 本來就會出現在回報內文裡。
import (
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"strings"

	"arcrun-rag/collector"
)

const eventKeyMax = 120

var eventKeyUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// eventKeyPart 把任意字串收成一段 key 用的安全片段（不含 ':'，才能用 ':' 當分隔）。
// 純安全字元且不超長 ⇒ 原樣；否則「清掉不安全字元後的前綴＋ '-' ＋原文 sha1 前 8 碼」。
func eventKeyPart(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "x"
	}
	if len(s) <= max && !eventKeyUnsafe.MatchString(s) {
		return s
	}
	sum := sha1.Sum([]byte(s))
	h := hex.EncodeToString(sum[:])[:8]
	pre := strings.Trim(eventKeyUnsafe.ReplaceAllString(s, "_"), "_.-")
	if max-9 < 0 {
		max = 9
	}
	if len(pre) > max-9 {
		pre = pre[:max-9]
	}
	if pre == "" {
		return h
	}
	return pre + "-" + h
}

// buildEventKey 組 `<host>:<scope>:<對象>:<原因>`；任何一段缺就用 x，總長超過上限就把 host 縮短。
// scope 用固定幾個字：stall（同原因整批停工）／acct（整個帳號沒在跑）／folder／file／text（自由文字）。
func buildEventKey(host, scope, target, cause string) string {
	hostMax, tgtMax := 40, 40
	for {
		k := strings.Join([]string{
			eventKeyPart(host, hostMax), eventKeyPart(scope, 10), eventKeyPart(target, tgtMax), eventKeyPart(cause, 30),
		}, ":")
		if len(k) <= eventKeyMax {
			return k
		}
		if hostMax > 16 {
			hostMax -= 8
		} else if tgtMax > 16 {
			tgtMax -= 8
		} else {
			return k[:eventKeyMax]
		}
	}
}

// causeKeyOf 把錯誤原文歸成穩定的原因類別（沿用停工卡的分類，同一類原因＝同一個鍵）。
func causeKeyOf(rawErr string) string {
	if strings.TrimSpace(rawErr) == "" {
		return "unknown"
	}
	k, _ := collector.StallReason(rawErr)
	return strings.ReplaceAll(k, "+", "-")
}

// textEventKey：沒有結構化事實的自由文字回報——同一台知識庫、同一段話（空白壓平、大小寫不分）算同一個事件。
func textEventKey(host, text string) string {
	norm := strings.ToLower(strings.Join(strings.Fields(text), " "))
	sum := sha1.Sum([]byte(norm))
	return buildEventKey(host, "text", hex.EncodeToString(sum[:])[:12], "free")
}
