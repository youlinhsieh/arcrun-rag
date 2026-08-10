package main

import (
	_ "embed"
	"runtime"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
)

// 托盤品牌 icon（2026-07-31，接 leo 的 CIS；結掉 main.go 舊 TODO「換品牌 icon」）。
//
// 兩平台要的東西不一樣，所以嵌兩份、開機時選一份：
//
//   - macOS 選單列＝**template icon**（純黑＋alpha），系統依淺色/深色選單列自動反色。
//     直接塞墨底彩色方塊在選單列會變成「一顆黑方塊」，非常醜——這是 CIS 也講明的：
//     ≤26px 的情境降級成 chevron，不用完整的 `a>>` 方塊（字在 22pt 下只剩 ~4px 高，糊掉）。
//   - Windows 系統匣＝完整墨底 icon（系統匣背景不固定，template 那套是 mac 專有）。
//
// ⚠️ fyne v2.5.3 的判斷點（internal/driver/glfw/driver_desktop.go:169）：
// **只有 `*theme.ThemedResource` 才會走 `systray.SetTemplateIcon`**，
// 傳一般的 `StaticResource` 會走 `SetIcon`＝不反色。所以 mac 這條一定要包 ThemedResource，
// 不能只是「給一張黑白圖」就以為會自動反色。
//
// 用 go:embed 內嵌，**不讀外部檔案路徑**——打包成 .app/.msix 後工作目錄不是原始碼目錄，
// 靠相對路徑找圖必 404（icon 不見）。
var (
	//go:embed assets/tray-template.png
	trayTemplatePNG []byte

	//go:embed assets/tray-windows.png
	trayWindowsPNG []byte
)

// trayIcon 回傳當前平台該用的托盤 icon。
func trayIcon() fyne.Resource {
	if runtime.GOOS == "windows" {
		return fyne.NewStaticResource("arcrun-tray.png", trayWindowsPNG)
	}
	// mac（與 Linux 一併走這條：深色 panel 下同樣需要單色可反轉的圖）
	return theme.NewThemedResource(
		fyne.NewStaticResource("arcrun-tray-template.png", trayTemplatePNG),
	)
}
