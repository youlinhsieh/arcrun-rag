// manifest.go — collector 本機 manifest 讀寫（SDD ingest-hash-trigger design §2）。
// manifest 只由 collector 寫入，雲端不得回寫（design §6-4）。
package collector

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ManifestEntry 是單一檔案在 manifest 裡的狀態。
//   - mtime 只決定「要不要重算 hash」（fast-path），絕不作為內容變更判準。
//   - ingested_hash 與 content_hash 分開存＝可表達「已變更但尚未成功 ingest」；
//     上傳失敗不更新 ingested_hash，天然可重試。本階段（不接網路）永不寫 ingested_hash，
//     留給之後的上傳/webhook task 在成功後回寫。
type ManifestEntry struct {
	ContentHash  string `json:"content_hash"`
	Size         int64  `json:"size"`
	Mtime        int64  `json:"mtime"`
	IngestedHash string `json:"ingested_hash,omitempty"`
	IngestedAt   int64  `json:"ingested_at,omitempty"`
	// ExtractedBy＝這張卡是誰萃的（"claude"／"gemma"／""＝無萃取器的直送路）。
	//
	// 為什麼要記（leo 2026-07-27 問「如果已經萃過了它知道嗎？」時發現的缺口）：
	// 原本 manifest 只記「萃過了」不記「誰萃的」。防重複本來就成立（hash 相同就跳過），
	// 但**換萃取器時無從分辨哪些卡是舊萃取器產的**——claude 萃的卡和 gemma 萃的卡
	// 品質不同卻混在同一個知識庫裡，想重萃也不知道該重萃哪些。
	//
	// 本欄位**不改變任何現有行為**（純記錄），但它是「換萃取器要不要重萃」這個決定的前提：
	// 沒有它，之後想分辨就永遠分辨不了（舊資料補不回來）。
	ExtractedBy string `json:"extracted_by,omitempty"`

	// ── 失敗退避（t195，2026-08-05）────────────────────────────────────────────
	// 病（leo 實撞）：`小果被AFTEE詐貸.pdf` 因雲端 401 失敗後，**manifest 完全不記失敗**
	// ⇒ 下一輪掃描又把它當「新檔」⇒ 無退避、無上限地重試。
	// 實測：**1387 輪、跨 11 小時**，每輪 3.2~3.8 秒全花在撞同一面牆上；
	// 而且它排在佇列前面 ⇒ **一個壞檔就把整個資料夾的同步拖住**。
	// leo：「不只推上去慢，原先萃檔案速度也快，現在也花了十幾分才萃完」——
	// **萃取根本沒變慢，慢的是重試**（log 的 `FOREACH 所有 5 項目均失敗` 證明卡早就萃好了）。
	//
	// 解：記下失敗次數與下次可重試時間，指數退避＋次數上限。
	// 這是**獨立於當次錯誤**的架構缺陷——401 修好了，下次換別的錯照樣卡死，所以要修這裡。
	FailCount  int   `json:"fail_count,omitempty"`   // 連續失敗次數（成功即歸零）
	LastFailAt int64 `json:"last_fail_at,omitempty"` // 最後一次失敗的 unix 秒
	NextRetry  int64 `json:"next_retry,omitempty"`   // 早於這個時間不重試（0＝可立即重試）
	// LastError＝最後一次失敗的**真正原因**（原文，不改寫）。
	//
	// 🔴 leo 2026-08-06 立的原則：「**別人的錯誤一律要顯示給用戶看，
	//    不然就會變成我的錯誤，導致客服**」。
	//    先前退避一開始，畫面就只剩「上次失敗（第 4 次），58m 後重試」，
	//    真因（Cloudflare「當日免費額度用完」／「這份 PDF 沒有文字層」）**當場消失**
	//    ⇒ 使用者以為是我們壞掉。原因必須跟著 entry 存活到下次成功為止。
	LastError string `json:"last_error,omitempty"`
}

// retryBackoff 退避階梯：1m → 5m → 15m → 1h → 6h，之後每次 6h。
var retryBackoff = []time.Duration{
	1 * time.Minute, 5 * time.Minute, 15 * time.Minute, 1 * time.Hour, 6 * time.Hour,
}

// MaxFailBeforeSkip 連續失敗達此次數 → 該檔暫停自動重試，不再拖住佇列。
// 使用者改檔（content hash 變）或按「立刻同步」時仍會重試（見 MarkFailed／ShouldRetry）。
const MaxFailBeforeSkip = 8

// Manifest 對應一個被勾選的資料夾。
type Manifest struct {
	FolderID string                    `json:"folder_id"`
	Root     string                    `json:"root"`
	Entries  map[string]*ManifestEntry `json:"entries"`
	// InventoryHash＝最後一次**成功送達雲端**的資料夾總覽卡內容雜湊（結構先行，
	// InkStoneCo#43，見 inventory.go）。與 entries 的跨輪 carry 陷阱無關——這是
	// Manifest 層欄位，Scan() 的 rebuild 只重建 Entries，不會碰它，天然跨輪存活。
	InventoryHash string `json:"inventory_hash,omitempty"`
	// InventoryFailHash／InventoryNextRetry＝總覽卡上一次送失敗的內容雜湊與下次可重試
	// 時間（unix）。存在理由＝t195 同款：積壓卡住時每輪都有事件，沒有這道退避，
	// 雲端一壞就是每 5 秒撞一次。內容變了（雜湊不同）視同新卡，立即可再試。
	InventoryFailHash  string `json:"inventory_fail_hash,omitempty"`
	InventoryNextRetry int64  `json:"inventory_next_retry,omitempty"`

	// PendingTakedowns＝改名／搬移後「舊路徑」在雲端知識庫裡還沒下架成功的待辦清單
	// （key=舊相對路徑，value=該路徑當時導出的頁名）。InkStoneCo#44 ⑩：
	//
	// direct 模式把 renamed 事件當 added 處理（用新路徑重送一次萃取），但從未告訴
	// 雲端「舊頁名／舊路徑那份已經死了」——純改檔名時舊頁名的舊卡永久留著；搬到
	// 別的資料夾時（basename 不變 ⇒ 新舊頁名相同）舊的不刪、新的照寫，kbdb 裡同一份
	// 文件變兩套，其中一套指向已不存在的路徑，而且沒有任何機制會回頭發現它。
	//
	// 為什麼要持久化而不是「失敗了下一輪自然重試」（removed 事件的作法）：removed
	// 事件靠「檔案仍然不在」讓 Scan() 每輪重新偵測、重新補發；但 renamed 的配對
	// （removed×added 以 content_hash 配對）只在偵測到的那一輪出現一次，舊路徑已經
	// 不在任何一邊的掃描結果裡，下一輪不會再有 renamed 事件把它帶出來。不記住它，
	// 一次下架失敗（雲端剛好那幾秒掛掉）就永久遺失，舊卡從此不會再被清。
	PendingTakedowns map[string]string `json:"pending_takedowns,omitempty"`
}

// QueueTakedown 記一筆「這個舊路徑（連同當時的頁名）還沒在雲端下架」的待辦。
// 冪等：同一路徑重複呼叫只覆蓋頁名（理論上不會變，但不假設呼叫端不會重複觸發）。
func (m *Manifest) QueueTakedown(oldPath, pageName string) {
	if m.PendingTakedowns == nil {
		m.PendingTakedowns = map[string]string{}
	}
	m.PendingTakedowns[oldPath] = pageName
}

// ClearTakedown 下架成功後從待辦清單移除。
func (m *Manifest) ClearTakedown(oldPath string) {
	delete(m.PendingTakedowns, oldPath)
}

// newUUID 產生 RFC 4122 v4 UUID（純 stdlib）。
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// LoadManifest 讀 manifest 檔；不存在＝新資料夾，生成 folder_id。
func LoadManifest(path, root string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			id, uerr := newUUID()
			if uerr != nil {
				return nil, uerr
			}
			return &Manifest{FolderID: id, Root: root, Entries: map[string]*ManifestEntry{}}, nil
		}
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("manifest %s 解析失敗（不覆寫、直接報錯）: %w", path, err)
	}
	if m.Entries == nil {
		m.Entries = map[string]*ManifestEntry{}
	}
	if m.FolderID == "" {
		id, uerr := newUUID()
		if uerr != nil {
			return nil, uerr
		}
		m.FolderID = id
	}
	if root != "" {
		m.Root = root
	}
	return &m, nil
}

// MarkIngested 是「整條 ingest 鏈成功」後的回寫鉤子（design §2）：把該路徑的
// ingested_hash 接上當時送出的 source_hash。**R2 上傳成功不呼叫它**——上傳只是鏈的
// 第一環，要等 task 4（named-webhook → ingest workflow）確認成功才回寫；在那之前
// 同檔每輪重發 added/modified＝設計內重試，R2 端靠 HEAD no-op 天然冪等、零浪費。
// 回傳 false＝路徑已不在 manifest（例如回報前檔案又被改名/刪除），呼叫端自行決定忽略或告警。
func (m *Manifest) MarkIngested(path, sourceHash string, at int64) bool {
	return m.MarkIngestedBy(path, sourceHash, at, "")
}

// MarkIngestedBy 同 MarkIngested，另記「這輪是誰萃的」（extractor＝"claude"／"gemma"／""）。
//
// 為什麼另開一支而不是改 MarkIngested 的簽名：MarkIngested 有多個呼叫點
// （direct 兩處＋trigger.go 的 MarkIngestedEvents＋測試），改簽名會擴散破壞。
// 走無萃取器路徑（sync／直送）的呼叫端不必知道這個欄位，維持原簽名最小侵入。
func (m *Manifest) MarkIngestedBy(path, sourceHash string, at int64, extractor string) bool {
	e, ok := m.Entries[path]
	if !ok {
		return false
	}
	e.IngestedHash = sourceHash
	e.IngestedAt = at
	e.ExtractedBy = extractor
	// 成功即清掉失敗狀態（t195）：下次再壞會從第一階退避重新算起。
	e.FailCount, e.LastFailAt, e.NextRetry = 0, 0, 0
	e.LastError = ""
	return true
}

// MarkFailed 記錄一次失敗並排定下次可重試時間（t195 指數退避）。
//
// 為什麼要記在 manifest 而不是記憶體：collector 每輪是獨立 process
// （`direct --once` 由看守器反覆拉起），記憶體狀態一輪就沒了——
// 這正是原本「1387 輪重試同一個檔」的原因：每輪都以為自己是第一次。
func (m *Manifest) MarkFailed(path string, at int64, reason string) bool {
	e, ok := m.Entries[path]
	if !ok {
		return false
	}
	e.FailCount++
	e.LastFailAt = at
	if strings.TrimSpace(reason) != "" {
		e.LastError = reason // 存真因；退避訊息由呼叫端另外組，不覆蓋這裡
	}
	idx := e.FailCount - 1
	if idx >= len(retryBackoff) {
		idx = len(retryBackoff) - 1
	}
	e.NextRetry = at + int64(retryBackoff[idx].Seconds())
	return true
}

// ShouldRetry 回報「這個檔現在該不該送」。
//
//   - 從沒失敗過 → true（行為與 t195 前一字不變）
//   - 還在退避窗口內 → false（**這是止血點：壞檔不再每 4 秒撞一次牆拖住整個佇列**）
//   - 連續失敗 ≥ MaxFailBeforeSkip → false（暫停自動重試）
//
// force＝使用者按「立刻同步」：忽略退避與上限一律重送
// （人明確要求時不該被機器的退避擋住）。
// 另：使用者改檔會讓 content hash 變 → 走的是「內容變更」路徑，本函式不介入。
func (m *Manifest) ShouldRetry(path string, now int64, force bool) bool {
	e, ok := m.Entries[path]
	if !ok || e.FailCount == 0 {
		return true
	}
	if force {
		return true
	}
	if e.FailCount >= MaxFailBeforeSkip {
		return false
	}
	return now >= e.NextRetry
}

// Save 原子寫入（temp + rename），避免掃描中斷留半個 JSON。
func (m *Manifest) Save(path string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".manifest-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
