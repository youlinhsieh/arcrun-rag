// wikireader.go — 文件的「讀者欄」層（inkstone/InkStoneCo#264 表格試點 → 上線）。
//
// 病：英文原稿（錯誤碼、手冊）的目錄行只有英文節錄。wikizh.go 的逐詞對照是應急補丁，
// 試點實測用中文症狀描述查，單資料夾 hit@5 只有約五成；換成「讀者欄」（逐欄正體中文譯文＋
// 6～12 句讀者會怎麼問）後，同一套 BM25＋改寫＋重排達 75%，多資料夾 84%。
//
// 這一層的規則（使用者原則，2026-11-04）：
//   - **就地**：讀者欄記在 wiki 帳本（.wiki/manifest.json）那份文件的條目裡，不另建檔、
//     不重送文件卡；只有目錄行變長。
//   - **有版本**：每份讀者欄記「產生時的原稿雜湊」與「讀者欄策略版本」。
//     原稿改了（雜湊不符）＝這份讀者欄作廢，目錄行退回舊樣子，等工班重做那一份（進場時機④）；
//     策略升版（readerLayerVer 加一）＝舊讀者欄照用（總比沒有好），但列入待重做（進場時機③）。
//   - **通用**：不認錯誤碼、不認客戶。哪些資料夾要做讀者欄由技師勘察決定，本檔只管存、用、驗。
//   - 不存向量。
//
// 讀者欄從哪來：工班（雲端批次或 daemon 自己）產出 JSONL，放進監看根的
// `.arcrun-rag/inbox/reader-*.jsonl`；daemon 每輪在自己的鎖裡併進帳本，併完就刪掉那份檔
// （收件匣不留殘檔）。不走 CLI 直接改帳本，是因為 daemon 是另一個行程，兩邊同時寫帳本會互蓋。
package collector

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// readerLayerVer＝目前的讀者欄策略版本。改了提示詞／欄位規則就加一。
const readerLayerVer = 1

const (
	readerZhMax  = 120 // 目錄行「中」段字數上限
	readerAskMax = 8   // 目錄行「問」段最多幾句
	readerAskLen = 24  // 每句問法字數上限
)

// docReader＝一份文件的讀者欄。
type docReader struct {
	Ver int      `json:"ver"`
	SHA string   `json:"sha256"` // 產生時的原稿雜湊（＝wikiDoc.SHA256）
	Zh  string   `json:"zh,omitempty"`
	Ask []string `json:"ask,omitempty"`
	By  string   `json:"by,omitempty"` // 產生的模型（記錄用，不影響行為）
}

// readerUsable：讀者欄對得上目前的原稿（版本舊也照用）。
func readerUsable(d wikiDoc) bool {
	return d.Reader != nil && d.Reader.SHA != "" && d.Reader.SHA == d.SHA256 &&
		(strings.TrimSpace(d.Reader.Zh) != "" || len(d.Reader.Ask) > 0)
}

// readerNeedsWork：這份文件的讀者欄要（重）做嗎？只對已經有讀者欄、或被技師指定要做的資料夾有意義；
// 回傳原因（空＝不用做）。
func readerNeedsWork(d wikiDoc) string {
	switch {
	case d.Status == "no_concept":
		return ""
	case d.Reader == nil:
		return "沒有讀者欄"
	case d.Reader.SHA != d.SHA256:
		return "原稿改過"
	case d.Reader.Ver < readerLayerVer:
		return fmt.Sprintf("策略版本舊（v%d → v%d）", d.Reader.Ver, readerLayerVer)
	}
	return ""
}

func clipRunes(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// readerTag：附在目錄行後面的讀者段：「｜中：…｜問：…；…」。
// 分隔符與 wikizh.go 相同，所以 idxFirstClause（分組摘要）一樣會把它切掉。
func readerTag(r *docReader) string {
	if r == nil {
		return ""
	}
	clean := func(s string) string { // 目錄行是一行：不准換行、不准出現會打斷連結語法的字
		return strings.NewReplacer("\n", " ", "\r", " ", "｜", "/", "[[", "", "]]", "").Replace(s)
	}
	out := ""
	if zh := clipRunes(clean(r.Zh), readerZhMax); zh != "" {
		out += "｜中：" + zh
	}
	var asks []string
	seen := map[string]bool{}
	for _, a := range r.Ask {
		a = clipRunes(clean(a), readerAskLen)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		asks = append(asks, strings.ReplaceAll(a, "；", "，"))
		if len(asks) >= readerAskMax {
			break
		}
	}
	if len(asks) > 0 {
		out += "｜問：" + strings.Join(asks, "；")
	}
	return out
}

// readerInboxDir＝讀者欄收件匣（在 daemon 自己的 .arcrun-rag/ 底下）。
func readerInboxDir(absRoot string) string {
	return filepath.Join(absRoot, workspaceRelDir, "inbox")
}

// readerInLine＝收件匣 JSONL 的一行。node 用帳本的節點鍵（根＝「(根)」）。
type readerInLine struct {
	Node string   `json:"node"`
	Path string   `json:"path"`
	SHA  string   `json:"sha256"`
	Ver  int      `json:"ver"`
	Zh   string   `json:"zh"`
	Ask  []string `json:"ask"`
	By   string   `json:"by"`
}

// readerMergeReport＝併一次收件匣的結果（每一類都講出來，不安靜跳過）。
type readerMergeReport struct {
	Files     int      `json:"files"`
	Merged    int      `json:"merged"`
	Stale     int      `json:"stale"`   // 原稿雜湊對不上（產生後原稿又改了）：丟掉，等重做
	Missing   int      `json:"missing"` // 帳本裡沒有這份文件
	Bad       int      `json:"bad"`     // 解析失敗／缺欄
	Unchanged int      `json:"unchanged"`
	Errors    []string `json:"errors,omitempty"`
}

// mergeReaderLines 把讀者欄併進帳本（純函式，不碰檔案）。同一份文件出現多次＝最後一筆為準。
func mergeReaderLines(m *wikiManifest, lines []readerInLine, rep *readerMergeReport) bool {
	changed := false
	for _, ln := range lines {
		if ln.Path == "" || ln.SHA == "" || (strings.TrimSpace(ln.Zh) == "" && len(ln.Ask) == 0) {
			rep.Bad++
			continue
		}
		node := ln.Node
		if node == "" {
			node = wikiRootNodeKey
		}
		d := m.find(node, ln.Path)
		if d == nil {
			rep.Missing++
			continue
		}
		if d.SHA256 != ln.SHA {
			rep.Stale++
			continue
		}
		ver := ln.Ver
		if ver <= 0 {
			ver = readerLayerVer
		}
		nr := &docReader{Ver: ver, SHA: ln.SHA, Zh: strings.TrimSpace(ln.Zh), Ask: ln.Ask, By: ln.By}
		if d.Reader != nil && d.Reader.Ver == nr.Ver && d.Reader.SHA == nr.SHA && d.Reader.Zh == nr.Zh &&
			strings.Join(d.Reader.Ask, "\x00") == strings.Join(nr.Ask, "\x00") {
			rep.Unchanged++
			continue
		}
		d.Reader = nr
		rep.Merged++
		changed = true
	}
	return changed
}

func readReaderFile(p string, rep *readerMergeReport) ([]readerInLine, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []readerInLine
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" {
			continue
		}
		var ln readerInLine
		if json.Unmarshal([]byte(t), &ln) != nil {
			rep.Bad++
			continue
		}
		out = append(out, ln)
	}
	return out, sc.Err()
}

// mergeReaderInbox：把收件匣裡的讀者欄併進帳本，有變就重寫本機目錄；併完刪掉收件匣的檔。
// 讀檔失敗的那份留著（下一輪再試），並寫進 Errors。
func mergeReaderInbox(absRoot string) (*readerMergeReport, error) {
	files, _ := filepath.Glob(filepath.Join(readerInboxDir(absRoot), "reader-*.jsonl"))
	if len(files) == 0 {
		return nil, nil
	}
	sort.Strings(files)
	rep := &readerMergeReport{}
	wikiDocMu.Lock()
	defer wikiDocMu.Unlock()
	m := loadWikiManifest(absRoot)
	var done []string
	changed := false
	for _, p := range files {
		lines, err := readReaderFile(p, rep)
		if err != nil {
			rep.Errors = append(rep.Errors, filepath.Base(p)+"："+err.Error())
			continue
		}
		rep.Files++
		if mergeReaderLines(m, lines, rep) {
			changed = true
		}
		done = append(done, p)
	}
	if changed {
		if err := saveWikiManifest(absRoot, m); err != nil {
			return rep, err // 帳本沒寫成：收件匣的檔留著，下一輪重來
		}
		if err := regenerateWikiIndexes(absRoot, m); err != nil {
			rep.Errors = append(rep.Errors, "本機目錄重寫失敗："+err.Error())
		}
	}
	for _, p := range done {
		_ = os.Remove(p)
	}
	_ = os.Remove(readerInboxDir(absRoot)) // 空了就收掉（不空會失敗，正好不動）
	return rep, nil
}

// readerBacklog：列出要（重）做讀者欄的文件。只看「該節點已有任何一份讀者欄」的節點——
// 那代表技師已經決定這個資料夾要做讀者欄；其餘節點不在本層範圍。
func readerBacklog(m *wikiManifest) map[string][]string {
	enabled := map[string]bool{}
	for _, d := range m.Docs {
		if d.Reader != nil {
			enabled[d.Node] = true
		}
	}
	out := map[string][]string{}
	for _, d := range m.Docs {
		if !enabled[d.Node] {
			continue
		}
		if why := readerNeedsWork(d); why != "" {
			out[why] = append(out[why], d.Node+"/"+d.Path)
		}
	}
	return out
}
