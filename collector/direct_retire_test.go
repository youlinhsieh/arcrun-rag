// direct_retire_test.go — arcrun-rag#46：「把整個資料夾從清單移除」要真的把雲端資料收回。
//
// 病（leo 2026-08-16 實撞）：「我去把 Logseq plugin 刪掉以後，**採集的 wiki 沒消失**。」
// 真兇是 App 的 RemoveFolder 只把路徑從看守清單拿掉，一次都沒碰撤除——
// 撤除機制本身是好的（有測試、有部署），只是這條路從來不呼叫它。
//
// 本檔釘的是 collector 這一半：資料夾進了 retiring_folders 之後，
// ① 真的逐筆撤除、② 撤乾淨才算完成、③ **不會波及別的資料夾**（巢狀/同名的邊界）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// takedownRecorder 收下每一次撤除呼叫的 payload，讓測試能斷言「殺的是哪一份」。
type takedownRecorder struct {
	mu   sync.Mutex
	hits []map[string]any
	fail bool // true＝一律回 500，用來驗「失敗要看得出來、而且下輪還會再試」
}

func (rec *takedownRecorder) server() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		rec.mu.Lock()
		rec.hits = append(rec.hits, m)
		rec.mu.Unlock()
		if rec.fail {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
}

func (rec *takedownRecorder) paths() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var out []string
	for _, h := range rec.hits {
		if p, ok := h["path"].(string); ok {
			out = append(out, p)
		}
	}
	return out
}

// seedSyncedRoot 造一個「已經同步過」的資料夾：實體檔案＋標成 ingested 的帳本。
func seedSyncedRoot(t *testing.T, cfg *DirectConfig, root string, files ...string) string {
	t.Helper()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	absRoot, _ := filepath.Abs(root)
	mp := cfg.manifestPathFor(absRoot)
	m := &Manifest{FolderID: "fid-" + filepath.Base(root), Root: absRoot, Entries: map[string]*ManifestEntry{}}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(root, f), []byte("# "+f), 0o644); err != nil {
			t.Fatal(err)
		}
		m.Entries[f] = &ManifestEntry{ContentHash: "h-" + f, IngestedHash: "h-" + f, IngestedAt: 1}
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	return mp
}

// ① 主線：資料夾進了 retiring_folders ⇒ 每個已上傳的檔都被撤除，帳本收乾淨。
func TestRetiringFolderTakesDownEveryIngestedFile(t *testing.T) {
	rec := &takedownRecorder{}
	srv := rec.server()
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "logseq-plugin")
	cfg := &DirectConfig{
		Manifest:  filepath.Join(base, "manifest.json"),
		CypherURL: srv.URL, Namespace: "ns1", APIKey: "ns1",
		RetiringFolders:   []string{root},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true, // 隔離變因：走舊制直送，不打雲端萃取端點
	}
	mp := seedSyncedRoot(t, cfg, root, "a.md", "b.md", "notes.md")

	results, exit, remaining, done := retireRootOnce(cfg, root, false)
	if exit != 0 {
		t.Fatalf("撤除應成功，exit=%d results=%+v", exit, results)
	}
	if !done || remaining != 0 {
		t.Fatalf("三筆都撤成功就該收乾淨，done=%v remaining=%d", done, remaining)
	}
	got := rec.paths()
	if len(got) != 3 {
		t.Fatalf("三個已上傳的檔應各撤一次，實得 %d 筆：%v", len(got), got)
	}
	want := map[string]bool{"a.md": true, "b.md": true, "notes.md": true}
	for _, p := range got {
		if !want[p] {
			t.Errorf("撤除了不該撤的 %q", p)
		}
	}
	// 收乾淨了 ⇒ 帳本沒有存在的理由，且下一輪不會再重排一次
	if _, err := os.Stat(mp); !os.IsNotExist(err) {
		t.Errorf("收乾淨後帳本該被刪掉，err=%v", err)
	}
	before := len(rec.paths())
	if _, _, _, done2 := retireRootOnce(cfg, root, false); !done2 {
		t.Error("第二輪應直接回報已完成")
	}
	if len(rec.paths()) != before {
		t.Errorf("第二輪不該再打任何撤除（冪等），before=%d after=%d", before, len(rec.paths()))
	}
}

// ②（最重要）邊界：兩個資料夾放著同名同相對路徑的檔，移除其中一個
//
//	**不可以**碰到另一個。程式這一半的保證＝撤除只針對那個根的帳本、
//	且 payload 帶著逐根導出的 library 讓雲端分得開。
func TestRetiringOneFolderDoesNotTouchTheOther(t *testing.T) {
	rec := &takedownRecorder{}
	srv := rec.server()
	defer srv.Close()

	base := t.TempDir()
	gone := filepath.Join(base, "gone") // 要移除的
	keep := filepath.Join(base, "keep") // 還在用的
	cfg := &DirectConfig{
		Manifest:  filepath.Join(base, "manifest.json"),
		CypherURL: srv.URL, Namespace: "ns1", APIKey: "ns1",
		WatchFolders:      []string{keep},
		RetiringFolders:   []string{gone},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true,
	}
	// 兩邊都有 notes.md：page_name 與相對 path 完全相同——這正是會誤傷的組合。
	goneMp := seedSyncedRoot(t, cfg, gone, "notes.md", "only-in-gone.md")
	keepMp := seedSyncedRoot(t, cfg, keep, "notes.md", "only-in-keep.md")

	if _, exit, _, done := retireRootOnce(cfg, gone, false); exit != 0 || !done {
		t.Fatalf("撤除應成功且收乾淨，exit=%d done=%v", exit, done)
	}

	// (a) 還在用的那個資料夾的帳本必須毫髮無傷
	keepM, err := LoadManifest(keepMp, keep)
	if err != nil {
		t.Fatalf("讀不回還在用的帳本：%v", err)
	}
	if len(keepM.Entries) != 2 {
		t.Errorf("還在用的資料夾帳本被動到了：%+v", keepM.Entries)
	}
	if len(keepM.PendingTakedowns) != 0 {
		t.Errorf("還在用的資料夾不該有待撤除：%+v", keepM.PendingTakedowns)
	}
	if _, err := os.Stat(keepMp); err != nil {
		t.Errorf("還在用的資料夾帳本不該被刪：%v", err)
	}
	if _, err := os.Stat(filepath.Join(keep, "notes.md")); err != nil {
		t.Errorf("還在用的資料夾的檔案不該被刪：%v", err)
	}
	if _, err := os.Stat(goneMp); !os.IsNotExist(err) {
		t.Errorf("被移除的資料夾帳本該收掉，err=%v", err)
	}

	// (b) 送上雲的每一筆都要帶 library，且是**被移除那個資料夾**的 library——
	//     沒有這一維，雲端無從分辨兩個 notes.md（page_name 與 path 全同）。
	goneLib := cfg.libraryFor(mustAbs(t, gone))
	keepLib := cfg.libraryFor(mustAbs(t, keep))
	if goneLib == keepLib {
		t.Fatalf("測試前提壞了：兩個資料夾應導出不同 library，都是 %q", goneLib)
	}
	rec.mu.Lock()
	hits := append([]map[string]any(nil), rec.hits...)
	rec.mu.Unlock()
	if len(hits) != 2 {
		t.Fatalf("只該撤被移除那個資料夾的兩個檔，實得 %d：%v", len(hits), rec.paths())
	}
	for _, h := range hits {
		if h["library"] != goneLib {
			t.Errorf("撤除 payload 的 library=%v，應為被移除資料夾的 %q（否則雲端會誤殺同名檔）",
				h["library"], goneLib)
		}
	}
}

// ③ 中途失敗要看得出來，而且不會被當成「已收乾淨」默默丟掉。
func TestRetiringFailureStaysPendingAndVisible(t *testing.T) {
	rec := &takedownRecorder{fail: true}
	srv := rec.server()
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "flaky")
	cfg := &DirectConfig{
		Manifest:  filepath.Join(base, "manifest.json"),
		CypherURL: srv.URL, Namespace: "ns1", APIKey: "ns1",
		RetiringFolders:   []string{root},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true,
	}
	mp := seedSyncedRoot(t, cfg, root, "x.md", "y.md")

	results, exit, remaining, done := retireRootOnce(cfg, root, false)
	if exit == 0 {
		t.Error("雲端回 500 時 exit 不該是 0——失敗要浮上來")
	}
	if done {
		t.Error("沒撤成功就宣告收乾淨＝把資料留在雲端卻跟使用者說刪了")
	}
	if remaining != 2 {
		t.Errorf("兩筆都失敗，remaining 應為 2，實得 %d", remaining)
	}
	var sawFail bool
	for _, r := range results {
		if r.Status == "failed" && r.Error != "" {
			sawFail = true
		}
	}
	if !sawFail {
		t.Errorf("失敗要帶原因（畫面要說得出來），results=%+v", results)
	}
	if _, err := os.Stat(mp); err != nil {
		t.Errorf("還沒撤乾淨，帳本不可以刪掉（刪了＝待辦永久遺失）：%v", err)
	}
	m, err := LoadManifest(mp, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.PendingTakedowns) != 2 {
		t.Errorf("失敗的兩筆要留在待辦清單等下輪重試，實得 %+v", m.PendingTakedowns)
	}

	// 雲端恢復 ⇒ 下一輪自己補完，不需要使用者再按一次
	rec.mu.Lock()
	rec.fail = false
	rec.mu.Unlock()
	if _, exit2, remaining2, done2 := retireRootOnce(cfg, root, false); exit2 != 0 || !done2 || remaining2 != 0 {
		t.Errorf("雲端恢復後應自動補完，exit=%d remaining=%d done=%v", exit2, remaining2, done2)
	}
}

// ④ 沒成功上傳過的檔不必空打——雲端根本沒有它。
func TestRetiringSkipsNeverIngestedFiles(t *testing.T) {
	rec := &takedownRecorder{}
	srv := rec.server()
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "half")
	cfg := &DirectConfig{
		Manifest:  filepath.Join(base, "manifest.json"),
		CypherURL: srv.URL, Namespace: "ns1", APIKey: "ns1",
		RetiringFolders:   []string{root},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true,
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	absRoot, _ := filepath.Abs(root)
	m := &Manifest{FolderID: "fid", Root: absRoot, Entries: map[string]*ManifestEntry{
		"up.md":    {ContentHash: "h1", IngestedHash: "h1"}, // 上去過
		"stuck.md": {ContentHash: "h2"},                     // 從沒成功上去（失敗退避中）
		"never.md": {ContentHash: "h3"},                     // 同上
	}}
	if err := m.Save(cfg.manifestPathFor(absRoot)); err != nil {
		t.Fatal(err)
	}

	if _, exit, _, done := retireRootOnce(cfg, root, false); exit != 0 || !done {
		t.Fatalf("exit=%d done=%v", exit, done)
	}
	got := rec.paths()
	if len(got) != 1 || got[0] != "up.md" {
		t.Errorf("只該撤真的上去過的那一筆，實得 %v", got)
	}
}

// ⑤ RetiringRoots() 兩層都要收——t149 的病（只讀了其中一層 ⇒ 新制設定被靜默忽略）。
func TestRetiringRootsReadsBothLayers(t *testing.T) {
	c := &DirectConfig{
		RetiringFolders: []string{"/tmp/legacy"},
		Accounts: []AccountConfig{
			{CypherURL: "https://a.example", RetiringFolders: []string{"/tmp/acc-a"}},
			{CypherURL: "https://b.example", RetiringFolders: []string{"/tmp/acc-b", "/tmp/legacy"}},
		},
	}
	got := c.RetiringRoots()
	want := []string{"/tmp/legacy", "/tmp/acc-a", "/tmp/acc-b"}
	if len(got) != len(want) {
		t.Fatalf("RetiringRoots()=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("RetiringRoots()[%d]=%s want %s", i, got[i], want[i])
		}
	}
	// 逐帳號隔離：撤除要打對的實例，不能沿用頂層清單
	sub := c.makeAccountSubConfig(c.Accounts[0])
	if got := sub.RetiringRoots(); len(got) != 1 || got[0] != "/tmp/acc-a" {
		t.Fatalf("帳號子設定的 RetiringRoots()=%v，應只有該帳號自己的", got)
	}
}

// ⑥ 端到端接線：RunDirectOnce 真的會處理 retiring_folders，並把進度寫進 status.json
//
//	（畫面靠它顯示「正在收回…」與失敗原因；沒接上就等於整條路沒接）。
func TestRunDirectOnceDrivesRetirementAndReportsStatus(t *testing.T) {
	rec := &takedownRecorder{}
	srv := rec.server()
	defer srv.Close()

	origVer := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "stub", true }
	defer func() { fetchCloudVersion = origVer }()

	base := t.TempDir()
	root := filepath.Join(base, "retired")
	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{{
			CypherURL: srv.URL, Namespace: "ns1", APIKey: "ns1",
			RetiringFolders: []string{root},
		}},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true,
	}
	// 帳本路徑含**帳號**尾碼（t86b），所以要用帳號子設定去算，不能用頂層 cfg
	// （頂層沒有 cypher_url ⇒ 算出來是另一個檔，等於什麼都沒 seed）。
	seedSyncedRoot(t, cfg.makeAccountSubConfig(cfg.Accounts[0]), root, "one.md")

	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("exit=%d results=%+v", exit, results)
	}
	if got := rec.paths(); len(got) != 1 || got[0] != "one.md" {
		t.Fatalf("RunDirectOnce 應驅動撤除，實得 %v", got)
	}
	var tagged bool
	for _, r := range results {
		if r.Type == "folder_takedown" && r.Root == root && r.Status == "removed" {
			tagged = true
		}
	}
	if !tagged {
		t.Errorf("撤除結果應標明是哪個資料夾，results=%+v", results)
	}

	st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if err != nil {
		t.Fatalf("讀不回 status.json：%v", err)
	}
	rs, ok := st.Retiring[root]
	if !ok {
		t.Fatalf("status.json 應回報這個資料夾的收回進度，實得 %+v", st.Retiring)
	}
	if !rs.Done || rs.Remaining != 0 {
		t.Errorf("撤乾淨後應回報 done（App 靠它把設定裡那一筆清掉），實得 %+v", rs)
	}
}

func mustAbs(t *testing.T, p string) string {
	t.Helper()
	a, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// ⑦ 舊制（頂層 retiring_folders、沒有 accounts[]）也要撤得掉。
//
//	LoadDirectConfig 會把舊制包成 Accounts[0]，而 makeAccountSubConfig 用帳號層
//	覆蓋頂層 ⇒ 遷移時漏帶這一欄，撤除就永遠不會發生、且**沒有任何錯誤訊息**（t149 形狀）。
func TestLegacyTopLevelRetiringFoldersMigrated(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"watch_folder": "/tmp/kb", "retiring_folders": []string{"/tmp/gone"},
		"manifest":   filepath.Join(dir, "m.json"),
		"cypher_url": "https://x.example", "namespace": "demo",
	})
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Accounts) != 1 {
		t.Fatalf("舊制應被包成一個帳號，實得 %d", len(c.Accounts))
	}
	sub := c.makeAccountSubConfig(c.Accounts[0])
	if got := sub.RetiringRoots(); len(got) != 1 || got[0] != "/tmp/gone" {
		t.Fatalf("舊制的待撤清單沒被帶進帳號層 ⇒ 永遠撤不掉，實得 %v", got)
	}
}
