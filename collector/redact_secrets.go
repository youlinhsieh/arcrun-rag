package collector

import (
	"fmt"
	"regexp"
	"strings"
)

// redact_secrets.go — 機敏值自動遮蔽（inkstone/arcrun-rag#294）。
//
// 🔴 為什麼不再整份拒收（leo 2026-11-05）：
//
//	「如果用戶有 1 萬份檔案，不能是我能處理的程式停下來不做……這是個 secret，我不萃，
//	 你需要就指向原檔案，有權限的人就看得到……不能停下來秀紅字」
//
// 舊制：H5 在**萃取之後**才看卡，命中就整份 rejected ⇒ ①Portal 一直掛紅字、要人處理
// ②更糟的是原稿純文字在萃取那一步**已經整份送上雲端**，擋卡只擋到最後一步。
//
// 新制（兩道，都在本機、都不擋）：
//  1. 送萃取前：redactSecretText 把原稿裡的機敏值換成指標〔機敏值，未萃取：請看原檔第 N 行〕
//     ⇒ 機敏值從此不出這台電腦（萃取請求、卡片、雲端都看不到原值）。
//  2. 卡片落地後、lint 前：再掃一次卡片（逐字表、讀圖原文、模型回聲都可能帶原文），
//     還有就遮掉——**不擋**。H5 仍留在 lint 裡當最後的防線（理論上已撞不到）。
//
// 判準與 H5 共用同一張 secretPatterns（lint.go），不另立一套 ⇒ 「遮過的東西 H5 一定看不到」。
// 個人證號（身分證／卡號）仍走 redact_ids.go（#251），本檔不重複處理。
//
// 日誌：本檔只回傳「幾處、哪幾類」，**永遠不回傳、不記錄原值**。

// secretMarkerPrefix＝指標的開頭；H5 掃描前會先把指標拿掉（見 stripSecretMarkers）。
const secretMarkerPrefix = "〔機敏值，未萃取"

var secretMarkerRe = regexp.MustCompile(`〔機敏值，未萃取[^〕]*〕`)

// assignValueRe：「密碼/密鑰賦值」只遮等號後面的值，留下鍵名（讀卡的人才知道那裡原本是什麼）。
// 與 lint.go 同一條 pattern，多了兩個分組。
// envAssignRe：環境變數式賦值，只遮值、留鍵名（與 lint.go「環境變數式密鑰賦值」同一條，多兩個分組）。
var envAssignRe = regexp.MustCompile(`(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*[[:space:]]*=[[:space:]]*)(["'][^[:space:]<>"'` + "`" + `_〔][^[:space:]<>"'` + "`" + `〔]{15,}|[^[:space:]<>"'` + "`" + `〔]{16,})`)

var assignValueRe = regexp.MustCompile(`(?i)((?:pass(?:word)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|priv(?:ate)?[_-]?key)["']?[[:space:]]*[:=][[:space:]]*)(["'][^[:space:]<>"'_〔][^[:space:]<>"'〔]{5,}|[^[:space:]<>"'〔]{6,})`)

// botTokenRe：Telegram bot token 只遮「數字:token」，留下網址裡的 `bot` 前綴（與 lint.go 同一條，多兩個分組）。
var botTokenRe = regexp.MustCompile(`(\bbot|\b)([0-9]{6,12}:[A-Za-z0-9_-]{30,})`)

// urlParamSecretRe：網址查詢參數只遮值，留下 `?鍵=`（與 lint.go「網址參數內的密鑰」同一條，多兩個分組）。
var urlParamSecretRe = regexp.MustCompile(`(?i)([?&](?:secret|secret_token|client_secret|token|access_token|refresh_token|id_token|auth_token|api_?key|password|passwd|sig|signature)=)([^&#[:space:]"'<>{}$〔]{8,})`)

// connCredRe：連線字串只遮「帳號:密碼」，留下協定與主機。
var connCredRe = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^[:space:]:/@]+:[^[:space:]:/@]+)(@)`)

var pemBeginRe = regexp.MustCompile(`-----BEGIN[[:space:]].*PRIVATE KEY-----`)

const pemMaxLines = 200 // 沒有 END 行時最多吃掉幾行（防一個壞檔把後面全遮光）

// secretRedaction＝一次遮蔽的統計（只有數量與類別，沒有原值）。
type secretRedaction struct {
	Count  int
	Labels []string // 命中的類別（去重保序），與 H5 的標籤相同
	Lines  []int    // 命中的行號（1 起算，對應傳進來的文字）
	// LineRefs＝Lines 是不是原檔的行號（純文字檔才是；docx/pdf 轉出來的行號對不上原檔）。
	LineRefs bool
}

func (r *secretRedaction) add(label string, line int) {
	r.Count++
	seen := false
	for _, l := range r.Labels {
		if l == label {
			seen = true
			break
		}
	}
	if !seen {
		r.Labels = append(r.Labels, label)
	}
	if n := len(r.Lines); n == 0 || r.Lines[n-1] != line {
		r.Lines = append(r.Lines, line)
	}
}

// merge 把另一次遮蔽的統計併進來（行號只在兩邊都是原檔行號時保留）。
func (r *secretRedaction) merge(o secretRedaction) {
	if o.Count == 0 {
		return
	}
	r.Count += o.Count
	for _, l := range o.Labels {
		dup := false
		for _, have := range r.Labels {
			dup = dup || have == l
		}
		if !dup {
			r.Labels = append(r.Labels, l)
		}
	}
	if !o.LineRefs {
		r.LineRefs = false
	}
}

func secretMarker(withLine bool, line int) string {
	if withLine {
		return fmt.Sprintf("%s：請看原檔第 %d 行〕", secretMarkerPrefix, line)
	}
	return secretMarkerPrefix + "：請看原檔〕"
}

// stripSecretMarkers 把指標換成一個 H5 pattern 不會接著吃的字元（`"`），
// 免得「password: 〔指標〕 後面的字」被當成新的賦值。
func stripSecretMarkers(line string) string {
	if !strings.Contains(line, secretMarkerPrefix) {
		return line
	}
	return secretMarkerRe.ReplaceAllString(line, `"`)
}

// redactSecretText 逐行把機敏值換成指標。withLineRefs＝指標要不要帶行號
// （純文字檔的行號就是原檔行號；docx/pdf 轉出來的行號對不上原檔，就不帶）。
// 沒有命中時原樣回傳、Count==0。
func redactSecretText(text string, withLineRefs bool) (string, secretRedaction) {
	rep := secretRedaction{LineRefs: withLineRefs}
	if !mayContainSecret(text) {
		return text, rep
	}
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		lineNo := i + 1
		if strings.Contains(line, "wiki-secret-ok") {
			continue // 與 H5 同一個行內豁免
		}
		mk := secretMarker(withLineRefs, lineNo)

		// 私鑰 PEM：BEGIN 到 END 整塊換成一個指標，其餘行留空（行號不位移）。
		if pemBeginRe.MatchString(line) {
			lines[i] = pemBeginRe.ReplaceAllString(line, mk)
			rep.add("私鑰 PEM 區塊", lineNo)
			if !strings.Contains(line, "-----END") {
				for j := i + 1; j < len(lines) && j <= i+pemMaxLines; j++ {
					end := strings.Contains(lines[j], "-----END")
					lines[j] = ""
					if end {
						i = j
						break
					}
					i = j
				}
			}
			continue
		}

		for _, p := range secretPatterns {
			if p.re == nil {
				continue // 信用卡號等 match 型：個人證號走 redact_ids.go
			}
			if !p.re.MatchString(stripSecretMarkers(line)) {
				continue // 已遮過的指標不算（冪等）
			}
			switch p.label {
			case "台灣身分證字號", "私鑰 PEM 區塊":
				continue
			case "密碼/密鑰賦值":
				if assignValueRe.MatchString(line) {
					line = replaceAssignValue(assignValueRe, line, mk)
					rep.add(p.label, lineNo)
				}
			case "環境變數式密鑰賦值":
				if envAssignRe.MatchString(line) {
					line = replaceAssignValue(envAssignRe, line, mk)
					rep.add(p.label, lineNo)
				}
			case "Telegram bot token":
				if botTokenRe.MatchString(line) {
					line = botTokenRe.ReplaceAllString(line, "${1}"+mk)
					rep.add(p.label, lineNo)
				}
			case "網址參數內的密鑰":
				if urlParamSecretRe.MatchString(line) {
					line = urlParamSecretRe.ReplaceAllString(line, "${1}"+mk)
					rep.add(p.label, lineNo)
				}
			case "連線字串內嵌帳密":
				if connCredRe.MatchString(line) {
					line = connCredRe.ReplaceAllString(line, "${1}"+mk+"${3}")
					rep.add(p.label, lineNo)
				}
			default:
				if p.re.MatchString(line) {
					line = p.re.ReplaceAllString(line, mk)
					rep.add(p.label, lineNo)
				}
			}
		}
		lines[i] = line
	}
	if rep.Count == 0 {
		return text, rep
	}
	return strings.Join(lines, "\n"), rep
}

// mayContainSecret：便宜的前置篩（大檔每輪都會經過這裡，別每行跑七條 regexp）。
func mayContainSecret(text string) bool {
	for _, p := range secretPatterns {
		if p.re == nil {
			continue
		}
		if p.re.MatchString(text) {
			return true
		}
	}
	return false
}

// secretNote＝寫進文件卡「讀不到的內容」段的一句話：有幾處沒萃、去哪看。
func secretNote(rep secretRedaction, relPath string) string {
	if rep.Count == 0 {
		return ""
	}
	where := ""
	if rep.LineRefs && len(rep.Lines) > 0 && len(rep.Lines) <= 10 {
		parts := make([]string, len(rep.Lines))
		for i, n := range rep.Lines {
			parts[i] = itoa(n)
		}
		where = "（第 " + strings.Join(parts, "、") + " 行）"
	}
	return fmt.Sprintf("本檔有 %d 處疑似機敏值%s（%s）刻意沒有萃取，卡上以「〔機敏值，未萃取〕」標出位置。"+
		"需要原值請開原檔 %s——只有看得到那台電腦上原檔的人看得到。被問到時請這樣說明，不要猜測原值。",
		rep.Count, where, strings.Join(rep.Labels, "、"), relPath)
}

// replaceAssignValue 把「鍵＝值」的值換成指標。值若帶開頭引號（`DB_PASSWORD = "…"`）就把那個引號留著，
// 指標放在引號裡面，後面的收尾引號原本就不在值裡、自然還在。
func replaceAssignValue(re *regexp.Regexp, line, mk string) string {
	return re.ReplaceAllStringFunc(line, func(m string) string {
		sm := re.FindStringSubmatch(m)
		if len(sm) < 3 {
			return m
		}
		q := ""
		if strings.HasPrefix(sm[2], `"`) || strings.HasPrefix(sm[2], "'") {
			q = sm[2][:1]
		}
		return sm[1] + q + mk
	})
}
