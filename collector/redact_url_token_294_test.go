package collector

import (
	"strings"
	"testing"
)

// 2026-11-11 leo21c 上實見：Telegram bot token 寫在 setWebhook 網址的路徑裡、還帶 secret_token 參數，
// 遮蔽與 H5 都沒攔。值是執行時組出的假值，repo 裡沒有任何真值。
func TestRedact_294_TokenInsideURL(t *testing.T) {
	botTok := "8123456789:" + "AAH" + strings.Repeat("xY7_k", 7)
	sec := "s3" + strings.Repeat("Qw9", 5)
	in := "- 設 webhook\n\t- `curl \"https://api.telegram.org/bot" + botTok + "/setWebhook?url=https://example.com/hook&secret_token=" + sec + "\"`\n" +
		"- 環境變數 `TELEGRAM_BOT_TOKEN`，說明網址 https://api.telegram.org/bot<token>/getMe\n" +
		"- 範例 ?token={{token}} 與 ?secret_token=<secret> 不是真值\n" +
		"- 時間 12:30 與 page?id=12345678 照常"
	out, rep := redactSecretText(in, true)
	if strings.Contains(out, botTok) || strings.Contains(out, botTok[strings.Index(botTok, ":")+1:]) || strings.Contains(out, sec) {
		t.Fatalf("原值還在：%s", out)
	}
	if rep.Count != 2 {
		t.Fatalf("應遮 2 處（bot token 一處＋secret_token 一處），實際 %d：%v", rep.Count, rep.Labels)
	}
	for _, want := range []string{
		"https://api.telegram.org/bot〔機敏值，未萃取：請看原檔第 2 行〕/setWebhook",
		"&secret_token=〔機敏值，未萃取：請看原檔第 2 行〕",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("應留網址骨架、只換值：缺 %q\n%s", want, out)
		}
	}
	for _, keep := range []string{"bot<token>/getMe", "?token={{token}}", "?secret_token=<secret>", "12:30", "page?id=12345678"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("不是機敏值的不該動：%q 不見了\n%s", keep, out)
		}
	}
	if hits := scanSecrets(out); len(hits) != 0 {
		t.Fatalf("遮過的文字 H5 不該再命中：%v", hits)
	}
	if hits := scanSecrets(in); len(hits) == 0 {
		t.Fatal("H5 對原文應命中")
	}
	if again, rep2 := redactSecretText(out, true); again != out || rep2.Count != 0 {
		t.Fatal("遮過再遮應不變（冪等）")
	}
}

// 規則升版到 3 ⇒ 既有卡上的網址 token 也要被重掃補到（不必改原檔）。
func TestRescanRevision_CoversURLTokens(t *testing.T) {
	if secretRedactRevision < 3 {
		t.Fatalf("加了網址 token 規則，secretRedactRevision 應 ≥3，現在 %d", secretRedactRevision)
	}
}
