// extract_resume.go — arcrun-rag#213：大檔不再拒收，改「分次讀、本機存書籤、
// 每天接著讀之前讀到的地方」的一般化機制（任何檔案都走這條路，不分文件形狀）。
//
// 🔴 leo 2026-09-22 原話（本檔存在的唯一理由，取代了 c10624「查表型偵測」那版設計）：
//
//	「我覺得簡單的方法是先把 pdf 原檔內容抽出暫存，如果一天來不及完成，
//	 存成自己能慢慢處理的格式，但存在本機，就像讀書，一天讀不完可以多讀幾天，
//	 就像續傳的功能。你需要做一個一般性的方法，而不是針對這個檔案」
//
// 形狀：
//  1. 原稿轉成純文字後（ConvertToText，原文不出機）按行界切成固定大小的段
//     （extract_chunk.go 的 chunkForWorkersAI）——**不判斷文件是不是查表型、
//     不偵測「錯誤碼家族」**，任何超過單發上限的檔都走同一條路。
//  2. 書籤（extractProgress）記「切成幾段、已經整理好幾段、目前累積的萃取結果」，
//     存在本機 `.wiki/.extract-progress/`（不進雲端、不進版控，同 `.wiki/.gitignore`）。
//  3. 每次呼叫從書籤記的地方接著讀：一段一段呼叫雲端整理，整理完一段就記一次書籤
//     （crash-safe），直到把這一輪能讀的都讀完（額度用完，或這輪讀夠了）。
//  4. 不管有沒有讀完，**已經完成的段落立刻組卡**（BuildWikiDoc 用累積到現在的
//     Concepts），讓使用者當天就查得到已經整理好的部分——不是全部讀完才產卡。
//  5. 還沒讀完時回傳 *extractInProgress（見下）而不是一般 error：direct.go
//     用它判斷「這輪的卡照樣要上雲，但這個檔還沒完全算數，別記失敗、別蓋『已送達』
//     的章」——manifest 的 IngestedHash 因此維持空白，Scan() 下一輪會自然對這個檔
//     再補一次事件（manifest.go 檔頭「IngestedHash == "" 自然補一發 added 事件」），
//     不需要另外設計排程器。額度用完是最常見的「讀不完」，那件事本來就有
//     isQuotaExhausted 的帳號層級冷卻頂著，所以這裡不必自己再做節流。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// extractChunkTargetBytes＝續讀機制每段的目標大小。
//
// 🔴 這個數字是**真的用客戶原檔對雲端 Workers AI 實測出來的**（`inkstone/arcrun-rag#213`
// c10637 總管要求：「切段大小由 AI 一次寫得出來的量決定，不只是讀得進去的量，拿真檔
// 量過、調到全數覆蓋」），不是猜的：
//
//	60,000 bytes（≈168 個可辨識條目）  → 覆蓋率  6%（模型直接放棄逐條列舉，改摘要）
//	20,000 bytes（≈ 50 個條目）        → 覆蓋率  6%（同上，臨界點附近會整段垮掉）
//	12,000 bytes（≈ 30 個條目）        → 覆蓋率 97%（幾乎完整，但已經在邊界上）
//	 8,000 bytes（≈ 15 個條目）        → 覆蓋率 100%（客戶原檔前段／後段兩次實測皆是）
//
// ⇒ 這不是「輸出 token 被裝滿」（`completion_tokens` 全程遠低於 `max_tokens=8192`）
// ——是**模型本身的行為在「條目數」這個維度上是雙峰的**：條目少就老實逐條列，
// 條目一多就切換成「開場撒 2-3 個代表性例子＋整段摘要」，而且切換點附近不穩定
// （20,000／60,000 都測到 6%，中間沒有漸進，是斷崖）。8,000 bytes 是量出來、
// 安全落在斷崖前的一邊；再加上 extract_prompt.go 的 candidateRecordLabels（機械掃出
// 候選識別碼塞進 prompt，把「注意到＋窮舉」改成「照清單逐條描述」）才是覆蓋率從
// 0% 打到 100% 真正的關鍵——光縮小這個常數不夠，兩者要一起生效。
//
// 段愈小還有第二個好處：「今天讀到第幾段」的進度愈細，使用者看得到東西在動，
// 不是等一整天才跳一次。
const extractChunkTargetBytes = 8_000

// chunkCallTimeout 續讀機制單段呼叫的逾時：基本 90 秒（跟現有 workersAIHTTP 同量級），
// 再依段落大小加一點餘裕，上限 4 分鐘。c10624 實測 92.3 秒撞上舊的 90 秒逾時（定義 3）
// 就是本函式要修的洞——固定 90 秒對「這段有多少東西要讀」沒有反應。
func chunkCallTimeout(chunkBytes int) time.Duration {
	extra := time.Duration(chunkBytes/1024) * time.Second // 每 KB 加 1 秒
	total := 90*time.Second + extra
	const capAt = 4 * time.Minute
	if total > capAt {
		return capAt
	}
	return total
}

// extractInProgress＝這一輪沒有把整份大檔讀完（額度用完／這輪的段數上限到了），
// 但確實有進度（至少完成了一段，含之前累積的）。
//
// 🔴 它實作 error 介面是為了走 extractWithWorkersAI 現有的 `(cards, error)` 回傳型，
// 但**不代表失敗**——呼叫端（direct.go）要用 asExtractInProgress 認出它，
// 對這個檔案改走「這輪的卡照樣送、但別記已完成、別記失敗」的第三條路。
type extractInProgress struct {
	Cards       []string // 這輪要送上雲的卡（含這一輪之前已完成、這輪新完成的）
	Done        int      // 已完成幾段
	Total       int      // 全部幾段
	Percent     int      // Done/Total 的百分比（畫面用，見 ManifestEntry.ExtractPercent）
	QuotaHit    bool     // 這輪停下來是不是因為撞到每日額度（讓呼叫端照舊觸發帳號冷卻／使用者訊息）
	RawQuotaErr string   // QuotaHit 時，上游原始錯誤文字（給 quotaState.markHit 用，同既有慣例）
	note        string
}

func (e *extractInProgress) Error() string {
	if e.note != "" {
		return e.note
	}
	return fmt.Sprintf("這份檔比較大，已經整理了 %d/%d 段，剩下的之後接著讀", e.Done, e.Total)
}

// asExtractInProgress 從一個 error 認出 *extractInProgress（可能被 fmt.Errorf %w 包過）。
func asExtractInProgress(err error) (*extractInProgress, bool) {
	type unwrapper interface{ Unwrap() error }
	for err != nil {
		if p, ok := err.(*extractInProgress); ok {
			return p, true
		}
		u, ok := err.(unwrapper)
		if !ok {
			return nil, false
		}
		err = u.Unwrap()
	}
	return nil, false
}

// extractProgress＝本機書籤：這份原稿讀到第幾段、目前累積的萃取結果。
// 原文段落**只存在這裡**（本機、不進雲端、不進版控）——雲端收到的永遠是
// BuildWikiDoc 組出來的卡（AI 整理過的判斷），不是原文切片。
type extractProgress struct {
	// SourceHash＝這份原稿（ConvertToText 之後的純文字）的 sha256。
	// 內容變了（使用者改了檔）⇒ 這個值對不上 ⇒ 書籤作廢、從頭切段，
	// 不會拿舊內容的殘餘進度硬接新內容。
	SourceHash string `json:"source_hash"`
	// ChunkBounds＝段落邊界（byte offset，len = 段數+1）。從 srcText 用同一個
	// chunkForWorkersAI(extractChunkTargetBytes) 算出來，存下來是為了**不必每次
	// 重切**（重切理論上會得到相同結果，但存下來更直接，也避免萬一切法之後改版
	// 導致同一輪內段界跳動）。
	ChunkBounds []int `json:"chunk_bounds"`
	// Done＝已經完成整理（且已併進 Merged）的段數，下一段從這裡開始。
	Done int `json:"done"`
	// Merged＝累積到目前為止的萃取結果（跨段合併，見 extract_chunk.go mergeDocExtract）。
	Merged    DocExtract `json:"merged"`
	UpdatedAt string     `json:"updated_at"`
}

func (p *extractProgress) total() int {
	if len(p.ChunkBounds) == 0 {
		return 0
	}
	return len(p.ChunkBounds) - 1
}

// extractProgressDir／extractProgressPath：書籤檔放哪裡。
// 跟 wiki 卡同一個節點目錄底下的隱藏子目錄——`.wiki/.gitignore` 的 `*` 已經蓋住它，
// 不需要另外處理版控排除；下架（RemoveWikiDoc 呼叫端）要記得一併清掉，見本檔
// clearExtractProgress。
func extractProgressDir(absRoot, node string) string {
	return filepath.Join(wikiDirFor(absRoot, node), ".extract-progress")
}

func extractProgressPath(absRoot, node, nodeKey, base string) string {
	return filepath.Join(extractProgressDir(absRoot, node), docIDOf(nodeKey, base)+".json")
}

func loadExtractProgress(absRoot, node, nodeKey, base string) *extractProgress {
	data, err := os.ReadFile(extractProgressPath(absRoot, node, nodeKey, base))
	if err != nil {
		return nil
	}
	var p extractProgress
	if err := json.Unmarshal(data, &p); err != nil {
		return nil // 讀壞的書籤等同沒有——從頭切段，不讓一份壞檔卡死這份原稿
	}
	return &p
}

func saveExtractProgress(absRoot, node, nodeKey, base string, p *extractProgress) error {
	p.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	dir := extractProgressDir(absRoot, node)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ensureWikiIgnored(filepath.Dir(dir)) // 上一層是 .wiki/，那份 .gitignore 已經蓋住這個子目錄
	return os.WriteFile(extractProgressPath(absRoot, node, nodeKey, base), data, 0o644)
}

// clearExtractProgress 讀完（或原稿被刪除、下架）之後清書籤，避免留孤兒檔。
// 找不到／刪不掉都不算錯（本來就可能沒有書籤）。
func clearExtractProgress(absRoot, node, nodeKey, base string) {
	_ = os.Remove(extractProgressPath(absRoot, node, nodeKey, base))
}

// extractResumableWorkersAI＝續讀機制主體。url／apiKey／absRoot／relPath／origin／retry
// 與 extractWithWorkersAI 一致；srcText 是已經轉好的純文字（呼叫端已經做過 ConvertToText，
// 這裡不重讀原始檔，維持「LLM 只碰得到文字」的既有邊界）。
func extractResumableWorkersAI(url, apiKey, absRoot, relPath, srcText string, origin SourceOrigin, retry bool) ([]string, error) {
	pageName := pageNameOf(relPath)
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)

	sum := sha256.Sum256([]byte(srcText))
	srcHash := hex.EncodeToString(sum[:])

	progress := loadExtractProgress(absRoot, node, nodeKey, base)
	if progress == nil || progress.SourceHash != srcHash {
		// 新檔，或內容變了（使用者改過）⇒ 書籤作廢，從頭切段重讀。
		chunks := chunkForWorkersAI(srcText, extractChunkTargetBytes)
		bounds := make([]int, 0, len(chunks)+1)
		offset := 0
		bounds = append(bounds, 0)
		for _, c := range chunks {
			offset += len(c)
			bounds = append(bounds, offset)
		}
		progress = &extractProgress{SourceHash: srcHash, ChunkBounds: bounds, Done: 0, Merged: DocExtract{}}
	}
	total := progress.total()
	if total <= 0 {
		return nil, fmt.Errorf("這份檔切不出任何段落（內容可能是空的）")
	}

	// 🔴 單一次呼叫最多處理幾段的安全上限：避免一份超巨大檔案在額度沒用完之前
	// 就把單一次直送事件的時間拖到失控（c10624 的教訓：段落數要跟每次投入的
	// 時間一起設定，不能只看有沒有額度）。額度用完（isQuotaExhausted）通常會先
	// 停下這個迴圈，這個上限只是那道閘之外的第二道保險。
	const maxChunksPerInvocation = 40

	quotaHit := false
	var quotaErr error
	processedThisCall := 0
	for progress.Done < total && processedThisCall < maxChunksPerInvocation {
		chunk := srcText[progress.ChunkBounds[progress.Done]:progress.ChunkBounds[progress.Done+1]]
		client := &http.Client{Timeout: chunkCallTimeout(len(chunk))}
		output, legacyCard, callErr := callWorkersAIExtract(client, url, apiKey, pageName, chunk, wikiExtractPrompt(pageName, chunk), retry)
		if callErr != nil {
			if strings.TrimSpace(legacyCard) != "" {
				// 舊雲端不認得 prompt、只會回 legacy markdown——沒辦法把段落併回結構化的卡。
				return nil, fmt.Errorf("這份檔比較大、需要分次整理，但你的知識庫還是舊版" +
					"（還不會分次整理）⇒ 請到 portal 按「立即更新」重裝一次")
			}
			if isQuotaExhausted(callErr.Error()) {
				quotaHit = true
				quotaErr = callErr
				break // 額度用完：停在這裡，已完成的段落照樣算數，下一輪接著讀
			}
			if progress.Done > 0 {
				// 已經有部分進度：這一段暫時失敗（多半是暫時性網路/上游錯誤），
				// 不要把之前的進度也賠進去——停在這裡，下一輪從同一段重試。
				break
			}
			// 連第一段都還沒成功過：跟原本「一次讀不完就整份失敗」的行為一致，
			// 讓既有的失敗/退避處理接手（也不會有任何卡可以送，沒有部分進度可保）。
			return nil, fmt.Errorf("整理第 %d／%d 段時：%w", progress.Done+1, total, callErr)
		}
		if strings.TrimSpace(output) == "" {
			// 這一段沒有可萃內容，合法：直接算完成、繼續下一段。
			progress.Done++
			processedThisCall++
			if err := saveExtractProgress(absRoot, node, nodeKey, base, progress); err != nil {
				return nil, fmt.Errorf("書籤存檔失敗：%w", err)
			}
			continue
		}
		ex, perr := parseWikiExtractJSON(output)
		if perr != nil {
			if progress.Done > 0 {
				break // 保住已有進度，這段下一輪重試
			}
			return nil, fmt.Errorf("整理第 %d／%d 段時：%w", progress.Done+1, total, perr)
		}
		mergeDocExtract(&progress.Merged, ex)
		progress.Done++
		processedThisCall++
		// 每完成一段就存一次書籤：daemon 中途被關掉／斷網也不會把這段的進度弄丟。
		if err := saveExtractProgress(absRoot, node, nodeKey, base, progress); err != nil {
			return nil, fmt.Errorf("書籤存檔失敗：%w", err)
		}
	}

	complete := progress.Done >= total
	if progress.Done == 0 {
		// 這輪一段都沒有成功過（多半是一開始就撞額度）——沒有東西可以組卡，
		// 照原本的「額度用完」錯誤路徑走，讓既有的帳號冷卻/使用者訊息機制接手。
		if quotaHit {
			return nil, quotaErr
		}
		return nil, fmt.Errorf("這份檔還沒有任何段落整理成功")
	}

	merged := progress.Merged
	if len(merged.Concepts) == 0 {
		merged.NoConcept = true
		if strings.TrimSpace(merged.Reason) == "" {
			merged.Reason = "目前讀到的部分沒有可以整理成概念卡的內容"
		}
	}
	// 一檔一份文件卡（hub）＋累積到現在的概念卡——「一檔一張文件卡、page_name 跟原稿走」
	// 的既有設計不變；概念卡數量隨著讀的進度增加，之前完成的段落卡內容不會因為
	// 這一輪而改變（mergeConcept 對同名概念取聯集，不同名概念純累加）。
	cards, berr := BuildWikiDoc(absRoot, relPath, srcText, &merged, origin, time.Now())
	if berr != nil {
		return nil, berr
	}

	if complete {
		// 🔴 完成後**不刪書籤**（跟舊版行為不同，是刻意的）：這個檔已經在
		// `progress.SourceHash` 這個版本上跑過續讀機制、產出了「文件卡＋N 張分次
		// 完成的概念卡」，direct.go 的送卡迴圈要知道「這份文件的概念卡也該上雲，
		// 不是只送 hub」——docWentThroughResumable 就是讀這份書籤來判斷。
		// 書籤在此刻等於「Done==Total」的完賽紀錄，內容不會再被讀取/續跑，
		// 只在原稿內容真的變了（SourceHash 對不上）或原稿被刪除／下架時才清掉
		// （後者見 ClearExtractProgress，由 direct.go 的下架路徑呼叫）。
		return cards, nil // 全部讀完＝跟一般單發萃取一樣，直接算成功
	}

	percent := progress.Done * 100 / total
	note := fmt.Sprintf("這份檔比較大，已經整理了 %d/%d 段（%d%%），明天/額度恢復後接著讀",
		progress.Done, total, percent)
	if quotaHit {
		note = fmt.Sprintf("這份檔比較大，今天的額度整理到第 %d/%d 段（%d%%），額度明天恢復後接著讀",
			progress.Done, total, percent)
	}
	rawQuotaErr := ""
	if quotaHit && quotaErr != nil {
		rawQuotaErr = quotaErr.Error()
	}
	return cards, &extractInProgress{
		Cards: cards, Done: progress.Done, Total: total, Percent: percent,
		QuotaHit: quotaHit, RawQuotaErr: rawQuotaErr, note: note,
	}
}

// ExtractProgressPercent 回傳一份原稿目前的續讀進度（0-100）。
// hasProgress＝false 代表**這份檔沒有分段書籤**——可能是還沒開始，也可能是
// 已經一次讀完（畫面該顯示 100% 或 0% 由呼叫端自己看 manifest 的 ingested 狀態決定，
// 本函式只管「有沒有分段正在進行中」這一半，不猜整體狀態）。
func ExtractProgressPercent(absRoot, relPath string) (percent int, hasProgress bool) {
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	p := loadExtractProgress(absRoot, node, nodeKey, base)
	if p == nil || p.total() == 0 {
		return 0, false
	}
	return p.Done * 100 / p.total(), true
}

// docWentThroughResumable 回報：這份原稿現在這一版（依 manifest／wiki 卡目前的內容）
// 是不是走過續讀機制切段整理的。direct.go 用它決定「這份文件的概念卡要不要跟著
// hub 一起上雲」——**只有走過續讀的大檔**才把 cardIdx>0 的卡也送出去；一般小文件
// 維持既有行為（只送 hub，概念卡先只落本機，見 `inkstone/Arcrun#129/#130`「第⑤環」，
// 本票不動那個全域決定，只在這條新路徑上開一個窄門）。
func docWentThroughResumable(absRoot, relPath string) bool {
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	p := loadExtractProgress(absRoot, node, nodeKey, base)
	return p != nil && p.total() > 0
}

// ClearExtractProgress 是 clearExtractProgress 的匯出版，供 direct.go 在原稿被刪除／
// 下架時呼叫（同一輪也要把「這份走過續讀」的書籤一起收掉，不留孤兒狀態）。
func ClearExtractProgress(absRoot, relPath string) {
	node, base := docNodeAndPath(absRoot, relPath)
	nodeKey := nodeKeyOf(node)
	clearExtractProgress(absRoot, node, nodeKey, base)
}
