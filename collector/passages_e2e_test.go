package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#296 端到端：敘述類新檔 → 切段送 rag_ingest_passages（沒有萃取、沒有卡）→
// manifest 記段數 → 改短重送會刪尾巴 → 刪檔把段落下架；表格類與關鍵資料夾照舊走萃卡（不碰 passages）。
func TestNarrativePassagesE2E(t *testing.T) {
	root := t.TempDir()
	long := "# 報銷政策\n\n## 差旅\n\n"
	for i := 0; i < 500; i++ {
		long += "第" + string(rune('A'+i%26)) + "條：出差住宿每晚上限三千元，必須附上發票才能報銷，逾期不受理。\n\n"
	}
	write := func(rel, s string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("報銷政策.md", long)
	write("b.md", "# B\n\n另一份。\n")
	write("c.md", "# C\n\n再一份。\n")
	write("d.md", "# D\n\n第四份。\n")

	var passageCalls []map[string]any
	var otherPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree"):
		case strings.HasSuffix(r.URL.Path, "/rag_ingest_passages/trigger"):
			b, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			passageCalls = append(passageCalls, m)
		default:
			otherPaths = append(otherPaths, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	cfg := &DirectConfig{
		WatchFolders: []string{root}, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true, MaxRemoved: DefaultMaxRemovedRatio,
		NarrativeRoute: "passages",
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d %+v", exit, results)
	}
	if len(passageCalls) < 2 {
		t.Fatalf("長文應分批送：%d 發", len(passageCalls))
	}
	total := 0
	var mine []map[string]any
	for _, c := range passageCalls {
		if c["machine"] == "" || c["source_hash"] == "" {
			t.Fatalf("欄位不全：%+v", c)
		}
		if c["path"] == "報銷政策.md" {
			mine = append(mine, c)
			total += len(c["passages"].([]any))
		}
	}
	if len(mine) < 2 {
		t.Fatalf("長文應分批送：%d 發", len(mine))
	}
	extractCalls := 0
	for _, p := range otherPaths {
		if strings.HasSuffix(p, "/portal/daemon/extract") {
			extractCalls++
		}
	}
	if extractCalls > 1 { // 每輪一發的「雲端 AI 通了沒」探測不算；逐檔萃取才算
		t.Fatalf("新路不該逐檔呼叫雲端萃取：%d 發", extractCalls)
	}
	mp, _ := filepath.Abs(cfg.manifestPathFor(root))
	m, err := LoadManifest(mp, root)
	if err != nil {
		t.Fatal(err)
	}
	e := m.Entries["報銷政策.md"]
	if e == nil || !e.PassageMode || e.PassageCount != total || !e.NoCloudCard || e.IngestedHash == "" {
		t.Fatalf("manifest 不對：%+v（total=%d）", e, total)
	}
	if _, err := os.Stat(filepath.Join(root, ".wiki", "報銷政策.md")); err == nil {
		t.Fatal("新路不該產生知識卡")
	}

	// 第二輪沒變 ⇒ 不重送
	passageCalls = nil
	RunDirectOnce(cfg, false)
	if len(passageCalls) != 0 {
		t.Fatalf("內容沒變不該重送：%d", len(passageCalls))
	}

	// 改短 ⇒ 覆寫前段、刪尾巴
	write("報銷政策.md", "# 報銷政策\n\n只剩一小段。\n")
	RunDirectOnce(cfg, false)
	var deleted int
	for _, c := range passageCalls {
		if c["path"] != "報銷政策.md" {
			continue
		}
		deleted += len(c["delete_ids"].([]any))
	}
	if deleted != total-1 {
		t.Fatalf("應刪掉舊版多出的 %d 段，got %d", total-1, deleted)
	}

	// 刪檔 ⇒ 整份下架（刪 0..n-1）
	passageCalls = nil
	_ = os.Remove(filepath.Join(root, "報銷政策.md"))
	RunDirectOnce(cfg, false)
	deleted = 0
	for _, c := range passageCalls {
		if c["path"] != "報銷政策.md" {
			continue
		}
		deleted += len(c["delete_ids"].([]any))
	}
	if deleted != 1 {
		t.Fatalf("下架應刪 1 段，got %d", deleted)
	}
}
