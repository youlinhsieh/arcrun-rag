package collector

// inkstone/arcrun-rag#58：直呼 Gemini 的萃取路已拔除，「Gemini 思考型回應解析」「缺金鑰」
// 兩支測試隨之刪除；vault 保護是**路徑無關**的契約（落點與不覆蓋由 wikishape 決定），
// 改用唯一的萃取路（雲端 workers-ai）驗，保護不因換路而丟。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// vaultStub：雲端 /portal/daemon/extract 的替身，回一份固定的模型 JSON。
func vaultStub(t *testing.T, modelOutput string) (url string, closeFn func()) {
	t.Helper()
	return workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": modelOutput})
	})
}

// arcrun-rag#60 驗收核心：對著一個「長得像 Logseq vault」的資料夾跑萃取，
// 卡片不能落在 pages/、journals/ 或任何非隱藏目錄——vault 的頁面數不能因為
// daemon 跑過而增加。
func TestExtractWithWorkersAI_VaultDoesNotGainPages(t *testing.T) {
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

	stubURL, stubClose := vaultStub(t, cardFixture("會議記錄", "專案"))
	defer stubClose()

	pagesBefore := countMD(t, filepath.Join(root, "pages")) + countMD(t, filepath.Join(root, "journals")) + countTopLevelMD(t, root)

	cards, err := ExtractWithWorkersAI(stubURL, "k123", root, srcRel, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	// 原稿內容「# 原稿」⇒ 文件卡名＝H1「原稿」；`.wiki/` 是隱藏目錄，Logseq 不掃
	if len(cards) != 2 || cards[0] != ".wiki/原稿.md" {
		t.Fatalf("vault 目標的卡片路徑不對：%v，want [.wiki/原稿.md …]", cards)
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
	cardAbs := filepath.Join(root, ".wiki", "原稿.md")
	if _, err := os.Stat(cardAbs); err != nil {
		t.Fatalf("卡片沒有落在預期的隱藏目錄：%v", err)
	}
}

// 故意在 `.wiki/` 先放一個「不是本文件產的」同名檔案：不覆蓋、誠實報錯、原檔原封不動
// （#105 的分界：本來就在的檔案一律不動——wikishape 的 writeCard 以 manifest 認擁有權）。
func TestExtractWithWorkersAI_VaultExistingCardNotClobbered(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq"))
	srcRel := "x.md"
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte("# 既有主題\n內文"), 0o644); err != nil {
		t.Fatal(err)
	}
	cardDir := filepath.Join(root, ".wiki")
	mustMkdir(t, cardDir)
	preexisting := "# 既有主題\n這份是先前就存在的內容"
	cardPath := filepath.Join(cardDir, "既有主題.md")
	if err := os.WriteFile(cardPath, []byte(preexisting), 0o644); err != nil {
		t.Fatal(err)
	}

	stubURL, stubClose := vaultStub(t, cardFixture("既有主題", "專案"))
	defer stubClose()

	_, err := ExtractWithWorkersAI(stubURL, "k123", root, srcRel, testOrigin())
	if err == nil {
		t.Fatal("目標位置被別人佔用時應報錯，不得無聲覆蓋")
	}
	if !strings.Contains(err.Error(), "佔用") {
		t.Fatalf("錯誤訊息看不出原因：%v", err)
	}
	data, _ := os.ReadFile(cardPath)
	if string(data) != preexisting {
		t.Fatalf("既有檔案被動過：%q", data)
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
