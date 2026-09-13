package main

import (
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
)

// TestSyncingSubSaysWhereAndWhy 守住 `inkstone/arcrun-rag#200`：
// 「同步中」底下那一行要講得出做到哪、卡在哪，不再是一句永遠不變的「請稍候」。
func TestSyncingSubSaysWhereAndWhy(t *testing.T) {
	now := time.Date(2026, 9, 14, 0, 30, 0, 0, time.Local)
	label := func(host string) string {
		if host == "arcrun-cypher-executor.leo21c.workers.dev" {
			return "leo21c"
		}
		return host
	}
	fresh := now.Add(-10 * time.Second).Format(time.RFC3339)

	cases := []struct {
		name string
		in   *collector.RoundProgress
		want []string // 全部都要出現
		not  []string // 一個都不准出現
	}{
		{
			name: "舊版 collector 沒寫 in_round＝沿用原本那句",
			in:   nil,
			want: []string{syncingSubFallback},
		},
		{
			name: "正在送＝講資料夾、知識庫、哪件事、送了幾份",
			in: &collector.RoundProgress{
				Account: "arcrun-cypher-executor.leo21c.workers.dev", Folder: "/Users/x/Documents/tech_projects/ISEP",
				Step: "送出一份筆記", Ingested: 11, UpdatedAt: fresh,
			},
			want: []string{"正在處理 ISEP（leo21c）", "送出一份筆記", "這一輪已送上 11 份"},
			not:  []string{"請稍候", "分鐘沒有新進展"},
		},
		{
			name: "卡住＝只講卡在哪",
			in: &collector.RoundProgress{
				Account: "arcrun-cypher-executor.leo21c.workers.dev", Folder: "/Users/x/Documents/KB",
				Step: "送出目錄索引", UpdatedAt: fresh,
				Waiting: &collector.StalledCall{Step: "送出目錄索引",
					Note: "還在等知識庫「arcrun-cypher-executor.leo21c.workers.dev」回覆「送出目錄索引」，已經等了 30 秒。"},
			},
			want: []string{"卡在「KB（leo21c）」", "已經等了 30 秒"},
			not:  []string{"請稍候", "正在處理"},
		},
		{
			name: "很久沒有任何寫入＝明講沒在動",
			in: &collector.RoundProgress{
				Account: "arcrun-cypher-executor.leo21c.workers.dev", Step: "確認雲端 AI 可不可以用",
				UpdatedAt: now.Add(-12 * time.Minute).Format(time.RFC3339),
			},
			want: []string{"正在處理 leo21c", "已經 12 分鐘沒有新進展"},
		},
		{
			name: "有失敗也要說",
			in: &collector.RoundProgress{
				Account: "h", Folder: "/a/B", Ingested: 2, Failed: 1, UpdatedAt: fresh,
			},
			want: []string{"這一輪已送上 2 份", "1 份沒送成功"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := syncingSub(c.in, now, label)
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Errorf("缺「%s」：%q", w, got)
				}
			}
			for _, n := range c.not {
				if strings.Contains(got, n) {
					t.Errorf("不該出現「%s」：%q", n, got)
				}
			}
		})
	}
}
