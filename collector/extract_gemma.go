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

// gemmaPrompt 組出與 rag_extract_one 同款的萃卡指令。
func gemmaPrompt(pageName, content string) string {
	return "把以下原稿重寫成定稿知識卡（正體中文）。直接輸出卡片本身：第一行必須是「# " + pageName +
		"」，不要任何前言、思考過程、英文草稿或說明。格式：\n# " + pageName +
		"\n## 一句話定義\n（一行）\n## 要點\n- （3-12 條，具體、含數字條件）\n## 關鍵實體\n- **實體名** — 一句說明\n## 關聯\n- 實體A >> 謂詞 >> 實體B（3-8 行，用上面實體名）\n\n原稿：\n" + content
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
func ExtractWithGemma(apiKey, model, absRoot, relPath string) ([]string, error) {
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
			{"parts": []map[string]any{{"text": gemmaPrompt(pageName, srcText)}}},
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

	card := cleanGemmaCard(text, pageName)
	if !strings.HasPrefix(card, "# ") {
		return nil, fmt.Errorf("萃出內容不像卡片（未以 # 開頭）：%.120s", card)
	}
	// arcrun-rag#60：非 vault 落 system-dev/wiki/cards/、vault 改落隱藏目錄，避免污染筆記軟體的頁面清單；
	// 落地前先查目標存不存在、不無條件覆蓋（safeWriteCard），兩條都是同一票的紅線。
	cardRel := filepath.ToSlash(filepath.Join(cardsRelDirFor(absRoot), pageName+".md"))
	dest := filepath.Join(absRoot, filepath.FromSlash(cardRel))
	if err := safeWriteCard(dest, []byte(card)); err != nil {
		return nil, err
	}
	return []string{cardRel}, nil
}
