package main

import (
	"testing"

	collector "arcrun-rag/collector"
)

// #240 c18615：三態（在跑／完成／沒在跑：有解、無解），且「打勾」與「有卡住」不會同時出現。
func TestActivityOf(t *testing.T) {
	sp := func(total, done, pending, stuck, fix int, why string) collector.SyncProgress {
		return collector.SyncProgress{Total: total, Done: done, Pending: pending, Stuck: stuck, StuckFix: fix, StuckWhy: why}
	}
	cases := []struct {
		name  string
		in    activityIn
		state string
		n     int
	}{
		{"有排隊、引擎活、近一小時有送出＝在跑", activityIn{P: sp(100, 60, 40, 0, 0, ""), Known: true, Alive: true, SentHour: 12}, actRunning, 0},
		{"有排隊、近一小時一份都沒送＝無解（我們的問題，要回報）", activityIn{P: sp(100, 60, 40, 0, 0, ""), Known: true, Alive: true, SentHour: 0}, actUnsolvable, 0},
		{"有排隊、額度用完＝有解", activityIn{P: sp(100, 60, 40, 0, 0, ""), Known: true, Alive: true, Blocked: true, SentHour: 0}, actFixable, 0},
		{"有排隊、引擎沒活＝無解", activityIn{P: sp(100, 60, 40, 0, 0, ""), Known: true, Alive: false, SentHour: -1}, actUnsolvable, 0},
		{"全送完＝完成", activityIn{P: sp(100, 100, 0, 0, 0, ""), Known: true, Alive: true, SentHour: 0}, actDone, 0},
		{"已打勾但有 8 份卡住＝不是完成（KB 的實況）", activityIn{P: sp(591, 583, 0, 8, 8, "檔案太大"), Known: true, Alive: true, SentHour: 0}, actFixable, 8},
		{"卡住的有一部分是新問題＝無解，數字是出錯總數（與排隊互斥）", activityIn{P: sp(50, 40, 0, 10, 6, "讀不出字"), Known: true, Alive: true, SentHour: 0}, actUnsolvable, 10},
		{"還不知道＝unknown", activityIn{P: sp(0, 0, 0, 0, 0, ""), Known: false, Alive: true, SentHour: -1}, actUnknown, 0},
	}
	for _, c := range cases {
		o := activityOf(c.in)
		if o.State != c.state || o.N != c.n {
			t.Errorf("%s：得到 %s/%d，要 %s/%d", c.name, o.State, o.N, c.state, c.n)
		}
		if c.state == actFixable && o.Why == "" {
			t.Errorf("%s：有解必須講出問題", c.name)
		}
	}
}

// #246 c18681：可讀檔 ＝ 已上傳 ＋ 待上傳 ＋ 出錯，三者互斥；帳號與各資料夾加總對得上；
// 「!」的數字不再等於排隊數（leo 實撞：!7 與 排隊 7 是同一批，加起來 57 ≠ 54）。
func TestProgressIdentity(t *testing.T) {
	folders := []collector.SyncProgress{
		{Total: 19, Done: 18, Pending: 1, Stuck: 0, Failing: 1}, // 失敗等重試的算出錯，不算待上傳
		{Total: 9, Done: 8, Pending: 0, Stuck: 1},
		{Total: 19, Done: 11, Pending: 5, Stuck: 3, Failing: 2},
		{Total: 7, Done: 6, Pending: 1, Failing: 1},
	}
	var sum collector.SyncProgress
	errs := 0
	for _, f := range folders {
		if f.Done+f.Waiting()+f.Errors() != f.Total {
			t.Errorf("資料夾 %+v：已上傳 %d＋待上傳 %d＋出錯 %d ≠ %d", f, f.Done, f.Waiting(), f.Errors(), f.Total)
		}
		errs += folderErrors(f)
		sum = sum.Add(f)
	}
	if sum.Done+sum.Waiting()+sum.Errors() != sum.Total {
		t.Errorf("帳號加總不對：%d＋%d＋%d ≠ %d", sum.Done, sum.Waiting(), sum.Errors(), sum.Total)
	}
	if errs != sum.Errors() {
		t.Errorf("資料夾 !N 加總 %d ≠ 帳號 !N %d", errs, sum.Errors())
	}
	if up := buildProgress(syncStatus{Progress: sum}); up.Total != up.Done+up.Waiting+up.Errors {
		t.Errorf("UIProgress 恆等式不成立：%+v", up)
	}
}
