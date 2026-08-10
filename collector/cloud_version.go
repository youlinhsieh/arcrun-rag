// cloud_version.go — t103 daemon 雲端版本偵測。
// 每輪 GET {cypher_url}/health 取 bundle_version，比對最低相容日期，
// 過舊時 status.json 記錄，托盤顯示更新入口。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// minCloudBuilt 是**舊格式**（YYYY-MM-DD+sha）的雲端最低相容建置日期。
// 2026-08-02 起雲端版本號改為 semver（1.4.2），改由 minCloudRelease 判斷；
// 本常數只用於尚未更新到 semver 世代的老實例。
const minCloudBuilt = "2026-07-28"

// minCloudRelease 是 semver 世代的雲端最低相容版本。
// 雲端契約變更時升此常數；daemon 下一輪自動偵測並提示更新。
const minCloudRelease = "1.4.0"

// isSemverLike 判斷版本字串是不是 semver 形態（開頭是數字且含 '.'，且不是 YYYY-MM-DD）。
// 舊格式 "2026-07-31+8e83589" 開頭也是數字，但用 '-' 不用 '.'，故以第一個分隔符區分。
func isSemverLike(v string) bool {
	if v == "" {
		return false
	}
	if v[0] < '0' || v[0] > '9' {
		return false
	}
	dot := strings.Index(v, ".")
	dash := strings.Index(v, "-")
	if dot < 0 {
		return false
	}
	return dash < 0 || dot < dash
}

// compareSemver 比較 a、b 兩個 semver（如 "1.4.2"）。回 -1／0／1。
// 逐段以「整數」比較——**不可用字串比較**，否則 "1.10.0" < "1.9.0"。
func compareSemver(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(as) {
			ai, _ = strconv.Atoi(strings.TrimSpace(as[i]))
		}
		if i < len(bs) {
			bi, _ = strconv.Atoi(strings.TrimSpace(bs[i]))
		}
		if ai != bi {
			if ai < bi {
				return -1
			}
			return 1
		}
	}
	return 0
}

// fetchCloudVersion 可在測試中替換為 stub，避免真實網路呼叫拖慢測試。
var fetchCloudVersion = fetchBundleVersion

// fetchBundleVersion GET {cypherURL}/health 取 bundle_version。
// 5s timeout；失敗（逾時、連不上、非 JSON）靜默回 ("", false)——呼叫端不判定過舊。
func fetchBundleVersion(cypherURL string) (version string, ok bool) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(strings.TrimSuffix(cypherURL, "/") + "/health")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var payload struct {
		BundleVersion string `json:"bundle_version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&payload); err != nil {
		return "", false
	}
	return payload.BundleVersion, true
}

// cloudVersionStale 判斷雲端是否需要更新。
// checkOK=false（/health 不可達）回 false（靜默不判定）——**呼叫端要自己顯示「查不到」**，
// 別把「連不上」呈現成「一切正常」（2026-08-02 記：這個預設會讓壞掉的機器安靜無聲）。
//
// 🔴 2026-08-02 修（leo 實撞：兩個帳號都更新到最新，卻**都**顯示「知識庫需要更新」且消不掉）：
//
//	原本一律 `version.split("+")[0] < minCloudBuilt`，看似日期比較，**實為字串比較**。
//	08-02 雲端版本號改為 semver（1.4.1）後：
//	    "1.4.1" < "2026-07-28"  → true（字元 '1' 排在 '2' 前）⇒ **恆為真**
//	⇒ 更新到最新版反而被判過舊，更新幾次都消不掉。
//	兩種格式並存期間（老實例仍是 YYYY-MM-DD+sha），**必須兩種都認**，
//	否則老實例會被誤判成最新而收不到更新提示。
func cloudVersionStale(version string, checkOK bool) bool {
	if !checkOK {
		return false
	}
	if version == "" {
		return true
	}
	head := strings.SplitN(version, "+", 2)[0]
	if isSemverLike(head) {
		// semver 世代：逐段整數比較（不可字串比較，否則 1.10.0 < 1.9.0）
		return compareSemver(head, minCloudRelease) < 0
	}
	// 舊格式 YYYY-MM-DD+sha：日期字串等長、可安全字串比較
	return head < minCloudBuilt
}
