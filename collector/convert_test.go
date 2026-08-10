package collector

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"
)

// 造一個結構正確的最小 .docx（與真 Word 檔同結構：ZIP + word/document.xml）。
func makeDocx(t *testing.T, bodyXML string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatalf("建 zip 失敗: %v", err)
	}
	xml := `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + bodyXML + `</w:body></w:document>`
	if _, err := w.Write([]byte(xml)); err != nil {
		t.Fatalf("寫 zip 失敗: %v", err)
	}
	// 真 docx 還有這些，一併放進去確保我們不會誤讀到它們
	for _, extra := range []string{"[Content_Types].xml", "word/theme/theme1.xml"} {
		e, _ := zw.Create(extra)
		e.Write([]byte(`<?xml version="1.0"?><x>不該被抽到的雜訊</x>`))
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("關 zip 失敗: %v", err)
	}
	return buf.Bytes()
}

func TestExtractDocx_中文與段落(t *testing.T) {
	body := `<w:p><w:r><w:t>船舶維修合約</w:t></w:r></w:p>` +
		`<w:p><w:r><w:t>維修費用為新台幣 350,000 元整。</w:t></w:r></w:p>`
	got, err := ConvertToText("a.docx", makeDocx(t, body))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	for _, want := range []string{"船舶維修合約", "350,000", "維修費用"} {
		if !strings.Contains(got, want) {
			t.Errorf("抽出的文字缺少 %q，實得:\n%s", want, got)
		}
	}
	// 主文以外的檔案不可被抽進來
	if strings.Contains(got, "不該被抽到的雜訊") {
		t.Errorf("抽到了 document.xml 以外的內容:\n%s", got)
	}
}

func TestExtractDocx_同段落多個run要相連(t *testing.T) {
	// Word 常把一句話因格式切成多個 <w:r>，它們必須黏在一起而不是被拆行
	body := `<w:p><w:r><w:t>合約金額</w:t></w:r><w:r><w:t>三十五萬</w:t></w:r></w:p>`
	got, err := ConvertToText("a.docx", makeDocx(t, body))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	if !strings.Contains(got, "合約金額三十五萬") {
		t.Errorf("同段落的 run 應相連，實得: %q", got)
	}
}

func TestConvertToText_純文字直接過(t *testing.T) {
	for _, p := range []string{"a.md", "b.markdown", "c.txt", "D.TXT"} {
		got, err := ConvertToText(p, []byte("純文字內容"))
		if err != nil {
			t.Errorf("%s 不該出錯: %v", p, err)
		}
		if got != "純文字內容" {
			t.Errorf("%s 應原樣回傳，實得 %q", p, got)
		}
	}
}

func TestConvertToText_不支援的格式要明確報錯(t *testing.T) {
	_, err := ConvertToText("a.xyz", []byte("x"))
	if !errors.Is(err, ErrUnsupported) {
		t.Errorf("應回 ErrUnsupported，實得 %v", err)
	}
}

// 這是掃描件 PDF 的行為契約：抽不出字要回 ErrNoText，不能「成功但空字串」，
// 否則會退化成 leo 撞到的靜默略過（用戶以為進去了、其實是空的）。
func TestConvertToText_抽不出文字要回ErrNoText(t *testing.T) {
	body := `<w:p><w:r><w:t>   </w:t></w:r></w:p>` // 只有空白
	_, err := ConvertToText("a.docx", makeDocx(t, body))
	if !errors.Is(err, ErrNoText) {
		t.Errorf("應回 ErrNoText，實得 %v", err)
	}
}

func TestExtractDocx_壞檔要報錯不當機(t *testing.T) {
	_, err := ConvertToText("a.docx", []byte("這不是 zip，是舊版 .doc 改名"))
	if err == nil {
		t.Error("壞檔應該報錯")
	}
	if errors.Is(err, ErrNoText) {
		t.Error("壞檔不該被歸類成 ErrNoText（訊息要能區分「檔壞了」和「沒有文字」）")
	}
}

func TestNormalizeText_NFKC修康熙部首(t *testing.T) {
	// U+2F02 康熙部首「丶」vs 正常的 U+4E36。PDF 抽中文常出這種變體，
	// 長得一樣但碼位不同 → 使用者會搜不到自己的檔案。
	got := normalizeText("⼀")   // 康熙部首「一」
	if got != "一" {             // 應摺成正常的「一」
		t.Errorf("NFKC 應把康熙部首摺回正常字，實得 %q (%U)", got, []rune(got))
	}
}

func TestNormalizeText_去控制字元與壓空行(t *testing.T) {
	got := normalizeText("第一行\x00\n\n\n\n第二行\f")
	if strings.ContainsRune(got, '\x00') || strings.ContainsRune(got, '\f') {
		t.Errorf("控制字元應被去掉，實得 %q", got)
	}
	if strings.Contains(got, "\n\n\n") {
		t.Errorf("過量空行應被壓掉，實得 %q", got)
	}
	if !strings.Contains(got, "第一行") || !strings.Contains(got, "第二行") {
		t.Errorf("內容不該遺失，實得 %q", got)
	}
}

func TestNormalizeText_保留tab與單一換行(t *testing.T) {
	got := normalizeText("欄一\t欄二\n下一行")
	if !strings.Contains(got, "\t") {
		t.Errorf("tab 應保留（表格語意），實得 %q", got)
	}
	if !strings.Contains(got, "\n") {
		t.Errorf("換行應保留，實得 %q", got)
	}
}

func TestCanConvert與IsPlainText(t *testing.T) {
	if !IsPlainText("a.md") || !IsPlainText("b.TXT") {
		t.Error("md/txt 應被認為純文字")
	}
	if IsPlainText("a.docx") {
		t.Error("docx 不是純文字")
	}
	if !CanConvert("a.docx") {
		t.Error("docx 應該轉得了")
	}
	if CanConvert("a.md") {
		t.Error("純文字不走 extractors（走 passthrough）")
	}
}
