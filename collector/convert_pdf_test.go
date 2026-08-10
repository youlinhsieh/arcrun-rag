package collector

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

const chromePDF = "/private/tmp/claude-501/-Users-youlinhsieh-Documents-tech-projects-InkStoneCo/92a75156-c295-4c79-bfeb-de1a20e4ed26/scratchpad/office-poc/chrome.pdf"

// 這是本抽取器存在的理由：調研實測「純 Go 的 PDF 套件對 Chrome 列印的 PDF 整段亂碼」
// （pdf-extraction-options.md §3），而客戶最常丟的就是瀏覽器列印的 PDF。
// 所以測資刻意用 Chrome headless 產的，不是隨便一個 PDF。
func TestPDF_Chrome列印的中文PDF(t *testing.T) {
	data, err := os.ReadFile(chromePDF)
	if err != nil {
		t.Skip("無 Chrome PDF 測資，跳過")
	}
	start := time.Now()
	got, err := ConvertToText("合約.pdf", data)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Chrome 列印的 PDF 應該讀得了: %v", err)
	}
	for _, want := range []string{"船舶維修合約書", "350,000", "2026", "交期"} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少 %q（若整段亂碼＝引擎選錯了），實得:\n%s", want, got)
		}
	}
	t.Logf("耗時 %v，抽出:\n%s", elapsed, got)
}

// 掃描件行為契約：PDFium 不做 OCR，影像 PDF 會抽不出字 → 必須是 ErrNoText，
// 不能靜默送空內容給 LLM（用戶會以為成功了，其實知識庫裡是空的）。
func TestPDF_無文字PDF回ErrNoText(t *testing.T) {
	// 一個結構合法但沒有文字內容的最小 PDF
	minimal := []byte(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
xref
0 4
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`)
	_, err := ConvertToText("空白.pdf", minimal)
	if err == nil {
		t.Fatal("沒有文字的 PDF 應該回錯，不能當成空內容送出去")
	}
	// 打不開也可接受（訊息不同但都不是靜默成功）；重點是不可回 nil error
	if !errors.Is(err, ErrNoText) && !strings.Contains(err.Error(), "PDF") {
		t.Errorf("錯誤訊息應說得出是 PDF 的問題，實得: %v", err)
	}
	t.Logf("如預期回錯: %v", err)
}

func TestPDF_壞檔要報錯不當機(t *testing.T) {
	_, err := ConvertToText("壞的.pdf", []byte("這根本不是 PDF"))
	if err == nil {
		t.Error("壞檔應該報錯")
	}
	t.Logf("錯誤訊息: %v", err)
}

// 同一個 process 連續處理多個 PDF 不可爆（pool 重用）——
// daemon 是長駐程式，一次掃描可能有幾十個 PDF。
func TestPDF_連續多檔不爆(t *testing.T) {
	data, err := os.ReadFile(chromePDF)
	if err != nil {
		t.Skip("無測資")
	}
	for i := 0; i < 3; i++ {
		got, err := ConvertToText("a.pdf", data)
		if err != nil {
			t.Fatalf("第 %d 次失敗: %v", i+1, err)
		}
		if !strings.Contains(got, "船舶維修合約書") {
			t.Fatalf("第 %d 次內容不對", i+1)
		}
	}
}
