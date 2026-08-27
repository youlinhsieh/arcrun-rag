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

const legacyCard = `---
tags: [測試]
gloss: 測試卡
created: 2026-08-01
updated: 2026-08-01
---
# 小果被AFTEE詐貸

← [[00-INDEX]]

## 摘要
一段摘要。

## 重點
- 一條重點

## 實體
- **小果**（人物）— 當事人

## 關聯
### 內文知識關係
- 小果 >` + `> 被詐貸 >` + `> AFTEE
### 卡片關係
- [[小果被AFTEE詐貸]] >` + `> 整理出 >` + `> [[貸款爭議]]
### 出處
- ` + "`../小果被AFTEE詐貸.pdf`" + ` >` + `> 提及 >` + `> 小果被AFTEE詐貸
`

// TestRepairCardSourceBlocks 驗既有資料的處置：舊形出處就地改寫＋原樣重推。
// 這是票 `inkstone/Arcrun#167` 驗收條件「不能只修新的」的機械閘。
func TestRepairCardSourceBlocks(t *testing.T) {
	root := t.TempDir()
	cardRel := "子資料夾/.wiki/小果被AFTEE詐貸.md"
	if err := os.MkdirAll(filepath.Join(root, "子資料夾", ".wiki"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(cardRel)), []byte(legacyCard), 0o644); err != nil {
		t.Fatal(err)
	}
	wm := &wikiManifest{Version: 1, Docs: []wikiDoc{{
		Node: "子資料夾", Path: "小果被AFTEE詐貸.pdf", Status: "extracted",
		Card: "小果被AFTEE詐貸", Cards: []string{cardRel},
	}}}
	if err := saveWikiManifest(root, wm); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	cfg := &DirectConfig{
		CypherURL: srv.URL, APIKey: "k", Namespace: "ns",
		CardIngestWF: "rag_ingest_card",
		MachineLabel: "教育部 Leo 的 Mac",
	}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}

	res := repairCardSourceBlocks(cfg, root, m, false, false, time.Now())
	if res == nil || res.Repushed != 1 {
		t.Fatalf("沒有重推：%+v", res)
	}

	// ① 本機卡不再有內部相對路徑，且定位得到子資料夾。
	fixed, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(cardRel)))
	if err != nil {
		t.Fatal(err)
	}
	card := string(fixed)
	if strings.Contains(card, "../") {
		t.Fatalf("本機卡仍帶 `../`：\n%s", card)
	}
	if !strings.Contains(card, "子資料夾/小果被AFTEE詐貸.pdf") {
		t.Fatalf("本機卡的出處定位不到子資料夾：\n%s", card)
	}
	if !strings.Contains(card, "教育部 Leo 的 Mac") {
		t.Fatalf("本機卡的出處沒有機器標記：\n%s", card)
	}
	// ② 出處以外一字不動（重萃會讓內容變樣，就地修不會）。
	if !strings.Contains(card, "## 摘要\n一段摘要。") || !strings.Contains(card, "- **小果**（人物）— 當事人") {
		t.Fatalf("出處以外的內容被動到了：\n%s", card)
	}

	// ③ 送上雲的 payload 與 direct.go 送新卡時同一組欄位，且路徑是**庫內完整路徑**。
	if got["path"] != "子資料夾/小果被AFTEE詐貸.pdf" {
		t.Fatalf("重推的 path 不對：%v", got["path"])
	}
	if got["page_name"] != "小果被AFTEE詐貸" {
		t.Fatalf("重推的 page_name 不對：%v", got["page_name"])
	}
	if s, _ := got["card_content"].(string); strings.Contains(s, "../") {
		t.Fatalf("送上雲的卡片內容仍帶 `../`：\n%s", s)
	}

	// ④ 修完蓋章 ⇒ 不會每輪重掃、更不會每輪重推。
	if m.SourceOriginRepairedAt == 0 {
		t.Fatal("修完沒蓋章，會變成每輪都跑的背景工作")
	}
	got = nil
	if again := repairCardSourceBlocks(cfg, root, m, false, false, time.Now()); again != nil {
		t.Fatalf("蓋章後又跑了一次：%+v", again)
	}
	if got != nil {
		t.Fatal("蓋章後又重推了一次")
	}
}

// TestRewriteSourceBlockLeavesNewShapeAlone：已經是新形的卡不該被再動一次
//（避免「每輪都改一點」讓使用者的檔案 mtime 無故跳動）。
func TestRewriteSourceBlockLeavesNewShapeAlone(t *testing.T) {
	o := SourceOrigin{MachineLabel: "m", Library: "kb", LibraryPath: "a/b.md"}
	var b strings.Builder
	renderSourceLine(&b, o, "卡")
	card := "## 關聯\n### 卡片關係\n" + b.String()
	if hasLegacySourceLine(card) {
		t.Fatalf("新形被誤判成舊形：\n%s", card)
	}
	if rewriteSourceBlock(card, o, "卡") != card {
		t.Fatal("新形卡被重寫了")
	}
}
