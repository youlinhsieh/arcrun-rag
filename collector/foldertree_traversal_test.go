// foldertree_traversal_test.go — 「雲端的樹要看得到所有的 folder」的迴歸網
// （inkstone/Arcrun#180，leo 2026-08-28）。
//
// leo 給的判準是機械的，本檔就照它寫：
//
//	find <root> -type d ｜ wc -l   ==   樹的 total_nodes
//	（實測差距：youlinhsieh-test1 地端 12 個目錄，雲端的樹只有 3 個節點）
//
// 🔴 這一組釘死的是「**展開 ≠ 收檔**」：收不收是另一個判斷，
// 不准再用「不走進去」來實作「不收」——那會讓使用者連自己有哪些子資料夾都看不到。
package collector

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// countLocalDirs＝`find <root> -type d -not -path '*/.*'` 的 Go 版（含根自己）。
func countLocalDirs(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err
		}
		if p != root && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		n++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func treeOf(t *testing.T, root string) FolderTree {
	t.Helper()
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	plan := PlanIngest(root)
	p, err := Scan(root, m, ScanOptions{Plan: plan})
	if err != nil {
		t.Fatal(err)
	}
	return BuildFolderTree(root, "lib", p.DirStats, m.Entries, p.AllExcludedDirs, plan, time.Now())
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 這棵樹照著 leo 貼的 `youlinhsieh-test1` 真實形狀擺：
// 一個「一般資料夾」（mode=all），底下一整棵 system-dev——以前整棵被剪掉。
func fixtureLikeTest1(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	// 範本鋪下去的那幾個，內容一律從內嵌快照原樣取——判準是「內容逐字相同」
	// （templateuntouched.go），自己捏一段假字串會被正確地判成「使用者寫的」。
	snap := func(rel string) string {
		data, err := templateFS.ReadFile(templateFSRoot + "/" + rel)
		if err != nil {
			t.Fatalf("快照裡沒有 %s：%v", rel, err)
		}
		return string(data)
	}
	write(t, filepath.Join(root, "火星座標_短片劇本_v1.md"), "# 火星座標\n")
	write(t, filepath.Join(root, "scripts", "sdd-active-check.sh"), snap("scripts/sdd-active-check.sh"))
	write(t, filepath.Join(root, "system-dev", "VERSION"), snap("system-dev/VERSION"))
	write(t, filepath.Join(root, "system-dev", "wiki", "status.md"), snap("system-dev/wiki/status.md"))
	// 快照裡沒有的真內容——leo 要的那 9 張卡就是這一種
	write(t, filepath.Join(root, "system-dev", "wiki", "cards", "arcrun-火星座標_短片劇本_v1.md"), "# 卡\n")
	write(t, filepath.Join(root, "system-dev", "docs", "3-specs", "TEMPLATE-sdd", "design.md"), snap("system-dev/docs/3-specs/TEMPLATE-sdd/design.md"))
	write(t, filepath.Join(root, "system-dev", "workflows", "tasks-project-sync.yaml"), snap("system-dev/workflows/tasks-project-sync.yaml"))
	return root
}

func TestFolderTree_地端有幾個資料夾樹上就要有幾個節點(t *testing.T) {
	root := fixtureLikeTest1(t)
	want := countLocalDirs(t, root) // 根＋scripts＋system-dev＋wiki＋cards＋docs＋3-specs＋TEMPLATE-sdd＋workflows ＝ 9
	tree := treeOf(t, root)
	if tree.TotalNodes != want {
		var got []string
		for _, n := range tree.Nodes {
			got = append(got, n.Path)
		}
		t.Fatalf("樹的節點數 %d ≠ 地端資料夾數 %d\n樹上有：%v", tree.TotalNodes, want, got)
	}
	if tree.Truncated {
		t.Fatalf("這麼小的一棵樹不該被截斷")
	}
}

func TestFolderTree_不收的那一層仍然展得開而且說得出理由(t *testing.T) {
	root := fixtureLikeTest1(t)
	tree := treeOf(t, root)
	byPath := map[string]FolderNode{}
	for _, n := range tree.Nodes {
		byPath[n.Path] = n
	}

	// ① system-dev 底下每一層都在（以前整棵不存在）
	for _, want := range []string{
		"system-dev", "system-dev/wiki", "system-dev/wiki/cards",
		"system-dev/docs", "system-dev/docs/3-specs",
		"system-dev/docs/3-specs/TEMPLATE-sdd", "system-dev/workflows",
	} {
		if _, ok := byPath[want]; !ok {
			t.Fatalf("樹上少了 %q——「不收」又被實作成「不走進去」了", want)
		}
	}

	// ② 數字是真的：cards 底下實際有 1 個檔，不是我們編的 0；
	//    而且它是真內容 ⇒ 要被收（leo：「cards 在 system-dev 下…所以不允許跳過它」）
	if got := byPath["system-dev/wiki/cards"]; got.TotalFiles != 1 || got.ExcludedFiles != 0 {
		t.Fatalf("cards：total=%d excluded=%d，期望 1／0（走進去了要數真的，而且真內容要收）",
			got.TotalFiles, got.ExcludedFiles)
	}

	// ③ 一個檔都沒收的那幾層（全是範本空殼），理由要講得出來
	for _, p := range []string{"system-dev/wiki", "scripts", "system-dev/workflows"} {
		n := byPath[p]
		if n.ExcludedFiles != n.TotalFiles || n.TotalFiles == 0 {
			t.Fatalf("%s 期望「全部排除」，實際 total=%d excluded=%d", p, n.TotalFiles, n.ExcludedFiles)
		}
		if !n.Skipped || n.SkipReason == "" {
			t.Fatalf("%s 一個檔都沒收，卻沒有講理由（skipped=%v reason=%q）", p, n.Skipped, n.SkipReason)
		}
	}

	// ④ 收檔範圍沒有跟著放寬——範本檔仍然不是知識
	if n := byPath[""]; n.SyncedFiles+n.PendingFiles == 0 {
		t.Fatalf("根層那份真文件應該還是要收")
	}
}

// 剪枝只剩「走進去也沒有意義」的那幾種，而且仍然留節點＋理由。
func TestFolderTree_依賴目錄仍然剪枝但看得見(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "筆記.md"), "# 筆記\n")
	write(t, filepath.Join(root, "node_modules", "left-pad", "index.js"), "module.exports=1\n")
	tree := treeOf(t, root)

	var nm *FolderNode
	for i := range tree.Nodes {
		if tree.Nodes[i].Path == "node_modules" {
			nm = &tree.Nodes[i]
		}
		if strings.HasPrefix(tree.Nodes[i].Path, "node_modules/") {
			t.Fatalf("不該走進 node_modules，卻生出了 %q", tree.Nodes[i].Path)
		}
	}
	if nm == nil {
		t.Fatal("node_modules 剪掉了就更該列出來——安靜地少收與講一個 0 是同一件事")
	}
	if !nm.Skipped || nm.SkipReason == "" {
		t.Fatalf("node_modules 沒有理由：skipped=%v reason=%q", nm.Skipped, nm.SkipReason)
	}
}
