//go:build !darwin && !windows

package main

// tray_other.go — 非出貨平台（Linux 等）的系統匣 no-op（arcrun-rag#137）。
//
// 為什麼加這一個檔：`setupTray` 只在 `tray_darwin.go`／`tray_windows.go` 有實作，
// 所以整包在 Linux **連編都編不起來**（`undefined: setupTray`）——
// 連帶 `go build ./...`／`go test ./...` 這兩件最基本的機械驗證在雲端／CI 上做不了，
// 而這台桌面 App 的出貨機是 macOS 與 Windows，本來就沒人會在 Linux 跑它。
//
// ⇒ 補一個 no-op，讓「編得過／測得過」這條線在任何機器上都成立。
// **對出貨零影響**：darwin 與 windows 兩個 tag 都排除了這個檔，
// 兩邊拿到的仍然是各自那份真正的托盤實作。
//
// 🔴 這不是「Linux 版桌面 App」：Linux 上沒有托盤、也沒有人測過 WebView，
//
//	它存在的唯一理由是讓編譯器與測試跑得起來（同 dock_other.go 的先例）。
func setupTray(_ *App) {}
