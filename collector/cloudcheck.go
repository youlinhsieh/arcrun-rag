// cloudcheck.go — 每輪固定要問雲端的兩件事（版本、雲端 AI 通了沒），限一分鐘問一次
// （`inkstone/arcrun-rag#121`，2026-09-13 真機量測抓到的副作用）。
//
// 病：這兩發原本「每輪各打一次」。以前一輪要跑十幾秒到幾分鐘（逐檔去撞壞掉的雲端），
// 所以每小時大約幾百發。路由退避生效之後，壞掉的那條路不再被打，一輪變成五、六秒就跑完
// ⇒ **這兩發變成每 5 秒一次**。實測 geek6688 真雲端 3 分鐘：
// 退避版 80 發（其中 /health 36、空探測 36），修前只有 34 發——
// 壞掉那條路的請求變少了，雲端收到的總請求卻變多。
//
// 解：兩件事都是「狀態」，不是「工作」——一分鐘內再問一次得到的答案幾乎一定一樣。
// ⇒ 同一台知識庫一分鐘內只真的問一次，其餘沿用上一次的答案。
//
//	使用者按「立刻同步」的那一輪照問（他要的就是最新狀況）。
package collector

import (
	"strings"
	"sync"
	"time"
)

// cloudCheckInterval＝同一台知識庫多久才真的重問一次版本／雲端 AI 狀態。
var cloudCheckInterval = 60 * time.Second

type cachedVersion struct {
	at  time.Time
	ver string
	ok  bool
}

type cachedAIState struct {
	at    time.Time
	state CloudAIState
}

var (
	cloudCheckMu     sync.Mutex
	cloudVersionSeen = map[string]cachedVersion{}
	cloudAISeen      = map[string]cachedAIState{}
)

// resetCloudChecks 清空快取（測試用）。
func resetCloudChecks() {
	cloudCheckMu.Lock()
	defer cloudCheckMu.Unlock()
	cloudVersionSeen = map[string]cachedVersion{}
	cloudAISeen = map[string]cachedAIState{}
}

func cloudCheckKey(cypherURL string) string {
	return strings.TrimSuffix(strings.TrimSpace(cypherURL), "/")
}

// cloudVersionThrottled＝fetchCloudVersion，但同一台一分鐘內只真的問一次。force＝立刻同步。
func cloudVersionThrottled(cypherURL string, force bool) (string, bool) {
	key := cloudCheckKey(cypherURL)
	now := directNow()
	cloudCheckMu.Lock()
	c, hit := cloudVersionSeen[key]
	cloudCheckMu.Unlock()
	if hit && !force && now.Sub(c.at) < cloudCheckInterval && !now.Before(c.at) {
		return c.ver, c.ok
	}
	ver, ok := fetchCloudVersion(cypherURL)
	cloudCheckMu.Lock()
	cloudVersionSeen[key] = cachedVersion{at: now, ver: ver, ok: ok}
	cloudCheckMu.Unlock()
	return ver, ok
}

// cachedAI 回上一次（一分鐘內）問到的雲端 AI 狀態；沒有就 ok=false。
func cachedAI(cypherURL string, force bool) (CloudAIState, bool) {
	if force {
		return CloudAIState{}, false
	}
	now := directNow()
	cloudCheckMu.Lock()
	defer cloudCheckMu.Unlock()
	c, hit := cloudAISeen[cloudCheckKey(cypherURL)]
	if !hit || now.Sub(c.at) >= cloudCheckInterval || now.Before(c.at) {
		return CloudAIState{}, false
	}
	return c.state, true
}

func rememberAI(cypherURL string, st CloudAIState) {
	cloudCheckMu.Lock()
	defer cloudCheckMu.Unlock()
	cloudAISeen[cloudCheckKey(cypherURL)] = cachedAIState{at: directNow(), state: st}
}
