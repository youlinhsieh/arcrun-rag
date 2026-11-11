package collector

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestPrintLedgerManual(t *testing.T) {
	if os.Getenv("PRINT_LEDGER_330") == "" {
		t.Skip()
	}
	now := time.Now()
	e := map[string]*ManifestEntry{"NRI.pdf": {ContentHash: "h", FailCount: 12, LastError: "連線在中途被切斷（read: connection reset by peer）"}}
	st := &HelpStore{}
	st.Set("h1", "connection_cut", HelpEntry{State: HelpStateReported, At: now.UTC().Format(time.RFC3339), Ticket: "inkstone/arcrun-rag#1708"})
	for name, s := range map[string]*HelpStore{"asked": nil, "reported": st} {
		b, _ := json.Marshal(BuildLedgerSummaryFor(e, now, "h1", s))
		fmt.Printf("LEDGER_%s=%s\n", name, b)
	}
}
