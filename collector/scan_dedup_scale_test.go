// scan_dedup_scale_test.go — 同內容多格式去重在「真實規模」下的驗證（2026-08-07 驗收補測）。
//
// 為什麼要有這支：scan_dedup_test.go 只在 2~3 個檔案的小規模下驗證邏輯正確，
// 沒有驗過演算法在 leo 實據的規模（27,164 檔＝9,045 md＋9,044 json＋9,043 html）下
// ①結果仍然正確（恰好 9,045 個 stem，一個 stem 只留一份）②不會因為規模爆炸而卡住
// （detectFormatDuplicates 是 map 分組＋逐組排序，理論上是 O(n log n)，這裡實測而非空想）。
package collector

import (
	"fmt"
	"testing"
	"time"
)

func TestScan_FormatDuplicate_EvanDatasetScale(t *testing.T) {
	if testing.Short() {
		t.Skip("scale test skipped in -short mode")
	}
	root := t.TempDir()
	const nStems = 9045 // leo 實據：9,045 md 為最大宗，json/html 各少於此數（非每個 md 都有 json/html 對應）
	const nJSON = 9044
	const nHTML = 9043

	for i := 0; i < nStems; i++ {
		writeFile(t, root, fmt.Sprintf("markdown/%05d.md", i), "md 內容", baseTime)
	}
	for i := 0; i < nJSON; i++ {
		writeFile(t, root, fmt.Sprintf("json/%05d.json", i), "json 內容", baseTime)
	}
	for i := 0; i < nHTML; i++ {
		writeFile(t, root, fmt.Sprintf("html/%05d.html", i), "html 內容", baseTime)
	}
	// .json/.html 不在 allowedExt 白名單裡（見 scan.go），不會進 current 候選集合——
	// 白名單先擋掉非文件格式與「去重」是獨立的兩層。為了真的測到「三格式並存去重」，
	// 額外補一批白名單內、彼此撞 stem 的三種格式（.md/.txt/.csv 皆在 allowedExt 內）。
	const nTripleStem = 500
	for i := 0; i < nTripleStem; i++ {
		stem := fmt.Sprintf("triple-%05d", i)
		writeFile(t, root, "a/"+stem+".md", "md", baseTime)
		writeFile(t, root, "b/"+stem+".txt", "txt", baseTime)
		writeFile(t, root, "c/"+stem+".csv", "csv,x", baseTime)
	}

	m := newTestManifest()
	start := time.Now()
	payload, err := Scan(root, m, ScanOptions{})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Scan() 於 %d 個白名單內檔案（%d 個獨立 md + %d 組三格式撞 stem）耗時 %v",
		nStems+3*nTripleStem, nStems, nTripleStem, elapsed)
	if elapsed > 30*time.Second {
		t.Errorf("規模測試耗時 %v，超過可接受上限（可能有 O(n^2) 的迴歸）", elapsed)
	}

	added := 0
	for _, ev := range payload.Events {
		if ev.Type == "added" {
			added++
		}
	}
	// 期望：nStems 個獨立 md（彼此 stem 不同，不受去重影響）＋ nTripleStem 個（三選一去重後只留一張）
	wantAdded := nStems + nTripleStem
	if added != wantAdded {
		t.Fatalf("added 事件數=%d，want %d（去重後每個 triple stem 應只產生 1 個事件）", added, wantAdded)
	}
	if len(payload.DuplicateFormats) != 2*nTripleStem {
		t.Fatalf("DuplicateFormats=%d，want %d（每個 triple stem 應有 2 份被標記為重複）",
			len(payload.DuplicateFormats), 2*nTripleStem)
	}
}
