// routebackoff_236_test.go — `inkstone/arcrun-rag#236` 的驗收。
//
// 2026-09-29 leo21c：folder-tree 連吃 429 ⇒ 斷路器把該路關到 30 分鐘；雲端修好後小幫手仍連打都不打，
// Portal 橫條不消，直到 kill collector 才恢復。
package collector

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func trip236(b *routeBreaker, u string, t0 time.Time) {
	// 429 連撞到階梯最高一格（第 4 發起停，第 8 發起停 30 分鐘）
	for i := 0; i < routeStrikesBeforeBackoff+len(routeBackoffLadder)-1; i++ {
		b.record(u, t0, 429, nil, false)
	}
}

// 雲端版本變了（修好、部署了新版）⇒ 退避中的路立刻放行一發，不必等 30 分鐘。
func TestRouteBreaker236_VersionChangeReleasesImmediately(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	host := "arcrun-cypher-executor.kb-a.workers.dev"
	u := "https://" + host + "/portal/daemon/folder-tree"
	other := "https://other.workers.dev/portal/daemon/folder-tree"
	t0 := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	trip236(b, u, t0)
	trip236(b, other, t0)
	b.noteCloudHealthy(host, "1.4.79", t0) // 第一次看到版本：只是記下
	if b.note(u, t0.Add(time.Second)) == "" {
		t.Fatal("前置：路應該在退避中")
	}
	if n := b.noteCloudHealthy(host, "1.4.80", t0.Add(time.Minute)); n != 1 {
		t.Fatalf("版本變了應放行這台主機的 1 條路，got %d", n)
	}
	if b.note(u, t0.Add(time.Minute)) != "" {
		t.Fatal("放行後這條路應可以打")
	}
	if b.note(other, t0.Add(time.Minute)) == "" {
		t.Fatal("別台知識庫的路不該被牽連放行")
	}
}

// 版本沒變、/health 通：停滿 routeProbeAfter 才放行一發，且兩次放行至少隔 routeProbeEvery。
func TestRouteBreaker236_HealthyProbeIsPaced(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	host := "arcrun-cypher-executor.kb-a.workers.dev"
	u := "https://" + host + "/portal/daemon/folder-tree"
	t0 := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	trip236(b, u, t0)
	b.noteCloudHealthy(host, "1.4.80", t0)
	if n := b.noteCloudHealthy(host, "1.4.80", t0.Add(time.Minute)); n != 0 {
		t.Fatalf("才停 1 分鐘不該放行，got %d", n)
	}
	if n := b.noteCloudHealthy(host, "1.4.80", t0.Add(3*time.Minute)); n != 1 {
		t.Fatalf("停滿 2 分鐘且 /health 通，應放行 1 發，got %d", n)
	}
	// 那一發又失敗 ⇒ fails 保留、階梯往上，路重新關起來
	at := t0.Add(3 * time.Minute)
	b.record(u, at, 429, nil, false)
	if b.note(u, at) == "" {
		t.Fatal("試探失敗後應重新退避（保護不能被拆）")
	}
	if n := b.noteCloudHealthy(host, "1.4.80", at.Add(3*time.Minute)); n != 0 {
		t.Fatalf("距上次放行不到 5 分鐘不該再放行，got %d", n)
	}
	if n := b.noteCloudHealthy(host, "1.4.80", at.Add(6*time.Minute)); n != 1 {
		t.Fatalf("隔滿 5 分鐘可再放行，got %d", n)
	}
}

// 端到端：雲端先 429 讓斷路器開到最長 → 雲端改回正常且版本更新 → 不重開，下一發真的打出去並成功、路歸零。
func TestRouteBreaker236_EndToEndRecoversWithoutRestart(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	var healthy atomic.Bool
	var posts int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			return
		}
		atomic.AddInt64(&posts, 1)
		if !healthy.Load() {
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()
	now := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	origNow := directNow
	directNow = func() time.Time { return now }
	defer func() { directNow = origNow }()

	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k"}
	url := cfg.folderTreeURL()
	host := instanceHostOf(srv.URL)
	cloudRoutes.noteCloudHealthy(host, "1.4.79", now)
	for i := 0; i < routeStrikesBeforeBackoff+len(routeBackoffLadder)-1; i++ {
		now = now.Add(31 * time.Minute) // 每次都等窗口過期再撞，走完整個階梯
		_, _, _ = cfg.postJSON(stepIngestCard, url, map[string]any{})
	}
	if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); !isRouteBackoff(err) {
		t.Fatalf("前置：階梯走滿後應在退避，got %v", err)
	}
	before := atomic.LoadInt64(&posts)

	healthy.Store(true) // 雲端修好
	now = now.Add(time.Minute)
	cloudRoutes.noteCloudHealthy(host, "1.4.80", now)
	if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); err != nil {
		t.Fatalf("雲端恢復後不重開小幫手也該送得出去，got %v", err)
	}
	if atomic.LoadInt64(&posts) != before+1 {
		t.Fatal("應真的打出 1 發")
	}
	if n := cloudRoutes.note(url, now); n != "" {
		t.Fatalf("成功後整條路應歸零，got %q", n)
	}
}
