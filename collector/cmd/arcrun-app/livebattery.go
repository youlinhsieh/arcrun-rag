package main

// livebattery.go — 側欄的用量要跟雲端「當下」一致（inkstone/arcrun-rag#240 c18328）
//
// 病：用量原本只來自 collector 每輪寫進 status.json 的那一份。使用者在 Portal 按了放行，
// 小幫手要等下一輪同步（還有 5 分鐘 TTL）才會變，畫面上還掛著舊的 3%。
//
// 做法：使用者打開小幫手／切到某個帳號頁／回到視窗時，前端呼叫 RefreshUsage，
// 這裡立刻問那台雲端一次，結果放在記憶體，GetState 優先用它（15 分鐘內）。
// 🔴 不是輪詢：沒有人動手就不會問；GetState 本身仍然只讀檔。
// 問不到就維持原樣（舊值不消失、也不編數字）；舊版雲端不回 % 時，不限用量的帳號只畫 ∞。

import (
	"sync"
	"time"

	"arcrun-rag/collector"
)

type liveBat struct {
	at time.Time
	b  *collector.Battery
}

var (
	liveBatMu sync.Mutex
	liveBats  = map[string]liveBat{}
)

const liveBatFresh = 15 * time.Minute

func setLiveBattery(host string, b *collector.Battery) {
	liveBatMu.Lock()
	defer liveBatMu.Unlock()
	liveBats[host] = liveBat{at: time.Now(), b: b}
}

// liveBatteryFor 回 host 這台最近問到的電池（15 分鐘內）；沒有就 nil。
func liveBatteryFor(host string) *collector.Battery {
	liveBatMu.Lock()
	defer liveBatMu.Unlock()
	if v, ok := liveBats[host]; ok && v.b != nil && time.Since(v.at) < liveBatFresh {
		return v.b
	}
	return nil
}

// refreshLiveBattery 問一台雲端。拿不到（nil）就不覆蓋。
func refreshLiveBattery(acc accountCfg) {
	if acc.APIKey == "" || acc.CypherURL == "" {
		return
	}
	host := shortHost(acc.CypherURL)
	if b := collector.BatteryNow(acc.CypherURL, acc.APIKey, host); b != nil {
		setLiveBattery(host, b)
	}
	if v, ok := collector.CloudVersionNow(acc.CypherURL); ok && v != "" {
		setLiveVersion(host, v)
	}
}

// RefreshUsage 給前端在人為動作時呼叫：accIdx<0＝全部帳號，否則只問那一個。回傳後前端再取一次 GetState。
func (a *App) RefreshUsage(accIdx int) {
	cfg, _ := loadCfg()
	if cfg == nil {
		return
	}
	for i, acc := range cfg.Accounts {
		if accIdx < 0 || i == accIdx {
			refreshLiveBattery(acc)
		}
	}
}

// 雲端版本（同樣只在人為動作時問、記在記憶體）
type liveVer struct {
	at time.Time
	v  string
}

var liveVers = map[string]liveVer{}

func setLiveVersion(host, v string) {
	liveBatMu.Lock()
	defer liveBatMu.Unlock()
	liveVers[host] = liveVer{at: time.Now(), v: v}
}

func liveVersionFor(host string) (string, bool) {
	liveBatMu.Lock()
	defer liveBatMu.Unlock()
	if x, ok := liveVers[host]; ok && time.Since(x.at) < liveBatFresh {
		return x.v, true
	}
	return "", false
}
