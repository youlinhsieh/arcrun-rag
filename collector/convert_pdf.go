// convert_pdf.go — PDF 抽文字（PDFium via wazero，純 Go 無 CGo）
//
// 為什麼 PDF 非要引擎不可（對照 docx/xlsx 只要 +0.31MB）：
//
//	PDF 是**印刷格式**——記的是「這個字畫在第 3 頁座標 (120,400)」，不是「第二段第五個字」。
//	要把散落的字元還原成通順文字，需要完整的排版還原邏輯。實測純 Go 的 PDF 套件
//	對「Chrome 列印出來的 PDF」直接吐整段亂碼（pdf-extraction-options.md §3），
//	而客戶最常丟的就是瀏覽器列印的 PDF。**把亂碼寫進知識庫比不收更糟**——
//	搜尋搜到垃圾、AI 讀到垃圾，而且用戶看不出來。
//
// 為什麼用戶不必裝任何東西（leo 2026-07-27 問「我的用戶可能不會自己裝 Python 環境」）：
//
//	PDFium 本體是 Google 的 C++ 引擎（Chrome 顯示 PDF 用的就是它），但我們用的是
//	**編譯成 WASM 的版本**，由 wazero（純 Go 的 WASM runtime）在本行程內跑。
//	`pdfium.wasm` 被 go:embed 進執行檔 ⇒ **用戶下載同一個 zip 解開就有**，
//	而且**我們自己也不需要 C/C++ 工具鏈**（CGO_ENABLED=0 編得過、Windows 交叉編譯一行成功）。
//
// 代價（實測，非估算）：collector 8.38 → 18.80 MB（+10.43 MB，壓縮後 +4.77 MB）。
// leo 2026-07-27 定調：「它全運作在客戶的電腦上，**就算肥一點跑的喘一點也沒事**」。
// 速度：1 頁 3–6 ms，15 頁 / 2.2 MB ＝ 134 ms。
//
// ⛔ **抽不出字的情況**：掃描件／翻拍的 PDF——PDFium **不做 OCR**，會回空字串。
// 這時回 ErrNoText 讓上層給用戶明確訊息，**絕不靜默當成空內容送出去**。
package collector

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
)

var (
	pdfPool     pdfium.Pool
	pdfPoolOnce sync.Once
	pdfPoolErr  error
	// 同一時間只讓一個 goroutine 用 instance——pool 設定為單一 worker，
	// 而 daemon 可能併發處理多檔（scan 迴圈目前是循序，但別依賴那個假設）。
	pdfMu sync.Mutex
)

// initPDFPool 延後到第一次真的要讀 PDF 時才初始化。
//
// 為什麼不用 init()：WASM runtime 啟動要吃記憶體與時間，而**多數使用者的資料夾裡
// 可能一個 PDF 都沒有**。沒 PDF 就不該付這個代價。
//（注意：go:embed 的 wasm 位元組仍在執行檔裡，體積代價省不掉，省的是執行期記憶體。）
func initPDFPool() error {
	pdfPoolOnce.Do(func() {
		pdfPool, pdfPoolErr = webassembly.Init(webassembly.Config{
			MinIdle:  1,
			MaxIdle:  1,
			MaxTotal: 1, // 單 worker 就夠：本用途是循序處理檔案，多開只是多吃記憶體
		})
	})
	return pdfPoolErr
}

func extractPDF(data []byte) (string, error) {
	if err := initPDFPool(); err != nil {
		return "", fmt.Errorf("PDF 引擎啟動失敗：%w", err)
	}

	pdfMu.Lock()
	defer pdfMu.Unlock()

	inst, err := pdfPool.GetInstance(30 * time.Second)
	if err != nil {
		return "", fmt.Errorf("PDF 引擎取用失敗：%w", err)
	}
	defer inst.Close()

	doc, err := inst.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		// 密碼保護的 PDF 也會走到這裡——訊息要讓用戶看得懂是「打不開」而非「沒內容」。
		return "", fmt.Errorf("PDF 打不開（可能損壞或有密碼保護）：%w", err)
	}
	defer inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	pageCount, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return "", fmt.Errorf("讀 PDF 頁數失敗：%w", err)
	}

	var sb strings.Builder
	for i := 0; i < pageCount.PageCount; i++ {
		txt, err := inst.GetPageText(&requests.GetPageText{
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: i}},
		})
		if err != nil {
			// 單頁失敗不該讓整份放棄——有內容總比沒有好，但要留痕跡。
			sb.WriteString(fmt.Sprintf("\n（第 %d 頁讀取失敗）\n", i+1))
			continue
		}
		sb.WriteString(txt.Text)
		sb.WriteString("\n")
	}

	// 抽不出字＝掃描件／影像 PDF。回空字串會被 ConvertToText 轉成 ErrNoText，
	// 上層才能告訴用戶「這個檔看起來是掃描的圖，沒有文字可讀」。
	return sb.String(), nil
}
