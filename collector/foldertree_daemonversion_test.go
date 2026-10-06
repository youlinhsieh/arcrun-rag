// foldertree_daemonversion_test.go — 小幫手版號隨資料夾樹回報（inkstone/arcrun-collector#1）。
package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func postTreeCapture(t *testing.T, v string) map[string]any {
	t.Helper()
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	tree := buildTreeFromDisk(t, root).StampDaemonVersion(v)
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	if res := syncFolderTree(cfg, root, m, tree, false, time.Unix(1786900000, 0)); res == nil || res.Status != "ingested" {
		t.Fatalf("應送達：%+v", res)
	}
	return got
}

// 新版：酬載帶 daemon_version（欄名是協定，與雲端 122-update-center 一致）。
func TestSyncFolderTree酬載帶小幫手版號(t *testing.T) {
	got := postTreeCapture(t, "0.18.65")
	if got["daemon_version"] != "0.18.65" {
		t.Errorf("daemon_version 不對：%v", got["daemon_version"])
	}
}

// 舊版／開發版：整個欄位不出現（雲端照實顯示「看不到」，不是顯示空字串或 "dev"）。
func TestSyncFolderTree沒有版號時不帶欄位(t *testing.T) {
	got := postTreeCapture(t, "")
	if _, ok := got["daemon_version"]; ok {
		t.Errorf("沒版號卻帶了欄位：%v", got["daemon_version"])
	}
}

func TestDaemonVersion開發版不回報(t *testing.T) {
	orig := version
	defer func() { version = orig }()
	for _, v := range []string{"dev", ""} {
		version = v
		if daemonVersion() != "" {
			t.Errorf("version=%q 不該回報", v)
		}
	}
	version = "0.18.65"
	if daemonVersion() != "0.18.65" {
		t.Error("正式版號應原樣回報")
	}
}

// 升級後版號變了 ⇒ 雜湊變 ⇒ 下一輪補送（不必等 24h 心跳）。
func TestFolderTreeHash版號變了算內容變了(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	base := buildTreeFromDisk(t, root)
	if base.StampDaemonVersion("0.18.64").Hash() == base.StampDaemonVersion("0.18.65").Hash() {
		t.Error("版號改了雜湊卻沒變——升級後更新中心要等 24h 才看得到新版號")
	}
}
