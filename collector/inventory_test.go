// inventory_test.go — 結構先行（InkStoneCo#43）：資料夾總覽卡的單元與整合測試。
package collector

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// splitInventory 把 results 拆成（總覽卡, 其餘）。既有測試斷言「幾個檔案事件」時
// 用 rest；要驗結構先行本身時用 inv。
func splitInventory(results []DirectResult) (inv, rest []DirectResult) {
	for _, r := range results {
		if r.Type == "inventory" {
			inv = append(inv, r)
		} else {
			rest = append(rest, r)
		}
	}
	return inv, rest
}

func invEntries(paths map[string]int64) map[string]*ManifestEntry {
	m := map[string]*ManifestEntry{}
	for p, mt := range paths {
		m[p] = &ManifestEntry{ContentHash: "sha256:x", Size: 1, Mtime: mt}
	}
	return m
}

// 基本結構：四段齊全、逐檔點名、格式統計、目錄 part_of 三元組。
func TestBuildInventoryCard_基本結構(t *testing.T) {
	day := time.Date(2026, 8, 10, 12, 0, 0, 0, time.Local)
	entries := invEntries(map[string]int64{
		"報銷規則.md":      day.Unix(),
		"docs/流程.md":   day.Add(24 * time.Hour).Unix(),
		"docs/簡報.pptx": day.Add(48 * time.Hour).Unix(),
	})
	page, card := BuildInventoryCard("/Users/x/我的筆記", entries, "kb")
	if page != "資料夾總覽：我的筆記" {
		t.Fatalf("page=%q", page)
	}
	for _, want := range []string{
		"# 資料夾總覽：我的筆記",
		"## 一句話定義",
		"這個資料夾目前有 3 份文件",
		"md 2 份",
		"pptx 1 份",
		"## 最近改了什麼",
		"- 2026-08-12　docs/簡報.pptx", // 最新在最上面
		"## 檔案清單",
		"- docs/流程.md（2026-08-11）",
		"- 報銷規則.md（2026-08-10）",
		"## 關聯",
		"- docs " + strings.Repeat(">", 2) + " part_of " + strings.Repeat(">", 2) + " 資料夾總覽：我的筆記",
	} {
		if !strings.Contains(card, want) {
			t.Errorf("卡片缺 %q\n----\n%s", want, card)
		}
	}
	// 最近改動的排序：簡報（08-12）要出現在 流程（08-11）之前
	if strings.Index(card, "docs/簡報.pptx") > strings.Index(card, "docs/流程.md") {
		t.Error("「最近改了什麼」未按 mtime 新到舊排序")
	}
}

// 確定性：同一份輸入永遠同一份輸出（冪等雜湊的前提）。
func TestBuildInventoryCard_確定性(t *testing.T) {
	entries := invEntries(map[string]int64{"a.md": 100, "b/c.md": 200, "b/d.pdf": 200})
	_, c1 := BuildInventoryCard("/x/root", entries, "kb")
	for i := 0; i < 10; i++ {
		_, c2 := BuildInventoryCard("/x/root", entries, "kb")
		if c1 != c2 {
			t.Fatal("同一份輸入產出不同卡片（map 迭代順序洩漏）")
		}
	}
}

// 巨量資料夾：不逐檔點名（改列各目錄份數），關聯不超上限——守雲端 subrequest 天花板。
func TestBuildInventoryCard_巨量只列摘要(t *testing.T) {
	entries := map[string]*ManifestEntry{}
	for d := 0; d < 40; d++ {
		for f := 0; f < 10; f++ {
			p := fmt.Sprintf("dir%02d/f%02d.md", d, f)
			entries[p] = &ManifestEntry{Mtime: int64(1000 + d + f)}
		}
	}
	_, card := BuildInventoryCard("/x/big", entries, "kb")
	if !strings.Contains(card, "共 400 份，檔案較多") {
		t.Error("巨量模式應改列摘要")
	}
	if strings.Count(card, "- dir")-strings.Count(card, "- dir00 ") > maxInventoryDirLines+maxInventoryRels {
		t.Error("目錄行數超出上限")
	}
	sep := " " + strings.Repeat(">", 2) + " "
	if n := strings.Count(card, sep+"part_of"+sep); n > maxInventoryRels {
		t.Errorf("關聯 %d 條超過上限 %d（會撞雲端 subrequest 上限）", n, maxInventoryRels)
	}
	if !strings.Contains(card, "其餘") {
		t.Error("被截斷的目錄應誠實說有其餘幾個（不安靜略過）")
	}
}

// 整合：總覽卡必須先於任何萃取／收卡 POST 送達（結構不跟 LLM 排同一條隊），
// 且第二輪（無變動）不重送＝冪等。
func TestDirectInventory_先於萃取且冪等(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "規則.md"), []byte("# 內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	var order []string // 按抵達順序記 page_name
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		pn, _ := m["page_name"].(string)
		order = append(order, pn)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaCardStub(t, cardFixture("規則", "kb"))()

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
	if len(order) != 2 {
		t.Fatalf("應恰好兩個 POST（總覽卡＋內容卡），got %v", order)
	}
	if !strings.HasPrefix(order[0], "資料夾總覽：") {
		t.Fatalf("總覽卡必須先送（結構先行），實際順序：%v", order)
	}
	if order[1] != "規則" {
		t.Fatalf("內容卡未送達：%v", order)
	}
	inv, _ := splitInventory(results)
	if len(inv) != 1 || inv[0].Status != "ingested" {
		t.Fatalf("inv=%+v", inv)
	}
	// 第二輪：什麼都沒變 → 總覽不重送、也沒有檔案事件
	results2, _, _ := RunDirectOnce(cfg, false)
	if len(results2) != 0 || len(order) != 2 {
		t.Fatalf("無變動輪不該重送：results2=%+v order=%v", results2, order)
	}
	// 新增一個檔 → 總覽跟著更新（清單多一筆）＋新檔照常萃取。
	// （附帶驗證：同一天內改同一個檔，總覽內容在日粒度下不變＝不重送，是冪等的正確行為）
	if err := os.WriteFile(filepath.Join(root, "新頁.md"), []byte("# 新內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, exit3, _ := RunDirectOnce(cfg, false); exit3 != 0 {
		t.Fatal("第三輪失敗")
	}
	if len(order) != 4 || !strings.HasPrefix(order[2], "資料夾總覽：") {
		t.Fatalf("變動後總覽應更新且仍先送：%v", order)
	}
}

// 整合：萃取整條路壞掉（連 Gemini 都連不上）時，總覽卡照樣送達——
// 這正是「不必等 LLM、不必等額度」要保的那條路。
func TestDirectInventory_萃取壞掉照樣送達(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var invPosted int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "資料夾總覽") {
			invPosted++
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	// Gemini 替身回 500＝萃取全滅
	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	})()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 1 {
		t.Fatalf("萃取失敗 exit 應為 1，got %d", exit)
	}
	if invPosted != 1 {
		t.Fatalf("萃取壞掉時總覽卡應照樣送達，got %d", invPosted)
	}
	inv, rest := splitInventory(results)
	if len(inv) != 1 || inv[0].Status != "ingested" {
		t.Fatalf("inv=%+v", inv)
	}
	if len(rest) != 1 || rest[0].Status != "failed" {
		t.Fatalf("rest=%+v", rest)
	}
}

// 失敗退避：總覽送失敗後，同一份內容在退避窗口內不重撞（積壓輪每 5 秒都有事件，
// 沒有這道就是 t195 的 1387 輪重演）；內容變了立即可再試。
func TestSyncInventory_失敗退避(t *testing.T) {
	root := t.TempDir()
	m := &Manifest{Entries: invEntries(map[string]int64{"a.md": 100})}
	cfg := &DirectConfig{CypherURL: "https://x.invalid", Namespace: "demo", APIKey: "demo", Library: "kb"}
	now := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)

	res := syncInventory(cfg, root, m, true, false, now)
	if res == nil || res.Status != "failed" {
		t.Fatalf("res=%+v", res)
	}
	if m.InventoryFailHash == "" || m.InventoryNextRetry == 0 {
		t.Fatal("失敗應記退避")
	}
	// 同內容、退避窗口內 → 不重試
	if res2 := syncInventory(cfg, root, m, true, false, now.Add(time.Minute)); res2 != nil {
		t.Fatalf("退避窗口內不該重試：%+v", res2)
	}
	// 退避窗口過了 → 重試
	if res3 := syncInventory(cfg, root, m, true, false, now.Add(inventoryRetryDelay+time.Minute)); res3 == nil {
		t.Fatal("退避過期後應重試")
	}
	// 內容變了 → 立即可再試
	m.Entries["b.md"] = &ManifestEntry{Mtime: 200}
	if res4 := syncInventory(cfg, root, m, true, false, now.Add(time.Minute)); res4 == nil {
		t.Fatal("內容變了應立即重試（新卡不受舊卡退避拖累）")
	}
}
