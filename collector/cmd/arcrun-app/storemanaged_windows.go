package main

import (
	"os"
	"syscall"
	"unsafe"
)

const (
	errInsufficientBuffer = 122   // ERROR_INSUFFICIENT_BUFFER：有套件身分，只是沒給緩衝區
	errNoPackage          = 15700 // APPMODEL_ERROR_NO_PACKAGE：沒有套件身分（一般 exe）
)

// detectPackageIdentity：問 Windows 這個程序有沒有套件身分（msix 裝的才有）。
// 問不到（舊系統沒有這支 API）才退而看執行檔路徑。
func detectPackageIdentity() bool {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentPackageFullName")
	if err := proc.Find(); err == nil {
		var n uint32
		r, _, _ := proc.Call(uintptr(unsafe.Pointer(&n)), 0)
		switch r {
		case errNoPackage:
			return false
		case errInsufficientBuffer, 0:
			return true
		}
	}
	if exe, err := os.Executable(); err == nil {
		return pathInsidePackageStore(exe)
	}
	return false
}
