// routebackoff_201_test.go — `inkstone/arcrun-rag#201` 的驗收。
//
// 2026-09-16 leo 的畫面：「雲端『雲端 AI 整理文件』這條路連續失敗 11 次，先停 26 分鐘再試」。
// 實查（collector.log.old＋manifest）：那句是 geek6688 帳號的，而且那 11 次是 09-14 開 App
// 之後兩天內零星的失敗（最後一發＝17:48:42 探測等了 20 秒），計數器從沒歸零過；
// 另外 leo 自己那台知識庫的 KB 資料夾有 17 份檔因為「這台電腦當時查不到 DNS」被記滿 8 次永久暫停、
// 12 份 0 位元組的日記被雲端回 400 後永久暫停。
package collector

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func dnsNotFoundErr(host string) error {
	return &url.Error{Op: "Post", URL: "https://" + host + "/portal/daemon/extract",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}}}
}

type timeoutErr struct{}

func (timeoutErr) Error() string {
	return "context deadline exceeded (Client.Timeout exceeded while awaiting headers)"
}
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// 本機沒連出去（DNS／網路不通／連線被拒）不花雲端額度 ⇒ 不准讓斷路器跳。
func TestRouteBreaker201_LocalNetworkDoesNotTrip(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	host := "arcrun-cypher-executor.kb-a.workers.dev"
	u := "https://" + host + "/portal/daemon/extract"
	t0 := time.Date(2026, 9, 16, 8, 0, 0, 0, time.UTC)
	errs := []error{
		dnsNotFoundErr(host),
		&url.Error{Op: "Post", URL: u, Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: network is unreachable")}},
		errors.New(`Post "x": dial tcp: lookup ` + host + `: no such host`),
		errors.New("dial tcp 127.0.0.1:9: connect: connection refused"),
	}
	for i := 0; i < 50; i++ {
		b.record(u, t0, 0, errs[i%len(errs)], false)
	}
	if n := b.note(u, t0); n != "" {
		t.Fatalf("本機沒連出去 50 次，斷路器不該跳：%q", n)
	}
	for i := 0; i < 50; i++ {
		b.record(u, t0, 400, nil, false)
	}
	if n := b.note(u, t0); n != "" {
		t.Fatalf("400 不花額度，斷路器不該跳：%q", n)
	}
	// 對照組：雲端連續 5xx 仍然要跳。
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		b.record(u, t0, 503, nil, false)
	}
	if b.note(u, t0) == "" {
		t.Fatal("雲端連續 5xx 仍然要退避（#121 的保護不准被拆掉）")
	}
}

// 「連續」要是真的連續：兩天內零星 11 次（每次隔 4 小時）不准累積成跳閘。
func TestRouteBreaker201_ScatteredFailuresDoNotAccumulate(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	u := "https://arcrun-cypher-executor.arcrun-fc9490d5.workers.dev/portal/daemon/extract"
	t0 := time.Date(2026, 9, 14, 9, 22, 0, 0, time.UTC)
	stall := &url.Error{Op: "Post", URL: u, Err: timeoutErr{}}
	for i := 0; i < 11; i++ {
		at := t0.Add(time.Duration(i) * 4 * time.Hour)
		b.record(u, at, 0, stall, false)
		if n := b.note(u, at); n != "" {
			t.Fatalf("第 %d 次零星失敗（距上一次 4 小時）就跳閘了：%q", i+1, n)
		}
	}
	t1 := t0.Add(100 * time.Hour)
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		b.record(u, t1.Add(time.Duration(i)*time.Minute), 0, stall, false)
	}
	if b.note(u, t1.Add(3*time.Minute+30*time.Second)) == "" {
		t.Fatal("幾分鐘內連續 4 發等不到回應，應該退避")
	}
}

// 跳閘時畫面那句話要點名是哪一台知識庫、最近一次是哪一種失敗；log 每一次失敗都帶時間。
func TestRouteBreaker201_NoteNamesAccountAndCause_LogHasTime(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	var mu sync.Mutex
	var got []string
	old := routeFailureLog
	routeFailureLog = func(at time.Time, f RouteFailure) {
		mu.Lock()
		defer mu.Unlock()
		line, _ := json.Marshal(struct {
			At string `json:"at"`
			RouteFailure
		}{at.Format(time.RFC3339), f})
		got = append(got, string(line))
	}
	defer func() { routeFailureLog = old }()

	u := "https://arcrun-cypher-executor.arcrun-fc9490d5.workers.dev/portal/daemon/extract"
	t0 := time.Date(2026, 9, 16, 9, 48, 42, 0, time.UTC)
	oldNow := directNow
	directNow = func() time.Time { return t0 }
	defer func() { directNow = oldNow }()

	cloudRoutes.record(u, t0, 0, dnsNotFoundErr("x"), false) // 不算，也不印
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		cloudRoutes.record(u, t0, 0, &url.Error{Op: "Post", URL: u, Err: timeoutErr{}}, false)
	}
	cfg := &DirectConfig{InstanceName: "geek6688", CypherURL: "https://arcrun-cypher-executor.arcrun-fc9490d5.workers.dev"}
	n := cfg.routeNote(u)
	for _, want := range []string{"geek6688", "雲端 AI 整理文件", "等不到回應", "稍後會自動恢復"} {
		if !strings.Contains(n, want) {
			t.Fatalf("畫面那句少了 %q：%q", want, n)
		}
	}
	if strings.Contains(n, "HTTP") {
		t.Fatalf("畫面上的話不准裸露狀態碼：%q", n)
	}
	if len(got) != routeStrikesBeforeBackoff {
		t.Fatalf("每一次算進去的失敗都要印一行，要 %d 行，拿到 %d：%v", routeStrikesBeforeBackoff, len(got), got)
	}
	last := got[len(got)-1]
	for _, want := range []string{`"at":"2026-09-16T09:48:42Z"`, `"cause":"等不到回應"`, `"fails":4`, `"backoff_until"`, "Client.Timeout"} {
		if !strings.Contains(last, want) {
			t.Fatalf("log 那一行少了 %s：%s", want, last)
		}
	}
	t.Logf("route_failure 紀錄範例：%s", last)
	t.Logf("畫面那句：%s", n)
}

// 舊病歷：斷網被記滿 8 次的檔，要自己再試、算排隊中。
func TestManifest201_LegacyNetworkPauseRetriesByItself(t *testing.T) {
	host := "arcrun-cypher-executor.kb-a.workers.dev"
	m := &Manifest{Entries: map[string]*ManifestEntry{
		"journals/2026_04_28.md": {ContentHash: "h1", FailCount: 8, LastFailAt: 1786674239, NextRetry: 1786695839,
			LastError: `本地萃取失敗：連不上你的知識庫：Post "https://` + host + `/portal/daemon/extract": dial tcp: lookup ` + host + `: no such host`},
		"assets/scan.pdf": {ContentHash: "h2", FailCount: 8, NextRetry: 1, LastError: "本地萃取失敗：轉檔失敗（assets/scan.pdf）：檔案裡沒有可抽取的文字"},
	}}
	now := time.Date(2026, 9, 16, 18, 0, 0, 0, time.Local).Unix()
	if !m.ShouldRetry("journals/2026_04_28.md", now, false) {
		t.Fatal("斷網被記滿 8 次的檔，網路好了要自己再試，不必按「立刻同步」")
	}
	if m.ShouldRetry("assets/scan.pdf", now, false) {
		t.Fatal("檔案本身的問題（讀不出文字）照舊暫停")
	}
	if m.HasOwnFailure("journals/2026_04_28.md") {
		t.Fatal("斷網不算這個檔的前科")
	}
	if p := m.Progress(); p.Pending != 1 || p.Stuck != 1 {
		t.Fatalf("斷網那份算排隊中、讀不出字那份算卡住：%+v", p)
	}
	m.MarkNetworkUnavailable("journals/2026_04_28.md", now, "dial tcp: lookup x: no such host")
	e := m.Entries["journals/2026_04_28.md"]
	if e.FailCount != 8 || m.ShouldRetry("journals/2026_04_28.md", now+30, false) || !m.ShouldRetry("journals/2026_04_28.md", now+61, false) {
		t.Fatalf("斷網要短暫等待（60 秒）而且不加次數：%+v", e)
	}
	if r := retrySkipReason(m, "journals/2026_04_28.md", now+30); !explainsWhySkipped(r) {
		t.Fatalf("等待中的訊息要講得出原因：%q", r)
	}
	// 從沒失敗過的新檔第一次就撞上斷網，同樣要等那 60 秒（不准每輪空轉重轉檔）。
	m.Entries["new.md"] = &ManifestEntry{ContentHash: "h3"}
	m.MarkNetworkUnavailable("new.md", now, "dial tcp: lookup x: no such host")
	if m.ShouldRetry("new.md", now+5, false) || !m.ShouldRetry("new.md", now+61, false) {
		t.Fatalf("新檔斷網後要等 60 秒再試：%+v", m.Entries["new.md"])
	}
	m.MarkFailed("journals/2026_04_28.md", now+61, "雲端萃取失敗（HTTP 500）")
	if e.FailCount != 1 {
		t.Fatalf("斷網留下的次數不該算進真的失敗：FailCount=%d", e.FailCount)
	}
}

// 端到端：知識庫連不上（本機沒連出去）的那段時間，檔案不被記失敗、斷路器不跳；
// 連線恢復後不按任何按鈕，下一輪就自己送上去。空白檔不送、不算失敗。
func TestDirect201_OfflineThenBackOnline(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	withCloudCheckInterval(t, 0)

	root := t.TempDir()
	writeFile(t, root, "筆記.md", "# 筆記\n\n內容", baseTime)
	writeFile(t, root, "journals/2026_05_07.md", "", baseTime)

	var mu sync.Mutex
	extracts, cards := 0, map[string]bool{}
	emptyTextSent := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			var req struct {
				PageName string `json:"page_name"`
				Text     string `json:"text"`
			}
			_ = json.Unmarshal(body, &req)
			if strings.TrimSpace(req.Text) == "" {
				if req.PageName != "" {
					emptyTextSent = true
				}
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"success":false,"error":"page_name 與 text 必填"}`))
				return
			}
			extracts++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture(req.PageName, "測試")})
		case strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger"):
			var req struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(body, &req)
			cards[req.Path] = true
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	})

	// 先占一個埠再關掉：斷線期間那個位址「連線被拒」（本機層），之後在同一個位址開伺服器。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	start := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	var clockMu sync.Mutex
	clock := start
	setClock := func(c time.Time) { clockMu.Lock(); clock = c; clockMu.Unlock() }
	oldNow := directNow
	directNow = func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return clock }
	defer func() { directNow = oldNow }()

	cfg := &DirectConfig{
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		Extractor: "workers-ai", ExtractorExplicit: true,
		MachineLabel: "測試機",
		MaxRemoved:   DefaultMaxRemovedRatio,
		Accounts: []AccountConfig{{
			CypherURL: "http://" + addr, Namespace: "demo", APIKey: "demo", InstanceName: "我的知識庫",
			WatchFolders: []string{root},
		}},
	}
	var offline []DirectResult
	for i := 0; i < 30; i++ {
		setClock(start.Add(time.Duration(i*5) * time.Second))
		offline, _, _ = RunDirectOnce(cfg, false)
	}
	acc := cfg.makeAccountSubConfig(cfg.Accounts[0])
	m, err := LoadManifest(acc.manifestPathFor(root), root)
	if err != nil {
		t.Fatal(err)
	}
	if e := m.Entries["筆記.md"]; e == nil || e.FailCount != 0 {
		t.Fatalf("斷線期間不准把這份記成失敗：%+v", e)
	}
	if n := cloudRoutes.note(workersAIExtractURL(acc.CypherURL), directNow()); n != "" {
		t.Fatalf("斷線 30 輪，斷路器不該跳：%q", n)
	}
	saw := false
	for _, r := range offline {
		if r.At == "" {
			t.Fatalf("每一筆結果都要帶時間：%+v", r)
		}
		if r.Path == "筆記.md" && (strings.Contains(r.Error, "我的知識庫") || strings.Contains(r.Error, "沒連上網路")) && explainsWhySkipped(r.Error) {
			saw = true
		}
	}
	if !saw {
		t.Fatalf("斷線時要講得出是哪台知識庫、為什麼沒送：%+v", offline)
	}

	ln2, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("無法重新綁定同一個埠（%v），略過恢復段", err)
	}
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(ln2) }()
	defer srv.Close()
	for i := 0; i < 3; i++ {
		setClock(start.Add(3*time.Minute + time.Duration(i*5)*time.Second))
		RunDirectOnce(cfg, false)
	}
	mu.Lock()
	defer mu.Unlock()
	if !cards["筆記.md"] {
		t.Fatalf("網路恢復後沒按按鈕，這份應該自己送上去（萃取 %d 次，送卡 %v）", extracts, cards)
	}
	if emptyTextSent {
		t.Fatal("空白檔不准再送去雲端（會拿到 400 被記成失敗）")
	}
	m, _ = LoadManifest(acc.manifestPathFor(root), root)
	if p := m.Progress(); p.Stuck != 0 || p.Done != p.Total {
		t.Fatalf("恢復後兩份都要算完成（空白檔＝沒有內容可整理）：%+v", p)
	}
}

// 0.18.54 實機第一輪抓到的：舊版把空白日記送上雲端、被 400 退回、記滿 8 次暫停——
// 這批**舊病歷**也要被重新判成「空白略過」，不能繼續掛著「連續失敗 8 次」。
// 同一輪：舊病歷寫「雲端沒有綁定 Workers AI」（當時雲端是舊版）的檔，雲端更新後要自己再試。
func TestDirect201_LegacyPausedEmptyAndOldCloudRecover(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	withCloudCheckInterval(t, 0)

	root := t.TempDir()
	writeFile(t, root, "journals/2024_11_24.md", "", baseTime)
	writeFile(t, root, "journals/2026_07_15.md", "# 七月\n\n一些內容", baseTime)

	var mu sync.Mutex
	cards := map[string]bool{}
	srv := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		var req struct {
			PageName string `json:"page_name"`
			Text     string `json:"text"`
			Path     string `json:"path"`
		}
		_ = json.Unmarshal(body, &req)
		switch {
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			if strings.TrimSpace(req.Text) == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture(req.PageName, "測試")})
		case strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger"):
			cards[req.Path] = true
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	})}
	// 先占一個位址再關掉：第一輪連不上（只為了建出帳本），之後在同一個位址開伺服器。
	ln0, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln0.Addr().String()
	_ = ln0.Close()

	clock := time.Date(2026, 9, 16, 15, 0, 0, 0, time.UTC)
	oldNow := directNow
	directNow = func() time.Time { return clock }
	defer func() { directNow = oldNow }()

	cfg := &DirectConfig{
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		Extractor: "workers-ai", ExtractorExplicit: true, MachineLabel: "測試機",
		MaxRemoved: DefaultMaxRemovedRatio,
		Accounts: []AccountConfig{{CypherURL: "http://" + addr, Namespace: "demo", APIKey: "demo",
			InstanceName: "我的知識庫", WatchFolders: []string{root}}},
	}
	RunDirectOnce(cfg, false) // 連不上的一輪：只為了建出帳本
	acc := cfg.makeAccountSubConfig(cfg.Accounts[0])
	mp := acc.manifestPathFor(root)
	m, err := LoadManifest(mp, root)
	if err != nil {
		t.Fatal(err)
	}
	past := clock.Add(-30 * 24 * time.Hour).Unix()
	for path, why := range map[string]string{
		"journals/2024_11_24.md": "本地萃取失敗：雲端萃取失敗（HTTP 400）：page_name 與 text 必填",
		"journals/2026_07_15.md": "本地萃取失敗：雲端萃取失敗（HTTP 501）：這個部署沒有綁定 Workers AI（wrangler.toml 需有 [ai] binding），請更新知識庫版本",
	} {
		e := m.Entries[path]
		if e == nil {
			t.Fatalf("帳本裡沒有 %s", path)
		}
		// 還原成「舊版留下的樣子」：沒送成、記滿 8 次暫停
		e.IngestedHash, e.IngestedAt, e.NoCloudCard = "", 0, false
		e.FailCount, e.LastFailAt, e.NextRetry, e.LastError = 8, past, past+6*3600, why
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("無法重新綁定同一個埠（%v）", err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	if m2, _ := LoadManifest(mp, root); m2.Progress().Stuck != 2 {
		t.Fatalf("前置條件：兩份都該是卡住：%+v", m2.Progress())
	}

	results, _, _ := RunDirectOnce(cfg, false)
	m, _ = LoadManifest(mp, root)
	var emptyNote string
	for _, r := range results {
		if r.Path == "journals/2024_11_24.md" {
			emptyNote = r.Error
		}
	}
	if !strings.Contains(emptyNote, "空白檔案") {
		t.Fatalf("舊病歷的空白日記要被重新判成空白略過，拿到：%q", emptyNote)
	}
	mu.Lock()
	defer mu.Unlock()
	if !cards["journals/2026_07_15.md"] {
		t.Fatalf("雲端更新後，「沒有綁定 Workers AI」那份要自己再試並送上去：%v", cards)
	}
	if p := m.Progress(); p.Stuck != 0 || p.Done != p.Total {
		t.Fatalf("兩份都要算完成：%+v", p)
	}
}
