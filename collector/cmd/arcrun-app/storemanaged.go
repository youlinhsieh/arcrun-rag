package main

// storemanaged.go — 從 Microsoft Store 裝的版本不自己更新（inkstone/arcrun-rag#352，父票 #351）
//
// 為什麼：msix 裝在唯讀的 `C:\Program Files\WindowsApps\<套件>\`，程式不能改寫自己；
// 套件更新只由 Store 發。我們的自我更新（下載新 exe → 改名蓋掉正在跑的自己，見
// selfupdate.go applyWindowsUpdateAndRestart）在 msix 底下一定失敗，而且「下載新的可執行檔
// 再執行」正是 Store 政策 10.2.2（不得動態引入程式碼改變功能）審核會盯的行為。
// ⇒ 以「身在 msix 套件裡」為判準，整個自我更新關掉：不背景下載、不查最新版、不顯示「有新版」。
// 直接下載的 exe、Mac 版沒有套件身分，行為與以前逐字相同。
//
// 判準＝套件身分（Windows 的 GetCurrentPackageFullName），不是「有沒有上架」：
// 側載的 msix 一樣是唯讀套件、一樣不能蓋自己。

import (
	"errors"
	"strings"
)

// errStoreManaged：msix 身分下任何自我更新入口一律回這個，白話給畫面用。
var errStoreManaged = errors.New("這個版本由 Microsoft Store 更新")

// packageIdentity 回傳「現在這個程序有沒有 msix 套件身分」。
// 預設實作在 storemanaged_windows.go／storemanaged_other.go；測試換掉它來模擬兩種身分。
var packageIdentity = detectPackageIdentity

// updatesManagedByStore：自我更新是否該關掉。
func updatesManagedByStore() bool {
	return packageIdentity()
}

// pathInsidePackageStore 是第二道判準：執行檔路徑落在 WindowsApps 套件目錄底下。
// 純字串、不碰系統，所以任何平台都能測；Windows 實作只在套件身分查詢失敗時才靠它。
func pathInsidePackageStore(exePath string) bool {
	p := strings.ToLower(strings.ReplaceAll(exePath, "/", `\`))
	return strings.Contains(p, `\windowsapps\`)
}
