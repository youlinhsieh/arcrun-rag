// progress_test.go — t210 統計層。守的是 leo 08-08 定的兩條驗法：
//
//	① 四個數字相加要等於總數（「不准有對不起來的組合」——這整批的起因就是數字對不起來）
//	② 分類收斂：認不出來的一律進「其他」，不准為新錯誤一直長文案
package collector

import "testing"

func mkEntry(content, ingested string, failCount int) *ManifestEntry {
	return &ManifestEntry{ContentHash: content, IngestedHash: ingested, FailCount: failCount}
}

// 🔴 leo 08-08 驗法①：相加必須等於總數。
func TestProgress_SumEqualsTotal(t *testing.T) {
	m := &Manifest{Entries: map[string]*ManifestEntry{
		"done1.md":    mkEntry("h1", "h1", 0),               // 已完成
		"done2.md":    mkEntry("h2", "h2", 0),               // 已完成
		"changed.md":  mkEntry("h3new", "h3old", 0),         // 改過了，要重送 → 待處理
		"fresh.md":    mkEntry("h4", "", 0),                 // 從沒送過 → 待處理
		"retrying.md": mkEntry("h5", "", 3),                 // 退避中，但還沒放棄 → 待處理
		"givenup.md":  mkEntry("h6", "", MaxFailBeforeSkip), // 已放棄自動重試 → 卡住
	}}
	p := m.Progress()

	if p.Total != 6 {
		t.Fatalf("總數應為 6，got %d", p.Total)
	}
	if p.Done != 2 || p.Pending != 3 || p.Stuck != 1 {
		t.Fatalf("分佈錯：Done=%d Pending=%d Stuck=%d（want 2/3/1）", p.Done, p.Pending, p.Stuck)
	}
	if sum := p.Done + p.Pending + p.Stuck + p.Unreadable; sum != p.Total {
		t.Fatalf("🔴 數字對不起來：%d+%d+%d+%d=%d ≠ 總數 %d\n"+
			"（這正是 Evan 2026-08-08 回報的病，不准再發生）",
			p.Done, p.Pending, p.Stuck, p.Unreadable, sum, p.Total)
	}
}

// 已放棄重試的不可以混進「待處理」——否則使用者會一直等一件永遠不會發生的事。
func TestProgress_GivenUpIsNotPending(t *testing.T) {
	m := &Manifest{Entries: map[string]*ManifestEntry{
		"givenup.md": mkEntry("h", "", MaxFailBeforeSkip),
	}}
	p := m.Progress()
	if p.Pending != 0 || p.Stuck != 1 {
		t.Fatalf("放棄重試的該算 Stuck 不是 Pending：Pending=%d Stuck=%d", p.Pending, p.Stuck)
	}
}

// 多資料夾／多帳號時首頁講的是總量。
func TestProgress_Add(t *testing.T) {
	a := SyncProgress{Total: 9000, Done: 101, Pending: 8879, Stuck: 20}
	b := SyncProgress{Total: 10, Done: 10}
	got := a.Add(b)
	if got.Total != 9010 || got.Done != 111 || got.Pending != 8879 || got.Stuck != 20 {
		t.Fatalf("累加錯：%+v", got)
	}
}

// 分類用的是實撞過的錯誤原文，不是猜的。
func TestClassifyFailure_RealWorldMessages(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"4006: you have used up your daily free allocation of 10,000 neurons", FailQuotaExhausted},
		{"轉檔失敗（a.pdf）：檔案裡沒有可抽取的文字", FailNoTextInFile},
		{"尚未支援的檔案格式：.pages", FailUnsupportedFormat},
		{"上次失敗（第 5 次），5h38m38s 後重試｜原因：4006 neurons", FailQuotaExhausted},
		{"connection reset by peer", FailOther},
		{"", FailOther},
	}
	for _, c := range cases {
		if got := ClassifyFailure(c.raw); got != c.want {
			t.Errorf("ClassifyFailure(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// 統計只出分類與份數；份數 0 的分類不佔畫面。
func TestBuildFailureBreakdown(t *testing.T) {
	b := BuildFailureBreakdown([]string{
		"4006 neurons", "4006 neurons",
		"尚未支援的檔案格式：.pages",
		"something we have never seen",
	})
	if b.Total != 4 {
		t.Fatalf("總數應為 4，got %d", b.Total)
	}
	if len(b.Groups) != 3 {
		t.Fatalf("應有 3 個非零分類（0 的不出現），got %d：%+v", len(b.Groups), b.Groups)
	}
	// 順序固定，畫面才不會每次重排
	want := []FailureGroup{
		{FailUnsupportedFormat, 1},
		{FailQuotaExhausted, 2},
		{FailOther, 1},
	}
	for i, w := range want {
		if b.Groups[i] != w {
			t.Fatalf("第 %d 組 = %+v, want %+v（順序須照 FailCategories）", i, b.Groups[i], w)
		}
	}
	// 分組份數加起來要等於總數（同「數字對得起來」的不變式）
	sum := 0
	for _, g := range b.Groups {
		sum += g.Count
	}
	if sum != b.Total {
		t.Fatalf("分組加總 %d ≠ 總數 %d", sum, b.Total)
	}
}
