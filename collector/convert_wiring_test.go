package collector

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 這一組測的是**接線**，不是轉檔本身（那在 convert_test.go）。
//
// 為什麼要獨立測：t73 的教訓是「零件完成 ≠ 功能完成」——convert.go 寫得再對，
// 沒接進 ExtractWithGemma 就等於不存在。這裡驗的是**用戶真的會走的那條路**：
// 檔案落在資料夾 → scan 收不收 → 萃取前有沒有真的過轉檔層。

func writeDocx(t *testing.T, path, bodyXML string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("word/document.xml")
	w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + bodyXML + `</w:body></w:document>`))
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("寫檔失敗: %v", err)
	}
}

// scan 必須把 .docx 當成要處理的檔案收進來——否則轉檔層再好也輪不到它。
func TestWiring_scan收得到docx(t *testing.T) {
	dir := t.TempDir()
	writeDocx(t, filepath.Join(dir, "合約.docx"), `<w:p><w:r><w:t>內容</w:t></w:r></w:p>`)
	os.WriteFile(filepath.Join(dir, "筆記.md"), []byte("# 標題"), 0o644)
	os.WriteFile(filepath.Join(dir, "圖.png"), []byte("\x89PNG"), 0o644)

	m := &Manifest{FolderID: "test-folder-id", Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(dir, m, ScanOptions{})
	if err != nil {
		t.Fatalf("scan 失敗: %v", err)
	}
	var got []string
	for _, ev := range payload.Events {
		got = append(got, filepath.Base(ev.Path))
	}
	joined := strings.Join(got, ",")
	if !strings.Contains(joined, "合約.docx") {
		t.Errorf(".docx 應被 scan 收進來，實得: %v", got)
	}
	if !strings.Contains(joined, "筆記.md") {
		t.Errorf(".md 應被收，實得: %v", got)
	}
	if strings.Contains(joined, "圖.png") {
		t.Errorf(".png 不該被收，實得: %v", got)
	}
}

// 接線的核心：ExtractWithGemma 讀完檔之後，送進 LLM 的必須是**轉好的文字**，
// 不是原始位元組。這裡不打真 API——用「缺 API key 會在轉檔之後才失敗」來反證
// 轉檔確實發生在送出之前。
func TestWiring_docx轉檔發生在送LLM之前(t *testing.T) {
	dir := t.TempDir()
	rel := "合約.docx"
	writeDocx(t, filepath.Join(dir, rel), `<w:p><w:r><w:t>維修費用 350,000 元</w:t></w:r></w:p>`)

	// 空 API key → 函式最前面就擋下，證明不了轉檔。給假 key 讓它走到轉檔那一步。
	_, err := ExtractWithGemma("fake-key-for-test", "", dir, rel, testOrigin())
	if err == nil {
		t.Fatal("用假 key 不該成功")
	}
	// 關鍵斷言：錯誤不可以是「轉檔失敗」——那代表轉檔層把正常的 docx 擋掉了。
	if strings.Contains(err.Error(), "轉檔失敗") {
		t.Errorf("正常的 docx 不該在轉檔層失敗，實得: %v", err)
	}
	// 也不該是「讀原稿失敗」——檔案是存在的。
	if strings.Contains(err.Error(), "讀原稿失敗") {
		t.Errorf("檔案存在卻讀不到: %v", err)
	}
	// 走到這裡代表：讀檔 ok → 轉檔 ok → 死在 API 呼叫（預期，因為 key 是假的）
	t.Logf("如預期死在 API 階段（證明轉檔已通過）: %v", err)
}

// 掃描件 PDF 的行為契約：轉不出文字要**明確失敗**並說得出原因，
// 不能靜默當成空內容送給 LLM（那會產生一張空卡，用戶以為成功了）。
func TestWiring_抽不出文字要明確失敗不靜默(t *testing.T) {
	dir := t.TempDir()
	rel := "空的.docx"
	writeDocx(t, filepath.Join(dir, rel), `<w:p><w:r><w:t>   </w:t></w:r></w:p>`)

	_, err := ExtractWithGemma("fake-key-for-test", "", dir, rel, testOrigin())
	if err == nil {
		t.Fatal("抽不出文字應該失敗")
	}
	if !strings.Contains(err.Error(), "轉檔失敗") {
		t.Errorf("應該明確說是轉檔失敗，實得: %v", err)
	}
	if !errors.Is(err, ErrNoText) {
		t.Errorf("應可用 errors.Is 判定為 ErrNoText（呼叫端才能給對的訊息），實得: %v", err)
	}
}

// 不支援的格式（例如 .ppt 舊式二進位格式）要回 ErrUnsupported，
// 訊息要跟「掃描件」區分開——給用戶的說法不同。
func TestWiring_未支援格式與無文字要能區分(t *testing.T) {
	dir := t.TempDir()
	rel := "簡報.ppt"
	os.WriteFile(filepath.Join(dir, rel), []byte("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1fake"), 0o644)

	_, err := ExtractWithGemma("fake-key-for-test", "", dir, rel, testOrigin())
	if err == nil {
		t.Fatal("未支援格式應該失敗")
	}
	if !errors.Is(err, ErrUnsupported) {
		t.Errorf("應為 ErrUnsupported，實得: %v", err)
	}
	if errors.Is(err, ErrNoText) {
		t.Error("未支援格式不該同時是 ErrNoText（兩者給用戶的說法不同）")
	}
}

// .md 走純文字直通，不可因為接了轉檔層而壞掉（迴歸保護）。
func TestWiring_md不受轉檔層影響(t *testing.T) {
	dir := t.TempDir()
	rel := "筆記.md"
	os.WriteFile(filepath.Join(dir, rel), []byte("# 標題\n\n內容"), 0o644)

	_, err := ExtractWithGemma("fake-key-for-test", "", dir, rel, testOrigin())
	if err == nil {
		t.Fatal("假 key 不該成功")
	}
	if strings.Contains(err.Error(), "轉檔失敗") {
		t.Errorf(".md 不該進轉檔層失敗路徑，實得: %v", err)
	}
}
