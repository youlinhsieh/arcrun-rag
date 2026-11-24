package main

// colleague_screen_389_manual_test.go — inkstone/arcrun-rag#389「同仁在小幫手真畫面」驗收的後端橋（預設 SKIP）。
//
// 把「真的 App 後端方法」用 HTTP 接給「真的 build 出來的前端」（frontend/dist 原封不動，只塞一段把 window.go
// 接到 /rpc 的墊片），讓無頭 Chrome 在雲端真的走一遍：連線精靈貼公司網址 → 登入 → 首頁問答 → 點出處 → 知識卡分頁。
// 與桌面 App 相比，只差視窗外殼（Wails/WebView）；Mac／Windows 打包後的實機仍要地端走一次。
// 獨立 HOME，不碰任何人的設定。OpenURL／Quit／ShowWindow／PickFolder 不接真的，只把要開的網址記進 SCREEN_URLS_FILE。
//
//	RUN_SCREEN_389=1 SCREEN_PORT=8766 SCREEN_DONE_FILE=/tmp/done389 go test -run TestColleagueScreenBridgeManual -timeout 900s .
// 然後用 colleague_screen_389_drive.mjs 驅動 Chrome。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestColleagueScreenBridgeManual(t *testing.T) {
	if os.Getenv("RUN_SCREEN_389") != "1" {
		t.Skip("手動驗收，設 RUN_SCREEN_389=1（見檔頭）")
	}
	port, done := os.Getenv("SCREEN_PORT"), os.Getenv("SCREEN_DONE_FILE")
	if port == "" || done == "" {
		t.Fatal("需要 SCREEN_PORT、SCREEN_DONE_FILE")
	}
	tempHome(t)
	app := &App{}
	var mu sync.Mutex
	var urls []string
	logURL := func(u string) {
		mu.Lock()
		defer mu.Unlock()
		urls = append(urls, u)
		if p := os.Getenv("SCREEN_URLS_FILE"); p != "" {
			_ = os.WriteFile(p, []byte(strings.Join(urls, "\n")+"\n"), 0o600)
		}
	}
	deny := map[string]bool{"Quit": true, "ShowWindow": true, "PickFolder": true, "startup": true}
	mux := http.NewServeMux()
	mux.HandleFunc("/rpc/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/rpc/")
		w.Header().Set("Content-Type", "application/json")
		mv := reflect.ValueOf(app).MethodByName(name)
		var raw []json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&raw)
		if name == "OpenURL" {
			var u string
			if len(raw) > 0 {
				_ = json.Unmarshal(raw[0], &u)
			}
			logURL(u)
			_, _ = w.Write([]byte("null"))
			return
		}
		if deny[name] || !mv.IsValid() {
			_, _ = w.Write([]byte("null"))
			return
		}
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
	shim := `<script>window.go={main:{App:new Proxy({},{get:(t,k)=>async(...a)=>{const r=await fetch('/rpc/'+k,{method:'POST',body:JSON.stringify(a)});const j=await r.json();if(!r.ok)throw j;return j;}})}};window.runtime=window.runtime||{BrowserOpenURL:(u)=>fetch('/rpc/OpenURL',{method:'POST',body:JSON.stringify([u])}),EventsOn:()=>()=>{},EventsOff:()=>{},EventsEmit:()=>{}};try{localStorage.setItem('arcrun_app_theme','light')}catch(e){}</script>`
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
	for i := 0; i < 850; i++ {
		if _, err := os.Stat(done); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	_ = srv.Close()
}
