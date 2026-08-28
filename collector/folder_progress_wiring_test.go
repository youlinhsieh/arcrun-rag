package collector

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestFolderProgressLandsInStatus 守住 `inkstone/arcrun-rag#159` 的接線：
// **逐資料夾的同步現況真的會寫進 status.json**，而且是每個根各一份。
//
// 為什麼要有這一條：小幫手畫面上那個打勾完全靠這個欄位。它沒寫出來的話，
// 前端拿不到資料 ⇒ 每一列都會落到 unknown ⇒ 使用者又回到「看不出同步了沒」。
func TestFolderProgressLandsInStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	base := t.TempDir()
	rootA := filepath.Join(base, "A")
	rootB := filepath.Join(base, "B")
	for _, d := range []string{rootA, rootB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(rootA, "a1.md"), []byte("# A1"), 0o644)
	_ = os.WriteFile(filepath.Join(rootA, "a2.md"), []byte("# A2"), 0o644)
	_ = os.WriteFile(filepath.Join(rootB, "b1.md"), []byte("# B1"), 0o644)

	cfg := &DirectConfig{
		Manifest:   filepath.Join(base, "manifest.json"),
		Accounts:   []AccountConfig{{CypherURL: srv.URL, Namespace: "ns", WatchFolders: []string{rootA, rootB}}},
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	RunDirectOnce(cfg, false)

	st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if err != nil {
		t.Fatalf("讀不到 status.json：%v", err)
	}
	if len(st.FolderProgress) != 2 {
		t.Fatalf("folder_progress 應該每個看守資料夾各一份（2），got %d：%+v",
			len(st.FolderProgress), st.FolderProgress)
	}
	if got := st.FolderProgress[rootA].Total; got != 2 {
		t.Errorf("A 的分母應為 2，got %d", got)
	}
	if got := st.FolderProgress[rootB].Total; got != 1 {
		t.Errorf("B 的分母應為 1，got %d", got)
	}
	// 🔴 逐資料夾加起來要等於首頁那行總量——它們本來就是同一組數字被切開，
	//    對不起來就代表有人另算了一套（那正是這張票要拔掉的病）。
	var sum SyncProgress
	for _, p := range st.FolderProgress {
		sum = sum.Add(p)
	}
	if sum.Total != st.Progress.Total-st.Progress.Unreadable {
		t.Errorf("逐資料夾合計 %d ≠ 首頁總量 %d（扣掉沒進 manifest 的 %d）",
			sum.Total, st.Progress.Total, st.Progress.Unreadable)
	}
}

// TestCloudVersionSurvivesOneFailedProbe 守住票的追加條件 6：
// **「連不上」的判準不能是「這一輪解析失敗」。**
//
// leo 2026-08-28 畫面上寫「目前連不上這個知識庫，查不到版本」，
// 而同一台機器 curl 打同一支 /health 是 HTTP 200——那是機器當下 DNS 抽風。
// 一次探測失敗不准抹掉我們已經知道的版本。
func TestCloudVersionSurvivesOneFailedProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "R")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "r.md"), []byte("# R"), 0o644)

	cfg := &DirectConfig{
		Manifest:   filepath.Join(base, "manifest.json"),
		Accounts:   []AccountConfig{{CypherURL: srv.URL, Namespace: "ns", WatchFolders: []string{root}}},
		MaxRemoved: DefaultMaxRemovedRatio,
	}

	orig := fetchCloudVersion
	defer func() { fetchCloudVersion = orig }()
	// 「最新版是多少」也要釘住，否則這條測試會依賴 install.arcrun.dev 通不通
	// ——那樣測的就不是我們要測的東西了（而且 CI 離線就紅）。
	origLatest := fetchLatestCloudReleaseRaw
	fetchLatestCloudReleaseRaw = func() (string, bool) { return "1.4.58", true }
	latestMu.Lock()
	latestFetched = time.Time{} // 清掉節流快取，讓 stub 這一輪真的生效
	latestMu.Unlock()
	defer func() {
		fetchLatestCloudReleaseRaw = origLatest
		latestMu.Lock()
		latestFetched = time.Time{}
		latestMu.Unlock()
	}()

	// 第一輪：查得到版本。
	fetchCloudVersion = func(string) (string, bool) { return "1.4.60", true }
	RunDirectOnce(cfg, false)

	// 第二輪：探測失敗（模擬 DNS 抽風）。
	fetchCloudVersion = func(string) (string, bool) { return "", false }
	RunDirectOnce(cfg, false)

	st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.AccountDetails) != 1 {
		t.Fatalf("應該只有一個帳號，got %d", len(st.AccountDetails))
	}
	for host, acc := range st.AccountDetails {
		if acc.CloudVersion != "1.4.60" {
			t.Errorf("%s：一次探測失敗就把版本抹掉了（got %q，應沿用 1.4.60）", host, acc.CloudVersion)
		}
		if !acc.CloudUpdateKnown {
			t.Errorf("%s：版本明明還知道，卻標成「查不到」", host)
		}
		// 可達性是另一件事，要照實記——不准為了讓畫面好看就說連得上。
		if acc.CloudCheckOK {
			t.Errorf("%s：這一輪明明沒連上，cloud_check_ok 卻是 true", host)
		}
	}
}
