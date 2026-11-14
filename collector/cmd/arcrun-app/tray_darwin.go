//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
void createTray(const char *iconBytes, int iconLen, const char *tooltip, const char *quitTitle, const char *label);
*/
import "C"
import (
	"unsafe"

	"arcrun-rag/collector/channel"
)

// trayApp 讓 C 回呼找得到 App（cgo 匯出函式不能帶 Go 參數）。
var trayApp *App

//export trayOnLeftClick
func trayOnLeftClick() {
	if trayApp != nil {
		trayApp.ShowWindow()
	}
}

//export trayOnQuit
func trayOnQuit() {
	if trayApp != nil {
		trayApp.Quit()
	}
}

// setupTray 建立選單列 icon。
// ⚠️ **必須在主執行緒呼叫**（NSStatusItem 內部會 new NSWindow）。
func setupTray(app *App) {
	trayApp = app
	ch := channel.Current()
	tip := C.CString(ch.AppName + " — 你的知識庫同步小幫手")
	quit := C.CString("結束 " + ch.AppName)
	// 🔴 #135：Stage 版在選單列 icon 旁多一段字（" Stage"）。選單列圖示是「模板圖」（只有形狀、系統上色），
	//    換顏色看不出差別，文字才是兩個 App 並排時一眼分得出來的記號。正式版傳空字串＝與以前完全相同。
	label := C.CString(trayLabel(ch))
	defer C.free(unsafe.Pointer(tip))
	defer C.free(unsafe.Pointer(quit))
	defer C.free(unsafe.Pointer(label))
	C.createTray((*C.char)(unsafe.Pointer(&trayIcon[0])), C.int(len(trayIcon)), tip, quit, label)
}
