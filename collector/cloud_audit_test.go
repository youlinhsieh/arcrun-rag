package collector

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 每個測試都把節流關掉，避免 20 個探測睡 2 秒。
func init() { pace2 = func(time.Duration) {} }

func newAuditManifest(paths ...string) *Manifest {
	m := &Manifest{FolderID: "f", Root: "/root", Entries: map[string]*ManifestEntry{}}
	for _, p := range paths {
		m.Entries[p] = &ManifestEntry{
			ContentHash:  "sha256:" + p,
			IngestedHash: "sha256:" + p,
			IngestedAt:   100,
		}
	}
	return m
}

// stubProbe 讓測試指定「雲端有哪些」，並記錄被問了幾次。
func stubProbe(t *testing.T, present map[string]bool, err error) *int {
	t.Helper()
	calls := 0
	orig := probeCloudCard
	probeCloudCard = func(cfg *DirectConfig, library, relPath string) (bool, bool, error) {
		calls++
		if err != nil {
			return false, false, err
		}
		return present[relPath], true, nil
	}
	t.Cleanup(func() { probeCloudCard = orig })
	return &calls
}

func auditCfg() *DirectConfig {
	return &DirectConfig{CypherURL: "https://x.invalid", APIKey: "ns", Namespace: "ns"}
}

// 本票的主場景：雲端被清空 ⇒ 章全部作廢 ⇒ Scan() 補發 added ⇒ 重送。
func TestAudit_CloudWiped_VoidsStampsAndScanReemits(t *testing.T) {
	m := newAuditManifest("a.md", "b.pdf")
	stubProbe(t, map[string]bool{}, nil) // 雲端什麼都沒有
	now := time.Unix(1_000_000, 0)

	res := auditCloudLedger(auditCfg(), "/root", m, false, now)
	if res == nil || res.Voided != 2 || res.Checked != 2 {
		t.Fatalf("預期對帳 2 份、作廢 2 份，實得 %+v", res)
	}
	for p, e := range m.Entries {
		if e.IngestedHash != "" {
			t.Fatalf("%s 的章沒有被拔掉", p)
		}
		if e.CloudMissingAt != now.Unix() {
			t.Fatalf("%s 沒有記下 cloud_missing_at", p)
		}
	}

	// 這才是真正的驗收：拔章之後 Scan() 要自己補發 added（不必另造送件路）。
	root := t.TempDir()
	writeFile(t, root, "a.md", "hello", time.Unix(900_000, 0))
	writeFile(t, root, "b.pdf", "world", time.Unix(900_000, 0))
	m2 := newAuditManifest("a.md", "b.pdf")
	for _, e := range m2.Entries {
		e.IngestedHash = "" // 對帳剛拔掉的狀態
	}
	// content_hash 讓 Scan 自己重算，這裡只要它認得出「這兩個路徑還沒 ingest 成功」。
	payload, err := Scan(root, m2, ScanOptions{MaxRemovedRatio: 0.4})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	added := map[string]bool{}
	for _, ev := range payload.Events {
		if ev.Type == "added" {
			added[ev.Path] = true
		}
	}
	if !added["a.md"] || !added["b.pdf"] {
		t.Fatalf("拔章後 Scan 沒有補發 added，實得 %+v", payload.Events)
	}
}

// 驗收條件 5：重跑第二次不可以又全部重送一遍。
func TestAudit_SecondRunDoesNotVoidAgain(t *testing.T) {
	m := newAuditManifest("a.md")
	stubProbe(t, map[string]bool{}, nil)
	now := time.Unix(1_000_000, 0)

	if r := auditCloudLedger(auditCfg(), "/root", m, false, now); r == nil || r.Voided != 1 {
		t.Fatalf("第一輪應該作廢 1 份，實得 %+v", r)
	}
	// 模擬補送成功（雲端仍在 ingest 中、查不到）
	m.MarkIngestedBy("a.md", "sha256:a.md", now.Unix()+1, "workers-ai")

	// 一小時後再對帳：雲端還是查不到，但 grace 內**不准**再拔一次章。
	later := now.Add(time.Hour)
	m.CloudAuditAt = 0 // 解除資料夾層節流，只考驗 per-path grace
	r2 := auditCloudLedger(auditCfg(), "/root", m, false, later)
	if r2 != nil && r2.Voided > 0 {
		t.Fatalf("grace 期間又拔了章 ⇒ 會變成無限重送迴圈：%+v", r2)
	}
	if m.Entries["a.md"].IngestedHash == "" {
		t.Fatal("章被重複拔掉了")
	}
}

// 雲端有的檔不准被動到（否則就是全量重送）。
func TestAudit_PresentCardsUntouched(t *testing.T) {
	m := newAuditManifest("a.md", "b.md")
	stubProbe(t, map[string]bool{"a.md": true, "b.md": true}, nil)
	now := time.Unix(1_000_000, 0)

	res := auditCloudLedger(auditCfg(), "/root", m, false, now)
	if res == nil || res.Voided != 0 || res.Checked != 2 {
		t.Fatalf("預期 0 作廢、2 已對帳，實得 %+v", res)
	}
	for p, e := range m.Entries {
		if e.IngestedHash == "" {
			t.Fatalf("%s 的章被誤拔", p)
		}
		if e.CloudCheckedAt != now.Unix() {
			t.Fatalf("%s 沒記下對帳時間 ⇒ 下一輪會重問，變成請求風暴", p)
		}
	}
}

// 🔴 網路抖動不准被讀成「雲端沒有」——那會讓一次逾時變成一次全量重送。
func TestAudit_ProbeFailureNeverVoids(t *testing.T) {
	m := newAuditManifest("a.md", "b.md")
	calls := stubProbe(t, nil, fmt.Errorf("connection reset"))
	res := auditCloudLedger(auditCfg(), "/root", m, false, time.Unix(1_000_000, 0))
	if res == nil || res.Voided != 0 || res.Err == "" {
		t.Fatalf("查不到時不該作廢、且要留下真因，實得 %+v", res)
	}
	if *calls != 1 {
		t.Fatalf("問不到就該整批停手（只問 1 次），實得 %d 次", *calls)
	}
	for p, e := range m.Entries {
		if e.IngestedHash == "" {
			t.Fatalf("%s 因為一次網路錯誤就被作廢", p)
		}
	}
}

// 從沒送成功過的檔不必問雲端（Scan 自己會重送），沒送過卡的檔更不能問（會無限重萃）。
func TestAudit_SkipsUnstampedAndNoCardEntries(t *testing.T) {
	m := newAuditManifest("stamped.md", "unstamped.md", "nocard.md")
	m.Entries["unstamped.md"].IngestedHash = ""
	m.Entries["nocard.md"].NoCloudCard = true
	calls := stubProbe(t, map[string]bool{}, nil)

	auditCloudLedger(auditCfg(), "/root", m, false, time.Unix(1_000_000, 0))
	if *calls != 1 {
		t.Fatalf("只該問 stamped.md 一個，實得 %d 次", *calls)
	}
	if m.Entries["nocard.md"].IngestedHash == "" {
		t.Fatal("沒送過卡的檔被作廢 ⇒ 會每天重萃一次，永遠停不下來")
	}
}

// 單輪上限＋最久沒對帳的排前面（巨量資料夾也要輪得完）。
func TestAudit_BatchCapAndOldestFirst(t *testing.T) {
	m := &Manifest{FolderID: "f", Root: "/root", Entries: map[string]*ManifestEntry{}}
	for i := 0; i < cloudAuditBatch+5; i++ {
		p := fmt.Sprintf("f%02d.md", i)
		m.Entries[p] = &ManifestEntry{
			ContentHash: "h", IngestedHash: "h",
			CloudCheckedAt: int64(i), // 越前面越久沒對
		}
	}
	var asked []string
	orig := probeCloudCard
	probeCloudCard = func(cfg *DirectConfig, library, relPath string) (bool, bool, error) {
		asked = append(asked, relPath)
		return true, true, nil
	}
	t.Cleanup(func() { probeCloudCard = orig })

	// force=true 才會忽略「24 小時內對過帳」的閘（上面的 CloudCheckedAt 是很小的數字，
	// 對現在的時間來說早就過期了，這裡用 force 讓意圖明確）。
	cfg := auditCfg()
	cfg.ForceSync = true
	auditCloudLedger(cfg, "/root", m, false, time.Unix(1_000_000, 0))
	if len(asked) != cloudAuditBatch {
		t.Fatalf("單輪上限沒生效：問了 %d 個（上限 %d）", len(asked), cloudAuditBatch)
	}
	if asked[0] != "f00.md" {
		t.Fatalf("最久沒對帳的沒排最前面，第一個是 %s", asked[0])
	}
}

// 資料夾層節流：daemon 每 5 秒一輪，不能每輪都對雲端發一批請求。
func TestAudit_FolderIntervalThrottle(t *testing.T) {
	m := newAuditManifest("a.md")
	calls := stubProbe(t, map[string]bool{"a.md": true}, nil)
	now := time.Unix(1_000_000, 0)

	auditCloudLedger(auditCfg(), "/root", m, false, now)
	auditCloudLedger(auditCfg(), "/root", m, false, now.Add(5*time.Second))
	if *calls != 1 {
		t.Fatalf("節流沒生效：5 秒內問了 %d 次", *calls)
	}
	// 使用者按「立刻同步」要能穿透節流。
	cfg := auditCfg()
	cfg.ForceSync = true
	auditCloudLedger(cfg, "/root", m, false, now.Add(6*time.Second))
	if *calls != 2 {
		t.Fatalf("立刻同步沒有穿透節流：共問了 %d 次", *calls)
	}
}

// 24 小時內對過帳的檔不重問（一般輪次）。
func TestAudit_RecheckInterval(t *testing.T) {
	m := newAuditManifest("a.md")
	m.Entries["a.md"].CloudCheckedAt = 1_000_000
	calls := stubProbe(t, map[string]bool{"a.md": true}, nil)
	auditCloudLedger(auditCfg(), "/root", m, false, time.Unix(1_000_000+3600, 0))
	if *calls != 0 {
		t.Fatalf("一小時前才對過帳，不該重問（實得 %d 次）", *calls)
	}
}

// dryRun 不准碰帳本。
func TestAudit_DryRunDoesNothing(t *testing.T) {
	m := newAuditManifest("a.md")
	calls := stubProbe(t, map[string]bool{}, nil)
	if r := auditCloudLedger(auditCfg(), "/root", m, true, time.Unix(1_000_000, 0)); r != nil {
		t.Fatalf("dry-run 不該做任何事，實得 %+v", r)
	}
	if *calls != 0 || m.Entries["a.md"].IngestedHash == "" || m.CloudAuditAt != 0 {
		t.Fatal("dry-run 動了帳本或打了網路")
	}
}

// 🔴 scan.go 的 carry 段漏欄位是這個檔案歷史上犯過兩次的錯（t195 fail_count、5fcc139
// LastError）。第三次的代價是「防重送迴圈的 grace 消失 ⇒ 燒光額度」，所以釘死它。
func TestScan_CarriesCloudAuditFields(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "hello", time.Unix(900_000, 0))
	m := &Manifest{FolderID: "f", Root: root, Entries: map[string]*ManifestEntry{}}
	if _, err := Scan(root, m, ScanOptions{MaxRemovedRatio: 0.4}); err != nil {
		t.Fatalf("首輪 Scan: %v", err)
	}
	e := m.Entries["a.md"]
	e.IngestedHash = e.ContentHash
	e.CloudCheckedAt = 111
	e.CloudMissingAt = 222
	e.NoCloudCard = true

	if _, err := Scan(root, m, ScanOptions{MaxRemovedRatio: 0.4}); err != nil {
		t.Fatalf("次輪 Scan: %v", err)
	}
	got := m.Entries["a.md"]
	if got.CloudCheckedAt != 111 || got.CloudMissingAt != 222 || !got.NoCloudCard {
		t.Fatalf("Scan 重建 entry 時把雲端對帳欄位抹掉了：%+v", got)
	}
}

// MarkIngestedBy 要保住 grace 標記（不然剛補送成功的檔立刻又回到可拔章的池子），
// 但要把 NoCloudCard 歸位（這一輪送了卡就不是「沒卡的檔」了）。
func TestMarkIngested_KeepsGraceClearsNoCard(t *testing.T) {
	m := newAuditManifest("a.md")
	e := m.Entries["a.md"]
	e.CloudCheckedAt, e.CloudMissingAt, e.NoCloudCard = 111, 222, true
	m.MarkIngestedBy("a.md", "h2", 999, "workers-ai")
	if e.CloudCheckedAt != 111 || e.CloudMissingAt != 222 {
		t.Fatalf("對帳記錄被清掉了：%+v", e)
	}
	if e.NoCloudCard {
		t.Fatal("NoCloudCard 沒有歸位")
	}
	if !m.MarkNoCloudCard("a.md") || !e.NoCloudCard {
		t.Fatal("MarkNoCloudCard 沒生效")
	}
}

// 補送進度是「現況快照」而不是「本輪計數」——沒事做的那輪不能歸零、補完要自然消失。
func TestResyncSummary(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	m := newAuditManifest("pending.md", "repaired.md", "normal.md")
	m.Entries["pending.md"].IngestedHash = ""
	m.Entries["pending.md"].CloudMissingAt = now.Unix() - 60
	m.Entries["repaired.md"].CloudMissingAt = now.Unix() - 60
	m.Entries["repaired.md"].IngestedAt = now.Unix() - 30

	pending, repaired := ResyncSummary(m, now)
	if pending != 1 || repaired != 1 {
		t.Fatalf("預期 pending=1 repaired=1，實得 %d/%d", pending, repaired)
	}
	if note := resyncNote(pending, repaired, ""); !strings.Contains(note, "補送") {
		t.Fatalf("人話沒生出來：%q", note)
	}
	// 一天後那句「已補回」要自己消失，不能永遠掛在畫面上。
	_, repairedLater := ResyncSummary(m, now.Add(25*time.Hour))
	if repairedLater != 0 {
		t.Fatalf("舊的補送紀錄沒有過期：%d", repairedLater)
	}
}

// cloudCardPresent 打的是真的 HTTP，形狀對不對用假伺服器釘住
// （URL 形狀一旦漂掉，對帳會靜默地永遠回「雲端沒有」＝全量重送）。
func TestCloudCardPresent_RequestShapeAndParsing(t *testing.T) {
	var got url.Values
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query()
		gotKey = r.Header.Get("X-Arcrun-API-Key")
		if r.URL.Path != "/kbdb/entries" {
			t.Errorf("打錯端點：%s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "entries": []any{}, "count": 0, "total": 1})
	}))
	defer srv.Close()

	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "ns"}
	present, ok, err := cloudCardPresent(cfg, "mylib", "docs/小果被AFTEE詐貸.pdf")
	if err != nil || !ok || !present {
		t.Fatalf("total=1 應該讀成 present，實得 present=%v ok=%v err=%v", present, ok, err)
	}
	if got.Get("source") != "kb://docs/小果被AFTEE詐貸.pdf#0" {
		t.Fatalf("source 鍵不對：%q", got.Get("source"))
	}
	if got.Get("library") != "mylib" || got.Get("entry_type") != "block" {
		t.Fatalf("庫／型別 filter 不對：%v", got)
	}
	if got.Get("offset") == "" || got.Get("offset") == "0" {
		t.Fatalf("沒有用大 offset 避開卡片內文：%q", got.Get("offset"))
	}
	if gotKey != "ns" {
		t.Fatalf("沒帶 X-Arcrun-API-Key：%q", gotKey)
	}
}

func TestCloudCardPresent_ZeroTotalIsMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "total": 0})
	}))
	defer srv.Close()
	present, ok, err := cloudCardPresent(&DirectConfig{CypherURL: srv.URL, APIKey: "ns"}, "lib", "a.md")
	if err != nil || !ok || present {
		t.Fatalf("total=0 應該讀成 missing，實得 present=%v ok=%v err=%v", present, ok, err)
	}
}

// 🔴 端點換了形狀（少了 total）要回「不知道」，不准回「雲端沒有」。
func TestCloudCardPresent_MissingTotalIsUnknown(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"沒有 total 欄位": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "entries": []any{}})
		},
		"success=false": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "total": 0, "error": "boom"})
		},
		"不是 JSON": func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html>cloudflare</html>"))
		},
		"401": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"缺少 X-Arcrun-API-Key header"}`))
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(h)
			defer srv.Close()
			_, ok, err := cloudCardPresent(&DirectConfig{CypherURL: srv.URL, APIKey: "ns"}, "lib", "a.md")
			if ok {
				t.Fatalf("%s 應該回 ok=false（不知道），不能回「雲端沒有」", name)
			}
			if err == nil {
				t.Fatalf("%s 沒有留下真因", name)
			}
		})
	}
}

func TestCloudCardPresent_NoConnectionInfo(t *testing.T) {
	if _, ok, _ := cloudCardPresent(&DirectConfig{}, "lib", "a.md"); ok {
		t.Fatal("沒有連線資訊時不該宣稱查得到答案")
	}
}
