//go:build windows

package collector

import (
	"path/filepath"
	"strings"
	"syscall"
)

// ownDirHidingSupported：這個平台「點開頭」不等於隱藏，需要另外掛屬性。
const ownDirHidingSupported = true

// hideOwnDirPlatform 對 dir 掛上 FILE_ATTRIBUTE_HIDDEN（保留原有的其他屬性）。
// 已經是隱藏的就不再打 SetFileAttributes（每輪都會被呼叫，別白白寫屬性）。
//
// 用 syscall 而不是 x/sys/windows：需要的兩支（GetFileAttributes／SetFileAttributes）
// 標準庫就有，不必為了一個屬性多拉一個直接依賴。
func hideOwnDirPlatform(dir string) error {
	p, err := syscall.UTF16PtrFromString(longPath(dir))
	if err != nil {
		return err
	}
	attrs, err := syscall.GetFileAttributes(p)
	if err != nil {
		return err
	}
	if attrs&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
		return nil
	}
	return syscall.SetFileAttributes(p, attrs|syscall.FILE_ATTRIBUTE_HIDDEN)
}

// longPath 比照標準庫 os 套件對 Windows 長路徑的處理：
// 絕對路徑超過 MAX_PATH 附近的長度就加 `\\?\` 前綴，否則 Win32 API 直接回「找不到」。
// 碎形知識庫的巢狀層數不受控（leo 的 KB 幾十層很正常），這一格漏了就是「深層的 .wiki 沒隱藏」
// 而且沒有任何錯誤訊息——跟本票的病同一個形狀。
// os 套件自己那支（fixLongPath）是 internal，抄它的判準：短的不動、已帶前綴不動、UNC 不動。
func longPath(p string) string {
	if len(p) < 248 {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return p // UNC 或已經是 \\?\ 形式
	}
	if !filepath.IsAbs(p) {
		return p
	}
	return `\\?\` + filepath.Clean(p)
}
