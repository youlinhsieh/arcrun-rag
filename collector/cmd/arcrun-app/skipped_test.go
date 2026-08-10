package main

// skipped_test.go — 首頁「這些檔案還讀不了」那張卡（G-6.2，2026-08-06）。
//
// 這一層驗的不是資料對不對（那在 collector/scan_skipped_test.go），
// 而是**話有沒有講成人話**：使用者看到的是檔名與該不該動手，
// 不是 allowedExt、extractor、副檔名白名單這些系統內部詞。

import (
	"strings"
	"testing"
)

func TestBuildSkippedNilWhenNothingSkipped(t *testing.T) {
	if got := buildSkipped(syncStatus{}); got != nil {
		t.Fatalf("沒東西被略過時不該生出卡片（會白佔首頁版面）：%+v", got)
	}
}

func TestBuildSkippedNamesTheFilesInPlainWords(t *testing.T) {
	u := buildSkipped(syncStatus{
		SkippedDocs: []skippedDoc{
			{Path: "提案/舊版報告.doc", Ext: ".doc"},
			{Path: "簡報.key", Ext: ".key"},
		},
		SkippedDocCount: 2,
	})
	if u == nil {
		t.Fatal("有讀不了的檔卻沒生出卡片＝又回到安靜略過")
	}
	if !strings.Contains(u.Title, "2") {
		t.Errorf("標題要講幾個檔，實得 %q", u.Title)
	}
	// 使用者看的是檔名，不是我們的相對路徑。
	if u.Files[0] != "舊版報告.doc（舊版 Word）" {
		t.Errorf("檔名該配上他認得的格式名，實得 %q", u.Files[0])
	}
	if u.Files[1] != "簡報.key（Keynote）" {
		t.Errorf("實得 %q", u.Files[1])
	}
	// 要回答「我現在該做什麼」——答案是不用做什麼，而且要說出替代路。
	for _, want := range []string{"不用重丟", "PDF"} {
		if !strings.Contains(u.Note, want) {
			t.Errorf("說明要包含 %q，實得 %q", want, u.Note)
		}
	}
	// 不准把系統內部詞漏給使用者。
	for _, leak := range []string{"allowedExt", "extractor", "ErrUnsupported", "副檔名"} {
		if strings.Contains(u.Title+u.Note, leak) {
			t.Errorf("不該對使用者講 %q", leak)
		}
	}
}

// 清單有上限，但**總數不能被截掉**——否則使用者以為只有 20 個檔沒進去。
func TestBuildSkippedShowsRemainderCount(t *testing.T) {
	docs := make([]skippedDoc, 20)
	for i := range docs {
		docs[i] = skippedDoc{Path: "檔.doc", Ext: ".doc"}
	}
	u := buildSkipped(syncStatus{SkippedDocs: docs, SkippedDocCount: 57})
	if u.More != 37 {
		t.Errorf("沒列出來的還有 37 個，實得 %d", u.More)
	}
	if !strings.Contains(u.Title, "57") {
		t.Errorf("標題該講真實總數 57，實得 %q", u.Title)
	}
}

// 整個資料夾都是照片這種情況：不必驚動他，但也不能一個字都不說。
//
// 🔴 2026-08-06 leo 封測截圖抓到的病：這張卡把同一件事講了兩次——
// 先一句通用的「看起來不是文件，所以跳過了。」（底下是空的，因為非文件檔不點名），
// 再一句「**另外**有 1 個…也沒有處理。」而「另外」前面根本沒有東西。
// ⇒ 只有非文件檔時**只准講一句**，而且那一句要自己帶數量。
func TestBuildSkippedOtherOnly(t *testing.T) {
	u := buildSkipped(syncStatus{SkippedOtherCount: 312})
	if u == nil {
		t.Fatal("只有非文件檔時仍要說一句，不能沉默")
	}
	if len(u.Files) != 0 {
		t.Error("非文件檔不逐檔點名（幾百張圖會變成噪音）")
	}
	if !strings.Contains(u.Title, "312") {
		t.Errorf("只有非文件檔時，數量要出現在標題（那是唯一會被看到的一句），實得 %q", u.Title)
	}
	if u.Other != "" {
		t.Errorf("同一件事不准講兩次——沒有讀不了的文件時不該再出現一句，實得 %q", u.Other)
	}
	if strings.Contains(u.Title+u.Note, "另外") {
		t.Errorf("前面沒有東西可以「另外」，實得 %q / %q", u.Title, u.Note)
	}
}

// 兩種都有時，「另外」才成立——它接在「讀不了的檔」那段之後。
func TestBuildSkippedBothKinds(t *testing.T) {
	u := buildSkipped(syncStatus{
		SkippedDocs:       []skippedDoc{{Path: "舊報告.doc", Ext: ".doc"}},
		SkippedDocCount:   1,
		SkippedOtherCount: 3,
	})
	if !strings.Contains(u.Title, "讀不了") {
		t.Errorf("有讀不了的文件時，標題要講那件事，實得 %q", u.Title)
	}
	if !strings.Contains(u.Other, "另外") || !strings.Contains(u.Other, "3") {
		t.Errorf("兩種都有時才用「另外」並帶數量，實得 %q", u.Other)
	}
}

func TestExtLabelFallsBackToRawExt(t *testing.T) {
	if got := extLabel(".xyz"); got != "xyz" {
		t.Errorf("沒對照到的格式原樣顯示，實得 %q", got)
	}
	if got := extLabel(".DOC"); got != "舊版 Word" {
		t.Errorf("大寫副檔名也要認得（Windows 常見），實得 %q", got)
	}
}
