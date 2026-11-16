package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// inkstone/Arcrun#343：更新前就萃好送好的檔，小幫手更新後自動補送一次（零 LLM、每檔一次、使用者不必按任何東西）。
func passageFixture(t *testing.T) (root string, srvHits *[]map[string]any, cfg *DirectConfig, m *Manifest, fail *bool, closeFn func()) {
	t.Helper()
	root = t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "手冊", ".wiki"), 0o755)
	layered := "# LinmaxB\n\n## 摘要\n五軸加工機。\n\n## 原文段落\n### PDF 第 18 頁的段落：2.6 Safety\nThe machine is fully enclosed.\n"
	plain := "# Notes\n\n## 摘要\n一段摘要。\n\n## 重點\n- 沒有原文層\n"
	_ = os.WriteFile(filepath.Join(root, "手冊", ".wiki", "LinmaxB.md"), []byte(layered), 0o644)
	_ = os.WriteFile(filepath.Join(root, "手冊", ".wiki", "Notes.md"), []byte(plain), 0o644)
	if err := saveWikiManifest(root, &wikiManifest{Version: 1, Docs: []wikiDoc{
		{Node: "手冊", Path: "LinmaxB.pdf", Card: "LinmaxB", Cards: []string{"手冊/.wiki/LinmaxB.md"}},
		{Node: "手冊", Path: "Notes.md", Card: "Notes", Cards: []string{"手冊/.wiki/Notes.md"}},
	}}); err != nil {
		t.Fatal(err)
	}
	hits := []map[string]any{}
	srvHits = &hits
	f := false
	fail = &f
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f {
			w.WriteHeader(500)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		hits = append(hits, got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	cfg = &DirectConfig{CypherURL: srv.URL, APIKey: "k", Namespace: "ns", CardIngestWF: "rag_ingest_card", MachineLabel: "測試機", CloudVersion: "1.4.216"}
	m = &Manifest{Root: root, Entries: map[string]*ManifestEntry{
		"手冊/LinmaxB.pdf": {ContentHash: "h", IngestedHash: "h"},
		"手冊/Notes.md":    {ContentHash: "n", IngestedHash: "n"},
	}}
	return root, srvHits, cfg, m, fail, srv.Close
}

func TestRepushCardPassages_OncePerFileOnlyLayeredNoAI(t *testing.T) {
	root, hits, cfg, m, _, done := passageFixture(t)
	defer done()
	res := repushCardPassages(cfg, root, m, false, time.Now())
	if res == nil || res.Repushed != 1 || !res.Done {
		t.Fatalf("結果不對：%+v", res)
	}
	if len(*hits) != 1 {
		t.Fatalf("只有有原文層的卡該送，實際 %d 發", len(*hits))
	}
	h := (*hits)[0]
	if h["page_name"] != "LinmaxB" || h["path"] != "手冊/LinmaxB.pdf" || h["library"] == nil {
		t.Fatalf("身分不對：%v", h)
	}
	if c, _ := h["card_content"].(string); c == "" {
		t.Fatal("要帶整張卡")
	}
	for p, e := range m.Entries {
		if e.PassageRev != passageRevision {
			t.Fatalf("%s 沒蓋章（沒有原文層的也要蓋，免得每輪重看）", p)
		}
	}
	// 每個檔只補一次
	*hits = nil
	if again := repushCardPassages(cfg, root, m, false, time.Now()); again != nil || len(*hits) != 0 {
		t.Fatalf("補過的檔又送了：%+v", again)
	}
}

func TestRepushCardPassages_FailKeepsRetrySignal(t *testing.T) {
	root, hits, cfg, m, fail, done := passageFixture(t)
	defer done()
	*fail = true
	res := repushCardPassages(cfg, root, m, false, time.Now())
	if res == nil || res.Err == "" || res.Done {
		t.Fatalf("推失敗應回錯且未完成：%+v", res)
	}
	if m.Entries["手冊/LinmaxB.pdf"].PassageRev != 0 {
		t.Fatal("推失敗不該蓋章")
	}
	*fail = false
	if r2 := repushCardPassages(cfg, root, m, false, time.Now()); r2 == nil || r2.Repushed != 1 || len(*hits) != 1 {
		t.Fatalf("下一輪應補上：%+v", r2)
	}
}

func TestRepushCardPassages_WaitsForNewCloudAndSkipsUnsent(t *testing.T) {
	root, hits, cfg, m, _, done := passageFixture(t)
	defer done()
	cfg.CloudVersion = "1.4.215"
	if res := repushCardPassages(cfg, root, m, false, time.Now()); res != nil || len(*hits) != 0 {
		t.Fatalf("舊雲端不該送、不該蓋章：%+v", res)
	}
	if m.Entries["手冊/LinmaxB.pdf"].PassageRev != 0 {
		t.Fatal("舊雲端不該蓋章")
	}
	cfg.CloudVersion = "1.4.216"
	m.Entries["手冊/LinmaxB.pdf"].IngestedHash = "" // 沒送過雲端的檔：之後收卡時自然有段落
	if res := repushCardPassages(cfg, root, m, false, time.Now()); res != nil && res.Repushed != 0 {
		t.Fatalf("沒送過的檔不該補送：%+v", res)
	}
	if len(*hits) != 0 {
		t.Fatal("沒送過的檔不該打雲端")
	}
}

func TestCloudHasCardPassages(t *testing.T) {
	for v, want := range map[string]bool{"": false, "1.4.215": false, "1.4.216": true, "1.4.216+abc": true, "1.5.0": true, "2026-11-16": false} {
		if got := cloudHasCardPassages(v); got != want {
			t.Fatalf("%q => %v，應為 %v", v, got, want)
		}
	}
}
