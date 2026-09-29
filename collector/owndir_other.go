//go:build !windows

package collector

// ownDirHidingSupported：Unix／macOS 上點開頭本來就是隱藏，不必另外掛屬性。
const ownDirHidingSupported = false

// hideOwnDirPlatform 在非 Windows 平台是 no-op。
// 保留同名函式是為了讓呼叫端不必寫 runtime.GOOS 判斷（跟 supervisor/hidewindow_other.go 同一個作法）。
func hideOwnDirPlatform(_ string) error { return nil }
