//go:build darwin

// dock_darwin.go — 托盤唯一指示器（leo 07-24 裁決）的 macOS 實作。
//
// 🔴 **這段是取回 `604704a`（07-24，fyne 版）的原版，不是重新發明。**
// 當時已真機驗證通過（`lsappinfo` 實測 `type=UIElement`），換 Wails 時整段掉了
// ⇒ leo 08-06 又撞同一個病：「托盤顯示 icon 時通常 Dock 就不顯示了，但現在是兩邊都顯示」。
//
// 原版註解說的是 fyne/glfw，**Wails 的死法一模一樣**（已查原始碼確認）：
//
//	wails/v2@v2.13.0 internal/frontend/desktop/darwin/AppDelegate.m:44
//	  - (void)applicationWillFinishLaunching:… {
//	        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
//
//	⇒ `Info.plist` 的 `LSUIElement=true` **只決定啟動當下的初始 policy**，
//	  app 起來後自己呼叫 setActivationPolicy 就把它蓋掉了。
//	  （我們的 plist 實測確實有 `LSUIElement => true`，但 Dock 照樣出 icon——就是這個原因。）
//	⇒ 而 Wails v2.13 的 `mac.ActivationPolicy` 選項在原始碼裡是**註解掉的**，設不了。
//	⇒ 唯一可靠解＝app 起來後 runtime 直接把 policy 切成 Accessory（就是本檔）。
//
// 附帶解掉的第三個症狀：leo「別的托盤 daemon 都不列在強制結束列表裡，只有 Arcrun 有」——
// 因為 Regular policy 的 app 才會被列進「強制結束」；切成 Accessory 後就不列了。
package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
#import <AppKit/AppKit.h>
static void arcrunHideDock(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
	});
}
*/
import "C"

// hideDockIcon 把 app 切成 Accessory（選單列有、Dock 無）。
//
// 須在 NSApp 起來**之後**呼叫——fyne 版掛在 `Lifecycle().SetOnStarted`，
// Wails 版掛在 `OnStartup`（見 main.go）。裡面已經 dispatch 回主佇列，
// 呼叫端不必自己處理執行緒。
func hideDockIcon() { C.arcrunHideDock() }
