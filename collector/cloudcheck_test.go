// cloudcheck_test.go — 每輪固定問雲端的兩件事，一分鐘只真的問一次（inkstone/arcrun-rag#121）。
package collector

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// init：測試環境預設不快取——既有測試（例如「第一輪查得到版本、第二輪 DNS 抽風」）
// 是連續兩輪背靠背跑，模擬的是「每一輪都真的問過」。
// 需要驗證節流本身的測試（下方與 route_backoff_measure_test.go）自行 save/restore 成真值。
func init() {
	cloudCheckInterval = 0
}

func withCloudCheckInterval(t *testing.T, d time.Duration) {
	t.Helper()
	old := cloudCheckInterval
	cloudCheckInterval = d
	resetCloudChecks()
	t.Cleanup(func() {
		cloudCheckInterval = old
		resetCloudChecks()
	})
}

func withClock(t *testing.T, start time.Time) *atomic.Int64 {
	t.Helper()
	var ns atomic.Int64
	ns.Store(start.UnixNano())
	old := directNow
	directNow = func() time.Time { return time.Unix(0, ns.Load()).UTC() }
	t.Cleanup(func() { directNow = old })
	return &ns
}

func TestCloudVersion_AskedOncePerMinute(t *testing.T) {
	withCloudCheckInterval(t, 60*time.Second)
	t0 := time.Date(2026, 9, 13, 5, 0, 0, 0, time.UTC)
	clock := withClock(t, t0)

	var calls int
	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { calls++; return "1.4.60", true }
	defer func() { fetchCloudVersion = orig }()

	u := "https://a.workers.dev"
	for i := 0; i < 12; i++ { // 一分鐘內每 5 秒一輪
		clock.Store(t0.Add(time.Duration(i*5) * time.Second).UnixNano())
		if v, ok := cloudVersionThrottled(u, false); v != "1.4.60" || !ok {
			t.Fatalf("快取回的答案要與真問到的一樣：%q %v", v, ok)
		}
	}
	if calls != 1 {
		t.Fatalf("一分鐘內 12 輪應該只真的問 1 次，got %d", calls)
	}
	clock.Store(t0.Add(60 * time.Second).UnixNano())
	cloudVersionThrottled(u, false)
	if calls != 2 {
		t.Fatalf("滿一分鐘要重問，got %d", calls)
	}
	cloudVersionThrottled(u, true)
	if calls != 3 {
		t.Fatalf("按「立刻同步」的那一輪要照問，got %d", calls)
	}
	cloudVersionThrottled("https://b.workers.dev", false)
	if calls != 4 {
		t.Fatalf("不同知識庫各問各的，got %d", calls)
	}
}

func TestProbeWorkersAI_AskedOncePerMinute(t *testing.T) {
	withCloudCheckInterval(t, 60*time.Second)
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	t0 := time.Date(2026, 9, 13, 5, 0, 0, 0, time.UTC)
	clock := withClock(t, t0)

	var probes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/extract") {
			probes.Add(1)
			w.WriteHeader(http.StatusBadRequest) // 空 text 的探測：路由存在＝可用
		}
	}))
	defer srv.Close()

	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "k"}
	for i := 0; i < 12; i++ {
		clock.Store(t0.Add(time.Duration(i*5) * time.Second).UnixNano())
		if st := cfg.probeWorkersAI(); !st.Ready {
			t.Fatalf("第 %d 輪：探測結果要沿用「可用」，got %+v", i, st)
		}
	}
	if n := probes.Load(); n != 1 {
		t.Fatalf("一分鐘內 12 輪應該只探測 1 次，got %d", n)
	}
	clock.Store(t0.Add(61 * time.Second).UnixNano())
	cfg.probeWorkersAI()
	if n := probes.Load(); n != 2 {
		t.Fatalf("滿一分鐘要重新探測，got %d", n)
	}
}
