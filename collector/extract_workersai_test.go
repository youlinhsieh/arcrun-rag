// extract_workersai_test.go — arcrun-rag#60：workers-ai 是預設/主線萃取路（t181），
// 同一套 vault 保護要對這條路也成立，不能只顧 gemma。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workersAIStub(t *testing.T, handler http.HandlerFunc) (url string, closeFn func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	return srv.URL, srv.Close
}

func TestExtractWithWorkersAI_VaultRedirectsAndDoesNotClobber(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, ".obsidian")) // Obsidian vault
	srcRel := "note.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 隱藏卡片目錄裡先放一份既有內容，驗證不會被無聲蓋掉。
	// 檔名帶 arcrun- 前綴＝第二輪之後卡片真正的名字（machinemark.go）。
	cardDir := filepath.Join(root, ".arcrun-rag", "wiki", "cards")
	mustMkdir(t, cardDir)
	preexisting := "# note\n既有內容"
	if err := os.WriteFile(filepath.Join(cardDir, "arcrun-note.md"), []byte(preexisting), 0o644); err != nil {
		t.Fatal(err)
	}

	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Arcrun-API-Key") != "key123" {
			t.Errorf("api key 未帶到 header")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"card":    "# note\n## 一句話定義\n新卡\n",
		})
	})
	defer closeFn()

	cards, err := ExtractWithWorkersAI(url, "key123", root, srcRel, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != ".arcrun-rag/wiki/cards/arcrun-note.md" {
		t.Fatalf("vault 目標的卡片路徑不對：%v，want [.arcrun-rag/wiki/cards/arcrun-note.md]", cards)
	}

	// pages/.obsidian 之外沒有新增任何非隱藏 .md（Obsidian 不掃描 .arcrun-rag/）。
	topLevel := countMD(t, root)
	if topLevel != 1 { // 只有原本的 srcRel
		t.Fatalf("vault 根目錄多出非預期的 .md：count=%d", topLevel)
	}

	// 既有卡片必須被備份，不能無聲覆蓋。
	entries, err := os.ReadDir(cardDir)
	if err != nil {
		t.Fatal(err)
	}
	var foundBackup bool
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "arcrun-note.md.bak-") {
			foundBackup = true
		}
	}
	if !foundBackup {
		t.Fatalf("既有卡片沒有被備份，目錄內容：%v", entries)
	}
}

// 非 vault：卡片仍落 system-dev/wiki/cards/（目錄不變），但檔名同樣帶標記。
//
// 🔴 第二輪刻意讓「vault 與非 vault 用同一條命名規則」：紅線是「前綴只准一種、
// 不要一部分加一部分不加」。若只在 vault 加前綴，一般資料夾的使用者照樣分不出
// 哪些檔是機器寫的——而 system-dev/wiki/cards/ 在他的檔案總管裡是**看得見**的。
func TestExtractWithWorkersAI_NonVaultUnchanged(t *testing.T) {
	root := t.TempDir()
	srcRel := "note.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"card":    "# note\n## 一句話定義\n新卡\n",
		})
	})
	defer closeFn()

	cards, err := ExtractWithWorkersAI(url, "key123", root, srcRel, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != "system-dev/wiki/cards/arcrun-note.md" {
		t.Fatalf("非 vault 卡片路徑不對：%v，want [system-dev/wiki/cards/arcrun-note.md]", cards)
	}
}

// ── Arcrun#134：workers-ai 路與 gemma 路共用同一份契約 ─────────────────────────
//
// 修法＝daemon 把 wikiExtractPrompt 整段帶去雲端（request `prompt` 欄位），
// 雲端只回模型原文（response `output`），解析與組卡回到本 package 與 gemma 路
// 同一段程式碼。⇒ 「兩條路的卡同形」不再是兩份 prompt 各自維持的巧合，
// 是同一份程式碼的必然。以下兩則就是這句話的機械守衛；
// 檔案上方兩則既有測試（stub 只回 `card`）則守住「舊雲端 fallback 不斷炊」。

// request 必帶 prompt，且必須就是 wikiExtractPrompt 本人——不是另一份手抄。
func TestExtractWithWorkersAI_SendsSharedPrompt(t *testing.T) {
	root := t.TempDir()
	const srcName = "報銷規則.md"
	const srcBody = "# 報銷規則\n\n內文"
	if err := os.WriteFile(filepath.Join(root, srcName), []byte(srcBody), 0o644); err != nil {
		t.Fatal(err)
	}
	var gotPrompt string
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotPrompt = req["prompt"]
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"output":  cardFixture("報銷規則", "財務"),
		})
	})
	defer closeFn()

	if _, err := ExtractWithWorkersAI(url, "key123", root, srcName, testOrigin()); err != nil {
		t.Fatal(err)
	}
	srcText, err := ConvertToText(srcName, []byte(srcBody))
	if err != nil {
		t.Fatal(err)
	}
	if want := wikiExtractPrompt("報銷規則", srcText); gotPrompt != want {
		t.Fatalf("送上雲的 prompt 不是共用那份 wikiExtractPrompt（len got=%d want=%d）", len(gotPrompt), len(want))
	}
}
