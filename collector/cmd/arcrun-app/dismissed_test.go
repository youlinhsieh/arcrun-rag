package main

import (
	"testing"
	"time"

	"arcrun-rag/collector"
)

// 警示的生命週期（#240 c18340／c18341）：回報＝已處理、× 關閉＝記住；同一原因不再亮，
// 份數變多不算新狀況，換了原因（或隔天再爆額度）才是新狀況；重開 App（重讀檔）仍不亮。
func TestDismissedAlertsStayGone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	mk := func(count int, fp string) UIState {
		return UIState{
			Stalls:   []UIStall{{Fingerprint: fp, Account: "geek", Count: count, Label: "x"}, {Fingerprint: "fp-rep", Account: "geek", Count: 9, Label: "y", Reported: true}},
			Quota:    &collector.QuotaNotice{Kind: "d1_write", Account: "geek", ResumeAt: "2026-10-10T00:00:00Z"},
			Accounts: []UIAccount{{Name: "geek", Host: "h", Battery: &UIBattery{Percent: 18, Level: "warn", Warning: "⚠ 用量 18%"}}},
			Skipped:  &UISkipped{Files: []string{"a"}},
		}
	}
	st := mk(5, "fp1")
	applyDismissals(&st)
	if len(st.Stalls) != 1 || st.Stalls[0].Fingerprint != "fp1" {
		t.Fatalf("已回報的停工不再亮，只剩 fp1：%+v", st.Stalls)
	}
	if st.Quota == nil || st.Accounts[0].Battery.Warning == "" || st.Skipped == nil {
		t.Fatal("沒關閉前都該亮")
	}
	for _, k := range []string{st.Stalls[0].DismissKey, st.Quota.DismissKey, st.Accounts[0].Battery.DismissKey, st.Skipped.DismissKey} {
		if k == "" {
			t.Fatal("每則警示都要帶可關閉的鍵")
		}
		if err := (&App{}).Dismiss(k); err != nil {
			t.Fatal(err)
		}
	}
	// 重開 App（重新讀檔）：份數變多不算新狀況
	again := mk(50, "fp1")
	applyDismissals(&again)
	if len(again.Stalls) != 0 || again.Quota != nil || again.Accounts[0].Battery.Warning != "" || again.Skipped != nil {
		t.Fatalf("關閉過的同一原因，份數變多也不該再亮：%+v", again)
	}
	// 新的原因、隔天再爆額度＝新狀況，要再亮
	fresh := mk(5, "fp-new")
	fresh.Quota.ResumeAt = "2026-10-11T00:00:00Z"
	applyDismissals(&fresh)
	if len(fresh.Stalls) != 1 || fresh.Quota == nil {
		t.Fatalf("新原因／隔天的額度要再亮：%+v", fresh)
	}
	_ = time.Now
}

// 鍵可以含逗號、引號、JSON：寫進檔、重讀都要完全一致（#240 c18374）。
func TestDismissKeyWithQuotesAndCommasRoundTrips(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	key := `stall:host.workers.dev|other:HTTP N：{"success":false,"data":{"x":1}}`
	st := UIState{Stalls: []UIStall{{Fingerprint: `host.workers.dev|other:HTTP N：{"success":false,"data":{"x":1}}`, Account: "geek", Count: 4, Label: "x"}}}
	applyDismissals(&st)
	if len(st.Stalls) != 1 || st.Stalls[0].DismissKey != key {
		t.Fatalf("鍵應原樣帶出：%q", st.Stalls[0].DismissKey)
	}
	if err := (&App{}).Dismiss(st.Stalls[0].DismissKey); err != nil {
		t.Fatal(err)
	}
	again := UIState{Stalls: []UIStall{{Fingerprint: `host.workers.dev|other:HTTP N：{"success":false,"data":{"x":1}}`, Account: "geek", Count: 99, Label: "x"}}}
	applyDismissals(&again)
	if len(again.Stalls) != 0 {
		t.Fatalf("關閉過就不該再亮：%+v", again.Stalls)
	}
}
