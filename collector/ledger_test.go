// ledger_test.go — 送件對帳摘要（inkstone/arcrun-collector#1／Arcrun#330）。
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

func ledgerEntries() map[string]*ManifestEntry {
	return map[string]*ManifestEntry{
		"a.md":        {ContentHash: "h1", IngestedHash: "h1"},
		"b.md":        {ContentHash: "h2", IngestedHash: "h2"},
		"c.md":        {ContentHash: "h3"}, // 排隊中，沒失敗紀錄
		"d.md":        {ContentHash: "h4", FailCount: 2, LastError: captivePortalSentence + "｜憑證對不上這台知識庫"},
		"e.md":        {ContentHash: "h5", FailCount: MaxFailBeforeSkip, LastError: "回應異常：品質未過 H1"},
		"sub/f.md":    {ContentHash: "h6", FailCount: 1, LastError: "dial tcp: lookup x: no such host"},
		"copy.txt":    {ContentHash: "h7", FormatDupOf: "copy.md"},
		"scan.pdf":    {ContentHash: "h8", LastError: "這份 PDF 沒有可抽取的文字層"},
		"zz-login.md": {ContentHash: "h9", FailCount: 1, LastError: captivePortalSentence},
	}
}

func TestBuildLedgerSummary口徑(t *testing.T) {
	l := BuildLedgerSummary(ledgerEntries(), time.Unix(1786900000, 0))
	if l.Total != 7 || l.Confirmed != 2 || l.Stalled != 1 || l.Retrying != 4 {
		t.Fatalf("數字不對：%+v", l)
	}
	if l.Total != l.Confirmed+l.Retrying+l.Stalled {
		t.Errorf("total 必須等於 confirmed+retrying+stalled：%+v", l)
	}
	if l.Gap() != 5 {
		t.Errorf("Gap：%d", l.Gap())
	}
	got := map[string]LedgerReason{}
	for _, r := range l.Reasons {
		got[r.Kind] = r
	}
	if r := got[LedgerKindLoginRequired]; r.Count != 2 || r.Sample != "d.md" {
		t.Errorf("登入頁：%+v", r)
	}
	if r := got[LedgerKindNetwork]; r.Count != 1 || r.Sample != "f.md" {
		t.Errorf("斷網：%+v", r)
	}
	if r := got[LedgerKindOther]; r.Count != 1 || r.Sample != "e.md" {
		t.Errorf("其他：%+v", r)
	}
	if len(l.Reasons) != 3 {
		t.Errorf("排隊中沒有失敗紀錄的檔不該進 reasons：%+v", l.Reasons)
	}
	if l.Reasons[0].Kind != LedgerKindLoginRequired {
		t.Errorf("應依件數由多到少：%+v", l.Reasons)
	}
}

func TestLedgerReasonKind分類(t *testing.T) {
	cases := map[string]string{
		captivePortalSentence:                     LedgerKindLoginRequired,
		"x509: certificate is valid for a, not b": LedgerKindOther, // 原文本身不分類；登入頁在送出時就被包成句子
		"dial tcp: lookup h: no such host":        LedgerKindNetwork,
		"connection reset by peer":                LedgerKindNetwork,
		"雲端萃取失敗（HTTP 429）：4006: you have used up your daily free allocation of 10,000 neurons": LedgerKindQuota,
		"這份 PDF 沒有可抽取的文字層": LedgerKindUnreadable,
		"萃取 JSON 解析失敗":     LedgerKindUnreadable,
		"不知名的錯":            LedgerKindOther,
	}
	for in, want := range cases {
		if got := ledgerReasonKind(in); got != want {
			t.Errorf("%q → %q，要 %q", in, got, want)
		}
	}
}

func TestLedgerSig不含時間(t *testing.T) {
	a := BuildLedgerSummary(ledgerEntries(), time.Unix(1, 0))
	b := BuildLedgerSummary(ledgerEntries(), time.Unix(999999, 0))
	if a.Sig() != b.Sig() {
		t.Error("同一份帳本在不同時間算出的簽章必須相同")
	}
	e := ledgerEntries()
	e["c.md"].IngestedHash = "h3"
	if BuildLedgerSummary(e, time.Unix(1, 0)).Sig() == a.Sig() {
		t.Error("多送達一份，簽章必須不同")
	}
}

// 送出一發並回傳酬載；count 累計打了幾發。
func ledgerServer(t *testing.T, bodies *[]map[string]any) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(raw, &got)
		*bodies = append(*bodies, got)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
}

func TestSyncFolderTree酬載帶ledger_summary(t *testing.T) {
	var bodies []map[string]any
	srv := ledgerServer(t, &bodies)
	defer srv.Close()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	now := time.Unix(1786900000, 0)
	tree := buildTreeFromDisk(t, root).StampLedger(ledgerEntries(), now)
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	if res := syncFolderTree(cfg, root, m, tree, false, now); res == nil || res.Status != "ingested" {
		t.Fatalf("應送達：%+v", res)
	}
	ls, ok := bodies[0]["ledger_summary"].(map[string]any)
	if !ok {
		t.Fatalf("沒帶 ledger_summary：%v", bodies[0])
	}
	if ls["total"].(float64) != 7 || ls["confirmed"].(float64) != 2 || ls["retrying"].(float64) != 4 || ls["stalled"].(float64) != 1 {
		t.Errorf("欄位值不對：%v", ls)
	}
	rs := ls["reasons"].([]any)[0].(map[string]any)
	if rs["kind"] != "network_login_required" || rs["count"].(float64) != 2 || rs["sample"] != "d.md" {
		t.Errorf("reasons 形狀不對：%v", rs)
	}
	if _, ok := ls["round_at"].(string); !ok {
		t.Error("缺 round_at")
	}
}

// 沒蓋摘要（舊流程／測試）⇒ 整個欄位不出現，雲端照實顯示「這台還不會回報送件帳」。
func TestSyncFolderTree沒有摘要時不帶欄位(t *testing.T) {
	var bodies []map[string]any
	srv := ledgerServer(t, &bodies)
	defer srv.Close()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	syncFolderTree(cfg, root, m, buildTreeFromDisk(t, root), false, time.Unix(1786900000, 0))
	if _, ok := bodies[0]["ledger_summary"]; ok {
		t.Error("沒摘要卻帶了欄位")
	}
}

// 樹沒變、只有送件帳變了 ⇒ 仍要送；完全沒變 ⇒ 不送；還差件時過了重報間隔 ⇒ 再報一次（雲端才看得到「連續兩輪」）。
func TestSyncFolderTree送件帳變動才送且差件時定期重報(t *testing.T) {
	var bodies []map[string]any
	srv := ledgerServer(t, &bodies)
	defer srv.Close()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	base := buildTreeFromDisk(t, root)
	t0 := time.Unix(1786900000, 0)
	e := ledgerEntries()

	send := func(entries map[string]*ManifestEntry, at time.Time) *DirectResult {
		return syncFolderTree(cfg, root, m, base.StampLedger(entries, at), false, at)
	}
	if r := send(e, t0); r == nil || r.Status != "ingested" {
		t.Fatalf("第 1 發：%+v", r)
	}
	t1 := t0.Add(folderTreeMinInterval + time.Second)
	if r := send(e, t1); r != nil {
		t.Errorf("樹與帳都沒變、也沒到重報時間，不該送：%+v", r)
	}
	e["c.md"].IngestedHash = "h3" // 又送達一份：樹同、帳變
	if r := send(e, t1); r == nil || r.Status != "ingested" {
		t.Fatalf("帳變了應送：%+v", r)
	}
	n := len(bodies)
	t2 := t1.Add(ledgerRepeatInterval + time.Minute)
	if r := send(e, t2); r == nil {
		t.Fatal("還差件、過了重報間隔，應再報一次")
	}
	if len(bodies) != n+1 {
		t.Errorf("應多一發")
	}
	// 差 0 件：不重報
	all := map[string]*ManifestEntry{"a.md": {ContentHash: "h1", IngestedHash: "h1"}}
	t3 := t2.Add(folderTreeMinInterval + time.Second)
	if r := send(all, t3); r == nil {
		t.Fatal("差 0 件的那一刻是變動，要送")
	}
	t4 := t3.Add(ledgerRepeatInterval + time.Minute)
	if r := send(all, t4); r != nil {
		t.Errorf("差 0 件不該定期重報：%+v", r)
	}
}
