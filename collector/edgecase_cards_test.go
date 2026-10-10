package collector

// inkstone/arcrun-rag#254：讀檔特例卡片的機械檢查。
// 卡片住在 system-dev/wiki/cards/reading-edge-cases/（規範見該目錄《讀檔特例卡片規範》）。
// 不檢查產品行為，只檢查「卡有掛進索引、指到的測試真的存在、每張卡都交代了測試」，
// 否則卡片會悄悄漂掉（測試改名、卡忘了掛索引）。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestEdgeCaseCards_IndexedAndTestsExist(t *testing.T) {
	dir := filepath.Join("..", "system-dev", "wiki", "cards", "reading-edge-cases")
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("找不到特例卡目錄：%v", err)
	}
	idxBytes, err := os.ReadFile(filepath.Join(dir, "00-INDEX.md"))
	if err != nil {
		t.Fatalf("缺 00-INDEX.md：%v", err)
	}
	idx := string(idxBytes)
	ref := regexp.MustCompile("^- 測試：(\\S+?)::(\\S+)$")
	cards := 0
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".md") || name == "00-INDEX.md" {
			continue
		}
		title := strings.TrimSuffix(name, ".md")
		if !strings.Contains(idx, "[["+title+"]]") {
			t.Errorf("卡沒有掛進 00-INDEX：%s", title)
		}
		if title == "讀檔特例卡片規範" {
			continue
		}
		cards++
		b, _ := os.ReadFile(filepath.Join(dir, name))
		accounted := false
		for _, ln := range strings.Split(string(b), "\n") {
			ln = strings.TrimSpace(ln)
			if strings.HasPrefix(ln, "- 缺測試：") || strings.HasPrefix(ln, "- 待併分支：") {
				accounted = true
				continue
			}
			m := ref.FindStringSubmatch(ln)
			if m == nil {
				continue
			}
			accounted = true
			src, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(m[1])))
			if err != nil {
				t.Errorf("[%s] 測試檔不存在：%s", title, m[1])
				continue
			}
			if !strings.Contains(string(src), "func "+m[2]+"(") {
				t.Errorf("[%s] %s 裡找不到 func %s", title, m[1], m[2])
			}
		}
		if !accounted {
			t.Errorf("[%s] 沒有交代測試：要有「- 測試：path::Name」或「- 缺測試：」或「- 待併分支：」", title)
		}
	}
	if cards < 30 {
		t.Errorf("特例卡只有 %d 張，疑似被誤刪", cards)
	}
}

// 卡 ↔ 程式雙向對應：卡寫了符號而程式沒有、程式登記了而卡沒有、前端提示與程式不一致，全部要失敗。
func TestEdgeCaseCards_MatchGoRegistry(t *testing.T) {
	dir := filepath.Join("..", "system-dev", "wiki", "cards", "reading-edge-cases")
	ents, _ := os.ReadDir(dir)
	reg := map[string]EdgeCase{}
	for _, e := range EdgeCases {
		if _, dup := reg[e.ID]; dup {
			t.Errorf("EdgeCases 編號重複：%s", e.ID)
		}
		reg[e.ID] = e
	}
	// 所有非測試原始碼合併，用來確認符號真的存在
	var all strings.Builder
	gofiles, _ := filepath.Glob("*.go")
	for _, f := range gofiles {
		if strings.HasSuffix(f, "_test.go") || f == "edgecases.go" {
			continue
		}
		b, _ := os.ReadFile(f)
		all.Write(b)
	}
	src := all.String()
	idRe := regexp.MustCompile(`(?m)^- 編號：(\S+)$`)
	goRe := regexp.MustCompile(`(?m)^- Go判斷：(\S+)`)
	llmRe := regexp.MustCompile(`(?m)^- LLM萃取要求：\S`)
	histRe := regexp.MustCompile(`(?m)^## 歷史\n\S`)
	seen := map[string]bool{}
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || n == "00-INDEX.md" || n == "讀檔特例卡片規範.md" || !strings.HasSuffix(n, ".md") {
			continue
		}
		b, _ := os.ReadFile(filepath.Join(dir, n))
		s := string(b)
		im := idRe.FindStringSubmatch(s)
		if im == nil {
			t.Errorf("[%s] 缺「- 編號：」", n)
			continue
		}
		id := im[1]
		seen[id] = true
		r, ok := reg[id]
		if !ok {
			t.Errorf("[%s] 編號 %s 沒有登記在 edgecases.go", n, id)
			continue
		}
		gm := goRe.FindStringSubmatch(s)
		if gm == nil {
			t.Errorf("[%s] 缺「- Go判斷：」", n)
			continue
		}
		want := r.Detector
		if want == "" {
			want = "無（尚未實作）"
		}
		if !strings.HasPrefix(gm[0], "- Go判斷："+want) {
			t.Errorf("[%s] 卡上 Go判斷（%s）與 edgecases.go 的 Detector（%s）不一致", n, gm[1], want)
		}
		if r.Detector != "" && !regexp.MustCompile(`\b`+regexp.QuoteMeta(r.Detector)+`\b`).MatchString(src) {
			t.Errorf("[%s] Detector %s 在程式裡找不到", n, r.Detector)
		}
		if !llmRe.MatchString(s) {
			t.Errorf("[%s] 缺「- LLM萃取要求：」（沒有也要明寫沒有）", n)
		}
		if !histRe.MatchString(s) {
			t.Errorf("[%s] 缺「## 歷史」段", n)
		}
	}
	for id := range reg {
		if !seen[id] {
			t.Errorf("edgecases.go 登記了 %s 但沒有對應的卡", id)
		}
	}
	// FixableKind 只准回傳登記過的標籤
	labels := EdgeCaseLabels()
	// #246 c18745／c18750：「太大了」（舊版病歷）與「沒有可抽取」（掃描檔）都不再是用戶要修的事 ⇒ FixableKind 回空
	for msg, want := range map[string]string{"太大了": "", "沒有可抽取": "", "轉檔失敗": LabelNoText, "尚未支援的檔案格式": LabelUnsupFmt} {
		if got := FixableKind(msg); got != want {
			t.Errorf("FixableKind(%q)=%q want %q", msg, got, want)
		}
		if want == "" {
			continue
		}
		if _, ok := labels[want]; !ok {
			t.Errorf("標籤 %q 沒有登記在 EdgeCases", want)
		}
	}
	// 前端提示必須與程式一致
	js, err := os.ReadFile(filepath.Join("cmd", "arcrun-app", "frontend", "src", "main.js"))
	if err != nil {
		t.Fatalf("讀不到 main.js：%v", err)
	}
	for _, l := range labels {
		if !strings.Contains(string(js), "'"+l.Label+"': '"+l.FixHint+"'") {
			t.Errorf("main.js 的 FIX_HINT 缺或不同於 %q → %q", l.Label, l.FixHint)
		}
	}
}
