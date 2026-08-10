//go:build windows

package main

// tray_windows.go — Windows 系統匣（t196，2026-08-05）
//
// 為什麼 Windows 用 energye/systray 而 macOS 不用（wiki mistakes 有全文）：
//   macOS 上 systray 在 Wails 之下**根本不會建立托盤**——`setInternalLoop(true)` 只在
//   `systray.Run()` 裡呼叫，走 `RunWithExternalLoop` 時 `registerSystray()` 第一行就 return；
//   而改用 `systray.Run()` 又會與 Wails 搶 macOS 主 loop（SIGTRAP）。
//   ⇒ macOS 最後改走原生 `NSStatusItem`（tray_darwin.m）。
//
//   **Windows 沒有這個限制**：托盤走 Win32 訊息迴圈（自己的 goroutine 就能跑），
//   不像 macOS 的 NSStatusItem 硬性要求主執行緒。所以這裡用 systray 是合適的，
//   不是「抄 macOS 失敗的做法」。
//
// 行為與 macOS 版**逐項對齊**（tray_darwin.go／.m）：
//   · 左鍵點 icon → 直接開視窗（不彈選單）
//   · 右鍵        → 只有「結束 Arcrun」一項
//   · 關視窗      → 隱藏不結束（daemon 常駐；在 app.go 的 OnBeforeClose 處理）

import (
	_ "embed"

	"github.com/energye/systray"
)

// trayApp 讓回呼找得到 App（與 tray_darwin.go 同名同用途；
// 該檔有 //go:build darwin，Windows 編譯時不存在，故這裡自帶一份）。
var trayApp *App

// Windows 系統匣要 .ico（PNG 會顯示成空白／方塊）。
//
// 🔴 2026-08-06：這裡以前 embed `build/windows/icon.ico`，而那顆是 `wails init` 留下的
// **Wails 預設「W」圖**（換 CIS logo 時只換了 appicon.png，沒人動它）
// ⇒ leo 封測看到視窗與托盤兩處都是「W」。
// 現在兩顆 .ico 都由 `gen-icons.py` 從 `build/appicon.png` 現場產生（build-win.sh 會跑），
// 這裡改用小尺寸階梯的 trayicon.ico——系統匣只吃 16/32，塞 256 的那顆是浪費。
//
//go:embed build/trayicon.ico
var trayIconICO []byte

// setupTray 建立系統匣圖示。
//
// 與 macOS 版的介面契約相同（main.go 只呼叫 setupTray(app)），
// 但這裡**不阻塞**：systray 自己開 goroutine 跑訊息迴圈，Wails 主迴圈不受影響。
func setupTray(app *App) {
	trayApp = app
	// RunWithExternalLoop 回傳 start/end；Windows 下 start 不阻塞。
	trayStart, trayEnd = systray.RunWithExternalLoop(func() {
		systray.SetIcon(trayIconICO)
		systray.SetTitle("Arcrun")
		systray.SetTooltip("Arcrun — 你的知識庫同步小幫手")

		// 🔴 右鍵選單：**只有結束**（leo 08-05：「依照 google drive，托盤裡只剩下
		//   按右鍵會結束，其他設定都在這個頁面」）。
		quit := systray.AddMenuItem("結束 Arcrun", "結束 Arcrun（同步會停止）")
		quit.Click(func() {
			if trayApp != nil {
				trayApp.Quit()
			}
		})

		// 左鍵＝直接開視窗，不彈選單（Google Drive 式）。
		systray.SetOnClick(func(menu systray.IMenu) {
			if trayApp != nil {
				trayApp.ShowWindow()
			}
		})
		// 右鍵才顯示選單。
		systray.SetOnRClick(func(menu systray.IMenu) {
			if menu != nil {
				_ = menu.ShowMenu()
			}
		})
	}, func() {})
}
