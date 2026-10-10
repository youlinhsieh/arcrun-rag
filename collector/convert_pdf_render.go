// convert_pdf_render.go — 把 PDF 的指定頁畫成 PNG（inkstone/arcrun-rag#251 讀圖的第一步）。
//
// 為什麼要畫成圖：掃描頁、貼成圖片的表、圖表、照片，PDFium 抽不到字（它不做文字辨識）。
// 這些頁畫成圖之後送雲端的多模態模型讀一次、存成文字（見 imageread.go）。
// 畫圖用的還是已內嵌的 PDFium（wazero），用戶不必多裝任何東西。
package collector

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"time"

	"github.com/klippa-app/go-pdfium/requests"
)

// imageReadDPI：畫圖解析度。c18787 試跑用 110 dpi 整頁圖，表格數字讀得出來、
// 每頁約 119–123 neurons（約 US$0.0013）；再高成本上升而準度沒有明顯變好，再低小字會糊。
const imageReadDPI = 110

// renderPDFPagesPNG 把 pages（PDF 頁序，1 起算）各畫成一張 PNG。
// 單頁失敗不拖累其他頁：該頁不出現在結果裡，錯誤收進 failed（頁序→原因）。
func renderPDFPagesPNG(data []byte, pages []int, dpi int) (out map[int][]byte, failed map[int]error, err error) {
	if err := initPDFPool(); err != nil {
		return nil, nil, fmt.Errorf("PDF 引擎啟動失敗：%w", err)
	}
	pdfMu.Lock()
	defer pdfMu.Unlock()

	inst, err := pdfPool.GetInstance(30 * time.Second)
	if err != nil {
		return nil, nil, fmt.Errorf("PDF 引擎取用失敗：%w", err)
	}
	defer inst.Close()

	doc, err := inst.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, nil, fmt.Errorf("PDF 打不開（可能損壞或有密碼保護）：%w", err)
	}
	defer inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	out = map[int][]byte{}
	failed = map[int]error{}
	for _, n := range pages {
		pg := requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: n - 1}}
		r, rerr := inst.RenderPageInDPI(&requests.RenderPageInDPI{Page: pg, DPI: dpi})
		if rerr != nil {
			failed[n] = rerr
			continue
		}
		var buf bytes.Buffer
		var img image.Image = r.Result.Image
		eerr := png.Encode(&buf, img)
		r.Cleanup() // WebAssembly：用完要釋放
		if eerr != nil {
			failed[n] = eerr
			continue
		}
		out[n] = buf.Bytes()
	}
	return out, failed, nil
}
