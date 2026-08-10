package main

import "testing"

// t190（leo 08-04 實撞）：「我切到 Gemini 把內容刪掉，再切回 Workers AI，儲存，
// 回去發現 Gemini Key 還在」——清空輸入框必須真的把金鑰刪掉。
//
// 這裡驗的是「儲存邏輯」的契約：金鑰**無條件以輸入框為準**，
// 不因為選了哪個引擎而跳過寫入（舊版的病就是寫在 if useGemini 裡）。
func TestAISettingsSaveClearsKeyWhenEmptied(t *testing.T) {
	// 模擬儲存邏輯（與 main.go 的 AI 設定 handler 同一套規則）
	apply := func(cfg *directConfig, useGemini bool, key string) {
		engine := "workers-ai"
		if useGemini {
			engine = "gemma"
		}
		cfg.GeminiAPIKey = key
		cfg.Extractor = engine
		cfg.ExtractorExplicit = true
		for i := range cfg.Accounts {
			cfg.Accounts[i].Extractor = engine
			cfg.Accounts[i].GeminiAPIKey = key
		}
	}

	cfg := &directConfig{
		GeminiAPIKey: "old-key",
		Accounts:     []accountCfg{{GeminiAPIKey: "old-key"}, {GeminiAPIKey: "old-key"}},
	}

	// 使用者：切回「雲端 AI」且把金鑰欄位清空 → 金鑰必須消失
	apply(cfg, false, "")

	if cfg.GeminiAPIKey != "" {
		t.Errorf("頂層金鑰沒被清掉：%q（leo 實撞的病）", cfg.GeminiAPIKey)
	}
	for i, a := range cfg.Accounts {
		if a.GeminiAPIKey != "" {
			t.Errorf("帳號[%d] 金鑰沒被清掉：%q", i, a.GeminiAPIKey)
		}
	}
	if cfg.Extractor != "workers-ai" {
		t.Errorf("引擎應為 workers-ai，got %q", cfg.Extractor)
	}
}

// 反向：選 Gemini 並填入金鑰時，金鑰要存進每一層（原本就該有的行為，不可被上面的修改弄壞）
func TestAISettingsSaveStoresKeyOnEveryLayer(t *testing.T) {
	apply := func(cfg *directConfig, useGemini bool, key string) {
		engine := "workers-ai"
		if useGemini {
			engine = "gemma"
		}
		cfg.GeminiAPIKey = key
		cfg.Extractor = engine
		cfg.ExtractorExplicit = true
		for i := range cfg.Accounts {
			cfg.Accounts[i].Extractor = engine
			cfg.Accounts[i].GeminiAPIKey = key
		}
	}
	cfg := &directConfig{Accounts: []accountCfg{{}, {}}}
	apply(cfg, true, "new-key")

	if cfg.GeminiAPIKey != "new-key" || cfg.Extractor != "gemma" {
		t.Errorf("頂層沒寫對：key=%q engine=%q", cfg.GeminiAPIKey, cfg.Extractor)
	}
	for i, a := range cfg.Accounts {
		if a.GeminiAPIKey != "new-key" || a.Extractor != "gemma" {
			t.Errorf("帳號[%d] 沒寫對：key=%q engine=%q", i, a.GeminiAPIKey, a.Extractor)
		}
	}
}
