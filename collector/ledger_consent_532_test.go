package collector

import (
	"testing"
	"time"
)

// inkstone/Arcrun#532：Portal 的決定要能從 folder-tree 回應讀回來；不合法的一律當沒有。
func TestParseConsentDecision(t *testing.T) {
	ok := ParseConsentDecision(`{"success":true,"consent":{"fingerprint":"fp1","sha":"ab","decision":"agree"}}`)
	if ok == nil || ok.Decision != "agree" || ok.Fingerprint != "fp1" || ok.SHA != "ab" {
		t.Fatalf("合法決定沒讀到：%+v", ok)
	}
	for _, bad := range []string{
		`{"success":true}`,
		`{"consent":{"fingerprint":"fp1","sha":"ab","decision":"maybe"}}`,
		`{"consent":{"fingerprint":"","sha":"ab","decision":"agree"}}`,
		`{"consent":{"fingerprint":"fp1","sha":"","decision":"dismiss"}}`,
		`not json`,
	} {
		if d := ParseConsentDecision(bad); d != nil {
			t.Errorf("%q 應當沒有決定，卻得到 %+v", bad, d)
		}
	}
}

func TestConsentSHAStable(t *testing.T) {
	if ConsentSHA("a") != ConsentSHA("a") || ConsentSHA("a") == ConsentSHA("b") {
		t.Fatal("簽章要對同一份原文穩定、對不同原文不同")
	}
}

// 有提問時才帶 consent；asked 以外的狀態不帶。
func TestStampLedgerAttachesConsentOnlyWhenAsked(t *testing.T) {
	defer func() { ConsentPreviewHook = nil }()
	calls := 0
	ConsentPreviewHook = func(host string) *LedgerConsent {
		calls++
		return &LedgerConsent{Fingerprint: "fp", SHA: "s", Preview: "p"}
	}
	c := &DirectConfig{CypherURL: "https://x.example.workers.dev"}
	tree := FolderTree{}
	// 沒有任何失敗檔：不是 asked，不該呼叫 hook
	out := c.stampLedger(tree, map[string]*ManifestEntry{}, time.Now())
	if out.Ledger.Consent != nil || calls != 0 {
		t.Fatalf("沒有提問卻帶了 consent：%+v calls=%d", out.Ledger.Consent, calls)
	}
}
