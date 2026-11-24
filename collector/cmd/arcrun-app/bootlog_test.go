package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#387：全新用戶第一次啟動時 ~/.arcrun-rag 不存在，
// appLog 必須自己建資料夾，不能靜默吞掉（那就是 Store 審核當機時查不到證據的原因）。
func TestAppLogCreatesMissingDirOnFirstRun(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if _, err := os.Stat(appDir()); err == nil {
		t.Fatalf("前提不成立：%s 一開始就存在", appDir())
	}
	bootTrace()
	b, err := os.ReadFile(filepath.Join(appDir(), "app.log"))
	if err != nil {
		t.Fatalf("首次啟動沒有留下 app.log：%v", err)
	}
	for _, want := range []string{"啟動 Arcrun", "Microsoft Store 套件內", "執行檔："} {
		if !strings.Contains(string(b), want) {
			t.Errorf("app.log 缺「%s」：\n%s", want, b)
		}
	}
}

func TestLogBootPanicKeepsStack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	logBootPanic("boom")
	b, _ := os.ReadFile(filepath.Join(appDir(), "app.log"))
	if !strings.Contains(string(b), "boom") || !strings.Contains(string(b), "goroutine") {
		t.Errorf("panic 紀錄沒有訊息或堆疊：\n%s", b)
	}
}
