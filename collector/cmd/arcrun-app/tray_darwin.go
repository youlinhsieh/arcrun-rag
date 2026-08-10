//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
void createTray(const char *iconBytes, int iconLen, const char *tooltip, const char *quitTitle);
*/
import "C"
import "unsafe"

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
	tip := C.CString("Arcrun — 你的知識庫同步小幫手")
	quit := C.CString("結束 Arcrun")
	defer C.free(unsafe.Pointer(tip))
	defer C.free(unsafe.Pointer(quit))
	C.createTray((*C.char)(unsafe.Pointer(&trayIcon[0])), C.int(len(trayIcon)), tip, quit)
}
