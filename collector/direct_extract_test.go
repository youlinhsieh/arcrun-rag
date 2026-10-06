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
		// InkStoneCo#44：資料夾樹走 portal 登記端點（不是 workflow webhook），
		// 它不是「卡片」也不含任何原文 ⇒ 不算進 posted，也不算打錯端點。
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			return
		}
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
	defer extractCardStub(t, cardFixture("報銷規則", "財務"))()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
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
	defer extractCardStub(t, cardFixture("報銷規則", "財務"))()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
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
	defer extractCardStub(t, cardFixture("a", "b"))()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Extractor: "workers-ai", ExtractorExplicit: true,
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
	defer extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	})()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    "https://x.example", Namespace: "demo", APIKey: "demo",
		Extractor: "workers-ai", ExtractorExplicit: true, MaxRemoved: DefaultMaxRemovedRatio,
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

// t108 Test B：makeAccountSubConfig 必須繼承機器層 Extractor/CardIngestWF 等，
// 帳號層（AccountConfig）無這些欄位時一律繼承機器層——驗收到 rag_ingest_card 而非 rag_ingest_direct。
func TestMultiAccountInheritsExtractor(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "doc.md"), []byte("# 知識"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 雲端萃取替身：輸出一張最簡卡片
	defer extractCardStub(t, cardFixture("doc", "kb"))()

	var hitCard, hitDirect bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 🔴 這裡以前寫的是 `else { hitDirect = true }`——「不是卡片端點就當成直送端點」。
		// InkStoneCo#44 加了第三個端點（資料夾樹）之後，那個 else 就開始說謊。
		// 改成指名要驗的那條路：本測要守的契約是「**原文不出機**」＝不准打 rag_ingest_direct。
		if strings.Contains(r.URL.Path, "rag_ingest_card") {
			hitCard = true
		} else if strings.Contains(r.URL.Path, "rag_ingest_direct") {
			hitDirect = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	// 機器層有 Extractor；帳號層 AccountConfig 沒設（正是 t108 場景）
	cfg := &DirectConfig{
		Manifest:  filepath.Join(t.TempDir(), "m.json"),
		Library:   "kb",
		Extractor: "workers-ai", ExtractorExplicit: true,
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
		t.Error("應打 rag_ingest_card（機器層 extractor 應被帳號繼承）")
	}
}

// t108 Test C：extractor 空時，非 .md/.txt 檔禁止直送——標 failed 且絕不打任何 ingest 端點。
//
// 🔴 t182 更新（leo 08-04 起 workers-ai 成為預設）：`extractor:""` 已**不再**代表
// 「舊制直送」——LoadDirectConfig/RunDirectOnce 會把它正規化成 workers-ai。
// 🔴 inkstone/arcrun-rag#58：本機金鑰的引擎已拔除，「選了 Gemini 卻沒有金鑰」這個停點不復存在。
// 本測現在驗的是：一份轉不出文字的「PDF」走 workers-ai 路時，在**轉檔層**就失敗，
// 位元組／原文不會上雲、也不會退回舊制直送端點。
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
		Extractor: "workers-ai", ExtractorExplicit: true,
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
	// 失敗要說得出原因（不准安靜消失）；本測要守的契約是：**PDF 不得被直送上雲**（上面的 leaked）。
	if !strings.Contains(fileResults[0].Error, "轉檔失敗") {
		t.Errorf("錯誤訊息應指出是轉檔層擋下：%q", fileResults[0].Error)
	}
}

// ── t181：預設一律走 Workers AI（免金鑰）──────────────────────────────────────
//
// leo 2026-08-04：「只要更新版本，就已經 default workers AI 了」。
// 🔴 inkstone/arcrun-rag#58（leo 2026-10-01）：引擎不再可選——無論 config 殘留什麼舊值
// （gemma／claude、有沒有「主動選過」），一律 workers-ai。
func TestT181DefaultsToWorkersAI(t *testing.T) {
	cases := []struct {
		name      string
		extractor string
		explicit  bool
		want      string
	}{
		{"新用戶（什麼都沒設）", "", false, "workers-ai"},
		{"舊 config 有 gemma 但沒主動選", "gemma", false, "workers-ai"},
		{"殘留 claude 且沒主動選", "claude", false, "workers-ai"},
		// 以前「主動選了 Gemini」會被尊重；現在那條路已拔除 ⇒ 一樣是 workers-ai
		{"舊 config 主動選過 Gemini", "gemma", true, "workers-ai"},
		{"主動選了雲端 AI", "workers-ai", true, "workers-ai"},
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
				MaxRemoved:        DefaultMaxRemovedRatio,
			}
			RunDirectOnce(cfg, false) // 空資料夾＝零事件，只看預設邏輯把 Extractor 定成什麼
			if cfg.Extractor != c.want {
				t.Errorf("Extractor=%q want=%q（explicit=%v）", cfg.Extractor, c.want, c.explicit)
			}
		})
	}
}
