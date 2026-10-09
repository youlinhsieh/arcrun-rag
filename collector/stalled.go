// stalled.go — 檔案因同一個原因停工時，要讓用戶一鍵回報給我們（inkstone/arcrun-rag#240 c18242）。
//
// leo 2026-10-09 原話：「如果都是相同原因，就要通知擁有者讓他回報有什麼問題，我們才能修復，
// 那在小幫手應該跳出把這個問題回報的按鈕，用戶按了我們就收到票，不然只會在用戶那裡默默死掉，
// 讓我們的信賴下跌」。geek 的 error_codes 有 126 份就是這樣停著，沒人知道。
//
// 本檔只做「判斷與分組」，不送任何東西：
//   - 什麼叫停工：連續失敗滿 MaxFailBeforeSkip 次、而且不是「會自己好的那幾類」
//     （暫時性雲端錯誤／額度／舊規則誤判，這些有自動續試；續試又多撞 4 次仍不過才算停工）。
//   - 分組鍵：知識庫 host＋原因分類。同一個原因（不管幾份、哪個資料夾）只算一組。
//   - 紅線：只回檔名（basename）與錯誤原文，**不碰文件內容**。
package collector

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// StallMinFiles＝同一個原因至少幾份才跳卡片。1～2 份多半是那幾個檔自己的事，
// 3 份起才是「同一個原因」的樣子，也避免單檔雜訊洗版。
const StallMinFiles = 3

// stallExtraTries＝自動會好的那幾類，在暫停門檻之後又多撞幾次仍不過，就當作停工。
const stallExtraTries = 4

// StalledGroup＝一個知識庫裡、因同一個原因停工的一批檔。
type StalledGroup struct {
	Host        string   `json:"host"`
	Key         string   `json:"key"`   // 原因分類鍵（穩定，做「已回報」的鍵）
	Label       string   `json:"label"` // 給人看的一句原因
	Count       int      `json:"count"`
	Samples     []string `json:"samples"`   // 檔名（basename），最多 5 個
	RawError    string   `json:"raw_error"` // 其中一份的錯誤原文
	MinFails    int      `json:"min_fails"`
	MaxFails    int      `json:"max_fails"`
	Roots       []string `json:"-"` // 受影響的資料夾（只在本機用，不送出）
	Fingerprint string   `json:"fingerprint"`
}

var digitsRe = regexp.MustCompile(`[0-9]+`)
var hCodeRe = regexp.MustCompile(`H[0-9]`)

// StallReason 把一則 LastError 歸成（分類鍵，白話原因）。
func StallReason(raw string) (key, label string) {
	switch {
	case strings.Contains(raw, "品質未過"):
		codes := map[string]bool{}
		for _, c := range hCodeRe.FindAllString(raw, -1) {
			codes[c] = true
		}
		var cs []string
		for c := range codes {
			cs = append(cs, c)
		}
		sort.Strings(cs)
		return "quality:" + strings.Join(cs, "+"), "卡片品質檢查沒通過"
	case isD1QuotaText(raw):
		return "cloud_db_quota", "雲端資料庫今天的寫入額度用完"
	case strings.Contains(raw, "4007:") || strings.Contains(raw, "4002:") || strings.Contains(raw, "雲端萃取失敗（HTTP 50"):
		return "cloud_ai", "雲端 AI 暫時出錯"
	case strings.Contains(raw, "connection reset") || strings.Contains(raw, "連不上你的知識庫") || strings.Contains(raw, "unexpected EOF"):
		return "network", "連線中途被切斷"
	case strings.Contains(raw, "卡片位置被佔用"):
		return "card_name_taken", "卡片名稱和既有檔案撞名"
	case strings.Contains(raw, "萃取 JSON 解析失敗"):
		return "model_json", "AI 回的內容格式不對"
	case strings.Contains(raw, "雲端沒有把這一份寫進"):
		return "cloud_write", "雲端沒有把檔案寫進知識庫"
	case strings.Contains(raw, "回得太慢"):
		return "cloud_slow", "知識庫回應太慢"
	}
	// 🔴 鍵只由穩定的分類決定，**不含錯誤原文**（#240 c18374）：以前這裡把原文前 40 字
	// 切進鍵裡（`other:HTTP N：{"success":false…`），原文帶引號／JSON，鍵會被截斷或被切成怪鍵，
	// 關閉（×）時寫下的鍵與下次判斷用的鍵對不上，× 就無效。所有未歸類的原因收成同一個鍵。
	_ = digitsRe
	return "other", "其他原因"
}

func selfRecovering(e *ManifestEntry) bool {
	return cardNumberRuleFixedSince(e) || isTransientCloudText(e.LastError) ||
		isD1QuotaText(e.LastError) || isOldCloudText(e.LastError) || isLocalNetworkText(e.LastError)
}

// stalledEntry＝這一筆算不算「停工」。
func stalledEntry(e *ManifestEntry) bool {
	if e == nil || e.FailCount < MaxFailBeforeSkip || strings.TrimSpace(e.LastError) == "" {
		return false
	}
	if selfRecovering(e) {
		return e.FailCount >= MaxFailBeforeSkip+stallExtraTries
	}
	return true
}

// StalledGroups 把一批 manifest（同一個知識庫 host 底下的各資料夾）裡的停工檔按原因分組，
// 只回份數 ≥ StallMinFiles 的組；依份數由多到少。
func StalledGroups(host string, manifests map[string]*Manifest) []StalledGroup {
	byKey := map[string]*StalledGroup{}
	for root, m := range manifests {
		if m == nil {
			continue
		}
		for p, e := range m.Entries {
			if !stalledEntry(e) {
				continue
			}
			key, label := StallReason(e.LastError)
			g := byKey[key]
			if g == nil {
				g = &StalledGroup{Host: host, Key: key, Label: label, RawError: e.LastError,
					MinFails: e.FailCount, MaxFails: e.FailCount, Fingerprint: host + "|" + key}
				byKey[key] = g
			}
			g.Count++
			if e.FailCount < g.MinFails {
				g.MinFails = e.FailCount
			}
			if e.FailCount > g.MaxFails {
				g.MaxFails = e.FailCount
			}
			if len(g.Samples) < 5 {
				g.Samples = append(g.Samples, filepath.Base(p))
			}
			dup := false
			for _, r := range g.Roots {
				dup = dup || r == root
			}
			if !dup {
				g.Roots = append(g.Roots, root)
			}
		}
	}
	var out []StalledGroup
	for _, g := range byKey {
		if g.Count >= StallMinFiles {
			sort.Strings(g.Samples)
			out = append(out, *g)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	return out
}

// ManifestPathFor＝某（知識庫, 資料夾）的帳本路徑（與 DirectConfig.manifestPathFor 同一條公式）。
func ManifestPathFor(manifestBase, cypherURL, absRoot string) string {
	return (&DirectConfig{CypherURL: cypherURL, Manifest: manifestBase}).manifestPathFor(absRoot)
}

// LoadStalledGroups 讀這個知識庫各資料夾的帳本，回停工分組。讀不到的資料夾略過（不為難畫面）。
func LoadStalledGroups(manifestBase, cypherURL string, roots []string) []StalledGroup {
	ms := map[string]*Manifest{}
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		p := ManifestPathFor(manifestBase, cypherURL, abs)
		if _, err := os.Stat(p); err != nil {
			continue
		}
		if m, err := LoadManifest(p, abs); err == nil {
			ms[r] = m
		}
	}
	return StalledGroups(instanceHostOf(cypherURL), ms)
}
