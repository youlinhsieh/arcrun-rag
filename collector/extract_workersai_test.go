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

	cards, err := ExtractWithWorkersAI(url, "key123", root, srcRel)
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

	cards, err := ExtractWithWorkersAI(url, "key123", root, srcRel)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != "system-dev/wiki/cards/arcrun-note.md" {
		t.Fatalf("非 vault 卡片路徑不對：%v，want [system-dev/wiki/cards/arcrun-note.md]", cards)
	}
}
