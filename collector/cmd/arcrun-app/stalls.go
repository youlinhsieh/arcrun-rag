package main

// stalls.go — 檔案因同一個原因停工時，跳出卡片＋「回報給 Arcrun」按鈕（inkstone/arcrun-rag#240 c18242）。
//
// leo 2026-10-09 原話：「如果都是相同原因，就要通知擁有者讓他回報有什麼問題，我們才能修復，
// 那在小幫手應該跳出把這個問題回報的按鈕，用戶按了我們就收到票，不然只會在用戶那裡默默死掉」。
//
// 三條紅線（票上）：
//   - 不帶用戶文件內容：只帶原因分類、份數、檔名（basename）、錯誤原文（路徑已遮蔽）、版本號。
//   - 同一個原因不洗版：以（知識庫 host＋原因分類）為鍵，回報過就記在 stall-reports.json，
//     之後這個原因只顯示「已回報」，不再跳、不再開第二張票。
//   - 用既有通道：送出走 App.SubmitFeedback（#210，同一條 feedback_report 工作流開票），不另起一套。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"arcrun-rag/collector"
)

// UIStall＝畫面上的一張「停工」卡。
type UIStall struct {
	Fingerprint string   `json:"fingerprint"`
	Account     string   `json:"account"` // 給人看的知識庫名稱
	Count       int      `json:"count"`
	Label       string   `json:"label"`
	Samples     []string `json:"samples"`
	Reported    bool     `json:"reported"`
	DismissKey  string   `json:"dismissKey"`
}

func stallReportsPath() string { return filepath.Join(appDir(), "stall-reports.json") }

type stallReport struct {
	ReportedAt string `json:"reported_at"`
	Count      int    `json:"count"`
}

var stallMu sync.Mutex

func loadStallReports() map[string]stallReport {
	out := map[string]stallReport{}
	if b, err := os.ReadFile(stallReportsPath()); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func markStallReported(fp string, count int) error {
	stallMu.Lock()
	defer stallMu.Unlock()
	m := loadStallReports()
	m[fp] = stallReport{ReportedAt: time.Now().Format(time.RFC3339), Count: count}
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(stallReportsPath(), b, 0o600)
}

// 帳本有上萬筆，GetState 又會被畫面頻繁輪詢 ⇒ 掃描結果快取一分鐘。
var (
	stallCacheMu   sync.Mutex
	stallCacheAt   time.Time
	stallCacheVal  []stallGroupWithAcct
	stallCacheSalt string
)

type stallGroupWithAcct struct {
	collector.StalledGroup
	AccountName string
}

func computeStalls(cfg *directConfig) []stallGroupWithAcct {
	var out []stallGroupWithAcct
	for _, acc := range cfg.Accounts {
		if strings.TrimSpace(acc.CypherURL) == "" || strings.TrimSpace(cfg.Manifest) == "" {
			continue
		}
		for _, g := range collector.LoadStalledGroups(cfg.Manifest, acc.CypherURL, acc.WatchFolders) {
			out = append(out, stallGroupWithAcct{StalledGroup: g, AccountName: accountName(acc)})
		}
	}
	return out
}

func cachedStalls(cfg *directConfig, fresh bool) []stallGroupWithAcct {
	stallCacheMu.Lock()
	defer stallCacheMu.Unlock()
	if !fresh && time.Since(stallCacheAt) < time.Minute && stallCacheSalt == cfg.Manifest {
		return stallCacheVal
	}
	stallCacheVal = computeStalls(cfg)
	stallCacheAt = time.Now()
	stallCacheSalt = cfg.Manifest
	return stallCacheVal
}

// uiStalls：已回報的仍列出（標「已回報」），讓用戶知道我們收到了；不再要求他按。
func uiStalls(cfg *directConfig) []UIStall {
	reports := loadStallReports()
	var out []UIStall
	for _, g := range cachedStalls(cfg, false) {
		_, done := reports[g.Fingerprint]
		out = append(out, UIStall{Fingerprint: g.Fingerprint, Account: g.AccountName,
			Count: g.Count, Label: g.Label, Samples: g.Samples, Reported: done})
	}
	return out
}

// stallReportText＝送給 feedback_report 的文字：全是結構化事實，沒有文件內容。
func stallReportText(g stallGroupWithAcct) string {
	var b strings.Builder
	b.WriteString("【自動回報：檔案停工】小幫手偵測到多份檔案因同一個原因停工，用戶按了「回報給 Arcrun」。\n\n")
	fmt.Fprintf(&b, "- 知識庫：%s（%s）\n", g.AccountName, g.Host)
	fmt.Fprintf(&b, "- 原因分類：%s（%s）\n", g.Key, g.Label)
	fmt.Fprintf(&b, "- 停工份數：%d（每份已失敗 %d～%d 次）\n", g.Count, g.MinFails, g.MaxFails)
	fmt.Fprintf(&b, "- 檔名樣本：%s\n", strings.Join(g.Samples, "、"))
	fmt.Fprintf(&b, "- 錯誤原文：%s\n", redactLocalPaths(g.RawError))
	fmt.Fprintf(&b, "- 小幫手版本：%s\n", version)
	b.WriteString("\n（此回報由小幫手自動產生，不含任何文件內容。）")
	return b.String()
}

// ReportStall 是前端「回報給 Arcrun」按鈕的唯一入口。
// 不信任前端傳來的內容：只收分組鍵，事實一律在這裡重算（現場讀帳本）。
func (a *App) ReportStall(fingerprint string) error {
	cfg, err := loadCfg()
	if err != nil {
		return fmt.Errorf("讀不到設定，沒送出去")
	}
	var hit *stallGroupWithAcct
	for _, g := range cachedStalls(cfg, true) {
		if g.Fingerprint == fingerprint {
			g := g
			hit = &g
			break
		}
	}
	if hit == nil {
		return fmt.Errorf("這個問題現在已經不在停工清單裡了（可能已經自己好了），不用回報")
	}
	if _, done := loadStallReports()[fingerprint]; done {
		return nil // 已回報過：不洗版、不開第二張票
	}
	if err := a.SubmitFeedback(stallReportText(*hit), true); err != nil {
		return err // 沒送出去就不標已回報，用戶可再按
	}
	if err := markStallReported(fingerprint, hit.Count); err != nil {
		appLog("記錄已回報失敗：%v", err)
	}
	return nil
}
