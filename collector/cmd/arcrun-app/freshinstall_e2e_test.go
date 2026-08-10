package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestFreshInstallCollectorStarts 端到端釘住 leo 2026-08-06 Windows 事故的完整鏈條：
//
//	全新安裝 → App 存 config → supervisor 用「同一支執行檔 + --collector」拉起同步引擎。
//
// 事故當時這條鏈在最後一步斷掉：config 少了 `manifest` ⇒ `exit status 2` ⇒ 無限重拉。
// 上一支測試只驗到「LoadDirectConfig 讀得下去」；這支**真的把執行檔跑起來**，
// 因為「函式回傳 nil」與「行程活得下去」是兩件事——事故就是死在後者。
//
// 用 --once --dry-run：只走到解析設定就收工，不 POST、不寫 manifest，不動到真資料。
func TestFreshInstallCollectorStarts(t *testing.T) {
	// 🔴 先編再改 HOME：把 HOME 指到暫存目錄後才 `go build`，Go 會把**唯讀的**模組快取
	//    寫進那個目錄，測試結束清不掉（實撞：TempDir RemoveAll permission denied）。
	bin := filepath.Join(t.TempDir(), "arcrun-app-test")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("編不出執行檔：%v\n%s", err, out)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL: "https://example.workers.dev",
			Namespace: "abc123",
			APIKey:    "abc123",
		}},
		Extractor: "workers-ai",
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}

	// 用剛才編好的執行檔自己當 collector 跑（＝supervisor 在真機上做的事）
	cmd := exec.Command(bin, collectorModeFlag, "direct", "--once", "--dry-run", "--config", configPath())
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
	out, err := cmd.CombinedOutput()

	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("跑不起來：%v", err)
	}

	if code == 2 {
		t.Fatalf("同步引擎以 exit status 2 結束＝設定被拒，就是 leo 撞到的無限重試。\n輸出：%s", out)
	}
	if strings.Contains(string(out), "缺必填欄位") {
		t.Fatalf("設定仍缺必填欄位：%s", out)
	}
	t.Logf("✅ 全新安裝的設定，同步引擎吃得下去（exit=%d）", code)
}
