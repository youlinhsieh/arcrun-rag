// extract_gemma.go — gemma 本地萃取路（daemon-beta task 4）。
//
// prompt 與淨化規則抄自實戰版 rag_extract_one workflow（同一套格式：一句話定義/要點/
// 關鍵實體/關聯），差別只在跑的位置：workflow 在雲端實例跑、這裡在用戶機器上由 daemon 直呼。
// 原文內容過境 Gemini API 一次，不落任何雲端儲存（四步定稿邊界）。
//
// gemma-4-31b 是思考型模型：parts[0] 常是 thought=true 的思考草稿，真答案在最後一個
// 非 thought 的 text part（agent-memory §7.6 實撞教訓，讀法照抄）。
package collector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// gemmaBaseURL 可注入（測試用 httptest 替身）。
var gemmaBaseURL = "https://generativelanguage.googleapis.com"

const defaultLLMModel = "gemma-4-31b-it"

var gemmaHTTP = &http.Client{Timeout: 120 * time.Second}

// wikiExtractPrompt 組出「文件卡＋N 張原子概念卡」的結構化萃取指令（InkStoneCo#44 ④）。
//
// 🔴 這是**全部萃取路共用的唯一一份**提示詞（Arcrun#134 起原名 gemmaPrompt 改此名）：
// gemma 路自己打 Gemini 用它；workers-ai 路把它整段帶去雲端（`prompt` 欄位）給
// env.AI 跑。契約（提示詞＋parseWikiExtractJSON＋BuildWikiDoc）同住本 package
// ⇒ 兩條路的卡片形狀由同一份程式碼保證，不再靠「兩邊要一起改」的叮嚀。
//
// 🔴 分工：模型只回 JSON（判斷），格式與落點全由 wikishape.go 機械組裝——
// 模型不寫 markdown、不決定檔名、不碰路徑。Luhmann ②（一卡一概念）在**萃取端**做，
// 否則 place_card 只會一直回 orphan（規範待裁 6 的裁定理由）。
func wikiExtractPrompt(pageName, content string) string {
	return `你是知識整理員。讀完原稿後，把它整理成「一份文件的總覽＋N 個原子概念」。只輸出一個 JSON 物件，不要任何說明、markdown 圍欄或思考過程。

規則（違反任何一條都算失敗）：
- 卡片內容是你的**判斷與重組**（正體中文），禁止整句照抄原稿。
- 概念數由內容決定（多數文件 1-5 個）；每個概念要能**離開原稿獨立成立**。
- 報價單、發票、純待辦、純流水帳＝沒有可萃取概念：回 {"no_concept":true,"reason":"一句話理由"} 即可。
- gloss＝一句話（40 字內）。summary＝一小段（80-200 字）。points＝3-8 條判斷句（不是條列複述）。
- 文件層的 points 每條要把相關概念名用 [[概念名]] 嵌在**句子中間**（不可放句首當標題）。
- entities：每個實體帶 type（人物/組織/工具/概念/地點/事件/檔案 擇一）與一句描述。
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

// parseWikiExtractJSON 從模型輸出撈出 JSON 並解析成 DocExtract。
// thinking 模型可能在 JSON 前後夾雜文字／圍欄：取第一個 '{' 到最後一個 '}'。
func parseWikiExtractJSON(text string) (*DocExtract, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("模型輸出裡找不到 JSON 物件：%.120s", text)
	}
	var ex DocExtract
	if err := json.Unmarshal([]byte(text[start:end+1]), &ex); err != nil {
		return nil, fmt.Errorf("萃取 JSON 解析失敗：%w（%.120s）", err, text[start:end+1])
	}
	return &ex, nil
}

// cleanGemmaCard 淨化思考型模型輸出：取最後一個「# <pageName>」起的內容（前面全是草稿）。
func cleanGemmaCard(text, pageName string) string {
	marker := "# " + pageName
	if i := strings.LastIndex(text, marker); i >= 0 {
		return strings.TrimSpace(text[i:]) + "\n"
	}
	return strings.TrimSpace(text) + "\n"
}

// ExtractWithGemma 讀原稿 → 呼 Gemini 萃卡 → 卡片落地 system-dev/wiki/cards/。
// 回傳產出的卡片相對路徑（單檔一卡）。
func ExtractWithGemma(apiKey, model, absRoot, relPath string, origin SourceOrigin) ([]string, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("gemma 萃取路需要 gemini_api_key（config）")
	}
	if model == "" {
		model = defaultLLMModel
	}
	raw, err := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return nil, fmt.Errorf("讀原稿失敗：%w", err)
	}

	// 本地轉檔層（t73/t16，2026-07-27）：任何格式在這裡變成「模型可讀的純文字」。
	// 純文字檔原樣通過；.docx 等走對應抽取器。**LLM 只會收到文字，永遠不會收到二進位**
	//（那正是這一層存在的理由——見 convert.go 檔頭與 pdf-extraction-options.md 洞 B）。
	srcText, err := ConvertToText(relPath, raw)
	if err != nil {
		// 這裡刻意**不吞錯**：靜默略過正是 leo 撞到的病（丟檔進去沒反應）。
		// ErrNoText＝掃描件/空檔，ErrUnsupported＝還沒支援的格式，兩者訊息不同但都要說出來。
		return nil, fmt.Errorf("轉檔失敗（%s）：%w", relPath, err)
	}

	pageName := pageNameOf(relPath)

	reqBody, _ := json.Marshal(map[string]any{
		"contents": []map[string]any{
			{"parts": []map[string]any{{"text": wikiExtractPrompt(pageName, srcText)}}},
		},
		"generationConfig": map[string]any{"temperature": 0.2, "maxOutputTokens": 8192},
	})
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent", gemmaBaseURL, model)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", apiKey)
	resp, err := gemmaHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Gemini API 連線失敗：%w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Gemini API HTTP %d：%.300s", resp.StatusCode, string(body))
	}

	// 解析：candidates[0].content.parts → 最後一個非 thought 的 text part
	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Thought bool   `json:"thought"`
					Text    string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("Gemini 回應解析失敗：%w", err)
	}
	var text string
	if len(parsed.Candidates) > 0 {
		parts := parsed.Candidates[0].Content.Parts
		for i := len(parts) - 1; i >= 0; i-- {
			if !parts[i].Thought && parts[i].Text != "" {
				text = parts[i].Text
				break
			}
		}
	}
	if text == "" {
		return nil, fmt.Errorf("Gemini 回應沒有可用文字（thought-only 或空回應）")
	}

	// InkStoneCo#44 ④（2026-08-15）：產出改走塑形層——模型回 JSON（判斷），
	// wikishape.go 機械組裝出規範形的 `.wiki/` 卡（文件卡＋原子概念卡＋索引＋manifest）。
	// 舊的「單檔一卡落 cards/」由此淘汰（差距表 #6–#10 的現狀）；
	// #60 的兩條保護換了形式仍在：落點是隱藏目錄（不進筆記軟體）、既有檔一律不覆蓋。
	ex, perr := parseWikiExtractJSON(text)
	if perr != nil {
		return nil, perr
	}
	cards, berr := BuildWikiDoc(absRoot, relPath, srcText, ex, origin, time.Now())
	if berr != nil {
		return nil, berr
	}
	// 沒有可萃概念＝合法結果：不產卡，但 00-INDEX 已列「空」（差距 #10）。
	return cards, nil
}
