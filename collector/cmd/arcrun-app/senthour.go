package main

// senthour.go — 每個帳號近一小時送出幾份（inkstone/arcrun-rag#240 c18413）
//
// 帳本上萬筆，GetState 又頻繁被畫面叫 ⇒ 每個帳號的結果快取 30 秒。

import (
	"sync"
	"time"

	"arcrun-rag/collector"
)

type sentCache struct {
	at time.Time
	n  int
}

var (
	sentMu      sync.Mutex
	sentCache30 = map[string]sentCache{}
)

func sentLastHour(cfg *directConfig, acc accountCfg) *int {
	if cfg == nil || cfg.Manifest == "" || acc.CypherURL == "" {
		return nil
	}
	key := acc.CypherURL
	sentMu.Lock()
	c, ok := sentCache30[key]
	sentMu.Unlock()
	if ok && time.Since(c.at) < 30*time.Second {
		n := c.n
		return &n
	}
	n := collector.IngestedSince(cfg.Manifest, acc.CypherURL, acc.WatchFolders, time.Now().Add(-time.Hour))
	sentMu.Lock()
	sentCache30[key] = sentCache{at: time.Now(), n: n}
	sentMu.Unlock()
	return &n
}
