// foldertree_inprogress_test.go — arcrun-rag#213／c10630：FolderNode 要看得到
// 「哪些大檔走過續讀機制、目前讀到幾 %」，桌面 UI（main.js 的 gapWhy）才有東西可畫。
package collector

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBuildFolderTree_InProgressFilesCarriesPercent(t *testing.T) {
	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 60) // 夠大，會走續讀機制，但這裡只需要書籤存在，不必真的打 API

	// 直接造一份書籤（不必真的跑萃取）：模擬「已經讀了 3/10 段」。
	node, base := docNodeAndPath(root, "手冊.md")
	nodeKey := nodeKeyOf(node)
	progress := &extractProgress{
		SourceHash:  "sha256:fake",
		ChunkBounds: []int{0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000},
		Done:        3,
	}
	if err := saveExtractProgress(root, node, nodeKey, base, progress); err != nil {
		t.Fatal(err)
	}

	dirs := map[string]*dirStat{"": {total: 1, unsupported: 0, excluded: 0}}
	entries := map[string]*ManifestEntry{
		"手冊.md": {ContentHash: "sha256:x", IngestedHash: ""}, // 還沒蓋章＝pending
	}
	tree := BuildFolderTree(root, "kb", dirs, entries, nil, IngestPlan{Mode: "all"}, time.Unix(1000, 0))

	var rootNode *FolderNode
	for i := range tree.Nodes {
		if tree.Nodes[i].Path == "" {
			rootNode = &tree.Nodes[i]
		}
	}
	if rootNode == nil {
		t.Fatal("找不到根節點")
	}
	if len(rootNode.InProgressFiles) != 1 {
		t.Fatalf("根節點應該有 1 份走過續讀機制的檔，實際 %d：%+v", len(rootNode.InProgressFiles), rootNode.InProgressFiles)
	}
	got := rootNode.InProgressFiles[0]
	if got.Name != "手冊" {
		t.Errorf("檔名應該是 pageNameOf 算出來的「手冊」，實際 %q", got.Name)
	}
	if got.Percent != 30 {
		t.Errorf("3/10 段應該是 30%%，實際 %d%%", got.Percent)
	}
}

func TestBuildFolderTree_NoInProgressFilesForOrdinaryPendingFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "small.md"), []byte("# 小檔"), 0o644); err != nil {
		t.Fatal(err)
	}
	dirs := map[string]*dirStat{"": {total: 1}}
	entries := map[string]*ManifestEntry{
		"small.md": {ContentHash: "sha256:x", IngestedHash: ""}, // pending 但沒有續讀書籤
	}
	tree := BuildFolderTree(root, "kb", dirs, entries, nil, IngestPlan{Mode: "all"}, time.Unix(1000, 0))
	for _, n := range tree.Nodes {
		if len(n.InProgressFiles) != 0 {
			t.Errorf("一般小檔（沒走過續讀）不該出現在 InProgressFiles：%+v", n)
		}
	}
}
