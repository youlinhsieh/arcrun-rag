package main

// supervise.go — 看守 collector 子行程（t194）
//
// 🔴 沒有這一段，這個 App 就只是個「會顯示設定的空殼」——
//    daemon 的本體是 `collector direct`，它才在監看資料夾、萃卡、上傳。
//    （寫 Wails 版時我一度漏了它，等於做出一個裝了也不會同步的東西。）
//
// 邊界：**複用既有的 supervisor 套件**（重起退避、狀態機、round 解析都在裡面，
// 含 t191 的 phase:start/done ⇒ 「同步中…」）。這裡只做「找到執行檔、拉起來」。
import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"arcrun-rag/collector/supervisor"
)

var sup *supervisor.Supervisor

// collectorBinPath 回傳「要跑哪一支執行檔當同步引擎」——答案是**我們自己**。
//
// 🔴 2026-08-06 leo 裁決：「不要兩支，寫成一支檔案」。
//
//	先前兩代做法都有病：
//	  ① zip 裡放兩支 exe 同層 ⇒ 使用者少拿一支就永遠不同步（leo 封測回報②）
//	  ② 內嵌 collector.exe、執行時攤到磁碟再跑 ⇒ **Windows Defender 眼中的 dropper**
//	     （封測者實撞：檔案「包含病毒或潛在的垃圾軟體」當場被刪）
//	現在：collector 已改成可被引用的套件（arcrun-rag/collector.Run），
//	App 直接把它編進同一個執行檔，靠 `--collector` 參數換身分。
//	⇒ **磁碟上永遠只有一個 exe，沒有任何東西被攤出來。**
func collectorBinPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return exe
}

// collectorArgPrefix 是「把自己當 collector 跑」的參數（見 main.go 開頭的分派）。
func collectorArgPrefix() []string { return []string{collectorModeFlag} }

// startSupervisor 在 App 啟動時拉起 collector；沒有 config 就先不啟動
// （使用者還沒連知識庫，啟動只會一直失敗刷 log）。
func startSupervisor() {
	bin := collectorBinPath()
	cfg := configPath()
	// 🔴 t195：這裡以前只 Stat(config) 就靜默 return，出問題完全查不到。
	//    leo 實撞：App 活著、collector 從沒啟動、畫面卻顯示「正在整理知識卡」。
	//    ⇒ 每個 return 點都要留下痕跡（寫進 collector.log 旁邊的 app.log）。
	if bin == "" {
		appLog("啟動同步引擎失敗：取不到自己的執行檔路徑")
		return
	}
	if _, err := os.Stat(cfg); err != nil {
		appLog("尚未連上知識庫（沒有 %s），同步引擎先不啟動", cfg)
		return
	}
	sup = supervisor.New(bin, cfg)
	sup.ArgPrefix = collectorArgPrefix() // 同一支執行檔，換身分跑
	// 🔴 2026-08-06：每次狀態變成 Error 都寫進 app.log。
	//    沒有這一段，「子行程一啟動就死」在檔案裡**一個字都沒有**——
	//    leo 在 Windows ARM 撞到時，畫面只有閃爍、log 只有「同步引擎已啟動」，
	//    死因（Status().LastError）只活在記憶體裡，跟著程式一起消失。
	//    只在錯誤訊息**變了**或每 10 次才記一次，避免重試迴圈把 log 洗爆。
	var lastLogged string
	var lastN int
	sup.SetOnChange(func(st supervisor.Status) {
		if st.State != supervisor.StateError {
			return
		}
		if st.LastError == lastLogged && st.Restarts-lastN < 10 {
			return
		}
		lastLogged, lastN = st.LastError, st.Restarts
		appLog("同步引擎異常結束（第 %d 次重試）：%s", st.Restarts, st.LastError)
	})
	sup.Start()
	appLog("同步引擎已啟動：%s", bin)
}

// appLog 把 App 層的關鍵事件寫進 ~/.arcrun-rag/app.log。
// 沒有這個，「為什麼沒同步」就只能用猜的（leo 這次就卡在這）。
func appLog(format string, args ...any) {
	f, err := os.OpenFile(filepath.Join(appDir(), "app.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// restartWatch 在設定變更後重起看守，讓新設定立刻生效。
func restartWatch() {
	// 🔴 2026-08-06 leo 實測（「第一次直接跑可以，清空再來一次就不跑了」）：
	//    這裡以前第一行是 `if sup == nil { return }` ⇒ **每一個全新使用者都會撞到**——
	//      ① 開程式時還沒有設定 ⇒ startSupervisor 早退，`sup` 是 nil
	//      ② 使用者接著連知識庫、加資料夾 ⇒ 呼叫這支 ⇒ **nil 就直接 return，什麼都沒發生**
	//      ③ 引擎永遠不啟動，畫面說「請結束 Arcrun 再重新開啟」
	//    ——它「不算錯」（重開真的會好），但等於要求剛裝好的人自己想到去重開程式。
	//    ⇒ 還沒建立就**現在建立**：設定剛剛才出現，正是該啟動的時機。
	if sup == nil {
		startSupervisor()
		return
	}
	sup.Stop()
	if _, err := os.Stat(configPath()); err == nil {
		sup.Start()
	}
}

// stopSupervisor 結束前停掉 collector 子行程。
// 沒有這一步，按「結束 Arcrun」後 collector 會變孤兒繼續跑
// ⇒ 使用者以為關了、其實還在同步，而且下次啟動會有兩個。
func stopSupervisor() {
	if sup != nil {
		sup.Stop()
	}
}

// installSignalHandler 讓 App 對 SIGTERM／SIGINT 有反應。
//
// 🔴 leo 實測④：「**用強制結束把它關掉才能測試**，一般托盤程式不會顯示在強制結束列表中」。
//
//	真兇：Wails 的 loop 不理會 TERM，而 collector 是我們自己 Start 的子行程
//	⇒ 主程式被殺時**子行程變孤兒繼續跑**（實測：kill -TERM 後 collector 還在）。
//	⇒ 收到訊號就先停子行程再退出，避免「關了卻還在同步」與「下次啟動有兩個」。
func installSignalHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-ch
		// 🔴 2026-08-06：這裡以前 stopSupervisor() 之後還跑一輪 waitCollectorGone()
		//    （pgrep 輪詢 + pkill 補刀），因為當時擔心「Stop() 回來時子行程還在收屍」。
		//    翻 supervisor 原始碼確認**那個擔心不成立**：
		//      Stop() → cancel ctx → 阻塞等 loop goroutine 關閉
		//      → loop 等 runOnce 回來 → runOnce 最後一行是 `return cmd.Wait()`
		//    ⇒ Stop() 回來時子行程**已經被 Wait 收屍完畢**，不需要補刀。
		//    而那兩支指令 Windows 根本沒有 ⇒ 在 Windows 上本來就只是空轉 3 秒。
		//    （leo 撞到的孤兒是「強制結束」＝SIGKILL 的情境，訊號處理器根本不會執行，
		//      補刀也救不了；那條要靠 Windows job object／macOS 的 App 生命週期解，另案。）
		stopSupervisor()
		os.Exit(0)
	}()
}

// collectorAlive 回報「同步引擎是不是真的在跑」。
//
// 🔴 t195 立的原則不變：**燈號要有憑有據，不准說謊**——leo 實撞過
// collector 已死、畫面卻一直顯示「正在整理知識卡」13 分鐘。
//
// 🔴 2026-08-06 換憑據來源（leo Windows 封測回報「根本不運行」，首頁恆顯示
// 「同步引擎沒有在跑」）：
//
//	舊憑據是 `pgrep -f <bin>`。**Windows 根本沒有 pgrep** ⇒ 這裡恆回 false
//	⇒ app.go 的狀態一定走「同步引擎沒有在跑」，與 collector 實際狀態無關。
//	Mac 有 pgrep 所以驗不出來——又一個只在 Windows 現形的病。
//
//	新憑據＝**supervisor 自己的狀態機**（我們親手 exec.CommandContext 拉起子行程、
//	runOnce 以 cmd.Wait() 收尾，行程一死立刻進 StateError／StateStopped）
//	⇒ 比掃行程表**更有憑據**，而且跨平台。
//	順帶修掉 pgrep 的偽陽性：`pgrep -f` 會匹配到**別的實例**拉起的 collector。
//
//	這不是第三種判斷法——db17f28（08-05）已為「同步中」立下同一條路：
//	「改讀 sup.Status().State ⇒ **接回既有機制，不發明第三種判斷法**」。
//	當時只改了 collectorSyncing 那半邊，這裡是把漏掉的另一半補上。
//
// collectorFailure 回報「同步引擎是不是一直啟動失敗」，以及死因。
//
// 🔴 2026-08-06 leo 在 Windows 11 ARM 實測：畫面「一直在『看守中』和『沒有在跑』
//
//	中間閃…我覺得它在跑個迴圈不停重複」。
//	真相就是那樣——子行程一啟動就死，supervisor 退避後再拉，狀態在
//	Starting（collectorAlive=true）與 Error（false）之間彈跳 ⇒ 畫面跟著閃。
//	**而死因一直被記在 Status().LastError 裡，從來沒有上過畫面**
//	⇒ 使用者只看到閃爍與「請重新開啟」，重開當然無效（死因沒變）。
//	這是「安靜地略過」的同一種病，換一個地方發作。
//
// restarts 達到門檻才算「一直失敗」——偶爾重起一次是正常的（例如換設定）。
func collectorFailure() (msg string, restarts int, looping bool) {
	if sup == nil {
		return "", 0, false
	}
	st := sup.Status()
	return st.LastError, st.Restarts, st.Restarts >= crashLoopThreshold
}

// crashLoopThreshold＝重起幾次算「一直失敗」。3 次以內可能只是換設定或暫時性錯誤。
const crashLoopThreshold = 3

func collectorAlive() bool {
	if sup == nil {
		return false
	}
	switch sup.Status().State {
	case supervisor.StateStopped, supervisor.StateError:
		return false
	default: // Starting／Watching／Syncing
		return true
	}
}

// collectorSyncing 回報 collector 是不是**正在跑一輪**。
//
// 🔴 2026-08-05：資料來源是 t191 就做好、上面這支 supervisor 一直在維護的狀態機——
// collector 開工印 phase:"start"、跑完印 "done"，supervisor 據此進出 StateSyncing。
// 換 Wails 時 App 沒接這條線、改看 sync-now 訊號檔，於是「拖檔進資料夾」這種
// 自動觸發的同步整輪都不會亮燈（訊號檔只有手動按鈕才產生，而且 collector 是先刪再跑）。
func collectorSyncing() bool {
	if sup == nil {
		return false
	}
	return sup.Status().State == supervisor.StateSyncing
}
