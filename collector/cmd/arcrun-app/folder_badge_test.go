package main

import (
	"strings"
	"testing"

	collector "arcrun-rag/collector"
)

// TestFolderBadge 守住「打勾是真的」這條紅線（`inkstone/arcrun-rag#159`）。
//
// leo 的紅線原文：「打勾要是**真的**：說得出『打勾』的判準是什麼，
// **不能是『沒有錯誤就打勾』**」。
// ⇒ 下面每一格都在問同一件事：**這個狀態對應得上 manifest 裡的哪個事實？**
func TestFolderBadge(t *testing.T) {
	cases := []struct {
		name  string
		p     collector.SyncProgress
		known bool
		want  string
		errs  int
	}{
		{name: "全部送完才打勾", p: collector.SyncProgress{Total: 19, Done: 19}, known: true, want: folderSyncOK},
		{name: "差一份就不准打勾", p: collector.SyncProgress{Total: 19, Done: 18, Pending: 1}, known: true, want: folderSyncWorking},
		{name: "零錯誤但沒送完＝同步中，不是打勾", p: collector.SyncProgress{Total: 133, Done: 23, Pending: 110}, known: true, want: folderSyncWorking},
		{name: "剛加進來還沒送＝同步中", p: collector.SyncProgress{Total: 20, Done: 0, Pending: 20}, known: true, want: folderSyncWorking},
		// 兩個維度獨立（#240 c18410）：出錯的檔不擋其他檔，進度照常前進。
		{name: "同步中＋有錯：進度照走，出錯另算", p: collector.SyncProgress{Total: 133, Done: 23, Pending: 110, Failing: 4}, known: true, want: folderSyncWorking, errs: 4},
		{name: "已完成＋有錯：除了出錯的以外都送完＝完成", p: collector.SyncProgress{Total: 1034, Done: 1030, Stuck: 4}, known: true, want: folderSyncOK, errs: 4},
		{name: "放棄重試很多、其餘還在送＝同步中", p: collector.SyncProgress{Total: 4184, Done: 817, Pending: 3342, Stuck: 25, Failing: 95}, known: true, want: folderSyncWorking, errs: 120},
		{name: "全部都出錯＝沒有可同步的（不打勾）", p: collector.SyncProgress{Total: 14, Done: 0, Pending: 14, Failing: 14}, known: true, want: folderSyncUnknown, errs: 14},
		{name: "沒有可整理的檔案不打勾", p: collector.SyncProgress{}, known: true, want: folderSyncUnknown},
		{name: "還沒回報過不准打勾", p: collector.SyncProgress{}, known: false, want: folderSyncUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, tip := folderBadge(c.p, c.known)
			if got != c.want {
				t.Fatalf("folderBadge(%+v, known=%v) = %q，預期 %q", c.p, c.known, got, c.want)
			}
			if c.known && folderErrors(c.p) != c.errs {
				t.Fatalf("出錯份數 = %d，預期 %d", folderErrors(c.p), c.errs)
			}
			if strings.TrimSpace(tip) == "" {
				t.Fatal("每個狀態都要講得出自己是什麼，但 tip 是空的")
			}
			for _, bad := range []string{"HTTP", "500", "error", "token", "manifest", "pending", "stuck"} {
				if strings.Contains(strings.ToLower(tip), strings.ToLower(bad)) {
					t.Fatalf("提示句出現技術詞 %q：%q", bad, tip)
				}
			}
			if n := len([]rune(tip)); n > 20 {
				t.Fatalf("提示句 %d 字，太長了（上限 20）：%q", n, tip)
			}
		})
	}
}
