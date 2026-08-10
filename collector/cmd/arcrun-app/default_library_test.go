package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// fakeDaemonConfigServer 假的知識庫登入端點，回傳固定的 daemonConfigResp，
// 讓測試能真的走過 App.Connect() 而不必打真的雲端。
//
// 🔴 用 TLS server 不是隨便選的：normalizePortalURL()（connect.go）不管使用者貼的是
// http:// 還是 https://，一律吐回 "https://" + host（現實世界的網址全是 https，這樣
// 才不必逼使用者記得打 https）——所以假伺服器也一定要是 TLS，用一般 httptest.NewServer
// 會被硬轉成 https:// 打過去、連不上。同時把 http.DefaultTransport 換成信任這顆測試憑證
// 的版本（fetchConfigByLogin 的 http.Client{} 沒指定 Transport ⇒ 用的正是這個全域預設值），
// 測試結束就還原，不影響其他測試或正式行為。
func fakeDaemonConfigServer(t *testing.T, cypherURL string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/portal/daemon/config", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(daemonConfigResp{
			Success: true,
			Config: daemonConfig{
				CypherURL:    cypherURL,
				Namespace:    "abc123",
				Library:      "lib1",
				Email:        "evan@example.com",
				InstanceName: "evan-的知識庫",
			},
		})
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)

	origTransport := http.DefaultTransport
	http.DefaultTransport = srv.Client().Transport
	t.Cleanup(func() { http.DefaultTransport = origTransport })

	return srv
}

// TestDefaultLibrarySeededOnFirstConnect 釘住紅線①③：全新安裝、第一次連上知識庫，
// 應該自動出現一個可刪除的預設庫——裡面有真的檔案（丟檔→知識卡→搜得到那條路走得通），
// 而且只在這個資料夾自己底下寫東西，不污染 Documents 的其他地方。
func TestDefaultLibrarySeededOnFirstConnect(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	srv := fakeDaemonConfigServer(t, "https://instance-a.example.workers.dev")
	app := &App{}
	if err := app.Connect(srv.URL, "evan@example.com", "pw"); err != nil {
		t.Fatalf("Connect 失敗：%v", err)
	}

	cfg, err := loadCfg()
	if err != nil {
		t.Fatalf("讀不回設定：%v", err)
	}
	if len(cfg.Accounts) != 1 {
		t.Fatalf("應該只有一個帳號，實際 %d 個", len(cfg.Accounts))
	}

	wantPath := defaultLibraryPath()
	found := false
	for _, f := range cfg.Accounts[0].WatchFolders {
		if f == wantPath {
			found = true
		}
	}
	if !found {
		t.Fatalf("預設庫 %s 沒有被加進 watch_folders：%v", wantPath, cfg.Accounts[0].WatchFolders)
	}

	// 資料夾真的存在、裡面有真的檔案（不是空殼）
	entries, err := os.ReadDir(wantPath)
	if err != nil {
		t.Fatalf("預設庫資料夾沒有被建出來：%v", err)
	}
	if len(entries) == 0 {
		t.Fatal("預設庫資料夾是空的，等於沒有東西可以被整理成知識卡")
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".md" {
			t.Fatalf("預設庫檔案 %s 不是 collector 讀得懂的格式（見 scan.go allowedExt）", e.Name())
		}
		b, err := os.ReadFile(filepath.Join(wantPath, e.Name()))
		if err != nil || len(b) == 0 {
			t.Fatalf("%s 讀不到內容或是空檔——不准放空檔/佔位符", e.Name())
		}
	}

	// 不污染：Documents 底下只多出這一個資料夾，沒有散落在別處的殘留檔案
	docsEntries, err := os.ReadDir(filepath.Join(home, "Documents"))
	if err != nil {
		t.Fatalf("讀不到 Documents：%v", err)
	}
	if len(docsEntries) != 1 || docsEntries[0].Name() != defaultLibraryDirName {
		names := []string{}
		for _, e := range docsEntries {
			names = append(names, e.Name())
		}
		t.Fatalf("Documents 底下應該只有預設庫這一個資料夾，實際：%v", names)
	}

	// marker 檔存在，代表「已經種過一次」
	if _, err := os.Stat(defaultLibraryMarkerPath()); err != nil {
		t.Fatalf("marker 檔沒寫出來：%v", err)
	}
}

// TestDefaultLibraryDeletedDoesNotComeBack 釘住紅線①④：使用者把預設庫整個刪掉之後，
// ① config 裡的殘留引用要被清乾淨（不留幽靈資料）
// ② 就算之後又跑一次「種子」邏輯，也絕對不會把資料夾或引用生回來。
func TestDefaultLibraryDeletedDoesNotComeBack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	srv := fakeDaemonConfigServer(t, "https://instance-b.example.workers.dev")
	app := &App{}
	if err := app.Connect(srv.URL, "evan@example.com", "pw"); err != nil {
		t.Fatalf("Connect 失敗：%v", err)
	}

	path := defaultLibraryPath()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("前置條件失敗：預設庫應該已經存在：%v", err)
	}

	// 使用者從 Finder/檔案總管把整個資料夾刪掉
	if err := os.RemoveAll(path); err != nil {
		t.Fatalf("刪除失敗：%v", err)
	}

	// App 下一次讀狀態（等同 GetState 的自我修復邏輯）應該把殘留引用清掉
	cfg, err := loadCfg()
	if err != nil {
		t.Fatalf("讀不回設定：%v", err)
	}
	if !pruneMissingDefaultLibrary(cfg) {
		t.Fatal("應該偵測到預設庫已被刪除並回報 changed=true")
	}
	if err := saveCfg(cfg); err != nil {
		t.Fatalf("存檔失敗：%v", err)
	}

	cfg2, _ := loadCfg()
	for _, f := range cfg2.Accounts[0].WatchFolders {
		if f == path {
			t.Fatal("刪掉的預設庫路徑還留在 watch_folders 裡——幽靈資料")
		}
	}

	// 再跑一次種子邏輯（模擬使用者重開程式、或又連了一次同一個帳號）——
	// marker 檔還在，絕對不能把資料夾或引用生回來。
	seedDefaultLibraryIfFirstEver(cfg2, 0)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("預設庫刪掉後又長回來了：%v", err)
	}
	for _, f := range cfg2.Accounts[0].WatchFolders {
		if f == path {
			t.Fatal("種子邏輯把已刪除的預設庫路徑又加回 watch_folders 了")
		}
	}
}

// TestDefaultLibraryNotSeededWhenAccountsAlreadyExist 釘住紅線②：
// 「只要有掛用戶自己的資料夾，就不再出現」——這台機器如果已經連過帳號，
// 之後不管再連幾個新帳號，都不應該冒出這個預設庫。
func TestDefaultLibraryNotSeededWhenAccountsAlreadyExist(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// 模擬「這台機器已經有一個帳號，且已經掛了使用者自己的資料夾」
	preexisting := &directConfig{
		Accounts: []accountCfg{{
			InstanceName: "既有帳號",
			CypherURL:    "https://instance-existing.example.workers.dev",
			Namespace:    "existing",
			APIKey:       "existing",
			WatchFolders: []string{filepath.Join(home, "我的筆記")},
		}},
		Extractor: "workers-ai",
		Manifest:  filepath.Join(home, ".arcrun-rag", "manifest.json"),
	}
	if err := saveCfg(preexisting); err != nil {
		t.Fatalf("前置存檔失敗：%v", err)
	}

	srv := fakeDaemonConfigServer(t, "https://instance-c.example.workers.dev")
	app := &App{}
	if err := app.Connect(srv.URL, "second@example.com", "pw"); err != nil {
		t.Fatalf("Connect 失敗：%v", err)
	}

	if _, err := os.Stat(defaultLibraryPath()); !os.IsNotExist(err) {
		t.Fatalf("已有帳號的機器不該冒出預設庫，但資料夾存在：err=%v", err)
	}
	if _, err := os.Stat(defaultLibraryMarkerPath()); !os.IsNotExist(err) {
		t.Fatal("已有帳號的機器不該寫出 marker 檔")
	}

	cfg, _ := loadCfg()
	if len(cfg.Accounts) != 2 {
		t.Fatalf("應該有兩個帳號（既有 + 新連的），實際 %d", len(cfg.Accounts))
	}
	for _, acc := range cfg.Accounts {
		for _, f := range acc.WatchFolders {
			if f == defaultLibraryPath() {
				t.Fatal("預設庫路徑不該出現在任何帳號的 watch_folders 裡")
			}
		}
	}
}
