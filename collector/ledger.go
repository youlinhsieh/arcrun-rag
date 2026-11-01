// ledger.go — 送件對帳摘要（inkstone/arcrun-collector#1 補充設計；雲端那半＝inkstone/Arcrun#330）。
//
// leo 2026-10-31：「我有一張單子說今天要送 5 件，掉了一件就去問為什麼少一件，這個機制沒有嗎？」
// 帳本（manifest）本來就逐檔記了送了沒、失敗幾次、為什麼；缺的是**雲端看不到**。
// 這裡把本機帳本壓成一份小摘要，搭資料夾樹那支回報（folder-tree）一起送上去。
//
// 🔴 欄位形狀是兩邊共用的協定（Arcrun#330 本文），欄名不另取：
//
//	ledger_summary: { round_at, total, confirmed, retrying, stalled,
//	                  reasons: [{ kind, count, sample }] }
//
// 口徑與 Progress() 一致（不另算第二套）：
//   - total＝應送件數：不含「同名不同格式的副本」（FormatDupOf）與「掃描檔、讀不出字」（不支援，不是漏送）。
//   - confirmed＝已送且內容沒再變（IngestedHash == ContentHash）。雲端「還在不在」由 cloud_audit.go 另外對帳，
//     對帳發現不在會拔章 ⇒ 掉出 confirmed，下一輪的摘要就看得到。
//   - stalled＝連續失敗滿 MaxFailBeforeSkip、已停止自動重試。
//   - retrying＝其餘還沒送達的（排隊中＋退避重試中）。total ＝ confirmed + retrying + stalled，恆成立。
//   - reasons＝**沒送達的檔**按原因分類；還在排隊、沒有任何失敗紀錄的檔不進 reasons（它們沒有「為什麼」，只是還沒輪到）。
//
// 紅線：只帶份數與一個檔名（basename），不碰文件內容、不帶完整路徑。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 原因分類（kind）——名稱是協定，與 Arcrun#330 一致。
const (
	LedgerKindLoginRequired = "network_login_required"
	LedgerKindNetwork       = "network"
	LedgerKindQuota         = "quota"
	LedgerKindUnreadable    = "unreadable"
	LedgerKindOther         = "other"
)

// ledgerRepeatInterval＝還有沒送達的檔、而且摘要沒變時，多久也要再報一次。
// 雲端要判斷「差的件數連續兩輪沒減少」，前提是它**收得到第二輪的回報**；
// 摘要沒變就不送（省雲端寫入）的話，卡住的那種情況恰好永遠不會有第二筆。
// 差 0 件時不重送（沒有東西要提醒）。
const ledgerRepeatInterval = 30 * time.Minute

type LedgerReason struct {
	Kind   string `json:"kind"`
	Count  int    `json:"count"`
	Sample string `json:"sample"`
}

type LedgerSummary struct {
	RoundAt   string         `json:"round_at"`
	Total     int            `json:"total"`
	Confirmed int            `json:"confirmed"`
	Retrying  int            `json:"retrying"`
	Stalled   int            `json:"stalled"`
	Reasons   []LedgerReason `json:"reasons"`
}

// Gap＝差幾件（還沒送達的）。
func (l *LedgerSummary) Gap() int {
	if l == nil {
		return 0
	}
	return l.Retrying + l.Stalled
}

// Sig＝內容簽章（不含 round_at）：摘要「實質上」有沒有變。
func (l *LedgerSummary) Sig() string {
	if l == nil {
		return ""
	}
	c := *l
	c.RoundAt = ""
	data, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

// ledgerReasonKind 把一則 LastError 歸到協定裡的 kind。
// 順序有意義：登入頁的句子同時被 isLocalNetworkText 認得，必須先判。
func ledgerReasonKind(lastErr string) string {
	switch {
	case strings.Contains(lastErr, "這個網路需要先登入"):
		return LedgerKindLoginRequired
	case isLocalNetworkText(lastErr):
		return LedgerKindNetwork
	case isQuotaExhausted(lastErr) || isD1QuotaText(lastErr):
		return LedgerKindQuota
	case isNoTextText(lastErr), strings.Contains(lastErr, "萃取 JSON 解析失敗"),
		strings.Contains(lastErr, "解析失敗"), strings.Contains(lastErr, "讀不出"),
		strings.Contains(lastErr, "無法讀取"), strings.Contains(lastErr, "格式不支援"):
		return LedgerKindUnreadable
	}
	if k, _ := StallReason(lastErr); k == "network" {
		return LedgerKindNetwork
	}
	return LedgerKindOther
}

// BuildLedgerSummary 由帳本條目算出摘要（純函式，不改 entries）。
func BuildLedgerSummary(entries map[string]*ManifestEntry, now time.Time) *LedgerSummary {
	l := &LedgerSummary{RoundAt: now.UTC().Format(time.RFC3339), Reasons: []LedgerReason{}}
	type acc struct {
		count  int
		sample string
	}
	by := map[string]*acc{}
	for p, e := range entries {
		if e == nil || e.FormatDupOf != "" {
			continue
		}
		confirmed := e.IngestedHash != "" && e.IngestedHash == e.ContentHash
		if !confirmed && isNoTextText(e.LastError) {
			continue // 不支援（掃描檔），不算漏送，與 Progress() 同口徑
		}
		l.Total++
		if confirmed {
			l.Confirmed++
			continue
		}
		stalled := e.FailCount >= MaxFailBeforeSkip && !isLegacyTooBigText(e.LastError) && !isCardCollisionText(e.LastError)
		if stalled {
			l.Stalled++
		} else {
			l.Retrying++
		}
		if strings.TrimSpace(e.LastError) == "" {
			continue // 還在排隊、沒有失敗紀錄：沒有「為什麼」
		}
		k := ledgerReasonKind(e.LastError)
		a := by[k]
		if a == nil {
			a = &acc{}
			by[k] = a
		}
		a.count++
		if b := filepath.Base(p); a.sample == "" || b < a.sample { // 取字典序最小：同一份帳本算出同一個樣本
			a.sample = b
		}
	}
	for k, a := range by {
		l.Reasons = append(l.Reasons, LedgerReason{Kind: k, Count: a.count, Sample: a.sample})
	}
	sort.Slice(l.Reasons, func(i, j int) bool {
		if l.Reasons[i].Count != l.Reasons[j].Count {
			return l.Reasons[i].Count > l.Reasons[j].Count
		}
		return l.Reasons[i].Kind < l.Reasons[j].Kind
	})
	return l
}

// StampLedger 蓋上對帳摘要，回一份新的樹（不改原件）。Ledger 不進 JSON（本機快照與雜湊都不含它）。
func (t FolderTree) StampLedger(entries map[string]*ManifestEntry, now time.Time) FolderTree {
	t.Ledger = BuildLedgerSummary(entries, now)
	return t
}
