// convert_pptx.go — .pptx 抽文字（ZIP+XML，與 .docx 同路數）
//
// PPTX 結構：ZIP 裡有 ppt/slides/slideN.xml（主文）
// 與 ppt/notesSlides/notesSlideN.xml（備註）。
// 文字全在 DrawingML <a:t> 標籤裡；段落是 <a:p>。
// 體積代價幾乎零（只用標準庫）。
package collector

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

var pptxSlideRe = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)
var pptxNotesRe = regexp.MustCompile(`^ppt/notesSlides/notesSlide(\d+)\.xml$`)

func extractPPTX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("pptx 解壓失敗（可能是檔案損壞）：%w", err)
	}

	slideData := map[int][]byte{}
	notesData := map[int][]byte{}

	for _, f := range zr.File {
		if m := pptxSlideRe.FindStringSubmatch(f.Name); m != nil {
			num, _ := strconv.Atoi(m[1])
			rc, err := f.Open()
			if err != nil {
				return "", fmt.Errorf("讀 %s 失敗：%w", f.Name, err)
			}
			b, readErr := io.ReadAll(rc)
			rc.Close()
			if readErr != nil {
				return "", fmt.Errorf("讀 %s 失敗：%w", f.Name, readErr)
			}
			slideData[num] = b
		} else if m := pptxNotesRe.FindStringSubmatch(f.Name); m != nil {
			num, _ := strconv.Atoi(m[1])
			rc, err := f.Open()
			if err != nil {
				continue // 備註讀失敗不中斷主流程
			}
			b, readErr := io.ReadAll(rc)
			rc.Close()
			if readErr != nil {
				continue
			}
			notesData[num] = b
		}
	}

	if len(slideData) == 0 {
		return "", ErrNoText
	}

	nums := make([]int, 0, len(slideData))
	for n := range slideData {
		nums = append(nums, n)
	}
	sort.Ints(nums)

	var sb strings.Builder
	for _, n := range nums {
		body := pptxXMLText(bytes.NewReader(slideData[n]))
		notes := ""
		if nd, ok := notesData[n]; ok {
			notes = pptxXMLText(bytes.NewReader(nd))
		}

		if strings.TrimSpace(body) == "" && strings.TrimSpace(notes) == "" {
			continue
		}

		fmt.Fprintf(&sb, "## 投影片 %d\n\n", n)
		if strings.TrimSpace(body) != "" {
			sb.WriteString(strings.TrimSpace(body))
			sb.WriteString("\n")
		}
		if strings.TrimSpace(notes) != "" {
			sb.WriteString("\n（備註）\n")
			sb.WriteString(strings.TrimSpace(notes))
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}

	result := strings.TrimSpace(sb.String())
	if result == "" {
		return "", ErrNoText
	}
	return result, nil
}

// pptxXMLText 串流解 XML，收集所有 CharData，以 <a:p> 段落分行。
// Local name 比對（不看 namespace 前綴，與 docxXMLText 同做法）。
func pptxXMLText(r io.Reader) string {
	dec := xml.NewDecoder(r)
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
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
			sb.WriteString(norm.NFKC.String(string(t)))
		}
	}
	return strings.TrimLeft(sb.String(), "\n")
}
