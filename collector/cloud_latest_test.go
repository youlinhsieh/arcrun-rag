// cloud_latest_test.go — t215 單元測試：EvalCloudUpdate 的判準要跟 portal 版本卡一致。
package collector

import "testing"

func TestEvalCloudUpdate(t *testing.T) {
	cases := []struct {
		name       string
		mine       string
		mineOK     bool
		latest     string
		latestOK   bool
		wantKnown  bool
		wantUpdate bool
	}{
		{
			name: "兩邊都拿得到、mine 落後", mine: "1.4.1", mineOK: true, latest: "1.4.2", latestOK: true,
			wantKnown: true, wantUpdate: true,
		},
		{
			name: "兩邊都拿得到、已是最新", mine: "1.4.2", mineOK: true, latest: "1.4.2", latestOK: true,
			wantKnown: true, wantUpdate: false,
		},
		{
			// 字串比較會誤判 "1.10.0" < "1.9.0"；逐段整數比較才對（同 t103 迴歸守衛）。
			name: "1.10.0 比 1.9.0 新，不該判落後", mine: "1.10.0", mineOK: true, latest: "1.9.0", latestOK: true,
			wantKnown: true, wantUpdate: false,
		},
		{
			// 老格式（YYYY-MM-DD+sha）——portal 版本卡註解原話：「這種情況一律當成落後」。
			name: "老格式版本一律當落後", mine: "2026-07-31+8e83589", mineOK: true, latest: "1.4.2", latestOK: true,
			wantKnown: true, wantUpdate: true,
		},
		{
			name: "連不上這個知識庫（mineOK=false）→ 查不到，不能裝沒事", mine: "", mineOK: false, latest: "1.4.2", latestOK: true,
			wantKnown: false, wantUpdate: false,
		},
		{
			name: "查得到 mine 但暫時查不到最新版 → 查不到，不是已最新", mine: "1.4.2", mineOK: true, latest: "", latestOK: false,
			wantKnown: false, wantUpdate: false,
		},
		{
			name: "/health 可達但 bundle_version 空字串（老實例）→ 查不到", mine: "", mineOK: true, latest: "1.4.2", latestOK: true,
			wantKnown: false, wantUpdate: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EvalCloudUpdate(tc.mine, tc.mineOK, tc.latest, tc.latestOK)
			if got.Known != tc.wantKnown {
				t.Errorf("Known = %v，want %v", got.Known, tc.wantKnown)
			}
			if got.NeedsUpdate != tc.wantUpdate {
				t.Errorf("NeedsUpdate = %v，want %v", got.NeedsUpdate, tc.wantUpdate)
			}
		})
	}
}

// TestFetchLatestCloudReleaseThrottle 驗證節流：窗口內第二次呼叫不重打 fetchLatestCloudReleaseRaw。
func TestFetchLatestCloudReleaseThrottle(t *testing.T) {
	calls := 0
	orig := fetchLatestCloudReleaseRaw
	defer func() {
		fetchLatestCloudReleaseRaw = orig
		latestMu.Lock()
		latestCached, latestCachedOK, latestFetched = "", false, latestFetched.Add(-2*latestCacheTTL)
		latestMu.Unlock()
	}()
	fetchLatestCloudReleaseRaw = func() (string, bool) { calls++; return "1.4.2", true }
	// 強制第一次一定重打（避開其他測試留下的快取）。
	latestMu.Lock()
	latestFetched = latestFetched.Add(-2 * latestCacheTTL)
	latestMu.Unlock()

	r1, ok1 := FetchLatestCloudRelease()
	r2, ok2 := FetchLatestCloudRelease()
	if calls != 1 {
		t.Errorf("節流窗口內第二次呼叫不該重打，calls = %d", calls)
	}
	if r1 != "1.4.2" || !ok1 || r2 != "1.4.2" || !ok2 {
		t.Errorf("兩次結果應相同，got (%q,%v) (%q,%v)", r1, ok1, r2, ok2)
	}
}
