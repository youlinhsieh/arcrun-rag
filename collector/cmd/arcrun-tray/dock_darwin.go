//go:build darwin

// dock_darwin.go — 托盤唯一指示器（leo 07-24 裁決）的 macOS 實作。
//
// 真機實測（07-24 第三枚坑）：Info.plist 的 LSUIElement=true 會被 fyne/glfw 啟動時
// 強制的 Regular activation policy 蓋掉（lsappinfo 實測 ApplicationType=Foreground），
// Dock icon 照樣出現。唯一可靠解＝app 起來後 runtime 直接把 policy 切成 Accessory。
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

// hideDockIcon 把 app 切成 Accessory（選單列有、Dock 無）。須在 NSApp 初始化後呼叫
// （掛在 fyne Lifecycle SetOnStarted）。
func hideDockIcon() { C.arcrunHideDock() }
