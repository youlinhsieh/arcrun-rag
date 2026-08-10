package main

// diagnostics_engine_e2e_test.go — t213 phase 3 端到端驗證（考卷 Q2 缺口）。
//
// 舊版診斷檔看得到 pending=0，但分不出「真的做完了」還是「daemon 早就掛了沒人知道」——
// 因為完全沒有時間資訊。這支測試用**真的執行檔＋真的 supervisor 子行程**（同 App 在真機上
// 做的事，見 supervise.go startSupervisor），證明新加的 local.engine 這組欄位不是憑空編出來
// 的假象，而是真的跟著子行程死活變動：
//
//	情境一（存活中）：子行程剛拉起、跑過至少一輪 → engine.alive=true、
//	  seconds_since_last_sync 是幾秒內的新鮮心跳。
//	情境二（考卷 Q2 的核心，刻意製造「同步停擺」）：把子行程停掉（模擬同步引擎掛掉／
//	  停止——不是「整個 App 被關掉」那種情況，那種情況下 App 根本不會被打開來按
//	  「匯出診斷檔」，不在本檔驗證範圍）→ engine.alive=false、headline 講人話說明、
//	  last_sync 凍結在停止前那一刻不再前進、seconds_since_last_sync 隨等待時間持續變大。
//
// 刻意零帳號、零網路：這支測試只驗「心跳（LastSync）跟著子行程死活走」這條機制本身，
// 不需要任何雲端憑證，任何機器上都能跑、都穩定。
import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector/supervisor"
)

func TestDiagnosticsEngine_ReflectsRealSupervisorLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("拉真子行程＋等真心跳，跑起來要十幾秒，-short 跳過")
	}

	// 🔴 先編再改 HOME（同 freshinstall_e2e_test.go 的教訓：Go 模組快取會寫進 HOME，
	//    先改 HOME 再 build 會把唯讀快取寫進暫存目錄，測試結束清不掉）。
	bin := filepath.Join(t.TempDir(), "arcrun-app-test")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("編不出執行檔：%v\n%s", err, out)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// t213 phase 4：監看資料夾要是一個**真的絕對路徑**，才能重現「collector 開機橫幅把
	// 監看路徑印進 stderr → supervisor 記成 LastError → 診斷檔把它原樣帶出去」這個洞
	// （見 direct.go RunDirect 的「監看 %s → %s」那行；leo 08-08 附帶發現、本輪要修的問題）。
	watchDir := filepath.Join(home, "知識庫")
	if err := os.MkdirAll(watchDir, 0o755); err != nil {
		t.Fatalf("建監看資料夾失敗：%v", err)
	}

	// 需要至少一個帳號：LoadDirectConfig 會拒絕零帳號的設定（「缺必填欄位：accounts」，
	// 連迴圈都進不去），但這個帳號**不必連得上**——cypher_url 刻意指向一個解析不出來的
	// 網址，驗證的是「心跳（LastSync）跟著子行程死活走」這條機制，不是雲端連線本身。
	cfg := &directConfig{
		Manifest: filepath.Join(home, ".arcrun-rag", "manifest.json"),
		Accounts: []accountCfg{{
			CypherURL: "https://example.invalid.test", Namespace: "test", APIKey: "test",
			WatchFolders: []string{watchDir},
		}},
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存設定失敗：%v", err)
	}

	sup = supervisor.New(bin, configPath())
	sup.ArgPrefix = []string{collectorModeFlag}
	t.Cleanup(func() { sup.Stop() })
	sup.Start()

	// ── 情境一：等到子行程真的活著、心跳過至少一輪 ──
	deadline := time.Now().Add(15 * time.Second)
	for {
		s := loadSyncStatus()
		if collectorAlive() && s.LastSync != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("等 15 秒子行程都沒完成第一輪心跳（alive=%v, LastSync=%q）", collectorAlive(), s.LastSync)
		}
		time.Sleep(200 * time.Millisecond)
	}

	app := &App{}
	aliveOut := app.buildDiagnosticsPayload()
	aliveJSON, _ := json.MarshalIndent(aliveOut, "", "  ")
	t.Logf("── 情境一（存活中）完整診斷檔 ──\n%s", aliveJSON)

	if !aliveOut.Local.Engine.Alive {
		t.Fatalf("情境一：engine.alive 應為 true，得到 %+v", aliveOut.Local.Engine)
	}
	if aliveOut.Local.Engine.SecondsSinceLastSync == nil || *aliveOut.Local.Engine.SecondsSinceLastSync > 10 {
		t.Fatalf("情境一：last_sync 應該是幾秒內的新鮮心跳，得到 seconds_since_last_sync=%v",
			aliveOut.Local.Engine.SecondsSinceLastSync)
	}

	// ── 情境二：停掉子行程，模擬同步引擎掛了／被停止（考卷 Q2）──
	frozenLastSync := aliveOut.Local.Engine.LastSync
	sup.Stop()

	// 等一段「真的有時間流逝」，讓 seconds_since_last_sync 明顯拉開（不是量測誤差）。
	time.Sleep(6 * time.Second)

	stoppedOut := app.buildDiagnosticsPayload()
	stoppedJSON, _ := json.MarshalIndent(stoppedOut, "", "  ")
	t.Logf("── 情境二（已停擺）完整診斷檔 ──\n%s", stoppedJSON)

	if stoppedOut.Local.Engine.Alive {
		t.Fatal("情境二：子行程已經 Stop()，engine.alive 應為 false")
	}
	if stoppedOut.Local.Engine.LastSync != frozenLastSync {
		t.Fatalf("情境二：子行程停了之後不該再有新心跳，last_sync 卻變了：停前 %q，停後 %q",
			frozenLastSync, stoppedOut.Local.Engine.LastSync)
	}
	if stoppedOut.Local.Engine.SecondsSinceLastSync == nil || *stoppedOut.Local.Engine.SecondsSinceLastSync < 5 {
		t.Fatalf("情境二：心跳停了 6 秒以上，seconds_since_last_sync 應該 >=5，得到 %v",
			stoppedOut.Local.Engine.SecondsSinceLastSync)
	}
	if stoppedOut.Local.Engine.Headline == "" {
		t.Fatal("情境二：alive=false 時 headline 不該是空的——這是給人看的『還在不在跑』答案")
	}
	t.Logf("✅ Q2 證據鏈完整：pending 不變的情況下，alive／last_sync／seconds_since_last_sync 三者都反映了子行程真的停了")

	// ── t213 phase 4（leo 08-08 附帶發現、本輪要修）──
	// alive=false 這個狀態下，engine.detail／engine.last_error 過去會帶出 collector 開機
	// 橫幅的完整原文，其中含監看資料夾的絕對路徑（見 direct.go RunDirect 的
	// 「監看 %s → %s」那行）。這裡的 watchDir 就是刻意設成真實絕對路徑，用來重現這個洞：
	// 驗證整份匯出 JSON 裡找不到它，同時確認「引擎沒在跑、以及為什麼」仍然讀得懂
	// （不能把資訊遮成啞巴——資料夾最後一截「知識庫」要還在）。
	if strings.Contains(string(stoppedJSON), watchDir) {
		t.Fatalf("情境二：整份診斷檔仍然帶出監看資料夾的絕對路徑 %q：%s", watchDir, stoppedJSON)
	}
	if strings.Contains(string(stoppedJSON), home) {
		t.Fatalf("情境二：整份診斷檔仍然帶出本機家目錄路徑 %q：%s", home, stoppedJSON)
	}
	if containsAbsPath(string(stoppedJSON)) {
		t.Fatalf("情境二：整份診斷檔（掃全文，不只 engine 兩個欄位）仍有本機絕對路徑殘留：%s", stoppedJSON)
	}
	reason := stoppedOut.Local.Engine.LastError + stoppedOut.Local.Engine.Detail
	if reason == "" {
		t.Fatal("情境二：alive=false 時 last_error／detail 不該兩個都是空的——『為什麼沒在跑』答不出來了")
	}
	if !strings.Contains(reason, "知識庫") {
		t.Fatalf("情境二：遮蔽把資訊遮成啞巴了——連監看資料夾叫什麼名字都看不出來：last_error=%q detail=%q",
			stoppedOut.Local.Engine.LastError, stoppedOut.Local.Engine.Detail)
	}
	t.Logf("✅ t213 phase 4：路徑遮掉了，但『引擎沒在跑、以及為什麼（監看的是「知識庫」資料夾）』還讀得懂")
}
