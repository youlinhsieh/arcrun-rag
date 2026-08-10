package main

// quota_card_test.go — P8（2026-08-09）：額度三句話從 status.json 到首頁那張卡的佈線測試。
//
// 背景：collector 08-07 就把 QuotaNotice 寫進 status.json（account_details[].quota_message），
// 但 App 端從來沒接——使用者撞額度只看得到「送不上去 N 份」。這裡釘住 pickQuotaNotice 的
// 三個行為：有效冷卻要撿到、過期快照不准顯示（不然會說「明天早上 8 點恢復」的謊）、
// 多帳號挑最早恢復的那份。

import (
	"testing"
	"time"

	collector "arcrun-rag/collector"
)

func mkNotice(resumeAt time.Time, n int) *collector.QuotaNotice {
	return &collector.QuotaNotice{
		Achievement: "今天已經幫你整理了 105 份",
		ExitOptions: "可以換一個模型，或升級 Cloudflare（每月 5 美元）",
		Guarantee:   "不花錢也沒關係，明天早上 8:00 會自動恢復、會接著跑",
		ResumeAt:    resumeAt.Format(time.RFC3339),
	}
}

func TestPickQuotaNotice_ActiveCooldownIsShown(t *testing.T) {
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	s := syncStatus{AccountDetails: map[string]collector.AccountSyncStatus{
		"youlin.example": {QuotaMessage: mkNotice(now.Add(3*time.Hour), 105)},
	}}
	q := pickQuotaNotice(s, now)
	if q == nil {
		t.Fatal("冷卻還沒到期，首頁應該要拿到三句話")
	}
	if q.Achievement == "" || q.ExitOptions == "" || q.Guarantee == "" {
		t.Fatalf("三句話缺一不可（leo 08-07 骨架）：%+v", q)
	}
}

func TestPickQuotaNotice_StaleSnapshotIsHidden(t *testing.T) {
	// daemon 整夜沒跑（電腦闔蓋），status.json 停在昨天的快照——額度其實已恢復。
	// 這時再顯示「明天早上 8 點恢復」就是在說謊 ⇒ 過期＝不畫。
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	s := syncStatus{AccountDetails: map[string]collector.AccountSyncStatus{
		"youlin.example": {QuotaMessage: mkNotice(now.Add(-time.Hour), 105)},
	}}
	if q := pickQuotaNotice(s, now); q != nil {
		t.Fatalf("過期快照不准顯示，got %+v", q)
	}
	// ResumeAt 解析不了 ⇒ 同樣不畫（寧可少顯示，不顯示錯的承諾）
	bad := mkNotice(now.Add(time.Hour), 1)
	bad.ResumeAt = "not-a-time"
	s.AccountDetails["youlin.example"] = collector.AccountSyncStatus{QuotaMessage: bad}
	if q := pickQuotaNotice(s, now); q != nil {
		t.Fatalf("ResumeAt 壞掉不准顯示，got %+v", q)
	}
}

func TestPickQuotaNotice_MultiAccountPicksEarliestResume(t *testing.T) {
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	early := mkNotice(now.Add(1*time.Hour), 40)
	late := mkNotice(now.Add(5*time.Hour), 80)
	s := syncStatus{AccountDetails: map[string]collector.AccountSyncStatus{
		"b.example": {QuotaMessage: late},
		"a.example": {QuotaMessage: early},
	}}
	q := pickQuotaNotice(s, now)
	if q == nil || q.ResumeAt != early.ResumeAt {
		t.Fatalf("多帳號應挑最早恢復的那份，got %+v", q)
	}
}
