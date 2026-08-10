package collector

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 建最小合法 PPTX：ZIP + ppt/slides/slideN.xml [+ ppt/notesSlides/notesSlideN.xml]。
// slides[i] 的內容對應 slide(i+1).xml 的 <p:txBody> 內部 XML。
// notes 鍵是投影片編號（1-based），值同為 <p:txBody> 內部 XML。
func makePPTX(t *testing.T, slides []string, notes map[int]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	slideXML := func(body string) string {
		return `<?xml version="1.0" encoding="UTF-8"?>` +
			`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
			` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
			`<p:cSld><p:spTree><p:sp><p:txBody>` + body + `</p:txBody></p:sp></p:spTree></p:cSld>` +
			`</p:sld>`
	}
	notesXML := func(body string) string {
		return `<?xml version="1.0" encoding="UTF-8"?>` +
			`<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
			` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
			`<p:cSld><p:spTree><p:sp><p:txBody>` + body + `</p:txBody></p:sp></p:spTree></p:cSld>` +
			`</p:notes>`
	}
	for i, body := range slides {
		name := fmt.Sprintf("ppt/slides/slide%d.xml", i+1)
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("建 zip 失敗: %v", err)
		}
		if _, err := w.Write([]byte(slideXML(body))); err != nil {
			t.Fatalf("寫 zip 失敗: %v", err)
		}
	}

	for num, body := range notes {
		name := fmt.Sprintf("ppt/notesSlides/notesSlide%d.xml", num)
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("建 zip 失敗: %v", err)
		}
		if _, err := w.Write([]byte(notesXML(body))); err != nil {
			t.Fatalf("寫 zip 失敗: %v", err)
		}
	}

	if err := zw.Close(); err != nil {
		t.Fatalf("關 zip 失敗: %v", err)
	}
	return buf.Bytes()
}

// 生成 DrawingML 段落 XML（給 makePPTX 的 slides/notes 參數用）。
func pptxPara(texts ...string) string {
	var sb strings.Builder
	for _, text := range texts {
		fmt.Fprintf(&sb, `<a:p><a:r><a:t>%s</a:t></a:r></a:p>`, text)
	}
	return sb.String()
}

// 測試 1：中文文字 + 多投影片內容與順序
func TestExtractPPTX_中文與多投影片(t *testing.T) {
	slides := []string{
		pptxPara("策略規劃", "第一季目標"),
		pptxPara("執行計劃", "二月里程碑"),
		pptxPara("成果展示", "關鍵指標"),
	}
	got, err := ConvertToText("deck.pptx", makePPTX(t, slides, nil))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	for _, hdr := range []string{"投影片 1", "投影片 2", "投影片 3"} {
		if !strings.Contains(got, hdr) {
			t.Errorf("缺少標頭 %q，實得:\n%s", hdr, got)
		}
	}
	for _, kw := range []string{"策略規劃", "第一季目標", "二月里程碑", "成果展示", "關鍵指標"} {
		if !strings.Contains(got, kw) {
			t.Errorf("缺少關鍵字 %q，實得:\n%s", kw, got)
		}
	}
	// 投影片 1 的標頭必須在 2 之前，2 在 3 之前
	p1 := strings.Index(got, "投影片 1")
	p2 := strings.Index(got, "投影片 2")
	p3 := strings.Index(got, "投影片 3")
	if !(p1 < p2 && p2 < p3) {
		t.Errorf("投影片應按編號排序（1<2<3），實得:\n%s", got)
	}
}

// 測試 2：數字排序——slide10 不能因字典序排到 slide2 前面
func TestExtractPPTX_數字排序(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	slideXML := func(n int) string {
		return fmt.Sprintf(
			`<?xml version="1.0" encoding="UTF-8"?>`+
				`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`+
				` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`+
				`<p:cSld><p:spTree><p:sp><p:txBody>`+
				`<a:p><a:r><a:t>投影片%d的內容</a:t></a:r></a:p>`+
				`</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`, n)
	}
	// 故意以字典序倒序放入 zip（10, 2, 1），驗輸出按數字序
	for _, n := range []int{10, 2, 1} {
		w, _ := zw.Create(fmt.Sprintf("ppt/slides/slide%d.xml", n))
		w.Write([]byte(slideXML(n)))
	}
	zw.Close()

	got, err := ConvertToText("deck.pptx", buf.Bytes())
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	pos1 := strings.Index(got, "投影片 1")
	pos2 := strings.Index(got, "投影片 2")
	pos10 := strings.Index(got, "投影片 10")
	if !(pos1 < pos2 && pos2 < pos10) {
		t.Errorf("數字排序應為 1<2<10，實得:\n%s", got)
	}
}

// 測試 3：備註（notesSlide）有文字時附在投影片下
func TestExtractPPTX_備註(t *testing.T) {
	slides := []string{pptxPara("標題投影片", "開場白")}
	notes := map[int]string{1: pptxPara("這是講者備註，強調重點一二三")}
	got, err := ConvertToText("deck.pptx", makePPTX(t, slides, notes))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	if !strings.Contains(got, "（備註）") {
		t.Errorf("應有（備註）標籤，實得:\n%s", got)
	}
	if !strings.Contains(got, "強調重點") {
		t.Errorf("備註文字應被抽出，實得:\n%s", got)
	}
	// 備註應在投影片本文之後
	bodyPos := strings.Index(got, "標題投影片")
	notesPos := strings.Index(got, "（備註）")
	if bodyPos < 0 || notesPos < 0 || bodyPos > notesPos {
		t.Errorf("備註應在投影片文字之後，bodyPos=%d notesPos=%d，實得:\n%s", bodyPos, notesPos, got)
	}
}

// 測試 4：空簡報（純圖或全空白）應回 ErrNoText
func TestExtractPPTX_空簡報ErrNoText(t *testing.T) {
	slides := []string{
		pptxPara("   "), // 只有空白
		pptxPara(""),    // 無文字
	}
	_, err := ConvertToText("empty.pptx", makePPTX(t, slides, nil))
	if !errors.Is(err, ErrNoText) {
		t.Errorf("空簡報應回 ErrNoText，實得: %v", err)
	}
}
