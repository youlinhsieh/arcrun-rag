// edgecases.go — 讀檔特例的「程式側入口」（inkstone/arcrun-rag#254）。
//
// 特例的結論住在 system-dev/wiki/cards/reading-edge-cases/（一例一卡）。本檔讓程式「讀得到」那份清單：
//
//	ID       卡上的「編號」，兩邊必須一一對應（edgecase_cards_test.go 檢查）
//	Detector 程式裡負責「認出這一例」的具名符號；空字串＝卡有寫、程式還沒接（卡上也要寫「無」）
//	Label    畫面上給用戶看的短標籤（≤6 字），FixableKind 回傳的就是這裡的常數
//	FixHint  畫面上「怎麼處理」的一句話；前端 main.js 的 FIX_HINT 必須與此一致（測試比對）
//
// 規則：新增特例＝先開卡、再在這裡加一列、再修。卡寫了符號而程式裡沒有它，測試會失敗。
package collector

// 用戶看到的三個可自助處理的標籤。progress.go FixableKind 只准回傳這些常數。
const (
	LabelTooBig     = "檔案太大"
	LabelNoText     = "讀不出字"
	LabelUnsupFmt   = "格式不支援"
	FixHintTooBig   = "把檔案拆小或壓縮後再放回資料夾"
	FixHintNoText   = "換成可複製文字的版本（掃描檔先做文字辨識）"
	FixHintUnsupFmt = "轉成 PDF 或 Markdown 再放回來"
)

// EdgeCase 是一例特例在程式裡的登記。
type EdgeCase struct {
	ID       string
	Detector string
	Label    string
	FixHint  string
}

// EdgeCases 與卡片一一對應（順序無意義）。
var EdgeCases = []EdgeCase{
	{ID: "pdf-chrome-print", Detector: "extractPDF"},
	{ID: "kangxi-radicals", Detector: "normalizeText"},
	{ID: "scan-pdf-no-text", Detector: "isNoTextText", Label: LabelNoText, FixHint: FixHintNoText},
	{ID: "corrupt-file", Detector: "ConvertToText"},
	{ID: "pdf-serial", Detector: "pdfMu"},
	{ID: "doclike-skipped", Detector: "docLikeExt", Label: LabelUnsupFmt, FixHint: FixHintUnsupFmt},
	{ID: "plain-text-whitelist", Detector: "IsPlainText"},
	{ID: "pptx-empty", Detector: "extractPPTX"},
	{ID: "pptx-order", Detector: "pptxNotesRe"},
	{ID: "docx-runs", Detector: "extractDocx"},
	{ID: "csv-quirks", Detector: "extractCSV"},
	{ID: "xlsx-quirks", Detector: "extractXLSX"},
	{ID: "table-limits", Detector: "maxTableRows"},
	{ID: "pdf-table-pages", Detector: ""},
	{ID: "image-table-pages", Detector: "buildPDFReport"},
	{ID: "transcript", Detector: ""},
	{ID: "oversize-resume", Detector: "tooBigForWorkersAI"},
	{ID: "legacy-too-big", Detector: "isLegacyTooBigText", Label: LabelTooBig, FixHint: FixHintTooBig},
	{ID: "chunk-cliff", Detector: "candidateRecordLabels"},
	{ID: "thin-card", Detector: ""},
	{ID: "json-loose", Detector: "parseWikiExtractJSON"},
	{ID: "concept-name-case", Detector: "BuildWikiDoc"},
	{ID: "card-collision", Detector: "isCardCollisionText"},
	{ID: "format-dup", Detector: "FormatDupOf"},
	{ID: "content-twin", Detector: "sweepOrphanTwins"},
	{ID: "machine-owned-loop", Detector: "IsMachineOwnedRel"},
	{ID: "cloud-transient", Detector: "ShouldRetry"},
	{ID: "d1-write-quota", Detector: "d1QuotaKind"},
	{ID: "subrequest-196", Detector: "isSubrequestLimitText"},
	{ID: "local-network", Detector: "isLocalNetworkText"},
	{ID: "count-identity", Detector: "Errors"},
	{ID: "claude-p-route", Detector: "claudeExtractTimeout"},
}

// EdgeCaseLabels 回傳「有畫面標籤」的特例，供測試與日後的 FAQ 產生使用。
func EdgeCaseLabels() map[string]EdgeCase {
	out := map[string]EdgeCase{}
	for _, e := range EdgeCases {
		if e.Label != "" {
			out[e.Label] = e
		}
	}
	return out
}
