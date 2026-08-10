// convert_docx.go — .docx 抽文字（純 Go 標準庫，零外部依賴）
//
// 為什麼不需要外部引擎（2026-07-27 POC 實測後定案）：
//
//	.docx/.xlsx/.pptx ＝ Office Open XML ＝ **本質是 ZIP，裡面是 XML**，
//	文字明明白白寫在 <w:t> 標籤裡。Go 標準庫 archive/zip + encoding/xml 直接讀得到。
//	實測體積代價 **+0.31 MB**（對照 PDF 走 PDFium 是 +10.43 MB，差 33 倍）。
//
// 對比 PDF 為何非要引擎不可：PDF 是**印刷格式**，記的是「這個字畫在第 3 頁座標 (120,400)」，
// 要把散落字元還原成通順文字＝需要整顆排版還原引擎。兩者不是同一個難度等級。
package collector

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// docx 內文的位置。註：頁首/頁尾/註腳另有 header*.xml/footnotes.xml，
// 目前只取主文——知識萃取要的是內容，頁首頁尾多半是雜訊（頁碼、公司名）。
const docxMainPart = "word/document.xml"

func extractDocx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		// .docx 不是 zip ＝ 檔案壞了，或副檔名騙人（例如舊版 .doc 改名成 .docx）。
		// 舊版 .doc 是完全不同的二進位格式（OLE），本抽取器讀不了。
		return "", fmt.Errorf("docx 解壓失敗（可能是舊版 .doc 或檔案損壞）：%w", err)
	}
	for _, f := range zr.File {
		if f.Name != docxMainPart {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", fmt.Errorf("讀 %s 失敗：%w", docxMainPart, err)
		}
		defer rc.Close()
		return docxXMLText(rc)
	}
	return "", fmt.Errorf("docx 缺少 %s", docxMainPart)
}

// docxXMLText 串流解 XML 取文字。
//
// 只認三個標籤就夠：
//   - w:p  段落     → 換行
//   - w:tab 定位點  → tab
//   - w:br  斷行    → 換行
//
// 其餘一律當文字節點收集。用 Local name 比對（不看 namespace 前綴），
// 因為不同產生器的前綴可能不同（w: / w14: 等）。
func docxXMLText(r io.Reader) (string, error) {
	dec := xml.NewDecoder(r)
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("解析 document.xml 失敗：%w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				sb.WriteString("\n")
			case "tab":
				sb.WriteString("\t")
			case "br":
				sb.WriteString("\n")
			}
		case xml.CharData:
			sb.Write(t)
		}
	}
	return sb.String(), nil
}
