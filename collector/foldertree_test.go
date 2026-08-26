// foldertree_test.go — 資料夾樹（InkStoneCo#44，leo 2026-08-17）
//
// leo 的驗收情境就是這裡測的東西：
//
//	「指定一個**有子資料夾、且混著支援與不支援檔案**的資料夾 → portal 出現那棵樹，
//	 每個節點兩個數字對得上實際檔案數」
//	「指定一個**空資料夾** → 它也要出現」
//
// 🔴 本檔測的是「分子分母對不對得上實際檔案」——那正是這條規格的重點：
// **兩個數字不相等是正常的，但差額必須解釋得了**。所以每個案例都驗不變式
//
//	total == synced + pending + unsupported + excluded
//
// 而不是只驗「有送出去」。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// answeredFolderTreePost 讓「假 cypher」認得資料夾樹這個端點：是它就自己回 200 並回報 true，
// 呼叫端 `return` 即可，不要把它算進卡片的統計裡。
//
// 🔴 這支存在的理由是一個實撞（2026-08-17，本分支自己踩的）：本套件的假 cypher 幾乎都是
// **萬用 handler**——「收到什麼都當成一次卡片 POST」，然後 `m["page_name"].(string)`。
// #44 之後多了第三個端點（`/portal/daemon/folder-tree`），它的 body **沒有 page_name**
// ⇒ 那些 handler 拿 nil 做型別斷言而 panic。而 panic 發生在 handler 的 goroutine 裡
// ⇒ 測試不是紅，是**掛住到 8 分鐘 timeout**（比紅更難查：看起來像「測試很慢」）。
//
// ⇒ 以後再加第四個 daemon 端點時，凡是「數 POST 幾次／記 page_name」的 stub
//    都要先問過這一句，不要再讓萬用 handler 去猜。
func answeredFolderTreePost(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
		return false
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	return true
}

// nodeOf 從一棵樹裡撈出某個路徑的節點（找不到就讓測試自己 Fatal，不回 nil 讓後面 panic）。
func treeNodeOf(t *testing.T, tree FolderTree, path string) FolderNode {
	t.Helper()
	for _, n := range tree.Nodes {
		if n.Path == path {
			return n
		}
	}
	t.Fatalf("樹裡沒有節點 %q，實際有：%v", path, nodePaths(tree))
	return FolderNode{}
}

func nodePaths(tree FolderTree) []string {
	out := make([]string, 0, len(tree.Nodes))
	for _, n := range tree.Nodes {
		out = append(out, n.Path)
	}
	return out
}

// 掃一個真實的暫存資料夾，把 Scan() 數出來的分母與 manifest 現況合成樹。
// 刻意走真的 Scan()——分母的判準活在那趟 WalkDir 裡，繞過它就等於測了另一套實作。
func buildTreeFromDisk(t *testing.T, root string) FolderTree {
	t.Helper()
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	plan := PlanIngest(root)
	payload, err := Scan(root, m, ScanOptions{Plan: plan})
	if err != nil {
		t.Fatalf("Scan 失敗：%v", err)
	}
	return BuildFolderTree(root, "kb", payload.DirStats, m.Entries, payload.AllExcludedDirs, plan, time.Unix(1786900000, 0))
}

// ── leo 的驗收情境①：有子資料夾、混著支援與不支援的檔案 ────────────────────────

func TestFolderTree混合資料夾的兩個數字對得上(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "報銷規則.md"), "# 報銷規則\n內容")
	mustWrite(t, filepath.Join(root, "docs", "流程.md"), "# 流程\n內容")
	mustWrite(t, filepath.Join(root, "docs", "簡報.pptx"), "binary-ish")
	mustWrite(t, filepath.Join(root, "docs", "main.go"), "package main")
	mustWrite(t, filepath.Join(root, "img", "logo.png"), "PNG")

	tree := buildTreeFromDisk(t, root)

	// 樹要長得出來（根＋docs＋img），而且根一定在第一個（畫面靠這個順序）
	if len(tree.Nodes) < 3 {
		t.Fatalf("節點太少：%v", nodePaths(tree))
	}
	if tree.Nodes[0].Path != "" {
		t.Fatalf("根不在第一個：%v", nodePaths(tree))
	}
	if tree.DisplayName == "" {
		t.Error("根沒有顯示名——使用者認得的是資料夾名字，不是空字串")
	}

	// 🔴 不變式：每一層的分母必須解釋得完（差額＝不支援＋不收＋還在路上）
	for _, n := range tree.Nodes {
		if n.Skipped {
			continue // 沒走進去 ⇒ 數字全 0 且不是事實，見下一支測試
		}
		sum := n.SyncedFiles + n.PendingFiles + n.UnsupportedFiles + n.ExcludedFiles
		if n.TotalFiles != sum {
			t.Errorf("節點 %q 的差額解釋不了：total=%d 但 synced+pending+unsupported+excluded=%d（%+v）",
				n.Path, n.TotalFiles, sum, n)
		}
	}

	// docs 這一層：Finder 裡看得到 3 個檔 ⇒ 分母就是 3（不是「我們收得下的那 1 個」）。
	// 這是整條規格的核心：分母是使用者數得出來的那個數字。
	docs := treeNodeOf(t, tree, "docs")
	if docs.TotalFiles != 3 {
		t.Errorf("docs 分母=%d，應為 3（.md/.pptx/.go 使用者都看得到）：%+v", docs.TotalFiles, docs)
	}
	// 且「沒上傳的那些」要分得出是哪一類——leo：「不上傳通常是不支援，比如程式碼、不支援的格式」
	if docs.UnsupportedFiles+docs.ExcludedFiles == 0 {
		t.Errorf("docs 有讀不了/不收的檔，卻一個都沒分類到：%+v", docs)
	}

	// 每個節點都要有名字與父親，畫面才串得成一棵樹（少一環就變一堆浮著的節點）
	for _, n := range tree.Nodes {
		if n.Path != "" && n.Parent == "-" {
			t.Errorf("非根節點 %q 的 parent 是 '-'（只有根才准）", n.Path)
		}
		if n.Name == "" {
			t.Errorf("節點 %q 沒有名字", n.Path)
		}
	}
}

// ── leo 的驗收情境②：空資料夾也要出現（arcrun-rag#106）────────────────────────

func TestFolderTree空資料夾照樣有根節點(t *testing.T) {
	root := t.TempDir()
	tree := buildTreeFromDisk(t, root)
	if len(tree.Nodes) != 1 || tree.Nodes[0].Path != "" {
		t.Fatalf("空資料夾應恰好有一個根節點：%v", nodePaths(tree))
	}
	if tree.Nodes[0].TotalFiles != 0 {
		t.Errorf("空資料夾的分母應為 0：%+v", tree.Nodes[0])
	}
	// leo：「不能因為地端資料夾內沒東西就當作不存在，如果那是他打算放東西的資料夾呢？」
	// ⇒ 樹要送得出去（有 library、有 root），收端才登記得起這個庫。
	if tree.Library == "" || tree.Root == "" {
		t.Errorf("空資料夾的樹缺 library/root，收端登記不了：%+v", tree)
	}
}

// 走進得去但一個檔都沒有的子資料夾，也要有自己的節點
//（leo 的規格是「不管那層有沒有文件，整棵樹都要採」）。
func TestFolderTree空的子資料夾也有節點(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "a.md"), "# A")
	if err := os.MkdirAll(filepath.Join(root, "打算放東西的地方"), 0o755); err != nil {
		t.Fatal(err)
	}
	tree := buildTreeFromDisk(t, root)
	n := treeNodeOf(t, tree, "打算放東西的地方")
	if n.TotalFiles != 0 || n.Skipped {
		t.Errorf("空的子資料夾應該是「有節點、數字 0、沒被剪掉」：%+v", n)
	}
}

// ── 冪等與雜湊 ───────────────────────────────────────────────────────────────

func TestFolderTreeHash不含時間(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "a.md"), "# A")
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	plan := PlanIngest(root)
	payload, err := Scan(root, m, ScanOptions{Plan: plan})
	if err != nil {
		t.Fatal(err)
	}
	t1 := BuildFolderTree(root, "kb", payload.DirStats, m.Entries, payload.AllExcludedDirs, plan, time.Unix(1000, 0))
	t2 := BuildFolderTree(root, "kb", payload.DirStats, m.Entries, payload.AllExcludedDirs, plan, time.Unix(9999, 0))
	if t1.Hash() != t2.Hash() {
		t.Error("同一份內容在不同時間算出不同雜湊 ⇒ 冪等閘失效，會每輪重送")
	}
	if t1.Hash() == "" {
		t.Error("雜湊算不出來")
	}
}

// ── 上傳行為：整棵一次送、成功後節流、失敗退避 ──────────────────────────────

func TestSyncFolderTree整棵一次送(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			t.Errorf("打錯端點：%s", r.URL.Path)
		}
		if r.Header.Get("X-Arcrun-API-Key") == "" {
			t.Error("沒帶 X-Arcrun-API-Key（收端會 401）")
		}
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		bodies = append(bodies, m)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	root := t.TempDir()
	for i := 0; i < 50; i++ { // 遠超過舊版 20 個節點一批的分批門檻
		mustWrite(t, filepath.Join(root, "d"+string(rune('a'+i%26))+string(rune('a'+i/26)), "x.md"), "# X")
	}
	tree := buildTreeFromDisk(t, root)
	if len(tree.Nodes) <= 20 {
		t.Fatalf("前置沒建出足夠節點：%d", len(tree.Nodes))
	}

	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	now := time.Unix(1786900000, 0)
	res := syncFolderTree(cfg, root, m, tree, false, now)
	if res == nil || res.Status != "ingested" {
		t.Fatalf("應送達：%+v", res)
	}
	// 🔴 一次請求送完整棵樹：分批只在「收端每節點一次寫入」的設計下才有意義，
	// 而收端改成整棵覆寫後，分批只會留下半棵樹的中間狀態。
	if len(bodies) != 1 {
		t.Fatalf("應恰好一次請求，實際 %d 次", len(bodies))
	}
	sent, _ := bodies[0]["nodes"].([]any)
	if len(sent) != len(tree.Nodes) {
		t.Errorf("送出的節點數 %d ≠ 樹的節點數 %d（有被切掉）", len(sent), len(tree.Nodes))
	}
	if bodies[0]["sync_token"] == "" || bodies[0]["library"] != "kb" {
		t.Errorf("body 缺 sync_token/library：%+v", bodies[0])
	}

	// 內容沒變 → 不重送
	if again := syncFolderTree(cfg, root, m, tree, false, now.Add(time.Hour)); again != nil {
		t.Errorf("內容沒變不該重送：%+v", again)
	}

	// 內容變了、但還在最小間隔內 → 也不送（沒有這道閘，初次同步會每 5 秒送一次）
	changed := tree
	changed.Nodes = append([]FolderNode{{Path: "新", Name: "新", Parent: "", Depth: 1}}, tree.Nodes...)
	if soon := syncFolderTree(cfg, root, m, changed, false, now.Add(30*time.Second)); soon != nil {
		t.Errorf("最小間隔內不該送：%+v", soon)
	}
	// 過了最小間隔 → 送
	if later := syncFolderTree(cfg, root, m, changed, false, now.Add(folderTreeMinInterval+time.Second)); later == nil {
		t.Error("過了最小間隔應該要送")
	}
	if len(bodies) != 2 {
		t.Errorf("應總共兩次請求，實際 %d", len(bodies))
	}
}

func TestSyncFolderTree首次不受最小間隔限制(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	root := t.TempDir()
	tree := buildTreeFromDisk(t, root) // 空資料夾
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	// FolderTreeNextSend 是零值（從沒送過）⇒ 就算「現在」小於它也不能被擋
	// ——指定資料夾的當下就要看得見它，那正是 #106 的重點。
	if res := syncFolderTree(&DirectConfig{CypherURL: srv.URL, APIKey: "demo"}, root, m, tree, false, time.Unix(1, 0)); res == nil || res.Status != "ingested" {
		t.Fatalf("首次應直接送出：%+v", res)
	}
	if hits != 1 {
		t.Errorf("應打一次，實際 %d", hits)
	}
}

func TestSyncFolderTree失敗退避(t *testing.T) {
	root := t.TempDir()
	tree := buildTreeFromDisk(t, root)
	cfg := &DirectConfig{CypherURL: "https://x.invalid", APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	now := time.Unix(1786900000, 0)
	res := syncFolderTree(cfg, root, m, tree, false, now)
	if res == nil || res.Status != "failed" {
		t.Fatalf("應失敗：%+v", res)
	}
	if m.FolderTreeFailHash == "" || m.FolderTreeNextRetry == 0 {
		t.Errorf("失敗沒記退避 ⇒ 雲端一壞就每 5 秒重撞一次：%+v", m)
	}
	// 退避窗口內同一份內容不重撞
	if again := syncFolderTree(cfg, root, m, tree, false, now.Add(time.Minute)); again != nil {
		t.Errorf("退避窗口內不該重試：%+v", again)
	}
}

