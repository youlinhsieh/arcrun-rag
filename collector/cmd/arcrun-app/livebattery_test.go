package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 雲端三種真實回應（leo 2026-10-09 總管實打）：舊版不回 %、新版回 %、都說 nuclear。
// 小幫手畫的要等於雲端當下說的：放行後不必等同步輪就變。
func TestRefreshLiveBatteryFollowsCloudNow(t *testing.T) {
	cases := []struct {
		name, body string
		wantKnown  bool
		wantPct    float64
	}{
		{"geek 舊版雲端 null", `{"success":true,"battery":{"state":"nuclear","remaining_percent":null}}`, false, 0},
		{"youlin 新版雲端 43.8", `{"success":true,"battery":{"state":"nuclear","remaining_percent":43.8,"billing":false}}`, true, 43.8},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/portal/daemon/battery" || r.Header.Get("X-Arcrun-API-Key") != "k" {
					http.Error(w, "no", 403)
					return
				}
				w.Write([]byte(c.body))
			}))
			defer srv.Close()
			acc := accountCfg{CypherURL: srv.URL, APIKey: "k"}
			host := shortHost(srv.URL)
			setLiveBattery(host, nil)
			// 先放一個過期的舊值（上一輪 status.json 的 3%），再重問
			refreshLiveBattery(acc)
			b := liveBatteryFor(host)
			if b == nil {
				t.Fatal("問到的雲端狀態應存進記憶體")
			}
			ui := accountBattery(b)
			if !ui.Paid {
				t.Fatalf("雲端說 nuclear ⇒ 要是不限用量（∞）：%+v", ui)
			}
			if ui.PctKnown != c.wantKnown || (c.wantKnown && ui.Percent != c.wantPct) {
				t.Fatalf("%s：畫面 pctKnown=%v percent=%v，雲端說 known=%v %v", c.name, ui.PctKnown, ui.Percent, c.wantKnown, c.wantPct)
			}
		})
	}
}
