// triggeroutcome.go — 「雲端收下了」不等於「知識庫寫進去了」（`inkstone/arcrun-rag#104`）。
//
// 🔴 為什麼有這支檔（2026-08-26 實測，非推測）：
// 把 leo 真實的 `InkStoneCo` 接上 youlin 跑一輪，daemon 對 26 份檔案蓋了「已送達」章，
// **雲端實際只有 4 份**。使用者畫面上是綠的，AR-Mira 一句都查不到。
//
// 真兇不是萃取、不是排除規則，是這一行：`postJSON` 只看 HTTP 狀態碼。
// named-webhook 觸發成功一律回 **200**，而工作流內部有沒有把東西寫進 KBDB
// 藏在 body 裡。當天的實際回應（原文照抄）：
//
//	HTTP 200
//	{"success":true,"data":{"success":false,"status":500,
//	  "error":"{\"success\":false,\"error\":\"unreachable\"}"},"duration_ms":2476}
//
// ⇒ 外層說 success，內層說 500／unreachable。daemon 讀外層 ⇒ 蓋章 ⇒
// content_hash 沒變就永遠不會重送 ⇒ **這份知識永久消失，而且沒有人會知道**。
//
// 這與 `Arcrun#135`（push_workflow 對跑不起來的定義回「部署成功！」）是同一個病：
// **回報層與事實層分居兩處，而讀的人只讀得到回報層。**
// 我們改不了別人回什麼，但可以改「我們信什麼」——2xx 只證明請求送達，
// 要證明寫進去了，得看 body。
//
// 三條自我約束：
//   - **只在看得懂的時候才判失敗**：body 不是 JSON、或沒有任何 success 欄位
//     ⇒ 回「看不出來」＝照舊當成功。寧可漏判，不可把一次格式變更變成全面停擺。
//   - **不猜語意**：只認 `success:false` 這個明確訊號，不去猜 data 裡別的欄位。
//   - **講人話**：訊息會出現在使用者畫面上，不裸露狀態碼與上游 JSON 原文
//     （同 direct_quota_test.go 那份禁字表）。
package collector

import (
	"encoding/json"
	"strings"
)

// triggerEnvelope＝named-webhook 觸發端點的回應外殼。
// `Data` 用 json.RawMessage：它可能是物件、陣列、字串，甚至 null——
// 硬綁成 map 會在形狀一變時整條路 panic 或誤判。
type triggerEnvelope struct {
	Success *bool           `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

// triggerInner＝工作流最後一個節點的輸出裡，我們唯一認得的兩個欄位。
type triggerInner struct {
	Success *bool  `json:"success"`
	Error   string `json:"error"`
}

// webhookFailure 檢查「HTTP 2xx 的觸發回應裡，工作流是不是其實失敗了」。
//
// 回空字串＝沒看出失敗（真的成功，或這個回應我們看不懂——兩者都放行）。
// 回非空＝**確定失敗**，字串是給使用者看的那句話。
func webhookFailure(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" || (!strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[")) {
		return "" // 不是 JSON ⇒ 看不出來 ⇒ 放行
	}
	var env triggerEnvelope
	if err := json.Unmarshal([]byte(trimmed), &env); err != nil {
		return "" // 解析不了（含被截斷）⇒ 看不出來 ⇒ 放行
	}
	// ① 外層自己就說失敗
	if env.Success != nil && !*env.Success {
		return ingestFailureSentence(env.Error)
	}
	// ② 外層說成功，但工作流的輸出說失敗——本檔存在的理由就是這一格
	if len(env.Data) > 0 {
		var inner triggerInner
		if err := json.Unmarshal(env.Data, &inner); err == nil && inner.Success != nil && !*inner.Success {
			return ingestFailureSentence(inner.Error)
		}
	}
	return ""
}

// ingestFailureSentence 把上游那串技術文字換成一句使用者讀得懂的話。
//
// 🔴 不是 debug 訊息，是產品文案：使用者看到「已整理 26 份」卻查不到東西的當下，
// 唯一能讓他知道發生什麼事的就是這句（#104 的紅線：不要讓他猜）。
// 認不出來的原因不編故事，只誠實說「雲端沒有寫進去」。
func ingestFailureSentence(raw string) string {
	const head = "雲端收下了，但你的知識庫沒有真的寫進去（這一份還查不到）"
	switch {
	case strings.Contains(raw, "unreachable"):
		return head + "：連不到知識庫的資料層。稍後會自動再試。"
	case strings.Contains(raw, "card_content 為空"):
		return head + "：這份檔萃出來是空的。"
	case strings.Contains(raw, "credential"):
		return head + "：知識庫的內部金鑰不對，要重裝一次雲端才會通。"
	default:
		return head + "，稍後會自動再試。"
	}
}
