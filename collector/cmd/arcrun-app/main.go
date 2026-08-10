package main

import (
	"context"
	"embed"
	"os"
	"sync/atomic"

	collector "arcrun-rag/collector"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/trayicon.png
var trayIcon []byte

type wailsCtx = context.Context

// 版本號由 build 時 -ldflags 注入（同 arcrun-tray 的規矩）。
var version = "dev"

// quitting 區分「按 ×（收起來）」與「按托盤的結束（真的退）」。
// 兩者都會走 OnBeforeClose，沒有這個旗標就無法分辨——leo 08-06 實撞：
// 「結束 Arcrun」點了沒反應，只能強制結束，導致新版覆蓋不了舊版。
var quitting atomic.Bool

// beginQuit 舉旗表示「這次是真的要退出」，由 App.Quit()（托盤的結束）呼叫。
func beginQuit() { quitting.Store(true) }

// closeMeansHide 回答「這次的關閉要不要攔下來改成隱藏」。
// 抽成獨立函式是為了**可機械驗證**——OnBeforeClose 需要 Wails 的 ctx，測不到；
// 這個判斷才是 leo 08-06 那個 bug 的核心（結束與按 × 共用同一個回呼）。
func closeMeansHide() bool { return !quitting.Load() }

// collectorModeFlag 是「把自己當同步引擎跑」的第一個參數。
//
// 🔴 2026-08-06 leo 裁決：「不要兩支，寫成一支檔案」。
//
//	collector 的程式碼已經編進這個執行檔（arcrun-rag/collector.Run），
//	所以 supervisor 拉起子行程時跑的是**同一個 exe**，只是多帶這個參數。
//	磁碟上不會出現第二支執行檔——那正是 Windows Defender 判 dropper 的特徵
//	（封測者實撞 Trojan:Win32/Sabsik.FL.A!ml，檔案被隔離）。
//
//	用雙連字號開頭而不是子命令，是為了與 collector 自己的子命令（scan/sync/direct…）
//	區分：使用者手動打的是那些，這一個是我們內部用的。
const collectorModeFlag = "--collector"

func main() {
	// 🔴 必須是 main() 的**第一件事**：這個模式下不能碰 GUI、托盤、單一實例鎖，
	//    否則每跑一輪同步就會多一個托盤 icon、還會被單一實例鎖擋掉。
	if len(os.Args) > 1 && os.Args[1] == collectorModeFlag {
		os.Exit(collector.Run(os.Args[2:]))
	}

	// 清掉上一輪 Windows 自我更新留下的 `<exe>.old`（見 selfupdate.go cleanupOldExe）。
	// 必須在這裡（新行程剛啟動、舊行程已結束）才刪得掉；Mac 上是 no-op。
	cleanupOldExe()

	app := NewApp()

	// 🔴 托盤必須在**主執行緒**建立（NSStatusItem 內部會 new NSWindow，
	//    AppKit 規定 NSWindow 只能在主執行緒 new）。
	//    踩過的兩個錯（都真機實測炸掉）：
	//      ① systray.Run() 自己開 loop ⇒ 與 Wails 搶主 loop ⇒ SIGTRAP
	//      ② 在 OnStartup 或 goroutine 裡呼叫 ⇒ 「NSWindow should only be
	//         instantiated on the main thread!」⇒ SIGABRT
	//    正解：main() 一開始（還在主執行緒）就 RunWithExternalLoop 註冊並 start，
	//    它不阻塞，接著再把主執行緒交給 wails.Run()。
	// 🔴 托盤必須在**主執行緒**建立（NSStatusItem 內部會 new NSWindow）。
	//    改用原生 NSStatusItem（見 tray_darwin.m）——實測證明 energye/systray
	//    在 RunWithExternalLoop 之下**根本不會建立托盤**（onReady 從未觸發）。
	setupTray(app)
	installSignalHandler() // 收到 TERM/INT 要能正常退出（不必強制結束）

	err := wails.Run(&options.App{
		Title: "Arcrun",
		// 這裡的 Width/Height 只是**開得起來的保底值**；真正的尺寸在 OnStartup
		// 依螢幕算（見下方 resizeToScreenFraction）。保底值不能大於常見筆電
		// 的可視高度，否則 ScreenGetAll 失敗時會沿用它而擠出畫面外
		// （leo 08-06 實撞：1000x700 在他的 Windows 上「高度太高快擠到外面了」）。
		Width: 960, Height: 600,
		MinWidth: 820, MinHeight: 560,
		AssetServer: &assetserver.Options{Assets: assets},
		// 🔴 2026-08-06：沒有這段，Arcrun.exe **點幾次就開幾個實例**，
		//    每個實例各掛一個系統匣 icon（leo 的封測者開到 4 個，分不清該點哪個），
		//    而且每個實例還各自拉一份 collector 子行程。
		//    macOS 由 LaunchServices 天然單實例 ⇒ 這個病**只在 Windows 現形**。
		//    第二次啟動＝叫醒既有視窗後自己退出（Wails 內部 os.Exit(0)）。
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "dev.arcrun.rag.daemon",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				app.ShowWindow()
			},
		},
		// 🔴 2026-08-06（leo 實測）：「在 Mac 似乎 disable 了全螢幕的按鈕，
		//    應該要讓使用者需要時可以全螢幕。查看 Windows 時全螢幕是可以用的」。
		//    真兇在 Wails 原始碼，不在我們的視窗設定：
		//      window.go:92  `if frontendOptions.Mac != nil { … zoomable = !mac.DisableZoom … }`
		//      ⇒ **沒設 Mac 時 zoomable 維持零值 false**
		//      WailsContext.m:208 `if (!zoomable && resizable) { [zoomButton setEnabled:NO]; }`
		//      ⇒ 綠色按鈕被停用。Windows 沒有這段，所以只有 Mac 壞。
		//    解＝給一個**空的** Mac options（DisableZoom 預設 false ⇒ zoomable=true）。
		Mac: &mac.Options{},
		OnStartup: func(ctx wailsCtx) {
			app.startup(ctx)
			// 🔴 必須在 NSApp 起來之後才切 Accessory——Wails 在
			//    applicationWillFinishLaunching 硬設 Regular，會蓋掉 Info.plist 的
			//    LSUIElement。詳見 dock_darwin.go（取回 604704a 的原版）。
			hideDockIcon()
			resizeToScreenFraction(ctx) // 視窗＝螢幕 70%，置中（leo 08-06 照 Google Drive）
			startSupervisor()           // 🔴 daemon 本體：不啟動就不會同步
			// 🔴 托盤必須在**主執行緒**建立（NSStatusItem 會 new NSWindow）。
			//    OnStartup 不是主執行緒 ⇒ 直接呼叫會炸
			//    「NSWindow should only be instantiated on the main thread!」（實測）。
			//    用 Wails 的 dispatch 把它丟回主執行緒。

		},
		// 🔴 daemon 是常駐程式：關窗只是收起來，**不能真的結束**
		//    （結束＝停止看守資料夾，使用者不會預期按 × 就不再同步）。
		//
		// 🔴 2026-08-06（leo 實測）：「在托盤按右鍵結束 Arcrun 但實際上 Dock 上的沒結束…
		//    唯一結束法是強制結束…因為舊版沒結束導致無法覆蓋，**如果不知道怎麼強制結束的人
		//    就放棄了**」。
		//    真兇：Wails 的 `runtime.Quit()` **也走這個 OnBeforeClose**——
		//      frontend.go:364 `func (f *Frontend) Quit() { … if !OnBeforeClose(ctx) { mainWindow.Quit() } }`
		//    我們無條件回 true ⇒ `mainWindow.Quit()` 永遠不執行 ⇒ 結束選單點了沒用，
		//    而且還順手 WindowHide ⇒ 看起來像關掉了、其實行程還活著。
		//    （AppDelegate.m:41 的 applicationShouldTerminate 也一律回 NSTerminateCancel，
		//      把決定權整個交給這個回呼——所以這裡回 true 就真的沒有任何出口。）
		//    解＝用 quitting 旗標區分「按 ×（收起來）」與「按結束（真的退）」。
		OnBeforeClose: func(ctx wailsCtx) bool {
			if !closeMeansHide() {
				return false // false＝放行，Wails 才會真的呼叫 mainWindow.Quit()
			}
			wruntime.WindowHide(ctx)
			return true // true＝攔下關閉（按 × 只是收起來）
		},
		HideWindowOnClose: true,
		// Dock 不出現 icon：Wails v2.13 的 mac.ActivationPolicy 還沒開放（原始碼裡是註解掉的），
		// 而 Info.plist 的 LSUIElement **會被 Wails 啟動時的 Regular policy 蓋掉**
		// （leo 08-06 實撞：Dock 與托盤兩邊都顯示）⇒ 改在 OnStartup 呼叫 hideDockIcon()
		// runtime 切 Accessory。plist 的 LSUIElement 保留（決定啟動當下的初始 policy）。
		Bind: []interface{}{app},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// screenFraction 是預設視窗佔螢幕長寬的比例。
//
// 🔴 leo 2026-08-06 兩次調整，**以第二次為準**：
//   - 先說「default 50% 螢幕長寬」（因為寫死的 1000x700「高度太高快擠到外面了」）
//   - 實際看到 50% 後改口：「**我查看 Google Drive 的視窗，它應該是大約螢幕長寬的 70%，
//     因為你改成 50% 後顯得太小**」
//
// ⇒ 70%。要再調就改這一個常數，不要散在各處。
const screenFraction = 0.70

// resizeToScreenFraction 把視窗調成螢幕長寬的 screenFraction 並置中。
//
// 寫死尺寸在 1366x768 這種常見筆電上，扣掉工作列就幾乎頂到底。
// 依螢幕算才不會在別人機器上爆版——我們沒有全世界的螢幕可以試。
//
// 拿不到螢幕資訊時**什麼都不做**（沿用 options 的保底值），不要瞎猜一個數字：
// 猜錯的後果就是原本那個病。
func resizeToScreenFraction(ctx wailsCtx) {
	screens, err := wruntime.ScreenGetAll(ctx)
	if err != nil || len(screens) == 0 {
		return
	}
	// 優先用「視窗現在所在的那面」；沒有就退回主螢幕，再退回第一面。
	s := screens[0]
	for _, c := range screens {
		if c.IsCurrent {
			s = c
			break
		}
		if c.IsPrimary {
			s = c
		}
	}
	// Size 是邏輯像素（Wails 設定尺寸用的單位）；舊欄位 Width/Height 已 deprecated，
	// 但某些平台只填舊欄位 ⇒ 兩個都試，取得到值的那個。
	w, h := s.Size.Width, s.Size.Height
	if w == 0 || h == 0 {
		w, h = s.Width, s.Height
	}
	if w == 0 || h == 0 {
		return
	}
	nw, nh := int(float64(w)*screenFraction), int(float64(h)*screenFraction)
	wruntime.WindowSetSize(ctx, nw, nh)
	wruntime.WindowCenter(ctx)
	// 留痕：使用者回報「視窗太大／太小」時，這一行直接說出當時螢幕多大、算出多大。
	// 沒有它就只能請人量像素（08-06 我自己就卡在這）。
	appLog("視窗依螢幕 %dx%d 設為 %dx%d（%.0f%%）", w, h, nw, nh, screenFraction*100)
}

// setupTray 建立選單列 icon。
//
// 🔴 leo 2026-08-05：「依照 google drive，托盤裡**只剩下按右鍵會結束**，
//
//	其他設定都在這個頁面，**點擊托盤的 icon 就立刻展開界面**」
//
// ⇒ 左鍵＝直接開視窗（不彈選單）；右鍵＝只有一項「結束 Arcrun」。
//
//	所有設定都在視窗裡，托盤不再是第二套 UI（fyne 版把設定塞在下拉選單，
//	leo：「daemon 設定項越來越多，不可能統統塞在下拉選單」）。
//
// 🔴 **不可以用 systray.Run() 開自己的迴圈**（我第一版這樣寫，真機一跑就 SIGTRAP）：
//
//	macOS 的選單列必須在**主執行緒**跑，Wails 已經佔著那條 loop，
//	兩個 toolkit 搶主 loop ⇒ `signal arrived during cgo execution` 直接崩。
//	正解是 `RunWithExternalLoop`——它只註冊、把 start/end 交給既有的 loop 呼叫。
var trayStart, trayEnd = func() {}, func() {}
