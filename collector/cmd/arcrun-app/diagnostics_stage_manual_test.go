package main

// diagnostics_stage_manual_test.go — t213 phase 3：手動、可重跑的 stage 驗收
// （2026-08-08，總管複驗要求：「本機測綠 ≠ stage 上按得出來」，要留一支能被
// 總管／leo 自己獨立重跑的東西，不是只留一份貼在聊天紀錄裡、驗完就刪的輸出）。
//
// 跟 diagnostics_engine_e2e_test.go 的差別：那支是**永久迴歸測試**（零帳號、零網路，
// `go test ./...` 預設就會跑，驗的是「engine 欄位跟著 supervisor 生死走」這個機制本身）。
// 這支要打**真的 stage 帳號**（youlin，官方指定的 stage 測試身分，見頂層 wiki D37
// 「安裝測試 stage＝youlin」），依賴外部憑證檔＋真網路，所以：
//   - 預設 SKIP（`go test ./...` 不會誤觸網路依賴），要 RUN_STAGE_DIAGNOSTICS=1 才跑。
//   - 憑證用 STAGE_ACCOUNT_JSON 指向一份外部 JSON（不寫死在原始碼裡，避免金鑰值
//     出現在 git 歷史／commit diff）；取得方式見下方 usage 註解。
//   - **這支檔案本身留在版控裡**（不像上一輪那樣驗完就刪）——總管／leo 可以隨時用
//     自己的憑證獨立重跑，不必等我。
//
// 用真的執行檔（`go build .`，帶 -ldflags 注入版本，比照 build-mac.sh 的做法，
// 不是裸 `go build` 留下 daemon_version="dev"）＋真的 supervisor 子行程（同 App
// 在真機上做的事，見 supervise.go startSupervisor）－這是「按鈕背後的真路徑」：
// ExportDiagnostics() 只比 buildDiagnosticsPayload() 多一行 SaveFileDialog
// （非互動環境 Wails 的視窗系統跳不出對話框，這一行沒有意義可測；其餘是完全
// 同一份程式碼路徑，這是 t213 phase 2 就定下、總管已核可的驗證方式）。
//
// ── 使用方式 ──
//
//	python3 -c '
//	import json
//	cfg = json.load(open("/Users/youlinhsieh/.arcrun-rag/config.json"))
//	for a in cfg["accounts"]:
//	    if a["instance_name"] == "youlin.hsieh.dev":
//	        print(json.dumps(a))
//	' > /tmp/stage_account.json
//
//	RUN_STAGE_DIAGNOSTICS=1 STAGE_ACCOUNT_JSON=/tmp/stage_account.json \
//	  go test -run TestDiagnosticsStageManual -v -timeout 180s .
import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"arcrun-rag/collector/supervisor"
)

func TestDiagnosticsStageManual(t *testing.T) {
	if os.Getenv("RUN_STAGE_DIAGNOSTICS") != "1" {
		t.Skip("一次性／可重跑的手動驗收，設 RUN_STAGE_DIAGNOSTICS=1 才跑（見本檔頂端 usage 註解）")
	}
	acctPath := os.Getenv("STAGE_ACCOUNT_JSON")
	if acctPath == "" {
		t.Fatal("需要 STAGE_ACCOUNT_JSON 指向帳號設定檔（見本檔頂端 usage 註解）")
	}
	raw, err := os.ReadFile(acctPath)
	if err != nil {
		t.Fatalf("讀不到帳號設定：%v", err)
	}
	var acc accountCfg
	if err := json.Unmarshal(raw, &acc); err != nil {
		t.Fatalf("帳號設定解析失敗：%v", err)
	}

	// 🔴 安全閘：不沿用來源帳號的 watch_folders——那是 leo 平常拿來測試的真實資料夾，
	// 這支測試指到一個全新、隔離、內容我們自己控制的資料夾，不動 leo 的真實測試資料。
	// 放兩個檔（一個能萃取、一個格式不支援）讓 progress／failure_breakdown 不是全零。
	watchDir := filepath.Join(t.TempDir(), "stage-watch")
	if err := os.MkdirAll(watchDir, 0o755); err != nil {
		t.Fatalf("建隔離監看資料夾失敗：%v", err)
	}
	if err := os.WriteFile(filepath.Join(watchDir, "diagnostics-note.md"),
		[]byte("# t213 phase 3 stage 驗收\n\n這份筆記只是用來驗證診斷檔的 engine 欄位機制，內容本身沒有意義。\n"),
		0o644); err != nil {
		t.Fatalf("寫測試檔失敗：%v", err)
	}
	if err := os.WriteFile(filepath.Join(watchDir, "legacy-report.wpd"), []byte("dummy"), 0o644); err != nil {
		t.Fatalf("寫測試檔失敗：%v", err)
	}
	acc.WatchFolders = []string{watchDir}

	// 🔴 帶真實版本，不是裸 build 留下 daemon_version="dev"——用目前實際出貨的
	// daemon 版本號，讓這份診斷檔更接近真實用戶會匯出的樣子。
	//
	// 兩個地方各要設一次，因為兩個行程各自持有自己那份 `version`：
	//   ① 子行程（collector 引擎本體）：靠 -ldflags 注入，比照 build-mac.sh 的
	//      LDFLAGS_VER 做法——但這支子行程只負責監看/心跳/觸發雲端，不負責組
	//      diagnostics JSON，所以子行程的版本號**不影響**輸出裡的 daemon_version。
	//   ② 呼叫 buildDiagnosticsPayload() 的這個行程（也就是本測試自己，因為
	//      Go test 二進位檔本身就是 package main 的編譯體，`version` 是套件層級
	//      變數）：這才是 daemon_version 欄位的真正來源，直接賦值即可，不必
	//      重新編譯測試二進位檔本身。
	// 這個號碼會過期，過期不影響驗證邏輯本身（update_check 照樣現查現答，
	// 比對的是雲端最新版），只是 headline 文案會隨之變化，不必維護到分毫不差。
	const simulatedShippedVersion = "v0.18.24"
	version = simulatedShippedVersion // ②：本行程（測試）自己的 daemon_version 來源
	t.Cleanup(func() { version = "dev" })

	bin := filepath.Join(t.TempDir(), "arcrun-app-stage")
	buildArgs := []string{"build",
		"-ldflags", "-X main.version=" + simulatedShippedVersion,
		"-o", bin, "."}
	if out, err := exec.Command("go", buildArgs...).CombinedOutput(); err != nil {
		t.Fatalf("編不出執行檔：%v\n%s", err, out)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	cfg := &directConfig{
		Manifest: filepath.Join(home, ".arcrun-rag", "manifest.json"),
		Accounts: []accountCfg{acc},
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存設定失敗：%v", err)
	}

	sup = supervisor.New(bin, configPath())
	sup.ArgPrefix = []string{collectorModeFlag}
	t.Cleanup(func() { sup.Stop() })
	sup.Start()

	// 等到真的處理過東西（LastActivityAt 有值＝那一輪有產出，不只是心跳），
	// 給 workers-ai 萃取留夠時間（雲端 LLM 呼叫，不是本地運算）。
	deadline := time.Now().Add(90 * time.Second)
	for {
		s := loadSyncStatus()
		if s.LastActivityAt != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Logf("⚠ 等 90 秒都沒等到 LastActivityAt（alive=%v），改用目前狀態繼續", collectorAlive())
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// buildDiagnosticsPayload() 是 App.ExportDiagnostics() 扣掉 SaveFileDialog
	// 那一行的完全同一份程式碼路徑（見本檔頂端註解）——這就是「按鈕背後的真路徑」。
	app := &App{}
	aliveOut := app.buildDiagnosticsPayload()
	aliveJSON, _ := json.MarshalIndent(aliveOut, "", "  ")

	// 把 JSON 真的寫到磁碟（不是只印在測試 log 裡）——留一個獨立於這次對話的檔案證據，
	// 存在系統暫存區（不進 repo，這是外部憑證跑出來的資料，不該進版控）。
	artifactPath := filepath.Join(os.TempDir(), "arcrun-stage-diagnostics-alive.json")
	if err := os.WriteFile(artifactPath, aliveJSON, 0o644); err != nil {
		t.Logf("⚠ 寫檔案證據失敗（不影響驗證本身）：%v", err)
	} else {
		t.Logf("📄 已寫入檔案證據：%s", artifactPath)
	}
	t.Logf("══ 情境一（stage，同步引擎活著）完整診斷檔 ══\n%s", aliveJSON)

	if len(aliveOut.Accounts) != 1 {
		t.Fatalf("帳號數量不對：%d", len(aliveOut.Accounts))
	}
	if aliveOut.Accounts[0].Cloud == nil && aliveOut.Accounts[0].CloudError == "" {
		t.Fatal("帳號既沒有 cloud 也沒有 cloud_error——不該發生")
	}
	if aliveOut.Accounts[0].Cloud != nil {
		if bv, ok := aliveOut.Accounts[0].Cloud["bundle_version"]; !ok || bv == nil {
			t.Fatal("accounts[].cloud.bundle_version 是 null／缺欄位——這正是前一輪踩過的坑，要如實回報，不能假裝過了")
		} else {
			t.Logf("✅ accounts[].cloud.bundle_version = %v（不是 null）", bv)
		}
	}
	if !aliveOut.Local.Engine.Alive {
		t.Fatalf("情境一：engine.alive 應為 true，得到 %+v", aliveOut.Local.Engine)
	}

	// ── 情境二（考卷 Q2 的核心）：刻意製造「同步停擺」——停掉子行程，模擬同步引擎掛了 ──
	frozenLastSync := aliveOut.Local.Engine.LastSync
	frozenProgress := aliveOut.Local.Progress
	sup.Stop()
	time.Sleep(8 * time.Second) // 真的讓時間流逝，seconds_since_last_sync 才會明顯拉開

	stoppedOut := app.buildDiagnosticsPayload()
	stoppedJSON, _ := json.MarshalIndent(stoppedOut, "", "  ")
	stoppedPath := filepath.Join(os.TempDir(), "arcrun-stage-diagnostics-stopped.json")
	if err := os.WriteFile(stoppedPath, stoppedJSON, 0o644); err != nil {
		t.Logf("⚠ 寫檔案證據失敗（不影響驗證本身）：%v", err)
	} else {
		t.Logf("📄 已寫入檔案證據：%s", stoppedPath)
	}
	t.Logf("══ 情境二（stage，同步引擎已停擺）完整診斷檔 ══\n%s", stoppedJSON)

	if stoppedOut.Local.Engine.Alive {
		t.Fatal("情境二：子行程已經 Stop()，engine.alive 應為 false")
	}
	if stoppedOut.Local.Engine.LastSync != frozenLastSync {
		t.Fatalf("情境二：last_sync 不該再前進：停前 %q，停後 %q", frozenLastSync, stoppedOut.Local.Engine.LastSync)
	}
	if stoppedOut.Local.Progress != frozenProgress {
		t.Fatalf("情境二：progress 不該再變（沒有新的一輪跑過）：停前 %+v，停後 %+v", frozenProgress, stoppedOut.Local.Progress)
	}
	if stoppedOut.Local.Engine.SecondsSinceLastSync == nil || *stoppedOut.Local.Engine.SecondsSinceLastSync < 7 {
		t.Fatalf("情境二：心跳停了 8 秒以上，seconds_since_last_sync 應該 >=7，得到 %v", stoppedOut.Local.Engine.SecondsSinceLastSync)
	}
	t.Logf("✅ 同一組 progress／pending 數字，情境一 alive=true、情境二 alive=false——"+
		"光看 JSON 就能分辨『還在跑』與『停擺了』，不必問任何人。frozenProgress=%+v", frozenProgress)
}
