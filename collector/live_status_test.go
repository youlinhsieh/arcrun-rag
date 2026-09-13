package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestStatusAndTreeMoveWhileRoundIsStillRunning 守住 `inkstone/arcrun-rag#200` 的主病：
// **一輪還沒跑完，畫面看的兩份檔就要反映已經送上去的份數。**
//
// 2026-09-13 實撞：ISEP 送上雲端 11 份，status.json 從 12:00 起沒寫過、
// folder-trees.json 的 synced 全是 0 ⇒ 畫面每層 0 / N。
//
// 驗法：假雲端在收到**第二份**筆記時（第一份已經送完、這一輪還在跑），
// 直接去讀磁碟上的 status.json 與 folder-trees.json——那就是小幫手此刻讀得到的東西。
func TestStatusAndTreeMoveWhileRoundIsStillRunning(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(root, n+".md"), []byte("# 原稿 "+n+" 內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	nameRe := regexp.MustCompile(`檔名：([^）]+)）`)
	restoreGemma := gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		name := "a"
		if m := nameRe.FindStringSubmatch(string(body)); m != nil {
			name = m[1]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture(name, "測試")}}},
			}},
		})
	})
	defer restoreGemma()

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	statusPath := StatusFilePath(manifestPath)
	treePath := FolderTreeStorePath(manifestPath)

	var mu sync.Mutex
	cards := 0
	var midStatus SyncStatus
	var midStatusErr error
	var midTree FolderTreeStore
	// 只數**這三份檔自己的**筆記：資料夾總覽卡、目錄索引卡也走同一條收卡路，
	// 而且排在逐檔之前送——數到它們就會在第一份檔都還沒送時拍照。
	docCard := regexp.MustCompile(`"path":"[abc]\.md"`)
	cypher := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), `"card_content"`) && docCard.Match(body) {
			mu.Lock()
			cards++
			if cards == 2 {
				midStatus, midStatusErr = LoadSyncStatus(statusPath)
				midTree, _ = LoadFolderTreeStore(treePath)
			}
			mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer cypher.Close()

	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifestPath,
		CypherURL:    cypher.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, _, _ := RunDirectOnce(cfg, false)

	mu.Lock()
	defer mu.Unlock()
	if cards < 3 {
		t.Fatalf("三份都應該送上去，實際收到 %d 張卡：results=%+v", cards, results)
	}

	// ── 一輪途中（第一份已送完）──
	if midStatusErr != nil {
		t.Fatalf("🔴 一輪途中讀不到 status.json：%v", midStatusErr)
	}
	if midStatus.InRound == nil {
		t.Fatalf("🔴 一輪途中 status.json 沒有 in_round——畫面講不出做到哪")
	}
	if got := midStatus.InRound.Ingested; got != 1 {
		t.Errorf("一輪途中 in_round.ingested 應為 1（第一份已送完），got %d", got)
	}
	if midStatus.InRound.Folder != root {
		t.Errorf("in_round.folder 應為 %q，got %q", root, midStatus.InRound.Folder)
	}
	if midStatus.InRound.Step != stepIngestCard.Name {
		t.Errorf("正在送第二份時 in_round.step 應為 %q，got %q", stepIngestCard.Name, midStatus.InRound.Step)
	}
	if got := midStatus.FolderProgress[root].Done; got != 1 {
		t.Errorf("🔴 一輪途中 folder_progress 的已同步應為 1，got %d（%+v）", got, midStatus.FolderProgress[root])
	}
	if got := midStatus.Progress.Done; got != 1 {
		t.Errorf("一輪途中首頁總量的已送上去應為 1，got %d", got)
	}
	if got := treeSynced(midTree, root); got != 1 {
		t.Errorf("🔴 一輪途中 folder-trees.json 的已同步應為 1（這就是 leo 看到 0 / N 的那個數字），got %d", got)
	}

	// ── 收工之後 ──
	st, err := LoadSyncStatus(statusPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.InRound != nil {
		t.Errorf("收工之後 in_round 應該消失，got %+v", st.InRound)
	}
	if got := st.FolderProgress[root].Done; got != 3 {
		t.Errorf("收工之後已同步應為 3，got %d", got)
	}
	final, err := LoadFolderTreeStore(treePath)
	if err != nil {
		t.Fatal(err)
	}
	// 🔴 以前收工合併用的是開工前那棵樹 ⇒ 就算整輪跑完，這裡也還是 0。
	if got := treeSynced(final, root); got != 3 {
		t.Errorf("🔴 收工之後 folder-trees.json 的已同步應為 3，got %d（收工合併還在用開工前那棵樹）", got)
	}
}

func treeSynced(s FolderTreeStore, root string) int {
	t, ok := s.Trees[root]
	if !ok {
		return -1
	}
	n := 0
	for _, node := range t.Nodes {
		n += node.SyncedFiles
	}
	return n
}

// TestWaitingIsWrittenWhileStillWaiting 守住驗收條件③「卡住時寫得出原因」：
// 「還在等」以前只印到 stdout（collector.log），status.json 一個字都沒有。
func TestWaitingIsWrittenWhileStillWaiting(t *testing.T) {
	origNotice := stallNoticeEvery
	stallNoticeEvery = 30 * time.Millisecond
	defer func() { stallNoticeEvery = origNotice }()

	path := filepath.Join(t.TempDir(), "status.json")
	g := newRoundGuard()
	g.announce = nil
	g.beginRound(path, time.Now())
	g.enterFolder("kb.example", "/Users/someone/ISEP")

	cfg := &DirectConfig{CypherURL: "https://kb.example", guard: g}
	gate := cfg.openGate(stepFolderCard)

	var st SyncStatus
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st, _ = LoadSyncStatus(path)
		if st.InRound != nil && st.InRound.Waiting != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st.InRound == nil || st.InRound.Waiting == nil {
		gate.release()
		t.Fatalf("🔴 等了一陣子，status.json 仍沒有寫出「卡在哪一步」：%+v", st.InRound)
	}
	if st.InRound.Waiting.Step != stepFolderCard.Name {
		t.Errorf("waiting.step 應為 %q，got %q", stepFolderCard.Name, st.InRound.Waiting.Step)
	}
	if st.InRound.Folder != "/Users/someone/ISEP" || st.InRound.Account != "kb.example" {
		t.Errorf("卡住時要講得出是哪個知識庫的哪個資料夾，got account=%q folder=%q",
			st.InRound.Account, st.InRound.Folder)
	}

	gate.release()
	st, _ = LoadSyncStatus(path)
	if st.InRound == nil || st.InRound.Waiting != nil {
		t.Errorf("那件事回來之後「還在等」要拿掉，got %+v", st.InRound)
	}

	// 收工封口：晚到的「還在等」不准把收工寫好的那份蓋回「同步中」。
	g.finishRound()
	if err := SaveSyncStatus(path, SyncStatus{LastSync: "2026-09-14T00:00:00+08:00"}); err != nil {
		t.Fatal(err)
	}
	g.noteWaiting(StalledCall{Step: "晚到的", Note: "晚到的"})
	st, _ = LoadSyncStatus(path)
	if st.InRound != nil {
		t.Errorf("🔴 收工之後的途中寫入把 in_round 寫回去了：%+v", st.InRound)
	}
}

// TestLiveWriteNeverWipesUnreadableStatus：狀態檔讀得到卻解不開時，途中寫入一律不動它
// ——拿零值改一格再寫回去，等於把上一輪所有的數字整份抹掉。
func TestLiveWriteNeverWipesUnreadableStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "status.json")
	garbage := []byte("{ 這不是 JSON")
	if err := os.WriteFile(path, garbage, 0o644); err != nil {
		t.Fatal(err)
	}
	g := newRoundGuard()
	g.announce = nil
	g.beginRound(path, time.Now())
	g.fileFinished("/x", "ingested", SyncProgress{Total: 1, Done: 1})
	got, _ := os.ReadFile(path)
	if string(got) != string(garbage) {
		t.Errorf("解不開的狀態檔被覆寫了：%q", got)
	}
}
