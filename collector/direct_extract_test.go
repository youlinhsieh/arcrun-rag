// direct_extract_test.go — task 6：extractor 模式端到端（本地萃卡→POST rag_ingest_card）。
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

// cardFixture 組出一份合格的萃取 JSON（InkStoneCo#44 ④：wikiExtractPrompt 的契約改為
// 「文件總覽＋N 個原子概念」的 JSON，卡片格式由 wikishape.go 機械組裝）。
// 概念名固定為「<subject>·概念」——避免與各測試原稿的 H1／頁名撞名。
func cardFixture(subject, object string) string {
	concept := subject + "·概念"
	return `{"gloss":"` + subject + `的測試用一句話","tags":["測試"],` +
		`"summary":"這是測試用的文件摘要，交代 ` + subject + ` 與 ` + object + ` 的關係。",` +
		`"points":["本文的核心判斷落在 [[` + concept + `]] 上，其餘是背景"],` +
		`"no_concept":false,"reason":"",` +
		`"concepts":[{"name":"` + concept + `","gloss":"一句話說明這個概念",` +
		`"tags":["測試"],"summary":"概念層的摘要，說明它離開原稿也能獨立成立。",` +
		`"points":["第一個判斷句含具體條件"],` +
		`"entities":[{"name":"` + subject + `","type":"概念","desc":"測試主體"},` +
		`{"name":"` + object + `","type":"組織","desc":"測試客體"}],` +
		`"facts":[["` + subject + `","屬於","` + object + `"]],` +
		`"relations":[]}]}`
}

// gemmaCardStub 讓 Gemini 替身回傳一份萃取 JSON（t176 起產品只走 gemma 路，
// 測試也跟著走真實路徑——不再用 claude stub，否則測的是產品走不到的分支＝假綠）。
func gemmaCardStub(t *testing.T, cardBody string) func() {
	t.Helper()
	return gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardBody}}},
			}},
		})
	})
}

// 完整鏈（gemma 替身版）：丟原稿 → 萃卡落地本地 → 只有「卡片」被 POST 到 rag_ingest_card
// → 原文從未離開本機 → manifest 標 ingested（下一輪不重送）。
func TestDirectExtractorModeE2E(t *testing.T) {
	root := t.TempDir()
	// H1＝卡名（規範洞 1）；機密哨兵放內文，驗「原文不出機」看的是內容不是標題。
	if err := os.WriteFile(filepath.Join(root, "報銷規則.md"), []byte("# 報銷規則\n\n機密內容 XYZZY"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 假 cypher：收 rag_ingest_card、驗 payload、記帳
	var posted []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/webhooks/named/demo/rag_ingest_card/trigger") {
			t.Errorf("打錯端點：%s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		posted = append(posted, m)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	// Gemini 替身：把原稿萃成卡（B2 合格四段卡，否則新增的品質 lint 會擋下——
	// 本測試聚焦 ingest 路，非 lint，lint 自身測試見 lint_test.go）
	defer gemmaCardStub(t, cardFixture("報銷規則", "財務"))()

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
	// 結構先行（InkStoneCo#43）：每輪多一張機械總覽卡（零 LLM），檔案事件另計
	inv, fileResults := splitInventory(results)
	if len(inv) != 1 || inv[0].Status != "ingested" {
		t.Fatalf("總覽卡應送達：%+v", inv)
	}
	if len(fileResults) != 1 || fileResults[0].Status != "ingested" {
		t.Fatalf("results=%+v", fileResults)
	}
	// 卡片落地本地 `.wiki/`（InkStoneCo#44 ④：檔名＝H1、文件卡＋概念卡＋索引齊備）
	for _, rel := range []string{".wiki/報銷規則.md", ".wiki/報銷規則·概念.md", ".wiki/00-INDEX.md", ".wiki/manifest.json"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("wiki 產物未落地 %s：%v", rel, err)
		}
	}
	// 上雲的是「總覽卡＋內容卡」兩張，都不含原文
	if len(posted) != 2 {
		t.Fatalf("應恰好 POST 兩張卡（總覽＋內容），got %d", len(posted))
	}
	for _, p := range posted {
		if cc, _ := p["card_content"].(string); strings.Contains(cc, "XYZZY") {
			t.Fatal("原文內容洩上雲＝違反四步定稿邊界")
		}
	}
	var contentCard map[string]any
	for _, p := range posted {
		if pn, _ := p["page_name"].(string); !strings.HasPrefix(pn, "資料夾總覽") {
			contentCard = p
		}
	}
	if contentCard == nil {
		t.Fatal("找不到內容卡")
	}
	cc, _ := contentCard["card_content"].(string)
	if !strings.Contains(cc, "## 摘要") || !strings.Contains(cc, "gloss:") {
		t.Fatalf("card_content 不是規範形卡片：%.80s", cc)
	}
	// path 必須是「原檔路徑」（takedown 比對鍵＋B4 溯源）——不是卡片路徑（07-24 第五枚坑）
	if p, _ := contentCard["path"].(string); p != "報銷規則.md" {
		t.Fatalf("path=%q（應為原檔路徑）", p)
	}
	// 🔴 arcrun-rag#60 第二輪：本機卡片檔名加了 arcrun- 前綴，但**上雲的 page_name 不准跟著變**。
	// 下架分支用的是原稿頁名（見下一支測試斷言 takedown page_name=="報銷規則"），
	// 這裡若跟著卡片檔名變成 "arcrun-報銷規則"，兩邊就永遠對不上、刪原檔再也下架不掉。
	if pn, _ := contentCard["page_name"].(string); pn != "報銷規則" {
		t.Fatalf("page_name=%q（應為原稿頁名，不含 arcrun- 前綴，否則下架對不上）", pn)
	}
	// 第二輪：原稿沒變 → 不重萃不重送（總覽卡雜湊相同也不重送）
	results2, exit2, _ := RunDirectOnce(cfg, false)
	if exit2 != 0 || len(results2) != 0 || len(posted) != 2 {
		t.Fatalf("第二輪應零事件：results=%+v posted=%d", results2, len(posted))
	}
}

// t15：extractor 模式刪原檔 → 雲端 takedown 成功後，本地萃出的卡也要被清掉。
func TestDirectExtractorRemovedClearsLocalCard(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "報銷規則.md"), []byte("# 原稿"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 假 cypher：收 rag_ingest_card 與 rag_takedown_direct
	var takedowns []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/webhooks/named/demo/rag_takedown_direct/trigger") {
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			takedowns = append(takedowns, m)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	// Gemini 替身：萃卡落地（B2 合格四段卡，過品質 lint）
	defer gemmaCardStub(t, cardFixture("報銷規則", "財務"))()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct",
		// 單檔刪除＝removed ratio 100%，預設 0.4 防呆會壓下事件；本測試聚焦下架路，放寬到 1.0
		//（1 > 1.0×1 為 false → 事件放行）。
		MaxRemoved: 1.0,
	}

	// 第一輪：萃卡＋上雲，本地卡存在
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatalf("第一輪 ingest 失敗 exit=%d", exit)
	}
	cardPath := filepath.Join(root, ".wiki", "原稿.md") // 原稿內容「# 原稿」⇒ H1＝卡名
	if _, err := os.Stat(cardPath); err != nil {
		t.Fatalf("前置失敗：卡片未落地 %v", err)
	}

	// 刪原檔 → 第二輪：takedown 打出去、本地卡也被清
	if err := os.Remove(filepath.Join(root, "報銷規則.md")); err != nil {
		t.Fatal(err)
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("第二輪 exit=%d results=%+v", exit, results)
	}
	// 結構先行：刪檔輪總覽卡也會更新（清單不該還列著剛刪的檔），檔案事件另計
	_, fileResults := splitInventory(results)
	if len(fileResults) != 1 || fileResults[0].Status != "removed" {
		t.Fatalf("results=%+v", fileResults)
	}
	if len(takedowns) != 1 {
		t.Fatalf("應恰好一次 takedown，got %d", len(takedowns))
	}
	if pn, _ := takedowns[0]["page_name"].(string); pn != "報銷規則" {
		t.Fatalf("takedown page_name=%q", pn)
	}
	if _, err := os.Stat(cardPath); !os.IsNotExist(err) {
		t.Fatalf("本地卡應已被清（err=%v）", err)
	}
}

// t15：本地卡不存在時（存在才刪）下架照常成功，不多出 warning。
func TestDirectExtractorRemovedNoLocalCardOK(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaCardStub(t, cardFixture("a", "b"))()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", RemovedWF: "rag_takedown_direct",
		MaxRemoved: 1.0,
	}
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatal("第一輪失敗")
	}
	// 模擬用戶已手動清走本地卡 → removed 分支「存在才刪」不應報錯或多出 warning
	// （原稿內容 "x" 無 H1 ⇒ 文件卡名 fallback＝檔名 "a"）
	if err := os.Remove(filepath.Join(root, ".wiki", "a.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "a.md")); err != nil {
		t.Fatal(err)
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	_, fileResults := splitInventory(results) // 結構先行：總覽卡另計
	if exit != 0 || len(fileResults) != 1 || fileResults[0].Status != "removed" {
		t.Fatalf("exit=%d results=%+v", exit, results)
	}
}

// 萃取失敗＝該檔標 failed、exit=1、manifest 不標（下輪重試），其他檔不受影響。
func TestDirectExtractorFailKeepsRetry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Gemini 替身回 500＝萃取失敗（真實失敗模式：模型端出錯）
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	})()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    "https://x.example", Namespace: "demo", APIKey: "demo",
		Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	_, fileResults := splitInventory(results) // 結構先行：總覽卡另計（此處 cypher 不通，總覽也 failed）
	if exit != 1 || len(fileResults) != 1 || fileResults[0].Status != "failed" {
		t.Fatalf("exit=%d results=%+v", exit, results)
	}
	// 再跑一輪：仍是同一個事件（manifest 沒標 ingested＝會重試）；
	// 總覽卡則在自己的失敗退避窗口內，不重撞
	results2, _, _ := RunDirectOnce(cfg, false)
	if inv2, fileResults2 := splitInventory(results2); len(fileResults2) != 1 || len(inv2) != 0 {
		t.Fatalf("失敗檔應重試、總覽應退避：%+v", results2)
	}
}

// t108 Test B：makeAccountSubConfig 必須繼承機器層 Extractor/GeminiAPIKey/CardIngestWF 等，
// 帳號層（AccountConfig）無這些欄位時一律繼承機器層——驗收到 rag_ingest_card 而非 rag_ingest_direct。
func TestMultiAccountInheritsExtractor(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "doc.md"), []byte("# 知識"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Gemini 替身：輸出一張最簡卡片
	defer gemmaCardStub(t, cardFixture("doc", "kb"))()

	var hitCard, hitDirect bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "rag_ingest_card") {
			hitCard = true
		} else {
			hitDirect = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	// 機器層有 Extractor+GeminiAPIKey；帳號層 AccountConfig 無這些欄位（正是 t108 場景）
	cfg := &DirectConfig{
		Manifest:  filepath.Join(t.TempDir(), "m.json"),
		Library:   "kb",
		Extractor: "gemma", ExtractorExplicit: true,
		GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card",
		IngestWF:     "rag_ingest_direct",
		RemovedWF:    "rag_takedown_direct",
		MaxRemoved:   DefaultMaxRemovedRatio,
		Accounts: []AccountConfig{{
			CypherURL:    srv.URL,
			Namespace:    "demo",
			APIKey:       "demo",
			WatchFolders: []string{root},
		}},
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d results=%+v", exit, results)
	}
	if hitDirect {
		t.Error("不應打 rag_ingest_direct（原文不出機，違反四步定稿）")
	}
	if !hitCard {
		t.Error("應打 rag_ingest_card（機器層 extractor=gemma 應被帳號繼承）")
	}
}

// t108 Test C：extractor 空時，非 .md/.txt 檔禁止直送——標 failed 且絕不打任何 ingest 端點。
//
// 🔴 t182 更新（leo 08-04 起 workers-ai 成為預設）：`extractor:""` 已**不再**代表
// 「舊制直送」——LoadDirectConfig/RunDirectOnce 會把它正規化成 workers-ai。
// 要測「舊制直送模式擋二進位」，必須把 config 逼進那條路：這裡用 ExtractorExplicit
// 明示、且不給任何可用引擎，才是真正的「無萃取器」狀態。
//
// ⚠️ 本測試守的契約沒變、也不准放寬：**原始二進位永遠不出用戶的電腦**。
// workers-ai 路一樣守——它送的是 ConvertToText 之後的純文字（extract_workersai.go），
// 不是 PDF 位元組本身。
func TestExtractorEmptyBlocksNonTextDirect(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "report.pdf"), []byte("%PDF-1.4 機密原文"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 結構先行後，總覽卡（只含檔名、零原文）照常會 POST 到 rag_ingest_card——
	// 本測試守的契約是「PDF 位元組／原文不出機」，改成逐請求驗內容與端點。
	var ingestDirectCalled bool
	var leaked bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.HasSuffix(r.URL.Path, "/rag_ingest_direct/trigger") {
			ingestDirectCalled = true
		}
		if strings.Contains(string(body), "%PDF") || strings.Contains(string(body), "機密原文") {
			leaked = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb",
		// t182：明示「使用者選過、但沒有可用引擎」＝真正的無萃取器狀態。
		// （不能只寫 Extractor:""——那現在會被正規化成 workers-ai，測不到這條防禦閘。）
		Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "",
		IngestWF:   "rag_ingest_direct",
		RemovedWF:  "rag_takedown_direct",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 1 {
		t.Fatalf("exit=%d，應是 1（非文字檔無萃取器＝失敗）", exit)
	}
	if ingestDirectCalled {
		t.Error("防禦閘失效：走了舊制直送端點（契約破壞）")
	}
	if leaked {
		t.Error("防禦閘失效：PDF 位元組／原文被送上雲（契約破壞）")
	}
	_, fileResults := splitInventory(results) // 結構先行：總覽卡（只含檔名）另計
	if len(fileResults) != 1 || fileResults[0].Status != "failed" {
		t.Fatalf("results=%+v", fileResults)
	}
	// t182：這裡是「選了 Gemini 卻沒有金鑰」⇒ 停在萃取層、誠實報缺什麼。
	// 本測真正要守的契約沒變、也仍然綠：**PDF 不得被直送上雲**（上面的 leaked）。
	if !strings.Contains(fileResults[0].Error, "gemini_api_key") {
		t.Errorf("錯誤訊息不符：%q", fileResults[0].Error)
	}
}

// ── t181：預設一律走 Workers AI（免金鑰）──────────────────────────────────────
//
// leo 2026-08-04 特別交代（這是本測存在的理由）：
//
//	「default 用 Workers AI，你要用 Gemini 要**特別去選取**，**不管你現在是否有填金鑰**」
//	「只要更新版本，就已經 default workers AI 了，除非去一個地方切換你指定的 AI 來源」
//	「不然我會有很多質疑，**花在解釋為什麼 Gemini 不管用上**」
//
// ⇒ 判準是 ExtractorExplicit（使用者主動選過），**不是**「有沒有金鑰」。
func TestT181DefaultsToWorkersAI(t *testing.T) {
	cases := []struct {
		name      string
		extractor string
		explicit  bool
		key       string
		want      string
	}{
		{"新用戶（什麼都沒設）", "", false, "", "workers-ai"},
		{"舊 config 有 gemma 但沒主動選", "gemma", false, "", "workers-ai"},
		// 🔴 最關鍵的一則：**有金鑰也照樣先走 Workers AI**
		{"有金鑰但沒主動選＝仍走雲端 AI", "gemma", false, "AIza-xxx", "workers-ai"},
		{"殘留 claude 且沒主動選", "claude", false, "", "workers-ai"},
		// 主動選過才尊重他的選擇
		{"主動選了 Gemini", "gemma", true, "AIza-xxx", "gemma"},
		{"主動選了雲端 AI", "workers-ai", true, "", "workers-ai"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &DirectConfig{
				WatchFolders:      []string{t.TempDir()},
				Manifest:          filepath.Join(t.TempDir(), "m.json"),
				CypherURL:         "https://unused.example",
				Namespace:         "demo",
				APIKey:            "demo",
				Extractor:         c.extractor,
				ExtractorExplicit: c.explicit,
				GeminiAPIKey:      c.key,
				MaxRemoved:        DefaultMaxRemovedRatio,
			}
			RunDirectOnce(cfg, false) // 空資料夾＝零事件，只看預設邏輯把 Extractor 定成什麼
			if cfg.Extractor != c.want {
				t.Errorf("Extractor=%q want=%q（explicit=%v key=%q）",
					cfg.Extractor, c.want, c.explicit, c.key)
			}
		})
	}
}
