// retryloop_windows_bug_test.go — 學生回報（2026-10-26）：Windows 上一份 .md 一直顯示「! 重試中」、
// 小幫手不停重送直到額度燒完，而畫面上看不出原因。這裡守住三件事：
// ①分次整理的大檔，某一段每次都失敗時不能無限重打（要回錯誤讓呼叫端記退避）
// ②Windows 常見的文字編碼（UTF-8 BOM、UTF-16、Big5）不能當成 UTF-8 亂讀
// ③出錯檔清單要帶上一次失敗的真因，不能只有「重試中」三個字
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf16"
)

// 第 1、2 段成功，之後每一段都回解析不了的 JSON（不是額度用完）。
func TestExtractResumable_這輪一段都沒前進就回錯誤不回partial(t *testing.T) {
	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 200)

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		if n > 2 {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "這不是 JSON"})
			return
		}
		body := `{"gloss":"段落` + strconv.Itoa(int(n)) + `","summary":"第 ` + strconv.Itoa(int(n)) + ` 段的摘要句子",` +
			`"points":["第 ` + strconv.Itoa(int(n)) + ` 段的重點句"],` +
			`"concepts":[{"name":"概念` + strconv.Itoa(int(n)) + `","gloss":"一句話","summary":"摘要內容一段話","points":["重點一句話"]}]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": body})
	}))
	defer srv.Close()
	url := workersAIExtractURL(srv.URL)
	src := bigTableLikeText(200)

	// 第一輪：前兩段成功、第三段失敗 ⇒ 有進度，照舊是 partial。
	_, err := extractResumableWorkersAI(url, "k", root, "手冊.md", src, testOrigin(), false)
	if pe, ok := asExtractInProgress(err); !ok || pe.Done != 2 {
		t.Fatalf("第一輪有進度，應回 partial 且 Done=2，實際：%v", err)
	}

	// 第二輪：從第三段開始又失敗、一段都沒前進 ⇒ 必須是一般錯誤（呼叫端才會 MarkFailed 退避）。
	_, err = extractResumableWorkersAI(url, "k", root, "手冊.md", src, testOrigin(), false)
	if err == nil {
		t.Fatal("一段都沒前進，不該回成功")
	}
	if _, ok := asExtractInProgress(err); ok {
		t.Fatalf("一段都沒前進還回 partial ⇒ 不記退避、每輪重打燒額度：%v", err)
	}
	if !strings.Contains(err.Error(), "第 3／") {
		t.Errorf("錯誤要說出卡在第幾段：%v", err)
	}
	// 書籤（前 2 段）不能被賠掉。
	if pct, has := ExtractProgressPercent(root, "手冊.md"); !has || pct <= 0 {
		t.Errorf("已完成的段落書籤要留著：pct=%d has=%v", pct, has)
	}
}

func TestDecodePlainText_Windows常見編碼(t *testing.T) {
	want := "# 交易篇\n吸音板 QA"

	got, err := decodePlainText(append([]byte{0xEF, 0xBB, 0xBF}, want...))
	if err != nil || got != want {
		t.Errorf("UTF-8 BOM 要去掉：got %q err %v", got, err)
	}

	u := utf16.Encode([]rune(want))
	le := []byte{0xFF, 0xFE}
	be := []byte{0xFE, 0xFF}
	for _, c := range u {
		le = append(le, byte(c), byte(c>>8))
		be = append(be, byte(c>>8), byte(c))
	}
	if got, err := decodePlainText(le); err != nil || got != want {
		t.Errorf("UTF-16LE 要轉成 UTF-8：got %q err %v", got, err)
	}
	if got, err := decodePlainText(be); err != nil || got != want {
		t.Errorf("UTF-16BE 要轉成 UTF-8：got %q err %v", got, err)
	}

	// 「交易篇吸音板」的 Big5 位元組：整份都不是 UTF-8 ⇒ 不送亂碼去萃取。
	big5 := []byte{0xA5, 0xE6, 0xA9, 0xF6, 0xBD, 0x67, 0xA7, 0x6C, 0xAD, 0xB5, 0xAA, 0x4F}
	if _, err := decodePlainText(big5); err != ErrNotUTF8 {
		t.Errorf("Big5 應回 ErrNotUTF8，實際 %v", err)
	}
	if _, err := ConvertToText("a.md", big5); err != ErrNotUTF8 {
		t.Errorf("ConvertToText 對 Big5 的 .md 應回 ErrNotUTF8，實際 %v", err)
	}

	// 只有零星一個壞位元組的 UTF-8 檔照舊放行（跟以前一樣）。
	mostlyOK := []byte(strings.Repeat("正常的中文內容。", 20) + "\xff")
	if _, err := decodePlainText(mostlyOK); err != nil {
		t.Errorf("零星壞位元組不該擋整份檔：%v", err)
	}
}

func TestErrorItemDetail_單行且截短(t *testing.T) {
	if got := errorItemDetail("本地萃取失敗：\n整理第 3／9 段時：bad json"); got != "本地萃取失敗： 整理第 3／9 段時：bad json" {
		t.Errorf("要壓成單行：%q", got)
	}
	long := strings.Repeat("字", 300)
	if got := errorItemDetail(long); len([]rune(got)) != 121 || !strings.HasSuffix(got, "…") {
		t.Errorf("要截成 120 字加刪節號：len=%d", len([]rune(got)))
	}
}
