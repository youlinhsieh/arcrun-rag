package collector

import (
	"testing"
	"time"
)

func TestLedgerTopLevel_330(t *testing.T) {
	now := time.Now()
	cut := &ManifestEntry{ContentHash: "h", FailCount: 12, LastError: "本地萃取失敗：連線在中途被切斷（read: connection reset by peer）"}
	mk := func() map[string]*ManifestEntry { return map[string]*ManifestEntry{"a.pdf": cut} }

	l := BuildLedgerSummaryFor(mk(), now, "h1", nil)
	if l.FixState != "asked" || l.Report != nil || l.UserAction != nil {
		t.Fatalf("修不了該是 asked：%+v", l)
	}
	st := &HelpStore{}
	st.Set("h1", "connection_cut", HelpEntry{State: HelpStateReported, At: now.UTC().Format(time.RFC3339), Ticket: "inkstone/arcrun-rag#1707"})
	l = BuildLedgerSummaryFor(mk(), now, "h1", st)
	if l.FixState != "reported" || l.Report == nil || l.Report.Ticket != "inkstone/arcrun-rag#1707" || l.Report.Status != "open" {
		t.Fatalf("已通報要帶票號：%+v", l)
	}
	young := map[string]*ManifestEntry{"b.pdf": {ContentHash: "h", FailCount: 2, LastError: "連線在中途被切斷（x）"}}
	if l := BuildLedgerSummaryFor(young, now, "h1", nil); l.FixState != "trying" {
		t.Fatalf("才失敗 2 次是 trying：%+v", l)
	}
	login := map[string]*ManifestEntry{"c": {ContentHash: "h", FailCount: 1, LastError: captivePortalSentence}}
	if l := BuildLedgerSummaryFor(login, now, "h1", nil); l.UserAction == nil || l.UserAction.Kind != "network_login" {
		t.Fatalf("登入頁要帶 user_action：%+v", l)
	}
}
