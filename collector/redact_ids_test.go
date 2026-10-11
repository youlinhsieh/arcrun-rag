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

func TestRedactPersonalIDs(t *testing.T) {
	card := "# 證件\n- 持有人 F122184369 的證件\n- 小寫首碼 f122184369 也算\n- 卡號 4111 1111 1111 1111\n- 檔名 1424194141044_N183C46.html 不算\n"
	out, n := redactPersonalIDs(card)
	if n != 3 {
		t.Fatalf("n=%d out=%s", n, out)
	}
	for _, bad := range []string{"122184369", "4111"} {
		if strings.Contains(out, bad) {
			t.Errorf("還留著 %s：%s", bad, out)
		}
	}
	if !strings.Contains(out, "N183C46") {
		t.Error("檔名不該被動")
	}
	if hits := scanSecrets(out); len(hits) != 0 {
		t.Errorf("改寫後仍命中 H5：%v", hits)
	}
}

func TestRedactPersonalIDs_金鑰不救(t *testing.T) {
	card := "# x\npassword: hunter2hunter2\n"
	out, n := redactPersonalIDs(card)
	if n != 0 || out != card {
		t.Fatal("金鑰類不該被改寫")
	}
	if len(scanSecrets(out)) == 0 {
		t.Fatal("金鑰類仍要被 H5 擋")
	}
}

// 讀圖讀出的字，比對用的原文要看得到（H7 不誤判）。
func TestLintSourceText_含讀圖結果(t *testing.T) {
	scan, err := os.ReadFile(os.ExpandEnv("$HOME/Documents/KB/assets/20230922_095745_1-1.pdf"))
	if err != nil {
		t.Skip("無掃描樣本")
	}
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "scan.pdf"), scan, 0o644)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/read-image") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "持有人證號 Z987654321 金額 12500 元"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("掃描檔", "金額")})
	}))
	defer srv.Close()
	old := imageReadHTTP
	imageReadHTTP = srv.Client()
	defer func() { imageReadHTTP = old }()
	defer extractStub2(t, srv)()
	if _, err := ExtractWithWorkersAI(srv.URL, "k", root, "scan.pdf", testOrigin()); err != nil {
		t.Fatal(err)
	}
	src := lintSourceText(root, "scan.pdf", scan)
	if !strings.Contains(src, "Z987654321") || !strings.Contains(src, "圖片辨識") {
		t.Fatalf("比對原文缺讀圖文字：%.200s", src)
	}
	// 卡上引用讀圖的數字 ⇒ 落地檢查不報憑空指稱
	card := "# 掃描檔\n\n### 一句話定義\n金額 12500 元的文件。\n"
	if g := CheckGrounding(card, src); len(groundingFindings(g)) != 0 {
		t.Errorf("讀圖出來的字被當憑空長出：%v", groundingFindings(g))
	}
}

// 端到端：原稿含身分證號、模型照抄進卡 ⇒ 不是失敗，卡上的證號被改寫後照送。
func TestDirect_卡上有身分證號_自動改寫不拒收(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "證件.md"), []byte("# 證件\n\n持有人身分證 F122184369 金額 12500"), 0o644); err != nil {
		t.Fatal(err)
	}
	var posted []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		posted = append(posted, m)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	out := strings.Replace(cardFixture("證件", "金額"), "這是測試用的文件摘要", "持有人 F122184369 的文件摘要", 1)
	defer extractCardStub(t, out)()
	cfg := &DirectConfig{
		WatchFolders: []string{root}, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true, CardIngestWF: "rag_ingest_card",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	_, files := splitInventory(results)
	if exit != 0 || len(files) != 1 || files[0].Status != "ingested" {
		t.Fatalf("exit=%d results=%+v", exit, files)
	}
	for _, p := range posted {
		if cc, _ := p["card_content"].(string); strings.Contains(cc, "122184369") {
			t.Fatalf("證號原文上雲了：%.200s", cc)
		}
	}
	b, _ := os.ReadFile(filepath.Join(root, ".wiki", "證件.md"))
	if strings.Contains(string(b), "122184369") || !strings.Contains(string(b), "已遮蔽") {
		t.Fatalf("本機卡沒被改寫：%s", b)
	}
}
