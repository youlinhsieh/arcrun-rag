// convert.go — 本地轉檔層（「收集端 Markitdown」，repo 定位 CLAUDE.md:13）
//
// leo 2026-07-27 定的形狀：
//
//	「本地任何檔案都透過一個機制把它轉成模型可讀，再把模型可讀內容發給它」
//	「能不能讀 PDF 根本不是 Arcrun 的工作」
//
// 所以這一層是**調度器（工頭）**：認副檔名 → 派給對應的抽取器（師傅）→ 統一吐出純文字。
// 好處是 Arcrun 那條管線永遠只處理文字，不必為每種格式去改框架（繞開 host fn 的
// 64KB／UTF-8 文字通道限制，見 rag-wave1/pdf-extraction-options.md 洞 B）。
//
// 硬前提（daemon-beta/tasks.md:469，leo 定）：**不裝 markitdown**——微軟那套是 Python
// 套件，要用戶先有 Python 環境＝違背「install 完即可用，不留抽象前置步驟」原則。
// 所以每個抽取器都必須是**純 Go／無 CGo**（才能跨編 Windows，t72 已實測這條路可行）。
//
// 加新格式＝在 extractors 註冊一個 func，不動架構。
package collector

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ErrNoText：檔案讀得到、格式也認得，但**抽不出任何文字**。
//
// 為什麼要有這個獨立錯誤：掃描件／翻拍的 PDF 就是這種——PDFium 不做 OCR，會回空字串。
// 這時**絕不能靜默略過**（那正是 leo 撞到的病：丟檔進去沒反應、用戶以為進去了其實是空的）。
// 呼叫端必須把它轉成使用者看得懂的訊息。
var ErrNoText = fmt.Errorf("檔案裡沒有可抽取的文字")

// ErrUnsupported：副檔名不在支援清單內。與 ErrNoText 分開，因為給用戶的說法不同
// （「這種檔案我還不會讀」vs「這個檔看起來是掃描的圖」）。
var ErrUnsupported = fmt.Errorf("尚未支援的檔案格式")

// extractor 吃檔案位元組，吐純文字。
type extractor func(data []byte) (string, error)

// extractors＝格式→師傅的對照表。加新格式只要在這裡註冊一行。
//
// .md/.markdown/.txt 不在此表：它們本來就是純文字，走 passthrough（見 ConvertToText）。
// **統一中間格式＝Markdown**（2026-07-27，leo 提 n8n 對照後定調）。
//
// leo：「其實 n8n 把一切 extract 都轉成 json，因為**它內部跑 json**」——這個觀察是對的，
// 而且點出「**統一中間格式**」本身就是價值。差別在下游是誰：
//
//	n8n 的下游是**程式**（節點之間要 `$json.欄位` 取值）→ JSON 可定址，正確。
//	我們的下游是 **LLM**（讀完寫知識卡）→ Markdown 表格更好。
//
// 實測（60 列 × 6 欄的維修紀錄表）：JSON 6,872 字元 vs Markdown 3,341 字元，
// **JSON 多花 2.1 倍 token**——因為每一列都要重複寫一次欄位名。
// 且 Markdown 與卡片格式同語言，萃出來的卡自然帶得走表格。
var extractors = map[string]extractor{
	".docx": extractDocx,
	".csv":  extractCSV,
	".xlsx": extractXLSX,
	".pdf":  extractPDF, // PDFium-via-wazero（+10.43MB；用戶不必裝任何東西，見 convert_pdf.go）
}

// preNormExtractors 裝「自己在 XML 文字片段上套完 NFKC」的抽取器。
// ConvertToText 對這類抽取器只跑 normalizeFormatting（無 NFKC），
// 確保它們後期組裝的結構標記（如全形「（備註）」）不被二次正規化。
var preNormExtractors = map[string]extractor{
	".pptx": extractPPTX, // ZIP+XML；NFKC 在 pptxXMLText 的 CharData 層套，見 convert_pptx.go
}

// IsPlainText 回報這個副檔名是否本來就是純文字（不需要轉檔）。
func IsPlainText(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown", ".txt", ".feature", ".yaml", ".yml", ".org", ".rst":
		// 後五個：規範洞 6 白名單（2026-08-15）——都是純文字知識檔，原樣通過。
		return true
	}
	return false
}

// CanConvert 回報這個副檔名是否有對應的抽取器（不含純文字）。
func CanConvert(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	if _, ok := extractors[ext]; ok {
		return true
	}
	_, ok := preNormExtractors[ext]
	return ok
}

// ConvertToText＝本層的唯一入口：任何檔案 → 模型可讀的純文字。
//
// 純文字檔原樣回傳（只做正規化）；其他格式派給對應抽取器。
// 抽不出文字回 ErrNoText，不支援的格式回 ErrUnsupported——兩者都**不是**「成功但空字串」，
// 呼叫端才有辦法給用戶明確訊號。
//
// 兩條抽取路徑：
//   - extractors：後處理走完整 normalizeText（含 NFKC）。
//   - preNormExtractors：抽取器自己在 XML CharData 層套 NFKC，
//     後處理只跑 normalizeFormatting，避免結構標記被二次正規化。
func ConvertToText(path string, data []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if IsPlainText(path) {
		return normalizeText(string(data)), nil
	}

	if ex, ok := preNormExtractors[ext]; ok {
		txt, err := ex(data)
		if err != nil {
			return "", err
		}
		txt = normalizeFormatting(txt)
		if strings.TrimSpace(txt) == "" {
			return "", ErrNoText
		}
		return txt, nil
	}

	ex, ok := extractors[ext]
	if !ok {
		return "", fmt.Errorf("%w：%s", ErrUnsupported, ext)
	}
	txt, err := ex(data)
	if err != nil {
		return "", err
	}
	txt = normalizeText(txt)
	if strings.TrimSpace(txt) == "" {
		return "", ErrNoText
	}
	return txt, nil
}

// normalizeText 做兩件事，兩件都是實測後才加的：
//
//  1. **NFKC 正規化**：PDF 抽出的中文常出現「康熙部首」等相容字元變體
//     （實測見 pdf-extraction-options.md §3）——長得跟正常字一模一樣但碼位不同，
//     會導致**使用者搜不到自己的檔案**。NFKC 把它們摺回正常字。這是廉價保險，
//     對其他來源同樣有效。
//  2. 去掉控制字元、統一換行、壓掉過量空行——PDF 抽出的文字常夾雜排版殘渣。
func normalizeText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = norm.NFKC.String(s)

	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		// 保留換行與 tab；其餘控制字元（PDF 常見的 \x00、\f 等）丟掉。
		if r == '\n' || r == '\t' {
			b.WriteRune(r)
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}

	// 連續 3 個以上換行壓成 2 個（保留段落感，去掉整頁空白）。
	out := b.String()
	for strings.Contains(out, "\n\n\n") {
		out = strings.ReplaceAll(out, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(out)
}

// normalizeFormatting 與 normalizeText 做同樣的格式清理，
// 但**不**套 NFKC 正規化。給 preNormExtractors 的抽取器用：
// 它們已在 XML CharData 層套完 NFKC，結構標記在之後才組裝，
// 不應再被 NFKC 二次轉換（例如全形「（備註）」→ 半形「(備註)」）。
func normalizeFormatting(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")

	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\n' || r == '\t' {
			b.WriteRune(r)
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}

	out := b.String()
	for strings.Contains(out, "\n\n\n") {
		out = strings.ReplaceAll(out, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(out)
}
