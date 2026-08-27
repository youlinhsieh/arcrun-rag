// stallguard_test.go — 「一發卡住就整輪停擺」這個形狀的網（`inkstone/arcrun-rag#153`）。
//
// 🔴 這裡測的**不是**「逾時設多久」。把 300 秒調小照樣過不了這幾條，因為病不在
// 那個數字上：一個階段可以連續打二十發，每發都等到超時的話，上限設多小都會把
// 一輪拖垮。這幾條驗的是**執行模型**：
//
//	① 一個帳號的端點不回應 ⇒ 另一個帳號、另一個資料夾照樣跑完一輪（驗收條件①）
//	② 卡住的那一發要有話說：哪個帳號、哪件事、等了多久（驗收條件②）
//	③ 一輪跑完 folder-trees.json 真的被重寫（驗收條件③）——這是使用者眼中
//	   「畫面永遠停在上一版」的那一格
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stallTestTimings 把等待相關的旋鈕調成測試尺度，回傳復原函式。
// 調的是「等多久算久」，不是「有沒有上限」——上限的存在本身才是被測的東西。
func stallTestTimings(t *testing.T, budget, notice time.Duration) {
	t.Helper()
	oldPlain, oldLLM := stepIngestCard, stepIngestDoc
	oldRepair, oldTree, oldInv, oldCard := stepRepairOrigin, stepFolderTree, stepInventory, stepFolderCard
	oldExtract, oldTakedown, oldRetire := stepExtractDoc, stepTakedown, stepRetire
	oldProbe, oldAudit := stepProbeAI, stepCloudAudit
	oldNotice := stallNoticeEvery
	// 🔴 **每一個** step 都要調到——漏掉一個，那一個就是新的瓶頸。
	// 這不是測試的細節，是本票的形狀本身：2026-08-28 第一版就是這樣，斷路器
	// 明明跳了，一輪還是要 20 秒，因為漏掉了每輪第一發的探測。
	for _, s := range []*callStep{
		&stepIngestCard, &stepIngestDoc, &stepRepairOrigin, &stepFolderTree,
		&stepInventory, &stepFolderCard, &stepExtractDoc, &stepTakedown, &stepRetire,
		&stepProbeAI, &stepCloudAudit,
	} {
		s.Budget = budget
	}
	stallNoticeEvery = notice
	t.Cleanup(func() {
		stepIngestCard, stepIngestDoc = oldPlain, oldLLM
		stepRepairOrigin, stepFolderTree, stepInventory, stepFolderCard = oldRepair, oldTree, oldInv, oldCard
		stepExtractDoc, stepTakedown, stepRetire = oldExtract, oldTakedown, oldRetire
		stepProbeAI, stepCloudAudit = oldProbe, oldAudit
		stallNoticeEvery = oldNotice
	})
}

// 一個永遠不回應的知識庫（把請求放進黑洞，直到測試結束）。
func blackHoleServer(t *testing.T) *httptest.Server {
	t.Helper()
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-done:
		case <-r.Context().Done(): // 呼叫端自己放棄了＝正是我們要的行為
		}
	}))
	t.Cleanup(func() { close(done); srv.Close() })
	return srv
}

// 一個正常回應的知識庫，順便數它被打過幾次。
func countingServer(t *testing.T, hits *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ① 一個帳號的端點不回應，另一個帳號照樣跑完一輪；而且整輪的時間有上限。
//
// 沒有這道閘之前的行為：第一個帳號的第一發 POST 停在那裡不回來，
// 第二個帳號一次都不會被碰到，folder-trees.json 也永遠不會被重寫。
func TestOneDeadAccountDoesNotStopTheRound(t *testing.T) {
	stallTestTimings(t, 300*time.Millisecond, 50*time.Millisecond)

	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	dead := blackHoleServer(t)
	liveHits := 0
	live := countingServer(t, &liveHits)

	deadRoot, liveRoot := t.TempDir(), t.TempDir()
	for _, r := range []string{deadRoot, liveRoot} {
		if err := os.WriteFile(filepath.Join(r, "note.md"), []byte("# 一份筆記\n內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{
			{CypherURL: dead.URL, Namespace: "dead", APIKey: "k", WatchFolders: []string{deadRoot}},
			{CypherURL: live.URL, Namespace: "live", APIKey: "k", WatchFolders: []string{liveRoot}},
		},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		// 萃取那條路不是這條測試的題目：這裡驗的是「不回應的端點會不會把整輪鎖住」。
		// 空 Extractor＝走原文直送（rag_ingest_direct），一樣是打同一批端點。
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}

	start := time.Now()
	results, _, _ := RunDirectOnce(cfg, false)
	elapsed := time.Since(start)

	// 🔴 核心：一輪要跑得完，而且時間跟「壞掉的那個帳號有幾件事要做」無關。
	// 上限抓得寬（真實情境下每發 300ms × 斷路器 2 次 ＋ 活著那邊的工作），
	// 但遠小於「每一發都各等一次」的量級——沒有斷路器時這裡會是好幾秒起跳。
	if elapsed > 5*time.Second {
		t.Fatalf("🔴 一輪花了 %v——一發等不到回覆就把整輪拖住了，正是本票要修的形狀", elapsed)
	}

	// 活著的那個帳號真的被服務到了（不是「兩個都被跳過所以很快」）。
	if liveHits == 0 {
		t.Fatalf("🔴 活著的帳號一次都沒被打到——壞掉的那個把整輪吃光了\nresults=%+v", results)
	}

	// 斷路器要真的跳過：同一個帳號不該被逐檔、逐階段各等一次。
	stalls := cfg.guard.Stalls()
	if len(stalls) == 0 {
		t.Fatalf("🔴 等了那麼久卻一句話都沒說——使用者會看到「開著、沒錯誤、不動」")
	}
	tripped := false
	for _, s := range stalls {
		if s.Skipped {
			tripped = true
		}
	}
	if !tripped {
		t.Fatalf("🔴 沒有任何一筆標成「這一輪跳過這個帳號」，斷路器沒生效：%+v", stalls)
	}
	if len(stalls) > 4 {
		t.Fatalf("🔴 等了 %d 次才停手——斷路器該在 %d 次就跳，不然一輪還是會被拖垮：%+v",
			len(stalls), stallStrikesBeforeSkip, stalls)
	}
}

// ② 卡住的那一發要講得出「哪個帳號、哪件事、等了多久」。
func TestStallSaysWhichAccountWhichStepHowLong(t *testing.T) {
	stallTestTimings(t, 300*time.Millisecond, 50*time.Millisecond)

	dead := blackHoleServer(t)
	// 🔴 播報會從**兩條** goroutine 進來（等待期間那條、以及記帳時呼叫端那條），
	// 所以收集它的地方自己要上鎖——這不是測試的潔癖，是 -race 抓出來的真實併發。
	var mu sync.Mutex
	var said []StalledCall
	g := newRoundGuard()
	g.announce = func(s StalledCall) { mu.Lock(); said = append(said, s); mu.Unlock() }

	cfg := &DirectConfig{CypherURL: dead.URL, Namespace: "n", APIKey: "k", guard: g}
	_, _, err := cfg.postJSON(stepRepairOrigin, dead.URL+"/x", map[string]any{"a": 1})
	if err == nil {
		t.Fatal("端點不回應卻回了 nil error")
	}

	// 播報：等待期間就要開口，不是等到最後才說。
	mu.Lock()
	saidCount := len(said)
	mu.Unlock()
	if saidCount == 0 {
		t.Fatal("🔴 等待期間一句話都沒播——靜默的等待跟當掉對使用者是同一件事")
	}
	host := instanceHostOf(dead.URL)
	mu.Lock()
	snapshot := append([]StalledCall(nil), said...)
	mu.Unlock()
	for _, s := range snapshot {
		if s.Account != host {
			t.Fatalf("沒講是哪個帳號：%+v（want %s）", s, host)
		}
		if s.Step != stepRepairOrigin.Name {
			t.Fatalf("沒講是哪件事：%+v（want %s）", s, stepRepairOrigin.Name)
		}
	}
	// 交給呼叫端的錯誤是產品文案：講哪件事、等多久、他會怎樣，不出現狀態碼／內部名詞。
	msg := err.Error()
	if !strings.Contains(msg, stepRepairOrigin.Name) {
		t.Fatalf("錯誤訊息沒講是哪件事：%s", msg)
	}
	// 🔴 不再寫死「會自動恢復」這幾個字——改用產生端與消費端**共用**的那個判準。
	// 寫死字串正是第三輪的病：我改了措辭，兩邊就對不上了（見 explainsWhySkipped）。
	if !explainsWhySkipped(msg) {
		t.Fatalf("🔴 這句話不會被 status.json 收進失敗清單 ⇒ 畫面上會沒有原因：%s", msg)
	}
	for _, banned := range []string{"context deadline", "HTTP", "timeout", "Client.Timeout"} {
		if strings.Contains(msg, banned) {
			t.Fatalf("🔴 錯誤訊息漏出內部語彙「%s」：%s", banned, msg)
		}
	}
}

// ②之二：等太久的事要寫進 status.json，畫面才有東西可以講。
func TestStallsLandInStatusJSON(t *testing.T) {
	stallTestTimings(t, 200*time.Millisecond, 50*time.Millisecond)

	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	dead := blackHoleServer(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("# 一份筆記\n內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{{CypherURL: dead.URL, Namespace: "n", APIKey: "k",
			WatchFolders: []string{root}}},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}
	RunDirectOnce(cfg, false)

	st, err := LoadSyncStatus(StatusFilePath(manifestPath))
	if err != nil {
		t.Fatalf("讀 status.json 失敗：%v", err)
	}
	if len(st.Stalls) == 0 {
		t.Fatal("🔴 status.json 沒有 stalls——畫面上就只剩「開著、沒錯誤、什麼都不動」")
	}
	s := st.Stalls[0]
	if s.Account == "" || s.Step == "" || s.Note == "" {
		t.Fatalf("三件事要講齊（哪個帳號／哪件事／人話）：%+v", s)
	}
}

// ③ 一輪跑完，folder-trees.json 真的被重寫——即使雲端那邊完全不回應。
//
// 這一格就是使用者實際撞到的症狀：畫面上的資料夾結構永遠停在上一版。
// 樹是**本機算出來的**，不該因為送不上雲端就連本機那份都不寫。
func TestFolderTreeStoreRewrittenEvenWhenCloudNeverAnswers(t *testing.T) {
	stallTestTimings(t, 200*time.Millisecond, 50*time.Millisecond)

	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	dead := blackHoleServer(t)
	root := t.TempDir()
	for _, d := range []string{"a", "b", "c"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, d, "n.md"), []byte("# n\n內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{{CypherURL: dead.URL, Namespace: "n", APIKey: "k",
			WatchFolders: []string{root}}},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}
	RunDirectOnce(cfg, false)

	treePath := FolderTreeStorePath(manifestPath)
	store, err := LoadFolderTreeStore(treePath)
	if err != nil {
		t.Fatalf("🔴 一輪跑完卻沒有 folder-trees.json：%v", err)
	}
	tree, ok := store.Trees[root]
	if !ok {
		t.Fatalf("快照裡沒有這個根：%+v", store.Trees)
	}
	if len(tree.Nodes) < 4 { // 根 + a/b/c
		t.Fatalf("🔴 樹只有 %d 個節點（該有根＋三個子資料夾）：%+v", len(tree.Nodes), tree.Nodes)
	}

	// 再跑一輪，mtime 要往前走——「畫面永遠停在上一版」的反面就是這一格。
	before, err := os.Stat(treePath)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	RunDirectOnce(cfg, false)
	after, err := os.Stat(treePath)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().After(before.ModTime()) {
		t.Fatalf("🔴 第二輪沒有重寫 folder-trees.json（%v → %v）", before.ModTime(), after.ModTime())
	}
}

// 連線被拒（很快就回來的錯）不該被當成「等太久」——
// 把它記進斷路器的話，正常的斷網會讓帳號被誤判成沒有回應。
func TestFastFailureIsNotCountedAsStall(t *testing.T) {
	stallTestTimings(t, 2*time.Second, 50*time.Millisecond)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // 關掉 ⇒ 連線立刻被拒

	g := newRoundGuard()
	g.announce = func(StalledCall) {}
	cfg := &DirectConfig{CypherURL: url, Namespace: "n", APIKey: "k", guard: g}
	if _, _, err := cfg.postJSON(stepIngestCard, url+"/x", map[string]any{}); err == nil {
		t.Fatal("連不上卻回 nil error")
	}
	if len(g.Stalls()) != 0 {
		t.Fatalf("🔴 立刻失敗被記成「等太久」：%+v", g.Stalls())
	}
	if g.skipReason(instanceHostOf(url)) != "" {
		t.Fatal("🔴 一次連線被拒就把整個帳號停掉了——那是把斷網懲罰成停機")
	}
}

// 沒裝 guard（低層函式被單獨呼叫）時仍然要有上限——
// 「沒裝閘」不可以等於「沒有上限」，那是這條線最初出事的樣子。
func TestGateAlwaysHasADeadlineEvenWithoutGuard(t *testing.T) {
	stallTestTimings(t, 200*time.Millisecond, 50*time.Millisecond)

	dead := blackHoleServer(t)
	cfg := &DirectConfig{CypherURL: dead.URL, Namespace: "n", APIKey: "k"} // guard == nil
	start := time.Now()
	_, _, err := cfg.postJSON(stepIngestCard, dead.URL+"/x", map[string]any{})
	if err == nil {
		t.Fatal("端點不回應卻回了 nil error")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("🔴 沒有 guard 就沒有上限了（等了 %v）", el)
	}
}

// 🔴 慢但**成功**的雲端，不准被講成「沒有回應」，也不准害後面的檔被跳過。
//
// 這一條是 2026-08-28 第三輪的實撞：`送出一份筆記` 實測 33〜57 秒，而我第一輪
// 憑「零 LLM 應該很快」的**推論**給了 60 秒上限 ⇒ 尾巴被剪斷 2 發 ⇒ 斷路器跳 ⇒
// **後面 9 個檔全被跳過**，畫面還對使用者說「知識庫現在沒有回應」。
// 那台知識庫一路都在回應（同一輪成功送出 8 份筆記），只是慢。
func TestSlowButSucceedingCloudIsNotCalledUnresponsive(t *testing.T) {
	// 上限給 2 秒，伺服器每發 300ms——**遠低於上限**，就是「慢但會成功」。
	stallTestTimings(t, 2*time.Second, 50*time.Millisecond)

	origFetch := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = origFetch }()

	var hits int64
	slow := slowButHealthyServer(t, 300*time.Millisecond, &hits)

	root := t.TempDir()
	for i := range [8]struct{}{} {
		name := filepath.Join(root, "note"+string(rune('a'+i))+".md")
		if err := os.WriteFile(name, []byte("# 筆記\n內容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifestPath := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{{CypherURL: slow.URL, Namespace: "n", APIKey: "k",
			WatchFolders: []string{root}}},
		Library: "kb", MaxRemoved: DefaultMaxRemovedRatio,
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		ForceSync: true,
	}
	results, _, _ := RunDirectOnce(cfg, false)

	// ① 斷路器不准跳：它一路都在回應。
	if note := cfg.unreachableNote(); note != "" {
		t.Fatalf("🔴 慢但成功的雲端被判成不能打了：%s", note)
	}
	for _, s := range cfg.guard.Stalls() {
		if s.Skipped {
			t.Fatalf("🔴 有一筆標成「這一輪跳過該帳號」：%+v", s)
		}
	}

	// ② 一個檔都不准被「帳號沒回應」這個理由跳過。
	skipped := 0
	for _, r := range results {
		if r.Status == "skipped" && (strings.Contains(r.Error, "沒有回應") ||
			strings.Contains(r.Error, "回得太慢")) {
			skipped++
		}
	}
	if skipped > 0 {
		t.Fatalf("🔴 有 %d 個檔因為「帳號沒回應」被跳過，但雲端每一發都成功了", skipped)
	}

	// ③ 就算真的有一發逾時，只要它這一輪回應過，措辭就不准是「沒有回應」。
	g := newRoundGuard()
	g.announce = func(StalledCall) {}
	g.succeeded("h")
	msg := g.strike("h", stepIngestCard, 3*time.Second)
	if strings.Contains(msg, "沒有回應") {
		t.Fatalf("🔴 它回應過，卻還是說「沒有回應」：%s", msg)
	}
	if !strings.Contains(msg, "回得太慢") {
		t.Fatalf("措辭應該是「回得太慢」：%s", msg)
	}
}

// 「連續」兩個字必須是真的：成功一次就把計數歸零。
func TestStrikesAreActuallyConsecutive(t *testing.T) {
	g := newRoundGuard()
	g.announce = func(StalledCall) {}
	g.strike("h", stepIngestCard, time.Second) // 第 1 次逾時
	g.succeeded("h")                           // 中間成功了一次
	g.strike("h", stepIngestCard, time.Second) // 又逾時一次 ⇒ 這是「第 1 次連續」
	if r := g.skipReason("h"); r != "" {
		t.Fatalf("🔴 中間成功過，卻仍然跳閘了——訊息裡的「連續」是假的：%s", r)
	}
	g.strike("h", stepIngestCard, time.Second) // 真的連續第 2 次 ⇒ 才該跳
	if g.skipReason("h") == "" {
		t.Fatal("真的連續兩次逾時了，該跳閘卻沒跳")
	}
}
