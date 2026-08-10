// cloud_version_test.go — t103 雲端版本判定函式 4 案單元測試。
package collector

import (
	"os"
	"testing"
)

// TestMain 在所有測試執行前把 fetchCloudVersion 換成 stub（回 ("", false)），
// 避免各測試的假 httptest.Server 或離線環境因真實 /health 呼叫炸掉測試。
// TestCloudVersionStale 直接測 cloudVersionStale 邏輯，不受此 stub 影響。
func TestMain(m *testing.M) {
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	// t215：同一個理由——避免 EvalCloudUpdate 相關測試因為真的打了
	// install.arcrun.dev 而變成看網路臉色的測試。
	fetchLatestCloudReleaseRaw = func() (string, bool) { return "", false }
	os.Exit(m.Run())
}

// TestCloudVersionStale 驗證四種判定情境：空版本/過舊/正常/解析失敗。
func TestCloudVersionStale(t *testing.T) {
	cases := []struct {
		name      string
		version   string
		checkOK   bool
		wantStale bool
	}{
		{
			// 老實例：/health 可達但 bundle_version 為空字串 → 需要更新
			name: "空版本（老實例）", version: "", checkOK: true, wantStale: true,
		},
		{
			// 日期早於 minCloudBuilt → 需要更新
			name: "過舊日期", version: "2026-07-27+abc1234", checkOK: true, wantStale: true,
		},
		{
			// 日期等於 minCloudBuilt → 正常（剛好達標）
			name: "正常（剛好達標）", version: "2026-07-28+abc1234", checkOK: true, wantStale: false,
		},
		{
			// /health 不可達（解析失敗/逾時）→ 靜默不判定
			name: "解析失敗（/health 不可達）", version: "", checkOK: false, wantStale: false,
		},

		// 🔴 2026-08-02 迴歸守衛（leo 實撞：兩帳號都更新到 1.4.1，卻**都**顯示需要更新且消不掉）。
		// 病根：舊實作 `head < minCloudBuilt` 是**字串比較**，semver 進來後
		//       "1.4.1" < "2026-07-28" 恆為真 ⇒ 最新版被判過舊。
		// 這幾則若變紅，代表版本比較又退回字串比較，或新格式沒被辨識。
		{
			name: "semver 最新版（1.4.1）不該被判過舊", version: "1.4.1", checkOK: true, wantStale: false,
		},
		{
			name: "semver 剛好達標（1.4.0）", version: "1.4.0", checkOK: true, wantStale: false,
		},
		{
			name: "semver 過舊（1.3.9）需要更新", version: "1.3.9", checkOK: true, wantStale: true,
		},
		{
			// 字串比較會誤判成 "1.10.0" < "1.9.0"；整數逐段比較才對
			name: "semver 1.10.0 比 1.9.0 新（防字串比較）", version: "1.10.0", checkOK: true, wantStale: false,
		},
		{
			// 舊格式仍須正確辨識——兩種格式並存期間，老實例不可被誤判成最新而收不到提示
			name: "舊格式過舊仍要判過舊（相容）", version: "2026-07-01+deadbee", checkOK: true, wantStale: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cloudVersionStale(tc.version, tc.checkOK)
			if got != tc.wantStale {
				t.Errorf("cloudVersionStale(%q, %v) = %v，want %v", tc.version, tc.checkOK, got, tc.wantStale)
			}
		})
	}
}
