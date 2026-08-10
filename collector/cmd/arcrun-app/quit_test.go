package main

import "testing"

// TestCloseMeansHide 守住 leo 2026-08-06 撞到的 bug：
//
//	「在托盤按右鍵結束 Arcrun 但實際上 Dock 上的沒結束…唯一結束法是強制結束…
//	 因為舊版沒結束導致無法覆蓋，如果不知道怎麼強制結束的人就放棄了」
//
// 真兇：Wails 的 runtime.Quit() 與「按 ×」**共用同一個 OnBeforeClose**
// （frontend.go:364 `if !OnBeforeClose(ctx) { mainWindow.Quit() }`）。
// 我們原本無條件回 true ⇒ mainWindow.Quit() 永遠不執行 ⇒ 結束選單失效。
//
// 這支測試釘住兩件事：按 × 要隱藏、按結束要放行。
func TestCloseMeansHide(t *testing.T) {
	quitting.Store(false)
	if !closeMeansHide() {
		t.Fatal("預設（按 ×）應該攔下來改成隱藏——常駐程式不該被關窗結束")
	}

	beginQuit() // ＝托盤右鍵「結束 Arcrun」會做的第一件事
	if closeMeansHide() {
		t.Fatal("按了結束卻仍要隱藏＝程式永遠退不掉（就是 leo 撞到的那個 bug）")
	}

	quitting.Store(false) // 還原，避免影響其他測試
}
