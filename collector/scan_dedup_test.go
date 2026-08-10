// scan_dedup_test.go — 同內容多格式去重（2026-08-07，見 scan.go FormatDuplicate 註解）。
//
// 實據：leo 給的封測資料集 27,164 檔＝9,045 md＋9,044 json＋9,043 html，
// 是同一批來源轉出的三種格式，md/json 逐一同檔名主幹（不同目錄）。
// 驗收：「同內容三種格式並存 → 只產一張卡」。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

// 三種格式、同檔名主幹、活在兄弟目錄（照實據的 markdown/ vs json/ 結構）
// → 只有一份（依優先序 docx > pptx > xlsx > csv > pdf > md > markdown > txt）進事件管線。
func TestScan_FormatDuplicate_OnlyOneEventPerStem(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "markdown/160-00F3_001.md", "# 錯誤說明\nM118/M128 不可同時使用", baseTime)
	writeFile(t, root, "csv/160-00F3_001.csv", "code,msg\n160-00F3,M118/M128 不可同時使用", baseTime)
	writeFile(t, root, "doc/160-00F3_001.docx", "docx 二進位占位", baseTime)

	m := newTestManifest()
	payload, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}

	var added []Event
	for _, ev := range payload.Events {
		if ev.Type == "added" {
			added = append(added, ev)
		}
	}
	if len(added) != 1 {
		t.Fatalf("三種格式應只產生 1 個 added 事件，got %d: %+v", len(added), added)
	}
	if added[0].Path != "doc/160-00F3_001.docx" {
		t.Fatalf("優先序應留 docx，got %q", added[0].Path)
	}

	if len(payload.DuplicateFormats) != 2 {
		t.Fatalf("應回報 2 份被跳過的重複格式，got %d: %+v", len(payload.DuplicateFormats), payload.DuplicateFormats)
	}
	for _, d := range payload.DuplicateFormats {
		if d.KeptPath != "doc/160-00F3_001.docx" {
			t.Errorf("KeptPath=%q，應指向留下的那份", d.KeptPath)
		}
		if d.Stem != "160-00f3_001" {
			t.Errorf("Stem=%q", d.Stem)
		}
	}
}

// 不同檔名主幹的檔案（真正不相干的內容）不受影響——去重不能誤傷正常檔案。
func TestScan_FormatDuplicate_DifferentStemsUnaffected(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "內容 A", baseTime)
	writeFile(t, root, "b.pdf", "內容 B", baseTime)

	m := newTestManifest()
	payload, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	added := 0
	for _, ev := range payload.Events {
		if ev.Type == "added" {
			added++
		}
	}
	if added != 2 {
		t.Fatalf("不同主幹的檔案應各自產生事件，got %d", added)
	}
	if len(payload.DuplicateFormats) != 0 {
		t.Fatalf("不該誤判為重複：%+v", payload.DuplicateFormats)
	}
}

// loser 仍留在 manifest（讓下一輪 mtime/size fast-path 照常運作），只是沒有事件、
// 且 ingested_hash 永遠不會被設定——不會在後續掃描裡被誤判成「新檔」而不斷回報。
func TestScan_FormatDuplicate_LoserStaysInManifestNoRepeatedEvents(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "x.docx", "docx 內容", baseTime)
	writeFile(t, root, "x.md", "md 內容（同主幹）", baseTime)

	m := newTestManifest()
	if _, err := Scan(root, m, ScanOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Entries["x.md"]; !ok {
		t.Fatal("loser 應仍被記錄在 manifest（供 fast-path 用）")
	}
	if m.Entries["x.md"].IngestedHash != "" {
		t.Fatal("loser 不該有 ingested_hash（它從未真的被送出）")
	}

	// 模擬 winner 已成功 ingest
	m.Entries["x.docx"].IngestedHash = m.Entries["x.docx"].ContentHash

	// 第二輪：兩份檔案都沒變 → loser 不該又跑出一個 added 事件
	payload2, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range payload2.Events {
		if ev.Path == "x.md" {
			t.Fatalf("loser 不該重複產生事件：%+v", ev)
		}
	}
}

// winner 消失後，loser 自然遞補（下一輪重算分組時 loser 變成該 stem 唯一成員）。
func TestScan_FormatDuplicate_WinnerRemovedLoserPromoted(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "y.docx", "docx 內容", baseTime)
	writeFile(t, root, "y.pdf", "pdf 內容", baseTime)

	m := newTestManifest()
	if _, err := Scan(root, m, ScanOptions{}); err != nil {
		t.Fatal(err)
	}
	m.Entries["y.docx"].IngestedHash = m.Entries["y.docx"].ContentHash

	// docx 被刪除
	if err := os.Remove(filepath.Join(root, "y.docx")); err != nil {
		t.Fatal(err)
	}
	payload2, err := Scan(root, m, ScanOptions{MaxRemovedRatio: 1.0})
	if err != nil {
		t.Fatal(err)
	}
	var addedPdf bool
	for _, ev := range payload2.Events {
		if ev.Type == "added" && ev.Path == "y.pdf" {
			addedPdf = true
		}
	}
	if !addedPdf {
		t.Fatalf("winner 消失後 loser 應遞補產生 added 事件：%+v", payload2.Events)
	}
}
