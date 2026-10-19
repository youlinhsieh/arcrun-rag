// convert_pdf_chart.go — 曲線圖的座標刻度不當成表格列進卡（inkstone/arcrun-rag#280 c21938）。
//
// 症狀：型錄的「扭矩／功率曲線圖」文字層裡，座標軸刻度（Nm 90／180、kW 60／90、rpm 0／6,000／12,000…）
// 和圖例、規格列混在同一塊，被還原成「表格列」逐字進卡；下游小模型把刻度當規格值，
// 把 28K 主軸的扭矩寫成 90 (180) Nm（正解 55 (75) Nm）。
//
// 判準只看結構，不認領域詞、不認文件類型（論文的折線圖、財報的趨勢圖同樣受益）：
//
//  1. 有「座標軸證據」（見 hasTickEvidence）：橫軸一排等差的純數字，或兩條縱軸，或單獨成列的縱軸刻度。
//     只有「年份欄剛好等差」的資料表不算。
//  2. 這張表 ≥50% 的列是「無標籤列」（沒有任何一格含 ≥4 個字母的詞）。
//     規格表、財報的每一列都有項目名；圖的刻度列只有數字與單位縮寫。
//
// 兩者都成立才算「圖的座標」：無標籤列整列不收；有標籤的列只拿掉純數字格（曲線旁的讀數、刻度）。
// 真正的規格列（「Spindle torque｜Nm｜67 (87)」這種項目＋單位＋值）原樣保留。
// 被拿掉的格數記在表上，卡上明說「圖的座標刻度未收」，不靜默。
package collector

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const (
	// 連續幾格等差的純數字才算刻度證據。
	chartTickRun = 4
	// 表至少幾列、無標籤列佔比達多少，才可能是圖。
	chartMinRows       = 4
	chartLabelLessFrac = 0.5
	// 垂直對齊的容差（PDF 點）。
	chartAlignTol = 3.0
)

var tickNumberRe = regexp.MustCompile(`^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$`)

// bareNumber：整格只有一個數字（可有千分位、小數、正負號、百分號）。
func bareNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if !tickNumberRe.MatchString(s) {
		return 0, false
	}
	s = strings.TrimSuffix(strings.ReplaceAll(s, ",", ""), "%")
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

// hasLabelWord：這格含一個 ≥4 個字母的詞（項目名）。單位縮寫（Nm、kW、rpm）、型號片段（S6-40%）不算。
func hasLabelWord(s string) bool {
	run := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			run++
			if run >= 4 {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// numberRun：整格是 ≥2 個以空白隔開的純數字（幾個刻度被併成一格）。
func numberRun(s string) bool {
	toks := strings.Fields(s)
	if len(toks) < 2 {
		return false
	}
	for _, tk := range toks {
		if _, ok := bareNumber(tk); !ok {
			return false
		}
	}
	return true
}

// isUnitCell：單位欄（kW、Nm、rpm、Full travel/mm）：有字母、沒有項目名那種長詞、很短。
func isUnitCell(s string) bool {
	return len([]rune(s)) <= 14 && strings.IndexFunc(s, unicode.IsLetter) >= 0 && !hasLabelWord(s)
}

func isArithmetic(v []float64) bool {
	if len(v) < 3 {
		return false
	}
	d := v[1] - v[0]
	if d == 0 {
		return false
	}
	for i := 2; i < len(v); i++ {
		e := (v[i] - v[i-1]) - d
		if e < 0 {
			e = -e
		}
		if e > 1e-9*(1+abs64(d)) {
			return false
		}
	}
	return true
}

func abs64(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// hasTickEvidence：這些列看起來有「座標軸」嗎？rows 是由上而下的列（每列由左而右的儲存格）。
// 只有下列三種算數（單獨一條「年份欄剛好等差」的資料表不算，它的其他欄不是等差）：
//  1. 橫軸：某一個無標籤列裡，連續 ≥4 格純數字且等差。
//  2. 縱軸有兩條：兩個不同的垂直欄，各自連續 ≥4 格純數字且等差（左右兩條 Y 軸）。
//  3. 縱軸只有一條，但那些格各自單獨占一列（刻度自己一行，旁邊沒有別的格）。
func hasTickEvidence(rows [][]tcell) bool {
	for _, r := range rows {
		if len(r) < chartTickRun {
			continue
		}
		less := true
		for _, c := range r {
			if hasLabelWord(c.text) {
				less = false
				break
			}
		}
		if !less {
			continue
		}
		for s := 0; s+chartTickRun <= len(r); s++ {
			vals := make([]float64, 0, chartTickRun)
			for _, c := range r[s : s+chartTickRun] {
				v, ok := bareNumber(c.text)
				if !ok {
					vals = nil
					break
				}
				vals = append(vals, v)
			}
			if vals != nil && isArithmetic(vals) {
				return true
			}
		}
	}
	// 垂直：純數字格依 左緣／右緣／中心 對齊成一欄，欄內（由上而下）連續 chartTickRun 格等差
	type bare struct {
		row    int
		v      float64
		x      [3]float64 // left, right, center
		single bool       // 這格自己占一整列
		span   [2]float64 // 水平範圍 left, right
	}
	var bs []bare
	for ri, r := range rows {
		for _, c := range r {
			if v, ok := bareNumber(c.text); ok {
				bs = append(bs, bare{row: ri, v: v, x: [3]float64{c.left, c.right, (c.left + c.right) / 2}, single: len(r) == 1, span: [2]float64{c.left, c.right}})
			}
		}
	}
	for k := 0; k < 3; k++ {
		var axes []float64 // 已找到的刻度欄的位置
		for i := range bs {
			var col []bare
			seen := map[int]bool{}
			for _, b := range bs {
				if abs64(b.x[k]-bs[i].x[k]) <= chartAlignTol && !seen[b.row] {
					seen[b.row] = true
					col = append(col, b)
				}
			}
			for s := 0; s+chartTickRun <= len(col); s++ {
				vals := make([]float64, chartTickRun)
				allSingle := true
				for j := range vals {
					vals[j] = col[s+j].v
					allSingle = allSingle && col[s+j].single
				}
				if !isArithmetic(vals) {
					continue
				}
				if allSingle {
					return true
				}
				if titledColumn(rows, col[s].row, col[s].span[0], col[s].span[1]) {
					continue // 欄頭是項目名（Revenue、Headcount）＝資料欄，不是座標軸
				}
				dup := false
				for _, x := range axes {
					if abs64(x-bs[i].x[k]) <= 2*chartAlignTol {
						dup = true
					}
				}
				if !dup {
					axes = append(axes, bs[i].x[k])
				}
				break
			}
		}
		if len(axes) >= 2 {
			return true
		}
	}
	return false
}

// titledColumn：這一欄（水平範圍 left–right）在 fromRow 之前、最近的一個水平重疊的非數字格是不是項目名。
// 座標軸頂上放的是單位縮寫（Nm、kW、rpm），資料表的欄頭是項目名（左對齊的欄頭配右對齊的數字也算同一欄）。
func titledColumn(rows [][]tcell, fromRow int, left, right float64) bool {
	for ri := fromRow - 1; ri >= 0; ri-- {
		for _, c := range rows[ri] {
			if c.left < right+chartAlignTol && c.right > left-chartAlignTol {
				if _, bare := bareNumber(c.text); bare {
					break // 欄裡更上面的刻度／數值，繼續往上找欄頭
				}
				return hasLabelWord(c.text)
			}
		}
	}
	return false
}

// dropChartTicks：判定這張表是不是圖的座標；是的話回傳整理後的列與拿掉的格（文字）。
// rows 由上而下。不是圖就原樣回傳、dropped＝nil。
func dropChartTicks(rows [][]tcell) ([][]tcell, []string) {
	if len(rows) < chartMinRows {
		return rows, nil
	}
	labelLess := func(r []tcell) bool {
		for _, c := range r {
			if hasLabelWord(c.text) {
				return false
			}
		}
		return true
	}
	nLess := 0
	for _, r := range rows {
		if labelLess(r) {
			nLess++
		}
	}
	if float64(nLess) < chartLabelLessFrac*float64(len(rows)) || !hasTickEvidence(rows) {
		return rows, nil
	}
	var out [][]tcell
	var dropped []string
	for _, r := range rows {
		if labelLess(r) {
			for _, c := range r {
				dropped = append(dropped, c.text)
			}
			continue
		}
		// 有項目名的列：只拿掉「不是規格值」的純數字格。「項目｜單位｜值」（Spindle speed｜rpm｜24,000）
		// 的值緊跟在單位後面，是規格，留著；其餘純數字（曲線旁的讀數、刻度）拿掉。
		var kept []tcell
		for i, c := range r {
			if _, ok := bareNumber(c.text); ok {
				if i >= 2 && isUnitCell(r[i-1].text) && hasLabelWord(r[i-2].text) {
					kept = append(kept, c)
					continue
				}
				dropped = append(dropped, c.text)
				continue
			}
			if numberRun(c.text) { // 「20 10」「3,500 5,000 7,000」：幾個刻度被併成一格
				dropped = append(dropped, c.text)
				continue
			}
			kept = append(kept, c)
		}
		if len(kept) > 0 {
			out = append(out, kept)
		}
	}
	return out, dropped
}

// stripChartTicksFromText：從一頁的純文字層拿掉「已被判成曲線圖座標」的字（inkstone/arcrun-rag#280 c21950）。
//
// 為什麼要有這一步：dropChartTicks 只管表格那一路（逐字表格段、原文段落）。但送給 AI 萃取的是整頁純文字，
// 刻度在那裡原樣都在 ⇒ 模型把「90 180／60 90」當規格，寫出「主軸功率 >> 是 >> 90 kW」進重點、三元組、實體。
// 要讓刻度「不以規格值的樣子出現在卡上任何地方」，源頭（餵給 AI 的文字）就不能有它。
//
// 只看表格層已掌握的證據（dropped＝拿掉的那批格，逐格計數），不另立判準：
//  1. 整行的字都對得上 dropped（刻度行、單位行）→ 整行拿掉。
//  2. 其餘行只拿掉對得上的字，但「項目 … 單位 值」的值留著（Spindle speed rpm 24,000 的 24,000）。
//
// 計數用完就不再拿，同一頁別處剛好相同的數字最多只受刻度本身的數量影響。
// 拿掉過東西就在該頁尾留一行說明（不靜默）。
func stripChartTicksFromText(text string, dropped []string) string {
	type cell struct {
		toks []string
		n    int
	}
	byKey := map[string]*cell{}
	var order []*cell
	for _, d := range dropped {
		k := strings.Join(strings.Fields(d), " ")
		if k == "" {
			continue
		}
		if c, ok := byKey[k]; ok {
			c.n++
			continue
		}
		c := &cell{toks: strings.Fields(k), n: 1}
		byKey[k] = c
		order = append(order, c)
	}
	if len(order) == 0 {
		return text
	}
	sort.SliceStable(order, func(a, b int) bool { return len(order[a].toks) > len(order[b].toks) }) // 長的先比
	match := func(toks []string, i int, consume bool) int {
		for _, c := range order {
			if c.n <= 0 || i+len(c.toks) > len(toks) {
				continue
			}
			ok := true
			for k, w := range c.toks {
				if toks[i+k] != w {
					ok = false
					break
				}
			}
			if ok {
				if consume {
					c.n--
				}
				return len(c.toks)
			}
		}
		return 0
	}
	// plan：這行哪些 token 要拿掉；all＝整行都是。consume=false 時不扣次數（試算）。
	plan := func(toks []string, consume bool) (rm []bool, all bool) {
		rm = make([]bool, len(toks))
		n := 0
		for i := 0; i < len(toks); {
			if _, isNum := bareNumber(toks[i]); isNum && i >= 1 && isUnitCell(toks[i-1]) {
				for _, e := range toks[:i-1] {
					if hasLabelWord(e) { // 「項目 … 單位 值」的值：留
						goto keepIt
					}
				}
			}
			if m := match(toks, i, consume); m > 0 {
				for k := 0; k < m; k++ {
					rm[i+k] = true
				}
				n += m
				i += m
				continue
			}
		keepIt:
			i++
		}
		return rm, n == len(toks) && n > 0
	}

	lines := strings.Split(text, "\n")
	// 第一輪：整行都是刻度的行先認領並扣次數
	whole := make([]bool, len(lines))
	removed := false
	for i, ln := range lines {
		toks := strings.Fields(ln)
		if len(toks) == 0 {
			continue
		}
		if _, all := plan(toks, false); all {
			plan(toks, true)
			whole[i] = true
			removed = true
		}
	}
	// 第二輪：其餘行拿掉剩下次數對得上的字
	out := make([]string, 0, len(lines))
	for i, ln := range lines {
		if whole[i] {
			continue
		}
		toks := strings.Fields(ln)
		if len(toks) == 0 {
			out = append(out, ln)
			continue
		}
		rm, _ := plan(toks, true)
		var keep []string
		for k, t := range toks {
			if !rm[k] {
				keep = append(keep, t)
			}
		}
		if len(keep) == len(toks) {
			out = append(out, ln)
			continue
		}
		removed = true
		if len(keep) > 0 {
			out = append(out, strings.Join(keep, " "))
		}
	}
	if !removed {
		return text
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n\r ") + "\n（這一頁夾著曲線圖：座標刻度與圖上的數字讀數未收錄，圖的數值請查原檔的圖）\n"
}
