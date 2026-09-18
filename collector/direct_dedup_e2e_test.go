// direct_dedup_e2e_test.go — inkstone/arcrun-rag#121 的驗收格「同一份內容以兩種格式丟進去 →
// 只被處理一次（貼證據）」的端到端證據。
//
// 為什麼另立一支：
//   scan_dedup_test.go 只驗到 Scan 層「同 stem 多格式只產一個 added 事件」，
//   而本票的驗收字面是「只被**萃取**、**送雲端**一次」——那是事件之後、extractor 與
//   rag_ingest_card 上雲那兩層的成本。09-17 分診（InkStoneCo#132 c7650）點名：
//   「這一格從沒有人貼過證據」。本測試補的就是那條證據：同內容兩格式同輪丟進去，
//   ①gemma 萃取恰好被呼叫一次 ②rag_ingest_card 的內容卡恰好上雲一次。
//
// 兩個成本點各記一個計數器，不靠推論：
//   - 萃取：gemma 替身每被打一次就 +1（extractWithWorkersAI 走不到，因為 Extractor=gemma）
//   - 上雲：假 cypher 每收到一張「內容卡」（非資料夾總覽）就 +1
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// 同一份內容、同檔名主幹、兩種都在 allowedExt 內的格式（.md 優先序高於 .txt），
// 活在兄弟目錄裡（照封測資料集 markdown/ vs txt/ 的實況）。
// 期望：dedup 留 .md、跳過 .txt ⇒ 萃取一次、內容卡上雲一次。
func TestDirectExtractor_FormatDuplicate_ExtractAndUploadOnce(t *testing.T) {
	root := t.TempDir()
	// 內容刻意「一字不差地相同」——忠實對應驗收的「同一份內容」，
	// 也防後人把 dedup 改成讀內容時，這支測試仍站得住。
	const body = "# 報銷規則\n\nM118/M128 不可同時使用；上限 3000 元。機密內容 XYZZY"
	writeSameContent(t, filepath.Join(root, "markdown", "報銷規則.md"), body)
	writeSameContent(t, filepath.Join(root, "txt", "報銷規則.txt"), body)

	// 假 cypher：數「內容卡」上雲幾次。
	// 排除機械卡（零 LLM）：資料夾總覽（「資料夾總覽：…」）與逐層資料夾卡（「資料夾：…」），
	// 它們是結構卡、不含萃取內容，隨資料夾數而變、與去重無關。真正的內容卡 page_name＝原稿 H1/主幹。
	var contentCardPosts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/webhooks/named/demo/rag_ingest_card/trigger") {
			bodyBytes, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(bodyBytes, &m)
			if pn, _ := m["page_name"].(string); !strings.HasPrefix(pn, "資料夾") {
				atomic.AddInt32(&contentCardPosts, 1)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	// gemma 替身：數萃取被呼叫幾次；每次都回同一張合格卡。
	var extractCalls int32
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&extractCalls, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("報銷規則", "財務")}}},
			}},
		})
	})()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}

	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d results=%+v", exit, results)
	}

	// ① 萃取只發生一次（loser 的 .txt 從未被萃取 ⇒ 不燒 AI）
	if got := atomic.LoadInt32(&extractCalls); got != 1 {
		t.Fatalf("同內容兩格式應只萃取 1 次，got %d（dedup 沒擋住 loser）", got)
	}
	// ② 內容卡只上雲一次（loser 的 .txt 從未送雲端 ⇒ 不燒額度、不重複消化）
	if got := atomic.LoadInt32(&contentCardPosts); got != 1 {
		t.Fatalf("同內容兩格式應只上雲 1 張內容卡，got %d", got)
	}

	// ③ 留下的是優先序較高的 .md（不是 .txt）；loser 沒有自己的內容 ingest 結果。
	// 只看真正的內容檔事件（Type=="added"）——資料夾結構卡（Type=="folder"）與去重無關。
	var added []DirectResult
	for _, r := range results {
		if r.Type == "added" {
			added = append(added, r)
		}
	}
	if len(added) != 1 {
		t.Fatalf("應恰好 1 個內容檔事件（winner），got %d：%+v", len(added), added)
	}
	if p := added[0].Path; p != filepath.FromSlash("markdown/報銷規則.md") {
		t.Fatalf("winner 應為優先序較高的 .md，got %q", p)
	}

	// ④ 第二輪：兩份都沒變 → 零事件、萃取與上雲次數都不再增加（loser 不會被誤判成新檔一直回報）
	results2, exit2, _ := RunDirectOnce(cfg, false)
	if exit2 != 0 || len(results2) != 0 {
		t.Fatalf("第二輪應零事件：exit=%d results=%+v", exit2, results2)
	}
	if got := atomic.LoadInt32(&extractCalls); got != 1 {
		t.Fatalf("第二輪不該再萃取，累計 got %d", got)
	}
	if got := atomic.LoadInt32(&contentCardPosts); got != 1 {
		t.Fatalf("第二輪不該再上雲，累計 got %d", got)
	}
}

func writeSameContent(t *testing.T, absPath, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
