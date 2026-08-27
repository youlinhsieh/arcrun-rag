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

// realFailingEnvelope 是 2026-08-26 從 youlin 實例抄回來的**原文**：
// HTTP 200、外層 success=true，而工作流其實一個字都沒寫進 KBDB。
// 這一份不是虛構的樣本，是這一票的物證——改動這裡等於改動證據。
const realFailingEnvelope = `{"success":true,"data":{"success":false,"status":500,` +
	`"error":"{\"success\":false,\"error\":\"unreachable\"}"},"duration_ms":2476}`

func TestWebhookFailure_實測那份回應必須被判成失敗(t *testing.T) {
	msg := webhookFailure(realFailingEnvelope)
	if msg == "" {
		t.Fatal("外層 success=true、內層 success=false ⇒ 必須判失敗，否則就是 2026-08-26 那個假綠")
	}
	if !strings.Contains(msg, "沒有真的寫進去") {
		t.Errorf("訊息要講出「沒寫進去」這件事：%q", msg)
	}
	// 使用者看得到這句話 ⇒ 不准出現狀態碼與上游 JSON 原文（同 direct_quota_test.go 的禁字表）
	for _, bad := range []string{"500", "HTTP", "unreachable", "{"} {
		if strings.Contains(msg, bad) {
			t.Errorf("訊息裸露了技術細節 %q：%q", bad, msg)
		}
	}
}

func TestWebhookFailure_只在看得懂的時候才判失敗(t *testing.T) {
	cases := []struct {
		name string
		body string
		fail bool
	}{
		{"一切正常", `{"success":true,"data":{"success":true,"ok":1},"duration_ms":9}`, false},
		{"外層就說失敗", `{"success":false,"error":"workflow not found"}`, true},
		{"內層說失敗", realFailingEnvelope, true},
		{"data 沒有 success 欄位＝看不出來", `{"success":true,"data":{"written":3}}`, false},
		{"data 是陣列", `{"success":true,"data":[1,2,3]}`, false},
		{"data 是字串", `{"success":true,"data":"done"}`, false},
		{"data 是 null", `{"success":true,"data":null}`, false},
		{"根本不是 JSON", `OK`, false},
		{"空回應", ``, false},
		{"被截斷的 JSON", `{"success":true,"data":{"success":false,"err`, false},
	}
	for _, c := range cases {
		got := webhookFailure(c.body) != ""
		if got != c.fail {
			t.Errorf("%s：判失敗=%v，預期 %v（body=%s）", c.name, got, c.fail, c.body)
		}
	}
}

// 🔴 這支是本票的核心迴歸閘：**「已送達」這個章，只能在東西真的寫進去時才准蓋。**
// 沒有它，同一個假綠會以任何一種新的包裝再回來一次
//（2026-08-26 實錄：26 份蓋章、雲端 4 份，而畫面全綠）。
func TestWiring_雲端說沒寫進去就不准蓋已送達的章(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "報銷規則.md"), []byte("# 報銷規則\n\n內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	var triggers int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
		_, _ = io.ReadAll(r.Body)
		triggers++
		// 就是實例當天回的那一份：200 ＋ 外層綠、內層紅
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, realFailingEnvelope)
	}))
	defer srv.Close()
	defer gemmaCardStub(t, cardFixture("報銷規則", "財務"))()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if triggers == 0 {
		t.Fatal("測試沒打到觸發端點，這支測試等於沒驗到東西")
	}
	if exit == 0 {
		t.Errorf("一份都沒真的寫進去，exit 不該是 0：%+v", results)
	}
	_, fileResults := splitInventory(results)
	if len(fileResults) != 1 || fileResults[0].Status != "failed" {
		t.Fatalf("那份檔應該是 failed，不是「已送達」：%+v", fileResults)
	}
	if !strings.Contains(fileResults[0].Error, "沒有真的寫進去") {
		t.Errorf("失敗理由要講人話：%q", fileResults[0].Error)
	}
	// 最關鍵的一格：manifest 不准留下「已送達」的章——留了，content_hash 沒變就永遠不會重送。
	m, err := LoadManifest(manifestPath, root)
	if err != nil {
		t.Fatalf("讀 manifest：%v", err)
	}
	for rel, e := range m.Entries {
		if e.IngestedHash != "" && e.IngestedHash == e.ContentHash {
			t.Errorf("%s 蓋了「已送達」章，但雲端根本沒收到 ⇒ 這份知識會永久消失", rel)
		}
	}
}

// 太大的檔：明知送出去一定失敗，就不要送——而且理由要是人話。
func TestTooBigForWorkersAI_講人話且不送出去(t *testing.T) {
	if why := tooBigForWorkersAI(strings.Repeat("a", 1000), "小檔.md"); why != "" {
		t.Errorf("一般大小的檔不該被擋：%q", why)
	}
	big := strings.Repeat("字", maxWorkersAIExtractBytes) // 中文一字 3 bytes ⇒ 一定超過
	why := tooBigForWorkersAI(big, "mistakes.md")
	if why == "" {
		t.Fatal("超過上限的檔要被擋下")
	}
	if !strings.Contains(why, "萬字") || !strings.Contains(why, "拆成") {
		t.Errorf("要講出多大、以及使用者能做什麼：%q", why)
	}
	for _, bad := range []string{"token", "131000", "HTTP", "8007", "llama"} {
		if strings.Contains(why, bad) {
			t.Errorf("訊息裸露技術細節 %q：%q", bad, why)
		}
	}
}

func TestExtractWithWorkersAI_太大的檔一個請求都不送(t *testing.T) {
	root := t.TempDir()
	big := strings.Repeat("字", maxWorkersAIExtractBytes)
	if err := os.WriteFile(filepath.Join(root, "巨檔.md"), []byte("# 巨檔\n\n"+big), 0o644); err != nil {
		t.Fatal(err)
	}
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "{}"})
	}))
	defer srv.Close()

	_, err := ExtractWithWorkersAI(srv.URL, "k", root, "巨檔.md")
	if err == nil {
		t.Fatal("太大的檔應該直接失敗")
	}
	if hits != 0 {
		t.Errorf("擋下的檔不該還打雲端一次（燒額度＋佔佇列），實際打了 %d 次", hits)
	}
	if !strings.Contains(err.Error(), "太大") {
		t.Errorf("理由要講人話：%v", err)
	}
}
