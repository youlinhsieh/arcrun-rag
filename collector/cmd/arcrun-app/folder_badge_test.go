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
	}{
		{
			// 打勾的唯一判準：認得的檔**每一份**都送上去了，而且送上去之後沒再改過
			// （Done 的定義見 progress.go：IngestedHash != "" && == ContentHash）。
			name:  "全部送完才打勾",
			p:     collector.SyncProgress{Total: 19, Done: 19},
			known: true,
			want:  folderSyncOK,
		},
		{
			name:  "差一份就不准打勾",
			p:     collector.SyncProgress{Total: 19, Done: 18, Pending: 1},
			known: true,
			want:  folderSyncWorking,
		},
		{
			// 🔴 「沒有錯誤就打勾」的反例：沒有任何失敗，但也還沒送完。
			name:  "零錯誤但沒送完＝同步中，不是打勾",
			p:     collector.SyncProgress{Total: 133, Done: 23, Pending: 110},
			known: true,
			want:  folderSyncWorking,
		},
		{
			// leo 2026-08-28 桌面實測值：geek6688-test1（14 份全在重試、一份都沒成功，
			// 雲端回 HTTP 500 Too many subrequests）。這是「不再標成進行中」的那一格。
			name:  "一份都沒成功而且全都在重試＝警告",
			p:     collector.SyncProgress{Total: 14, Done: 0, Pending: 14, Failing: 14},
			known: true,
			want:  folderSyncTrouble,
		},
		{
			// 對照組：健康的積壓不准亮警告，不然畫面又變回「滿滿都是狀態」。
			// 實測值取自 pms（110 待處理裡只有 4 份在重試，已經成功 23 份）。
			name:  "有成功過的積壓＝同步中，不亮警告",
			p:     collector.SyncProgress{Total: 133, Done: 23, Pending: 110, Failing: 4},
			known: true,
			want:  folderSyncWorking,
		},
		{
			// 剛加進來、還沒開始送：一份都沒成功，但也還沒失敗過 ⇒ 不准嚇人。
			name:  "剛加進來還沒送＝同步中",
			p:     collector.SyncProgress{Total: 20, Done: 0, Pending: 20},
			known: true,
			want:  folderSyncWorking,
		},
		{
			// 已放棄自動重試＝**不會自己好**，就算大多數都送成功了也要講。
			name:  "有放棄重試的就亮警告",
			p:     collector.SyncProgress{Total: 4184, Done: 817, Pending: 3342, Stuck: 25, Failing: 95},
			known: true,
			want:  folderSyncTrouble,
		},
		{
			// 空資料夾不准打勾——打勾要對應「東西真的在知識庫裡」。
			name:  "沒有可整理的檔案不打勾",
			p:     collector.SyncProgress{},
			known: true,
			want:  folderSyncUnknown,
		},
		{
			// 🔴 collector 還沒回報 ⇒ 零值。舊寫法會讓它看起來「什麼問題都沒有」，
			//    在這裡它必須是 unknown，不能落到 ok。
			name:  "還沒回報過不准打勾",
			p:     collector.SyncProgress{},
			known: false,
			want:  folderSyncUnknown,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, tip := folderBadge(c.p, c.known)
			if got != c.want {
				t.Fatalf("folderBadge(%+v, known=%v) = %q，預期 %q", c.p, c.known, got, c.want)
			}
			if strings.TrimSpace(tip) == "" {
				t.Fatalf("每個狀態都要講得出自己是什麼（leo 驗收條件 3），但 tip 是空的")
			}
			// 紅線：提示句是**產品文案**，不准出現狀態碼／技術詞；也不准長成一段說明
			// （leo：「不要把長句子搬進 tooltip 裡繼續長」）。
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
