package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#240 c18241 — error_codes 失敗分類的回歸測試。

// points 夾了 bool（126-011E）：整份不該因為一個格式小毛病被擋 8 次。
func TestParseWikiExtractJSON_PointsWithBoolTolerated(t *testing.T) {
	in := `{"gloss":"錯誤碼126-011E說明文件","tags":["錯誤碼",true],"summary":"摘要","points":["重點一",false,null,7],"concepts":[{"name":"授權","gloss":"g","summary":"s","points":"單一字串"}]}`
	ex, err := parseWikiExtractJSON(in)
	if err != nil {
		t.Fatalf("bool 夾在清單裡應被容忍：%v", err)
	}
	if len(ex.Points) != 2 || ex.Points[0] != "重點一" || ex.Points[1] != "7" {
		t.Fatalf("points 應丟掉 bool/null、數字轉字串，got %v", ex.Points)
	}
	if len(ex.Tags) != 1 || ex.Tags[0] != "錯誤碼" {
		t.Fatalf("tags=%v", ex.Tags)
	}
	if len(ex.Concepts) != 1 || len(ex.Concepts[0].Points) != 1 || ex.Concepts[0].Points[0] != "單一字串" {
		t.Fatalf("概念 points 單一字串應包成一項，got %+v", ex.Concepts)
	}
	// 真壞的 JSON 仍報錯
	if _, err := parseWikiExtractJSON(`{"points": [1,`); err == nil {
		t.Fatal("壞 JSON 應報錯")
	}
}

// 概念名只差大小寫（Error message / Error Message）：不分大小寫的檔案系統會寫成同一檔。
func TestBuildWikiDoc_ConceptNameCaseInsensitiveCollision(t *testing.T) {
	root := t.TempDir()
	mk := func(rel, concept string) error {
		mustWrite(t, filepath.Join(root, rel), "# "+rel+"\n\n內文")
		ex := &DocExtract{Gloss: "g", Summary: "s", Points: []string{"p [[" + concept + "]]"},
			Concepts: []WikiConcept{{Name: concept, Gloss: "g", Summary: "s", Points: []string{"x"}}}}
		_, err := BuildWikiDoc(root, rel, "# "+rel+"\n\n內文", ex, wsOrigin(rel), wsNow)
		return err
	}
	if err := mk("125-0071_002.md", "Error Message"); err != nil {
		t.Fatal(err)
	}
	if err := mk("1A0-0077_002.md", "Error message"); err != nil {
		t.Fatalf("只差大小寫的概念名應消歧，不該撞名：%v", err)
	}
	ents, _ := os.ReadDir(filepath.Join(root, ".wiki"))
	seen := map[string]bool{}
	for _, e := range ents {
		k := strings.ToLower(e.Name())
		if seen[k] {
			t.Fatalf(".wiki 內出現只差大小寫的兩個檔：%s", e.Name())
		}
		seen[k] = true
	}
}

// 上一輪寫到一半（卡已落地、manifest 沒存）→ 殘卡不能擋住自己下一輪的重試（160-0122_002）。
func TestBuildWikiDoc_OwnOrphanCardOverwritten(t *testing.T) {
	root := t.TempDir()
	rel := "160-0122_002.md"
	src := "# 160-0122 (2/2)\n\n內文"
	mustWrite(t, filepath.Join(root, rel), src)
	ex := func() *DocExtract {
		return &DocExtract{Gloss: "g", Summary: "s", Points: []string{"p [[甲]]"},
			Concepts: []WikiConcept{{Name: "甲", Gloss: "g", Summary: "s", Points: []string{"x"}}}}
	}
	if _, err := BuildWikiDoc(root, rel, src, ex(), wsOrigin(rel), wsNow); err != nil {
		t.Fatal(err)
	}
	// 模擬「manifest 沒存」：卡留著、manifest 刪掉
	if err := os.Remove(filepath.Join(root, ".wiki", "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildWikiDoc(root, rel, src, ex(), wsOrigin(rel), wsNow); err != nil {
		t.Fatalf("自己的殘卡應可覆寫：%v", err)
	}
	// 別人的檔（沒有本文件的出處行）仍不覆蓋——但也不報錯，概念卡改名閃開（#246 c18722）。
	other := filepath.Join(root, ".wiki", "乙.md")
	mustWrite(t, other, "使用者自己寫的")
	ex2 := ex()
	ex2.Concepts[0].Name = "乙"
	ex2.Points = []string{"p [[乙]]"}
	if _, err := BuildWikiDoc(root, rel, src, ex2, wsOrigin(rel), wsNow); err != nil {
		t.Fatalf("撞名不該是錯誤：%v", err)
	}
	if b, _ := os.ReadFile(other); string(b) != "使用者自己寫的" {
		t.Fatal("使用者原有的檔不該被覆蓋")
	}
}

// 兩個監看根疊在一起：同一份原文只一張卡、出處兩行；不同原文同卡名則兩份都有。#246 c18722
func TestBuildWikiDoc_OverlappingRootsNoCollisionError(t *testing.T) {
	outer := t.TempDir()
	inner := filepath.Join(outer, "legacy")
	mustWrite(t, filepath.Join(inner, "A.md"), "# A\n\n內文")
	mustWrite(t, filepath.Join(inner, "B.md"), "# B\n\n別的內文")
	mk := func(name string) *DocExtract {
		return &DocExtract{Gloss: "g", Summary: "s", Points: []string{"p [[" + name + "]]"},
			Concepts: []WikiConcept{{Name: name, Gloss: "g", Summary: "s", Points: []string{"x"}}}}
	}
	innerOrigin := SourceOrigin{MachineLabel: "m", Library: "legacy", LibraryPath: "A.md"}
	outerOrigin := SourceOrigin{MachineLabel: "m", Library: "pms", LibraryPath: "legacy/A.md"}
	if _, err := BuildWikiDoc(inner, "A.md", "# A\n\n內文", mk("共用概念"), innerOrigin, wsNow); err != nil {
		t.Fatal(err)
	}
	// 外層根的 .wiki 在 legacy/.wiki（同一個資料夾），但它自己的 manifest 不知道內層寫過什麼
	if _, err := BuildWikiDoc(outer, "legacy/A.md", "# A\n\n內文", mk("共用概念"), outerOrigin, wsNow); err != nil {
		t.Fatalf("同一份原文疊根不該報錯：%v", err)
	}
	b, err := os.ReadFile(filepath.Join(inner, ".wiki", "共用概念.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "- `legacy/A.md`") || !strings.Contains(string(b), "- `pms/legacy/A.md`") {
		t.Fatalf("卡上應指向兩條出處：\n%s", b)
	}
	// 不同原文、同一個概念名：兩份都在，各留出處
	if _, err := BuildWikiDoc(outer, "legacy/B.md", "# B\n\n別的內文", mk("共用概念"), SourceOrigin{MachineLabel: "m", Library: "pms", LibraryPath: "legacy/B.md"}, wsNow); err != nil {
		t.Fatalf("不同原文同名不該報錯：%v", err)
	}
	ents, _ := os.ReadDir(filepath.Join(inner, ".wiki"))
	n := 0
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "共用概念") {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("同名概念應各留一張（共用概念＋共用概念（B）），實際 %d", n)
	}
}

// 舊版留下的「卡片位置被佔用」病歷：不算出錯、會重排。
func TestCardCollisionLegacyErrorIsNotAnError(t *testing.T) {
	m := &Manifest{Entries: map[string]*ManifestEntry{"x.md": {ContentHash: "h", FailCount: 8,
		LastError: "本地萃取失敗：卡片位置被佔用（不覆蓋既有檔案）：.wiki/x.md"}}}
	if p := m.Progress(); p.Errors() != 0 || p.Waiting() != 1 {
		t.Fatalf("撞名不得算出錯：%+v", p)
	}
	if !m.ShouldRetry("x.md", 1<<40, false) {
		t.Fatal("舊撞名病歷應重排")
	}
}

// 暫時性失敗撞滿 8 次不該永遠停；額度類窗口過後再試、解析類仍停。
func TestShouldRetry_TransientCloudFailureKeepsTrying(t *testing.T) {
	cases := map[string]bool{
		"本地萃取失敗：雲端萃取失敗（HTTP 502）：雲端萃取：Workers AI 執行失敗：4007: An internal server error occured.":               true,
		"本地萃取失敗：雲端萃取失敗（HTTP 502）：雲端萃取：Workers AI 執行失敗：4002: could not route request to AI model":             true,
		"本地萃取失敗：連不上你的知識庫：Post \"https://x/portal/daemon/extract\": read tcp: read: connection reset by peer": true,
		`HTTP 500：{"error":"daily_write_budget_reserved_for_indexing"}`:                                      true, // 額度用完隔天重置，窗口過後再試
		"本地萃取失敗：萃取 JSON 解析失敗：x":                                                                              false,
	}
	for msg, want := range cases {
		m := newRetryTestManifest("a.md")
		e := m.Entries["a.md"]
		e.FailCount, e.NextRetry, e.LastError, e.FailLintRev = MaxFailBeforeSkip, 2000, msg, lintGateRevision
		if m.ShouldRetry("a.md", 1000, false) {
			t.Fatalf("退避窗口內不該重試：%s", msg)
		}
		if got := m.ShouldRetry("a.md", 2001, false); got != want {
			t.Errorf("窗口過後 ShouldRetry=%v want %v：%s", got, want, msg)
		}
	}
}

// 「雲端沒寫進」的真因是資料庫每日寫入額度用完，外層 error 只有空殼 → 不能講「稍後會自動再試」。
func TestRejectedSentence_DailyWriteBudgetNamedAsQuota(t *testing.T) {
	body := `{"success":false,"data":{"data":{"body":"{\"error\":\"HTTP 429\",\"status\":429,\"body\":\"{\\\"success\\\":false,\\\"error\\\":\\\"daily_write_budget_reserved_for_indexing\\\",\\\"message\\\":\\\"KBDB has reserved part of today's D1 free tier daily row write limit for search-index maintenance.\\\"}\"}"}},"error":"HTTP 500"}`
	got := triggerRejectedSentence(body, nil)
	if got == "" || strings.Contains(got, "稍後會自動再試。") && !strings.Contains(got, "額度") {
		t.Fatalf("應講成額度用完，got %q", got)
	}
	if !strings.Contains(got, "額度") && !strings.Contains(got, "免費") {
		t.Fatalf("句子沒提到額度：%q", got)
	}
	if d1QuotaKind("daily_write_budget_reserved_for_indexing") != QuotaKindD1Write {
		t.Fatal("daily_write_budget_reserved_for_indexing 應認成寫入額度")
	}
	// 其他沒原因的失敗仍是原句
	if g := triggerRejectedSentence(`{"success":false,"error":"boom"}`, nil); !strings.Contains(g, "稍後會自動再試") {
		t.Fatalf("非額度失敗應維持原句：%q", g)
	}
}

func TestShouldRetry_QuotaPauseRetriesAfterWindow(t *testing.T) {
	m := newRetryTestManifest("a.md")
	e := m.Entries["a.md"]
	e.FailCount, e.NextRetry, e.FailLintRev = MaxFailBeforeSkip, 2000, lintGateRevision
	e.LastError = "雲端沒有把這一份寫進你的知識庫：雲端知識庫今天的免費寫入額度用完。（會自動恢復）。"
	if !m.ShouldRetry("a.md", 2001, false) {
		t.Fatal("額度用完的暫停，窗口過後應再試（隔天重置）")
	}
}
