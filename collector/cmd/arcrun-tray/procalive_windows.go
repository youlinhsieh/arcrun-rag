//go:build windows

package main

import "golang.org/x/sys/windows"

// processAlive 開啟該 pid 的行程控制代碼並讀退出碼；
// STILL_ACTIVE(259) 代表還在跑。Windows 沒有 signal 0 這種探測法。
func processAlive(pid int) bool {
	const stillActive = 259
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false // 開不起來＝行程不存在（或已無權限，一律當作不存在，寧可放行不要擋住啟動）
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}
