// extract_prompt_legacy.go — 舊雲端相容：沒有 #299 指示表的雲端，小幫手照舊帶整段 prompt。
//
// 🔴 inkstone/arcrun-rag#251 c18860：0.18.93 不再送 prompt，撞到 #299 之前的雲端（geek／leo21c 當時是 prod 1.4.95）
// 它忽略 prompt_table、走 legacy 路回舊格式 card，小幫手落 legacy 卡，導致 geek 的
// system-dev/wiki/cards/arcrun-*.md 原稿被判「整理它會蓋掉自己」而失敗。
// 修法：偵測到雲端回 legacy card（沒有 output）⇒ 記下這個雲端是舊的，之後改送 prompt（Arcrun#134 契約，舊雲端回 output）。
// 這段指示是**舊雲端專用**；新雲端的指示住雲端那張表，改指示不要改這裡。
package collector

import (
	"fmt"
	"strings"
	"sync"
)

// oldCloudURLs：已知沒有指示表的雲端（以萃取網址為鍵）。程序內記憶，重開再探測一次。
var oldCloudURLs sync.Map

func wikiExtractPrompt(pageName, content string) string {
	labelSection := ""
	if labels := candidateRecordLabels(content); len(labels) >= 3 {
		labelSection = fmt.Sprintf(
			"\n\n機械掃出的候選識別碼清單（原稿裡偵測到重複的欄位結構，"+
				"以下每一個都要在 entities 裡各自寫一筆，逐字使用清單裡的原文當 name；"+
				"不准新增清單外的碼，也不准漏掉清單裡的任何一個）：\n- %s",
			strings.Join(labels, "\n- "))
	}
	return `你是知識整理員。讀完原稿後，把它整理成「一份文件的總覽＋N 個原子概念」。只輸出一個 JSON 物件，不要任何說明、markdown 圍欄或思考過程。` + labelSection + `

規則（違反任何一條都算失敗）：
- 卡片內容是你的**判斷與重組**（正體中文），禁止整句照抄原稿。
- 概念數由內容決定（多數文件 1-5 個）；每個概念要能**離開原稿獨立成立**。
- 報價單、發票、純待辦、純流水帳＝沒有可萃取概念：回 {"no_concept":true,"reason":"一句話理由"} 即可。
- gloss＝一句話（40 字內）。summary＝一小段（80-200 字）。points＝3-8 條判斷句（不是條列複述）。
- 文件層的 points 每條要把相關概念名用 [[概念名]] 嵌在**句子中間**（不可放句首當標題）。
- entities：每個實體帶 type（人物/組織/工具/概念/地點/事件/檔案 擇一）與一句描述。
- 🔴 **先數一遍：原稿裡有沒有重複出現的「條目」結構**——同一種短識別碼（型號／代碼／
  單號／參數名，任何原稿自己用來標示每一條的字串）在原稿裡各自帶開一段說明，
  一段接一段地重複。有的話：
  1. 先數出原稿裡總共有幾條這種條目，在心裡記住這個數字 N。
  2. entities 陣列（所有概念合計）要正好列出 N 筆，逐一對應原稿的每一條——
     **不是舉幾個例子代表其餘的，是每一條都要有自己的一筆**。漏掉任何一條都算失敗。
  3. 開少數幾個概念（1-3 個，按主題分組）當容器，把 N 筆 entities 分裝進去；
     每個概念的 entities 陣列可以很長（十幾、幾十筆都正常），**不要因為「這樣看起來
     很長」就自己截斷、只挑前面幾筆或看起來重要的幾筆**——你不是在寫摘要給人瀏覽，
     是在建一份查找用的索引，缺一筆，那一條在索引裡就永久找不到。
  4. entity 的 name＝識別碼原文（逐字，不意譯）。desc 要把該識別碼底下**每一個子欄位**
     （例如原稿標的「訊息／原因／處置」，或該格式對應的其他欄位）都摘要進同一句話，
     不是只抄第一個欄位——讀者要能光看 desc 就知道發生什麼、為什麼、怎麼處理，
     並保留原碼、參數名、數字。
  原稿沒有這種重複條目結構（一般散文／報告）就不受本條約束，照一般寫法整理。
- facts＝[主詞,述詞,受詞] 三元組，端點盡量用 entities 的名字；任何欄位不得含雙箭頭符號。
- relations＝概念之間的關係（to 填另一個概念的 name）。

JSON 形狀（照這個結構填）：
{"gloss":"","tags":[""],"summary":"","points":["…句子中間嵌 [[概念名]]…"],
 "no_concept":false,"reason":"",
 "concepts":[{"name":"","gloss":"","tags":[""],"summary":"","points":[""],
   "entities":[{"name":"","type":"","desc":""}],
   "facts":[["","",""]],
   "relations":[{"to":"","pred":""}]}]}

原稿（檔名：` + pageName + `）：
` + content
}

