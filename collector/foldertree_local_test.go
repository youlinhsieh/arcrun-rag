// foldertree_local_test.go — 本機那份樹快照（`inkstone/InkStoneCo#44` 桌面小幫手那半）
//
// 這裡測的不是「樹算得對不對」（那在 foldertree_test.go，已驗過、沒動），
// 而是**落地那一層的三個會讓畫面說謊的情境**：
//
//	① 這一輪掃壞了 ⇒ 不准把上一輪的好資料蓋成空的（畫面不該突然說「還沒回報」）
//	② 使用者移除了資料夾 ⇒ 快照裡那棵要消失（不然他以為沒移掉）
//	③ 存進去、讀回來，要是同一棵樹（桌面與 portal 看到的是同一份資料）
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sampleTree(root string, synced, total int) FolderTree {
	return FolderTree{
		Library:     "lib-" + filepath.Base(root),
		DisplayName: filepath.Base(root),
		Root:        root,
		Mode:        "all",
		Reason:      "整個資料夾都收",
		Nodes: []FolderNode{
			{Path: "", Name: filepath.Base(root), Parent: "-", Depth: 0,
				TotalFiles: total, SyncedFiles: synced, UnsupportedFiles: total - synced},
			{Path: "sub", Name: "sub", Parent: "", Depth: 1, TotalFiles: 2, SyncedFiles: 2},
		},
		TotalNodes:  2,
		GeneratedAt: 1000,
	}
}

// ③ 存－讀來回：一個欄位都不准掉。
// 🔴 這條的重點不是 JSON 會不會動，是**桌面看到的必須是送上雲端的那一棵**——
// 少一個欄位就等於本機悄悄長出了第二套資料形狀。
func TestFolderTreeStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := FolderTreeStorePath(filepath.Join(dir, "manifest.json"))
	if want := filepath.Join(dir, "folder-trees.json"); path != want {
		t.Fatalf("快照該與 manifest 同目錄：got %s want %s", path, want)
	}
	in := FolderTreeStore{
		UpdatedAt: "2026-08-26T00:00:00Z",
		Trees:     map[string]FolderTree{"/a/b": sampleTree("/a/b", 3, 5)},
	}
	if err := SaveFolderTreeStore(path, in); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}
	out, err := LoadFolderTreeStore(path)
	if err != nil {
		t.Fatalf("讀回失敗：%v", err)
	}
	got, ok := out.Trees["/a/b"]
	if !ok {
		t.Fatalf("讀回來少了那棵樹：%+v", out)
	}
	if got.Library != "lib-b" || got.Reason != "整個資料夾都收" || got.Mode != "all" {
		t.Fatalf("欄位掉了：%+v", got)
	}
	if len(got.Nodes) != 2 || got.Nodes[0].TotalFiles != 5 || got.Nodes[0].SyncedFiles != 3 ||
		got.Nodes[0].Parent != "-" || got.Nodes[1].Depth != 1 {
		t.Fatalf("節點對不上：%+v", got.Nodes)
	}
}

// 讀不到／壞掉的檔一律回可用的零值——桌面小幫手不該因為快照壞掉就整個畫不出來。
func TestFolderTreeStoreLoadMissingOrBroken(t *testing.T) {
	dir := t.TempDir()
	s, err := LoadFolderTreeStore(filepath.Join(dir, "nope.json"))
	if err == nil {
		t.Fatalf("檔案不存在該回 error")
	}
	if s.Trees == nil {
		t.Fatalf("零值也要能直接用（Trees 不可為 nil）")
	}
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s2, err := LoadFolderTreeStore(bad)
	if err == nil {
		t.Fatalf("壞檔該回 error")
	}
	if s2.Trees == nil {
		t.Fatalf("壞檔也要回可用的零值")
	}
}

// ①：這一輪某個根沒算出樹（掃描失敗／還沒輪到）⇒ 沿用上一輪的，不清空。
func TestMergeFolderTreeStoreKeepsPreviousWhenRoundProducedNothing(t *testing.T) {
	now := time.Unix(2000, 0)
	prev := FolderTreeStore{Trees: map[string]FolderTree{
		"/a": sampleTree("/a", 3, 5),
		"/b": sampleTree("/b", 1, 1),
	}}
	// 這一輪只有 /a 算出來，/b 掃失敗（fresh 裡沒有它），但兩個都還在看守清單上。
	out := MergeFolderTreeStore(prev, map[string]FolderTree{"/a": sampleTree("/a", 5, 5)}, []string{"/a", "/b"}, now)
	if len(out.Trees) != 2 {
		t.Fatalf("兩個根都該在：%+v", out.Trees)
	}
	if out.Trees["/a"].Nodes[0].SyncedFiles != 5 {
		t.Fatalf("這一輪算出來的該覆蓋舊的：%+v", out.Trees["/a"].Nodes[0])
	}
	if out.Trees["/b"].Nodes[0].SyncedFiles != 1 {
		t.Fatalf("這一輪沒算出來的該沿用上一輪，不是被清掉：%+v", out.Trees["/b"])
	}
	if out.UpdatedAt == "" {
		t.Fatalf("要記得更新時間，畫面才說得出「這是什麼時候的現況」")
	}
}

// ②：使用者把資料夾從看守清單移掉 ⇒ 快照裡那棵要消失。
// 留著的話他移除完還看得到那棵樹，會以為移除沒作用（arcrun-rag#46 修過的同一個病）。
func TestMergeFolderTreeStoreDropsUnwatchedRoots(t *testing.T) {
	now := time.Unix(3000, 0)
	prev := FolderTreeStore{Trees: map[string]FolderTree{
		"/a":    sampleTree("/a", 3, 5),
		"/gone": sampleTree("/gone", 1, 1),
	}}
	out := MergeFolderTreeStore(prev, map[string]FolderTree{}, []string{"/a"}, now)
	if _, still := out.Trees["/gone"]; still {
		t.Fatalf("已經不看守的根不該留在快照裡：%+v", out.Trees)
	}
	if _, ok := out.Trees["/a"]; !ok {
		t.Fatalf("還在看守的根不該被一起刪掉：%+v", out.Trees)
	}
}

// ── 接線測試：跑完一輪，本機真的多出那份快照 ────────────────────────────────
//
// 🔴 這支存在的理由就是 `arcrun-rag#104` 那條教訓的翻版：
// 「東西做好了，但**不在會被執行的那條路上**」。
// 樹早就算得出來（BuildFolderTree 有測、送雲端有測），但只要 RunDirectOnce
// 沒把它落地，桌面小幫手就永遠一個字都看不到——而單看那些既有的測試，全綠。
func TestRunDirectOnce把樹落地給桌面小幫手(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "我的知識庫")
	mustWrite(t, filepath.Join(root, "報銷規則.md"), "# 報銷規則\n內容")
	mustWrite(t, filepath.Join(root, "docs", "流程.md"), "# 流程\n內容")
	mustWrite(t, filepath.Join(root, "docs", "main.go"), "package main")

	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "stub", true }
	defer func() { fetchCloudVersion = orig }()

	manifest := filepath.Join(base, "manifest.json")
	cfg := &DirectConfig{
		Manifest:          manifest,
		Accounts:          []AccountConfig{{CypherURL: srv.URL, Namespace: "ns", WatchFolders: []string{root}}},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true, // 隔離變因：本測驗的是落地，不是萃取
	}
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatalf("同步應成功，exit=%d", exit)
	}

	store, err := LoadFolderTreeStore(FolderTreeStorePath(manifest))
	if err != nil {
		t.Fatalf("跑完一輪之後應該有快照可讀：%v", err)
	}
	tree, ok := store.Trees[root]
	if !ok {
		t.Fatalf("快照裡沒有這個看守根：%+v", store.Trees)
	}
	// 桌面畫面要的東西一件都不能少：根節點、子資料夾、分母、以及「為什麼沒收」的分類。
	if len(tree.Nodes) < 2 {
		t.Fatalf("樹太扁，畫不出巢狀結構：%+v", tree.Nodes)
	}
	if tree.DisplayName != "我的知識庫" {
		t.Errorf("根的顯示名要是使用者認得的資料夾名，got %q", tree.DisplayName)
	}
	var docs *FolderNode
	for i := range tree.Nodes {
		if tree.Nodes[i].Path == "docs" {
			docs = &tree.Nodes[i]
		}
	}
	if docs == nil {
		t.Fatalf("子資料夾 docs 不在樹上：%+v", tree.Nodes)
	}
	if docs.TotalFiles != 2 {
		t.Errorf("docs 分母=%d，應為 2（使用者在 Finder 裡看得到兩個檔）：%+v", docs.TotalFiles, docs)
	}
	if docs.UnsupportedFiles+docs.ExcludedFiles == 0 {
		t.Errorf("main.go 沒被分類到「為什麼沒上去」：%+v", docs)
	}

	// 🔴 不准併進 status.json：那支每秒被讀一次，樹上限 300 個節點。
	raw, err := os.ReadFile(StatusFilePath(manifest))
	if err != nil {
		t.Fatalf("status.json 該存在：%v", err)
	}
	if strings.Contains(string(raw), "folder_tree") || strings.Contains(string(raw), "\"nodes\"") {
		t.Errorf("樹跑進 status.json 了——那支每秒讀一次，不該扛這個")
	}
}
