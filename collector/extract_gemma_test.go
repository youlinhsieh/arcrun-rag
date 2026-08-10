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
