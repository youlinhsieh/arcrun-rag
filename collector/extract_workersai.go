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

// maxWorkersAIExtractBytes＝送進雲端萃取的純文字上限（位元組）。
//
// 🔴 為什麼要有這道閘（2026-08-26 實測 `InkStoneCo`，非推測）：
// 這條路沒有任何長度判斷——整份原稿原封不動塞進 prompt。leo 的
// `system-dev/wiki/mistakes.md`（562 KB）、`status.md`（401 KB）、
// `status-archive-2026-08.md`（511 KB）因此每一輪都撞同一面牆，
// 而使用者看到的是這串**沒有人讀得懂的東西**：
//
//	本地萃取失敗：雲端萃取失敗（HTTP 502）：Workers AI 執行失敗：8007:
//	{"error":{"message":"This model's maximum context length is 131000 tokens…
//
// ⇒ 兩個錯：①明知一定會失敗還是送出去（每次燒一份額度、拖住整個佇列）
//
//	②失敗的理由沒有翻成人話（#104 的紅線：不要讓他猜）。
//
// 300,000 這個數字怎麼來的：實測那份 401,526 位元組的檔，上游回報
// 「prompt contains at least 122,xxx tokens」，而可用輸入是
// 131,000 − 8,192(輸出) ≈ 122,800 ⇒ 中文原稿約 3.3 位元組/token。
// 300 KB ≈ 9 萬 token，留了三成餘裕給提示詞本身與英數混排的變異。
//
// ⚠️ 這個上限只綁**這條路**（雲端 llama-4-scout 的 131k 視窗）。
// gemma 路走 Gemini、視窗大一個數量級，不受此限——判準跟著模型走，
// 不做成全域常數，免得換模型時有人以為它是產品規格。
const maxWorkersAIExtractBytes = 300_000

// wordCountOf 用**實際字元數**（rune）估「約幾萬字」，取代舊版 `len(bytes)/3`。
//
// 🔴 為什麼要改（#213 scout c10575 第 2 點）：bytes/3 假設整份都是中文（UTF-8 中文
// 3 bytes/字），客戶那份 NC 手冊幾乎全英文（1 byte/字）⇒ 舊算法把「約 98 萬字」
// 講成中文讀者的三倍大，使用者以為檔案比實際誇張很多。rune 數是**語言中立**的
// 「這份稿有幾個字元」，中英文都準。
func wordCountOf(srcText string) int {
	return len([]rune(srcText))
}

// tooBigForWorkersAI 回傳「這份原稿太大，這條路讀不完」的人話理由；
// 沒超過回空字串。
//
// 🔴 arcrun-rag#213（leo 2026-09-22 定向）：**超過上限不再直接拒收**——見
// extract_resume.go 的一般化「分次讀、本機存書籤、隔天接著讀」機制。這裡保留的
// 判斷只用來決定「這份原稿要不要走那條路」，訊息本身也改記錄用途（legacy 雲端
// 仍可能撞到，見 extractResumableWorkersAI 的 legacy fallback）。
//
// 🔴 訊息是產品文案不是 debug 字串：要講**多大**、**為什麼**、**他能做什麼**，
// 而且不准出現狀態碼、模型名或 token 這種只有工程師看得懂的詞。
func tooBigForWorkersAI(srcText, relPath string) string {
	if len(srcText) <= maxWorkersAIExtractBytes {
		return ""
	}
	wan := wordCountOf(srcText) / 10000
	return fmt.Sprintf(
		"這份檔比較大（約 %d 萬字），雲端的整理模型一次讀不完，"+
			"改成分次整理、每天接著讀之前讀到的地方。", wan)
}

// ExtractWithWorkersAI 讀原稿 → 送自己雲端的 /portal/daemon/extract 萃卡 → 卡片落地。
// cypherURL/apiKey 用的是 daemon 既有的連線憑證（送卡片上雲時同一把，見 direct.go）。
// 回傳產出的卡片相對路徑（單檔一卡；分次讀的大檔可能是一卡＋多張分次完成的概念卡）。
func ExtractWithWorkersAI(cypherURL, apiKey, absRoot, relPath string, origin SourceOrigin) ([]string, error) {
	return extractWithWorkersAI(cypherURL, apiKey, absRoot, relPath, origin, false)
}

// workersAIExtractURL＝萃取端點。探測（probe_workersai.go）與萃取打的是同一條路，
// 退避（routebackoff.go）也用這一個網址當鍵。
func workersAIExtractURL(cypherURL string) string {
	return strings.TrimSuffix(strings.TrimSpace(cypherURL), "/") + "/portal/daemon/extract"
}

// extractWithWorkersAI＝ExtractWithWorkersAI，多帶 retry：這個檔先前就失敗過。
// `inkstone/arcrun-rag#121`：這條路不經 postJSON，所以在這裡自己把結果記進路由退避——
// 2026-09-13 真機上對 youlin 打最多的正是這一條。
func extractWithWorkersAI(cypherURL, apiKey, absRoot, relPath string, origin SourceOrigin, retry bool) ([]string, error) {
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
	url := workersAIExtractURL(cypherURL)

	// 🔴 arcrun-rag#213（leo 2026-09-22 定向）：原稿超過單發上限 ⇒ **不再拒收**，
	// 改走一般化的「分段、本機存書籤、每天接著讀」機制（extract_resume.go）。
	// 這是**任何**大檔的共通路，不綁定文件形狀（不做「查表型偵測」之類的特判）。
	if len(srcText) > maxWorkersAIExtractBytes {
		return extractResumableWorkersAI(url, apiKey, absRoot, relPath, srcText, origin, retry)
	}

	output, legacyCard, err := callWorkersAIExtract(workersAIHTTP, url, apiKey, pageName, srcText, wikiExtractPrompt(pageName, srcText), retry)
	if err != nil {
		return nil, err
	}

	// #134 主線：新雲端回 `output`（模型對 wikiExtractPrompt 的原始回應）⇒
	// 與 gemma 路走**同一段**收尾：解析 JSON 判斷 → wikishape 機械組卡落 `.wiki/`。
	// 兩條萃取路的卡片形狀從此由同一份程式碼保證，不是由兩份 prompt 各自維持。
	if strings.TrimSpace(output) != "" {
		ex, perr := parseWikiExtractJSON(output)
		if perr != nil {
			return nil, perr
		}
		cards, berr := BuildWikiDoc(absRoot, relPath, srcText, ex, origin, time.Now())
		if berr != nil {
			return nil, berr
		}
		// 沒有可萃概念＝合法結果：不產卡，00-INDEX 列「空」（同 gemma 路）。
		return cards, nil
	}

	// legacy fallback：舊雲端（不認得 prompt）回 `card`（舊格式 markdown）。
	// 與 gemma 舊路同一套淨化與落卡（第一行必須是「# <頁名>」），#60 保護不動。
	card := cleanGemmaCard(legacyCard, pageName)
	if !strings.HasPrefix(card, "# ") {
		return nil, fmt.Errorf("萃出內容不像卡片（未以 # 開頭）：%.120s", card)
	}
	// arcrun-rag#60：路徑與檔名都由 cardRelFor 決定——非 vault 落 system-dev/wiki/cards/、
	// vault 落隱藏目錄，且**檔名一律帶 arcrun- 前綴**（第二輪：光換目錄擋不住撞名，
	// 因為 Logseq 的頁名是 basename）。落地前先查目標存不存在、不無條件覆蓋（safeWriteCard）。
	cardRel := cardRelFor(absRoot, pageName)
	// 🔴 inkstone/Arcrun#180（2026-08-28）：**不准把萃取結果寫回原稿自己身上。**
	// 舊制的落點是 `system-dev/wiki/cards/arcrun-<頁名>.md`，而 `MarkName` 是冪等的
	// ⇒ 原稿本來就住在那裡、名字本來就帶前綴時（leo 的 9 張現成卡正是這一種），
	// 算出來的目的地**就是原稿自己**。真寫下去＝原稿被自己的摘要蓋掉（safeWriteCard
	// 會留一份 `.bak-*`，但下一輪內容又變了 ⇒ 每輪重萃、每輪燒一次額度）。
	// 這條路只在**舊雲端**（回 `card` 而不是 `output`）才走得到，所以平常撞不到；
	// #180 讓 `system-dev/` 收得到之後就撞得到了。誠實報錯，不要靜默略過。
	if cardRel == filepath.ToSlash(relPath) {
		return nil, fmt.Errorf("這份檔案本身就在卡片產物區、而且已經帶著我們的標記（%s）"+
			"——整理它會蓋掉它自己。請把它移到別的資料夾，或更新你的知識庫到新版", relPath)
	}
	dest := filepath.Join(absRoot, filepath.FromSlash(cardRel))
	if err := safeWriteCard(absRoot, dest, []byte(card)); err != nil {
		return nil, err
	}
	return []string{cardRel}, nil
}

// callWorkersAIExtract 對雲端 /portal/daemon/extract 打一發，回傳
// （新雲端的）模型原文 output 與（舊雲端的）legacy card——兩者至多一個非空。
// #121：這條路不經 postJSON，所以在這裡自己把結果記進路由退避。
// 抽成獨立函式是為了讓「一發」與「大檔分段各打一發」（extract_resume.go）
// 共用完全同一段連線／記帳／解析邏輯，不會有第二份漂移的實作。
// client 可傳入不同逾時的 *http.Client（分段大檔的逾時要跟段落大小一起設定，見 chunkCallTimeout）。
func callWorkersAIExtract(client *http.Client, url, apiKey, pageName, text, prompt string, retry bool) (output, legacyCard string, err error) {
	reqBody, _ := json.Marshal(map[string]string{
		"page_name": pageName,
		"text":      text,
		"prompt":    prompt,
	})

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Arcrun-API-Key", apiKey)

	resp, err := client.Do(req)
	if err != nil {
		cloudRoutes.record(url, directNow(), 0, err, retry) // #121
		return "", "", fmt.Errorf("連不上你的知識庫：%w", err)
	}
	defer resp.Body.Close()
	cloudRoutes.record(url, directNow(), resp.StatusCode, nil, retry) // #121：5xx／429 記失敗，2xx 歸零
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))

	if resp.StatusCode == http.StatusNotFound {
		// 舊實例還沒有這條 route ⇒ 講人話，別讓用戶看到裸 404
		return "", "", fmt.Errorf("你的知識庫還是舊版（沒有雲端萃取功能）⇒ 請到 portal 按「立即更新」重裝一次")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Error != "" {
			return "", "", fmt.Errorf("雲端萃取失敗（HTTP %d）：%s", resp.StatusCode, e.Error)
		}
		return "", "", fmt.Errorf("雲端萃取失敗（HTTP %d）：%.200s", resp.StatusCode, string(body))
	}

	var parsed struct {
		Success bool   `json:"success"`
		Card    string `json:"card"`
		Output  string `json:"output"` // #134：新雲端在 prompt 模式回模型原文
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", "", fmt.Errorf("雲端回應解析失敗：%w", err)
	}
	if !parsed.Success || (strings.TrimSpace(parsed.Card) == "" && strings.TrimSpace(parsed.Output) == "") {
		if parsed.Error != "" {
			return "", "", fmt.Errorf("雲端萃取失敗：%s", parsed.Error)
		}
		return "", "", fmt.Errorf("雲端沒有回傳卡片內容")
	}
	return parsed.Output, parsed.Card, nil
}
