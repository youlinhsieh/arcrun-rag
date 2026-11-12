package collector

import (
	"strings"
	"testing"
)

// 2026-11-11 youlin stage 實跑（inkstone/InkStoneCo#233）：`DB_PASSWORD = "…"` 有引號的賦值
// 遮蔽與 H5 都沒攔，值原樣進了雲端卡。值是執行時組出的假值。
func TestRedact_233_QuotedAssignments(t *testing.T) {
	v := "sup3r" + "S3cretV4lue" + "XyZ12345"
	in := "DB_PASSWORD = \"" + v + "\"\n" +
		"password: '" + v + "'\n" +
		"{\"api_key\": \"" + v + "\"}\n" +
		"API_TOKEN=\"" + v + "\"\n" +
		"說明：password: \"<你的密碼>\" 與 password: <pw> 是佔位符\n" +
		"X-Arcrun-API-Key: \"__NAMESPACE__\"\n" +
		"一般句子：我忘記 password 了\n"
	out, rep := redactSecretText(in, true)
	if strings.Contains(out, v) {
		t.Fatalf("原值還在：%s", out)
	}
	if rep.Count != 4 {
		t.Fatalf("應遮 4 處，實際 %d：%v\n%s", rep.Count, rep.Labels, out)
	}
	for _, keep := range []string{"DB_PASSWORD = \"〔", "password: '〔", "\"api_key\": \"〔", "API_TOKEN=\"〔", "password: \"<你的密碼>\"", "password: <pw>", "X-Arcrun-API-Key: \"__NAMESPACE__\"", "我忘記 password 了"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("缺 %q（鍵名與引號要留、佔位符與一般句子不動）\n%s", keep, out)
		}
	}
	if hits := scanSecrets(out); len(hits) != 0 {
		t.Fatalf("遮過的文字 H5 不該再命中：%v\n%s", hits, out)
	}
	if hits := scanSecrets(in); len(hits) == 0 {
		t.Fatal("H5 對原文應命中")
	}
	if again, rep2 := redactSecretText(out, true); again != out || rep2.Count != 0 {
		t.Fatalf("遮過再遮應不變（冪等）：%s", again)
	}
	if secretRedactRevision < 4 {
		t.Fatalf("加了有引號賦值的規則，secretRedactRevision 應 ≥4，現在 %d", secretRedactRevision)
	}
}
