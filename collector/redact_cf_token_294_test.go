package collector

import (
	"strings"
	"testing"
)

// 2026-11-05 leo21c 上實見：`CLOUDFLARE_TOKEN_CC_COURSE=cfut_…` 完整躺在卡上，H5 與遮蔽都沒攔。
// 這裡的值是假的（執行時組出來，不把任何真值寫進 repo）。
func TestRedact_294_CloudflareTokenAndEnvAssign(t *testing.T) {
	fake := "cfut_" + strings.Repeat("Ab3dE", 8)
	in := "- 拿金鑰\n\t- `CLOUDFLARE_TOKEN_CC_COURSE=" + fake + "`\n- 變數四行:`CLOUDFLARE_API_TOKEN`、`ARCRUN_RAG_URL`(網址加 `/mcp`)、`ARCRUN_RAG_TOKEN`\n- 環境設定加第五個 `TELEGRAM_BOT_TOKEN`,開新工作階段\n- ARCRUN_RAG_TOKEN=<token>\n- 裸貼 " + fake + " 在句子裡"
	out, rep := redactSecretText(in, true)
	if strings.Contains(out, fake) || strings.Contains(out, "cfut_") {
		t.Fatalf("原值還在：%s", out)
	}
	if rep.Count != 2 {
		t.Fatalf("應遮 2 處（賦值一處＋裸貼一處），實際 %d：%v", rep.Count, rep.Lines)
	}
	if !strings.Contains(out, "CLOUDFLARE_TOKEN_CC_COURSE=〔機敏值，未萃取：請看原檔第 2 行〕") {
		t.Fatalf("賦值應留鍵名、換成指標：%s", out)
	}
	for _, keep := range []string{"`CLOUDFLARE_API_TOKEN`、`ARCRUN_RAG_URL`", "`TELEGRAM_BOT_TOKEN`,開新工作階段", "ARCRUN_RAG_TOKEN=<token>"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("不是機敏值的不該動：%q 不見了\n%s", keep, out)
		}
	}
	if hits := scanSecrets(out); len(hits) != 0 {
		t.Fatalf("遮過的文字 H5 不該再命中：%v", hits)
	}
	if hits := scanSecrets(in); len(hits) == 0 {
		t.Fatal("H5 對原文應命中（否則舊卡的洞還在）")
	}
}
