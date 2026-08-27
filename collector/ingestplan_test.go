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

// codeProjectFiles 把「這裡真的是一套軟體專案」的內容鋪進 fixture：
// 一個專案檔 ＋ 夠多的原始碼檔。
//
// 🔴 2026-08-16 第二層修法之後，**這件事必須用內容表達，不能再用 `mustMkdir(.git)` 表達**
// ——判準已經改成看資料夾裡實際裝了什麼（foldershape.go）。
// 以前的 fixture 造一個空的 `.git` 目錄就算「開發專案」，那正是 leo 推翻的那個訊號：
// 「我的 KB 筆記庫也有 git，是否用 github/gitea 追蹤完全沒意義。」
func codeProjectFiles(prefix, ext, body string) map[string]string {
	out := map[string]string{prefix + "go.mod": "module example\n\ngo 1.22\n"}
	for i := 0; i < softwareProjectMinCodeFiles+5; i++ {
		out[fmt.Sprintf("%ssrc/mod%02d%s", prefix, i, ext)] = body
	}
	return out
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
	//    ——這一段同時也是「這個資料夾是軟體專案」的**唯一**證據來源（見 codeProjectFiles）。
	for i := 0; i < 40; i++ {
		files[fmt.Sprintf("collector/file%02d.go", i)] = "package collector"
		files[fmt.Sprintf("collector/note%02d.md", i)] = "# 散落在程式碼旁邊的說明"
	}
	files["go.mod"] = "module inkstone\n\ngo 1.22\n"
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

	// 監看根同時也在版控裡——**故意留著**：它不准影響任何判斷（見本檔最後那條迴歸測試）。
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
//
// 🔴 2026-08-27 Phase 0（`arcrun-rag#136`，leo 08-24 第三次追加）之後行為分兩種：
//   - `src/說明.md`：`src/` 這個目錄自己直接放的檔案裡就有 `.go`（程式碼）——
//     零程式碼這一條不成立，繼續當程式碼目錄整棵跳過，不收。
//   - `internal/notes.md`：`internal/` 這個目錄自己直接放的檔案裡**只有這份 .md**、
//     沒有任何程式碼副檔名——即使名字不叫 docs，Phase 0 判準也會把它當文件目錄收。
//     這不是誤放的迴歸，是這次要的效果：leo 08-24「如果要加上很多（手動救回），
//     那就更覺得很煩，就會棄用」——非標準命名但整棵零程式碼的資料夾預設就該收，
//     不必等使用者自己救。
func TestPlanIngest_RepoWithoutWikiReadsDocsOnly(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	for rel, body := range map[string]string{
		"README.md":         "# 專案",
		"docs/請假規則.md":      "# 特休 14 天",
		"docs/報銷政策.md":      "# 每日 3000 元",
		"src/說明.md":         "# 散在程式碼旁邊——但 src/ 自己直接放的檔案裡就有 .go，不合格",
		"internal/notes.md": "# 自己單獨一個資料夾，直接內容零程式碼——Phase 0 判準下合格",
	} {
		files[rel] = body
	}
	writeFixture(t, root, files)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略：%s（%s）｜送：%v", plan.Mode, plan.Reason, got)

	if plan.Mode != IngestDocsOnly {
		t.Fatalf("策略=%s，want %s", plan.Mode, IngestDocsOnly)
	}
	want := []string{"README.md", "docs/報銷政策.md", "docs/請假規則.md", "internal/notes.md"}
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("送了 %v，want %v（`src/` 因為自己直接放著 .go 仍不收；`internal/` "+
			"自己直接內容零程式碼，Phase 0 判準下該收）", got, want)
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
	files := codeProjectFiles("", ".go", "package main")
	files["docs/說明.md"] = "# 說明"
	writeFixture(t, root, files)

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
	// 真的有一整套程式碼——**這才是「這是軟體專案」的證據**，不是 `.git`
	// （真樹 2,127 檔裡絕大多數是 `.ts`／`.js`）。
	for i := 0; i < softwareProjectMinCodeFiles+5; i++ {
		files[fmt.Sprintf("workers/pms-order-search/src/handler%02d.ts", i)] = "export const x = 1"
	}
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

// 🔴 本票最重要的一條：**版控訊號不得改變任何收檔行為**（leo 2026-08-16 推翻 .git 判準）。
//
//	「**你不需要判斷有沒有 git，我的 KB 筆記庫也有 git，
//	  是否用 github/gitea 追蹤完全沒意義。**」
//
// 這條測試原本只釘住**排除規則**那一層，函式上方還記著一條已知落差：
// 「`PlanIngest` 的模式選擇仍看 `.git`，要另外開票」。
// 2026-08-16 第二層修法把那個落差補掉了 ⇒ **本測試同時擴充到模式選擇**，
// 而不是另開一條平行的（兩條分開釘，下一個人只會改到其中一條）。
//
// 判準也從「幾個個別行為一樣」升成「**收到的檔案集合一模一樣**」——
// 那才是使用者手上真正會少掉東西的那一維。
func TestPlanIngest_排除判準與模式選擇都不看有沒有版控(t *testing.T) {
	// 🔴 地雷本體：一個**有 wiki 目錄、也有大量其他內容**的筆記庫。
	// 這正是 `~/Documents/KB` 的形狀（實測：5,915 份文件，而它真的有 `system-dev/wiki`）。
	// 舊判準下：沒有 `.git` ⇒ all（全收）；跑一次 `git init` ⇒ curated-wiki ⇒ 只剩 wiki 那幾張。
	// **一個純粹的版控動作，會讓使用者手上的知識少掉九成，而畫面上不會有任何提示。**
	base := map[string]string{
		"docs/說明.md":                "# 文件",
		"build/樂高作品集.md":            "# 使用者的東西",
		"node_modules/x/a.md":       "# 別人的套件",
		"wiki/status.md":            "# 我自己開的 wiki 資料夾",
		"wiki/INDEX.md":             "# 索引",
		"system-dev/wiki/status.md": "# 我在筆記庫裡也順手裝過 template（KB 真的是這樣）",
	}
	// 「大量其他內容」——真正會被吃掉的那一批。
	for i := 0; i < 30; i++ {
		base[fmt.Sprintf("journals/2026_08_%02d.md", i)] = "# 日記"
	}

	withoutGit := t.TempDir()
	writeFixture(t, withoutGit, base)
	withGit := t.TempDir()
	writeFixture(t, withGit, base)
	mustMkdir(t, filepath.Join(withGit, ".git"))

	var firstSet string
	for _, tc := range []struct{ name, root string }{
		{"沒有版控", withoutGit}, {"有版控（跑過 git init）", withGit},
	} {
		payload, plan := scanWithPlan(t, tc.root)
		reasons := map[string]string{}
		for _, d := range payload.ExcludedDirs {
			reasons[d.Path] = d.Reason
		}
		got := eventPaths(payload)
		t.Logf("%s：策略=%s｜送出 %d 個檔｜跳過=%v", tc.name, plan.Mode, len(got), reasons)

		// ① 排除規則那一層（原本就釘住的）
		if reasons["node_modules"] == "" {
			t.Errorf("%s：node_modules 沒被排除——它是誰的套件跟有沒有版控無關", tc.name)
		}
		if strings.Contains(reasons["build"], "建置") {
			t.Errorf("%s：`build` 被判成建置產物（%q），但它旁邊沒有任何專案檔"+
				"——版控訊號不得改變這個判斷", tc.name, reasons["build"])
		}
		// ② 模式選擇那一層（本輪補上的）
		if plan.Mode != IngestAll {
			t.Errorf("%s：策略=%s，want %s——這是筆記庫（沒有專案檔、沒有成堆原始碼），"+
				"有沒有跑過 git init 都不該改變它", tc.name, plan.Mode, IngestAll)
		}
		// ③ 🔴 真正的判準：**收到的檔案集合必須一模一樣**
		set := strings.Join(got, "\n")
		if firstSet == "" {
			firstSet = set
			// 34＝30 篇日記＋docs/說明＋build/樂高＋wiki 的 2 張。
			// （`system-dev/` 是 template 鋪出來的產物區，任何模式都不收——那條規則
			//   比本票更早存在，也正是舊判準的殺傷力所在：一旦翻成 curated-wiki，
			//   **唯一被收的就只剩那個平常根本不收的目錄**。）
			if len(got) != 34 {
				t.Fatalf("%s：只送出 %d 個檔（want 34）：%v", tc.name, len(got), got)
			}
		} else if set != firstSet {
			t.Fatalf("🔴 跑一次 `git init` 就改變了收到的東西——這正是本票要拆掉的引信。\n"+
				"沒有版控時：\n%s\n有版控時：\n%s", firstSet, set)
		}
	}
}

// 三種收法換了判準之後仍然各自正確——同一組內容，只差「裡面有沒有一整套程式碼」。
//
// 🔴 這條是防止「修好筆記庫卻把專案那兩種弄壞」：判準只有一個，三種答案必須都還在。
func TestPlanIngest_三種收法在新判準下都還正確(t *testing.T) {
	// 共用的內容：一份整理好的 wiki、一個文件區、一些散落在旁邊的 .md。
	shared := map[string]string{
		"wiki/status.md": "# 整理好的知識",
		"wiki/INDEX.md":  "# 索引",
		"docs/請假規則.md":   "# 特休 14 天",
		"README.md":      "# 說明",
		"雜/隨手記.md":       "# 散落在旁邊",
	}
	merge := func(extra map[string]string) map[string]string {
		out := map[string]string{}
		for k, v := range shared {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}

	for _, tc := range []struct {
		name     string
		files    map[string]string
		wantMode IngestMode
		wantGot  []string
	}{
		{
			// ① 筆記庫：沒有專案檔、沒有成堆原始碼 ⇒ 整份讀進去
			name:     "筆記庫整份收",
			files:    merge(nil),
			wantMode: IngestAll,
			wantGot: []string{"README.md", "docs/請假規則.md",
				"wiki/INDEX.md", "wiki/status.md", "雜/隨手記.md"},
		},
		{
			// ② 軟體專案＋已經整理好 wiki ⇒ 只收那份 wiki
			name:     "整理好的專案只收那份wiki",
			files:    merge(codeProjectFiles("", ".go", "package main")),
			wantMode: IngestCuratedWiki,
			wantGot:  []string{"wiki/INDEX.md", "wiki/status.md"},
		},
		{
			// ③ 軟體專案、沒有現成 wiki ⇒ 只收文件區＋根層說明檔＋跳過原始碼，
			//    但 Phase 0（`arcrun-rag#136`）之後也收「非標準命名、自己直接內容零程式碼」
			//    的資料夾——`雜/` 自己只放了一份 `隨手記.md`，沒有任何程式碼副檔名，
			//    即使名字不叫 docs 也算文件目錄。這不是誤放的迴歸，見同檔
			//    TestPlanIngest_RepoWithoutWikiReadsDocsOnly 上方的完整說明。
			name: "沒wiki的專案只收文件跳過源碼",
			files: func() map[string]string {
				f := merge(codeProjectFiles("", ".go", "package main"))
				delete(f, "wiki/status.md")
				delete(f, "wiki/INDEX.md")
				return f
			}(),
			wantMode: IngestDocsOnly,
			wantGot:  []string{"README.md", "docs/請假規則.md", "雜/隨手記.md"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeFixture(t, root, tc.files)
			payload, plan := scanWithPlan(t, root)
			got := eventPaths(payload)
			t.Logf("策略=%s｜%s", plan.Mode, plan.Reason)
			t.Logf("送出 %d 個：%v", len(got), got)

			if plan.Mode != tc.wantMode {
				t.Fatalf("策略=%s，want %s", plan.Mode, tc.wantMode)
			}
			sort.Strings(tc.wantGot)
			if strings.Join(got, ",") != strings.Join(tc.wantGot, ",") {
				t.Fatalf("送出 %v，want %v", got, tc.wantGot)
			}
		})
	}
}

// 🔴 不誤殺（票上的紅線）：筆記庫裡名字像建置產物的資料夾，換了判準之後照樣要收。
//
// 上一輪已經有 TestPlanIngest_筆記庫裡真的叫build的資料夾不准誤殺 守著排除那一層；
// 這一條守的是**模式選擇**那一層——判準若寫成「看到 build/dist/out 就算專案」，
// 或看到零星幾個腳本就算專案，那些筆記一樣會整批消失，而且是換一個入口消失。
func TestPlanIngest_筆記庫有像產物的資料夾與零星腳本也不准翻成專案(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"日記.md":            "# 日記",
		"build/樂高作品集.md":   "# 我在做的模型",
		"dist/出貨清單.md":     "# 交件",
		"out/外出旅遊筆記.md":    "# 旅遊",
		"vendor/廠商聯絡簿.md":  "# 廠商",
		"target/年度目標.md":   "# 目標",
		"coverage/保單整理.md": "# 保單",
	}
	// 筆記庫裡存幾個順手抄下來的腳本片段——**不足以讓整個資料夾變成軟體專案**。
	for i := 0; i < softwareProjectMinCodeFiles-5; i++ {
		files[fmt.Sprintf("片段/snippet%02d.py", i)] = "print('hi')"
	}
	writeFixture(t, root, files)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略=%s（%s）", plan.Mode, plan.Reason)
	t.Logf("送出 %d／7：%v", len(got), got)

	if plan.Mode != IngestAll {
		t.Fatalf("策略=%s，want %s——這是筆記庫，`build` 是樂高作品集、`out` 是外出旅遊，"+
			"幾個腳本片段不能讓整個資料夾翻成軟體專案", plan.Mode, IngestAll)
	}
	if len(got) != 7 {
		t.Fatalf("使用者的 7 份筆記只送了 %d 份：%v", len(got), got)
	}
	if payload.ExcludedDirCount != 0 {
		t.Fatalf("筆記庫不該有任何資料夾被剪掉，卻剪了：%v", payload.ExcludedDirs)
	}
}

// 判準的證據要看得見（票上的紅線：使用者要看得出「我對你的資料夾做了什麼」）。
//
// 「我判斷這是軟體專案」不附證據＝一個黑盒；附上「看到 go.mod，還有 25 個原始碼檔」，
// 他自己就看得出對不對。而且**這句話裡不准再出現版控字眼**——
// 那正是 leo 說「完全沒意義」的那個訊號。
func TestPlanIngest_判成專案時要講得出憑什麼(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["docs/說明.md"] = "# 文件"
	writeFixture(t, root, files)

	plan := PlanIngest(root)
	t.Logf("策略=%s", plan.Mode)
	t.Logf("理由：%s", plan.Reason)
	t.Logf("實測形狀：專案檔 %d 個（%v）／原始碼 %d 個／文件 %d 個",
		plan.Shape.ManifestCount, plan.Shape.ManifestRels, plan.Shape.CodeFiles, plan.Shape.DocFiles)

	if !strings.Contains(plan.Reason, "go.mod") {
		t.Errorf("理由沒講出憑什麼判成專案：%q", plan.Reason)
	}
	if plan.Shape.CodeFiles < softwareProjectMinCodeFiles {
		t.Errorf("形狀沒數到原始碼：%+v", plan.Shape)
	}
	for _, bad := range []string{"版控", "git", "Git", "GitHub", "gitea"} {
		if strings.Contains(plan.Reason, bad) {
			t.Errorf("理由裡出現了版控字眼 %q——判準已經不看版控了：%q", bad, plan.Reason)
		}
	}
}

// 🔴 Phase 0（`arcrun-rag#136`，leo 2026-08-24 第三次追加）——正面驗收：
// 票上真正的案例（`pms_v1_legacy/pms-backup`）：非標準命名、整棵沒有一套程式碼、
// 但巢狀更深處混了一份資料庫備份檔——這正是研究文件原本「整棵子樹零程式碼」的
// 設計會漏掉的那個真實形狀（見 `dirQualifiesAsAutoDoc` 的說明）。
//
// fixture 照 leo 08-24 給的 Finder 截圖形狀造：
//
//	pms_v1_legacy/
//	  PMS_USER_STORIES.md         ← 自己直接放的文件（零程式碼）；一旦這裡合格，
//	                                 整個 pms_v1_legacy 都被收（onPathTo 前綴涵蓋子孫）
//	  pms-backup/
//	    PMS_ASSESSMENT.md          ← 自己直接放的文件
//	    pms_db_backup.sql          ← 巢狀更深處的「程式碼副檔名」（codeFileExts 收 .sql）
//
// 🔴 `pms-backup` 底下混了 .sql 這件事，**不影響** `pms_v1_legacy` 本身的合格判斷
// （逐層判準只看每一層自己的直接內容），所以 `pms-backup/PMS_ASSESSMENT.md`
// 也跟著被收——它是「已合格的 pms_v1_legacy」底下的子孫，不必再單獨判一次
// （與 `docs/` 目錄底下不管有沒有子資料夾都整棵收，是同一條既有語意）。
func TestPlanIngest_Phase0非標準命名文件目錄零程式碼即收(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["README.md"] = "# 專案"
	files["pms_v1_legacy/PMS_USER_STORIES.md"] = "# 使用者故事"
	files["pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md"] = "# 評估報告"
	files["pms_v1_legacy/pms-backup/pms_db_backup.sql"] = "-- 假資料，測試只在意副檔名不在意內容\n"
	writeFixture(t, root, files)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略=%s（%s）", plan.Mode, plan.Reason)
	t.Logf("送出：%v", got)
	for _, d := range payload.ExcludedDirs {
		t.Logf("跳過 %s — %s", d.Path, d.Reason)
	}

	if plan.Mode != IngestDocsOnly {
		t.Fatalf("策略=%s，want %s", plan.Mode, IngestDocsOnly)
	}
	want := []string{
		"README.md",
		"pms_v1_legacy/PMS_USER_STORIES.md",          // 自己直接放的檔案零程式碼，合格
		"pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md", // 已合格祖先底下的子孫，一併收
	}
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("送出 %v，want %v", got, want)
	}
}

// 🔴 Phase 0——正面驗收（獨立合格）：`pms-backup` 若是「自己單獨掛上去的看守根」
// （不在任何已合格祖先底下），逐層判準要能單獨判它自己——它自己直接混了 .sql，
// 不合格，但巢狀更深處若有一個自己零程式碼的子目錄，仍要被獨立找到。
// 用 `archive/`（非標準命名、非隱藏）取代真實案例裡的 `.wiki`——後者是
// daemon 自己產生的隱藏快取目錄，本來就會被 Scan 的隱藏目錄規則整個擋下，
// 不是這裡要驗的「內容判準」這件事。
func TestPlanIngest_Phase0巢狀更深處的獨立合格目錄也找得到(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md"] = "# 評估報告"
	files["pms_v1_legacy/pms-backup/pms_db_backup.sql"] = "-- 假資料，測試只在意副檔名不在意內容\n"
	files["pms_v1_legacy/pms-backup/archive/OLD_NOTES.md"] = "# 更早的筆記"
	writeFixture(t, root, files)

	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("送出：%v", got)
	want := "pms_v1_legacy/pms-backup/archive/OLD_NOTES.md"
	found := false
	for _, p := range got {
		if p == want {
			found = true
		}
		if strings.HasPrefix(p, "pms_v1_legacy/pms-backup/") && p != want {
			t.Fatalf("`pms-backup` 自己混了 .sql 不該被收，卻收了 %s", p)
		}
	}
	if !found {
		t.Fatalf("巢狀更深處的獨立合格目錄沒被找到：%v", got)
	}
}

// 🔴 Phase 0——反面驗收①：`pms-backup` 自己直接放著 `.sql`（程式碼副檔名），
// 所以它自己不合格，同層的 `PMS_ASSESSMENT.md` 目前**仍然不會被收**——
// 這是逐層判準（而非整棵子樹判準）刻意接受的邊界：一個目錄自己混了程式碼副檔名，
// 就當它自己是「開發用的」，不因為隔壁躺著一份文件就整個放行。使用者若真的要救
// 這一份，仍然有第 6 節的樹狀 UI／手動覆寫（尚未實作，見票上 Phase 2）這條路。
// 本測試把這個邊界寫清楚，不讓它在下一輪被誤改成「連 pms-backup 自己也收」。
func TestPlanIngest_Phase0巢狀混雜程式碼的目錄自己仍不收(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md"] = "# 評估報告"
	files["pms_v1_legacy/pms-backup/pms_db_backup.sql"] = "-- 假資料，測試只在意副檔名不在意內容\n"
	writeFixture(t, root, files)

	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	for _, p := range got {
		if strings.Contains(p, "pms-backup/") {
			t.Fatalf("`pms-backup` 自己直接放著 .sql（程式碼副檔名），不該被 Phase 0 判準收進去：%v", got)
		}
	}
}

// 🔴 Phase 0——反面驗收②：不准重新引入 `#104` 的套件洩漏洞。
// `node_modules` 底下即使巢狀著一個「整棵零程式碼」的文件目錄，也不能被收——
// `toolOwnedDirNames` 的優先序排在 Phase 0 判準之前，整棵 `SkipDir`，
// 新判準根本沒有機會看到 `node_modules` 底下的任何內容。
func TestPlanIngest_Phase0不重新引入套件洩漏洞(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["node_modules/some-pkg/docs-backup/README.md"] = "# 別人的套件文件"
	files["node_modules/some-pkg/docs-backup/GUIDE.md"] = "# 別人的套件文件"
	writeFixture(t, root, files)

	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	for _, p := range got {
		if strings.Contains(p, "node_modules/") {
			t.Fatalf("Phase 0 判準洩漏了 node_modules 底下的內容（重新打開 #104 那個洞）：%v", got)
		}
	}
}

// 🔴 Phase 0——反面驗收③：真正的程式碼目錄不受影響，仍走原本的 docs-only 通用跳過。
// `workers/pms-auth` 自己直接放著 `.go`（與 `package.json`），零程式碼那一條不成立，
// 整棵照舊被跳過——不因為新判準而多送出任何一份程式碼旁邊的檔案。
func TestPlanIngest_Phase0真正的程式碼目錄不受影響(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["workers/pms-auth/package.json"] = `{"name":"pms-auth"}`
	files["workers/pms-auth/main.go"] = "package main"
	files["workers/pms-auth/README.md"] = "# 這個服務怎麼跑"
	writeFixture(t, root, files)

	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略=%s｜送出：%v", plan.Mode, got)
	for _, p := range got {
		if strings.Contains(p, "workers/pms-auth/") {
			t.Fatalf("`workers/pms-auth` 自己直接放著 .go，不該被 Phase 0 判準收進去：%v", got)
		}
	}
}

// 🔴 接線：**模式選擇的判準只有一個地方**。
//
// 這一票的同款形狀出現過四次（能力做好了，卻不在會被執行的那條路上）。
// 上一輪用 `go/ast` 釘住「不准再有第二張排除清單」；這一條釘住同一件事的另一半：
// 除了 `PlanIngest` 自己，**沒有別的地方可以用版控訊號決定收檔策略**。
func TestWiring_模式選擇不准再引用版控訊號(t *testing.T) {
	src, err := os.ReadFile("ingestplan.go")
	if err != nil {
		t.Fatal(err)
	}
	// 註解裡當然會提到（那是在解釋為什麼不用），只看程式碼行。
	for i, line := range strings.Split(string(src), "\n") {
		code := line
		if idx := strings.Index(code, "//"); idx >= 0 {
			code = code[:idx]
		}
		for _, fn := range []string{"DetectRepoRoot(", "UnderVersionControl("} {
			if strings.Contains(code, fn) {
				t.Errorf("ingestplan.go:%d 又用版控訊號決定收檔策略了：%s\n"+
					"leo 2026-08-16：「你不需要判斷有沒有 git，我的 KB 筆記庫也有 git」\n"+
					"判準要建在資料夾裡實際裝了什麼（foldershape.go）", i+1, strings.TrimSpace(line))
			}
		}
	}
	// 反面：#105 那個**正當**的用途不准被一起拆掉（tidy.go：版控中的檔案不自動改名搬移）。
	tidy, err := os.ReadFile("tidy.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(tidy), "DetectRepoRoot(") {
		t.Error("tidy.go 不再檢查版控——#105「不要改動使用者版控中的檔案」那一條是對的，" +
			"它問的真的是版控，不准跟著這一票一起拿掉")
	}
}
