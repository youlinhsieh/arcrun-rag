// battery.go — 電池模型，小幫手這一半（inkstone/arcrun-rag#240 c18058，母票 inkstone/Arcrun#293 c18013）。
//
// leo 2026-10-07：「就像 battery life 一樣，電車快沒電時會警告、降速……不聲不響把你剎車要去找出
// 如何解除剎車非常糟糕。如果買了月租就是我裝上核能電池，就不用再跳出 n% 警告了」。
//
// 🔴 判準只在雲端（`cypher-executor/src/lib/battery.ts`），**小幫手不重算**：
// 雲端 `GET /portal/daemon/battery` 回的 `battery` 欄位原樣收下、逐帳號記，
// 畫面只負責畫。兩處各算一套，用量定義一改就漂（同 explainsWhySkipped 的教訓）。
//
// 狀態（與雲端同名）：nuclear／normal／warn20／saver／empty。
//   - nuclear：主人放行或關掉剎車 ⇒ 不顯示 %、不警告、不省電（小幫手也不降速）。
//   - saver／empty：省電——延後補送（雲端對帳與「原文位置」修正）、單輪少送、放慢節奏。
//
// 逐帳號各記各的：每一台雲端有自己的免費額度，A 帳號電量低不代表 B 帳號要省電。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 雲端 battery.state 的值。
const (
	BatteryNuclear = "nuclear"
	BatteryNormal  = "normal"
	BatteryWarn20  = "warn20"
	BatterySaver   = "saver"
	BatteryEmpty   = "empty"
)

// Battery＝雲端交來的電池狀態（欄位與 `lib/battery.ts` 的 Battery 一一對應）。
type Battery struct {
	State            string   `json:"state"`
	RemainingPercent *float64 `json:"remaining_percent"` // nuclear 時為 null——不顯示 n%
	Warn             bool     `json:"warn"`
	Saver            bool     `json:"saver"`
	Message          string   `json:"message,omitempty"`
	// Billing＝這台雲端的免費額度已用完、現在在計費（不限用量的帳號超出免費後）。畫面顯示「計費中」（#240 c18387）。
	Billing bool `json:"billing,omitempty"`
	ResetAt          string   `json:"reset_at,omitempty"`
	// Account＝這是哪一台雲端的電（instanceHostOf，與 AccountSyncStatus 同一把 key）。
	Account string `json:"account,omitempty"`
}

// batteryPath＝雲端給電池狀態的端點。
//
// 雲端 `GET /portal/daemon/battery`（inkstone/Arcrun#293 c18064，分支 arcrun-293-battery-apikey）
// 收小幫手身上的 `X-Arcrun-API-Key`，只回 `{success, battery}`、不開放放行／開關。
// 舊雲端沒有這支 ⇒ 404 ⇒ **電池狀態＝未知**：畫面不顯示 %、不省電，也不編一個數字。
const batteryPath = "/portal/daemon/battery"

// batteryTTL＝同一台多久才真的重問一次。電量是「今天累積」的量，分鐘級變化沒有意義；
// 而這一問在雲端要讀 3 個 KBDB 端點，省電時更不該自己多吃額度。
var batteryTTL = 5 * time.Minute

// fetchBattery 可在測試中替換。回 (nil, err)＝問不到。
var fetchBattery = fetchBatteryHTTP

func fetchBatteryHTTP(cypherURL, apiKey string) (*Battery, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimSuffix(cypherURL, "/")+batteryPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Arcrun-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return nil, &batteryHTTPError{Status: resp.StatusCode}
	}
	return parseBattery(body)
}

type batteryHTTPError struct{ Status int }

func (e *batteryHTTPError) Error() string {
	return "雲端用量狀態回 HTTP " + http.StatusText(e.Status)
}

// parseBattery 從 usage-brakes 的回應取出 `battery`。缺欄位（舊版雲端）或狀態不認得 ⇒ (nil, nil)：
// 認不出來就不編故事，畫面當作「這台沒有電池資訊」。
func parseBattery(body []byte) (*Battery, error) {
	var payload struct {
		Battery *Battery `json:"battery"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	b := payload.Battery
	if b == nil {
		return nil, nil
	}
	switch b.State {
	case BatteryNuclear, BatteryNormal, BatteryWarn20, BatterySaver, BatteryEmpty:
	default:
		return nil, nil
	}
	if b.State == BatteryNuclear {
		// 不限用量：不警告、不省電、不帶話——但**剩餘 % 照收**（#240 c18328，leo 2026-10-09）：
		// 「無限帳號也要看到免費用量」。雲端有給就畫（格數＋%＋∞），沒給（舊版雲端 null）就只有 ∞。
		// 以前這裡一併清掉 %，youlin（雲端回 43.8）因此只剩 ∞，與雲端當下說的不一致。
		b.Warn, b.Saver, b.Message = false, false, ""
	}
	return b, nil
}

// SavesPower＝這份電池狀態要不要讓小幫手省電（雲端 saver 旗標，或電量已空）。核能電池永遠 false。
func (b *Battery) SavesPower() bool {
	if b == nil || b.State == BatteryNuclear {
		return false
	}
	return b.Saver || b.State == BatterySaver || b.State == BatteryEmpty
}

type cachedBattery struct {
	at  time.Time
	val *Battery
}

var (
	batteryMu   sync.Mutex
	batterySeen = map[string]cachedBattery{}
)

func resetBatteries() {
	batteryMu.Lock()
	defer batteryMu.Unlock()
	batterySeen = map[string]cachedBattery{}
}

// batteryFor 回這台雲端的電池狀態（一律標上 account）。TTL 內沿用；問不到就沿用上一次的
// 好值（一次逾時不該讓警告消失又出現），從沒問到過就 nil＝未知。
func batteryFor(cypherURL, apiKey, account string, force bool) *Battery {
	key := cloudCheckKey(cypherURL)
	now := directNow()
	batteryMu.Lock()
	c, hit := batterySeen[key]
	batteryMu.Unlock()
	if hit && !force && now.Sub(c.at) < batteryTTL && !now.Before(c.at) {
		return withAccount(c.val, account)
	}
	b, err := fetchBattery(cypherURL, apiKey)
	if err != nil {
		// 問不到：保留舊值，但把「這一刻問過了」記下來，免得每一輪都重打一個壞掉的端點。
		batteryMu.Lock()
		batterySeen[key] = cachedBattery{at: now, val: c.val}
		batteryMu.Unlock()
		return withAccount(c.val, account)
	}
	batteryMu.Lock()
	batterySeen[key] = cachedBattery{at: now, val: b}
	batteryMu.Unlock()
	return withAccount(b, account)
}

func withAccount(b *Battery, account string) *Battery {
	if b == nil {
		return nil
	}
	cp := *b
	cp.Account = account
	return &cp
}

// 省電模式的節奏。
const saverMaxEventsPerRun = 5

// saverPaceInterval＝省電時兩次觸發雲端之間的最小間隔（正常是 directPaceInterval）。測試會歸零。
var saverPaceInterval = 3 * time.Second

// paceFor＝pace() 的省電版：省電模式放慢，否則照舊。
func paceFor(cfg *DirectConfig) {
	if cfg != nil && cfg.SaverMode && saverPaceInterval > 0 {
		time.Sleep(saverPaceInterval)
		return
	}
	pace()
}

// auditCloudLedgerUnlessSaving／repairSourceBlocksUnlessSaving：省電時整段略過（回 nil＝沒做、
// 也不留痕——它們是保險絲不是主流程，延後到電量恢復那一輪自然補上，不必另排「欠帳」）。
func auditCloudLedgerUnlessSaving(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) *auditResult {
	if cfg.SaverMode {
		return nil
	}
	return auditCloudLedger(cfg, absRoot, m, dryRun, now)
}

func repairSourceBlocksUnlessSaving(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) *sourceRepairResult {
	if cfg.SaverMode {
		return nil
	}
	return repairCardSourceBlocks(cfg, absRoot, m, dryRun, false, now)
}

// BatteryNow 立刻向雲端問一次（略過 TTL），給「使用者打開帳號頁／回到視窗」這類人為動作用——
// 不是輪詢：沒有人動手就不會呼叫。問不到時回上一次的好值（或 nil）。
func BatteryNow(cypherURL, apiKey, account string) *Battery {
	return batteryFor(cypherURL, apiKey, account, true)
}
