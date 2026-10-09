package collector

import (
	"strings"
	"testing"
	"time"
)

// inkstone/arcrun-rag#240：額度剎車要講成人話，不是「雲端回報內部錯誤」。
func TestRouteNoteNamesUsageBrake(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	u := "https://arcrun-cypher-executor.geek.workers.dev/webhooks/named/x/rag_ingest_card/trigger"
	now := time.Now()
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		b.record(u, now, 500, nil, false)
	}
	b.refineCause(u, `{"error":"usage_brake","message":"已自動剎車"}`)
	note := b.noteFor(u, "geek6688", now)
	if !strings.Contains(note, "額度剎車") || strings.Contains(note, "內部錯誤") {
		t.Fatalf("要講剎車不是內部錯誤：%q", note)
	}
	if !strings.Contains(note, "稍後會自動恢復") {
		t.Fatalf("識別字不能丟：%q", note)
	}
	// 認不出的 body 不動原因
	b2 := &routeBreaker{routes: map[string]*routeState{}}
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		b2.record(u, now, 500, nil, false)
	}
	b2.refineCause(u, "boom")
	if !strings.Contains(b2.noteFor(u, "g", now), "內部錯誤") {
		t.Fatal("非剎車維持原句")
	}
}
