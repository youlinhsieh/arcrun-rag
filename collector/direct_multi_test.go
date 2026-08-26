// direct_multi_test.go — daemon-beta task 1 多資料夾 config（單數相容／manifest 分根／多根掃描）。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDirectConfig(t *testing.T, dir string, cfg map[string]any) string {
	t.Helper()
	data, _ := json.Marshal(cfg)
	p := filepath.Join(dir, "config.json")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// 單數舊制照舊可載入；Folders() 正規化＝一根。
// t86b：單根也分實例，manifest 路徑含 instanceHost 尾碼，不再沿用 cfg.Manifest 原名。
func TestLoadDirectConfigSingularCompat(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"watch_folder": "/tmp/kb", "manifest": filepath.Join(dir, "m.json"),
		"cypher_url": "https://x.example", "namespace": "demo",
	})
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Folders(); len(got) != 1 || got[0] != "/tmp/kb" {
		t.Fatalf("Folders()=%v", got)
	}
	// t86b：單根也含實例尾碼，不再沿用裸 cfg.Manifest
	mp := c.manifestPathFor("/tmp/kb")
	if mp == c.Manifest {
		t.Fatalf("t86b：單根 manifest 應含實例尾碼，不應沿用 cfg.Manifest 原路徑，got %s", mp)
	}
	// 穩定性：同路徑同 config 重算一致
	if mp != c.manifestPathFor("/tmp/kb") {
		t.Fatal("manifestPathFor 應穩定")
	}
}

// 只填 watch_folders 也合法；單數與清單並存時去重保序。
func TestLoadDirectConfigMulti(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"watch_folder": "/tmp/a", "watch_folders": []string{"/tmp/b", "/tmp/a", "/tmp/c"},
		"manifest":   filepath.Join(dir, "m.json"),
		"cypher_url": "https://x.example", "namespace": "demo",
	})
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	got := c.Folders()
	want := []string{"/tmp/a", "/tmp/b", "/tmp/c"}
	if len(got) != len(want) {
		t.Fatalf("Folders()=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Folders()[%d]=%s want %s", i, got[i], want[i])
		}
	}
	// 多根＝每根 manifest 各一份、彼此不同、且尾碼對同一路徑穩定
	m1 := c.manifestPathFor("/tmp/a")
	m2 := c.manifestPathFor("/tmp/b")
	if m1 == m2 || m1 == c.Manifest {
		t.Fatalf("多根 manifest 應分根：%s vs %s", m1, m2)
	}
	if m1 != c.manifestPathFor("/tmp/a") {
		t.Fatal("同路徑尾碼應穩定")
	}
}

// t104：cypher_url 有值但無 watch_folders → 合法（遷移後空帳號，等待用戶加資料夾）。
// 真正缺必填：無 accounts 且無 cypher_url。
func TestLoadDirectConfigMissingFolders(t *testing.T) {
	dir := t.TempDir()
	// 有 cypher_url 無 watch_folders → 合法
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest": filepath.Join(dir, "m.json"), "cypher_url": "https://x.example", "namespace": "demo",
	})
	if _, err := LoadDirectConfig(p); err != nil {
		t.Fatalf("t104: 有 cypher_url 無 watch_folders 應合法，got: %v", err)
	}
	// 無 cypher_url 無 accounts → 缺必填
	p2 := writeDirectConfig(t, dir, map[string]any{
		"manifest": filepath.Join(dir, "m.json"),
	})
	if _, err := LoadDirectConfig(p2); err == nil {
		t.Fatal("無帳號且無 cypher_url 時應報缺必填")
	}
}

// 多根 dry-run：各根的檔案都被掃到、事件標 Root、manifest 各自獨立。
func TestRunDirectOnceMultiRootDryRun(t *testing.T) {
	base := t.TempDir()
	rootA := filepath.Join(base, "rootA")
	rootB := filepath.Join(base, "rootB")
	for _, d := range []string{rootA, rootB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootA, "a.md"), []byte("# A"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "b.md"), []byte("# B"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &DirectConfig{
		WatchFolders: []string{rootA, rootB},
		Manifest:     filepath.Join(base, "manifest.json"),
		CypherURL:    "https://x.example", Namespace: "demo",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, true)
	if exit != 0 {
		t.Fatalf("dry-run 不應失敗：%+v", results)
	}
	byRoot := map[string][]string{}
	for _, r := range results {
		if r.Status != "planned" {
			t.Fatalf("dry-run 事件應為 planned：%+v", r)
		}
		if r.Type == "inventory" || r.Type == "folder_tree" {
			// 每根各有一張總覽卡與一棵資料夾樹（都是 planned），檔案事件另計。
			// 兩者都不是檔案事件：一個是結構先行的知識卡，一個是 portal 畫面的樹。
			continue
		}
		byRoot[r.Root] = append(byRoot[r.Root], r.Path)
	}
	if len(byRoot[rootA]) != 1 || byRoot[rootA][0] != "a.md" {
		t.Fatalf("rootA 事件錯：%v", byRoot[rootA])
	}
	if len(byRoot[rootB]) != 1 || byRoot[rootB][0] != "b.md" {
		t.Fatalf("rootB 事件錯：%v", byRoot[rootB])
	}
}

// t39：config 的 `~/` 由 daemon 端展開——安裝器成功頁下載的 config.json 用
// `~/.arcrun-rag/manifest.json` 這種人看的寫法，Go 不展開波浪號＝會去找字面上叫 "~" 的資料夾。
func TestLoadDirectConfigExpandsHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("拿不到家目錄，跳過")
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	body := `{
  "watch_folders": ["~/Documents/知識庫", "/tmp/絕對路徑不動"],
  "manifest": "~/.arcrun-rag/manifest.json",
  "cypher_url": "https://cypher.example.workers.dev",
  "namespace": "ns1"
}`
	if err := os.WriteFile(cfgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadDirectConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	wantManifest := filepath.Join(home, ".arcrun-rag/manifest.json")
	if cfg.Manifest != wantManifest {
		t.Errorf("manifest 未展開：got %q want %q", cfg.Manifest, wantManifest)
	}
	folders := cfg.Folders()
	wantFolder := filepath.Join(home, "Documents/知識庫")
	if folders[0] != wantFolder {
		t.Errorf("watch_folders[0] 未展開：got %q want %q", folders[0], wantFolder)
	}
	if folders[1] != "/tmp/絕對路徑不動" {
		t.Errorf("絕對路徑不該被動：got %q", folders[1])
	}
}

// ── t86b：manifest 分實例 ────────────────────────────────────────────────────

// ① 同資料夾、不同 instanceHost → 不同 manifest 路徑。
func TestManifestPathDifferentInstances(t *testing.T) {
	dir := t.TempDir()
	cfgA := &DirectConfig{
		WatchFolder: "/tmp/kb",
		Manifest:    filepath.Join(dir, "m.json"),
		CypherURL:   "https://instanceA.example.workers.dev",
		Namespace:   "demo",
	}
	cfgB := &DirectConfig{
		WatchFolder: "/tmp/kb",
		Manifest:    filepath.Join(dir, "m.json"),
		CypherURL:   "https://instanceB.example.workers.dev",
		Namespace:   "demo",
	}
	pA := cfgA.manifestPathFor("/tmp/kb")
	pB := cfgB.manifestPathFor("/tmp/kb")
	if pA == pB {
		t.Fatalf("① 不同實例相同資料夾應產生不同 manifest 路徑，got same: %s", pA)
	}
}

// ② 同 instance 同夾路徑 → 穩定且含尾碼。
func TestManifestPathStable(t *testing.T) {
	dir := t.TempDir()
	cfg := &DirectConfig{
		WatchFolder: "/tmp/kb",
		Manifest:    filepath.Join(dir, "m.json"),
		CypherURL:   "https://instance.workers.dev",
		Namespace:   "demo",
	}
	p1 := cfg.manifestPathFor("/tmp/kb")
	p2 := cfg.manifestPathFor("/tmp/kb")
	if p1 != p2 {
		t.Fatalf("② 相同 instance+路徑應穩定，got %s vs %s", p1, p2)
	}
	if p1 == cfg.Manifest {
		t.Fatal("② manifestPathFor 應含實例尾碼，不應沿用 cfg.Manifest 原路徑")
	}
}

// ③ 遷移：舊單根名（cfg.Manifest）存在、新名不存在 → rename 後讀得到既有 entries。
func TestManifestMigrateSingleRoot(t *testing.T) {
	dir := t.TempDir()
	cfg := &DirectConfig{
		WatchFolder: dir,
		Manifest:    filepath.Join(dir, "manifest.json"),
		CypherURL:   "https://instance.workers.dev",
		Namespace:   "demo",
		MaxRemoved:  DefaultMaxRemovedRatio,
	}
	absRoot, _ := filepath.Abs(dir)

	// 在舊路徑（cfg.Manifest）寫一份有資料的 manifest
	old := &Manifest{
		FolderID: "old-folder-id",
		Root:     absRoot,
		Entries:  map[string]*ManifestEntry{"doc.md": {ContentHash: "sha256:aabb", IngestedHash: "sha256:aabb", Size: 42}},
	}
	if err := old.Save(cfg.Manifest); err != nil {
		t.Fatal(err)
	}

	newPath := cfg.manifestPathFor(absRoot)
	if newPath == cfg.Manifest {
		t.Fatal("前提失效：新路徑應與舊路徑不同")
	}
	if _, err := os.Stat(newPath); err == nil {
		t.Fatal("新路徑不應已存在")
	}

	cfg.migrateManifestIfNeeded(absRoot, newPath)

	if _, err := os.Stat(cfg.Manifest); err == nil {
		t.Fatal("③ 遷移後舊路徑應已消失")
	}
	m, err := LoadManifest(newPath, absRoot)
	if err != nil {
		t.Fatalf("③ 遷移後讀取新路徑失敗：%v", err)
	}
	if _, ok := m.Entries["doc.md"]; !ok {
		t.Fatal("③ 遷移後 entries 應完整保留")
	}
}

// ③ 遷移：舊多根名（sha256(absRoot only)）存在 → rename 到新路徑（sha256(host+absRoot)）。
func TestManifestMigrateMultiRootOldFormula(t *testing.T) {
	dir := t.TempDir()
	cfg := &DirectConfig{
		WatchFolders: []string{dir},
		Manifest:     filepath.Join(dir, "manifest.json"),
		CypherURL:    "https://instance.workers.dev",
		Namespace:    "demo",
		MaxRemoved:   DefaultMaxRemovedRatio,
	}
	absRoot, _ := filepath.Abs(dir)

	// 計算舊多根路徑（只含路徑雜湊，無 instanceHost）
	sum := sha256.Sum256([]byte(absRoot))
	ext := filepath.Ext(cfg.Manifest)
	oldMultiPath := strings.TrimSuffix(cfg.Manifest, ext) + "-" + hex.EncodeToString(sum[:4]) + ext

	old := &Manifest{
		FolderID: "multi-old-id",
		Root:     absRoot,
		Entries:  map[string]*ManifestEntry{"wiki.md": {ContentHash: "sha256:cc00"}},
	}
	if err := old.Save(oldMultiPath); err != nil {
		t.Fatal(err)
	}

	newPath := cfg.manifestPathFor(absRoot)
	if newPath == oldMultiPath {
		t.Fatal("前提失效：新路徑應與舊多根路徑不同（instanceHost 加進去了）")
	}

	cfg.migrateManifestIfNeeded(absRoot, newPath)

	if _, err := os.Stat(oldMultiPath); err == nil {
		t.Fatal("③ 多根遷移後舊路徑應已消失")
	}
	m, err := LoadManifest(newPath, absRoot)
	if err != nil {
		t.Fatalf("③ 多根遷移後讀取失敗：%v", err)
	}
	if _, ok := m.Entries["wiki.md"]; !ok {
		t.Fatal("③ 多根遷移後 entries 應保留")
	}
}

// ④ 冪等：新名已存在 → 再跑 migrateManifestIfNeeded 不覆蓋新名內容。
func TestManifestMigrateIdempotent(t *testing.T) {
	dir := t.TempDir()
	cfg := &DirectConfig{
		WatchFolder: dir,
		Manifest:    filepath.Join(dir, "manifest.json"),
		CypherURL:   "https://instance.workers.dev",
		Namespace:   "demo",
		MaxRemoved:  DefaultMaxRemovedRatio,
	}
	absRoot, _ := filepath.Abs(dir)
	newPath := cfg.manifestPathFor(absRoot)

	// 直接在新路徑寫一份 manifest
	fresh := &Manifest{
		FolderID: "fresh-id",
		Root:     absRoot,
		Entries:  map[string]*ManifestEntry{"keep.md": {ContentHash: "sha256:dd11"}},
	}
	if err := fresh.Save(newPath); err != nil {
		t.Fatal(err)
	}

	// 也在舊路徑留一份（確認冪等時不被搬來蓋掉新名）
	stale := &Manifest{
		FolderID: "stale-id",
		Root:     absRoot,
		Entries:  map[string]*ManifestEntry{"old.md": {ContentHash: "sha256:ee22"}},
	}
	if err := stale.Save(cfg.Manifest); err != nil {
		t.Fatal(err)
	}

	// 跑兩次
	cfg.migrateManifestIfNeeded(absRoot, newPath)
	cfg.migrateManifestIfNeeded(absRoot, newPath)

	m, err := LoadManifest(newPath, absRoot)
	if err != nil {
		t.Fatalf("④ 冪等後讀取失敗：%v", err)
	}
	if _, ok := m.Entries["keep.md"]; !ok {
		t.Fatal("④ 冪等後新路徑內容不應被蓋掉")
	}
	if _, ok := m.Entries["old.md"]; ok {
		t.Fatal("④ 冪等後新路徑不應出現舊路徑的 entries")
	}
}

// ── t104：多帳號同時看守 ──────────────────────────────────────────────────────────

// ①遷移：舊格式（頂層 cypher_url + watch_folders）→ LoadDirectConfig → accounts[0]。
func TestMigrateOldConfigToAccounts(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"watch_folders": []string{"/tmp/a", "/tmp/b"},
		"manifest":      filepath.Join(dir, "m.json"),
		"cypher_url":    "https://instance.example.workers.dev",
		"namespace":     "ns1",
		"email":         "user@example.com",
		"instance_name": "My Library",
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if len(cfg.Accounts) != 1 {
		t.Fatalf("① 應自動建 accounts[0]，got %d accounts", len(cfg.Accounts))
	}
	acc := cfg.Accounts[0]
	if acc.CypherURL != "https://instance.example.workers.dev" {
		t.Errorf("accounts[0].cypher_url 錯：%s", acc.CypherURL)
	}
	if acc.Namespace != "ns1" {
		t.Errorf("accounts[0].namespace 錯：%s", acc.Namespace)
	}
	if acc.Email != "user@example.com" {
		t.Errorf("accounts[0].email 錯：%s", acc.Email)
	}
	if acc.InstanceName != "My Library" {
		t.Errorf("accounts[0].instance_name 錯：%s", acc.InstanceName)
	}
	if len(acc.WatchFolders) != 2 {
		t.Errorf("accounts[0].watch_folders 應含 2 根，got %v", acc.WatchFolders)
	}
}

// ①冪等：已有 accounts 時不再遷移（accounts 數量不增加）。
func TestMigrateAlreadyHasAccountsIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"accounts": []map[string]any{
			{"cypher_url": "https://a.example", "namespace": "nsA", "watch_folders": []string{"/tmp/a"}},
			{"cypher_url": "https://b.example", "namespace": "nsB", "watch_folders": []string{"/tmp/b"}},
		},
		"manifest": filepath.Join(dir, "m.json"),
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if len(cfg.Accounts) != 2 {
		t.Fatalf("① 已有 2 個 accounts 時不應再新增，got %d", len(cfg.Accounts))
	}
}

// ②雙帳號同輪同步互不干擾：各帳號事件打到各自的 fake server，結果標正確的 Account host。
func TestRunDirectOnceMultiAccount(t *testing.T) {
	var serverACalled, serverBCalled int
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverACalled++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer serverA.Close()
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverBCalled++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer serverB.Close()

	base := t.TempDir()
	rootA := filepath.Join(base, "rootA")
	rootB := filepath.Join(base, "rootB")
	for _, d := range []string{rootA, rootB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootA, "a.md"), []byte("# A"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "b.md"), []byte("# B"), 0o644); err != nil {
		t.Fatal(err)
	}

	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "2026-07-28+stub", true }
	defer func() { fetchCloudVersion = orig }()

	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{
			{CypherURL: serverA.URL, Namespace: "nsA", WatchFolders: []string{rootA}},
			{CypherURL: serverB.URL, Namespace: "nsB", WatchFolders: []string{rootB}},
		},
		MaxRemoved: DefaultMaxRemovedRatio,
		// t181：本測驗的是「雙帳號各自送到自己的實例」，不是萃取。
		// 預設已改成 workers-ai（會打雲端萃取端點），為隔離變因這裡明確走舊制直送
		// （Extractor 空＋ExtractorExplicit=true ⇒ 不被預設覆蓋）。
		ExtractorExplicit: true,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("② 雙帳號同步應成功，exit=%d，results=%+v", exit, results)
	}
	hostA := instanceHostOf(serverA.URL)
	hostB := instanceHostOf(serverB.URL)
	var countA, countB int
	for _, r := range results {
		if r.Account == hostA {
			countA++
		}
		if r.Account == hostB {
			countB++
		}
	}
	if countA == 0 {
		t.Errorf("② account A 結果應標 host %s，got results: %+v", hostA, results)
	}
	if countB == 0 {
		t.Errorf("② account B 結果應標 host %s，got results: %+v", hostB, results)
	}
	// 各自的 fake server 收到請求（a.md → serverA，b.md → serverB）
	if serverACalled == 0 {
		t.Error("② serverA 未收到請求")
	}
	if serverBCalled == 0 {
		t.Error("② serverB 未收到請求")
	}
}

// ③一帳號 HTTP 失敗不擋另一帳號。
func TestRunDirectOnceOneAccountFailDoesNotBlock(t *testing.T) {
	serverFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal"}`))
	}))
	defer serverFail.Close()

	var serverOKCalled bool
	serverOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverOKCalled = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer serverOK.Close()

	base := t.TempDir()
	rootFail := filepath.Join(base, "rootFail")
	rootOK := filepath.Join(base, "rootOK")
	for _, d := range []string{rootFail, rootOK} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(rootFail, "f.md"), []byte("# F"), 0o644)
	_ = os.WriteFile(filepath.Join(rootOK, "ok.md"), []byte("# OK"), 0o644)

	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = orig }()

	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{
			{CypherURL: serverFail.URL, Namespace: "nsFail", WatchFolders: []string{rootFail}},
			{CypherURL: serverOK.URL, Namespace: "nsOK", WatchFolders: []string{rootOK}},
		},
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	_, exit, _ := RunDirectOnce(cfg, false)
	if exit != 1 {
		t.Errorf("③ 帳號失敗時 exit 應為 1，got %d", exit)
	}
	if !serverOKCalled {
		t.Error("③ 帳號 A 失敗不應擋住帳號 B 同步")
	}
}

// ④托盤分組資料結構：accountDisplayName 與 removeAccountWatchFolder 正確作用於指定帳號。
// （純資料結構測試，不依賴 fyne GUI）
func TestAccountDataStructureFunctions(t *testing.T) {
	type localAccCfg struct {
		InstanceName string
		Email        string
		CypherURL    string
		WatchFolders []string
	}
	// 用 makeAccountSubConfig 驗證 per-account sub-config 繼承機器層級欄位
	parent := &DirectConfig{
		Manifest:  "/tmp/m.json",
		PollSec:   10,
		Extractor: "claude", ExtractorExplicit: true,
		Accounts: []AccountConfig{
			{CypherURL: "https://a.example", Namespace: "nsA", WatchFolders: []string{"/folder1"}},
		},
		Library:    "kb",
		IngestWF:   "rag_ingest_direct",
		RemovedWF:  "rag_takedown_direct",
		CardIngestWF: "rag_ingest_card",
		LLMModel:   "gemma-4-31b-it",
	}
	sub := parent.makeAccountSubConfig(parent.Accounts[0])
	if sub.CypherURL != "https://a.example" {
		t.Errorf("makeAccountSubConfig CypherURL 錯：%s", sub.CypherURL)
	}
	if sub.PollSec != 10 {
		t.Errorf("makeAccountSubConfig 機器層級 PollSec 應繼承：%d", sub.PollSec)
	}
	if sub.Extractor != "claude" {
		t.Errorf("makeAccountSubConfig 機器層級 Extractor 應繼承：%s", sub.Extractor)
	}
	if len(sub.Accounts) != 0 {
		t.Errorf("makeAccountSubConfig Accounts 應清空（避免遞迴），got %d", len(sub.Accounts))
	}
}

// ⑤t101 刪除在多帳號下作用於正確帳號：帳號 A 刪 folder1 不影響帳號 B。
func TestRunDirectOnceAccountResultsTagged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	defer func() { fetchCloudVersion = orig }()

	base := t.TempDir()
	rootA := filepath.Join(base, "rA")
	rootB := filepath.Join(base, "rB")
	for _, d := range []string{rootA, rootB} {
		_ = os.MkdirAll(d, 0o755)
	}
	_ = os.WriteFile(filepath.Join(rootA, "a.md"), []byte("# A"), 0o644)
	_ = os.WriteFile(filepath.Join(rootB, "b.md"), []byte("# B"), 0o644)

	// 同一個 server，兩個帳號（用不同 namespace 區分）
	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{
			{CypherURL: server.URL, Namespace: "nsA", WatchFolders: []string{rootA}},
			{CypherURL: server.URL + "/", Namespace: "nsB", WatchFolders: []string{rootB}},
		},
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, _, _ := RunDirectOnce(cfg, true) // dry-run：驗結果標籤
	if len(results) == 0 {
		t.Fatal("⑤ dry-run 應有計畫事件")
	}
	for _, r := range results {
		if r.Account == "" {
			t.Errorf("⑤ 結果應標 Account host，got %+v", r)
		}
	}
}

// ── t126：每帳號獨立萃取設定 ──────────────────────────────────────────────────

// t126①：帳號層 Extractor/GeminiAPIKey/LLMModel 有值時優先覆蓋機器層。
func TestMakeAccountSubConfigExtractorOverride(t *testing.T) {
	parent := &DirectConfig{
		Manifest:     "/tmp/m.json",
		Extractor:    "claude", ExtractorExplicit: true,
		GeminiAPIKey: "machine-key",
		LLMModel:     "model-machine",
		PollSec:      5,
		MaxRemoved:   DefaultMaxRemovedRatio,
	}
	acc := AccountConfig{
		CypherURL:    "https://a.example",
		Namespace:    "ns",
		WatchFolders: []string{"/tmp"},
		Extractor:    "gemma", // 帳號層覆蓋（AccountConfig 無 ExtractorExplicit，那是機器層旗標）
		GeminiAPIKey: "account-key", // 帳號層覆蓋
		LLMModel:     "model-acc",   // 帳號層覆蓋
	}
	sub := parent.makeAccountSubConfig(acc)
	if sub.Extractor != "gemma" {
		t.Errorf("① 帳號層 Extractor 應優先，got %q", sub.Extractor)
	}
	if sub.GeminiAPIKey != "account-key" {
		t.Errorf("① 帳號層 GeminiAPIKey 應優先，got %q", sub.GeminiAPIKey)
	}
	if sub.LLMModel != "model-acc" {
		t.Errorf("① 帳號層 LLMModel 應優先，got %q", sub.LLMModel)
	}
}

// t126②：帳號層空字串不算「有值」，應繼承機器層。
func TestMakeAccountSubConfigExtractorFallback(t *testing.T) {
	parent := &DirectConfig{
		Manifest:     "/tmp/m.json",
		Extractor:    "gemma", ExtractorExplicit: true,
		GeminiAPIKey: "machine-key",
		LLMModel:     "model-machine",
		PollSec:      5,
		MaxRemoved:   DefaultMaxRemovedRatio,
	}
	acc := AccountConfig{
		CypherURL:    "https://a.example",
		Namespace:    "ns",
		WatchFolders: []string{"/tmp"},
		// Extractor/GeminiAPIKey/LLMModel 全空 → 繼承機器層
	}
	sub := parent.makeAccountSubConfig(acc)
	if sub.Extractor != "gemma" {
		t.Errorf("② 帳號層空時應繼承機器層 Extractor，got %q", sub.Extractor)
	}
	if sub.GeminiAPIKey != "machine-key" {
		t.Errorf("② 帳號層空時應繼承機器層 GeminiAPIKey，got %q", sub.GeminiAPIKey)
	}
	if sub.LLMModel != "model-machine" {
		t.Errorf("② 帳號層空時應繼承機器層 LLMModel，got %q", sub.LLMModel)
	}
}

// t126③ 遷移：機器層金鑰複製到沒有金鑰的帳號；已有金鑰的帳號不覆蓋。
func TestLoadDirectConfigMigratesCopyKeyToAccounts(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":       filepath.Join(dir, "m.json"),
		"extractor":      "gemma",
		"extractor_explicit": true, // t182：主動選過 ⇒ 不被抹成 workers-ai
		"gemini_api_key": "top-level-key",
		"llm_model":      "model-x",
		"accounts": []map[string]any{
			{
				"cypher_url":   "https://a.example",
				"namespace":    "nsA",
				"watch_folders": []string{"/tmp/a"},
				// 沒有 gemini_api_key → 應複製頂層
			},
			{
				"cypher_url":   "https://b.example",
				"namespace":    "nsB",
				"watch_folders": []string{"/tmp/b"},
				"gemini_api_key": "b-own-key", // 已有自己的 key → 不覆蓋
			},
		},
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	// account A：無 key → 應複製頂層
	if cfg.Accounts[0].GeminiAPIKey != "top-level-key" {
		t.Errorf("③ account A 應複製頂層 key，got %q", cfg.Accounts[0].GeminiAPIKey)
	}
	// t182：加 extractor_explicit（見下方 writeDirectConfig）＝使用者主動選過 Gemini
	// ⇒ 不觸發 workers-ai 抹除，t126 的「複製頂層 extractor」行為照舊可測。
	if cfg.Accounts[0].Extractor != "gemma" {
		t.Errorf("③ account A 應複製頂層 extractor，got %q", cfg.Accounts[0].Extractor)
	}
	if cfg.Accounts[0].LLMModel != "model-x" {
		t.Errorf("③ account A 應複製頂層 llm_model，got %q", cfg.Accounts[0].LLMModel)
	}
	// account B：已有自己的 key → 不覆蓋
	if cfg.Accounts[1].GeminiAPIKey != "b-own-key" {
		t.Errorf("③ account B 已有 key 不應被頂層覆蓋，got %q", cfg.Accounts[1].GeminiAPIKey)
	}
	// 頂層保留（複製非搬移）
	if cfg.GeminiAPIKey != "top-level-key" {
		t.Errorf("③ 頂層 key 應保留（複製非搬移），got %q", cfg.GeminiAPIKey)
	}
}

// t126④ 冪等：帳號已有 extractor/key 時再跑遷移不覆蓋。
func TestLoadDirectConfigMigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest":       filepath.Join(dir, "m.json"),
		"extractor":      "gemma",
		"extractor_explicit": true, // t182：主動選過 ⇒ 不被抹成 workers-ai
		"gemini_api_key": "top-key",
		"accounts": []map[string]any{
			{
				"cypher_url":   "https://a.example",
				"namespace":    "nsA",
				"watch_folders": []string{"/tmp/a"},
				"extractor":      "claude",    // 帳號已有 → 不應被頂層 "gemma" 覆蓋
				"gemini_api_key": "own-key",  // 帳號已有 → 不應被頂層 key 覆蓋
			},
		},
	})
	cfg, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatalf("LoadDirectConfig: %v", err)
	}
	if cfg.Accounts[0].Extractor != "claude" {
		t.Errorf("④ 帳號已有 extractor 不應被頂層覆蓋，got %q", cfg.Accounts[0].Extractor)
	}
	if cfg.Accounts[0].GeminiAPIKey != "own-key" {
		t.Errorf("④ 帳號已有 key 不應被頂層覆蓋，got %q", cfg.Accounts[0].GeminiAPIKey)
	}
}

// TestRunDirectOnceMultiAccount_TopLevelCloudCheckOK 釘住 arcrun-rag#59 相關實查
// （2026-08-10，見頂層 wiki `system-dev/wiki/status.md`「畫面在說謊」段）：
//
//	leo 三個帳號 `/health` 全部 200，畫面卻顯示「沒連上雲端」。
//	真兇＝ direct.go 寫 status.json 頂層 cloud_check_ok 時，
//	以前只有 `len(accountDetails) == 1` 才填，2+ 帳號時停在 Go 零值 false，
//	即使每個帳號自己的 AccountDetails.CloudCheckOK 都是 true。
//
// 這支測試刻意用**兩個帳號、兩台 fake /health 都成功**的設定——
// 釘住「多帳號時頂層 cloud_check_ok 也要照實填 true」，不是恆為 false。
func TestRunDirectOnceMultiAccount_TopLevelCloudCheckOK(t *testing.T) {
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"bundle_version":"1.4.30"}`))
	}))
	defer serverA.Close()
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"bundle_version":"1.4.30"}`))
	}))
	defer serverB.Close()

	base := t.TempDir()
	rootA := filepath.Join(base, "rootA")
	rootB := filepath.Join(base, "rootB")
	for _, d := range []string{rootA, rootB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// fetchCloudVersion 真的探每台 /health（模擬「三台全部 200」的現場，
	// 不用固定 stub——要驗的正是「per-account CloudCheckOK=true 時，
	// 頂層也要跟著 true」，不是探測機制本身）。
	origFCV := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFCV }()

	manifestPath := filepath.Join(base, "manifest.json")
	statusPath := filepath.Join(filepath.Dir(manifestPath), "status.json")
	cfg := &DirectConfig{
		Manifest: manifestPath,
		Accounts: []AccountConfig{
			{CypherURL: serverA.URL, Namespace: "nsA", WatchFolders: []string{rootA}},
			{CypherURL: serverB.URL, Namespace: "nsB", WatchFolders: []string{rootB}},
		},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true, // 隔離變因：不要走 workers-ai 萃取路，只驗 cloud check
	}
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatalf("雙帳號同步應成功，exit=%d", exit)
	}

	raw, err := os.ReadFile(statusPath)
	if err != nil {
		t.Fatalf("讀不到 status.json：%v（manifest=%s）", err, manifestPath)
	}
	var st SyncStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("status.json 格式錯：%v", err)
	}

	hostA := instanceHostOf(serverA.URL)
	hostB := instanceHostOf(serverB.URL)
	if !st.AccountDetails[hostA].CloudCheckOK || !st.AccountDetails[hostB].CloudCheckOK {
		t.Fatalf("兩個帳號各自的 CloudCheckOK 應該都是 true（測試前提：兩台 fake /health 都回 200）：%+v",
			st.AccountDetails)
	}
	if !st.CloudCheckOK {
		t.Fatal("兩個帳號都連得上，頂層 cloud_check_ok 卻是 false——" +
			"這正是 arcrun-rag#59「明明連上卻說沒連上」的那個病（多帳號時頂層被鎖死在零值）")
	}
	if st.CloudVersion == "" {
		t.Error("頂層 cloud_version 應該取到至少一個帳號的版本代表，不該是空字串")
	}
}

func TestExpandHomeEdgeCases(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("拿不到家目錄，跳過")
	}
	cases := map[string]string{
		"~":            home,
		"~/a/b":        filepath.Join(home, "a/b"),
		"/abs/path":    "/abs/path",
		"relative/dir": "relative/dir",
		"":             "",
		"~notme/x":     "~notme/x", // 只認 `~/`；`~user` 形式不猜（Go 無法解析他人家目錄）
	}
	for in, want := range cases {
		if got := expandHome(in); got != want {
			t.Errorf("expandHome(%q)＝%q，want %q", in, got, want)
		}
	}
}
