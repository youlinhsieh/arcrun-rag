// usage.go — 用量分頁的資料：離「爆」或「開始收費」還多遠（inkstone/arcrun-rag#246 第二階段）。
//
// 設計依據：#246 c18630（設計）＋c18631（總管裁示）＋c18638（每行樣式）＋c18642（三級精密度）。
//
// 🔴 分工（c18630「CF GraphQL 管顯示，時速表只管剎車」）：
//   - 數字來自雲端 `GET /portal/daemon/usage`——那一端讀 Cloudflare 自己的分析數字
//     （D1 讀寫、Workers AI、Vectorize、Workers…），所以小幫手身上不放任何 CF 金鑰。
//   - 小幫手只做「用量 ÷ 線」與三態：線（內含量）與單價由雲端隨數字一起交來，
//     不在這裡寫死第二份價目表（價目一改就漂，同 battery.go 的教訓）。
//   - 舊雲端沒有這支端點 ⇒ 404 ⇒ nil ⇒ 畫面誠實說「查不到」，不編一個數字。
//
// 雲端交來的形狀（usage 欄位；金額單位 US$）：
//
//	{"success":true,"usage":{
//	   "plan":"free|paid|local", "base_usd":5, "fetched_at":"RFC3339", "delay_sec":120,
//	   "brake":{"on":true,"covers":["d1_write","d1_read"]},
//	   "items":[{"key":"ai","used":62205,"limit":10000,"period":"day",
//	             "reset_at":"RFC3339","rate_per_min":217,"unit_usd":0.000011}]}}
//
// limit 為 null＝這一項沒有線（地端自行計量的量）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// 計費項的 key（雲端與小幫手共用；畫面上固定的先後順序也以此為準——儀表靠位置判讀）。
const (
	UsageAI       = "ai"        // Workers AI（萃取＋嵌入）neurons
	UsageVecStore = "vec_store" // Vectorize 儲存維度
	UsageVecQuery = "vec_query" // Vectorize 查詢維度
	UsageD1Write  = "d1_write"  // D1 寫入列數
	UsageD1Read   = "d1_read"   // D1 讀取列數
	UsageCPU      = "cpu"       // Workers CPU
	UsageRequests = "requests"  // Workers 請求數
	UsageDisk     = "disk"      // 地端：磁碟
)

// UsageOrder＝畫面固定的先後（位置就是意義）。不在這裡的 key 排在最後，依雲端給的順序。
var UsageOrder = []string{UsageAI, UsageVecStore, UsageVecQuery, UsageD1Write, UsageD1Read, UsageCPU, UsageRequests, UsageDisk}

const (
	UsagePlanFree  = "free"
	UsagePlanPaid  = "paid"
	UsagePlanLocal = "local"
)

type UsageItem struct {
	Key        string   `json:"key"`
	Used       float64  `json:"used"`
	Limit      *float64 `json:"limit"`
	Period     string   `json:"period"` // day | month
	ResetAt    string   `json:"reset_at,omitempty"`
	RatePerMin float64  `json:"rate_per_min,omitempty"`
	UnitUSD    float64  `json:"unit_usd,omitempty"` // 超出線之後每單位的費用（付費帳號）
	// CostUSD＝本月到目前為止這一項的超出費用（雲端用逐日資料算；每天一條線的項目，月費用不是今天超出量×單價）。
	// 雲端沒交就由小幫手用「今天超出量×單價」估。
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

type UsageBrake struct {
	On     bool     `json:"on"`
	Covers []string `json:"covers,omitempty"`
}

// Usage＝雲端交來的用量快照。
type Usage struct {
	Plan      string      `json:"plan"`
	BaseUSD   float64     `json:"base_usd,omitempty"`
	FetchedAt string      `json:"fetched_at,omitempty"`
	DelaySec  int         `json:"delay_sec,omitempty"`
	Brake     *UsageBrake `json:"brake,omitempty"`
	Items     []UsageItem `json:"items"`
	// Received＝小幫手收到的時刻（本機時鐘）。畫面往前推數字用它，不用雲端的時間，免得兩台時鐘差一點就亂跳。
	Received time.Time `json:"-"`
	Account  string    `json:"account,omitempty"`
}

const usagePath = "/portal/daemon/usage"

// fetchUsage 可在測試中替換。
var fetchUsage = fetchUsageHTTP

func fetchUsageHTTP(cypherURL, apiKey string) (*Usage, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimSuffix(cypherURL, "/")+usagePath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Arcrun-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return nil, &batteryHTTPError{Status: resp.StatusCode}
	}
	return parseUsage(body)
}

// parseUsage：缺 usage 欄位（舊雲端）、方案認不得 ⇒ (nil, nil)，不編故事。
func parseUsage(body []byte) (*Usage, error) {
	var payload struct {
		Usage *Usage `json:"usage"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	u := payload.Usage
	if u == nil {
		return nil, nil
	}
	switch u.Plan {
	case UsagePlanFree, UsagePlanPaid, UsagePlanLocal:
	default:
		return nil, nil
	}
	u.Received = directNow()
	SortUsageItems(u.Items)
	return u, nil
}

var (
	usageMu   sync.Mutex
	usageSeen = map[string]*Usage{}
)

// UsageNow 立刻向雲端問一次，給人為動作（開啟／切到用量分頁／視窗回到前景／分頁開著時每分鐘）用。
// 問不到時回上一次的好值（或 nil）。
func UsageNow(cypherURL, apiKey, account string) *Usage {
	key := cloudCheckKey(cypherURL)
	u, err := fetchUsage(cypherURL, apiKey)
	usageMu.Lock()
	defer usageMu.Unlock()
	if err != nil || u == nil {
		if prev := usageSeen[key]; prev != nil && err != nil {
			cp := *prev
			cp.Account = account
			return &cp
		}
		if u == nil && err == nil {
			delete(usageSeen, key) // 舊雲端：不沿用過期的好值
		}
		return nil
	}
	u.Account = account
	usageSeen[key] = u
	cp := *u
	return &cp
}

// SortUsageItems 把計費項排成固定順序：位置就是意義（c18642）。穩定排序，未知 key 排後面。
func SortUsageItems(items []UsageItem) {
	rank := func(k string) int {
		for i, x := range UsageOrder {
			if x == k {
				return i
			}
		}
		return len(UsageOrder)
	}
	sort.SliceStable(items, func(i, j int) bool { return rank(items[i].Key) < rank(items[j].Key) })
}
