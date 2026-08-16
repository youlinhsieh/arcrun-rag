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

// scanWithPlan 照 daemon 的真實接法跑一輪掃描。
//
// 🔴 2026-08-16 簡化：這裡以前要自己複製 direct.go 那段「curated-wiki 時解除
// system-dev 的 SkipDirNames」的邏輯——**測試複製了受測程式的一半，於是它驗的是
// 我抄得對不對，不是產品對不對**。那段判準已收進 IngestPlan，兩邊都不必再抄。
func scanWithPlan(t *testing.T, root string) (*TriggerPayload, IngestPlan) {
	t.Helper()
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(root, m, ScanOptions{}) // Plan 不填＝Scan 自己算，同 daemon
	if err != nil {
		t.Fatalf("掃描失敗：%v", err)
	}
	return payload, payload.Plan
}

// countDocFiles 數這棵樹裡有幾個「本來就會被收」的文件檔（不套任何策略）。
// 拿它當對照組，比再跑一次 Scan 誠實——策略現在是走訪器自己裝的，
// 「不套策略的 Scan」已經不存在了（那正是本次修法要的性質）。
func countDocFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if strings.HasPrefix(name, ".") {
			return nil
		}
		if allowedExt[strings.ToLower(filepath.Ext(name))] {
			n++
		}
		return nil
	})
	return n
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

	// 對照組：這棵樹裡本來就有幾個文件檔（＝完全不排除時會送出去的量）。
	onDisk := countDocFiles(t, root)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)

	t.Logf("策略：%s（%s）", plan.Mode, plan.Reason)
	t.Logf("樹上共有 %d 個文件檔｜實際送出 %d 個（逐檔擋掉 %d，整棵跳過 %d 個資料夾）",
		onDisk, len(got), payload.ExcludedByPlan, payload.ExcludedDirCount)
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
	if onDisk < len(got)*5 {
		t.Fatalf("樹上只有 %d 個文件檔，fixture 沒造出「被淹沒」的形狀，這個測試證明不了什麼",
			onDisk)
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

// ═══════════════════════════════════════════════════════════════════════════
// arcrun-rag#104 第二輪（2026-08-16 leo 實撞：掛上 pms，27 張卡裡 22 張是別人的）
// ═══════════════════════════════════════════════════════════════════════════

// makePMSFixture 造 leo 那棵真樹的形狀：一個含大量依賴目錄的專案。
// 數字照票上的實測比例縮小（真樹 2,127 檔／1,647 在依賴底下／node_modules 裡 108 個 .md）。
func makePMSFixture(t *testing.T) (root string, mine []string) {
	t.Helper()
	root = t.TempDir()

	files := map[string]string{}

	// ① leo 自己的東西——唯一該收的
	mine = []string{
		"README.md",
		"docs/PMS_USER_STORIES.md",
		"docs/kbdb-api-patterns.md",
		"docs/u6u-implementation-notes.md",
	}
	for _, p := range mine {
		files[p] = "# 我自己寫的：" + p
	}

	// ② 專案本體（有 package.json ⇒ 這一層旁邊的 dist 才算產物）
	files["package.json"] = `{"name":"pms"}`
	files["pnpm-lock.yaml"] = "lockfileVersion: 1"
	files[".gitignore"] = "node_modules/\ndist/\n.wrangler/\n*.log\n.dev.vars\n"

	// ③ 別人的套件：undici 的 API 文件與第三方授權條款
	//    （票上實據：16 張 undici 卡＋5 張授權條款，佔 27 張裡的 81%）
	for _, n := range []string{
		"Pool", "ProxyAgent", "Dispatcher", "MockAgent", "MockPool",
		"WebSocket", "RetryHandler", "DiagnosticsChannel",
	} {
		files["workers/pms-order-search/node_modules/undici/docs/api/"+n+".md"] = "# " + n
	}
	for _, n := range []string{
		"LICENSE-browserify-fs", "LICENSE-buffer-es6", "LICENSE-crypto-browserify",
		"LICENSE-process-es6", "ThirdPartyNoticeText",
	} {
		files["workers/pms-order-search/node_modules/"+n+".md"] = "MIT License\n\nPermission is hereby granted…"
	}
	files["workers/pms-order-search/package.json"] = `{"name":"order-search"}`
	files["workers/pms-order-search/dist/bundle.md"] = "# 建置產物"

	// ④ 使用者宣告不要的（.gitignore 第一線）
	files["build.log"] = "noise"
	files[".dev.vars"] = "secret"

	writeFixture(t, root, files)
	sort.Strings(mine)
	return root, mine
}

// 🔴 正面驗收：**掛上一個真實專案資料夾，收進去的是他的東西，不是他安裝的別人的東西。**
func TestPlanIngest_真實專案只收使用者自己的東西(t *testing.T) {
	root, mine := makePMSFixture(t)
	onDisk := countDocFiles(t, root)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)

	t.Logf("── 修法前後對照（同一棵樹）──")
	t.Logf("樹上的文件檔共 %d 個；其中別人的套件文件 13 個（undici API ×8＋授權條款 ×5）", onDisk)
	t.Logf("策略：%s — %s", plan.Mode, plan.Reason)
	t.Logf("實際送出 %d 個：", len(got))
	for _, p := range got {
		t.Logf("   ✓ %s", p)
	}
	t.Logf("整棵跳過 %d 個資料夾：", payload.ExcludedDirCount)
	for _, d := range payload.ExcludedDirs {
		t.Logf("   ✗ %s — %s", d.Path, d.Reason)
	}

	for _, p := range got {
		if strings.Contains(p, "node_modules/") {
			t.Errorf("收進了別人的套件：%s", p)
		}
		if strings.Contains(strings.ToUpper(p), "LICENSE") {
			t.Errorf("把授權條款收成知識：%s（那是法律文字，不是知識）", p)
		}
	}
	if strings.Join(got, ",") != strings.Join(mine, ",") {
		t.Fatalf("送出的不等於使用者自己的東西\n實得：%v\n應為：%v", got, mine)
	}
}

// 🔴 反面驗收（票上紅線「不要誤殺」）：一個**真的**叫 build／dist／out 的資料夾，
// 但它確實是使用者的內容——不准安靜地弄不見。
//
// 這一條是 2026-08-16 實測抓到的迴歸：原本的大表在一般資料夾裡也照殺，
// 8 個 .md 只送出 1 個，而且回報「擋掉 0 個」。
func TestPlanIngest_筆記庫裡真的叫build的資料夾不准誤殺(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"日記.md":            "# 日記",
		"build/樂高作品集.md":   "# 我在做的模型",
		"專案/dist/交件清單.md":  "# 交件",
		"out/外出旅遊筆記.md":    "# 旅遊",
		"target/年度目標.md":   "# 目標",
		"coverage/保單整理.md": "# 保單",
		"bin/雜項.md":        "# 雜項",
		"vendor/廠商聯絡簿.md":  "# 廠商",
	})

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略：%s｜送出 %d／8：%v", plan.Mode, len(got), got)

	if len(got) != 8 {
		t.Fatalf("使用者的 8 份筆記只送了 %d 份——`build`／`out`／`vendor` 在筆記庫裡"+
			"是樂高作品集、外出旅遊、廠商聯絡簿，不是建置產物。實得：%v", len(got), got)
	}
	if payload.ExcludedDirCount != 0 {
		t.Fatalf("一般資料夾不該有任何資料夾被剪掉，卻剪了：%v", payload.ExcludedDirs)
	}
}

// 同一個名字、不同脈絡：`dist` 旁邊擺著 package.json ⇒ 是產物，該跳過。
// 判準是**目錄局部的**，與有沒有版控無關（leo 2026-08-16：他的 KB 筆記庫也有 git）。
func TestPlanIngest_同一個名字看旁邊擺什麼決定(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"筆記/build/樂高作品集.md":  "# 使用者的東西（旁邊沒有專案檔）",
		"程式/package.json":    `{"name":"x"}`,
		"程式/build/bundle.md": "# 產物（旁邊就是 package.json）",
	})

	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("送出：%v", got)
	for _, d := range payload.ExcludedDirs {
		t.Logf("跳過 %s — %s", d.Path, d.Reason)
	}

	want := []string{"筆記/build/樂高作品集.md"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("實得 %v，應為 %v（同一個名字，要看旁邊擺什麼）", got, want)
	}
}

// 有 `.git` 但其實是筆記庫：**版控不得改變收檔行為**（leo 2026-08-16 推翻 .git 判準）。
//
// ⚠️ 已知落差（不在本輪範圍，另報總管）：`PlanIngest` 的**模式選擇**仍看 `.git`
// ——所以帶 `.git` 的筆記庫會被判成 docs-only。本測試只釘住「排除規則那一層
// 不看版控」，模式選擇那一層要另外開票處理。
func TestPlanIngest_排除判準不看有沒有版控(t *testing.T) {
	base := map[string]string{
		"docs/說明.md":          "# 文件",
		"build/樂高作品集.md":      "# 使用者的東西",
		"node_modules/x/a.md": "# 別人的套件",
	}

	withoutGit := t.TempDir()
	writeFixture(t, withoutGit, base)
	withGit := t.TempDir()
	writeFixture(t, withGit, base)
	mustMkdir(t, filepath.Join(withGit, ".git"))

	for _, tc := range []struct{ name, root string }{
		{"沒有版控", withoutGit}, {"有版控", withGit},
	} {
		payload, plan := scanWithPlan(t, tc.root)
		reasons := map[string]string{}
		for _, d := range payload.ExcludedDirs {
			reasons[d.Path] = d.Reason
		}
		t.Logf("%s：策略=%s｜跳過=%v", tc.name, plan.Mode, reasons)

		if reasons["node_modules"] == "" {
			t.Errorf("%s：node_modules 沒被排除——它是誰的套件跟有沒有版控無關", tc.name)
		}
		// 🔴 本測試釘的是**排除規則那一層**：`build` 旁邊沒有任何專案檔，
		//    所以無論有沒有版控，都不准把它當成「建置工具產生的」。
		//    （帶 `.git` 時 `build` 仍會因為**模式選擇**落在文件區之外而不收——
		//     那是另一層，見本函式上方的已知落差說明。）
		if strings.Contains(reasons["build"], "建置") {
			t.Errorf("%s：`build` 被判成建置產物（%q），但它旁邊沒有任何專案檔"+
				"——版控訊號不得改變這個判斷", tc.name, reasons["build"])
		}
	}
}
