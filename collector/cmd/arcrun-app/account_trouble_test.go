package main

import (
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
	"arcrun-rag/collector/supervisor"
)

// inkstone/arcrun-rag#240：一個知識庫出錯，錯誤只出現在它自己的分頁。
func TestAccountTroubleOnlyForOwningAccount(t *testing.T) {
	fs := []collector.ExtractFail{
		{Path: "a.md", Error: "雲端回報內部錯誤", Account: "geek.example"},
		{Path: "b.md", Error: "雲端回報內部錯誤", Account: "geek.example"},
	}
	if tr := accountTrouble(fs, "geek.example"); tr == nil || tr.Count != 2 || !strings.Contains(tr.Detail, "內部錯誤") {
		t.Fatalf("geek 該有 2 份問題與真因，got %+v", tr)
	}
	if tr := accountTrouble(fs, "youlin.example"); tr != nil {
		t.Fatalf("別的知識庫不該被牽連，got %+v", tr)
	}
}

func TestHeaderDoesNotShoutFailuresWhenAttributed(t *testing.T) {
	s := syncStatus{LastSync: "2026-10-07T14:32:23+08:00", LastActivityOK: 0, LastActivityFailed: 20,
		LastActivityAt: "2026-10-07T14:27:27+08:00",
		Failures:       []collector.ExtractFail{{Path: "a", Error: "x", Account: "geek.example"}}}
	_, sub := watchingSummary(s)
	if strings.Contains(sub, "20 份失敗") {
		t.Fatalf("歸得到帳號的失敗不該在全站頁首喊：%q", sub)
	}
	if !strings.Contains(sub, "1 個知識庫要處理") {
		t.Fatalf("頁首要指路：%q", sub)
	}
	// 舊版 status.json（歸不到）維持原樣
	s.Failures = []collector.ExtractFail{{Path: "a", Error: "x"}}
	_, sub = watchingSummary(s)
	if !strings.Contains(sub, "20 份失敗") {
		t.Fatalf("歸不到帳號時維持原句：%q", sub)
	}
}

func TestCrashLoopingOnlyWhileNotRunning(t *testing.T) {
	if crashLooping(supervisor.StateWatching, 9) || crashLooping(supervisor.StateSyncing, 9) {
		t.Fatal("已經在跑就不是『一直啟動失敗』")
	}
	if !crashLooping(supervisor.StateError, 3) || !crashLooping(supervisor.StateStarting, 3) {
		t.Fatal("起不來時 ≥3 次要算")
	}
	if crashLooping(supervisor.StateError, 2) {
		t.Fatal("2 次不算")
	}
}

// c18000：帳號頁的動態只講這個帳號自己的；引擎在處理別人時不轉述別人的檔案。
func TestAccountStatusOnlyOwnActivity(t *testing.T) {
	now := time.Now()
	s := syncStatus{InRound: &collector.RoundProgress{Account: "geek.example", Folder: "/x/pricing-course", Step: "請雲端讀一份文件"}}
	g := accountStatus(s, "geek.example", true, now)
	if !g.Syncing || !strings.Contains(g.Line, "pricing-course") || strings.Contains(g.Line, "（") {
		t.Fatalf("geek 該看到自己的動態且不帶括號帳號名，got %+v", g)
	}
	y := accountStatus(s, "youlin.example", true, now)
	if y.Syncing || strings.Contains(y.Line, "pricing-course") {
		t.Fatalf("youlin 不該看到 geek 的動態，got %+v", y)
	}
	if idle := accountStatus(syncStatus{}, "youlin.example", false, now); idle.Syncing || idle.Line == "" {
		t.Fatalf("閒置時該有一句看守中，got %+v", idle)
	}
}

func TestNoAccountClaimsSyncingWithoutRound(t *testing.T) {
	for _, h := range []string{"a", "b", "c"} {
		if st := accountStatus(syncStatus{}, h, true, time.Now()); st.Syncing {
			t.Fatalf("不知道在處理誰時，%s 不該顯示同步中", h)
		}
	}
}
