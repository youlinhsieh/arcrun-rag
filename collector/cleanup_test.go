// cleanup_test.go — 斷連清理的迴歸網（arcrun-rag#138）。
//
// 這支測的重點**不是「有沒有刪掉」**，是「**有沒有刪到不該刪的**」。
// 每一個 case 都對應一種「差一點就誤刪使用者知識」的擺法。
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func cuWriteFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// makeWiki 造一個「長得跟 daemon 產的一模一樣」的 .wiki 目錄。
func makeWiki(t *testing.T, dir string, cards ...string) {
	t.Helper()
	cuWriteFile(t, filepath.Join(dir, ".gitignore"), wikiIgnoreBody)
	cuWriteFile(t, filepath.Join(dir, "00-INDEX.md"), "# 00-INDEX\n\n## 文件\n")
	for _, c := range cards {
		cuWriteFile(t, filepath.Join(dir, c), "# "+strings.TrimSuffix(c, ".md")+"\n")
	}
}

// makeRootManifest 寫出監看根那一份 `.wiki/manifest.json`（帳本）。
// nodeCards＝節點 →「相對監看根」的卡片路徑，跟 daemon 實際寫的形狀一致
// （2026-08-24 對照 `pms` 現場的真檔驗過：帳本涵蓋每一張卡，只有 00-INDEX.md 不在裡面）。
func makeRootManifest(t *testing.T, root string, nodeCards map[string][]string) {
	t.Helper()
	m := &wikiManifest{Version: 1}
	for node, cards := range nodeCards {
		m.Docs = append(m.Docs, wikiDoc{
			Node: nodeKeyOf(node), Path: "來源.md", DocID: "doc-" + node + "-1",
			Status: "extracted", Cards: cards,
		})
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	cuWriteFile(t, filepath.Join(root, wikiRelDir, "manifest.json"), string(data)+"\n")
}

func makeWorkspace(t *testing.T, root string) {
	t.Helper()
	cuWriteFile(t, filepath.Join(root, workspaceRelDir, ".gitignore"), workspaceIgnoreBody)
	cuWriteFile(t, filepath.Join(root, workspaceRelDir, "wiki", "cards", "arcrun-資料夾總覽-x.md"), "# x\n")
}

func relsOf(items []CleanupItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Rel)
	}
	sort.Strings(out)
	return out
}

func keepRels(keeps []CleanupKeep) []string {
	out := make([]string, 0, len(keeps))
	for _, k := range keeps {
		out = append(out, k.Rel)
	}
	sort.Strings(out)
	return out
}

// snapshotTree 記下整棵樹每個檔的相對路徑與內容雜湊——用來證明「使用者的檔一個都沒動」。
func cuSnapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			return nil
		}
		out[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// ── ① 基本盤：多層巢狀的 .wiki 與工作區全部收掉，使用者的原稿一個不少 ──

func TestCleanupRemovesNestedProductsKeepsUserFiles(t *testing.T) {
	root := t.TempDir()
	// 使用者的東西
	cuWriteFile(t, filepath.Join(root, "README.md"), "我的說明\n")
	cuWriteFile(t, filepath.Join(root, "docs", "設計.md"), "我的設計\n")
	cuWriteFile(t, filepath.Join(root, "docs", "deep", "更深的.md"), "我的深層檔\n")
	// daemon 的東西（三層）
	makeWorkspace(t, root)
	makeWiki(t, filepath.Join(root, wikiRelDir), "根卡.md")
	makeWiki(t, filepath.Join(root, "docs", wikiRelDir), "設計卡.md")
	makeWiki(t, filepath.Join(root, "docs", "deep", wikiRelDir), "深卡.md")
	makeRootManifest(t, root, map[string][]string{
		"":          {".wiki/根卡.md"},
		"docs":      {"docs/.wiki/設計卡.md"},
		"docs/deep": {"docs/deep/.wiki/深卡.md"},
	})

	before := cuSnapshotTree(t, root)

	plan, res, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("不該有刪不掉的：%+v", res.Failed)
	}
	want := []string{".arcrun-rag", ".wiki", "docs/.wiki", "docs/deep/.wiki"}
	if got := relsOf(plan.Remove); !equalStrings(got, want) {
		t.Fatalf("要刪的清單不對\n got=%v\nwant=%v", got, want)
	}

	after := cuSnapshotTree(t, root)
	// 使用者的檔：逐一比對「內容一字不差」。
	for _, rel := range []string{"README.md", "docs/設計.md", "docs/deep/更深的.md"} {
		if after[rel] != before[rel] {
			t.Fatalf("使用者的檔被動到了：%s（before=%q after=%q）", rel, before[rel], after[rel])
		}
	}
	// 剩下的檔**只能是**使用者那三個。
	if len(after) != 3 {
		t.Fatalf("清完之後應該只剩使用者的 3 個檔，實際剩 %d：%v", len(after), after)
	}
	for _, hidden := range []string{".wiki", ".arcrun-rag", "docs/.wiki", "docs/deep/.wiki"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(hidden))); !os.IsNotExist(err) {
			t.Fatalf("%s 沒被刪掉", hidden)
		}
	}
}

// ── ② 陌生鄰居：.wiki 裡有一個不是我們的檔 ⇒ 整個目錄留下，只刪認得的 ──

func TestCleanupKeepsWikiDirWithStrangerFile(t *testing.T) {
	root := t.TempDir()
	wiki := filepath.Join(root, wikiRelDir)
	makeWiki(t, wiki, "卡.md")
	makeRootManifest(t, root, map[string][]string{"": {".wiki/卡.md"}})
	cuWriteFile(t, filepath.Join(wiki, "我自己寫的.md"), "這是我的\n")

	plan, res, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = res
	for _, it := range plan.Remove {
		if it.Kind == CleanupKindWikiDir {
			t.Fatalf("有陌生鄰居時不准整個目錄刪掉：%+v", it)
		}
	}
	if _, err := os.Stat(filepath.Join(wiki, "我自己寫的.md")); err != nil {
		t.Fatalf("使用者自己的檔被刪了：%v", err)
	}
	if _, err := os.Stat(wiki); err != nil {
		t.Fatalf(".wiki 目錄不該被刪：%v", err)
	}
	// 帳本以外的檔（00-INDEX 與 .gitignore 是我們的）該刪掉。
	if _, err := os.Stat(filepath.Join(wiki, "00-INDEX.md")); !os.IsNotExist(err) {
		t.Fatalf("00-INDEX.md 應該被刪掉")
	}
	if !contains(keepRels(plan.Keep), ".wiki/我自己寫的.md") {
		t.Fatalf("留下的東西要出現在 Keep 清單上讓使用者看到：%v", keepRels(plan.Keep))
	}
}

// ── ③ 沒有我們宣告的 .wiki（使用者自己的同名目錄）⇒ 一個檔都不碰 ──

func TestCleanupIgnoresForeignWikiDir(t *testing.T) {
	root := t.TempDir()
	wiki := filepath.Join(root, wikiRelDir)
	cuWriteFile(t, filepath.Join(wiki, "我的筆記.md"), "我的\n")
	cuWriteFile(t, filepath.Join(wiki, "00-INDEX.md"), "# 00-INDEX\n") // 連名字都一樣也不行

	before := cuSnapshotTree(t, root)
	plan, _, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Remove) != 0 {
		t.Fatalf("沒有我們的宣告就一個都不准刪：%v", relsOf(plan.Remove))
	}
	if got := cuSnapshotTree(t, root); len(got) != len(before) {
		t.Fatalf("樹被動到了：before=%v after=%v", before, got)
	}
}

// ── ④ .gitignore 被使用者改過（後面加了自己的規則）⇒ 不算我們的宣告 ──

func TestCleanupRequiresExactIgnoreBody(t *testing.T) {
	root := t.TempDir()
	wiki := filepath.Join(root, wikiRelDir)
	makeWiki(t, wiki, "卡.md")
	cuWriteFile(t, filepath.Join(wiki, ".gitignore"), wikiIgnoreBody+"\n!我要收版控的.md\n")

	plan, err := PlanCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Remove) != 0 {
		t.Fatalf(".gitignore 被改過就不該認：%v", relsOf(plan.Remove))
	}
}

// ── ⑤ 工作區裡有 legacy-template 收容處 ⇒ 收容處留著，其餘刪 ──

func TestCleanupKeepsLegacyTemplateQuarantine(t *testing.T) {
	root := t.TempDir()
	makeWorkspace(t, root)
	quar := filepath.Join(root, legacyTemplateRelDir, "system-dev", "wiki", "status.md")
	cuWriteFile(t, quar, "使用者的舊 status\n")

	plan, res, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("不該有失敗：%+v", res.Failed)
	}
	if _, err := os.Stat(quar); err != nil {
		t.Fatalf("收容處裡的檔被刪了——那是從使用者資料夾搬進來的：%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, workspaceRelDir, "wiki")); !os.IsNotExist(err) {
		t.Fatalf("工作區裡我們自己的東西該刪掉")
	}
	if !contains(keepRels(plan.Keep), ".arcrun-rag/legacy-template") {
		t.Fatalf("收容處要出現在 Keep 清單：%v", keepRels(plan.Keep))
	}
}

// ── ⑥ 另一個還在看守的巢狀根 ⇒ 它底下的東西一個都不碰（2026-08-24 pms 現場擺法）──

func TestCleanupSkipsOtherWatchedRoot(t *testing.T) {
	root := t.TempDir()
	inner := filepath.Join(root, "legacy")
	makeWorkspace(t, root)
	makeWiki(t, filepath.Join(root, wikiRelDir), "外卡.md")
	makeRootManifest(t, root, map[string][]string{"": {".wiki/外卡.md"}})
	makeWorkspace(t, inner)
	makeWiki(t, filepath.Join(inner, wikiRelDir), "內卡.md")
	makeWiki(t, filepath.Join(inner, "sub", wikiRelDir), "更內卡.md")
	makeRootManifest(t, inner, map[string][]string{
		"":    {".wiki/內卡.md"},
		"sub": {"sub/.wiki/更內卡.md"},
	})

	plan, res, err := ApplyCleanup(root, []string{inner})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("不該有失敗：%+v", res.Failed)
	}
	for _, rel := range relsOf(plan.Remove) {
		if strings.HasPrefix(rel, "legacy/") {
			t.Fatalf("動到另一個還在看守的根：%s", rel)
		}
	}
	for _, p := range []string{
		filepath.Join(inner, workspaceRelDir, ".gitignore"),
		filepath.Join(inner, wikiRelDir, "內卡.md"),
		filepath.Join(inner, "sub", wikiRelDir, "更內卡.md"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("還在看守的資料夾底下的東西被刪了：%s（%v）", p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, wikiRelDir)); !os.IsNotExist(err) {
		t.Fatalf("外層自己的 .wiki 該刪掉")
	}
}

// ── ⑦ 看得見的卡片產物區：只刪帶 arcrun- 標記的檔，目錄與別人的卡不動 ──

func TestCleanupMarkedCardsOnly(t *testing.T) {
	root := t.TempDir()
	cards := filepath.Join(root, filepath.FromSlash(cardsRelDir))
	cuWriteFile(t, filepath.Join(cards, "arcrun-機器卡.md"), "# 機器卡\n")
	cuWriteFile(t, filepath.Join(cards, "leo自己的卡.md"), "# 我的\n")
	cuWriteFile(t, filepath.Join(root, "system-dev", "wiki", "status.md"), "我的 status\n")

	_, res, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("不該有失敗：%+v", res.Failed)
	}
	if _, err := os.Stat(filepath.Join(cards, "arcrun-機器卡.md")); !os.IsNotExist(err) {
		t.Fatalf("帶標記的卡該刪掉")
	}
	for _, p := range []string{
		filepath.Join(cards, "leo自己的卡.md"),
		filepath.Join(root, "system-dev", "wiki", "status.md"),
		cards,
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("不該動的東西被動了：%s（%v）", p, err)
		}
	}
}

// ── ⑧ symlink 不跟隨、不刪（指出去的連結會刪到監看根以外）──

func TestCleanupNeverFollowsSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	cuWriteFile(t, filepath.Join(outside, "外面的重要檔.md"), "別碰\n")
	makeWiki(t, filepath.Join(root, wikiRelDir), "卡.md")
	if err := os.Symlink(outside, filepath.Join(root, "捷徑")); err != nil {
		t.Skipf("這台建不了 symlink：%v", err)
	}
	// 連 .wiki 自己是條捷徑的情況也擋
	link2 := filepath.Join(root, "sub", wikiRelDir)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link2); err != nil {
		t.Fatal(err)
	}

	plan, res, err := ApplyCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("不該有失敗：%+v", res.Failed)
	}
	for _, rel := range relsOf(plan.Remove) {
		if strings.HasPrefix(rel, "捷徑") || strings.HasPrefix(rel, "sub/") {
			t.Fatalf("動到 symlink：%s", rel)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "外面的重要檔.md")); err != nil {
		t.Fatalf("監看根以外的檔被刪了：%v", err)
	}
}

// ── ⑨ PlanCleanup 保證不寫檔（「先看清單」的前提就是看清單這件事本身無副作用）──

func TestPlanCleanupWritesNothing(t *testing.T) {
	root := t.TempDir()
	cuWriteFile(t, filepath.Join(root, "我的.md"), "x\n")
	makeWorkspace(t, root)
	makeWiki(t, filepath.Join(root, wikiRelDir), "卡.md")
	makeWiki(t, filepath.Join(root, "docs", wikiRelDir), "卡2.md")

	before := cuSnapshotTree(t, root)
	plan, err := PlanCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Remove) == 0 {
		t.Fatal("這份擺法應該找得到東西")
	}
	after := cuSnapshotTree(t, root)
	if len(before) != len(after) {
		t.Fatalf("PlanCleanup 動了檔案：before=%d after=%d", len(before), len(after))
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("PlanCleanup 改了 %s", k)
		}
	}
	// 每一筆都要說得出依據——沒依據的東西不准進清單。
	for _, it := range plan.Remove {
		if strings.TrimSpace(it.Evidence) == "" {
			t.Fatalf("這一筆沒有依據：%+v", it)
		}
	}
}

// ── ⑩ 帳本認卡：卡名不帶標記、也不是 00-INDEX，靠 manifest.json 認出來 ──

func TestCleanupAccountsCardsViaManifest(t *testing.T) {
	root := t.TempDir()
	wiki := filepath.Join(root, wikiRelDir)
	cuWriteFile(t, filepath.Join(wiki, "手動卡.md"), "# 手動卡\n")
	cuWriteFile(t, filepath.Join(wiki, "manifest.json"), `{"version":1,"docs":[
		{"node":"(根)","path":"a.md","doc_id":"abc","status":"extracted","cards":[".wiki/手動卡.md"]}]}`)
	// 故意不放 .gitignore ⇒ 只能靠帳本認人
	plan, err := PlanCleanup(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := relsOf(plan.Remove); !equalStrings(got, []string{".wiki"}) {
		t.Fatalf("帳本上的卡＋帳本自己＝全部認得，應該整個目錄刪掉，實際 %v（keep=%v）", got, keepRels(plan.Keep))
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
