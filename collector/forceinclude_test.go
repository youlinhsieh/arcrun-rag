package collector

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// ── 逃生口清單本身（folder-includes.json）──────────────────────────────────────

func TestForceIncludeStore_AddRemoveRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := ForceIncludeStorePath(filepath.Join(dir, "manifest.json"))

	s := LoadForceIncludeStore(path) // 檔案還不存在＝空清單，不是錯誤
	if len(s.For("/home/leo/pms")) != 0 {
		t.Fatalf("全新清單應該是空的")
	}

	if !s.Add("/home/leo/pms", "pms_v1_legacy") {
		t.Fatalf("第一次加入應該回報有變動")
	}
	if s.Add("/home/leo/pms", "pms_v1_legacy") {
		t.Fatalf("重複加入同一筆不應該回報變動")
	}
	if err := s.Save(path); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}

	// 記得住（驗收 6）：重新從磁碟讀回來，那筆還在。
	again := LoadForceIncludeStore(path)
	got := again.For("/home/leo/pms")
	if len(got) != 1 || got[0] != "pms_v1_legacy" {
		t.Fatalf("重讀後清單=%v，want [pms_v1_legacy]", got)
	}

	// 收得回（驗收 7）：拿掉之後磁碟上也沒有了。
	if !again.Remove("/home/leo/pms", "pms_v1_legacy") {
		t.Fatalf("移除既有的一筆應該回報有變動")
	}
	if again.Remove("/home/leo/pms", "pms_v1_legacy") {
		t.Fatalf("移除不存在的一筆不應該回報變動")
	}
	if err := again.Save(path); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}
	if len(LoadForceIncludeStore(path).For("/home/leo/pms")) != 0 {
		t.Fatalf("收回後清單應該是空的")
	}
}

func TestForceIncludeStore_Normalizes(t *testing.T) {
	s := &ForceIncludeStore{Roots: map[string][]string{}}
	// 尾斜線、前綴 ./、反斜線都要正規化成同一把 key／同一筆值。
	s.Add("/home/leo/pms/", "pms_v1_legacy/")
	if got := s.For("/home/leo/pms"); len(got) != 1 || got[0] != "pms_v1_legacy" {
		t.Fatalf("root 尾斜線沒被正規化：%v", got)
	}
	if !s.Add("/home/leo/pms", "docs/子/深") || len(s.For("/home/leo/pms")) != 2 {
		t.Fatalf("巢狀相對路徑應該加得進去")
	}
	// 收整個根（空 rel）不需要逃生口，拒絕。
	if s.Add("/home/leo/pms", "") || s.Add("/home/leo/pms", ".") {
		t.Fatalf("空的相對路徑不該被加進清單")
	}
}

func TestForceIncludeStore_CorruptFileTreatedAsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ForceIncludeStoreName)
	if err := os.WriteFile(path, []byte("{ 這不是合法 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 壞掉的檔不該讓整輪掃描炸掉——當成空清單即可。
	if len(LoadForceIncludeStore(path).Roots) != 0 {
		t.Fatalf("壞掉的檔應被當成空清單")
	}
}

// ── 掛上逃生口之後，真的收得到那些檔（驗收 5，這是本票的核心）─────────────────

// pms 這種案例：一個軟體專案（docs-only）＋ 一個**自己這一層就摻了程式碼**的
// 子資料夾（pms_v1_legacy 直接放著 server.js）。Phase 0（f98caa5）的自動判準是
// 「這一層零程式碼才算文件目錄」，所以摻了程式碼的這一層 Phase 0 認不出、預設整棵跳過
// ——這正是 leo 說「看到程式碼就是要萃，這是他的自由」要救的那一類。
//
// 底下的 pms-backup 也刻意摻一個 .sql，讓它同樣不被 Phase 0 自動收，才驗得到
// 「強制收父資料夾 ⇒ 子孫的文件也跟著進來」。
func softwareProjectWithLegacyDocs(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	files["pms_v1_legacy/server.js"] = "console.log('legacy')"     // 程式碼 ⇒ 這一層 Phase 0 不認得
	files["pms_v1_legacy/CEO_PROMPT.md"] = "# 交接說明"                // 文件，預設被跳過
	files["pms_v1_legacy/pms-backup/db.sql"] = "SELECT 1"          // 程式碼 ⇒ pms-backup 也不被自動收
	files["pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md"] = "# 舊版評估" // 文件，預設被跳過
	files["pms_v1_legacy/pms-backup/規格.pdf"] = "%PDF-1.4 假裝是 PDF"  // 文件，預設被跳過
	// 這一顆是雜訊：就算使用者強制收 pms_v1_legacy，鎖定檔仍然不該進來。
	files["pms_v1_legacy/pnpm-lock.yaml"] = "lockfileVersion: 9"
	writeFixture(t, root, files)
	return root
}

func TestForceInclude_默認跳過強制後收得到(t *testing.T) {
	root := softwareProjectWithLegacyDocs(t)

	// ① 沒有逃生口：docs-only 模式，pms_v1_legacy 整棵不在文件區 ⇒ 一份都不收。
	plan := PlanIngest(root)
	if plan.Mode != IngestDocsOnly {
		t.Fatalf("這應該被判成開發專案（docs-only），卻是 %s", plan.Mode)
	}
	before := scanEventPathsWithPlan(t, root, plan)
	for _, p := range before {
		if strings.HasPrefix(p, "pms_v1_legacy/") {
			t.Fatalf("預設就不該收 pms_v1_legacy 底下的檔，卻收了 %s（這是開票的病）", p)
		}
	}

	// ② 使用者按了「收進來」：掛上逃生口，同一個 root 再掃一次。
	plan2 := PlanIngest(root)
	plan2.ForceIncludeDirs = []string{"pms_v1_legacy"}
	after := scanEventPathsWithPlan(t, root, plan2)

	wantIncluded := []string{
		"pms_v1_legacy/CEO_PROMPT.md",
		"pms_v1_legacy/pms-backup/PMS_ASSESSMENT.md",
		"pms_v1_legacy/pms-backup/規格.pdf",
	}
	for _, w := range wantIncluded {
		if !hasStr(after, w) {
			t.Fatalf("強制收錄後應該收得到 %s，實際只收了 %v", w, after)
		}
	}
	// 🔴 紅線：強制收「一個資料夾」不等於連裡面的鎖定檔也收。
	if hasStr(after, "pms_v1_legacy/pnpm-lock.yaml") {
		t.Fatalf("鎖定檔不該因為父資料夾被強制收錄就跟著進來")
	}
}

// 🔴 紅線（c5097）：不改預設判準。空的 ForceIncludeDirs ⇒ 行為與從前一模一樣。
func TestForceInclude_空清單行為不變(t *testing.T) {
	root := softwareProjectWithLegacyDocs(t)
	plan := PlanIngest(root) // ForceIncludeDirs 為空
	got := scanEventPathsWithPlan(t, root, plan)
	for _, p := range got {
		if strings.HasPrefix(p, "pms_v1_legacy/") {
			t.Fatalf("空清單時不該收 pms_v1_legacy 底下任何檔，卻收了 %s", p)
		}
	}
}

// 只影響「自己與子孫」，不影響兄弟資料夾。
func TestForceInclude_只收自己與子孫不碰兄弟(t *testing.T) {
	root := t.TempDir()
	files := codeProjectFiles("", ".go", "package main")
	// 兩個兄弟都摻程式碼 ⇒ 都不會被 Phase 0 自動收 ⇒ 兩個預設都是跳過狀態，
	// 這樣「只有被強制收的那個才進得來」才驗得乾淨（不會被 Phase 0 混淆）。
	files["legacy_a/app.js"] = "//a"
	files["legacy_a/筆記.md"] = "# A"
	files["legacy_b/app.js"] = "//b"
	files["legacy_b/筆記.md"] = "# B"
	writeFixture(t, root, files)

	plan := PlanIngest(root)
	plan.ForceIncludeDirs = []string{"legacy_a"}
	got := scanEventPathsWithPlan(t, root, plan)

	if !hasStr(got, "legacy_a/筆記.md") {
		t.Fatalf("legacy_a 被強制收錄，該收得到它的檔：%v", got)
	}
	if hasStr(got, "legacy_b/筆記.md") {
		t.Fatalf("只強制收了 legacy_a，legacy_b 不該跟著被收：%v", got)
	}
}

// ── 樹上要標得出「使用者收進來了」（驗收 7 的收回入口靠這一格）─────────────────

func TestBuildFolderTree_MarksIncluded(t *testing.T) {
	root := softwareProjectWithLegacyDocs(t)
	plan := PlanIngest(root)
	plan.ForceIncludeDirs = []string{"pms_v1_legacy"}

	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(root, m, ScanOptions{Plan: plan})
	if err != nil {
		t.Fatalf("掃描失敗：%v", err)
	}
	tree := BuildFolderTree(root, "kb", payload.DirStats, m.Entries, payload.AllExcludedDirs, plan, time.Now())

	var node *FolderNode
	for i := range tree.Nodes {
		if tree.Nodes[i].Path == "pms_v1_legacy" {
			node = &tree.Nodes[i]
			break
		}
	}
	if node == nil {
		t.Fatalf("樹上找不到 pms_v1_legacy 節點")
	}
	if !node.Included {
		t.Fatalf("使用者收進來的資料夾應該標 Included，好讓畫面給出「取消收進來」")
	}
	if node.Skipped {
		t.Fatalf("已經收進來的資料夾不該再標 Skipped（那會讓畫面同時給「收進來」與收回兩個矛盾狀態）")
	}
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

func scanEventPathsWithPlan(t *testing.T, root string, plan IngestPlan) []string {
	t.Helper()
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(root, m, ScanOptions{Plan: plan})
	if err != nil {
		t.Fatalf("掃描失敗：%v", err)
	}
	out := eventPaths(payload)
	sort.Strings(out)
	return out
}

func hasStr(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
