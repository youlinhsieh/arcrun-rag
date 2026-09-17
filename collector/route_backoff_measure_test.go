// route_backoff_measure_test.go — `inkstone/arcrun-rag#121`（comment 6923）的量測與驗收。
//
// 情境＝2026-09-13 leo Mac 的實況：雲端「收卡」那條路（rag_ingest_card）持續回 HTTP 500
// （`Node list_old_blocks failed: 缺少 credential: kbdb_internal_token`），而每一發都是
// 雲端的全表掃。其他端點（萃取、資料夾樹、對帳）都正常。
//
// 量的是：假時鐘每 5 秒跑一輪（daemon 預設 poll_interval_sec），跑滿 N 分鐘，
// 各類雲端請求一共打了幾發。**假伺服器＝只數請求**，不碰任何真實例。
//
// 🔴 這裡的 5 秒是**下限**：真實一輪還要加上本身的耗時（leo Mac 上約 15 秒一輪），
// 所以同樣 N 分鐘，真機的輪數比這裡少——這份數字是「最壞情況」，不是真機的精確值。
//
// 修前基準（commit 7a3eb2c，同一支量測、同一個情境）：
//
//	 1 分鐘（ 12 輪）：收卡路由  151 發
//	10 分鐘（120 輪）：收卡路由 1291 發
//	60 分鐘（720 輪）：收卡路由 7326 發，萃取 120 次（同一批檔反覆重萃）
package collector

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type routeCounts struct {
	Rounds    int
	CardRoute int             // rag_ingest_card 收到幾發（壞掉那段時間的每一發＝雲端一次全表掃）
	CardOK    map[string]bool // 雲端恢復後，哪些 path 真的送成功了
	Extract   int             // /portal/daemon/extract 真的萃取（燒 AI 額度）
	Probe     int             // /portal/daemon/extract 空探測
	Tree      int             // /portal/daemon/folder-tree
	Audit     int             // /kbdb/entries
	Other     int             // 含 /health（每輪固定問的版本）
}

func (c routeCounts) Total() int {
	return c.CardRoute + c.Extract + c.Probe + c.Tree + c.Audit + c.Other
}

// runCardRouteDownScenario 建一個「30 份新檔＋10 份待修出處的舊卡」的資料夾，
// 讓收卡路由在前 downFor 內持續 500（之後恢復），模擬 minutes 分鐘（每 pollSec 秒一輪）。
func runCardRouteDownScenario(t *testing.T, minutes, pollSec int, downFor time.Duration) routeCounts {
	return runRouteDownScenario(t, minutes, pollSec, downFor, "ok")
}

// runRouteDownScenario：extractMode＝"ok"｜"5xx"（萃取端點恆回 503，含空探測）｜"refuse"（萃取端點連線直接被切斷＝連不上）。
func runRouteDownScenario(t *testing.T, minutes, pollSec int, downFor time.Duration, extractMode string) routeCounts {
	t.Helper()
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	// 量測要用正式值：每輪固定問雲端的兩件事（版本、雲端 AI）一分鐘只問一次（cloudcheck.go）。
	withCloudCheckInterval(t, 60*time.Second)

	root := t.TempDir()
	for i := 0; i < 30; i++ {
		name := fmt.Sprintf("筆記%02d", i)
		writeFile(t, root, name+".md", "# "+name+"\n\n內容 "+name, baseTime.Add(time.Duration(i)*time.Minute))
	}
	// 10 份舊形出處的卡（Arcrun#167 的就地修正會想重推它們）。
	var docs []wikiDoc
	for i := 0; i < 10; i++ {
		rel := fmt.Sprintf("舊資料/.wiki/舊檔%02d.md", i)
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(legacyCard), 0o644); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, wikiDoc{Node: "舊資料", Path: fmt.Sprintf("舊檔%02d.pdf", i),
			Status: "extracted", Card: fmt.Sprintf("舊檔%02d", i), Cards: []string{rel}})
	}
	if err := saveWikiManifest(root, &wikiManifest{Version: 1, Docs: docs}); err != nil {
		t.Fatal(err)
	}

	start := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	var clockNs atomic.Int64
	clockNs.Store(start.UnixNano())
	oldNow := directNow
	directNow = func() time.Time { return time.Unix(0, clockNs.Load()).UTC() }
	defer func() { directNow = oldNow }()

	var mu sync.Mutex
	c := routeCounts{CardOK: map[string]bool{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/rag_ingest_card/trigger"):
			c.CardRoute++
			if time.Unix(0, clockNs.Load()).Before(start.Add(downFor)) {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"success":false,"error":"Node list_old_blocks failed: 缺少 credential: kbdb_internal_token"}`))
				return
			}
			var req struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(body, &req)
			c.CardOK[req.Path] = true
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			var req struct {
				PageName string `json:"page_name"`
				Text     string `json:"text"`
			}
			_ = json.Unmarshal(body, &req)
			mode := extractMode
			if mode == "5xx-10m" { // 前 10 分鐘 503，之後恢復
				mode = "ok"
				if time.Unix(0, clockNs.Load()).Before(start.Add(10 * time.Minute)) {
					mode = "5xx"
				}
			}
			switch mode {
			case "5xx":
				if strings.TrimSpace(req.Text) == "" {
					c.Probe++
				} else {
					c.Extract++
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"success":false,"error":"upstream unavailable"}`))
				return
			case "refuse":
				if strings.TrimSpace(req.Text) == "" {
					c.Probe++
				} else {
					c.Extract++
				}
				if hj, ok := w.(http.Hijacker); ok {
					if conn, _, err := hj.Hijack(); err == nil {
						_ = conn.Close() // 沒有任何回應就斷線＝client 端拿到連線層錯誤
						return
					}
				}
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			if strings.TrimSpace(req.Text) == "" {
				c.Probe++
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
				return
			}
			c.Extract++
			subject := req.PageName
			if subject == "" {
				subject = "未命名"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture(subject, "測試")})
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree"):
			c.Tree++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		case strings.HasSuffix(r.URL.Path, "/kbdb/entries"):
			c.Audit++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "total": 1})
		default:
			c.Other++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	}))
	defer srv.Close()

	cfg := &DirectConfig{
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CardIngestWF: "rag_ingest_card", IngestWF: "rag_ingest_direct", RemovedWF: "rag_takedown_direct",
		Extractor: "workers-ai", ExtractorExplicit: true,
		MachineLabel: "量測機",
		MaxRemoved:   DefaultMaxRemovedRatio,
		Accounts: []AccountConfig{{
			CypherURL: srv.URL, Namespace: "demo", APIKey: "demo",
			WatchFolders: []string{root},
		}},
	}
	end := start.Add(time.Duration(minutes) * time.Minute)
	for now := start; now.Before(end); now = now.Add(time.Duration(pollSec) * time.Second) {
		clockNs.Store(now.UnixNano())
		RunDirectOnce(cfg, false)
		c.Rounds++
	}
	mu.Lock()
	defer mu.Unlock()
	return c
}

// TestCardRouteDown_Measure：雲端收卡路由**從頭壞到尾**，daemon 打上去的請求數。
// 情境與修前基準（檔頭）逐字相同，數字可以直接對照。
func TestCardRouteDown_Measure(t *testing.T) {
	// 修前：151／1291／7326。上限＝門檻 4 發（第一輪內停下）＋每個退避窗口到期各 1 發，再留一點餘裕。
	limits := map[int]int{1: 5, 10: 10, 60: 15}
	for _, minutes := range []int{1, 10, 60} {
		c := runCardRouteDownScenario(t, minutes, 5, 24*time.Hour)
		t.Logf("收卡路由持續 500，模擬 %2d 分鐘（%3d 輪）：收卡路由 %4d 發｜萃取 %3d｜探測 %3d｜資料夾樹 %2d｜對帳 %3d｜其他 %d｜合計 %4d",
			minutes, c.Rounds, c.CardRoute, c.Extract, c.Probe, c.Tree, c.Audit, c.Other, c.Total())
		if c.CardRoute > limits[minutes] {
			t.Errorf("%d 分鐘內打壞掉那條路 %d 發，超過 %d——退避沒有生效", minutes, c.CardRoute, limits[minutes])
		}
		// 送不出去就不該反覆萃：30 份新檔最多各萃一次（第一份是撞牆的那一發）。
		if c.Extract > 30 {
			t.Errorf("%d 分鐘內萃取 %d 次，同一批檔被重複燒 AI 額度", minutes, c.Extract)
		}
	}
}

// TestExtractRouteDown_Measure：`inkstone/arcrun-rag#121` comment 6960 補的驗收——
// 萃取端點（/portal/daemon/extract，不經 postJSON）持續 5xx／連不上，收卡路由正常。
// 修前基準見 comment（同一支情境在 7a3eb2c 上跑）。
func TestExtractRouteDown_Measure(t *testing.T) {
	limits := map[int]int{1: 6, 10: 12, 60: 16} // 萃取＋探測合計；與收卡路由同一個量級
	for _, mode := range []string{"5xx", "refuse"} {
		for _, minutes := range []int{1, 10, 60} {
			c := runRouteDownScenario(t, minutes, 5, 0, mode)
			t.Logf("萃取端點持續 %-6s，模擬 %2d 分鐘（%3d 輪）：萃取 %4d 發｜探測 %4d｜萃取端點合計 %4d｜收卡路由 %3d｜資料夾樹 %d｜其他 %d",
				mode, minutes, c.Rounds, c.Extract, c.Probe, c.Extract+c.Probe, c.CardRoute, c.Tree, c.Other)
			if got := c.Extract + c.Probe; got > limits[minutes] {
				t.Errorf("%s／%d 分鐘：打萃取端點 %d 發，超過 %d——萃取那條路沒有退避", mode, minutes, got, limits[minutes])
			}
		}
	}
}

// TestExtractRouteDown_RecoversByItself：萃取端點壞 10 分鐘後恢復——不重開、不按按鈕，
// 30 份新檔都要自己萃完並送上去（退避不准變成「永久放棄」，也不准把檔累積到「連續失敗 8 次已暫停」）。
func TestExtractRouteDown_RecoversByItself(t *testing.T) {
	c := runRouteDownScenario(t, 60, 5, 0, "5xx-10m")
	t.Logf("萃取端點壞 10 分鐘後恢復，模擬 60 分鐘：萃取 %d 發｜探測 %d｜送成功的 path %d 個",
		c.Extract, c.Probe, len(c.CardOK))
	var missing []string
	for i := 0; i < 30; i++ {
		if p := fmt.Sprintf("筆記%02d.md", i); !c.CardOK[p] {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("萃取端點恢復 50 分鐘後仍有 %d 份沒送上去：%v", len(missing), missing)
	}
}

// TestCardRouteDown_RecoversByItself：壞 10 分鐘之後雲端修好了——
// 不重開小幫手、不按任何按鈕，所有該送的東西都要自己送上去（退避不准變成「永久放棄」）。
func TestCardRouteDown_RecoversByItself(t *testing.T) {
	c := runCardRouteDownScenario(t, 60, 5, 10*time.Minute)
	t.Logf("壞 10 分鐘後恢復，模擬 60 分鐘：收卡路由 %d 發｜送成功的 path %d 個｜萃取 %d",
		c.CardRoute, len(c.CardOK), c.Extract)
	var missing []string
	for i := 0; i < 30; i++ {
		if p := fmt.Sprintf("筆記%02d.md", i); !c.CardOK[p] {
			missing = append(missing, p)
		}
	}
	for i := 0; i < 10; i++ {
		if p := fmt.Sprintf("舊資料/舊檔%02d.pdf", i); !c.CardOK[p] {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("雲端恢復 50 分鐘後仍有 %d 份沒送上去：%v", len(missing), missing)
	}
}

// ── 退避本身的規則 ────────────────────────────────────────────────────────

func TestRouteBreaker_Rules(t *testing.T) {
	b := &routeBreaker{routes: map[string]*routeState{}}
	u := "https://x.workers.dev/webhooks/named/ns/rag_ingest_card/trigger"
	other := "https://x.workers.dev/webhooks/named/ns/rag_takedown_direct/trigger"
	t0 := time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)

	// 2xx（即使 body 寫工作流失敗，postJSON 也只把狀態碼交進來）與一般 4xx 不開閘。
	b.record(u, t0, 200, nil, false)
	for i := 0; i < 10; i++ {
		b.record(u, t0, 400, nil, false)
	}
	if n := b.note(u, t0); n != "" {
		t.Fatalf("2xx／400 不該讓整條路退避：%q", n)
	}

	// 有前科的內容再失敗：不算數。
	for i := 0; i < 10; i++ {
		b.record(u, t0, 500, nil, true)
	}
	if n := b.note(u, t0); n != "" {
		t.Fatalf("先前就失敗過的檔再失敗，不准把整條路關掉：%q", n)
	}

	// 第一次送的內容連續失敗：前 3 發照常重試，第 4 發 ⇒ 停 1 分鐘；只停這一條，別條路照走。
	for i := 0; i < routeStrikesBeforeBackoff-1; i++ {
		b.record(u, t0, 500, nil, false)
	}
	if n := b.note(u, t0); n != "" {
		t.Fatalf("單次（未達門檻）的 500 下一輪要照常重試：%q", n)
	}
	b.record(u, t0, 500, nil, false)
	n := b.note(u, t0.Add(30*time.Second))
	if n == "" || !strings.Contains(n, "rag_ingest_card") {
		t.Fatalf("500 之後應該退避並講出是哪條路：%q", n)
	}
	if !explainsWhySkipped(n) {
		t.Fatalf("退避訊息要講得出原因（sync_status.go 的識別字）：%q", n)
	}
	if strings.Contains(n, "500") || strings.Contains(n, "HTTP") {
		t.Fatalf("畫面上的話不准裸露狀態碼：%q", n)
	}
	if b.note(other, t0) != "" {
		t.Fatal("一條路壞了不該牽連同台知識庫的其他路")
	}
	if b.note(u, t0.Add(time.Minute)) != "" {
		t.Fatal("窗口到了就要放一發試試")
	}

	// 連續失敗 ⇒ 窗口變長；429 與連線錯誤也算。
	b.record(u, t0.Add(time.Minute), 429, nil, false)
	if b.note(u, t0.Add(time.Minute+90*time.Second)) == "" {
		t.Fatal("窗口到期後再失敗一發，應該停 2 分鐘")
	}
	// #201：連線層錯誤只算「連上之後出事」的（這裡用連線被切斷）；本機沒連出去的另有測試。
	b.record(u, t0.Add(3*time.Minute), 0, errors.New("read tcp 10.0.0.1:1->10.0.0.2:443: connection reset by peer"), false)
	if b.note(u, t0.Add(3*time.Minute+4*time.Minute)) == "" {
		t.Fatal("再失敗一發應該停 5 分鐘")
	}
	// 一發成功 ⇒ 全部歸零：之後單次 500 不會立刻停。
	b.record(u, t0.Add(9*time.Minute), 200, nil, false)
	b.record(u, t0.Add(9*time.Minute), 500, nil, false)
	if b.note(u, t0.Add(9*time.Minute)) != "" {
		t.Fatal("成功一次後計數要歸零，重新累積到門檻前不該停")
	}
	// 上限 30 分鐘。
	for i := 0; i < 20; i++ {
		b.record(u, t0, 500, nil, false)
	}
	if b.note(u, t0.Add(30*time.Minute)) != "" {
		t.Fatal("退避上限是 30 分鐘，雲端修好後最慢半小時要自己接上")
	}
}

// 「立刻同步」＝使用者明確要求這一輪照打（與逐檔退避同一個語意）。
func TestRouteBreaker_ForceSyncBypasses(t *testing.T) {
	cloudRoutes.reset()
	defer cloudRoutes.reset()
	u := "https://y.workers.dev/webhooks/named/ns/rag_ingest_card/trigger"
	for i := 0; i < routeStrikesBeforeBackoff; i++ {
		cloudRoutes.record(u, directNow(), 503, nil, false)
	}
	cfg := &DirectConfig{}
	if cfg.routeNote(u) == "" {
		t.Fatal("503 之後應該在退避中")
	}
	cfg.ForceSync = true
	if cfg.routeNote(u) != "" {
		t.Fatal("按了「立刻同步」這一輪要照打")
	}
}
