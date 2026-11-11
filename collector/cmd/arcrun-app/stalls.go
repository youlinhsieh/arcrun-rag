package main

// stalls.go — 檔案因同一個原因停工時，跳出卡片＋「回報給 Arcrun」按鈕（inkstone/arcrun-rag#240 c18242）。
//
// leo 2026-10-09 原話：「如果都是相同原因，就要通知擁有者讓他回報有什麼問題，我們才能修復，
// 那在小幫手應該跳出把這個問題回報的按鈕，用戶按了我們就收到票，不然只會在用戶那裡默默死掉」。
//
// 🔴 2026-11-11（inkstone/arcrun-rag#330）改成「先自己修、修不了才問你、你同意才寄」：
//   - 小幫手自己會退避重試、換連線、等額度（見 collector/selfheal.go 的分類）；那些**不打擾用戶**，也沒有卡。
//   - 重試也用完還過不了的（連一份都算），卡片問「要不要通報」；用戶先看到要送的完整內容（StallPreview），
//     按「同意通報」（ReportStall）才寄——寄的就是他看過的那一份，不重組。不同意（DeclineStall）就不寄、7 天內不再問。
//   - 寄出後卡片變「已通報 · 處理中」＋票號；問題沒了變「已修好」。
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
	"sort"
	"strings"
	"sync"
	"time"

	"arcrun-rag/collector"
)

// UIStall＝畫面上的一張「停工」卡。
//
// State（#330）：
//
//	ask       小幫手自己修不了，問用戶要不要通報（還沒回答）
//	reported  用戶同意、已寄出；處理中（Ticket＝票號，可能空＝收件端沒回票號）
//	fixed     已通報過的問題現在沒了
type UIStall struct {
	Fingerprint string   `json:"fingerprint"`
	Account     string   `json:"account"` // 給人看的知識庫名稱
	Count       int      `json:"count"`
	Label       string   `json:"label"`
	Samples     []string `json:"samples"`
	Reported    bool     `json:"reported"` // State != ask（舊欄位，保留）
	DismissKey  string   `json:"dismissKey"`
	State       string   `json:"state"`
	Ticket      string   `json:"ticket,omitempty"`
}

const (
	stallAsk      = "ask"
	stallReported = "reported"
	stallFixed    = "fixed"
)

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
		// #330：一份就該問（NRI 就是 2 份），所以門檻 1；要不要問由 collector.Diagnose 決定。
		for _, g := range collector.LoadStalledGroupsMin(cfg.Manifest, acc.CypherURL, acc.WatchFolders, 1) {
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

func helpStore() *collector.HelpStore {
	return collector.LoadHelpStore(collector.HelpStatePath(filepath.Join(appDir(), "manifest.json")))
}

var helpMu sync.Mutex

// updateHelp 讀—改—寫 help-state.json（App 與 collector 是兩個行程，檔案原子寫）。
func updateHelp(fn func(st *collector.HelpStore)) error {
	helpMu.Lock()
	defer helpMu.Unlock()
	p := collector.HelpStatePath(filepath.Join(appDir(), "manifest.json"))
	st := collector.LoadHelpStore(p)
	fn(st)
	return st.Save(p)
}

// uiStalls：只在「小幫手自己修不了」時才出卡（collector.Diagnose＝asked）。
//   - 退避重試中、等額度、這台電腦沒網路：自己處理，沒有卡，不打擾。
//   - 用戶說過「不用了」：7 天內不再出。
//   - 已通報：留一張「已通報 · 處理中」卡（帶票號）；問題沒了就變一張「已修好」卡，用戶 × 掉才消失。
func uiStalls(cfg *directConfig) []UIStall {
	store := helpStore()
	now := time.Now()
	var out []UIStall
	live := map[string]bool{} // 這一輪還有的（host|kind）
	for _, g := range cachedStalls(cfg, false) {
		live[collector.HelpKey(g.Host, g.Kind)] = true
		if collector.Diagnose(g.Kind, g.Count).Handling != collector.HandlingAsked {
			continue
		}
		card := UIStall{Fingerprint: g.Fingerprint, Account: g.AccountName,
			Count: g.Count, Label: g.Label, Samples: g.Samples, State: stallAsk}
		if e, ok := store.Lookup(g.Host, g.Kind, now); ok {
			switch e.State {
			case collector.HelpStateDeclined:
				continue
			case collector.HelpStateReported:
				card.State, card.Reported, card.Ticket = stallReported, true, e.Ticket
			}
		}
		out = append(out, card)
	}
	// 已通報、而且問題已經沒了 ⇒ 「已修好」
	open := map[string]map[string]bool{} // host → 仍有失敗紀錄的 kind
	for _, acc := range cfg.Accounts {
		if strings.TrimSpace(acc.CypherURL) == "" || strings.TrimSpace(cfg.Manifest) == "" {
			continue
		}
		open[shortHost(acc.CypherURL)] = collector.OpenFailureKinds(cfg.Manifest, acc.CypherURL, acc.WatchFolders)
	}
	for key, e := range store.Items {
		if e.State != collector.HelpStateReported || live[key] {
			continue
		}
		if _, ok := store.Lookup(strings.SplitN(key, "|", 2)[0], strings.SplitN(key, "|", 2)[1], now); !ok {
			continue
		}
		host, kind := strings.SplitN(key, "|", 2)[0], strings.SplitN(key, "|", 2)[1]
		if hk, known := open[host]; !known || hk[kind] {
			continue // 這個知識庫不在了，或這個原因還有檔在失敗（只是還沒到停工）
		}
		out = append(out, UIStall{Fingerprint: "fixed|" + key, Account: e.Account, Label: e.Label,
			State: stallFixed, Reported: true, Ticket: e.Ticket})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Fingerprint < out[j].Fingerprint })
	return out
}

// stallReportText＝送給 feedback_report 的文字：全是結構化事實，沒有文件內容。
func stallReportText(g stallGroupWithAcct) string {
	var b strings.Builder
	b.WriteString("【自動回報：檔案停工】小幫手自己試過修、修不了，用戶看過下面的內容後同意通報。\n\n")
	fmt.Fprintf(&b, "- 知識庫：%s（%s）\n", g.AccountName, g.Host)
	fmt.Fprintf(&b, "- 原因分類：%s（%s）\n", g.Key, g.Label)
	fmt.Fprintf(&b, "- 停工份數：%d（每份已失敗 %d～%d 次）\n", g.Count, g.MinFails, g.MaxFails)
	fmt.Fprintf(&b, "- 檔名樣本：%s\n", strings.Join(g.Samples, "、"))
	fmt.Fprintf(&b, "- 錯誤原文：%s\n", redactLocalPaths(g.RawError))
	fmt.Fprintf(&b, "- 小幫手版本：%s\n", version)
	b.WriteString("\n（此回報由小幫手自動產生，不含任何文件內容。）")
	return b.String()
}

// pendingReport＝已經給用戶看過、等他按「同意」的那一份。
type pendingReport struct {
	g      stallGroupWithAcct
	text   string
	diag   any
	shown  string
	shownA time.Time
}

var (
	pendingMu      sync.Mutex
	pendingReports = map[string]*pendingReport{}
)

const pendingTTL = 30 * time.Minute

// StallPreview 回「如果你同意，會寄出去的完整內容」（文字＋診斷資料），並記住它。
// 同意（ReportStall）寄的就是這一份，不重組——給用戶看的就是寄出去的。
// 不信任前端傳來的內容：只收分組鍵，事實一律現場讀帳本重算。
func (a *App) StallPreview(fingerprint string) (string, error) {
	cfg, err := loadCfg()
	if err != nil {
		return "", fmt.Errorf("讀不到設定")
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
		return "", fmt.Errorf("這個問題現在已經不在了（可能已經自己好了），不用通報")
	}
	text := stallReportText(*hit)
	diag := a.buildDiagnosticsPayload()
	dj, _ := json.MarshalIndent(diag, "", "  ")
	shown := text + "\n\n── 診斷資料（只有統計數字，不含文件內容）──\n" + string(dj)
	pendingMu.Lock()
	pendingReports[fingerprint] = &pendingReport{g: *hit, text: text, diag: diag, shown: shown, shownA: time.Now()}
	pendingMu.Unlock()
	return shown, nil
}

// ReportStall 是前端「同意通報」按鈕的唯一入口。
//
// 🔴 #330 紅線：不准背著用戶偷送——必須先 StallPreview（用戶看過內容）才寄得出去；
// 沒看過（沒有預覽記錄，或超過 30 分鐘）一律拒絕。寄出的就是預覽的那一份。
func (a *App) ReportStall(fingerprint string) error {
	pendingMu.Lock()
	p := pendingReports[fingerprint]
	pendingMu.Unlock()
	if p == nil || time.Since(p.shownA) > pendingTTL {
		return fmt.Errorf("請先看過要寄出的內容再同意")
	}
	hit := p.g
	if e, ok := helpStore().Lookup(hit.Host, hit.Kind, time.Now()); ok && e.State == collector.HelpStateReported {
		return nil // 已通報過：不洗版、不開第二張票
	}
	ref, err := a.submitFeedbackRef(p.text, true, p.diag, hit.Host, buildEventKey(hit.Host, "stall", "all", hit.Key))
	if err != nil {
		return err // 沒送出去就不標已通報，用戶可再按
	}
	if err := markStallReported(fingerprint, hit.Count); err != nil {
		appLog("記錄已回報失敗：%v", err)
	}
	if err := updateHelp(func(st *collector.HelpStore) {
		st.Set(hit.Host, hit.Kind, collector.HelpEntry{State: collector.HelpStateReported,
			At: time.Now().UTC().Format(time.RFC3339), Ticket: ref, Account: hit.AccountName, Label: hit.Label})
	}); err != nil {
		appLog("記錄通報決定失敗：%v", err)
	}
	pendingMu.Lock()
	delete(pendingReports, fingerprint)
	pendingMu.Unlock()
	invalidateStallCache() // 讓畫面立刻換成「已通報」
	return nil
}

// DeclineStall 是前端「不用了」的入口：什麼都不寄；同一個原因 7 天內不再問（原因變了是另一個原因，會再問）。
func (a *App) DeclineStall(fingerprint string) error {
	cfg, err := loadCfg()
	if err != nil {
		return fmt.Errorf("讀不到設定")
	}
	for _, g := range cachedStalls(cfg, false) {
		if g.Fingerprint != fingerprint {
			continue
		}
		pendingMu.Lock()
		delete(pendingReports, fingerprint)
		pendingMu.Unlock()
		return updateHelp(func(st *collector.HelpStore) {
			st.Set(g.Host, g.Kind, collector.HelpEntry{State: collector.HelpStateDeclined,
				At: time.Now().UTC().Format(time.RFC3339), Account: g.AccountName, Label: g.Label})
		})
	}
	return nil // 已經不在清單裡了，不用記
}

func invalidateStallCache() {
	stallCacheMu.Lock()
	stallCacheAt = time.Time{}
	stallCacheMu.Unlock()
}

func problemKey(host, folder string) string { return "problem|" + host + "|" + folder }

// ReportProblem：「!N」popup 裡「無解」的一鍵回報（c18616）。folder 空字串＝整個帳號。
// 事實一律在這裡現場重算，不信任前端；回報過就不再送（鍵＝知識庫＋資料夾）。
func (a *App) ReportProblem(accIdx int, folder string) error {
	cfg, err := loadCfg()
	if err != nil || accIdx < 0 || accIdx >= len(cfg.Accounts) {
		return fmt.Errorf("讀不到設定")
	}
	acc := cfg.Accounts[accIdx]
	host := shortHost(acc.CypherURL)
	key := problemKey(host, folder)
	if _, done := loadStallReports()[key]; done {
		return nil
	}
	roots := acc.WatchFolders
	if folder != "" {
		roots = []string{folder}
	}
	var p collector.SyncProgress
	sync := loadSyncStatus()
	for _, r := range roots {
		if fp, ok := sync.FolderProgress[r]; ok {
			p = p.Add(fp)
		}
	}
	sent := -1
	if n := sentLastHour(cfg, acc); n != nil {
		sent = *n
	}
	out := activityOf(activityIn{P: p, Known: true, Alive: collectorAlive(), SentHour: sent})
	names, raw := collector.StuckSamples(cfg.Manifest, acc.CypherURL, roots)
	if err := a.submitFeedbackFor(problemReportText(accountName(acc), host, folder, p, out, names, raw), true, host, problemEventKey(host, folder, out.State, raw)); err != nil {
		return err
	}
	_ = markStallReported(key, out.N)
	return nil
}

// ReportFileProblem：資料夾樹裡「這一份」出錯檔的回報鈕（c18700 第 9 項）。
// 鍵＝知識庫＋資料夾＋檔案，回報過就不再送；內容只有檔名（basename）、分類與錯誤原文（路徑已遮蔽）。
func (a *App) ReportFileProblem(accIdx int, root, rel string) error {
	cfg, err := loadCfg()
	if err != nil || accIdx < 0 || accIdx >= len(cfg.Accounts) || strings.TrimSpace(rel) == "" {
		return fmt.Errorf("讀不到設定")
	}
	acc := cfg.Accounts[accIdx]
	host := shortHost(acc.CypherURL)
	key := problemKey(host, root) + "|" + rel
	if _, done := loadStallReports()[key]; done {
		return nil
	}
	raw := collector.FileLastError(cfg.Manifest, acc.CypherURL, root, rel)
	text := "【自動回報：一份檔案出錯】用戶按了這份檔案旁的「回報」。\n\n" +
		fmt.Sprintf("- 知識庫：%s（%s）\n- 資料夾：%s\n- 檔名：%s\n", accountName(acc), host, filepath.Base(root), filepath.Base(rel))
	if raw != "" {
		text += "- 錯誤原文：" + redactLocalPaths(raw) + "\n"
	}
	text += fmt.Sprintf("- 小幫手版本：%s\n\n（此回報由小幫手自動產生，不含任何文件內容。）", version)
	if err := a.submitFeedbackFor(text, true, host, fileEventKey(host, root, rel, raw)); err != nil {
		return err
	}
	return markStallReported(key, 1)
}

// ReportedFiles：這個帳號已回報過的出錯檔（鍵＝資料夾|相對路徑），畫面據此標 ✓。
func (a *App) ReportedFiles(accIdx int) []string {
	cfg, err := loadCfg()
	if err != nil || accIdx < 0 || accIdx >= len(cfg.Accounts) {
		return nil
	}
	prefix := "problem|" + shortHost(cfg.Accounts[accIdx].CypherURL) + "|"
	var out []string
	for k := range loadStallReports() {
		if strings.HasPrefix(k, prefix) && strings.Count(k, "|") >= 3 {
			out = append(out, strings.TrimPrefix(k, prefix))
		}
	}
	return out
}

// problemEventKey：「!N」整個帳號／一個資料夾的回報。原因優先用錯誤原文歸類，沒有原文就用畫面狀態。
func problemEventKey(host, folder, state, rawErr string) string {
	scope, target := "acct", "all"
	if folder != "" {
		scope, target = "folder", filepath.Base(folder)
	}
	cause := causeKeyOf(rawErr)
	if strings.TrimSpace(rawErr) == "" {
		cause = "state-" + state
	}
	return buildEventKey(host, scope, target, cause)
}

// fileEventKey：資料夾樹裡一份出錯檔的回報。鍵含資料夾名與檔案的相對路徑（不同資料夾的同名檔是不同事件）。
func fileEventKey(host, root, rel, rawErr string) string {
	return buildEventKey(host, "file", filepath.Base(root)+"/"+filepath.ToSlash(rel), causeKeyOf(rawErr))
}
