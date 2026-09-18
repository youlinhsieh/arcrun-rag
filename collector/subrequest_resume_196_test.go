package collector

// inkstone/arcrun-rag#196：雲端 1.4.64 起修掉「單次呼叫子請求太多」那面牆，
// 但修之前被記滿 8 次、暫停自動重試的檔不會自己動——用戶不改檔、不按「立刻同步」就永遠送不上去。
// 09-17 實查 geek6688：13 份掛著這種暫停，含本票量測用的兩張卡。
// 本檔用那兩張卡在 geek6688 帳本上的**原樣病歷**（testdata/196_geek6688_paused.json）重演。

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type pausedFixture struct {
	Entries map[string]struct {
		FailCount  int    `json:"fail_count"`
		LastFailAt int64  `json:"last_fail_at"`
		NextRetry  int64  `json:"next_retry"`
		LastError  string `json:"last_error"`
	} `json:"entries"`
}

const (
	card196Sample = "system-dev/wiki/cards/arcrun-sample-knowledge.md"
	card196N8n    = "system-dev/wiki/cards/arcrun-n8n版本比較表新-2025.11-範本.md"
)

// fakeCloud196 ＝一台假知識庫：萃取一律成功；收卡依 wall 決定回成功或回 geek6688 那句 500。
type fakeCloud196 struct {
	mu      sync.Mutex
	version string          // /health 的 bundle_version
	wall    map[string]bool // 這些檔收卡時回「Too many subrequests」
	posts   map[string]int  // 每個檔實際打到 rag_ingest_card 幾次
	wallErr string
}

func (f *fakeCloud196) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var req struct {
		PageName string `json:"page_name"`
		Text     string `json:"text"`
		Path     string `json:"path"`
	}
	_ = json.Unmarshal(body, &req)
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture(req.PageName, "測試")})
	case strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger"):
		f.posts[req.Path]++
		if f.wall[req.Path] {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, f.wallErr)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}
}

func (f *fakeCloud196) postsOf(p string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts[p]
}

// setup196 建出「geek6688 今天的樣子」：兩張卡在帳本上是舊版留下的暫停病歷（沒記雲端版本）。
func setup196(t *testing.T) (cfg *DirectConfig, mp, root string, cloud *fakeCloud196, clock *time.Time) {
	t.Helper()
	cloudRoutes.reset()
	t.Cleanup(cloudRoutes.reset)
	withCloudCheckInterval(t, 0)

	raw, err := os.ReadFile(filepath.Join("testdata", "196_geek6688_paused.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx pausedFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Entries) != 2 {
		t.Fatalf("fixture 應有兩張卡：%d", len(fx.Entries))
	}

	root = t.TempDir()
	writeFile(t, root, card196Sample, "# Arcrun 範例知識\n\nArcrun 是跑在 Cloudflare 上的工作流引擎。", baseTime)
	writeFile(t, root, card196N8n, "# n8n 版本比較表\n\n| 版本 | 說明 |\n|---|---|\n| 1.0 | 測試 |", baseTime)

	cloud = &fakeCloud196{wall: map[string]bool{}, posts: map[string]int{},
		wallErr: fx.Entries[card196Sample].LastError[len("HTTP 500："):]}
	oldFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) {
		cloud.mu.Lock()
		defer cloud.mu.Unlock()
		return cloud.version, true
	}
	t.Cleanup(func() { fetchCloudVersion = oldFetch })

	// 先占位址再關掉：第一輪連不上（只為了建出帳本），之後在同一個位址開假雲端。
	ln0, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln0.Addr().String()
	_ = ln0.Close()

	c := time.Unix(fx.Entries[card196Sample].NextRetry, 0).Add(4 * 24 * time.Hour) // 09-17：暫停早已過了退避窗口
	clock = &c
	oldNow := directNow
	directNow = func() time.Time { return *clock }
	t.Cleanup(func() { directNow = oldNow })

	cfg = &DirectConfig{
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		Extractor: "workers-ai", ExtractorExplicit: true, MachineLabel: "測試機",
		MaxRemoved: DefaultMaxRemovedRatio,
		Accounts: []AccountConfig{{CypherURL: "http://" + addr, Namespace: "demo", APIKey: "demo",
			InstanceName: "geek6688", WatchFolders: []string{root}}},
	}
	RunDirectOnce(cfg, false)
	cloudRoutes.reset() // 建帳本那一輪的連線失敗不要帶進正式情境
	acc := cfg.makeAccountSubConfig(cfg.Accounts[0])
	mp = acc.manifestPathFor(root)
	m, err := LoadManifest(mp, root)
	if err != nil {
		t.Fatal(err)
	}
	for p, f := range fx.Entries {
		e := m.Entries[p]
		if e == nil {
			t.Fatalf("帳本裡沒有 %s", p)
		}
		e.IngestedHash, e.IngestedAt, e.NoCloudCard = "", 0, false
		e.FailCount, e.LastFailAt, e.NextRetry, e.LastError = f.FailCount, f.LastFailAt, f.NextRetry, f.LastError
		e.FailCloudVersion = "" // 舊版小幫手不記這欄
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("無法重新綁定同一個埠（%v）", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(cloud.handler)}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	if p := mustLoad(t, mp, root).Progress(); p.Stuck != 2 {
		t.Fatalf("前置條件：兩張卡都該是暫停：%+v", p)
	}
	return cfg, mp, root, cloud, clock
}

func mustLoad(t *testing.T, mp, root string) *Manifest {
	t.Helper()
	m, err := LoadManifest(mp, root)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// 雲端還是舊版 ⇒ 照舊暫停、不重撞；雲端更新到 1.4.64 以上 ⇒ 不用人動手，兩張卡自己送上去、算完成。
func TestDirect196_SubrequestPausedResumesAfterCloudFix(t *testing.T) {
	cfg, mp, root, cloud, clock := setup196(t)

	cloud.version = "1.4.63"
	results, _, _ := RunDirectOnce(cfg, false)
	if n := cloud.postsOf(card196Sample) + cloud.postsOf(card196N8n); n != 0 {
		t.Fatalf("雲端還是 1.4.63（沒修那面牆）時不該重撞，卻送了 %d 發", n)
	}
	for _, r := range results {
		if (r.Path == card196Sample || r.Path == card196N8n) && !strings.Contains(r.Error, "已暫停自動重試") {
			t.Fatalf("舊雲端上 %s 應維持暫停說明，拿到 %q", r.Path, r.Error)
		}
	}
	if p := mustLoad(t, mp, root).Progress(); p.Stuck != 2 {
		t.Fatalf("舊雲端上兩張都該維持暫停：%+v", p)
	}

	cloud.version = "1.4.67" // geek6688 09-17 的 /health
	*clock = clock.Add(time.Minute)
	RunDirectOnce(cfg, false)
	if cloud.postsOf(card196Sample) == 0 || cloud.postsOf(card196N8n) == 0 {
		t.Fatalf("雲端更新後兩張都要自己送出：sample=%d n8n=%d", cloud.postsOf(card196Sample), cloud.postsOf(card196N8n))
	}
	m := mustLoad(t, mp, root)
	if p := m.Progress(); p.Stuck != 0 || p.Done != p.Total {
		t.Fatalf("兩張都要算完成：%+v", p)
	}
	for _, p := range []string{card196Sample, card196N8n} {
		if e := m.Entries[p]; e.FailCount != 0 || e.LastError != "" || e.FailCloudVersion != "" {
			t.Fatalf("%s 送成功後病歷要清乾淨：%+v", p, e)
		}
	}
}

// 在已經修好的雲端上**又**撞同一面牆（卡真的太大）⇒ 記下這一版，之後不再自動重撞燒額度。
func TestDirect196_StillTooBigOnFixedCloudStaysPaused(t *testing.T) {
	cfg, mp, root, cloud, clock := setup196(t)
	cloud.version = "1.4.67"
	cloud.wall[card196Sample] = true

	RunDirectOnce(cfg, false)
	first := cloud.postsOf(card196Sample)
	if first == 0 {
		t.Fatal("雲端已修好時，舊暫停的卡應該要再試一次")
	}
	m := mustLoad(t, mp, root)
	e := m.Entries[card196Sample]
	if e.FailCount < MaxFailBeforeSkip || e.FailCloudVersion != "1.4.67" || !isSubrequestLimitText(e.LastError) {
		t.Fatalf("在新雲端上又撞牆，病歷要記下 1.4.67：%+v", e)
	}
	if p := m.Progress(); p.Done != 1 || p.Stuck != 1 {
		t.Fatalf("n8n 那張送成、sample 那張暫停：%+v", p)
	}

	*clock = clock.Add(7 * 24 * time.Hour) // 遠超過最長退避
	cloudRoutes.reset()
	RunDirectOnce(cfg, false)
	if got := cloud.postsOf(card196Sample); got != first {
		t.Fatalf("已在修好的雲端上撞過牆，不該再自動重撞：%d → %d", first, got)
	}
}

func TestCloudHasSubrequestFix196(t *testing.T) {
	for v, want := range map[string]bool{
		"": false, "1.4.63": false, "1.4.64": true, "1.4.67+b08a8cee": true, "1.10.0": true,
		"2026-09-13+1eb26c9": false, "unknown": false,
	} {
		if got := cloudHasSubrequestFix(v); got != want {
			t.Errorf("cloudHasSubrequestFix(%q)=%v，要 %v", v, got, want)
		}
	}
}
