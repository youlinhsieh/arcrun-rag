// singleinstance_test.go — t176：一台機器只跑一個托盤（leo 08-03「點多次產生多個 icon」）。
package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// withTempLock 把鎖檔導到暫存目錄，避免測試碰到使用者真正的 ~/.arcrun-rag。
func withTempLock(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tray.lock")
	orig := trayLockPath
	trayLockPath = func() string { return path }
	t.Cleanup(func() { trayLockPath = orig })
	return path
}

// 第一個實例拿得到鎖；release 後鎖檔消失。
func TestSingleInstanceFirstAcquires(t *testing.T) {
	path := withTempLock(t)

	ok, release := acquireSingleInstance()
	if !ok {
		t.Fatal("第一個實例應該拿得到鎖")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("鎖檔應被建立：%v", err)
	}
	if got, _ := strconv.Atoi(string(data)); got != os.Getpid() {
		t.Errorf("鎖檔應寫入自己的 pid，got %q want %d", data, os.Getpid())
	}

	release()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("release 後鎖檔應被刪除（否則下次啟動要靠 pid 檢查兜底）")
	}
}

// 鎖檔記著一個「還活著」的 pid（就用自己的父流程：本測試行程自己）→ 第二個實例被擋。
// 這正是 leo 撞到的情境：點第二次不該再開一個托盤。
func TestSingleInstanceSecondBlocked(t *testing.T) {
	path := withTempLock(t)
	// 寫入一個確定活著、且不等於自己的 pid：用 pid 1（init/launchd，任何系統上都在跑）。
	if err := os.WriteFile(path, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := acquireSingleInstance(); ok {
		t.Error("已有活著的實例時，第二個應該被擋下（不然就會多一個托盤 icon）")
	}
}

// 殘留鎖檔（上次當機留下、pid 已死）不應永久卡死啟動——要能接管。
func TestSingleInstanceStaleLockTakenOver(t *testing.T) {
	path := withTempLock(t)
	// 挑一個幾乎不可能存在的 pid：先開一個行程再等它結束太慢，直接用超大值。
	if err := os.WriteFile(path, []byte("4194303"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok, release := acquireSingleInstance()
	if !ok {
		t.Fatal("殘留鎖檔（pid 已死）應可接管，否則使用者永遠打不開")
	}
	defer release()
	data, _ := os.ReadFile(path)
	if got, _ := strconv.Atoi(string(data)); got != os.Getpid() {
		t.Errorf("接管後鎖檔應改寫成自己的 pid，got %q", data)
	}
}

// 壞掉的鎖檔內容（非數字）不應擋住啟動。
func TestSingleInstanceGarbageLock(t *testing.T) {
	path := withTempLock(t)
	if err := os.WriteFile(path, []byte("not-a-pid"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok, release := acquireSingleInstance()
	if !ok {
		t.Fatal("鎖檔內容壞掉時應放行（寧可容忍重複開，也不要讓人完全打不開）")
	}
	release()
}
