package collector

// foldertree_live_test.go — 對**真實的監看資料夾**跑一次樹，用 leo 給的機械判準對帳
//（`inkstone/Arcrun#180`，leo 2026-08-28：
// 「就在桌面，你為什麼沒看？最簡單的方式就像 terminal tree 一樣把被同步資料夾下的
// 所有 folder 都遍歷後印出來」）。
//
// 🔴 為什麼 fixture 不夠（同 sourcerepair_live_test.go 的理由）：
// `foldertree_traversal_test.go` 用的是我們自己擺出來的形狀——它證明得了邏輯，
// 證明不了「**leo 桌面上那個資料夾**現在到底展不展得開」。
// 這張票的現象是他螢幕上的數字，對帳就要拿他螢幕上那個資料夾來對。
//
// 只讀磁碟、不碰網路、不寫 manifest，所以沒有「打錯實例」的風險；
// 仍然預設 skip，因為路徑是機器專屬的。
//
//	LIVE_TREE_ROOTS="/Users/x/Desktop/youlinhsieh-test1,/Users/x/Desktop/youlinhsieh-test2" \
//	go test -run TestLiveFolderTreeMatchesDisk -v ./
//
// 判準（leo 原話）：**`find <root> -type d` 數出幾個目錄，雲端的樹就該有幾個節點**
//（收不收是另一回事，`skip_reason` 照標）。
// 例外只有一種且必須說得出口：**真的沒走進去**的那幾類（gitignore／工具產物／
// 建置目錄／worktree／巢狀 repo）——它們仍然佔一個節點，但底下不生子節點，
// 所以本測試把它們的子樹從地端這一側也扣掉，兩邊才是同一個問題的兩個答案。

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// diskDirsExcludingPrunedSubtrees＝地端目錄清單，但「真的沒走進去」的那幾類只算它自己。
func diskDirsExcludingPrunedSubtrees(t *testing.T, root string, plan IngestPlan) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err //nolint:nilerr // 讀不到的目錄交給 WalkDir 自己回報
		}
		if p == root {
			out = append(out, "")
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		out = append(out, rel)
		if skip, _ := plan.SkipsDirWhy(rel, p); skip {
			return filepath.SkipDir // 節點留著（上一行已經 append），子樹不算
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

func TestLiveFolderTreeMatchesDisk(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("LIVE_TREE_ROOTS"))
	if raw == "" {
		t.Skip("設 LIVE_TREE_ROOTS=<資料夾,資料夾> 才跑（路徑是機器專屬的）")
	}
	for _, root := range strings.Split(raw, ",") {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		t.Run(filepath.Base(root), func(t *testing.T) {
			plan := PlanIngest(root)
			m := &Manifest{Entries: map[string]*ManifestEntry{}}
			p, err := Scan(root, m, ScanOptions{Plan: plan})
			if err != nil {
				t.Fatal(err)
			}
			tree := BuildFolderTree(root, "live", p.DirStats, m.Entries, p.AllExcludedDirs, plan, time.Now())

			onTree := map[string]FolderNode{}
			for _, n := range tree.Nodes {
				onTree[n.Path] = n
			}
			want := diskDirsExcludingPrunedSubtrees(t, root, plan)

			t.Logf("收檔策略：%s — %s", plan.Mode, plan.Reason)
			t.Logf("地端目錄 %d（扣掉沒走進去的子樹）／樹上節點 %d／truncated=%v",
				len(want), tree.TotalNodes, tree.Truncated)
			for _, n := range tree.Nodes {
				t.Logf("  %-46s tot=%-4d sync=%-4d excl=%-4d skipped=%v %s",
					"'"+n.Path+"'", n.TotalFiles, n.SyncedFiles, n.ExcludedFiles, n.Skipped, n.SkipReason)
			}

			var missing []string
			for _, w := range want {
				if _, ok := onTree[w]; !ok {
					missing = append(missing, w)
				}
			}
			if len(missing) > 0 {
				t.Fatalf("地端有、樹上沒有的資料夾（「不收」又被實作成「不走進去」了）：%v", missing)
			}
			if tree.TotalNodes != len(want) {
				t.Fatalf("樹上節點 %d ≠ 地端資料夾 %d", tree.TotalNodes, len(want))
			}
			if tree.Truncated {
				t.Fatalf("被截斷了——MaxFolderTreeNodes=%d 不夠這個資料夾用，不准靜默截斷",
					MaxFolderTreeNodes)
			}
		})
	}
}
