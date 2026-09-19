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
	"errors"
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
func webhookFailure(body string, probe credentialProbe) string {
	raw, ok := failureReason(body)
	if !ok {
		return ""
	}
	return ingestFailureSentence(headAccepted, raw, probe)
}

// failureReason 從觸發回應裡挖出「工作流自己說的失敗原因」原文。
// ok=false ⇒ 沒看出失敗（真的成功，或這個回應我們看不懂——兩者都放行）。
func failureReason(body string) (string, bool) {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" || (!strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[")) {
		return "", false // 不是 JSON ⇒ 看不出來 ⇒ 放行
	}
	var env triggerEnvelope
	if err := json.Unmarshal([]byte(trimmed), &env); err != nil {
		return "", false // 解析不了（含被截斷）⇒ 看不出來 ⇒ 放行
	}
	// ① 外層自己就說失敗
	if env.Success != nil && !*env.Success {
		return env.Error, true
	}
	// ② 外層說成功，但工作流的輸出說失敗——本檔存在的理由就是這一格
	if len(env.Data) > 0 {
		var inner triggerInner
		if err := json.Unmarshal(env.Data, &inner); err == nil && inner.Success != nil && !*inner.Success {
			return inner.Error, true
		}
	}
	return "", false
}

// triggerFailure＝一則觸發失敗的**兩張臉**：使用者讀的那句（`Error()`）
// 與工程師要的上游原文（`raw`）。
//
// 🔴 這兩張臉不准合併成一張。合併過的下場就是這張票的兩半：
//   - 合成「原文」⇒ 上游那句「修復: 編輯 credentials.yaml…」直接印到使用者臉上
//   - 合成「人話」⇒ 為了不嚇人，連證據一起丟掉，檢修孔就再也看不到出了什麼事
//     （leo 2026-09-10：「客戶的測試環境，我們應該有檢修孔看到出了什麼事」）
type triggerFailure struct {
	sentence string
	raw      string
}

func (e *triggerFailure) Error() string { return e.sentence }

// upstreamDetail 取出上游原文（給檢修孔／log 用）。不是 triggerFailure 就回空字串。
func upstreamDetail(err error) string {
	var tf *triggerFailure
	if errors.As(err, &tf) {
		return tf.raw
	}
	return ""
}

// 兩種開頭，因為「收下了但沒寫進去」與「根本沒收下」是兩件事，不准講成同一句。
const (
	headAccepted = "雲端收下了，但你的知識庫沒有真的寫進去（這一份還查不到）"
	headRejected = "雲端沒有把這一份寫進你的知識庫"
)

// triggerRejectedSentence 給**非 2xx** 的觸發回應用（`inkstone/arcrun-rag#179` c6867）。
//
// 🔴 為什麼要有這一支：原本非 2xx 直接把 `HTTP 500：<上游 JSON 原文>` 當成錯誤丟出去，
// 而那串原文裡就寫著「修復: 編輯 credentials.yaml 後執行 …」——
// **我們把一句叫使用者去修一個沒壞的東西的指示，原封不動印到他畫面上。**
// 這同時違反本檔開頭第三條自我約束（講人話、不裸露狀態碼與上游 JSON 原文）。
//
// 回空字串＝這個回應不是我們認得的「工作流自己說失敗」的形狀（例如額度、401），
// 呼叫端保留原本的技術字串——那些路徑另有判準在讀它，不在本票射程內。
func triggerRejectedSentence(body string, probe credentialProbe) string {
	raw, ok := failureReason(body)
	if !ok {
		return ""
	}
	return ingestFailureSentence(headRejected, raw, probe)
}

// ingestFailureSentence 把上游那串技術文字換成一句使用者讀得懂的話。
//
// 🔴 不是 debug 訊息，是產品文案：使用者看到「已整理 26 份」卻查不到東西的當下，
// 唯一能讓他知道發生什麼事的就是這句（#104 的紅線：不要讓他猜）。
// 認不出來的原因不編故事，只誠實說「雲端沒有寫進去」。
func ingestFailureSentence(head, raw string, probe credentialProbe) string {
	switch {
	case strings.Contains(raw, "unreachable"):
		return head + "：連不到知識庫的資料層。稍後會自動再試。"
	case strings.Contains(raw, "card_content 為空"):
		return head + "：這份檔萃出來是空的。"
	case strings.Contains(raw, "credential"):
		return credentialSentence(head, raw, probe)
	default:
		return head + "，稍後會自動再試。"
	}
}

// credentialSentence 決定「取不到內部金鑰」這一類要講哪一句。
//
// 🔴 舊版只有一句：「知識庫的內部金鑰不對，要重裝一次雲端才會通。」
// 它有兩個問題，而且兩個都是這張票在治的那個病：
//   - **它指定了一個修法**，但上游那句話在「金鑰真的沒種進去」與「目錄暫時讀不到」
//     兩種原因下長得一模一樣（見 credentialcause.go 檔頭那三行證據）
//     ⇒ 資料層抖一下，我們就叫使用者去重裝整座雲端。
//   - 就算真的是金鑰沒種進去，**重裝也不是使用者的活**——那是我們的安裝沒到位。
//
// ⇒ 現在先去問一次目錄（探針），問得出來才講原因，問不出來就說不知道。
func credentialSentence(head, raw string, probe credentialProbe) string {
	name := credentialNameIn(raw)
	rep := credDirReport{Status: credDirUnknown}
	if probe != nil {
		rep = probe()
	}
	switch {
	case rep.Status == credDirUnreachable:
		// 這一格就是總管 2026-09-10 追了一整天的那個誤導：資料層讀不到而已。
		return head + "：連不到知識庫的資料層（金鑰目錄現在讀不到，不是金鑰不見了）。稍後會自動再試。"
	case rep.Status == credDirReadable && name != "" && !rep.has(name):
		// 目錄讀得到、就是沒有這一把 ⇒ 我們的安裝沒到位。使用者做不了任何事，
		// 唯一的出路是交回我們（不叫他重裝——重裝跑的是同一支安裝步驟）。
		return head + "：這個實例的內部金鑰沒有裝上去，這是我們這邊沒做完的事，不是你的設定。請把這一句回報給我們。"
	case rep.Status == credDirReadable && name != "" && rep.has(name):
		// 目錄有它，壞的是取值那一段。分得出來就要說出來，不要含混成上一句。
		return head + "：內部金鑰在，但雲端這一趟取不到它的值。請把這一句回報給我們。"
	default:
		// 問不出來就說不知道——**不編一個原因**（頂層鐵律：帶著免責聲明的猜測比誠實說不知道更貴）。
		return head + "：雲端取不到它要用的內部金鑰，我們還沒能分辨是金鑰沒裝上、還是資料層暫時讀不到。稍後會自動再試；一直這樣請回報給我們。"
	}
}
