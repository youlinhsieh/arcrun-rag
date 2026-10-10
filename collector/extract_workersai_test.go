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

// ── Arcrun#299：指示住雲端那張表，小幫手只送「這段是哪一類」 ───────────────────
//
// Arcrun#134 時代小幫手把 208 行提示詞整段帶上雲；#299 起改成雲端一張有 key、有版本的表，
// 小幫手只送 prompt_table＋kinds（讀檔特例編號）＋hints（機械掃出的資料）。
// 以下守衛：①請求裡**不准再出現整段 prompt**（出現＝又養了第二份指示）
// ②一般文件不帶任何類別 ③重複條目結構（chunk-cliff）帶上類別與候選清單。
// 檔案上方兩則既有測試（stub 只回 `card`）仍守住「舊雲端 fallback 不斷炊」。

func captureExtractRequest(t *testing.T, srcBody string) map[string]any {
	t.Helper()
	root := t.TempDir()
	const srcName = "報銷規則.md"
	if err := os.WriteFile(filepath.Join(root, srcName), []byte(srcBody), 0o644); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"output":  cardFixture("報銷規則", "財務"),
			"prompt":  map[string]any{"name": "extract_wiki", "source": "builtin", "blocks": []string{"common.role@1"}},
		})
	})
	defer closeFn()
	if _, err := ExtractWithWorkersAI(url, "key123", root, srcName, testOrigin()); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestExtractWithWorkersAI_SendsTableNotPrompt(t *testing.T) {
	got := captureExtractRequest(t, "# 報銷規則\n\n內文")
	if _, has := got["prompt"]; has {
		t.Fatalf("請求還帶著整段 prompt——指示應該住雲端那張表（Arcrun#299）：%v", got["prompt"])
	}
	if got["prompt_table"] != "extract_wiki" {
		t.Fatalf("prompt_table = %v，want extract_wiki", got["prompt_table"])
	}
	if kinds, _ := got["kinds"].([]any); len(kinds) != 0 {
		t.Fatalf("一般文件不該帶任何類別：%v", kinds)
	}
}

func TestExtractWithWorkersAI_RepeatedRecordsSendChunkCliff(t *testing.T) {
	var b strings.Builder
	for _, code := range []string{"E101", "E102", "E103", "E104"} {
		b.WriteString(code + "\nERROR MESSAGE\n某訊息\nCAUSE OF ERROR\n某原因\n")
	}
	got := captureExtractRequest(t, b.String())
	kinds, _ := got["kinds"].([]any)
	if len(kinds) != 1 || kinds[0] != "chunk-cliff" {
		t.Fatalf("kinds = %v，want [chunk-cliff]", kinds)
	}
	hints, _ := got["hints"].(map[string]any)
	labels, _ := hints["labels"].([]any)
	if len(labels) != 4 || labels[0] != "E101" || labels[3] != "E104" {
		t.Fatalf("hints.labels = %v，want E101..E104", labels)
	}
}
