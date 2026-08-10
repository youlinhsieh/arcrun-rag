package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestDefaultLibraryEndToEndDryRun 是 default_library_test.go 的補強：那邊驗證的是
// 「App 這一層的邏輯對不對」（單元層級），這支驗證的是**真的把同步引擎跑起來**，
// 證明預設庫裡的檔案真的會被 collector 認成「要處理的事件」——也就是
// 「丟檔 → 知識卡」那條路的前半段真的通，不是紙上談兵。
// 用 --dry-run：collector 掃到 added 事件後回報 status="planned" 就收手，
// 不會真的打雲端（沒有真的知識庫可以打），也不寫 manifest。
func TestDefaultLibraryEndToEndDryRun(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "arcrun-app-e2e")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("編不出執行檔：%v\n%s", err, out)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// ① 全新安裝、第一次連上知識庫 ⇒ 應該自動長出預設庫
	srv := fakeDaemonConfigServer(t, "https://instance-e2e.example.workers.dev")
	app := &App{}
	if err := app.Connect(srv.URL, "evan@example.com", "pw"); err != nil {
		t.Fatalf("Connect 失敗：%v", err)
	}
	libPath := defaultLibraryPath()

	run := func(label string) string {
		t.Helper()
		cmd := exec.Command(bin, collectorModeFlag, "direct", "--once", "--dry-run", "--config", configPath())
		cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
		out, _ := cmd.CombinedOutput() // 非零結束碼也要看輸出，不提前判死
		t.Logf("=== %s ===\n%s", label, out)
		return string(out)
	}

	// ② 真的跑一輪：三份示範檔應該被辨識成 planned（＝萃取管線願意收）
	out := run("① 全新安裝，預設庫存在")
	plannedCount := strings.Count(out, `"status": "planned"`)
	if plannedCount < len(defaultLibraryFiles) {
		t.Fatalf("預設庫的 %d 份示範檔應該全部被排進處理佇列（status=planned），"+
			"實際只看到 %d 次，輸出：\n%s", len(defaultLibraryFiles), plannedCount, out)
	}
	if strings.Contains(out, "缺必填欄位") {
		t.Fatalf("設定缺必填欄位：%s", out)
	}

	// ③ 使用者把預設庫整個刪掉
	if err := os.RemoveAll(libPath); err != nil {
		t.Fatalf("刪除失敗：%v", err)
	}
	if _, err := os.Stat(libPath); !os.IsNotExist(err) {
		t.Fatalf("刪除沒生效：%v", err)
	}

	// App 下一次讀狀態時的自我修復（等同 GetState 裡的那段）：清掉殘留引用
	cfg, err := loadCfg()
	if err != nil {
		t.Fatalf("讀不回設定：%v", err)
	}
	if !pruneMissingDefaultLibrary(cfg) {
		t.Fatal("應該偵測到預設庫已被刪除")
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}

	// ④ 再跑一輪：不該再處理那三份檔（資料夾不在了），也不該把資料夾生回來
	out2 := run("② 刪除後再跑一輪")
	if strings.Contains(out2, `"status": "planned"`) {
		t.Fatalf("刪除後不該還有 planned 事件，輸出：\n%s", out2)
	}
	if _, err := os.Stat(libPath); !os.IsNotExist(err) {
		t.Fatalf("預設庫刪掉後又被同步引擎生回來了：%v", err)
	}

	// ⑤ marker 檔還在 ⇒ 就算再跑一次種子邏輯，也不會再出現（紅線②③④一次證完）
	seedDefaultLibraryIfFirstEver(cfg, 0)
	if _, err := os.Stat(libPath); !os.IsNotExist(err) {
		t.Fatalf("種子邏輯把已刪除的預設庫又生回來了：%v", err)
	}
}
