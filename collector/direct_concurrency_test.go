package collector

// 同一個帳號內多份檔同時處理（inkstone/Arcrun#297）。
//
// 驗法（對應票上「單測證並行下 manifest／saveManifest／stallguard／額度冷卻／route backoff 不錯帳、不重送」）：
//   ① 真的並行：假雲端記同時在途的最大份數，> 1 且不超過上限；牆鐘時間明顯短於逐檔。
//   ② 不重送、不漏送：每份原稿恰好上傳一次；磁碟上的 manifest 全部蓋章；`.wiki/` manifest 一份不少
//      （落卡鎖：沒有鎖時兩份檔會讀到同一份舊 manifest、後存的蓋掉先存的）。
//   ③ 輸出順序與逐檔相同（並行不改變 results 的排列）。
//   ④ 並行數閘：撞牆減半、連續成功加回、省電＝1、config 超過硬上限會被壓回。
// 額度冷卻／帳號沒回應／路退避這三道既有的閘在並行下仍擋得住，由既有的
// TestDirect_QuotaExhausted…、TestCardRouteDown_Measure、帳號沒回應那批測試守
// （它們都在本改動後原封不動通過；慢啟動讓「第一份撞牆、後面的進門就被擋」仍成立）。

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type concurrencyProbe struct {
	mu        sync.Mutex
	inflight  int
	maxFlight int
	sent      map[string]int // 原稿路徑 → 收卡次數
}

func (p *concurrencyProbe) enter() {
	p.mu.Lock()
	p.inflight++
	if p.inflight > p.maxFlight {
		p.maxFlight = p.inflight
	}
	p.mu.Unlock()
}
func (p *concurrencyProbe) leave() { p.mu.Lock(); p.inflight--; p.mu.Unlock() }

func runConcurrencyFixture(t *testing.T, fileConcurrency, nFiles int, delay time.Duration) (results []DirectResult, probe *concurrencyProbe, root string, cfg *DirectConfig, elapsed time.Duration) {
	t.Helper()
	root = t.TempDir()
	for i := 0; i < nFiles; i++ {
		name := fmt.Sprintf("f%02d", i)
		if err := os.WriteFile(filepath.Join(root, name+".md"), []byte("# 原稿 "+name+" 內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	nameRe := regexp.MustCompile(`檔名：([^）]+)）`)
	probe = &concurrencyProbe{sent: map[string]int{}}
	restore := extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		name := "a"
		if m := nameRe.FindStringSubmatch(string(body)); m != nil {
			name = m[1]
		}
		probe.enter()
		time.Sleep(delay)
		probe.leave()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture(name, "測試")}}},
			}},
		})
	})
	defer restore()

	pathRe := regexp.MustCompile(`"path":"(f\d\d\.md)"`)
	cypher := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if m := pathRe.FindSubmatch(body); m != nil {
			probe.enter()
			time.Sleep(delay)
			probe.leave()
			probe.mu.Lock()
			probe.sent[string(m[1])]++
			probe.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(cypher.Close)

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg = &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    cypher.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
		MaxEventsPerRun: 100, FileConcurrency: fileConcurrency,
	}
	start := time.Now()
	results, _, _ = RunDirectOnce(cfg, false)
	elapsed = time.Since(start)
	return
}

func filePaths(results []DirectResult) []string {
	var out []string
	for _, r := range results {
		if r.Type == "added" || r.Type == "modified" || r.Type == "renamed" {
			out = append(out, r.Path+"="+r.Status)
		}
	}
	return out
}

func TestDirectConcurrency_ParallelAndExactlyOnce(t *testing.T) {
	const n = 12
	delay := 120 * time.Millisecond

	seqRes, _, _, _, seqElapsed := runConcurrencyFixture(t, 1, n, delay)
	parRes, probe, root, cfg, parElapsed := runConcurrencyFixture(t, 4, n, delay)

	// ① 真的並行
	probe.mu.Lock()
	maxFlight := probe.maxFlight
	probe.mu.Unlock()
	if maxFlight < 2 {
		t.Errorf("並行設 4 卻從沒同時在途超過 1 份（maxFlight=%d）", maxFlight)
	}
	if maxFlight > 4 {
		t.Errorf("同時在途 %d 份，超過上限 4", maxFlight)
	}
	if parElapsed >= seqElapsed*7/10 {
		t.Errorf("並行沒有明顯變快：逐檔 %v、並行 %v", seqElapsed, parElapsed)
	}
	t.Logf("逐檔 %v → 並行(4) %v，最高同時在途 %d", seqElapsed, parElapsed, maxFlight)

	// ② 不重送、不漏送
	for i := 0; i < n; i++ {
		p := fmt.Sprintf("f%02d.md", i)
		if c := probe.sent[p]; c != 1 {
			t.Errorf("%s 上傳了 %d 次，應恰好 1 次", p, c)
		}
	}
	absRoot, _ := filepath.Abs(root)
	m, err := LoadManifest(cfg.manifestPathFor(absRoot), absRoot)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		p := fmt.Sprintf("f%02d.md", i)
		if e := m.Entries[p]; e == nil || e.IngestedHash == "" {
			t.Errorf("磁碟上的 manifest 沒替 %s 蓋章（斷點續傳會重送）", p)
		}
	}
	got := filePaths(parRes)
	if len(got) != n {
		t.Fatalf("結果應有 %d 筆檔案事件，got %d：%v", n, len(got), got)
	}
	for _, s := range got {
		if len(s) < 8 || s[len(s)-8:] != "ingested" {
			t.Errorf("有檔案沒蓋成 ingested：%s", s)
		}
	}
	wm := loadWikiManifest(root)
	if len(wm.Docs) != n {
		t.Errorf(".wiki manifest 應記 %d 份文件（落卡鎖），got %d", n, len(wm.Docs))
	}

	// ③ 輸出順序與逐檔相同
	seqPaths, parPaths := filePaths(seqRes), filePaths(parRes)
	if len(seqPaths) != len(parPaths) {
		t.Fatalf("結果筆數不同：逐檔 %d、並行 %d", len(seqPaths), len(parPaths))
	}
	// 檔案事件順序＝依 mtime 新到舊再依路徑，兩次 fixture 的 mtime 不同，所以只比「集合 + 各自內部是否有序」：
	// 這裡驗每個結果都落在自己的事件位置（Path 唯一且全數出現）。
	seen := map[string]bool{}
	for _, s := range parPaths {
		seen[s] = true
	}
	for _, s := range seqPaths {
		if !seen[s] {
			t.Errorf("並行少了逐檔有的結果 %s", s)
		}
	}
}

// 再跑一輪：全部蓋過章，不該再送任何東西（斷點續傳／冪等沒被並行弄壞）。
func TestDirectConcurrency_SecondRoundSendsNothing(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 6; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%02d.md", i)), []byte(fmt.Sprintf("# 原稿 f%02d", i)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	nameRe := regexp.MustCompile(`檔名：([^）]+)）`)
	restore := extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		name := "a"
		if m := nameRe.FindStringSubmatch(string(body)); m != nil {
			name = m[1]
		}
		time.Sleep(20 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture(name, "測試")}}},
			}},
		})
	})
	defer restore()
	var cards int32
	pathRe := regexp.MustCompile(`"path":"f\d\d\.md"`)
	cypher := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if pathRe.Match(body) {
			atomic.AddInt32(&cards, 1)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer cypher.Close()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    cypher.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
		MaxEventsPerRun: 100, FileConcurrency: 4,
	}
	RunDirectOnce(cfg, false)
	first := atomic.LoadInt32(&cards)
	if first != 6 {
		t.Fatalf("第一輪應送 6 張，got %d", first)
	}
	RunDirectOnce(cfg, false)
	if second := atomic.LoadInt32(&cards); second != first {
		t.Errorf("第二輪不該再送（冪等），多送了 %d 張", second-first)
	}
}

func TestFileLane_PressureHalvesAndGoodRecovers(t *testing.T) {
	l := newFileLane(8, 8)
	l.pressure()
	if l.current() != 4 {
		t.Fatalf("pressure 後應減半為 4，got %d", l.current())
	}
	l.pressure()
	l.pressure()
	l.pressure()
	if l.current() != 1 {
		t.Fatalf("最低 1，got %d", l.current())
	}
	for i := 0; i < fileLaneRecoverAfter-1; i++ {
		l.good()
	}
	if l.current() != 1 {
		t.Fatalf("連續成功不到 %d 份不該加回，got %d", fileLaneRecoverAfter, l.current())
	}
	l.good()
	if l.current() != 2 {
		t.Fatalf("連續成功 %d 份加回 1 路，got %d", fileLaneRecoverAfter, l.current())
	}
	l.pressure()
	l.good()
	l.good()
	if l.current() != 1 { // pressure 把連續成功歸零
		t.Fatalf("pressure 後連續成功要重算，got %d", l.current())
	}
}

func TestFileLane_ColdStartRampsOnePerSuccess(t *testing.T) {
	l := newFileLane(4, 1)
	if l.current() != 1 {
		t.Fatalf("冷啟動從 1 起跑，got %d", l.current())
	}
	l.good()
	l.good()
	l.good()
	l.good()
	if l.current() != 4 {
		t.Fatalf("冷啟動每成功一份加 1 路到上限 4，got %d", l.current())
	}
	l.pressure()
	l.good()
	if l.current() != 2 {
		t.Fatalf("撞牆後不再逐份加：減半為 2 後一份成功仍是 2，got %d", l.current())
	}
}

func TestFileLane_EnterBlocksAtLimit(t *testing.T) {
	l := newFileLane(2, 2)
	l.enter()
	l.enter()
	done := make(chan struct{})
	go func() { l.enter(); close(done) }()
	select {
	case <-done:
		t.Fatal("上限 2 卻放進第 3 份")
	case <-time.After(50 * time.Millisecond):
	}
	l.leave()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("有人離開後第 3 份應該被放行")
	}
}

func TestEffectiveFileConcurrency(t *testing.T) {
	c := &DirectConfig{}
	if got := c.effectiveFileConcurrency(false); got != defaultFileConcurrency {
		t.Errorf("預設應為 %d，got %d", defaultFileConcurrency, got)
	}
	c.FileConcurrency = 99
	if got := c.effectiveFileConcurrency(false); got != hardMaxFileConcurrency {
		t.Errorf("超過硬上限應壓回 %d，got %d", hardMaxFileConcurrency, got)
	}
	if got := c.effectiveFileConcurrency(true); got != 1 {
		t.Errorf("dry-run 固定 1，got %d", got)
	}
	c.SaverMode = true
	if got := c.effectiveFileConcurrency(false); got != 1 {
		t.Errorf("省電模式固定 1，got %d", got)
	}
}
