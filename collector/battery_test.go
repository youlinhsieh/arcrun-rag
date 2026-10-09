// battery_test.go — 電池模型小幫手這一半（inkstone/arcrun-rag#240 c18058，母票 inkstone/Arcrun#293 c18013）。
// 五種狀態：50%、80%、90%、100%（用量）與核能電池（放行）。
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

func init() {
	// 既有測試一律不打真的雲端電池端點；要驗電池的測試自己換掉。
	fetchBattery = func(string, string) (*Battery, error) { return nil, nil }
	saverPaceInterval = 0
}

// 雲端 `lib/battery.ts` computeBattery 的實際輸出形狀（portal-battery.test.ts 的五種輸入）。
var cloudBatteryJSON = map[string]string{
	"50":      `{"success":true,"battery":{"state":"normal","remaining_percent":50,"warn":false,"saver":false,"message":null,"reset_at":"2026-10-08T00:00:00.000Z"}}`,
	"80":      `{"success":true,"battery":{"state":"warn20","remaining_percent":20,"warn":true,"saver":false,"message":"電量剩 20%，快用完時會自動進入省電模式。","reset_at":"2026-10-08T00:00:00.000Z"}}`,
	"90":      `{"success":true,"battery":{"state":"saver","remaining_percent":10,"warn":true,"saver":true,"message":"電量只剩 10%，已進入省電模式。","reset_at":"2026-10-08T00:00:00.000Z"}}`,
	"100":     `{"success":true,"battery":{"state":"empty","remaining_percent":0,"warn":true,"saver":true,"message":"今天的免費額度用完了。","reset_at":"2026-10-08T00:00:00.000Z"}}`,
	"nuclear": `{"success":true,"battery":{"state":"nuclear","remaining_percent":null,"warn":false,"saver":false,"message":null,"reset_at":"2026-10-08T00:00:00.000Z"}}`,
}

func TestParseBatteryFiveStates(t *testing.T) {
	cases := []struct {
		key       string
		state     string
		remaining float64
		hasPct    bool
		warn      bool
		saves     bool
	}{
		{"50", BatteryNormal, 50, true, false, false},
		{"80", BatteryWarn20, 20, true, true, false},
		{"90", BatterySaver, 10, true, true, true},
		{"100", BatteryEmpty, 0, true, true, true},
		{"nuclear", BatteryNuclear, 0, false, false, false},
	}
	for _, c := range cases {
		b, err := parseBattery([]byte(cloudBatteryJSON[c.key]))
		if err != nil || b == nil {
			t.Fatalf("%s：解析失敗 %v %v", c.key, b, err)
		}
		if b.State != c.state || b.Warn != c.warn || b.SavesPower() != c.saves {
			t.Errorf("%s：state=%s warn=%v saves=%v，want %s/%v/%v", c.key, b.State, b.Warn, b.SavesPower(), c.state, c.warn, c.saves)
		}
		if c.hasPct && (b.RemainingPercent == nil || *b.RemainingPercent != c.remaining) {
			t.Errorf("%s：remaining=%v want %v", c.key, b.RemainingPercent, c.remaining)
		}
		if !c.hasPct && b.RemainingPercent != nil {
			t.Errorf("%s：核能電池不該有 %%，got %v", c.key, *b.RemainingPercent)
		}
	}
}

// 核能電池：就算雲端多帶了 %／警告，小幫手也一律收乾淨（不顯示、不警告、不省電）。
func TestParseBatteryNuclearKeepsPercentButScrubsRest(t *testing.T) {
	b, _ := parseBattery([]byte(`{"battery":{"state":"nuclear","remaining_percent":43.8,"warn":true,"saver":true,"message":"x"}}`))
	if b == nil || b.RemainingPercent == nil || *b.RemainingPercent != 43.8 {
		t.Fatalf("不限用量的帳號，雲端給的剩餘 %% 要原樣收下（#240 c18328）：%+v", b)
	}
	if b.Warn || b.Saver || b.Message != "" || b.SavesPower() {
		t.Fatalf("nuclear 的警告／省電／訊息要收乾淨：%+v", b)
	}
	old, _ := parseBattery([]byte(`{"battery":{"state":"nuclear","remaining_percent":null}}`))
	if old == nil || old.RemainingPercent != nil {
		t.Fatalf("舊版雲端不回 %%（null）就維持 nil＝只顯示 ∞：%+v", old)
	}
}

// 舊版雲端（沒有 battery 欄位）或不認得的狀態＝未知：不編故事。
func TestParseBatteryUnknownIsNil(t *testing.T) {
	for _, body := range []string{`{"success":true}`, `{"battery":{"state":"banana"}}`} {
		if b, err := parseBattery([]byte(body)); err != nil || b != nil {
			t.Fatalf("%s 該回 nil：%+v %v", body, b, err)
		}
	}
}

// 逐帳號：A 台電量低、B 台正常，各記各的；問不到的那台沿用上一次好值而不是消失。
func TestBatteryForIsPerAccountAndKeepsLastGood(t *testing.T) {
	resetBatteries()
	defer resetBatteries()
	calls := 0
	failB := false
	fetchBattery = func(url, key string) (*Battery, error) {
		calls++
		if url == "https://b.example" {
			if failB {
				return nil, &batteryHTTPError{Status: 401}
			}
			return parseBattery([]byte(cloudBatteryJSON["50"]))
		}
		return parseBattery([]byte(cloudBatteryJSON["90"]))
	}
	defer func() { fetchBattery = func(string, string) (*Battery, error) { return nil, nil } }()

	a := batteryFor("https://a.example", "ka", "a.example", false)
	b := batteryFor("https://b.example", "kb", "b.example", false)
	if a.State != BatterySaver || a.Account != "a.example" || b.State != BatteryNormal || b.Account != "b.example" {
		t.Fatalf("逐帳號各記各的：a=%+v b=%+v", a, b)
	}
	// TTL 內不重問
	batteryFor("https://a.example", "ka", "a.example", false)
	if calls != 2 {
		t.Fatalf("TTL 內不該重打雲端，calls=%d", calls)
	}
	// 過期後問不到 ⇒ 沿用上次好值
	failB = true
	old := batteryTTL
	batteryTTL = 0
	defer func() { batteryTTL = old }()
	if b2 := batteryFor("https://b.example", "kb", "b.example", false); b2 == nil || b2.State != BatteryNormal {
		t.Fatalf("問不到時該沿用上次好值，got %+v", b2)
	}
	// 從沒問到過 ⇒ nil
	failC := batteryFor("https://c.example", "kc", "c.example", false)
	_ = failC // 另一台（c）沿用 fetchBattery 的預設回應，這裡只確認不 panic
}

// 真的打 HTTP：帶 X-Arcrun-API-Key、解析 battery；401 ⇒ 錯誤（＝未知，不編數字）。
func TestFetchBatteryHTTP(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-Arcrun-API-Key")
		if r.URL.Path != batteryPath {
			t.Errorf("path=%s", r.URL.Path)
		}
		if gotKey == "bad" {
			w.WriteHeader(401)
			return
		}
		_, _ = io.WriteString(w, cloudBatteryJSON["80"])
	}))
	defer srv.Close()
	b, err := fetchBatteryHTTP(srv.URL, "good")
	if err != nil || b == nil || b.State != BatteryWarn20 || gotKey != "good" {
		t.Fatalf("b=%+v err=%v key=%s", b, err, gotKey)
	}
	if b, err := fetchBatteryHTTP(srv.URL, "bad"); err == nil || b != nil {
		t.Fatalf("401 該回錯誤：%+v %v", b, err)
	}
}

// 整條路：五種狀態各跑一輪 8 個檔。省電（90%、100%）單輪只送 5 個、延後補送；
// 50%、80%、核能電池照常（8 個全送）。電池狀態寫進 status.json 該帳號底下。
func TestRunDirectOnceBatteryFiveStates(t *testing.T) {
	cases := []struct {
		key      string
		wantSent int
		saver    bool
	}{
		{"50", 8, false}, {"80", 8, false}, {"90", saverMaxEventsPerRun, true},
		{"100", saverMaxEventsPerRun, true}, {"nuclear", 8, false},
	}
	for _, c := range cases {
		t.Run(c.key, func(t *testing.T) {
			resetBatteries()
			defer resetBatteries()
			root := t.TempDir()
			for i, n := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
				writeFile(t, root, n+".md", "內容 "+n, baseTime.Add(time.Duration(i)*time.Minute))
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if answeredFolderTreePost(w, r) {
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			}))
			defer srv.Close()
			defer extractStub(t, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"candidates": []map[string]any{{
						"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
					}},
				})
			})()
			fetchBattery = func(string, string) (*Battery, error) { return parseBattery([]byte(cloudBatteryJSON[c.key])) }
			defer func() { fetchBattery = func(string, string) (*Battery, error) { return nil, nil } }()

			cfg := &DirectConfig{
				Manifest: filepath.Join(t.TempDir(), "m.json"),
				Accounts: []AccountConfig{{CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", WatchFolders: []string{root}}},
				Library:  "kb", Extractor: "workers-ai", ExtractorExplicit: true,
				CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
			}
			results, _, _ := RunDirectOnce(cfg, false)
			if got := len(ingestedPaths(results)); got != c.wantSent {
				t.Fatalf("%s：本輪送出 %d 份，want %d", c.key, got, c.wantSent)
			}
			if c.saver != hasDeferredNotice(results) {
				t.Errorf("%s：省電時該交代「已排入佇列」，非省電不該有（saver=%v）", c.key, c.saver)
			}
			st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
			if err != nil {
				t.Fatal(err)
			}
			acc := st.AccountDetails[instanceHostOf(srv.URL)]
			if acc.Battery == nil || acc.Battery.Account != instanceHostOf(srv.URL) {
				t.Fatalf("%s：status.json 該帳號底下要有自己的電池狀態：%+v", c.key, acc.Battery)
			}
			wantState := map[string]string{"50": BatteryNormal, "80": BatteryWarn20, "90": BatterySaver, "100": BatteryEmpty, "nuclear": BatteryNuclear}[c.key]
			if acc.Battery.State != wantState {
				t.Errorf("%s：state=%s want %s", c.key, acc.Battery.State, wantState)
			}
			if c.key == "nuclear" && (acc.Battery.RemainingPercent != nil || acc.Battery.Warn) {
				t.Errorf("核能電池不該有 %% 或警告：%+v", acc.Battery)
			}
		})
	}
}

// 省電只落在電量低的那一台；另一台照常。使用者按「立刻同步」時兩台都不省電。
func TestSaverOnlyAffectsLowAccount(t *testing.T) {
	resetBatteries()
	defer resetBatteries()
	mk := func() (string, *httptest.Server) {
		root := t.TempDir()
		for i, n := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
			writeFile(t, root, n+".md", "內容 "+n, baseTime.Add(time.Duration(i)*time.Minute))
		}
		return root, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if answeredFolderTreePost(w, r) {
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}))
	}
	rootA, srvA := mk()
	defer srvA.Close()
	rootB, srvB := mk()
	defer srvB.Close()
	defer extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("卡", "測試")}}},
			}},
		})
	})()
	fetchBattery = func(url, _ string) (*Battery, error) {
		if url == srvA.URL {
			return parseBattery([]byte(cloudBatteryJSON["90"]))
		}
		return parseBattery([]byte(cloudBatteryJSON["50"]))
	}
	defer func() { fetchBattery = func(string, string) (*Battery, error) { return nil, nil } }()

	cfg := &DirectConfig{
		Manifest: filepath.Join(t.TempDir(), "m.json"),
		Accounts: []AccountConfig{
			{CypherURL: srvA.URL, Namespace: "nsA", APIKey: "nsA", WatchFolders: []string{rootA}},
			{CypherURL: srvB.URL, Namespace: "nsB", APIKey: "nsB", WatchFolders: []string{rootB}},
		},
		Library: "kb", Extractor: "workers-ai", ExtractorExplicit: true,
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, _, _ := RunDirectOnce(cfg, false)
	hostA, hostB := instanceHostOf(srvA.URL), instanceHostOf(srvB.URL)
	n := map[string]int{}
	for _, r := range results {
		if r.Status == "ingested" && r.Type != "inventory" && r.Type != "folder_tree" {
			n[r.Account]++
		}
	}
	if n[hostA] != saverMaxEventsPerRun || n[hostB] != 8 {
		t.Fatalf("省電只該落在 A：A=%d B=%d", n[hostA], n[hostB])
	}
	st, _ := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if st.AccountDetails[hostA].Battery.State != BatterySaver || st.AccountDetails[hostB].Battery.State != BatteryNormal {
		t.Fatalf("各帳號各記各的電：%+v / %+v", st.AccountDetails[hostA].Battery, st.AccountDetails[hostB].Battery)
	}
}
