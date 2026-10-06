package collector

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 這一組測的是**接線**，不是轉檔本身（那在 convert_test.go）。
//
// 為什麼要獨立測：t73 的教訓是「零件完成 ≠ 功能完成」——convert.go 寫得再對，
// 沒接進萃取路就等於不存在。這裡驗的是**用戶真的會走的那條路**：
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

// 接線的核心：萃取路讀完檔之後，送上雲端 LLM 的必須是**轉好的文字**，
// 不是原始位元組。用替身雲端端點直接看收到的 `text`。

// wiringExtract 對替身雲端跑一次萃取；回傳（雲端實際收到的 text、有沒有被打到、錯誤）。
func wiringExtract(t *testing.T, dir, rel string) (gotText string, hit bool, err error) {
	t.Helper()
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		hit = true
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotText = req["text"]
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("標題", "測試")})
	})
	defer closeFn()
	_, err = ExtractWithWorkersAI(url, "key-for-test", dir, rel, testOrigin())
	return gotText, hit, err
}
func TestWiring_docx轉檔發生在送LLM之前(t *testing.T) {
	dir := t.TempDir()
	rel := "合約.docx"
	writeDocx(t, filepath.Join(dir, rel), `<w:p><w:r><w:t>維修費用 350,000 元</w:t></w:r></w:p>`)

	gotText, hit, err := wiringExtract(t, dir, rel)
	if err != nil {
		t.Fatalf("正常的 docx 應萃取成功，實得: %v", err)
	}
	if !hit {
		t.Fatal("替身雲端沒被打到——轉檔後的文字沒送出去")
	}
	// 關鍵斷言：雲端收到的是**抽出來的文字**，不是 zip 位元組。
	if !strings.Contains(gotText, "維修費用 350,000 元") {
		t.Errorf("送上雲的不是轉好的文字：%.120q", gotText)
	}
	if strings.Contains(gotText, "PK\x03\x04") || strings.Contains(gotText, "word/document.xml") {
		t.Errorf("原始 docx 位元組洩進了送出的內容：%.120q", gotText)
	}
}

// 掃描件 PDF 的行為契約：轉不出文字要**明確失敗**並說得出原因，
// 不能靜默當成空內容送給 LLM（那會產生一張空卡，用戶以為成功了）。
func TestWiring_抽不出文字要明確失敗不靜默(t *testing.T) {
	dir := t.TempDir()
	rel := "空的.docx"
	writeDocx(t, filepath.Join(dir, rel), `<w:p><w:r><w:t>   </w:t></w:r></w:p>`)

	_, hit, err := wiringExtract(t, dir, rel)
	if err == nil {
		t.Fatal("抽不出文字應該失敗")
	}
	if hit {
		t.Error("抽不出文字不該把空內容送上雲（那會產生一張空卡）")
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

	_, hit, err := wiringExtract(t, dir, rel)
	if err == nil {
		t.Fatal("未支援格式應該失敗")
	}
	if hit {
		t.Error("未支援格式不該送上雲")
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

	gotText, hit, err := wiringExtract(t, dir, rel)
	if err != nil {
		t.Fatalf(".md 不該因轉檔層而失敗，實得: %v", err)
	}
	if !hit || !strings.Contains(gotText, "內容") {
		t.Errorf(".md 的純文字應原樣送上雲，實得 hit=%v text=%q", hit, gotText)
	}
}
