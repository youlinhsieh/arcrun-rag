package collector

// scan_skipped_test.go — G-6.2「不准安靜地略過」（J-1/S6，2026-08-06）。
//
// 考題：「Given 我丟進去的是 PDF 或 Word ／ When 我搜它的內容 ／
//        Then 我一樣找得到——**或當場被告知這種檔案還不支援**，不准安靜地略過。」
//
// 改動前的實測基線（真檔跑過）：把 .doc/.key/.jpg 丟進資料夾，`collector scan`
// 吐出的 events 只有 .pdf 與 .md，另外三個檔**沒有在任何輸出裡留下一個字**。
// 本檔把「那三個檔要留下名字」釘住。

import (
	"encoding/json"
	"strings"
	"testing"
)

// 讀不了的文件要逐檔點名；純粹不是文件的只計數；**能處理的檔完全不受影響**（回歸）。
func TestScanReportsSkippedFiles(t *testing.T) {
	root := t.TempDir()
	// 支援的（必須照常產生事件）
	writeFile(t, root, "筆記.md", "# 內容", baseTime)
	writeFile(t, root, "報表.csv", "a,b\n1,2", baseTime)
	// 像文件、但還讀不了的（必須逐檔點名）
	writeFile(t, root, "舊版報告.doc", "\xd0\xcf\x11\xe0binary", baseTime)
	writeFile(t, root, "提案/簡報.key", "binary", baseTime)
	// 不是文件的（只計數，不點名——避免附件庫炸出幾百行噪音）
	writeFile(t, root, "照片.jpg", "\xff\xd8\xff", baseTime)
	writeFile(t, root, "封存.zip", "PK", baseTime)

	m := newTestManifest()
	p := mustScan(t, root, m)

	// ① 回歸：支援的格式照舊，一個不多一個不少。
	added := eventsOfType(p, "added")
	if len(added) != 2 {
		t.Fatalf("支援的檔應產生 2 個 added 事件，實得 %d：%+v", len(added), added)
	}
	for _, ev := range added {
		if strings.HasSuffix(ev.Path, ".doc") || strings.HasSuffix(ev.Path, ".key") ||
			strings.HasSuffix(ev.Path, ".jpg") || strings.HasSuffix(ev.Path, ".zip") {
			t.Fatalf("讀不了的檔不該被送進管線（會被當二進位餵給模型）：%s", ev.Path)
		}
	}

	// ② 讀不了的文件必須留名——這就是「不准安靜地略過」。
	if len(p.Skipped) != 2 {
		t.Fatalf("應點名 2 個讀不了的文件，實得 %d：%+v", len(p.Skipped), p.Skipped)
	}
	got := map[string]string{}
	for _, s := range p.Skipped {
		got[s.Path] = s.Ext
	}
	if got["舊版報告.doc"] != ".doc" {
		t.Errorf("舊版報告.doc 沒被點名：%+v", got)
	}
	if got["提案/簡報.key"] != ".key" {
		t.Errorf("子目錄裡的 .key 沒被點名（相對路徑要保留）：%+v", got)
	}

	// ③ 非文件檔只給總數。
	if p.SkippedOther != 2 {
		t.Errorf("非文件檔應計數 2（jpg+zip），實得 %d", p.SkippedOther)
	}
}

// manifest 不該因為「有讀不了的檔」而被污染——它們沒進管線，就不該有帳本條目。
func TestSkippedFilesStayOutOfManifest(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "好的.md", "x", baseTime)
	writeFile(t, root, "壞的.doc", "x", baseTime)

	m := newTestManifest()
	mustScan(t, root, m)

	if _, ok := m.Entries["壞的.doc"]; ok {
		t.Error("讀不了的檔不該進 manifest（會被誤當成已收錄）")
	}
	if _, ok := m.Entries["好的.md"]; !ok {
		t.Error("支援的檔應照常進 manifest")
	}
}

// 🔴 schema 保護：collector-trigger.v1.schema.json 頂層是 additionalProperties:false，
// 多帶一個欄位上線就會被雲端擋掉。Skipped 是**給本機使用者看的**，不准漏到 wire 上。
// （BuildSendablePayload 是 `sendable := *p` 淺拷貝 ⇒ 有 json tag 就會一起送出去。）
func TestSkippedNeverGoesOnTheWire(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "壞的.doc", "x", baseTime)
	writeFile(t, root, "照片.jpg", "x", baseTime)

	p := mustScan(t, root, newTestManifest())
	if len(p.Skipped) == 0 {
		t.Fatal("前提不成立：這輪應該要有被略過的檔")
	}

	blob, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"skipped", "壞的.doc"} {
		if strings.Contains(string(blob), forbidden) {
			t.Errorf("送雲端的 payload 不該出現 %q：%s", forbidden, blob)
		}
	}
}

// 隱藏檔／被排除的目錄不該被點名——那些是系統與產品自己的東西，
// 使用者從來沒把它們當成「我丟進去的檔案」。報了只會變噪音。
func TestSkippedIgnoresHiddenAndExcluded(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, ".DS_Store", "x", baseTime)
	writeFile(t, root, ".hidden.doc", "x", baseTime)
	writeFile(t, root, ".obsidian/workspace.key", "x", baseTime)
	writeFile(t, root, "system-dev/舊稿.doc", "x", baseTime)
	writeFile(t, root, "真的.doc", "x", baseTime)

	m := newTestManifest()
	p, err := Scan(root, m, ScanOptions{SkipDirNames: map[string]bool{"system-dev": true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Skipped) != 1 || p.Skipped[0].Path != "真的.doc" {
		t.Fatalf("只有使用者自己的檔該被點名，實得 %+v", p.Skipped)
	}
	if p.SkippedOther != 0 {
		t.Errorf("隱藏檔不該進非文件計數，實得 %d", p.SkippedOther)
	}
}

// 沒有任何讀不了的檔時，兩個欄位都該是零值 ⇒ UI 才不會憑空冒出一張卡。
func TestNoSkippedWhenEverythingSupported(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "x", baseTime)
	writeFile(t, root, "b.txt", "y", baseTime)

	p := mustScan(t, root, newTestManifest())
	if len(p.Skipped) != 0 || p.SkippedOther != 0 {
		t.Errorf("全部都讀得了時不該有略過紀錄：%+v / %d", p.Skipped, p.SkippedOther)
	}
}
