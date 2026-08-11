// extract_gemma_test.go — task 4（httptest 替身：驗 prompt 契約/thought 淨化/落卡）。
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

func gemmaStub(t *testing.T, handler http.HandlerFunc) func() {
	t.Helper()
	srv := httptest.NewServer(handler)
	old := gemmaBaseURL
	gemmaBaseURL = srv.URL
	return func() { gemmaBaseURL = old; srv.Close() }
}

// happy path：思考型回應（parts[0]=thought）→ 取最後非 thought part、去草稿、落卡。
func TestExtractWithGemmaThinkingModel(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "會議記錄.md"), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "k123" {
			t.Errorf("api key 未帶到 header")
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		b, _ := json.Marshal(req)
		if !strings.Contains(string(b), "# 會議記錄") {
			t.Errorf("prompt 未帶頁名")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{
					{"thought": true, "text": "let me think..."},
					{"text": "草稿雜訊\n# 會議記錄\n## 一句話定義\n測試卡\n"},
				}},
			}},
		})
	})()
	cards, err := ExtractWithGemma("k123", "gemma-test", root, "會議記錄.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != "system-dev/wiki/cards/會議記錄.md" {
		t.Fatalf("cards=%v", cards)
	}
	data, _ := os.ReadFile(filepath.Join(root, "system-dev", "wiki", "cards", "會議記錄.md"))
	if !strings.HasPrefix(string(data), "# 會議記錄") {
		t.Fatalf("卡片未淨化（應從最後的 # 頁名 起）：%.80s", string(data))
	}
	if strings.Contains(string(data), "草稿雜訊") {
		t.Fatal("思考草稿洩入卡片")
	}
}

// thought-only 回應＝誠實報錯。
func TestExtractWithGemmaThoughtOnly(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "x.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"thought": true, "text": "..."}}},
			}},
		})
	})()
	if _, err := ExtractWithGemma("k", "m", root, "x.md"); err == nil {
		t.Fatal("thought-only 應報錯")
	}
}

// 缺 key＝引導訊息。
func TestExtractWithGemmaNoKey(t *testing.T) {
	if _, err := ExtractWithGemma("", "m", t.TempDir(), "x.md"); err == nil {
		t.Fatal("缺 key 應報錯")
	}
}

// arcrun-rag#60 驗收核心：對著一個「長得像 Logseq vault」的資料夾跑萃取，
// 卡片不能落在 pages/、journals/ 或任何非隱藏目錄——vault 的頁面數不能因為
// daemon 跑過而增加。
func TestExtractWithGemma_VaultDoesNotGainPages(t *testing.T) {
	root := t.TempDir()
	// 造一個像真的 Logseq vault：有 logseq/、pages/、journals/，journals 裡放一篇
	// leo 自己的日記（模擬「原稿」，萃取對象另外放在 vault 根目錄下）。
	mustMkdir(t, filepath.Join(root, "logseq"))
	mustMkdir(t, filepath.Join(root, "pages"))
	mustMkdir(t, filepath.Join(root, "journals"))
	journalPath := filepath.Join(root, "journals", "2026_08_08.md")
	journalContent := "leo 原話原圖，不該被動"
	if err := os.WriteFile(journalPath, []byte(journalContent), 0o644); err != nil {
		t.Fatal(err)
	}
	// 監看到的來源檔（相對 vault 根）——模擬使用者丟進 vault 的一份原稿。
	srcRel := "會議記錄.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}

	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{
					{"text": "# 會議記錄\n## 一句話定義\n測試卡\n"},
				}},
			}},
		})
	})()

	pagesBefore := countMD(t, filepath.Join(root, "pages")) + countMD(t, filepath.Join(root, "journals")) + countTopLevelMD(t, root)

	cards, err := ExtractWithGemma("k123", "gemma-test", root, srcRel)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != ".arcrun-rag/wiki/cards/會議記錄.md" {
		t.Fatalf("vault 目標的卡片路徑不對：%v，want [.arcrun-rag/wiki/cards/會議記錄.md]", cards)
	}

	pagesAfter := countMD(t, filepath.Join(root, "pages")) + countMD(t, filepath.Join(root, "journals")) + countTopLevelMD(t, root)
	if pagesAfter != pagesBefore {
		t.Fatalf("vault 頁面數增加了：before=%d after=%d（daemon 跑完不該讓 Logseq 多任何頁）", pagesBefore, pagesAfter)
	}

	// 原稿（journals 裡 leo 的日記）必須原封不動。
	got, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != journalContent {
		t.Fatalf("journals 原稿被動過：%q", got)
	}

	// 卡片確實落在隱藏目錄，且是「監看根底下」（呼叫端 absRoot-relative 假設仍成立）。
	cardAbs := filepath.Join(root, ".arcrun-rag", "wiki", "cards", "會議記錄.md")
	if _, err := os.Stat(cardAbs); err != nil {
		t.Fatalf("卡片沒有落在預期的隱藏目錄：%v", err)
	}
}

// 故意在 vault 的隱藏卡片目錄放一個同名檔案，跑完必須被備份、不能無聲蓋掉。
func TestExtractWithGemma_VaultExistingCardNotClobbered(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	srcRel := "x.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}
	cardDir := filepath.Join(root, ".arcrun-rag", "wiki", "cards")
	mustMkdir(t, cardDir)
	preexisting := "# x\n這份是先前就存在的內容"
	cardPath := filepath.Join(cardDir, "x.md")
	if err := os.WriteFile(cardPath, []byte(preexisting), 0o644); err != nil {
		t.Fatal(err)
	}

	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{
					{"text": "# x\n## 一句話定義\n新卡\n"},
				}},
			}},
		})
	})()

	if _, err := ExtractWithGemma("k123", "gemma-test", root, srcRel); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(cardDir)
	if err != nil {
		t.Fatal(err)
	}
	var foundBackup bool
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "x.md.bak-") {
			foundBackup = true
			data, _ := os.ReadFile(filepath.Join(cardDir, e.Name()))
			if string(data) != preexisting {
				t.Fatalf("備份內容不對：%q", data)
			}
		}
	}
	if !foundBackup {
		t.Fatalf("既有卡片沒有被備份，可能被無聲覆蓋。目錄內容：%v", entries)
	}
}

func countMD(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			n++
		}
	}
	return n
}

func countTopLevelMD(t *testing.T, dir string) int {
	return countMD(t, dir)
}
