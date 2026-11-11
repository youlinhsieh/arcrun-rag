package main

// feedback_eventkey_stage_manual_test.go — inkstone/arcrun-rag#309 在 stage 上的實測（預設 SKIP）。
//
// 同一個事件連送兩次：只該有一張票、第二次成為留言；換一份檔：另開一張。
// 走的是 submitFeedbackFor（桌面三個「回報」按鈕背後同一段）＋與按鈕相同的 fileEventKey。
// 🔴 只准打隔離租戶（例：youlin 的 ahub-stage-377b），不打 inbox-feedback 主實例。
//
//	RUN_STAGE_FEEDBACK_309=1 STAGE_CYPHER_URL=https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev \
//	  STAGE_INBOX_NS=ahub-stage-377b STAGE_TAG=<本次唯一字串> \
//	  go test -run TestFeedbackEventKeyStageManual -v -timeout 120s .
import (
	"os"
	"strings"
	"testing"
)

func TestFeedbackEventKeyStageManual(t *testing.T) {
	if os.Getenv("RUN_STAGE_FEEDBACK_309") != "1" {
		t.Skip("手動驗收，設 RUN_STAGE_FEEDBACK_309=1 才跑（見檔頭）")
	}
	cy, ns, tag := os.Getenv("STAGE_CYPHER_URL"), os.Getenv("STAGE_INBOX_NS"), os.Getenv("STAGE_TAG")
	if cy == "" || !strings.HasPrefix(ns, "ahub-stage-") || tag == "" {
		t.Fatal("需要 STAGE_CYPHER_URL、STAGE_INBOX_NS（ahub-stage- 開頭的隔離租戶）、STAGE_TAG")
	}
	t.Setenv("ARCRUN_FEEDBACK_INBOX", cy+"/webhooks/named/"+ns+"/feedback_report/trigger")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	a := &App{}
	host := "stage-309-" + tag + ".example.dev"
	text := func(file, n string) string {
		return "【自動回報：一份檔案出錯】用戶按了這份檔案旁的「回報」。\n\n- 知識庫：測試（" + host + "）\n- 資料夾：合約\n- 檔名：" + file +
			"\n- 錯誤原文：雲端萃取失敗（HTTP 502）\n- 這是第 " + n + " 次按（#309 實測 " + tag + "）\n"
	}
	k1 := fileEventKey(host, "/home/u/合約", "甲方.docx", "雲端萃取失敗（HTTP 502）")
	k2 := fileEventKey(host, "/home/u/合約", "乙方.docx", "雲端萃取失敗（HTTP 502）")
	t.Logf("甲方 key=%s\n乙方 key=%s", k1, k2)
	for i, c := range []struct{ name, file, key string }{
		{"甲方第一次", "甲方.docx", k1}, {"甲方第二次（同一事件）", "甲方.docx", k1}, {"乙方（換一份檔）", "乙方.docx", k2}, {"甲方第三次", "甲方.docx", k1},
	} {
		if err := a.submitFeedbackFor(text(c.file, string(rune('1'+i))), false, host, c.key); err != nil {
			t.Fatalf("%s 送出失敗：%v", c.name, err)
		}
		t.Logf("%s：送出成功", c.name)
	}
	// 自由文字（沒有結構化事實）：同一段話兩次。本機每小時上限 5 則，換一個 HOME 重算。
	home2 := t.TempDir()
	t.Setenv("HOME", home2)
	t.Setenv("USERPROFILE", home2)
	for i := 0; i < 2; i++ {
		if err := a.SubmitFeedback("搜尋一直轉圈圈 "+tag, false); err != nil {
			t.Fatalf("自由文字第 %d 次失敗：%v", i+1, err)
		}
	}
	t.Log("自由文字兩次：送出成功")
}
