package collector

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// inkstone/arcrun-rag#251 c18987：掃描證件類文件（身分證、卡片）讀圖後，卡上會出現證號原文。
// H5 是硬缺 ⇒ 整份檔被拒收；但「照規約改寫成描述」是機器自己做得到的事，
// 不該把它變成使用者看得到的失敗。這裡在 lint 之前把「個人證號」機械改寫成描述。
// 只處理個人證號（身分證字號、信用卡號）；金鑰／密碼／私鑰等**照舊硬擋**——那些不是改寫能救的。

var twIDRe = regexp.MustCompile(`[A-Za-z][12][0-9]{8}`)

const (
	redactedID   = "〔身分證字號，已遮蔽〕"
	redactedCard = "〔卡號，已遮蔽〕"
)

// redactPersonalIDs 回傳改寫後的卡與改寫處數；沒有命中時原樣回傳（n=0）。
func redactPersonalIDs(card string) (string, int) {
	n := 0
	lines := strings.Split(card, "\n")
	for i, line := range lines {
		if strings.Contains(line, "wiki-secret-ok") {
			continue
		}
		// 身分證：與 H5 同一條邊界規則（前後不得緊鄰英數字）；掃描文字常把首碼讀成小寫，也一併認。
		var sb strings.Builder
		last := 0
		for _, loc := range twIDRe.FindAllStringIndex(line, -1) {
			if loc[0] > 0 && isAlnumByte(line[loc[0]-1]) {
				continue
			}
			if loc[1] < len(line) && line[loc[1]] >= '0' && line[loc[1]] <= '9' {
				continue
			}
			sb.WriteString(line[last:loc[0]])
			sb.WriteString(redactedID)
			last = loc[1]
			n++
		}
		if last > 0 {
			sb.WriteString(line[last:])
			line = sb.String()
		}
		// 信用卡：與 hasCardNumber 同一套（形狀＋Luhn＋發卡組織前綴）。
		sb.Reset()
		last = 0
		hit := false
		for _, loc := range cardCandidateRe.FindAllStringIndex(line, -1) {
			if loc[0] > 0 && isIdentByte(line[loc[0]-1]) {
				continue
			}
			if loc[1] < len(line) && isIdentByte(line[loc[1]]) {
				continue
			}
			if !looksLikeCardNumber(line[loc[0]:loc[1]]) {
				continue
			}
			sb.WriteString(line[last:loc[0]])
			sb.WriteString(redactedCard)
			last = loc[1]
			hit = true
			n++
		}
		if hit {
			sb.WriteString(line[last:])
			line = sb.String()
		}
		lines[i] = line
	}
	if n == 0 {
		return card, 0
	}
	return strings.Join(lines, "\n"), n
}

func isAlnumByte(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// lintSourceText 回傳 H6/H7/H8 要拿來比對的「原文」。
// 以前直接用檔案位元組：掃描 PDF 是二進位、讀圖讀出的字更不在裡面 ⇒ 卡上的字一律被當成憑空長出。
// 現在用萃取時同一份文字：轉檔文字＋讀圖結果（只讀本機快取，不打雲端；快取沒有的頁就是沒有）。
func lintSourceText(absRoot, relPath string, raw []byte) string {
	txt, rep, err := ConvertToTextReport(relPath, raw)
	if err != nil && !isNoTextErr(err) {
		return string(raw)
	}
	if rep != nil && len(rep.ImagePageNums) > 0 {
		dir := filepath.Join(wikiDirFor(absRoot, ""), ".imageread-cache")
		if res, rerr := readPDFImages(raw, rep, pageNameOf(relPath), cacheOnlyImageReader(dir)); rerr == nil && res != nil {
			if t := res.Text(); t != "" {
				if strings.TrimSpace(txt) == "" {
					txt = t
				} else {
					txt = txt + "\n\n" + t
				}
			}
		}
	}
	if strings.TrimSpace(txt) == "" {
		return string(raw)
	}
	return txt
}

func isNoTextErr(err error) bool {
	return err == ErrNoText || strings.Contains(err.Error(), ErrNoText.Error())
}

// cacheOnlyImageReader：只讀 cachedImageReader 存下的結果，沒有就回錯（不連雲端）。
func cacheOnlyImageReader(dir string) ImageReader {
	return cachedImageReader(dir, func(ImageReadRequest) (string, error) {
		return "", os.ErrNotExist
	})
}
