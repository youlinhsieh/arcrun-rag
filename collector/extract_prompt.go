// extract_prompt.go — 萃取契約（提示詞＋JSON 解析）：全部萃取路共用的唯一一份。
//
// 🔴 inkstone/arcrun-rag#58（leo 2026-10-01）：本檔原名 extract_gemma.go，曾是 daemon 直呼
// Google Gemini 的「gemma 路」。那條路連同 `config.json` 裡的明碼 `gemini_api_key` 已拔除——
// 萃取 AI 一律在雲端（CF 雲＝Workers AI、企業私有雲＝Ollama，走同一條 /portal/daemon/extract），
// 小幫手只轉發。留下來的是與 LLM 供應商無關的部分：提示詞怎麼寫、模型回的 JSON 怎麼解析。
// 模型只回 JSON（判斷），格式與落點全由 wikishape.go 機械組裝。
package collector

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// extractTableRequest 是送上雲的萃取請求「這段是哪一類」的部分（inkstone/Arcrun#299）。
//
// 🔴 2026-10-10 起**指示不住小幫手**：原本這裡有一段 208 行的 wikiExtractPrompt，整段帶上雲
// （Arcrun#134 的設計）。leo：「現在的 prompt 就是程式碼，既然程式碼解耦，prompt 也應該解耦」
// ⇒ 指示改成雲端的一張表（每塊一個 key、一個版本，Arcrun `cypher-executor/src/lib/prompt-tables/`），
// 改一個決策＝雲端改一塊，不必等每位用戶更新小幫手。ADR：Arcrun
// `system-dev/docs/2-architecture/decisions/ADR-299-extract-prompt-table.md`。
//
// 小幫手只送三樣：哪一張表（PromptTable）、這段是哪一類（Kinds，讀檔特例編號，見 edgecases.go）、
// 機械掃出的資料（Hints）。判斷「是哪一類」仍是小幫手的事（偵測住 Go、登記在 edgecases.go），
// 「是這一類時要怎麼跟模型說」是雲端那張表的事。
// 契約的另一半（模型回的 JSON 怎麼解析、卡怎麼組）仍住本 package：parseWikiExtractJSON／BuildWikiDoc。
const extractPromptTable = "extract_wiki"

type extractTableRequest struct {
	Kinds []string            `json:"kinds"`
	Hints map[string][]string `json:"hints"`
}

// extractRequestFor 判斷這段文字是哪一類，並附上機械掃出的資料。
// 目前只有一類：chunk-cliff（重複條目結構，見 candidateRecordLabels）。新增一類＝
// 先在 edgecases.go 登記那個編號、在這裡偵測、再到雲端那張表加一塊 when=<編號> 的指示。
func extractRequestFor(content string) extractTableRequest {
	req := extractTableRequest{Kinds: []string{}, Hints: map[string][]string{}}
	if labels := candidateRecordLabels(content); len(labels) >= 3 {
		req.Kinds = append(req.Kinds, "chunk-cliff")
		req.Hints["labels"] = labels
	}
	return req
}

// candidateRecordLabels 機械掃出「這段文字裡有沒有重複出現的條目識別碼」（特例 chunk-cliff 的偵測）。
//
// 🔴 為什麼要有這個函式（arcrun-rag#213，總管 c10637 要求「調到全數覆蓋」，實測見下）：
// 光靠文字指示 LLM「原稿有重複條目就每條都列成 entity」，實測（`api-recipe-seeds.ts`
// 同款模型／參數，llama-4-scout、temperature 0.2）在客戶 NC 手冊的真實段落上只能做到
// 20-40% 覆蓋率，且同一份輸入跑兩次結果不穩定——「注意到＋窮舉」對這顆模型是不可靠的
// 任務。「照著給定清單，逐條描述」則容易得多：把「注意到有幾條」這件事改成機械做
// （regex／字串比對，零 LLM 判斷、零隨機性），LLM 只負責「這條原文寫的是什麼、怎麼
// 濃縮成一句話」——分工上更接近 wikishape.go 檔頭那句「模型只負責判斷，格式與落點
// 全部是機械的」的既有原則，不是新發明一條路。
//
// 🔴 這不是「查表型偵測」（c10627 明文禁止的：偵測文件形狀 → 換一條主路徑／換切法）：
// 本函式**不影響**切段大小、不影響走不走續讀機制、不影響任何路由決策——它只是在
// 「已經定案要送出去的這個 chunk」裡，順手掃出候選清單（#299 起以 hints.labels 送上雲，
// 由雲端表上 when=chunk-cliff 那一塊帶給模型）。沒有重複條目結構的一般文件（散文、報告）
// 呼叫這個函式只會拿到空清單，請求裡就不會有 chunk-cliff 這一類。
//
// 判準是純結構性的，不認得任何領域詞彙，也不依賴空行（轉檔後的純文字不一定保留
// 段落間的空行——實測 `ConvertToText` 對這份 PDF 的輸出逐行相接，沒有空行）：
// 先找出在整段內重複出現 ≥3 次的短行（多半是「ERROR MESSAGE」「CAUSE OF ERROR」
// 這類欄位名——同一份文件會用同一套欄位名反覆標示每一條紀錄），這種行本身**不是**
// 候選；**候選是「下一行就是這種重複欄位名」的那一行本身**——也就是每條紀錄開頭、
// 緊接在第一個欄位名之前的那個識別碼。任何「一條紀錄＝識別碼＋固定幾個欄位」的格式
// 都適用（錯誤碼手冊、FAQ、詞彙表、changelog…），不只是這一份 NC 手冊；候選數 <3
// 視為訊號太弱（可能只是巧合），不當作重複條目結構處理。
func candidateRecordLabels(content string) []string {
	lines := strings.Split(content, "\n")
	freq := map[string]int{}
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "" || len([]rune(t)) > 60 {
			continue
		}
		freq[t]++
	}
	var labels []string
	seen := map[string]bool{}
	for i := 0; i < len(lines)-1; i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" || len([]rune(t)) > 60 || freq[t] >= 3 {
			continue // 空行／太長／自己就是常見欄位名 ⇒ 不是候選
		}
		next := strings.TrimSpace(lines[i+1])
		if freq[next] >= 3 && !seen[t] {
			seen[t] = true
			labels = append(labels, t)
		}
	}
	if len(labels) < 3 {
		return nil // 訊號太弱——一般文件，不受影響
	}
	return labels
}

// parseWikiExtractJSON 從模型輸出撈出 JSON 並解析成 DocExtract。
// thinking 模型可能在 JSON 前後夾雜文字／圍欄：取第一個 '{' 到最後一個 '}'。
func parseWikiExtractJSON(text string) (*DocExtract, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("模型輸出裡找不到 JSON 物件：%.120s", text)
	}
	raw := []byte(text[start : end+1])
	var ex DocExtract
	err := json.Unmarshal(raw, &ex)
	if err == nil {
		return &ex, nil
	}
	// 模型偶爾在「該是字串清單」的欄位塞 bool／數字／null，或把清單寫成單一字串
	// （inkstone/arcrun-rag#240 c18241：126-011E 的 points 夾了 bool，整份被擋 8 次）。
	// 這是格式的小毛病不是內容壞了：把這幾個欄位正規化後再解一次，仍失敗才報錯。
	if fixed, ok := normalizeStringListFields(raw); ok {
		var ex2 DocExtract
		if err2 := json.Unmarshal(fixed, &ex2); err2 == nil {
			return &ex2, nil
		}
	}
	return nil, fmt.Errorf("萃取 JSON 解析失敗：%w（%.120s）", err, text[start:end+1])
}

// normalizeStringListFields 把文件層與各概念的 tags／points 正規化成純字串清單：
// 字串保留、數字轉字串、bool／null／物件丟掉、單一字串包成一項。
func normalizeStringListFields(raw []byte) ([]byte, bool) {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil, false
	}
	fix := func(o map[string]any) {
		for _, k := range []string{"tags", "points"} {
			v, present := o[k]
			if !present {
				continue
			}
			var out []string
			switch t := v.(type) {
			case string:
				if strings.TrimSpace(t) != "" {
					out = []string{t}
				}
			case []any:
				for _, e := range t {
					switch x := e.(type) {
					case string:
						out = append(out, x)
					case float64:
						out = append(out, strconv.FormatFloat(x, 'f', -1, 64))
					}
				}
			}
			if out == nil {
				out = []string{}
			}
			o[k] = out
		}
	}
	fix(m)
	if cs, ok := m["concepts"].([]any); ok {
		for _, c := range cs {
			if co, ok := c.(map[string]any); ok {
				fix(co)
			}
		}
	}
	b, err := json.Marshal(m)
	return b, err == nil
}

// cleanLegacyCard 淨化思考型模型輸出：取最後一個「# <pageName>」起的內容（前面全是草稿）。
func cleanLegacyCard(text, pageName string) string {
	marker := "# " + pageName
	if i := strings.LastIndex(text, marker); i >= 0 {
		return strings.TrimSpace(text[i:]) + "\n"
	}
	return strings.TrimSpace(text) + "\n"
}
