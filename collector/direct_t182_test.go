// direct_t182_test.go — t182：老 config 必須被**抹除**成 Workers AI（leo 2026-08-04）。
//
//	「如果是我的 config 保持舊的，那新版裝上就要檢查，因為已經是 default worker AI，
//	 **就要抹除改成用 Workers AI**，如果保持 Gemini 它不會改掉，**那就是失敗的**」
//
// 這組測試守的是 leo 08-04 實撞的三個真 bug：
//  1. 更新到 v0.15.5 後托盤**兩個帳號都還顯示 Gemini**（帳號層舊值沒清）
//  2. 丟 PDF 進去**產不出卡**（因為根本沒走到 Workers AI，還在跑 Gemini）
//  3. `workers-ai` 不在合法值清單裡 ⇒ 一旦寫進 config，daemon 直接起不來
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// t182①：老 config（extractor=gemma、帳號層也是 gemma、無 explicit）
// → 每一層都要被抹成 workers-ai，而且**要寫回檔案**。
func TestT182ErasesLegacyExtractorAllLayers(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":       filepath.Join(dir, "m.json"),
		"extractor":      "gemma", // 舊值：頂層
		"gemini_api_key": "old-key",
		// 注意：**沒有** extractor_explicit ⇒ 使用者從沒主動選過
		"accounts": []map[string]any{
			{
				"cypher_url": "https://a.example", "namespace": "nsA",
				"watch_folders": []string{"/tmp/a"},
				"extractor":     "gemma", // 舊值：帳號層（leo 的 config 正是這樣）
			},
			{
				"cypher_url": "https://b.example", "namespace": "nsB",
				"watch_folders": []string{"/tmp/b"},
				"extractor":     "claude", // 更舊的殘留值
			},
		},
	})

	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if cfg.Extractor != "workers-ai" {
		t.Errorf("① 頂層沒被抹除：got %q want workers-ai", cfg.Extractor)
	}
	for i, a := range cfg.Accounts {
		if a.Extractor != "workers-ai" {
			t.Errorf("① 帳號[%d] 沒被抹除：got %q want workers-ai（leo 實撞：兩個帳號都還顯示 Gemini）", i, a.Extractor)
		}
	}

	// 金鑰要留著——Gemini 只是變選配，不是廢除（leo：「客戶說他要用 Gemini」）
	if cfg.GeminiAPIKey != "old-key" {
		t.Errorf("① Gemini 金鑰不該被清掉：got %q", cfg.GeminiAPIKey)
	}

	// 真的寫回檔案了嗎？（只改記憶體 ⇒ 托盤是另一個行程，還是會念 Gemini）
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk struct {
		Extractor string `json:"extractor"`
		Accounts  []struct {
			Extractor string `json:"extractor"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatal(err)
	}
	if onDisk.Extractor != "workers-ai" {
		t.Errorf("① **沒寫回檔案**：磁碟上頂層仍為 %q ⇒ 托盤下次讀還是念 Gemini", onDisk.Extractor)
	}
	for i, a := range onDisk.Accounts {
		if a.Extractor != "workers-ai" {
			t.Errorf("① **沒寫回檔案**：磁碟上帳號[%d] 仍為 %q", i, a.Extractor)
		}
	}
}

// t182②：主動選過 Gemini 的人不被動到（Gemini 是選配、不是廢除）。
func TestT182KeepsExplicitGeminiChoice(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":           filepath.Join(dir, "m.json"),
		"extractor":          "gemma",
		"extractor_explicit": true, // ← 使用者在「AI 設定…」主動選過
		"gemini_api_key":     "my-key",
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA", "watch_folders": []string{"/tmp/a"}},
		},
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if cfg.Extractor != "gemma" {
		t.Errorf("② 主動選過 Gemini 不該被抹掉：got %q", cfg.Extractor)
	}
}

// t182③：`workers-ai` 必須是合法值——否則寫進 config 後 daemon 直接起不來。
// （v0.15.5 就踩到這顆：預設改了、驗證器沒跟上。）
func TestT182WorkersAIIsValidExtractor(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":           filepath.Join(dir, "m.json"),
		"extractor":          "workers-ai",
		"extractor_explicit": true,
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA", "watch_folders": []string{"/tmp/a"}},
		},
	})
	if _, err := LoadDirectConfig(p); err != nil {
		t.Fatalf("③ workers-ai 應為合法值，卻載入失敗：%v", err)
	}
}

// t182④：冪等——已是 workers-ai 再載一次不應改動任何東西。
func TestT182MigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":  filepath.Join(dir, "m.json"),
		"extractor": "workers-ai",
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA",
				"watch_folders": []string{"/tmp/a"}, "extractor": "workers-ai"},
		},
	})
	before, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDirectConfig(p); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("④ 已是 workers-ai 不該再改寫檔案（非冪等＝每次啟動都寫一次磁碟）")
	}
}
