// idle_poll_test.go — 閒置時拉長輪詢間隔（小幫手閒置吃滿 CPU，leo 2026-11-17）。
package collector

import (
	"testing"
	"time"
)

func TestNextPollIntervalBacksOffWhenIdle(t *testing.T) {
	base, max := 5*time.Second, 60*time.Second
	cur := base
	want := []time.Duration{10, 20, 40, 60, 60}
	for i, w := range want {
		cur = nextPollInterval(cur, base, max, false)
		if cur != w*time.Second {
			t.Fatalf("第 %d 次閒置：got %v want %v", i+1, cur, w*time.Second)
		}
	}
	if got := nextPollInterval(cur, base, max, true); got != base {
		t.Fatalf("有事做要立刻回到基本間隔：got %v", got)
	}
}

func TestNextPollIntervalMaxBelowBaseDisablesBackoff(t *testing.T) {
	c := &DirectConfig{PollSec: 30, IdlePollMaxSec: 10}
	if got := c.idleMaxPoll(); got != 30*time.Second {
		t.Fatalf("上限小於基本間隔要以基本間隔為準：got %v", got)
	}
	if got := nextPollInterval(30*time.Second, 30*time.Second, c.idleMaxPoll(), false); got != 30*time.Second {
		t.Fatalf("退避關掉時應維持基本間隔：got %v", got)
	}
	if got := (&DirectConfig{PollSec: 5}).idleMaxPoll(); got != 60*time.Second {
		t.Fatalf("預設上限應為 60s：got %v", got)
	}
}

func TestRoundDidWork(t *testing.T) {
	idle := []DirectResult{{Type: "added", Status: "skipped"}, {Type: "info", Status: "skipped"}, {Type: "warning", Status: "skipped"}}
	if roundDidWork(idle) {
		t.Fatal("只有略過的輪次算閒置")
	}
	if roundDidWork(append(idle, DirectResult{Type: "folder_tree", Status: "ingested"})) {
		t.Fatal("資料夾樹的定期重送不算有做事")
	}
	for _, st := range []string{"ingested", "removed", "planned", "failed"} {
		if !roundDidWork(append(idle, DirectResult{Status: st})) {
			t.Fatalf("%s 要算有做事", st)
		}
	}
}
