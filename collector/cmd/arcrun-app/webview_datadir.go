package main

// webview_datadir.go — Store 版（msix）把 WebView2 的資料夾放在我們自己的資料目錄（inkstone/arcrun-rag#387）
//
// 為什麼：Wails 沒給 WebviewUserDataPath 時，go-webview2 用 %APPDATA%\Arcrun.exe。
// msix 套件裡的程式寫 %APPDATA% 會被檔案系統虛擬化轉到套件私有的 LocalCache；
// WebView2 建環境失敗時 go-webview2 的 errorCallback 直接 os.Exit(1)——
// 沒有視窗、沒有錯誤訊息，正是 Store 審核寫的「crashes at launch，錯誤訊息 NA」那個形狀。
// ⇒ 只在 msix 身分下改放 ~/.arcrun-rag/webview2（家目錄不在虛擬化範圍內，跟 config、log 同窩）。
// 直接下載的 exe 照舊用預設位置，現有用戶的 WebView2 資料不搬家。
// （這是調查中的試驗版；以 Windows runner 的實測結果為準，見票。）

import (
	"os"
	"path/filepath"
)

// webviewUserDataPath 回傳要交給 Wails 的 WebView2 資料夾；空字串＝用 Wails 預設。
func webviewUserDataPath() string {
	if !updatesManagedByStore() {
		return ""
	}
	dir := filepath.Join(appDir(), "webview2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		appLog("WebView2 資料夾建不起來 %s：%v（改用 Wails 預設）", dir, err)
		return ""
	}
	appLog("Store 版：WebView2 資料夾 %s", dir)
	return dir
}
