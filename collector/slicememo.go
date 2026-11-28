// slicememo.go — inkstone/arcrun-rag#399：大卡分段送，斷在中途時不要整張從頭重寫。
//
// 病（leo21c 2026-11-28 實撞：NRI 報告 10 段、同一份已失敗 29 次）：
// 送法是「最後一段先送、第一段（含 block＝整份的提交標記）最後送」（cardslice.go 檔頭）。
// 於是**提交標記沒蓋之前**，雲端認不得任何一段是「已經寫好的」——
// 雲端 pick_stale 對後面的段要看 block 上的指紋，而 block 要等第一段才寫。
// 結果每一輪重送，前面成功的段都被判成「有變」，先刪光自己名下 50 條、再重寫 50 條。
// 一輪要連續過完 10 段才算數；知識庫資料庫忙的時候（503 d1_overloaded），
// 每一段各有失敗的機會，連續十段都過的機率很低；而每一輪失敗前還白刪白寫了好幾段，
// 本身就在加重資料庫的忙碌（刪＋寫＝一段約 100 列寫入）。
//
// 解：本機記下「這一段（這份卡內容的這個範圍）已經確定送達」。下一輪同一份內容、同一個雲端版本、
// 不超過 sliceMemoTTL，就直接略過那一段，只補沒送達的。
//   - 第一段（offset 0）**永遠送**——它是提交標記，而且它才負責 block；
//   - 卡片內容、頁名、庫、機器任何一格變了，鍵就變，不會誤略過；
//   - 雲端版本變了（可能重裝、清空過）、按「立刻同步」（ForceSync）、過了 TTL，一律全部重送；
//   - 整份送完蓋章（MarkIngestedBy）就清掉。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// sliceMemoTTL＝記帳有效多久（秒）。雲端若在這段時間內被清空／重裝，雲端版本多半會變而失效；
// TTL 要比失敗退避的最長一階（6 小時）長，否則退避等完記帳剛好過期；它是最後一道保險：寧可多重送一輪，不要永遠相信一筆過期的記帳。
const sliceMemoTTL int64 = 24 * 3600

// sliceMemoDisabled＝只給測試：關掉分段記帳，重現 #399 之前的行為（證明病在這裡）。
var sliceMemoDisabled bool

// SentSlices＝一個檔「已送達的段」。Done 的鍵見 sliceMemoKey。
type SentSlices struct {
	CloudVersion string          `json:"cloud_version,omitempty"`
	At           int64           `json:"at"` // 最後一次記下的 unix 秒（TTL 從這裡起算）
	Done         map[string]bool `json:"done"`
}

// sliceMemoKey＝一段的身分：整個請求本文（卡片全文、頁名、路徑、庫、機器）的雜湊＋這一段的範圍。
// 本文任何一格變了就是另一段。
func sliceMemoKey(cardBody map[string]any, sl cardSlice) string {
	raw, _ := json.Marshal(cardBody) // map 的鍵序固定，同內容同結果
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%s|%s|%d|%d", hex.EncodeToString(sum[:8]), sl.Scope, sl.Offset, sl.Limit)
}

func (s *SentSlices) valid(cloudVersion string, now int64) bool {
	return s != nil && s.CloudVersion == cloudVersion && now >= s.At && now-s.At <= sliceMemoTTL
}

// SliceSent＝這一段是不是已經確定送達（可略過）。第一段（offset 0）永遠回 false。
func (m *Manifest) SliceSent(path, key string, offset int, now int64) bool {
	if offset <= 0 {
		return false
	}
	e := m.Entries[path]
	if e == nil || !e.SentSlices.valid(m.CloudVersion, now) {
		return false
	}
	return e.SentSlices.Done[key]
}

// MarkSliceSent 記下一段已送達。雲端版本或 TTL 對不上時先丟掉舊記帳再記。
func (m *Manifest) MarkSliceSent(path, key string, now int64) {
	e := m.Entries[path]
	if e == nil {
		return
	}
	if !e.SentSlices.valid(m.CloudVersion, now) {
		e.SentSlices = &SentSlices{CloudVersion: m.CloudVersion, Done: map[string]bool{}}
	}
	e.SentSlices.Done[key] = true
	e.SentSlices.At = now
}

// ClearSentSlices 丟掉一個檔的分段記帳（按「立刻同步」時用：人明確要求重來）。
func (m *Manifest) ClearSentSlices(path string) {
	if e := m.Entries[path]; e != nil {
		e.SentSlices = nil
	}
}
