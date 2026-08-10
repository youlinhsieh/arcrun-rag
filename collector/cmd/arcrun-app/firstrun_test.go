package main

import (
	"os"
	"testing"
)

// TestFirstRunStartsEngineAfterConnect 釘住 leo 2026-08-06 實測的最後一個病：
//
//	「第一次直接跑可以，**清空再來一次，就不跑了**」
//
// 全新使用者的真實順序是：
//
//	① 打開程式（**這時還沒有任何設定**）⇒ startSupervisor 早退，sup 仍是 nil
//	② 連上知識庫、加資料夾 ⇒ 呼叫 restartWatch
//	③ 舊版的 restartWatch 第一行是 `if sup == nil { return }` ⇒ **什麼都沒發生**
//	   ⇒ 引擎永遠不啟動，畫面叫人「請結束 Arcrun 再重新開啟」
//
// 這條路只有「**先沒有設定、之後才有**」才會走到——
// 開發機永遠有設定，所以永遠測不到。這支測試刻意從「沒有設定」開始。
func TestFirstRunStartsEngineAfterConnect(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	sup = nil
	t.Cleanup(func() { stopSupervisor(); sup = nil })

	// ① 打開程式：還沒有設定
	startSupervisor()
	if sup != nil {
		t.Fatal("沒有設定時不該啟動引擎（會一直失敗刷 log）")
	}

	// ② 使用者連上知識庫、加資料夾（＝寫出設定）
	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL: "https://example.workers.dev",
			Namespace: "abc123",
			APIKey:    "abc123",
		}},
		Extractor: "workers-ai",
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}
	if _, err := os.Stat(configPath()); err != nil {
		t.Fatalf("設定沒寫出來：%v", err)
	}

	// ③ 這一步以前是死巷
	restartWatch()
	if sup == nil {
		t.Fatal("設定出現後仍沒建立引擎 ⇒ 使用者得自己想到重開程式（leo 撞到的那個）")
	}
}
