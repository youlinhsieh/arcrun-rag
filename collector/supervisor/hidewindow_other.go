//go:build !windows

package supervisor

import "os/exec"

// hideChildWindow 在非 Windows 平台是 no-op：
// Unix 系沒有「起子行程會配一個視窗」這回事（那是 Windows console subsystem 的行為）。
// 保留同名函式是為了讓 supervisor.go 不必寫 runtime.GOOS 判斷（編譯期就分好）。
func hideChildWindow(_ *exec.Cmd) {}
