// ingestplan_test.go — arcrun-rag#104 的驗收網：**接上一個開發用的 repo 時，
// 送進知識庫的應該是那幾十張整理好的卡，不是幾千個原始檔。**
//
// fixture 刻意照票上那份實據的形狀造：45 個名為 wiki 的目錄裡，8 份 `.claude/worktrees`、
// 5 份出貨用 worktree、8 份 `templatefs` 範本、還有 `.next`／`.vercel` 建置產物。
package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// eventPaths 取出本輪要送上去的檔案路徑（排序，好當實測輸出貼進 issue）。
func eventPaths(p *TriggerPayload) []string {
	var out []string
	for _, e := range p.Events {
		out = append(out, e.Path)
	}
	sort.Strings(out)
	return out
}

// scanWithPlan 照 daemon 的真實接法跑一輪掃描（PlanIngest ＋ curated-wiki 時解除
// system-dev 的 SkipDirNames，見 direct.go 那段註解）。
func scanWithPlan(t *testing.T, root string) (*TriggerPayload, IngestPlan) {
	t.Helper()
	plan := PlanIngest(root)
	skip := map[string]bool{"system-dev": true}
	if plan.Mode == IngestCuratedWiki && strings.HasPrefix(plan.WikiRelDir, "system-dev/") {
		skip = map[string]bool{}
	}
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(root, m, ScanOptions{SkipDirNames: skip, Plan: plan})
	if err != nil {
		t.Fatalf("掃描失敗：%v", err)
	}
	return payload, plan
}

// makeMonorepoFixture 造一個「leo 的 InkStoneCo」形狀的 repo。
// 回傳「真正整理好的那份 wiki」有幾個檔——那就是唯一該被送上去的量。
func makeMonorepoFixture(t *testing.T) (root string, curatedCount int) {
	t.Helper()
	root = t.TempDir()

	files := map[string]string{}

	// ① 真正整理好的知識庫（唯一該收的）
	curated := []string{"status.md", "principles.md", "mistakes.md", "decisions-summary.md", "INDEX.md"}
	for _, n := range curated {
		files["system-dev/wiki/"+n] = "# 整理好的知識：" + n
	}
	files["system-dev/wiki/cards/autonomy/自動派工心法.md"] = "# 我自己寫的卡"
	curatedCount = len(curated) + 1

	// ② 程式碼與一般專案檔（leo：「只有文件要讀，程式碼不用讀」）
	for i := 0; i < 40; i++ {
		files[fmt.Sprintf("collector/file%02d.go", i)] = "package collector"
		files[fmt.Sprintf("collector/note%02d.md", i)] = "# 散落在程式碼旁邊的說明"
	}
	files["README.md"] = "# 專案說明"
	files["CHANGELOG.md"] = "# 版本紀錄"

	// ③ templatefs 範本：我們自己要鋪給別人的檔，不是誰的知識（實據：8 份）
	for i := 0; i < 8; i++ {
		files[fmt.Sprintf("collector/templatefs/system-dev/wiki/status%d.md", i)] = "# 範本"
	}

	// ④ 建置產物（實據：.next／.vercel）
	files["landing/.next/server/pages/doc.md"] = "# 建置產物"
	files["landing/.vercel/output/static/doc.md"] = "# 建置產物"
	files["landing/node_modules/some-pkg/README.md"] = "# 別人的套件"

	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 監看根是版控中的專案
	mustMkdir(t, filepath.Join(root, ".git"))

	// ⑤ 出貨用 worktree（`.git` 是**檔案**）——主 repo 的第二份簽出，內容重複（實據：5 份）
	for i := 0; i < 5; i++ {
		wt := filepath.Join(root, fmt.Sprintf("products/arcrun-rag-wt%dship", i))
		mustMkdir(t, filepath.Join(wt, "system-dev", "wiki"))
		if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /elsewhere\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, n := range curated {
			if err := os.WriteFile(filepath.Join(wt, "system-dev", "wiki", n), []byte("# 同一份 wiki 的第 N 份副本"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	// ⑥ 巢狀的獨立子專案（自己有 .git 目錄）——那是別的專案的知識
	sub := filepath.Join(root, "products", "arcrun-rag")
	mustMkdir(t, filepath.Join(sub, ".git"))
	mustMkdir(t, filepath.Join(sub, "system-dev", "wiki"))
	if err := os.WriteFile(filepath.Join(sub, "system-dev", "wiki", "status.md"), []byte("# 子專案自己的知識"), 0o644); err != nil {
		t.Fatal(err)
	}

	return root, curatedCount
}

// 🔴 #104 的驗收條件本身：接上一個開發 repo，送進去的是幾十張，不是幾千個。
func TestPlanIngest_MonorepoSendsOnlyCuratedWiki(t *testing.T) {
	root, curatedCount := makeMonorepoFixture(t)

	// 對照組：沒有策略時（也就是修好之前的行為）會送多少。
	baseM := &Manifest{Entries: map[string]*ManifestEntry{}}
	baseline, err := Scan(root, baseM, ScanOptions{SkipDirNames: map[string]bool{"system-dev": true}})
	if err != nil {
		t.Fatal(err)
	}

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)

	t.Logf("策略：%s（%s）", plan.Mode, plan.Reason)
	t.Logf("修好之前會送：%d 個檔｜現在送：%d 個檔（策略擋掉 %d 個）",
		len(baseline.Events), len(got), payload.ExcludedByPlan)
	for _, p := range got {
		t.Logf("  → %s", p)
	}

	if plan.Mode != IngestCuratedWiki {
		t.Fatalf("策略=%s，want %s（這個 repo 有現成的 system-dev/wiki）", plan.Mode, IngestCuratedWiki)
	}
	if len(got) != curatedCount {
		t.Fatalf("送了 %d 個檔，want %d（只有整理好的那份 wiki）：%v", len(got), curatedCount, got)
	}
	for _, p := range got {
		if !strings.HasPrefix(p, "system-dev/wiki/") {
			t.Fatalf("送了不該送的檔：%s", p)
		}
	}
	// 量級檢查：這一票的實據是「差 115 倍」，修好之後不該只差一點點。
	if len(baseline.Events) < len(got)*5 {
		t.Fatalf("對照組只有 %d 個檔，fixture 沒造出「被淹沒」的形狀，這個測試證明不了什麼",
			len(baseline.Events))
	}
}

// 同一份 wiki 被出貨用 worktree／templatefs 收十幾次——那是「48 萬筆廢資料」的同款成因。
func TestPlanIngest_NoDuplicateWikiCopies(t *testing.T) {
	root, _ := makeMonorepoFixture(t)
	payload, _ := scanWithPlan(t, root)

	seen := map[string]int{}
	for _, p := range eventPaths(payload) {
		seen[filepath.Base(p)]++
	}
	for base, n := range seen {
		if n > 1 {
			t.Fatalf("%s 被收了 %d 次——同一份內容重複放大，AR-Mira 會搜出一堆一模一樣的東西", base, n)
		}
	}
	for _, p := range eventPaths(payload) {
		for _, bad := range []string{"templatefs/", "-wt0ship/", ".next/", ".vercel/", "node_modules/"} {
			if strings.Contains(p, bad) {
				t.Fatalf("收到了不該收的 %s（命中 %q）", p, bad)
			}
		}
	}
}

// 排除規則要看得見：使用者要知道「有幾千個檔沒被收、為什麼」，以及「其他子專案的 wiki 在哪」。
func TestPlanIngest_ExclusionsAreVisible(t *testing.T) {
	root, _ := makeMonorepoFixture(t)
	payload, plan := scanWithPlan(t, root)

	if plan.Reason == "" {
		t.Fatal("沒有給使用者一句話解釋——他只會覺得系統壞了（票上的紅線）")
	}
	if !strings.Contains(plan.Reason, plan.WikiRelDir) {
		t.Fatalf("理由沒說出是讀了哪一份 wiki：%q", plan.Reason)
	}
	if payload.ExcludedByPlan <= 0 {
		t.Fatal("擋掉的檔案數是 0——那個數字就是「有 N 個檔沒被收」要顯示的東西")
	}
	// 子專案的 wiki 刻意不收，但一定要列出來讓使用者知道去哪裡找。
	if len(plan.OtherWikiDirs) == 0 {
		t.Fatal("沒列出子專案自己的 wiki——使用者接了 monorepo 只看到幾十張，會以為東西不見了")
	}
	t.Logf("理由：%s", plan.Reason)
	t.Logf("擋掉 %d 個檔｜其他子專案的 wiki：%v", payload.ExcludedByPlan, plan.OtherWikiDirs)
}

// 沒有現成 wiki 的 repo：退到「只讀文件、不讀程式碼」（leo 明講的第三步）。
func TestPlanIngest_RepoWithoutWikiReadsDocsOnly(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"README.md":         "# 專案",
		"docs/請假規則.md":      "# 特休 14 天",
		"docs/報銷政策.md":      "# 每日 3000 元",
		"src/main.go":       "package main",
		"src/說明.md":         "# 散在程式碼旁邊",
		"internal/notes.md": "# 也是程式碼旁邊",
	}
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustMkdir(t, filepath.Join(root, ".git"))

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略：%s（%s）｜送：%v", plan.Mode, plan.Reason, got)

	if plan.Mode != IngestDocsOnly {
		t.Fatalf("策略=%s，want %s", plan.Mode, IngestDocsOnly)
	}
	want := []string{"README.md", "docs/報銷政策.md", "docs/請假規則.md"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("送了 %v，want %v（程式碼旁邊的 .md 不該收）", got, want)
	}
}

// 一般資料夾／筆記庫：行為與修這一票之前**完全一致**，全部照收。
// 這條是防止「修好 repo 卻把一般使用者的資料夾弄壞」——他們才是產品的主要客群。
func TestPlanIngest_PlainFolderUnchanged(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"會議記錄.md":          "# 會議",
		"專案/請假規則.md":       "# 特休",
		"專案/深/一點/報銷.md":    "# 報銷",
		"src/main.go":      "package main", // 非文件，本來就被副檔名白名單擋
		"隨手/notes/2026.md": "# 隨手記",
	})

	plan := PlanIngest(root)
	if plan.Mode != IngestAll {
		t.Fatalf("一般資料夾的策略=%s，want %s——不准因為修 repo 而改變一般使用者的行為",
			plan.Mode, IngestAll)
	}

	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	want := []string{"會議記錄.md", "專案/深/一點/報銷.md", "專案/請假規則.md", "隨手/notes/2026.md"}
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("一般資料夾送了 %v，want %v", got, want)
	}
	if payload.ExcludedByPlan != 0 {
		t.Fatalf("一般資料夾不該有任何檔被策略擋掉，卻擋了 %d 個", payload.ExcludedByPlan)
	}
}

// 空的 wiki 目錄不算「已經整理好」——不然剛裝完 template 的 repo 會一個檔都不收，
// 那比收太多更糟（使用者會以為系統壞了）。
func TestPlanIngest_EmptyWikiFallsBackToDocs(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "system-dev", "wiki"))
	mustMkdir(t, filepath.Join(root, ".git"))
	writeFixture(t, root, map[string]string{"docs/說明.md": "# 說明"})

	plan := PlanIngest(root)
	if plan.Mode != IngestDocsOnly {
		t.Fatalf("wiki 是空的，策略應退到 %s，卻是 %s", IngestDocsOnly, plan.Mode)
	}
}
