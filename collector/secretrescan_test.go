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
	"time"
)

// #294：規則升版 ⇒ 既有卡（本機＋已上雲的那張）就地遮掉；原檔沒變、不重萃、不擋。
// 假值執行時組出，repo 裡沒有任何真值。
func TestRescanCardSecrets_RuleUpgradeRedactsExistingCards(t *testing.T) {
	fake := "cfut_" + strings.Repeat("Zq7Kd", 8)
	root := t.TempDir()
	cardRel := "journals/.wiki/2026_10_21.md"
	if err := os.MkdirAll(filepath.Join(root, "journals", ".wiki"), 0o755); err != nil {
		t.Fatal(err)
	}
	card := "---\ntags: [日誌]\n---\n# 2026_10_21\n\n## 摘要\n一段摘要。\n\n## 原稿的段落\n- `CLOUDFLARE_TOKEN_CC_COURSE=" + fake + "`\n- 這行是正常內容\n\n## 關聯\n### 出處\n- 原文位置：`journals/2026_10_21.md`\n"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(cardRel)), []byte(card), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := saveWikiManifest(root, &wikiManifest{Version: 1, Docs: []wikiDoc{{
		Node: "journals", Path: "2026_10_21.md", Status: "extracted", Card: "2026_10_21", Cards: []string{cardRel},
	}}}); err != nil {
		t.Fatal(err)
	}

	var posts []map[string]any
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if fail {
			w.WriteHeader(500)
			return
		}
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		posts = append(posts, got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "k", Namespace: "ns", CardIngestWF: "rag_ingest_card", MachineLabel: "測試機"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{
		"journals/2026_10_21.md": {ContentHash: "h", IngestedHash: "h"}, // 已送過雲端、內容沒變
	}}

	// 推失敗：本機不動（重試訊號）、不蓋章。
	fail = true
	if res := rescanCardSecrets(cfg, root, m, false, time.Now()); res == nil || res.Err == "" {
		t.Fatalf("推失敗應回錯：%+v", res)
	}
	if m.SecretRedactRev != 0 {
		t.Fatal("推失敗不該蓋章")
	}
	if raw, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(cardRel))); !strings.Contains(string(raw), fake) {
		t.Fatal("推失敗時本機應維持原樣當重試訊號")
	}

	fail = false
	res := rescanCardSecrets(cfg, root, m, false, time.Now())
	if res == nil || res.Redacted != 1 || res.Repushed != 1 || !res.Done {
		t.Fatalf("重掃結果不對：%+v", res)
	}
	// 雲端收到的、本機卡、日誌訊息：都不含原值，且有指標與說明。
	if len(posts) != 1 {
		t.Fatalf("應重推 1 發，實際 %d", len(posts))
	}
	sent, _ := posts[0]["card_content"].(string)
	local, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(cardRel)))
	for name, text := range map[string]string{"雲端": sent, "本機": string(local), "回報": strings.Join(res.Labels, "")} {
		if strings.Contains(text, fake) || strings.Contains(text, "cfut_") {
			t.Fatalf("%s 還帶著原值：%s", name, text)
		}
	}
	for _, want := range []string{"CLOUDFLARE_TOKEN_CC_COURSE=〔機敏值，未萃取", "## 讀不到的內容", "疑似機敏值", "- 這行是正常內容", "一段摘要。"} {
		if !strings.Contains(sent, want) {
			t.Fatalf("送上雲的卡缺 %q：\n%s", want, sent)
		}
	}
	if posts[0]["path"] != "journals/2026_10_21.md" || posts[0]["page_name"] != "2026_10_21" {
		t.Fatalf("重推的 path／page_name 不對：%v", posts[0])
	}
	// 遮過的卡過 H5、不被擋。
	if hits := scanSecrets(sent); len(hits) != 0 {
		t.Fatalf("遮過的卡 H5 不該命中：%v", hits)
	}
	if m.SecretRedactRev != secretRedactRevision {
		t.Fatal("掃完沒蓋章，會變成每輪都跑")
	}
	// 蓋章後不再跑；再跑一次（強制歸零）也冪等：不再命中、不再重推。
	posts = nil
	if again := rescanCardSecrets(cfg, root, m, false, time.Now()); again != nil || len(posts) != 0 {
		t.Fatalf("蓋章後又跑了：%+v", again)
	}
	m.SecretRedactRev = 0
	if again := rescanCardSecrets(cfg, root, m, false, time.Now()); again != nil || len(posts) != 0 {
		t.Fatalf("已遮過的卡不該再重推：%+v", again)
	}
	if m.SecretRedactRev != secretRedactRevision {
		t.Fatal("乾淨的根也要蓋章")
	}
}

// 沒送過雲端的卡（例如舊制被 rejected 的）只遮本機、不推。
func TestRescanCardSecrets_NeverSentOnlyLocal(t *testing.T) {
	fake := "cfut_" + strings.Repeat("Zq7Kd", 8)
	root := t.TempDir()
	cardRel := ".wiki/a.md"
	_ = os.MkdirAll(filepath.Join(root, ".wiki"), 0o755)
	_ = os.WriteFile(filepath.Join(root, cardRel), []byte("# a\n\n## 摘要\nTOKEN_X_SECRET="+fake+"\n"), 0o644)
	_ = saveWikiManifest(root, &wikiManifest{Version: 1, Docs: []wikiDoc{{Node: wikiRootNodeKey, Path: "a.md", Card: "a", Cards: []string{cardRel}}}})
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "k", CardIngestWF: "rag_ingest_card"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	if res := rescanCardSecrets(cfg, root, m, false, time.Now()); res == nil || res.Redacted != 1 || res.Repushed != 0 {
		t.Fatalf("結果不對：%+v", res)
	}
	if hits != 0 {
		t.Fatal("沒送過的卡不該推上雲")
	}
	if raw, _ := os.ReadFile(filepath.Join(root, cardRel)); strings.Contains(string(raw), fake) {
		t.Fatal("本機卡沒遮")
	}
}
