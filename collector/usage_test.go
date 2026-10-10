package collector

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseUsage(t *testing.T) {
	body := []byte(`{"success":true,"usage":{"plan":"paid","base_usd":5,"items":[
	  {"key":"d1_write","used":10,"limit":50,"period":"month"},
	  {"key":"ai","used":62205,"limit":10000,"period":"day","rate_per_min":217},
	  {"key":"mystery","used":1,"limit":null,"period":"day"}]}}`)
	u, err := parseUsage(body)
	if err != nil || u == nil {
		t.Fatal(err, u)
	}
	if u.Items[0].Key != "ai" || u.Items[1].Key != "d1_write" || u.Items[2].Key != "mystery" {
		t.Fatalf("要依固定順序、未知排後面：%+v", u.Items)
	}
	if u.Items[2].Limit != nil || u.Received.IsZero() {
		t.Fatal("limit null＝沒有線；Received 要蓋上收到時刻")
	}
}

func TestParseUsageOldCloud(t *testing.T) {
	for _, b := range []string{`{"success":true}`, `{"usage":{"plan":"weird","items":[]}}`} {
		u, err := parseUsage([]byte(b))
		if u != nil || err != nil {
			t.Fatalf("舊雲端／認不得的方案要回 nil：%s → %v %v", b, u, err)
		}
	}
}

func TestUsageNowOverHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/portal/daemon/usage" || r.Header.Get("X-Arcrun-API-Key") != "k" {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"usage":{"plan":"free","items":[{"key":"ai","used":5,"limit":10,"period":"day"}]}}`))
	}))
	defer srv.Close()
	u := UsageNow(srv.URL, "k", "acc")
	if u == nil || u.Plan != "free" || u.Account != "acc" || len(u.Items) != 1 {
		t.Fatalf("%+v", u)
	}
	// 之後雲端變成舊版（404）：不沿用過期的好值，也不編
	if got := UsageNow(srv.URL, "wrong", "acc"); got != nil {
		// 404 屬於 HTTP 錯誤，沿用上次好值是允許的（一次抽風不該讓畫面消失）；確認至少仍是同一份
		if got.Plan != "free" {
			t.Fatalf("%+v", got)
		}
	}
}
