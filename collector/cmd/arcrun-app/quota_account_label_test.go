// quota_account_label_test.go — inkstone/arcrun-rag#207：collector 只填得出技術 host
// （instanceHostOf 的產物），App 端要換成使用者看得懂的名字，讓「爆的是哪一台」真的讀得懂。
package main

import (
	"testing"
	"time"

	collector "arcrun-rag/collector"
)

func TestAccountLabel_UsesMatchingUIAccountName(t *testing.T) {
	accounts := []UIAccount{
		{Name: "leo21c", Host: "arcrun-cypher-executor.leo21c.workers.dev"},
		{Name: "youlin", Host: "arcrun-cypher-executor.youlin-hsieh-dev.workers.dev"},
	}
	got := accountLabel(accounts, "arcrun-cypher-executor.youlin-hsieh-dev.workers.dev")
	if got != "youlin" {
		t.Fatalf("應該換成使用者取的暱稱 youlin，got %q", got)
	}
}

func TestAccountLabel_FallsBackToHostWhenNoMatch(t *testing.T) {
	accounts := []UIAccount{{Name: "leo21c", Host: "arcrun-cypher-executor.leo21c.workers.dev"}}
	host := "arcrun-cypher-executor.someone-else.workers.dev"
	if got := accountLabel(accounts, host); got != host {
		t.Fatalf("找不到對應帳號時應照原樣回傳 host，got %q want %q", got, host)
	}
}

// 兩台帳號、只有一台爆——票上的驗收情境，釘在 pickQuotaNotice 這一層：挑出來的通知
// 要原樣帶著爆掉那台的 Account（跟既有的 quota_card_test.go 同一套 mkNotice 慣例，
// 這裡額外釘住 Account 沒有在「挑最早恢復」的過程中被弄丟）。
func TestPickQuotaNotice_MultiAccountKeepsWhichOneHit(t *testing.T) {
	now := time.Date(2026, 9, 19, 9, 0, 0, 0, time.UTC)
	resumeAt := now.Add(3 * time.Hour)
	notice := mkNotice(resumeAt, 0)
	notice.Kind = "d1_read"
	notice.Account = "arcrun-cypher-executor.youlin-hsieh-dev.workers.dev"

	s := syncStatus{AccountDetails: map[string]collector.AccountSyncStatus{
		"arcrun-cypher-executor.leo21c.workers.dev":           {}, // 付費那台沒事，沒有 QuotaMessage
		"arcrun-cypher-executor.youlin-hsieh-dev.workers.dev": {QuotaMessage: notice},
	}}
	q := pickQuotaNotice(s, now)
	if q == nil {
		t.Fatal("免費那台還在冷卻中，應該挑得到通知")
	}
	if q.Account != "arcrun-cypher-executor.youlin-hsieh-dev.workers.dev" {
		t.Errorf("挑出來的通知要保留是哪一台爆的，got %q", q.Account)
	}
}
