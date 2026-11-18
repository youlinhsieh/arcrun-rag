package main

// stall_screen_manual_test.go — inkstone/arcrun-rag#362「真畫面」驗收的後端橋（預設 SKIP）。
//
// #330 當初只驗了按鈕背後的方法，沒在畫面上點過，所以「看內容／同意通報」那張卡從沒被畫出來。
// 這支把「真的 App 後端方法」用 HTTP 接給「真的 build 出來的前端」，讓無頭 Chrome 在雲端真的點一遍：
//   - 後端：真的 GetState／StallPreview／ReportStall／DeclineStall／Dismiss（獨立 HOME，不碰任何人的設定）
//   - 前端：frontend/dist（vite build）原封不動，只在 index.html 前面塞一段把 window.go 接到 /rpc 的墊片
//   - 造一個 asked 停工：知識庫是一台一接上就掛斷的假伺服器，帳本有 NRI 那份 PDF 的失敗紀錄
// 🔴 通報只准打隔離租戶（ahub-stage-*）或本機替身，不打 inbox-feedback 主實例，更不碰 leo21c。
//
//	RUN_SCREEN_362=1 SCREEN_PORT=8765 STAGE_CYPHER_URL=https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev \
//	  STAGE_INBOX_NS=ahub-stage-377b STAGE_TAG=<本次唯一字串> go test -run TestStallScreenBridgeManual -timeout 900s .
// 然後用 stall_screen_drive.mjs 驅動 Chrome。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
)

func TestStallScreenBridgeManual(t *testing.T) {
	if os.Getenv("RUN_SCREEN_362") != "1" {
		t.Skip("手動驗收，設 RUN_SCREEN_362=1（見檔頭）")
	}
	cy, ns, tag, port := os.Getenv("STAGE_CYPHER_URL"), os.Getenv("STAGE_INBOX_NS"), os.Getenv("STAGE_TAG"), os.Getenv("SCREEN_PORT")
	if tag == "" || port == "" {
		t.Fatal("需要 STAGE_TAG、SCREEN_PORT")
	}
	if ns != "" {
		if cy == "" || !strings.HasPrefix(ns, "ahub-stage-") {
			t.Fatal("STAGE_INBOX_NS 只准 ahub-stage- 開頭的隔離租戶（並要 STAGE_CYPHER_URL）")
		}
		t.Setenv("ARCRUN_FEEDBACK_INBOX", cy+"/webhooks/named/"+ns+"/feedback_report/trigger")
	} else {
		// 沒給隔離租戶：本機替身收件端，回與真收件端同形狀的票號（只驗畫面串得起來，不算 stage 驗收）
		inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"success":true,"repo":"inkstone/arcrun-rag","number":99362}}`))
		}))
		defer inbox.Close()
		t.Setenv("ARCRUN_FEEDBACK_INBOX", inbox.URL)
	}
	tempHome(t)

	cutSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close()
	}))
	defer cutSrv.Close()
	watch := filepath.Join(t.TempDir(), "KB")
	_ = os.MkdirAll(watch, 0o755)
	writeCfgWithAccount(t, cutSrv.URL, accountCfg{Namespace: "ns-test", InstanceName: "測試知識庫-" + tag, WatchFolders: []string{watch}})
	_, cerr := (&http.Client{Timeout: 5 * time.Second}).Post(cutSrv.URL+"/portal/daemon/extract", "application/json", strings.NewReader("{}"))
	if cerr == nil {
		t.Fatal("掛斷的伺服器應該讓請求失敗")
	}
	realErr := "本地萃取失敗：" + collector.CloudCallErr(cerr).Error()
	mp := collector.ManifestPathFor(filepath.Join(appDir(), "manifest.json"), cutSrv.URL, watch)
	m := &collector.Manifest{FolderID: "t", Root: watch, Entries: map[string]*collector.ManifestEntry{}}
	for _, n := range []string{"20221216-NRI-國際低軌通訊衛星期中報告書.pdf", "NRI-附錄.pdf"} {
		m.Entries[n] = &collector.ManifestEntry{ContentHash: "h", FailCount: 12, LastError: realErr}
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	allow := map[string]bool{"GetState": true, "StallPreview": true, "ReportStall": true, "DeclineStall": true, "Dismiss": true}
	mux := http.NewServeMux()
	mux.HandleFunc("/rpc/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/rpc/")
		w.Header().Set("Content-Type", "application/json")
		mv := reflect.ValueOf(app).MethodByName(name)
		if !allow[name] || !mv.IsValid() {
			_, _ = w.Write([]byte("null"))
			return
		}
		var raw []json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&raw)
		mt := mv.Type()
		in := make([]reflect.Value, mt.NumIn())
		for i := range in {
			p := reflect.New(mt.In(i))
			if i < len(raw) {
				_ = json.Unmarshal(raw[i], p.Interface())
			}
			in[i] = p.Elem()
		}
		out := mv.Call(in)
		if n := len(out); n > 0 && mt.Out(n-1).String() == "error" && !out[n-1].IsNil() {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(fmt.Sprintf("%q", out[n-1].Interface().(error).Error())))
			return
		}
		if len(out) == 0 || mt.Out(0).String() == "error" {
			_, _ = w.Write([]byte("null"))
			return
		}
		_ = json.NewEncoder(w).Encode(out[0].Interface())
	})
	dist := os.Getenv("SCREEN_DIST")
	if dist == "" {
		dist = "frontend/dist"
	}
	shim := `<script>window.go={main:{App:new Proxy({},{get:(t,k)=>async(...a)=>{const r=await fetch('/rpc/'+k,{method:'POST',body:JSON.stringify(a)});const j=await r.json();if(!r.ok)throw j;return j;}})}};try{localStorage.setItem('arcrun_app_theme','light')}catch(e){}</script>`
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			b, err := os.ReadFile(filepath.Join(dist, "index.html"))
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(strings.Replace(string(b), "<script", shim+"<script", 1)))
			return
		}
		http.FileServer(http.Dir(dist)).ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: "127.0.0.1:" + port, Handler: mux}
	go func() { _ = srv.ListenAndServe() }()
	t.Logf("橋已起來 http://127.0.0.1:%s/", port)
	// 等驅動程式在 /tmp 放 done 檔才結束
	done := os.Getenv("SCREEN_DONE_FILE")
	for i := 0; i < 850; i++ {
		if _, err := os.Stat(done); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	_ = srv.Close()
}
