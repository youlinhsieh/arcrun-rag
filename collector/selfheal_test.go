package collector

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #330：leo 11-11 的那份送件帳——NRI 兩件、連續 9 輪以上、同一種失敗。

func nriEntries(fails int, lastErr string) map[string]*ManifestEntry {
	return map[string]*ManifestEntry{
		"ok.md":     {ContentHash: "h0", IngestedHash: "h0"},
		"NRI-1.pdf": {ContentHash: "h1", FailCount: fails, LastError: lastErr},
		"NRI-2.pdf": {ContentHash: "h2", FailCount: fails, LastError: lastErr},
	}
}

const cutErr = "連線在中途被切斷（Post \"https://h/portal/daemon/extract\": unexpected EOF）"

func onlyReason(t *testing.T, l *LedgerSummary) LedgerReason {
	t.Helper()
	if len(l.Reasons) != 1 {
		t.Fatalf("reasons：%+v", l.Reasons)
	}
	return l.Reasons[0]
}

func TestHandling_剛開始失敗自己修不打擾(t *testing.T) {
	r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(3, cutErr), time.Unix(1, 0), "h", nil))
	if r.Kind != LedgerKindConnectionCut || r.Handling != HandlingSelfHeal {
		t.Fatalf("%+v", r)
	}
}

func TestHandling_續試也用完才問用戶(t *testing.T) {
	// 這種原因會自動續試，滿 8 次不算停工，要再多 4 次（stalledEntry）。
	if r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(9, cutErr), time.Unix(1, 0), "h", nil)); r.Handling != HandlingSelfHeal {
		t.Fatalf("續試還沒用完不該問：%+v", r)
	}
	r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(12, cutErr), time.Unix(1, 0), "h", nil))
	if r.Handling != HandlingAsked || r.Kind != LedgerKindConnectionCut {
		t.Fatalf("%+v", r)
	}
}

func TestHandling_用戶同意後帶票號_不同意回到自修(t *testing.T) {
	now := time.Unix(1790000000, 0)
	st := &HelpStore{}
	st.Set("h", LedgerKindConnectionCut, HelpEntry{State: HelpStateReported, At: now.Add(-time.Hour).UTC().Format(time.RFC3339), Ticket: "inkstone/arcrun-rag#999"})
	r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(12, cutErr), now, "h", st))
	if r.Handling != HandlingReported || r.Ticket != "inkstone/arcrun-rag#999" || r.ReportedAt == "" {
		t.Fatalf("%+v", r)
	}
	// 別台知識庫的決定不能串過來
	if r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(12, cutErr), now, "other-host", st)); r.Handling != HandlingAsked {
		t.Fatalf("%+v", r)
	}
	st.Set("h", LedgerKindConnectionCut, HelpEntry{State: HelpStateDeclined, At: now.Add(-time.Hour).UTC().Format(time.RFC3339)})
	if r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(12, cutErr), now, "h", st)); r.Handling != HandlingSelfHeal {
		t.Fatalf("說不用了就不再問：%+v", r)
	}
	// 7 天後同一個原因還卡著，再問一次
	if r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(12, cutErr), now.Add(8*24*time.Hour), "h", st)); r.Handling != HandlingAsked {
		t.Fatalf("不用了過期後要再問：%+v", r)
	}
}

func TestHandling_只有用戶動手才解得開的才叫用戶(t *testing.T) {
	r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(2, captivePortalSentence), time.Unix(1, 0), "h", nil))
	if r.Kind != LedgerKindLoginRequired || r.Handling != HandlingUserAction || r.UserAction != UserActionLoginNetwork {
		t.Fatalf("%+v", r)
	}
	// 即使用戶先前按過通報，登入網路這件事還是用戶的事
	st := &HelpStore{}
	st.Set("h", LedgerKindLoginRequired, HelpEntry{State: HelpStateReported, At: time.Now().UTC().Format(time.RFC3339), Ticket: "x/y#1"})
	if r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(2, captivePortalSentence), time.Now(), "h", st)); r.Handling != HandlingUserAction {
		t.Fatalf("%+v", r)
	}
}

func TestHandling_本機斷網與額度都是自己等_不問用戶(t *testing.T) {
	for _, e := range []string{"dial tcp: lookup h: no such host", "雲端萃取失敗（HTTP 429）：4006: you have used up your daily free allocation of 10,000 neurons"} {
		r := onlyReason(t, BuildLedgerSummaryFor(nriEntries(30, e), time.Unix(1, 0), "h", nil))
		if r.Handling != HandlingSelfHeal {
			t.Errorf("%q → %+v", e, r)
		}
	}
}

func TestHandling_舊協定欄位不動(t *testing.T) {
	b, _ := json.Marshal(BuildLedgerSummary(nriEntries(3, cutErr), time.Unix(1, 0)))
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"round_at", "total", "confirmed", "retrying", "stalled", "reasons"} {
		if _, ok := m[k]; !ok {
			t.Errorf("舊欄位 %s 不見了", k)
		}
	}
	rs := m["reasons"].([]any)[0].(map[string]any)
	for _, k := range []string{"kind", "count", "sample"} {
		if _, ok := rs[k]; !ok {
			t.Errorf("reasons 舊欄位 %s 不見了", k)
		}
	}
}

func TestHelpStore_存取與過期(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "help-state.json")
	st := LoadHelpStore(p)
	if len(st.Items) != 0 {
		t.Fatal("不存在的檔要回空的")
	}
	now := time.Now()
	st.Set("h", "connection_cut", HelpEntry{State: HelpStateReported, At: now.UTC().Format(time.RFC3339), Ticket: "inkstone/arcrun-rag#1"})
	if err := st.Save(p); err != nil {
		t.Fatal(err)
	}
	got := LoadHelpStore(p)
	if e, ok := got.Lookup("h", "connection_cut", now); !ok || e.Ticket != "inkstone/arcrun-rag#1" {
		t.Fatalf("%+v %v", e, ok)
	}
	if _, ok := got.Lookup("h", "connection_cut", now.Add(31*24*time.Hour)); ok {
		t.Fatal("已通報 30 天後要過期")
	}
	if !strings.HasSuffix(HelpStatePath("/a/b/manifest.json"), "/a/b/help-state.json") {
		t.Fatal(HelpStatePath("/a/b/manifest.json"))
	}
}
