package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// leo 2026-08-06 在 Windows 上真實壞掉的那份 config（逐字，只把值改成假的）。
// 它剛好只有 saveCfg 會寫的四個鍵 —— 那就是「App 自己存出來、但少了必填欄位」的鐵證。
const leoBrokenConfig = `{
  "accounts": [{"cypher_url":"https://x.workers.dev","namespace":"abc123","api_key":"abc123"}],
  "extractor": "workers-ai",
  "extractor_explicit": true,
  "gemini_api_key": ""
}`

// TestExistingBrokenConfigSelfHeals 釘住我**第一次修錯**的那條路：
//
//	只在 saveCfg 補必填欄位 ⇒ 全新安裝好了，但**已經存在的壞設定永遠修不好**，
//	因為 App 開起來只是「讀 config → 啟動引擎」，saveCfg 根本沒被呼叫。
//	leo 裝了 v0.18.12 仍看到同一句「缺必填欄位：manifest」、重試 30 次。
//
// 所以這支測試從**磁碟上已存在的壞 config** 出發，而不是從 saveCfg 出發。
func TestExistingBrokenConfigSelfHeals(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "arcrun-app-test")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("編不出執行檔：%v\n%s", err, out)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(), []byte(leoBrokenConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	// App 讀一次 config —— 這就是使用者「打開程式」會發生的事
	if _, err := loadCfg(); err != nil {
		t.Fatalf("讀不了 config：%v", err)
	}

	// 修復必須**寫回磁碟**：collector 是另一個行程，讀的是磁碟那份，不是記憶體
	raw, err := os.ReadFile(configPath())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("修完不是合法 JSON：%v", err)
	}
	if s, _ := m["manifest"].(string); strings.TrimSpace(s) == "" {
		t.Fatal("讀取後沒把 manifest 補進磁碟 ⇒ collector 仍會 exit 2（就是 leo v0.18.12 撞到的）")
	}

	// 終極驗收：真的把執行檔當 collector 跑，不能再是 exit 2
	cmd := exec.Command(bin, collectorModeFlag, "direct", "--once", "--dry-run", "--config", configPath())
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	if code == 2 || strings.Contains(string(out), "缺必填欄位") {
		t.Fatalf("舊 config 修復後同步引擎仍被拒（exit=%d）：%s", code, out)
	}
}
