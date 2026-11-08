package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#294：機敏值遮掉、指向原檔、其餘照常——不擋、不出這台電腦。

// 測試用的假值，故意長得像真的（每一條都會被 H5 認出來）。
var fakeSecrets = []string{
	"hunter2hunter2",
	"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
	"sk_live_ABCDEFGHIJKLMNOP1234",
	"dbuser:dbp4ssw0rd",
	"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
}

const secretDoc = "# 2026_10_21\n" +
	"- 今天把部署腳本整理好了，流程是先 build 再推 stage。\n" +
	"- SECRET = hunter2hunter2\n" +
	"- token 是 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n" +
	"- 金流測試金鑰 sk_live_ABCDEFGHIJKLMNOP1234\n" +
	"- 資料庫 postgres://dbuser:dbp4ssw0rd@db.example.com/app\n" +
	"-----BEGIN PRIVATE KEY-----\n" +
	"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n" +
	"-----END PRIVATE KEY-----\n" +
	"- 下週要跟客戶開會討論報價。\n"

func assertNoSecret(t *testing.T, where, s string) {
	t.Helper()
	for _, v := range fakeSecrets {
		if strings.Contains(s, v) {
			t.Fatalf("%s 仍含機敏值原文 %q", where, v)
		}
	}
	if hits := scanSecrets(s); len(hits) > 0 {
		t.Fatalf("%s 仍被 H5 認出：%v", where, hits)
	}
}

func TestRedactSecretText_MasksAllKindsKeepsRest(t *testing.T) {
	out, rep := redactSecretText(secretDoc, true)
	assertNoSecret(t, "遮蔽後文字", out)
	if rep.Count != 5 {
		t.Fatalf("Count=%d want 5（%v）", rep.Count, rep.Labels)
	}
	if !strings.Contains(out, "SECRET = 〔機敏值，未萃取：請看原檔第 3 行〕") {
		t.Fatalf("賦值要留鍵名、只遮值、帶行號：\n%s", out)
	}
	if !strings.Contains(out, "postgres://〔機敏值，未萃取：請看原檔第 6 行〕@db.example.com/app") {
		t.Fatalf("連線字串要留協定與主機：\n%s", out)
	}
	for _, keep := range []string{"先 build 再推 stage", "跟客戶開會討論報價"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("其他內容被吃掉了：缺 %q", keep)
		}
	}
	if got, want := strings.Count(out, "\n"), strings.Count(secretDoc, "\n"); got != want {
		t.Fatalf("行數位移了：%d vs %d（後面的行號會對不上原檔）", got, want)
	}
}

func TestRedactSecretText_CleanTextUntouched(t *testing.T) {
	in := "# 筆記\n- password 要記得每季換\n- 會議在 3 樓\n"
	out, rep := redactSecretText(in, true)
	if out != in || rep.Count != 0 {
		t.Fatalf("沒有機敏值卻被改：%q %+v", out, rep)
	}
}

func TestRedactSecretText_Idempotent(t *testing.T) {
	once, _ := redactSecretText(secretDoc, true)
	twice, rep := redactSecretText(once, true)
	if twice != once || rep.Count != 0 {
		t.Fatalf("遮過的再遮一次不該再變（指標本身不是機敏值）：%+v", rep)
	}
}

func TestSecretNote_NoValueOnlyPointer(t *testing.T) {
	_, rep := redactSecretText(secretDoc, true)
	n := secretNote(rep, "journals/2026_10_21.md")
	assertNoSecret(t, "說明句", n)
	if !strings.Contains(n, "journals/2026_10_21.md") || !strings.Contains(n, "第 3、4、5、6、7 行") {
		t.Fatalf("說明句要指向原檔與行號：%s", n)
	}
}

// 端到端（萃取一份檔）：送上雲的請求不含原值；卡片含指標與說明、過得了 lint。
func TestExtractWithWorkersAI_SecretsNeverLeaveMachine(t *testing.T) {
	root := t.TempDir()
	srcRel := "journals/2026_10_21.md"
	if err := os.MkdirAll(filepath.Join(root, "journals"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, srcRel), []byte(secretDoc), 0o644); err != nil {
		t.Fatal(err)
	}
	var sent string
	url, closeFn := workersAIStub(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		sent += string(b)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"output":  cardFixture("2026_10_21", "部署"),
		})
	})
	defer closeFn()
	cards, err := ExtractWithWorkersAI(url, "key123", root, srcRel, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	if sent == "" {
		t.Fatal("沒攔到萃取請求")
	}
	assertNoSecret(t, "萃取請求", sent)
	if !strings.Contains(sent, "跟客戶開會討論報價") {
		t.Fatal("其餘內容沒送去萃取")
	}
	if len(cards) == 0 {
		t.Fatal("沒產卡")
	}
	card, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(cards[0])))
	if err != nil {
		t.Fatal(err)
	}
	assertNoSecret(t, "文件卡", string(card))
	if !strings.Contains(string(card), "疑似機敏值") || !strings.Contains(string(card), srcRel) {
		t.Fatalf("文件卡要說明有機敏值沒萃、指向原檔：\n%s", card)
	}
	lr := LintCard(string(card), LintOptions{Source: lintSourceText(root, srcRel, []byte(secretDoc))})
	for _, h := range lr.Hard {
		if h.Code == "H5" {
			t.Fatalf("遮過的卡不該再被 H5 擋：%v", lr.Hard)
		}
	}
}

// 卡上還帶原文（例：逐字段、模型回聲）時，落卡後那一道把它遮掉而不是擋下。
func TestCardLevelRedaction_DoesNotBlock(t *testing.T) {
	card := "# x\n## 一句話定義\n部署筆記\n## 要點\n- 設定 api_key: abcdef123456\n"
	if !LintCard(card, LintOptions{}).Blocks(false) {
		t.Fatal("前提：沒遮的卡會被 H5 擋")
	}
	red, rep := redactSecretText(card, false)
	if rep.Count != 1 {
		t.Fatalf("Count=%d", rep.Count)
	}
	for _, h := range LintCard(red, LintOptions{}).Hard {
		if h.Code == "H5" {
			t.Fatalf("遮過仍被 H5 擋：%s", red)
		}
	}
	if strings.Contains(red, "abcdef123456") {
		t.Fatal("值沒遮掉")
	}
}
