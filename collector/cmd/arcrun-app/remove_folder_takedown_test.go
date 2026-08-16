// remove_folder_takedown_test.go — arcrun-rag#46：按下「移除」之後，資料真的要被收回。
//
// leo 2026-08-16 實撞：「我去把 Logseq plugin 刪掉以後，**採集的 wiki 沒消失**。」
// 真兇：RemoveFolder 只把路徑從 WatchFolders 拿掉、存檔、重啟看守——**一次都沒碰撤除**。
//
// 本檔釘 App 這一半的三件事：
//  1. 選了「連同雲端一起收回」⇒ 資料夾要進 retiring_folders（collector 靠它才知道要撤）
//  2. 選了「只停止同步」⇒ 行為與從前一字不差（不可以偷偷幫使用者刪東西）
//  3. collector 回報收乾淨了 ⇒ 設定裡那一筆才消失（且中途不會被靜默丟掉）
package main

import (
	"encoding/json"
	"os"
	"testing"

	collector "arcrun-rag/collector"
)

func newTestCfgWithFolder(t *testing.T, path string) {
	t.Helper()
	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL: "https://example.workers.dev", Namespace: "abc123", APIKey: "abc123",
			WatchFolders: []string{path, "/other/folder"},
		}},
		Extractor: "workers-ai",
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}
}

// ① 選「連同雲端一起收回」：離開看守清單、進入待撤清單。
func TestRemoveFolderWithTakedownQueuesRetirement(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	newTestCfgWithFolder(t, "/kb/logseq-plugin")

	if err := (&App{}).RemoveFolder(0, "/kb/logseq-plugin", true); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	cfg, err := loadCfg()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range cfg.Accounts[0].WatchFolders {
		if f == "/kb/logseq-plugin" {
			t.Error("移除後不該還在看守清單裡")
		}
	}
	if len(cfg.Accounts[0].RetiringFolders) != 1 || cfg.Accounts[0].RetiringFolders[0] != "/kb/logseq-plugin" {
		t.Fatalf("🔴 這就是 #46 的真兇：移除沒有排任何撤除，retiring_folders=%v",
			cfg.Accounts[0].RetiringFolders)
	}
	// 別的資料夾不能被波及
	if len(cfg.Accounts[0].WatchFolders) != 1 || cfg.Accounts[0].WatchFolders[0] != "/other/folder" {
		t.Errorf("其他資料夾被動到了：%v", cfg.Accounts[0].WatchFolders)
	}

	// 🔴 t108 鏡像檢查：欄位要真的落在磁碟上、且 collector 讀得回來。
	// （兩份 struct 各自維護，少一欄就會在下次存檔靜默消失。）
	raw, _ := os.ReadFile(configPath())
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	accs, _ := m["accounts"].([]any)
	if len(accs) == 0 {
		t.Fatal("accounts 不見了")
	}
	a0, _ := accs[0].(map[string]any)
	if _, ok := a0["retiring_folders"]; !ok {
		t.Error("retiring_folders 沒有寫進磁碟 ⇒ collector 永遠不會知道要撤除")
	}
	cc, err := collector.LoadDirectConfig(configPath())
	if err != nil {
		t.Fatalf("collector 讀不了 App 存的 config：%v", err)
	}
	if got := cc.RetiringRoots(); len(got) != 1 || got[0] != "/kb/logseq-plugin" {
		t.Errorf("collector 端看到的待撤清單=%v", got)
	}
}

// ② 選「只停止同步」：行為與從前一字不差——不可以幫使用者做他沒選的刪除。
func TestRemoveFolderWithoutTakedownKeepsCloudData(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	newTestCfgWithFolder(t, "/kb/keep-cloud")

	if err := (&App{}).RemoveFolder(0, "/kb/keep-cloud", false); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	cfg, _ := loadCfg()
	for _, f := range cfg.Accounts[0].WatchFolders {
		if f == "/kb/keep-cloud" {
			t.Error("移除後不該還在看守清單裡")
		}
	}
	if len(cfg.Accounts[0].RetiringFolders) != 0 {
		t.Errorf("使用者選的是「保留雲端資料」，不該排撤除：%v", cfg.Accounts[0].RetiringFolders)
	}
}

// ③ 收乾淨了才從設定裡消失；還在撤的中途不可以被清掉（清掉＝待辦永久遺失）。
func TestRetirementClearedOnlyWhenCollectorSaysDone(t *testing.T) {
	cfg := &directConfig{Accounts: []accountCfg{{
		RetiringFolders: []string{"/kb/finished", "/kb/still-going", "/kb/never-reported"},
	}}}

	sync := syncStatus{Retiring: map[string]collector.RetiringStatus{
		"/kb/finished":    {Done: true},
		"/kb/still-going": {Remaining: 12, LastError: "HTTP 500：boom"},
		// "/kb/never-reported" 刻意沒被回報（collector 還沒跑到）
	}}

	if !pruneFinishedRetirements(cfg, sync) {
		t.Fatal("有一筆已完成，應回報有變動")
	}
	got := cfg.Accounts[0].RetiringFolders
	if len(got) != 2 || got[0] != "/kb/still-going" || got[1] != "/kb/never-reported" {
		t.Fatalf("只有 done 的那一筆該消失，實得 %v", got)
	}
	// 冪等：再跑一次不該有變動（不然每輪都在寫 config）
	if pruneFinishedRetirements(cfg, sync) {
		t.Error("沒有新的完成項時不該回報變動")
	}
}

// ④ 收回中的資料夾不准同時加回來看守——一邊撤一邊傳，結果不可預測。
func TestAddFolderRefusedWhileRetiring(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cfg := &directConfig{Accounts: []accountCfg{{
		CypherURL: "https://example.workers.dev", Namespace: "abc123",
		RetiringFolders: []string{"/kb/retiring"},
	}}}
	if err := saveCfg(cfg); err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).AddFolder(0, "/kb/retiring"); err == nil {
		t.Error("正在收回的資料夾應該擋下來並說明原因，不該默默加回去")
	}
	after, _ := loadCfg()
	if len(after.Accounts[0].WatchFolders) != 0 {
		t.Errorf("被擋下就不該寫進看守清單：%v", after.Accounts[0].WatchFolders)
	}
}
