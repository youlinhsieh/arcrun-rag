// version_beacon_test.go — 版號先報＋登入頁（公眾 Wi-Fi）講人話（inkstone/arcrun-collector#1，2026-10-31 實測）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// beaconFixture＝一個「上一輪跑過」的資料夾：帳本有、樹快照有，帳本上記的是舊版號。
func beaconFixture(t *testing.T, srvURL, oldVer string) (*DirectConfig, string) {
	t.Helper()
	dir := t.TempDir()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	cfg := &DirectConfig{
		CypherURL: srvURL, APIKey: "demo", Namespace: "demo",
		Manifest:  filepath.Join(dir, "manifest.json"),
		Libraries: map[string]string{root: "kb"},
	}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}, FolderID: "f1",
		FolderTreeHash: "oldhash", FolderTreeDaemonVersion: oldVer}
	if err := m.Save(cfg.manifestPathFor(root)); err != nil {
		t.Fatal(err)
	}
	PublishFolderTreeNow(cfg.Manifest, root, buildTreeFromDisk(t, root).StampDaemonVersion(oldVer), time.Unix(1786900000, 0))
	return cfg, root
}

func withVersion(t *testing.T, v string) {
	t.Helper()
	orig := version
	version = v
	t.Cleanup(func() { version = orig })
}

func TestSyncVersionBeacon升級後第一發就報新版號(t *testing.T) {
	withVersion(t, "0.18.118")
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	cfg, root := beaconFixture(t, srv.URL, "0.18.117")
	now := time.Unix(1786900000, 0)

	res := syncVersionBeacon(cfg, root, now)
	if res == nil || res.Status != "ingested" {
		t.Fatalf("應送達：%+v", res)
	}
	if len(bodies) != 1 || bodies[0]["daemon_version"] != "0.18.118" {
		t.Fatalf("該帶新版號：%v", bodies)
	}
	m, _ := LoadManifest(cfg.manifestPathFor(root), root)
	if m.FolderTreeDaemonVersion != "0.18.118" {
		t.Errorf("帳本沒記下已報的版號：%q", m.FolderTreeDaemonVersion)
	}
	// 已報過 ⇒ 之後每輪零成本
	if again := syncVersionBeacon(cfg, root, now.Add(time.Hour)); again != nil || len(bodies) != 1 {
		t.Errorf("版號沒變不該再送：%+v／%d 發", again, len(bodies))
	}
}

func TestSyncVersionBeacon沒有快照或沒有帳本或開發版都不送(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	now := time.Unix(1786900000, 0)

	withVersion(t, "dev")
	cfg, root := beaconFixture(t, srv.URL, "0.18.117")
	if syncVersionBeacon(cfg, root, now) != nil {
		t.Error("開發版不報版號")
	}
	version = "0.18.118"

	// 沒有帳本（從沒同步過）
	cfg2 := &DirectConfig{CypherURL: srv.URL, APIKey: "d", Manifest: filepath.Join(t.TempDir(), "m.json")}
	if syncVersionBeacon(cfg2, t.TempDir(), now) != nil {
		t.Error("沒帳本不該送，交給正常流程")
	}
	// 快照的庫名不是這個帳號的 ⇒ 不拿別人的樹頂替
	cfg.Libraries[root] = "another-kb"
	if syncVersionBeacon(cfg, root, now) != nil {
		t.Error("快照屬於別的知識庫，不該送")
	}
	if calls != 0 {
		t.Errorf("不該有任何請求：%d", calls)
	}
}

// 公眾 Wi-Fi 的登入頁：2xx 的 HTML／被導去別的網址／511 ⇒ 都講成「需要先登入」，不當成功、也不退避 10 分鐘。
func TestCaptivePortal三種長相都認得且講人話(t *testing.T) {
	withVersion(t, "0.18.118")
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>login</html>"))
	}))
	defer other.Close()
	cases := map[string]http.HandlerFunc{
		"2xx 卻是網頁": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!DOCTYPE html><html><body>Wi-Fi login</body></html>"))
		},
		"被導去別的網址": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL+"/login", http.StatusFound)
		},
		"511": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNetworkAuthenticationRequired)
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(h)
			defer srv.Close()
			cfg, root := beaconFixture(t, srv.URL, "0.18.117")
			res := syncVersionBeacon(cfg, root, time.Unix(1786900000, 0))
			if res == nil || res.Status != "failed" {
				t.Fatalf("該判失敗：%+v", res)
			}
			if !strings.Contains(res.Error, "這個網路需要先登入") {
				t.Errorf("畫面要直接說要先登入：%q", res.Error)
			}
			m, _ := LoadManifest(cfg.manifestPathFor(root), root)
			if m.FolderTreeDaemonVersion != "0.18.117" || m.FolderTreeFailHash != "" || m.FolderTreeNextRetry != 0 {
				t.Errorf("登入頁攔下沒到雲端：不該記成已報、也不該退避：%+v", m)
			}
		})
	}
}

// Cloudflare 自己的錯誤頁（5xx、帶 CF-RAY）是雲端的事，不是登入頁。
func TestCaptivePortal雲端自己的錯誤頁不誤判(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("CF-RAY", "abc")
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>Bad gateway</html>"))
	}))
	defer srv.Close()
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "d"}
	_, _, err := cfg.postJSON(stepFolderTree, cfg.folderTreeURL(), map[string]any{})
	if err == nil || isCaptivePortalErr(err) {
		t.Fatalf("502 是雲端的錯，不是登入頁：%v", err)
	}
}

func TestCaptivePortal算沒離開這台電腦(t *testing.T) {
	if !isLocalNetworkErr(&captivePortalError{detail: "x"}) {
		t.Error("登入頁攔下＝沒到雲端，不該記進逐檔病歷／斷路器")
	}
	cfg := &DirectConfig{CypherURL: "https://kb.example"}
	if got := networkDownNote(cfg, &captivePortalError{}); !strings.Contains(got, "需要先登入") || !strings.Contains(got, "後重試") {
		t.Errorf("逐檔那條路也要講登入：%q", got)
	}
}

// 整輪的次序：版號在任何資料夾的其他請求之前就先報（不必等前面資料夾的萃取）。
func TestRunDirectOnce版號排在所有資料夾之前(t *testing.T) {
	withVersion(t, "0.18.118")
	var mu sync.Mutex
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		order = append(order, r.Method+" "+r.URL.Path)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	dir := t.TempDir()
	rootA, rootB := t.TempDir(), t.TempDir()
	mustWrite(t, filepath.Join(rootA, "a.md"), "# a")
	mustWrite(t, filepath.Join(rootB, "b.md"), "# b")
	acc := AccountConfig{CypherURL: srv.URL, Namespace: "demo", APIKey: "k", WatchFolders: []string{rootA, rootB}}
	cfg := &DirectConfig{Manifest: filepath.Join(dir, "manifest.json"), Accounts: []AccountConfig{acc}}
	sub := cfg.makeAccountSubConfig(acc)
	for _, root := range []string{rootA, rootB} {
		m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}, FolderID: "f-" + filepath.Base(root),
			FolderTreeHash: "old", FolderTreeDaemonVersion: "0.18.117"}
		if err := m.Save(sub.manifestPathFor(root)); err != nil {
			t.Fatal(err)
		}
		PublishFolderTreeNow(cfg.Manifest, root, buildTreeFromDisk(t, root), time.Unix(1786900000, 0))
	}
	// 快照的庫名要與帳號層算出來的一致
	store, _ := LoadFolderTreeStore(FolderTreeStorePath(cfg.Manifest))
	for _, root := range []string{rootA, rootB} {
		tr := store.Trees[root]
		tr.Library = sub.libraryFor(root)
		store.Trees[root] = tr
	}
	_ = SaveFolderTreeStore(FolderTreeStorePath(cfg.Manifest), store)

	RunDirectOnce(cfg, false)

	mu.Lock()
	defer mu.Unlock()
	trees, firstOther := 0, -1
	for i, o := range order {
		if o == "POST /portal/daemon/folder-tree" {
			trees++
			continue
		}
		if strings.HasPrefix(o, "POST ") && firstOther < 0 {
			firstOther = i
		}
	}
	if len(order) < 2 || order[0] != "POST /portal/daemon/folder-tree" || order[1] != "POST /portal/daemon/folder-tree" {
		t.Fatalf("兩個資料夾的版號都該排在最前面：%v", order)
	}
	if trees < 2 {
		t.Errorf("樹至少送 2 發：%v", order)
	}
}
