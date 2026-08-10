// singleinstance.go — 一台機器只跑一個托盤（t176，leo 08-03 回報「點選多次後托盤產生多個 icon」）。
//
// 為什麼要自己做：托盤程式**從來沒有任何** single-instance 機制（無 mutex／lockfile／pidfile）。
// mac 上看起來不會重複開，是**借了 macOS Launch Services 對同 bundle ID .app 的內建去重**
// （`open` 喚回既有行程），不是這支程式自己做的；Windows 的 .exe 沒有這層，
// 於是每雙擊一次就真的多一個行程、多一個托盤 icon。
//
// 作法：在 ~/.arcrun-rag/tray.lock 寫入自己的 pid，啟動時檢查該 pid 是否還活著。
// 選 pidfile 而非 OS 專屬鎖（Windows CreateMutex／unix flock）的理由：
// 產物是 CGO_ENABLED=0 的純 stdlib 單一執行檔（見 build-*.sh），跨平台一份實作最不容易漂移。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// trayLockPath 回傳鎖檔路徑（與 config/manifest 同一個 app 目錄）。可注入（測試用）。
var trayLockPath = func() string { return filepath.Join(appDir(), "tray.lock") }

// acquireSingleInstance 嘗試取得「本機唯一托盤」的鎖。
// 回傳 false 代表已經有另一個托盤在跑（呼叫端應該直接退出，不要再建第二個托盤 icon）。
//
// 誠實限制：pid 在行程結束後可能被作業系統重用，極端情況下會誤判成「還在跑」。
// 這種情況下使用者刪掉 tray.lock 就能恢復，比「每點一次多一個 icon」好得多。
func acquireSingleInstance() (ok bool, release func()) {
	path := trayLockPath()
	if data, err := os.ReadFile(path); err == nil {
		if pid, perr := strconv.Atoi(strings.TrimSpace(string(data))); perr == nil && pid > 0 && pid != os.Getpid() {
			if processAlive(pid) {
				return false, func() {}
			}
			// pid 已死＝上次沒有正常結束（當機／強制關閉）留下的殘檔，直接接管。
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		// 建不了目錄就不擋啟動——寧可容忍重複開，也不要讓使用者完全打不開。
		return true, func() {}
	}
	if err := os.WriteFile(path, []byte(fmt.Sprint(os.Getpid())), 0o644); err != nil {
		return true, func() {}
	}
	return true, func() { _ = os.Remove(path) }
}
