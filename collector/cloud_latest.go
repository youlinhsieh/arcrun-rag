// cloud_latest.go — t215（2026-08-08）「每個知識庫要不要更新」的全域比較基準。
//
// leo 原話：「在每個知識庫上顯示是否要更新，如果要，加開啓 install 頁的連結」。
// 一個使用者可能連著不只一個雲端知識庫（帳號），每個帳號各自的雲端版本可能不同步——
// 之前只有 t150 那套「小幫手自己」的更新提示，雲端側完全沒有對應的畫面。
//
// 🔴 判準**必須跟 portal 設定頁那張版本卡一致**（不能自己另立一套，見驗收要求）：
// `console-ui/public/portal/index.html` 的 `loadVersion()` 拿自己的 `bundle_version`
// （cypher `/health`）比對 `install.arcrun.dev/api/latest` 的 `release` 欄位，
// 用逐段整數比較（不是字串比較），非 semver 格式一律視為落後。
// 這裡原樣照抄同一個比法與同一個資料源，**不是**沿用 cloud_version.go 的
// `cloudVersionStale`——那支比的是 `minCloudRelease`（協定相容底線，「太舊會壞掉」），
// 跟這裡要回答的「有沒有更新版可以裝」是兩個不同的問題，兩把尺不能混用，
// 否則同一個知識庫會在小幫手與 portal 兩處得到相反答案。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const installLatestURL = "https://install.arcrun.dev/api/latest"

// latestCacheTTL：install.arcrun.dev 自己在 CF edge 快取 5 分鐘（landing/worker.js
// 同一顆端點的既有用法），daemon 端沒必要比它更頻繁去打；同步輪詢間隔常常只有十幾秒，
// 若不節流，每個帳號每輪都會外打一次全域端點＝不必要的高頻請求。30 分鐘一輪已經足夠
// 讓使用者在「新版剛發佈」後半小時內看到提示。
const latestCacheTTL = 30 * time.Minute

var (
	latestMu       sync.Mutex
	latestCached   string
	latestCachedOK bool
	latestFetched  time.Time
)

// fetchLatestCloudReleaseRaw 可在測試中替換為 stub（同 fetchCloudVersion 慣例）。
var fetchLatestCloudReleaseRaw = func() (string, bool) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(installLatestURL)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var payload struct {
		Release string `json:"release"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&payload); err != nil {
		return "", false
	}
	if strings.TrimSpace(payload.Release) == "" {
		return "", false
	}
	return payload.Release, true
}

// FetchLatestCloudRelease 回傳目前已知的「雲端最新版」，內建節流（見 latestCacheTTL）。
// 節流窗內回快取值（含失敗快取＝ok=false）；窗口過了才真的重打一次。
// 這是**全域單一值**（不分帳號）——所有知識庫比的是同一個「目前最新版是什麼」。
func FetchLatestCloudRelease() (release string, ok bool) {
	latestMu.Lock()
	if time.Since(latestFetched) < latestCacheTTL {
		release, ok = latestCached, latestCachedOK
		latestMu.Unlock()
		return
	}
	latestMu.Unlock()

	release, ok = fetchLatestCloudReleaseRaw()

	latestMu.Lock()
	latestCached, latestCachedOK, latestFetched = release, ok, time.Now()
	latestMu.Unlock()
	return
}

// CloudUpdateStatus 是「這個知識庫要不要更新」的判定結果。
// Known=false 時前端要照實講「查不到」，不能當成「已是最新」——
// 靜默把「不知道」呈現成「一切正常」正是 cloud_version.go 開頭記過的那個坑。
type CloudUpdateStatus struct {
	Known       bool   // 兩邊版本都拿得到才能下判斷
	NeedsUpdate bool   // Known 且落後
	Mine        string // 這個帳號目前的 bundle_version（可能是空字串或舊格式）
	Latest      string // 已知的最新版（可能是空字串＝暫時查不到）
}

// EvalCloudUpdate 比較單一帳號的 bundle_version 與全域最新版。
// 與 portal 版本卡 loadVersion() 的 cmpSemver 同一套邏輯：
//   - mine 拿不到、或 latest 拿不到 → Known=false（誠實說「查不到」）
//   - mine 不是 semver 格式（老實例的 YYYY-MM-DD+sha）→ 一律當落後
//     （新版才會寫 semver 進來，portal 端註解原話同此）
//   - 兩邊都是 semver → 逐段整數比較，mine < latest 才算落後
func EvalCloudUpdate(mine string, mineOK bool, latest string, latestOK bool) CloudUpdateStatus {
	mine = strings.TrimSpace(mine)
	latest = strings.TrimSpace(latest)
	if !mineOK || mine == "" || !latestOK || latest == "" {
		return CloudUpdateStatus{Known: false, Mine: mine, Latest: latest}
	}
	behind := !isSemverLike(mine) || compareSemver(mine, latest) < 0
	return CloudUpdateStatus{Known: true, NeedsUpdate: behind, Mine: mine, Latest: latest}
}
