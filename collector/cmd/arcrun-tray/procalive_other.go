//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

// processAlive 用 signal 0 探測：不真的送訊號，只做「這個 pid 現在存在嗎」的檢查。
//
// ⚠️ EPERM 也算活著：行程存在但屬於別的使用者（權限不足送訊號）。
// 只有 ESRCH（查無此行程）才是真的死了。把 EPERM 當死會讓鎖被錯誤接管 ⇒ 又變成多開。
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid) // Unix 上這一步不會失敗，真正的判定在 Signal
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
