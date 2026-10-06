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
	"strings"
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

	// 🔴 inkstone/arcrun-rag#58（取代原本的「金鑰要留著」）：Gemini 路已拔除，
	// 檔案裡的明碼金鑰必須一併消失——見下方 TestArcrunRag58ScrubsPlaintextGeminiKeys。
	if raw, rerr := os.ReadFile(p); rerr != nil {
		t.Fatal(rerr)
	} else if strings.Contains(string(raw), "old-key") {
		t.Errorf("① 明碼金鑰還留在 config.json 裡")
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

// t182②（inkstone/arcrun-rag#58 改寫）：以前「主動選過 Gemini 的人不被動到」。
// Gemini 路已拔除，主動選過的人也一律改走雲端 AI——否則他的萃取會落在一條不存在的路上。
func TestT182ExplicitGeminiChoiceIsMigratedToo(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":           filepath.Join(dir, "m.json"),
		"extractor":          "gemma",
		"extractor_explicit": true, // ← 使用者曾在「AI 設定…」主動選過
		"gemini_api_key":     "my-key",
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA", "watch_folders": []string{"/tmp/a"}},
		},
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if cfg.Extractor != "workers-ai" || cfg.Accounts[0].Extractor != "workers-ai" {
		t.Errorf("② 曾主動選過 Gemini 也要改走雲端 AI：top=%q acct=%q", cfg.Extractor, cfg.Accounts[0].Extractor)
	}
}

// 🔴 inkstone/arcrun-rag#58 驗收：`~/.arcrun-rag/config.json` 全文搜不到任何明碼金鑰。
// 票上實況＝頂層＋兩個帳號各一處（共 3 處）明碼 gemini_api_key；載入一次後檔案裡一處都不剩，
// 且不傷到其他欄位（連線、資料夾、帳號數）。冪等：第二次載入檔案位元組不變。
func TestArcrunRag58ScrubsPlaintextGeminiKeys(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":           filepath.Join(dir, "m.json"),
		"gemini_api_key":     "AIzaSyTOPSECRET0000000000000000000000",
		"llm_model":          "gemma-4-31b-it",
		"extractor":          "workers-ai",
		"extractor_explicit": true,
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA", "api_key": "nsA-key",
				"watch_folders": []string{"/tmp/a"}, "gemini_api_key": "AIzaSyACCT1SECRET00000000000000000000"},
			{"cypher_url": "https://b.example", "namespace": "nsB", "api_key": "nsB-key",
				"watch_folders": []string{"/tmp/b"}, "gemini_api_key": "AIzaSyACCT2SECRET00000000000000000000",
				"llm_model": "x"},
		},
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{"AIza", "gemini_api_key", "llm_model", "SECRET"} {
		if strings.Contains(string(raw), needle) {
			t.Errorf("config.json 還搜得到 %q：\n%s", needle, raw)
		}
	}
	// 其他設定不能被連帶弄丟
	if len(cfg.Accounts) != 2 || cfg.Accounts[1].Namespace != "nsB" || cfg.Accounts[1].APIKey != "nsB-key" {
		t.Errorf("帳號設定被弄壞：%+v", cfg.Accounts)
	}
	var onDisk struct {
		Accounts []struct {
			CypherURL string `json:"cypher_url"`
			APIKey    string `json:"api_key"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &onDisk); err != nil || len(onDisk.Accounts) != 2 ||
		onDisk.Accounts[0].CypherURL != "https://a.example" || onDisk.Accounts[0].APIKey != "nsA-key" {
		t.Errorf("回寫後帳號連線資料不對：%v %+v", err, onDisk)
	}
	// 冪等
	if _, err := LoadDirectConfig(p); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(p)
	if string(again) != string(raw) {
		t.Error("第二次載入又改了檔案（不冪等）")
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
