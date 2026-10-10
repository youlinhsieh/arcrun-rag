// contenttwin_test.go — inkstone/arcrun-rag#246 c18734：同內容（hash 一樣）的檔，不論在哪兩個互不相關的
// 路徑，只萃一張卡、卡上列出所有出處；內容不同就各留一張。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type twinCloud struct {
	mu       sync.Mutex
	extracts int
	cards    map[string]string // library|path -> 最後一次上雲的 card_content
	takedown []string
}

func (c *twinCloud) originLines(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Count(c.cards[key], "提及")
}

func newTwinHarness(t *testing.T, roots ...string) (*DirectConfig, *twinCloud) {
	t.Helper()
	cl := &twinCloud{cards: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger"):
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if pn, _ := m["page_name"].(string); !strings.HasPrefix(pn, "資料夾") {
				cl.mu.Lock()
				cl.cards[m["library"].(string)+"|"+m["path"].(string)], _ = m["card_content"].(string)
				cl.mu.Unlock()
			}
		case strings.Contains(r.URL.Path, "takedown"):
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if pth := m["path"].(string); !strings.Contains(pth, "資料夾") { // 資料夾結構卡與併卡無關
				cl.mu.Lock()
				cl.takedown = append(cl.takedown, pth)
				cl.mu.Unlock()
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(srv.Close)
	undo := extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		cl.mu.Lock()
		cl.extracts++
		n := cl.extracts
		cl.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("報銷規則"+itoa(n), "財務")})
	})
	t.Cleanup(undo)
	cfg := &DirectConfig{
		WatchFolders: roots, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct", MaxRemoved: 1.0,
	}
	return cfg, cl
}

func runOK(t *testing.T, cfg *DirectConfig) []DirectResult {
	t.Helper()
	res, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d results=%+v", exit, res)
	}
	return res
}

func cardTexts(t *testing.T, root string) string {
	t.Helper()
	var sb strings.Builder
	_ = filepath.Walk(root, func(p string, i os.FileInfo, err error) error {
		if err == nil && !i.IsDir() && strings.Contains(p, ".wiki") && strings.HasSuffix(p, ".md") && !strings.HasSuffix(p, "00-INDEX.md") {
			b, _ := os.ReadFile(p)
			sb.WriteString(string(b))
		}
		return nil
	})
	return sb.String()
}

const twinBody = "# 報銷規則\n\nM118/M128 不可同時使用；上限 3000 元。內容一字不差"

func TestContentTwin_SameHashUnrelatedFolders_OneCard(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "規則", "報銷規則.md"), twinBody)
	writeSameContent(t, filepath.Join(b, "別處", "報銷規則.md"), twinBody)
	cfg, cl := newTwinHarness(t, a, b)

	runOK(t, cfg)
	if cl.extracts != 1 {
		t.Fatalf("同內容兩份只該萃 1 次，got %d", cl.extracts)
	}
	if len(cl.cards) != 1 {
		t.Fatalf("雲端卡數應為 1（不多一張），got %d：%v", len(cl.cards), cl.cards)
	}
	var key string
	for k := range cl.cards {
		key = k
	}
	if n := cl.originLines(key); n != 2 {
		t.Fatalf("卡上應有 2 行出處，got %d：\n%s", n, cl.cards[key])
	}
	// 兩邊都算已上傳、沒有出錯
	for _, root := range []string{a, b} {
		m, _ := LoadManifest(cfg.manifestPathFor(root), root)
		p := m.Progress()
		if p.Done != 1 || p.Pending != 0 || p.Errors() != 0 {
			t.Fatalf("%s 應該 1 已上傳 0 待上傳 0 出錯，got %+v", root, p)
		}
	}
	// 本機只有一張文件卡（在本尊那邊），卡上兩行出處
	if txt := cardTexts(t, a) + cardTexts(t, b); strings.Count(txt, "\n# 報銷規則\n") != 1 {
		t.Fatalf("本機應只有一張卡：\n%s", txt)
	}

	// 第二輪：不再萃、不再多卡
	runOK(t, cfg)
	if cl.extracts != 1 || len(cl.cards) != 1 {
		t.Fatalf("第二輪不該有新動作：extracts=%d cards=%d", cl.extracts, len(cl.cards))
	}

	// 刪掉雙胞胎那一份 ⇒ 卡還在、只剩一行出處
	_ = os.Remove(filepath.Join(b, "別處", "報銷規則.md"))
	runOK(t, cfg)
	if n := cl.originLines(key); n != 1 {
		t.Fatalf("刪掉其中一份後應剩 1 行出處，got %d：\n%s", n, cl.cards[key])
	}
	if len(cl.takedown) != 0 {
		t.Fatalf("雙胞胎被刪不該下架本尊的卡：%v", cl.takedown)
	}
	if cl.extracts != 1 {
		t.Fatalf("不該再萃：%d", cl.extracts)
	}
}

func TestContentTwin_CanonicalDeleted_TwinPromotedToOwnCard(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "報銷規則.md"), twinBody)
	writeSameContent(t, filepath.Join(b, "報銷規則.md"), twinBody)
	cfg, cl := newTwinHarness(t, a, b)
	runOK(t, cfg)
	if cl.extracts != 1 {
		t.Fatalf("extracts=%d", cl.extracts)
	}
	// 本尊（先萃的那份）是哪個根，就刪哪個
	var canonRoot, otherRoot string
	for _, r := range []string{a, b} {
		m, _ := LoadManifest(cfg.manifestPathFor(r), r)
		if e := m.Entries["報銷規則.md"]; e != nil && e.TwinPath == "" {
			canonRoot = r
		} else {
			otherRoot = r
		}
	}
	if canonRoot == "" || otherRoot == "" {
		t.Fatal("找不到本尊／雙胞胎")
	}
	_ = os.Remove(filepath.Join(canonRoot, "報銷規則.md"))
	runOK(t, cfg) // 這輪本尊下架、雙胞胎放回佇列並自己萃
	runOK(t, cfg)
	if cl.extracts != 2 {
		t.Fatalf("本尊被刪後，雙胞胎該自己萃一張，extracts=%d", cl.extracts)
	}
	m, _ := LoadManifest(cfg.manifestPathFor(otherRoot), otherRoot)
	if e := m.Entries["報銷規則.md"]; e == nil || e.TwinPath != "" || e.IngestedHash == "" {
		t.Fatalf("雙胞胎應已自己上傳：%+v", e)
	}
	if !strings.Contains(cardTexts(t, otherRoot), "\n# 報銷規則") {
		t.Fatalf("雙胞胎應有自己的卡")
	}
	if len(cl.takedown) != 1 {
		t.Fatalf("本尊那張應被下架一次：%v", cl.takedown)
	}
}

func TestContentTwin_DifferentContentSameName_TwoCards(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "報銷規則.md"), twinBody)
	writeSameContent(t, filepath.Join(b, "報銷規則.md"), twinBody+"（不一樣的版本）")
	cfg, cl := newTwinHarness(t, a, b)
	runOK(t, cfg)
	if cl.extracts != 2 || len(cl.cards) != 2 {
		t.Fatalf("內容不同應各一張：extracts=%d cards=%d", cl.extracts, len(cl.cards))
	}
}

func TestContentTwin_TwinEdited_BecomesOwnCard(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "報銷規則.md"), twinBody)
	writeSameContent(t, filepath.Join(b, "報銷規則.md"), twinBody)
	cfg, cl := newTwinHarness(t, a, b)
	runOK(t, cfg)
	var twinRoot, canonRoot string
	for _, r := range []string{a, b} {
		m, _ := LoadManifest(cfg.manifestPathFor(r), r)
		if m.Entries["報銷規則.md"].TwinPath != "" {
			twinRoot = r
		} else {
			canonRoot = r
		}
	}
	// 改雙胞胎的內容
	writeSameContent(t, filepath.Join(twinRoot, "報銷規則.md"), twinBody+"\n新增一段")
	// mtime/size 會變 ⇒ 重新掃描
	runOK(t, cfg)
	runOK(t, cfg)
	if cl.extracts != 2 {
		t.Fatalf("改過內容的雙胞胎應自己萃：extracts=%d", cl.extracts)
	}
	key := cfg.libraryFor(canonRoot) + "|報銷規則.md"
	if n := cl.originLines(key); n != 1 {
		t.Fatalf("本尊的卡應只剩自己 1 行出處，got %d：\n%s", n, cl.cards[key])
	}
}

func TestContentTwin_BothDeleted_CardTakenDown(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeSameContent(t, filepath.Join(a, "報銷規則.md"), twinBody)
	writeSameContent(t, filepath.Join(b, "報銷規則.md"), twinBody)
	cfg, cl := newTwinHarness(t, a, b)
	runOK(t, cfg)
	_ = os.Remove(filepath.Join(a, "報銷規則.md"))
	_ = os.Remove(filepath.Join(b, "報銷規則.md"))
	runOK(t, cfg)
	runOK(t, cfg)
	if len(cl.takedown) < 1 {
		t.Fatalf("兩份都刪掉，卡要下架：%v", cl.takedown)
	}
	if cl.extracts != 1 {
		t.Fatalf("不該為已刪的檔再萃：%d", cl.extracts)
	}
	for _, r := range []string{a, b} {
		m, _ := LoadManifest(cfg.manifestPathFor(r), r)
		if len(m.Entries) != 0 {
			t.Fatalf("%s manifest 應清空：%+v", r, m.Entries)
		}
	}
}
