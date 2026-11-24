package main

import (
	"os"
	"runtime"
	"runtime/debug"
)

// bootTrace 在 main() 一開始就把「這次是怎麼被啟動的」寫進 app.log。
//
// 🎯 inkstone/arcrun-rag#387：Microsoft Store 審核 2026-11-19 退件「The product crashes at launch」，
//
//	錯誤訊息 NA。我們在 Windows Server 2025 上重現不了（三種啟動法、WACK 24 項、Defender、
//	斷網都正常），而 App 沒有任何啟動紀錄可查——首次啟動時 ~/.arcrun-rag 不存在，appLog 靜默失敗。
//	這支補上之後，審核員再當機，app.log 會停在哪一行就是答案：
//	  · 只有「啟動」沒有「視窗已建立」⇒ 死在建 WebView2 的那一步（Wails 在那步失敗會直接 os.Exit）
//	  · 有「視窗已建立」沒有「畫面載入完成」⇒ 死在前端載入
//	  · 有 panic 行 ⇒ 附完整堆疊
func bootTrace() {
	exe, _ := os.Executable()
	appLog("──── 啟動 Arcrun %s（%s/%s，go %s）", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	appLog("執行檔：%s；Microsoft Store 套件內＝%v；pid %d", exe, updatesManagedByStore(), os.Getpid())
	if v := webview2Version(); v != "" {
		appLog("WebView2：%s", v)
	}
}

// logBootPanic 在 main() 的 defer 裡呼叫：panic 也要留下完整堆疊再結束，
// 不然使用者只看到「一開就消失」。
func logBootPanic(r any) {
	appLog("🔴 啟動中發生 panic：%v\n%s", r, debug.Stack())
}
