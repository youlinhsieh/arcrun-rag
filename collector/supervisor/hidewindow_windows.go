//go:build windows

package supervisor

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW：起子行程時不要配一個新的 console 視窗。
//
// 為什麼需要（t75，2026-07-28 leo 同事在真 Windows 上實測撞到）：
// 使用者回報「**daemon 開啟時每幾秒螢幕會閃一個方框，大概有螢幕一半大，關閉它就消失**」。
// 根因＝`arcrun-collector.exe` 是 **console 型執行檔**（`PE32+ (console)`），
// supervisor 每輪起它一次，**Windows 預設會為 console 程式配一個可見的視窗** ⇒ 每輪閃一下。
//
// **Mac/Linux 沒有這個概念**，所以這個跨平台差異在開發期完全沒被想到——
// 這也是為什麼「真機驗證」不能只驗自己改過的東西（見 t75 教訓）。
//
// 注意：`-H windowsgui` 是**連結期**選項，只影響「這支程式自己有沒有視窗」；
// 這裡處理的是「**我起別人時要不要給它視窗**」，是不同一件事，兩者都要做才乾淨。
const createNoWindow = 0x08000000

// hideChildWindow 讓子行程不要彈出 console 視窗（僅 Windows 有效）。
func hideChildWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
