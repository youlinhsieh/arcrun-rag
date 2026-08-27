// foldertree_publish_test.go — 「畫面有沒有跟上」的網（`inkstone/arcrun-rag#153` 第二輪）。
//
// 🔴 這裡測的判準跟 stallguard_test.go **刻意不一樣**，因為第一輪測錯了東西：
// 那一輪的網問的是「**有沒有發出警告**」，而總管 2026-08-28 端到端實測打回來的正是
// 「閘在跑、警告會發，**但主流程仍然沒走下去**」。
//
//	stallguard_test.go        端點**不回應**時 → 這一輪要跳過它、要有話說
//	foldertree_publish_test   端點**回應但很慢**時 → 畫面要的東西**不准排在後面等**
//
// 為什麼第二種才是使用者真正撞到的（`ARCRUN_TRACE=1` 實測，健康的 youlin 實例）：
// 每一發雲端呼叫 24〜33 秒，**沒有一發接近 300 秒** ⇒ 逾時不會觸發、斷路器不會跳、
// 播報也大多不會響（門檻 30 秒）。一輪就這樣安靜地跑十幾分鐘到幾小時，
// 而 `folder-trees.json` 從前**只在整輪的最後**才落地。
// 使用者看到的是「小幫手開著、沒有錯誤、資料夾結構永遠停在上一版」。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// slowButHealthyServer＝**會回應、只是慢**。這是本檔的主角，不是黑洞。
func slowButHealthyServer(t *testing.T, delay time.Duration, hits *int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(hits, 1)
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// 🔴 本票第二輪的核心：**雲端每一發都很慢（但都會回來）時，資料夾結構仍然要在
// 這一輪還在跑的時候就已經寫好**。
//
// 這條會抓到的回歸：把樹的落地搬回「整輪最後」——那時它會等到所有雲端呼叫跑完，
// 使用者的畫面就又回到「永遠停在上一版」。
func TestFolderTreeLandsWhileTheRoundIsStillRunning(t *testing.T) {
	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	// 每一發 400ms——遠低於任何逾時（所以斷路器不會跳，正是實測的形狀），
	// 但夠多發就足以把一輪拖長。
	var hits int64
	slow := slowButHealthyServer(t, 400*time.Millisecond, &hits)

	// 多層資料夾＋多個檔：讓「雲端呼叫的總時間」明顯大於「算一棵樹的時間」。
	root := t.TempDir()
	for _, d := range []string{"a", "b", "c", "d", "e", "a/a1", "b/b1"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, d, "n.md"), []byte("# n\n內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "top.md"), []byte("# top\n內容"), 0o644); err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	treePath := FolderTreeStorePath(manifestPath)
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{{CypherURL: slow.URL, Namespace: "n", APIKey: "k",
			WatchFolders: []string{root}}},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}

	roundDone := make(chan time.Duration, 1)
	start := time.Now()
	go func() {
		RunDirectOnce(cfg, false)
		roundDone <- time.Since(start)
	}()

	// 一邊等這一輪跑，一邊盯著快照什麼時候出現。
	var treeAt time.Duration
	var roundAt time.Duration
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	deadline := time.After(60 * time.Second)
watch:
	for {
		select {
		case roundAt = <-roundDone:
			break watch
		case <-deadline:
			t.Fatalf("🔴 60 秒內這一輪還沒跑完（雲端每一發只有 400ms，這不該發生）")
		case <-poll.C:
			if treeAt == 0 {
				if _, err := os.Stat(treePath); err == nil {
					treeAt = time.Since(start)
				}
			}
		}
	}

	if treeAt == 0 {
		t.Fatalf("🔴 整輪跑完（%v）之前，folder-trees.json 一次都沒出現過——"+
			"畫面上的資料夾結構會一直停在上一版", roundAt)
	}
	t.Logf("樹落地於 %v／整輪跑完於 %v／雲端被打了 %d 次", treeAt, roundAt, atomic.LoadInt64(&hits))

	// 🔴 判準：樹要在**這一輪還早**的時候就落地，不是跟著整輪一起結束。
	// 用比例而不是絕對秒數——CI 機器快慢不同，但「排在雲端佇列前面」這個性質不變。
	if treeAt > roundAt/2 {
		t.Fatalf("🔴 樹落地於 %v，而整輪 %v——它還是排在雲端呼叫後面等。\n"+
			"本票第二輪的病就是這個：不是卡住，是這一輪還沒輪到寫它。", treeAt, roundAt)
	}

	// 內容也要對：使用者看到的節點數要等於地端真的有幾個資料夾。
	store, err := LoadFolderTreeStore(treePath)
	if err != nil {
		t.Fatalf("讀不回快照：%v", err)
	}
	tree, ok := store.Trees[root]
	if !ok {
		t.Fatalf("快照裡沒有這個根：%+v", store.Trees)
	}
	// 根 ＋ a b c d e a/a1 b/b1 ＝ 8
	if tree.TotalNodes != 8 || len(tree.Nodes) != 8 {
		t.Fatalf("🔴 節點數不對：TotalNodes=%d len(Nodes)=%d，want 8（根＋7 個子資料夾）",
			tree.TotalNodes, len(tree.Nodes))
	}
}

// 收工那一次的合併語意不准被「提早落地」破壞：
// 已經不看守的根，仍然要在整輪結束時被清掉（不然使用者移除了資料夾還看得到它）。
func TestEarlyPublishStillLetsTheFinalMergeDropUnwatchedRoots(t *testing.T) {
	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	var hits int64
	srv := slowButHealthyServer(t, time.Millisecond, &hits)

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "n.md"), []byte("# n\n內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), "m.json")
	treePath := FolderTreeStorePath(manifestPath)

	// 先塞一棵「已經不看守」的舊樹進快照。
	if err := SaveFolderTreeStore(treePath, FolderTreeStore{
		UpdatedAt: "2026-08-01T00:00:00Z",
		Trees:     map[string]FolderTree{"/已經移除的資料夾": sampleTree("/已經移除的資料夾", 1, 1)},
	}); err != nil {
		t.Fatal(err)
	}

	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{{CypherURL: srv.URL, Namespace: "n", APIKey: "k",
			WatchFolders: []string{root}}},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}
	RunDirectOnce(cfg, false)

	store, err := LoadFolderTreeStore(treePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, still := store.Trees["/已經移除的資料夾"]; still {
		t.Fatalf("🔴 已經不看守的根還留在快照裡——使用者移除完還看得到它：%+v", store.Trees)
	}
	if _, ok := store.Trees[root]; !ok {
		t.Fatalf("正在看守的那棵反而不見了：%+v", store.Trees)
	}
}
