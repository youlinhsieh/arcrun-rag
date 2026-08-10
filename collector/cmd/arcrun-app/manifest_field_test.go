package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	collector "arcrun-rag/collector"
)

// TestFreshConfigIsUsableByCollector 釘住 leo 2026-08-06 Windows 封測的真兇：
//
//	App 存出來的**全新** config 少了 `manifest` 這個必填欄位
//	⇒ collector 一啟動就 exit status 2 ⇒ supervisor 無限重拉
//	⇒ 畫面在「看守中／沒有在跑」之間閃、加資料夾也沒反應。
//
// 為什麼一路活到封測：開發機的 config 是舊版留下的、早就有這一欄
// ——「我這台好好的」正是它能活下來的原因。所以這支測試**從零建 config**。
func TestFreshConfigIsUsableByCollector(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // Windows 的家目錄變數

	// 模擬全新安裝：完全沒有 config，使用者連上一個知識庫後存檔
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

	raw, err := os.ReadFile(configPath())
	if err != nil {
		t.Fatalf("讀不回剛存的 config：%v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("存出來的不是合法 JSON：%v", err)
	}
	if s, _ := m["manifest"].(string); strings.TrimSpace(s) == "" {
		t.Fatal("全新 config 沒有 manifest ⇒ collector 會 exit 2 無限重試（就是 leo 撞到的那個）")
	}

	// 真正的驗收不是「欄位在不在」，是**collector 吃不吃得下去**。
	if _, err := collector.LoadDirectConfig(configPath()); err != nil {
		t.Fatalf("collector 讀不了 App 存的 config：%v", err)
	}

	// manifest 要落在 app 目錄下，不能指到別人家
	if got, _ := m["manifest"].(string); filepath.Dir(got) != appDir() {
		t.Errorf("manifest 應該放在 %s，實得 %s", appDir(), got)
	}
}
