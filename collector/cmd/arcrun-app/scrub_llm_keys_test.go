package main

import (
	"os"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#58 驗收（桌面小幫手那半）：
// 「`~/.arcrun-rag/config.json` 全文搜不到任何明碼金鑰」。
//
// 票上實況＝頂層＋兩個帳號各一處、共 3 處明碼 gemini_api_key。
// 兩條路都要驗：① 打開 App（只讀）就抹掉並寫回；② 之後 App 自己存檔，舊金鑰不會從 raw 回流。
const configWithPlaintextKeys = `{
  "manifest": "/tmp/m.json",
  "extractor": "workers-ai",
  "gemini_api_key": "AIzaSyTOPLEVELSECRET000000000000000000",
  "llm_model": "gemma-4-31b-it",
  "poll_interval_sec": 7,
  "accounts": [
    {"cypher_url":"https://a.workers.dev","namespace":"nsA","api_key":"nsA","gemini_api_key":"AIzaSyACCOUNTASECRET0000000000000000"},
    {"cypher_url":"https://b.workers.dev","namespace":"nsB","api_key":"nsB","gemini_api_key":"AIzaSyACCOUNTBSECRET0000000000000000"}
  ]
}`

func assertNoKeys(t *testing.T, when string) {
	t.Helper()
	raw, err := os.ReadFile(configPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{"AIza", "SECRET", "gemini_api_key", "llm_model"} {
		if strings.Contains(string(raw), needle) {
			t.Errorf("%s：config.json 還搜得到 %q\n%s", when, needle, raw)
		}
	}
}

func TestLoadCfgScrubsPlaintextLLMKeysAndSaveDoesNotBringThemBack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(), []byte(configWithPlaintextKeys), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadCfg() // 使用者「打開程式」＝只讀
	if err != nil {
		t.Fatal(err)
	}
	assertNoKeys(t, "只讀一次之後")

	// 不能連帶弄丟別的設定
	if len(cfg.Accounts) != 2 || cfg.Accounts[1].Namespace != "nsB" || cfg.Accounts[1].APIKey != "nsB" {
		t.Fatalf("帳號設定被弄壞：%+v", cfg.Accounts)
	}
	raw, _ := os.ReadFile(configPath())
	if !strings.Contains(string(raw), `"poll_interval_sec": 7`) {
		t.Errorf("未宣告的欄位（poll_interval_sec）被抹掉了：%s", raw)
	}

	// App 自己存檔（例如新增資料夾）之後，舊金鑰也不能從記憶體裡的 raw 回流
	cfg.Accounts[0].WatchFolders = []string{"/tmp/x"}
	if err := saveCfg(cfg); err != nil {
		t.Fatal(err)
	}
	assertNoKeys(t, "saveCfg 之後")

	// 冪等：再讀一次不改檔案
	before, _ := os.ReadFile(configPath())
	if _, err := loadCfg(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(configPath())
	if string(before) != string(after) {
		t.Error("第二次讀取又改了檔案（不冪等）")
	}
}
