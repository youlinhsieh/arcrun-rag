package main

import "github.com/wailsapp/go-webview2/webviewloader"

// webview2Version 回報這台機器上的 WebView2 執行階段版本；沒裝或查不到時回報原因。
// 寫進 app.log 是因為「WebView2 缺／壞」是 Windows 上啟動即結束最常見的原因之一。
func webview2Version() string {
	v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
	if err != nil {
		return "查不到（" + err.Error() + "）"
	}
	return v
}
