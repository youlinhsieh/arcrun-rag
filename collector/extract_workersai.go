// extract_workersai.go — 走「自己雲端實例的 Workers AI」萃卡（t181，**免金鑰**）。
//
// 🔴 為什麼有這條路（leo 2026-08-04 列為最優先）：
//
//	「daemon 的 AI 改用 workers AI」——「這是我的用戶**最大障礙**，
//	 造成首輪測試用戶的**好評或惡評**」。
//
// 舊的 gemma 路要用戶自己去 Google 申請 API Key，實測撞到三種災難：
//  1. 完全不知道要去哪裡設定（封測者是台大資工碩士都卡住 ⇒ leo：「一般人就完蛋了」）
//  2. 拿到的金鑰所屬 Google 帳號被 flag ⇒ 403 PERMISSION_DENIED；換專案無效、
//     申訴要 billing account 而 free tier 進不去＝死結
//  3. 52 檔全滅、零產出，還要把金鑰傳給別人實打才查得出真因
//
// ⇒ 本路徑改打**用戶自己雲端實例**的 `/portal/daemon/extract`，
//
//	那端用 `env.AI` binding（Workers AI）⇒ **完全不需要任何金鑰**。
//	用的是用戶自己 CF 帳號內建的 AI；他的 Google 帳號被封也不受影響。
//
// 架構上與 gemma 路完全對稱（leo 的判斷：「不論用 Claude／Gemini／Workers AI，
// 都是把原文經過 daemon 變成文字送到一個 API，**應該是同一件事**」——是）：
//
//	讀原檔 → ConvertToText（本機轉檔）→ 送 API → 淨化 → 落卡
//	                                    ↑ 只有這一步不同
//
// 🔴 Arcrun#134（2026-08-15）：**提示詞也由 daemon 帶去**（request 的 `prompt` 欄位）。
// 之前雲端自備一份 prompt、daemon 另有一份 gemma 用的，兩份靠註解叮嚀「一起改」——
// InkStoneCo#44 ④ 改了 gemma 那份（JSON 契約＋wikishape 機械組卡），雲端沒跟上，
// 免金鑰預設路的用戶因此繼續拿舊格式卡。修法＝契約只住本 package 一份
// （wikiExtractPrompt ＋ parseWikiExtractJSON ＋ BuildWikiDoc 同進同出），
// 雲端只是「用實例自己的 env.AI 跑生成」的執行器，回應 `output` 原文。
// 版本歪斜：舊雲端會忽略 prompt、照舊回 `card`（舊格式 markdown）⇒ 本檔 fallback
// 走 legacy 落卡（收端 lint 新舊雙軌仍接受，#60 的前綴與不覆蓋保護原封不動）。
//
// ⚠️ 隱私邊界不變：送出去的是**已在本機轉成純文字的原稿**，回來的是知識卡；
// 原始檔案（docx/pdf/xlsx）仍然不出用戶的電腦。
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

// workersAIHTTP 逾時放寬到 90s：雲端要跑 LLM 生成，比一般 API 慢。
// （選型實測 llama-4-scout 約 2.4s，但長文＋冷啟動要留餘裕。）
var workersAIHTTP = &http.Client{Timeout: 90 * time.Second}

// ExtractWithWorkersAI 讀原稿 → 送自己雲端的 /portal/daemon/extract 萃卡 → 卡片落地。
// cypherURL/apiKey 用的是 daemon 既有的連線憑證（送卡片上雲時同一把，見 direct.go）。
// 回傳產出的卡片相對路徑（單檔一卡），與 ExtractWithGemma 契約一致。
func ExtractWithWorkersAI(cypherURL, apiKey, absRoot, relPath string) ([]string, error) {
	if strings.TrimSpace(cypherURL) == "" {
		return nil, fmt.Errorf("workers-ai 萃取路需要 cypher_url（config）")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("workers-ai 萃取路需要 api_key（config）")
	}

	raw, err := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return nil, fmt.Errorf("讀原稿失敗：%w", err)
	}

	// 本地轉檔層與 gemma 路共用同一份（t73/t16）：任何格式在這裡變成純文字。
	// **LLM 只會收到文字，永遠不會收到二進位**。刻意不吞錯——靜默略過正是 leo 撞過的病。
	srcText, err := ConvertToText(relPath, raw)
	if err != nil {
		return nil, fmt.Errorf("轉檔失敗（%s）：%w", relPath, err)
	}

	pageName := pageNameOf(relPath)
	// #134：prompt＝與 gemma 路同一份契約（同 package 同函式，物理上不可能漂移）。
	// page_name/text 仍照送：舊雲端不認得 prompt，會拿它們組 legacy 提示詞回舊卡。
	reqBody, _ := json.Marshal(map[string]string{
		"page_name": pageName,
		"text":      srcText,
		"prompt":    wikiExtractPrompt(pageName, srcText),
	})

	url := strings.TrimSuffix(strings.TrimSpace(cypherURL), "/") + "/portal/daemon/extract"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Arcrun-API-Key", apiKey)

	resp, err := workersAIHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("連不上你的知識庫：%w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))

	if resp.StatusCode == http.StatusNotFound {
		// 舊實例還沒有這條 route ⇒ 講人話，別讓用戶看到裸 404
		return nil, fmt.Errorf("你的知識庫還是舊版（沒有雲端萃取功能）⇒ 請到 portal 按「立即更新」重裝一次")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Error != "" {
			return nil, fmt.Errorf("雲端萃取失敗（HTTP %d）：%s", resp.StatusCode, e.Error)
		}
		return nil, fmt.Errorf("雲端萃取失敗（HTTP %d）：%.200s", resp.StatusCode, string(body))
	}

	var parsed struct {
		Success bool   `json:"success"`
		Card    string `json:"card"`
		Output  string `json:"output"` // #134：新雲端在 prompt 模式回模型原文
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("雲端回應解析失敗：%w", err)
	}
	if !parsed.Success || (strings.TrimSpace(parsed.Card) == "" && strings.TrimSpace(parsed.Output) == "") {
		if parsed.Error != "" {
			return nil, fmt.Errorf("雲端萃取失敗：%s", parsed.Error)
		}
		return nil, fmt.Errorf("雲端沒有回傳卡片內容")
	}

	// #134 主線：新雲端回 `output`（模型對 wikiExtractPrompt 的原始回應）⇒
	// 與 gemma 路走**同一段**收尾：解析 JSON 判斷 → wikishape 機械組卡落 `.wiki/`。
	// 兩條萃取路的卡片形狀從此由同一份程式碼保證，不是由兩份 prompt 各自維持。
	if strings.TrimSpace(parsed.Output) != "" {
		ex, perr := parseWikiExtractJSON(parsed.Output)
		if perr != nil {
			return nil, perr
		}
		cards, berr := BuildWikiDoc(absRoot, relPath, srcText, ex, time.Now())
		if berr != nil {
			return nil, berr
		}
		// 沒有可萃概念＝合法結果：不產卡，00-INDEX 列「空」（同 gemma 路）。
		return cards, nil
	}

	// legacy fallback：舊雲端（不認得 prompt）回 `card`（舊格式 markdown）。
	// 與 gemma 舊路同一套淨化與落卡（第一行必須是「# <頁名>」），#60 保護不動。
	card := cleanGemmaCard(parsed.Card, pageName)
	if !strings.HasPrefix(card, "# ") {
		return nil, fmt.Errorf("萃出內容不像卡片（未以 # 開頭）：%.120s", card)
	}
	// arcrun-rag#60：路徑與檔名都由 cardRelFor 決定——非 vault 落 system-dev/wiki/cards/、
	// vault 落隱藏目錄，且**檔名一律帶 arcrun- 前綴**（第二輪：光換目錄擋不住撞名，
	// 因為 Logseq 的頁名是 basename）。落地前先查目標存不存在、不無條件覆蓋（safeWriteCard）。
	cardRel := cardRelFor(absRoot, pageName)
	dest := filepath.Join(absRoot, filepath.FromSlash(cardRel))
	if err := safeWriteCard(absRoot, dest, []byte(card)); err != nil {
		return nil, err
	}
	return []string{cardRel}, nil
}
