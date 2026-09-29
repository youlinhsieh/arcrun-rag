package main

import (
	"os"
	"path/filepath"
	"testing"

	collector "arcrun-rag/collector"
)

// App 端的逃生口（#136 驗收 5／6／7）：按「收進來」要真的寫進 folder-includes.json
// 並立刻觸發一次同步；「取消收進來」要把它拿掉。這一層驗的是前端按鈕背後那支 Go 方法。
func TestIncludeFolder_WritesStoreAndTriggersSync(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)            // appDir() 走 os.UserHomeDir()，Linux 上吃 $HOME
	t.Setenv("XDG_CONFIG_HOME", home) // 保險：某些平台 UserHomeDir 會看它
	appdir := filepath.Join(home, ".arcrun-rag")

	a := &App{}
	root := "/Users/leo/pms"

	// 收進來
	if err := a.IncludeFolder(root, "pms_v1_legacy"); err != nil {
		t.Fatalf("IncludeFolder 失敗：%v", err)
	}
	storePath := collector.ForceIncludeStorePath(filepath.Join(appdir, "manifest.json"))
	got := collector.LoadForceIncludeStore(storePath).For(root)
	if len(got) != 1 || got[0] != "pms_v1_legacy" {
		t.Fatalf("清單=%v，want [pms_v1_legacy]——收進來沒有落地", got)
	}
	// 立刻觸發同步：sync-now 訊號檔要在
	if _, err := os.Stat(filepath.Join(appdir, "sync-now")); err != nil {
		t.Fatalf("收進來後應該立刻觸發同步（sync-now 訊號檔不存在）：%v", err)
	}

	// 記得住（驗收 6）：換一個新的 App 實例（模擬下一輪），清單還在
	if len(collector.LoadForceIncludeStore(storePath).For(root)) != 1 {
		t.Fatalf("清單應該記得住，重讀後卻不見了")
	}

	// 收回（驗收 7）
	if err := a.ExcludeFolder(root, "pms_v1_legacy"); err != nil {
		t.Fatalf("ExcludeFolder 失敗：%v", err)
	}
	if len(collector.LoadForceIncludeStore(storePath).For(root)) != 0 {
		t.Fatalf("收回後清單應該是空的")
	}
}

func TestIncludeFolder_RejectsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	a := &App{}
	if err := a.IncludeFolder("", "x"); err == nil {
		t.Fatalf("沒給監看根應該報錯")
	}
	if err := a.IncludeFolder("/root", ""); err == nil {
		t.Fatalf("沒給子資料夾應該報錯")
	}
}
