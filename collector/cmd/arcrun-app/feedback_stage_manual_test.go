package main

// feedback_stage_manual_test.go — inkstone/arcrun-rag#210 comment 15334：
// 桌面「?」求救頁「1・打字回報問題」打真的 stage youlin，驗證真的變成一張
// Gitea 票。跟 diagnostics_stage_manual_test.go 同一個模式（預設 SKIP，
// 需 RUN_STAGE_FEEDBACK=1 才跑；憑證用外部 JSON，不寫死金鑰），
// 留在版控裡供總管／leo 隨時重跑，不是驗完就刪的一次性腳本。
//
// SubmitFeedback 本身是純 HTTP 呼叫（不像 diagnostics 需要 supervisor 子行程
// 才組得出 engine 欄位），所以這支不必真的 build+跑 collector 二進位——直接呼叫
// App.SubmitFeedback()，走的就是桌面「?」頁「送出」按鈕背後同一段程式碼。
//
// ── 使用方式 ──
//
//	RUN_STAGE_FEEDBACK=1 STAGE_CYPHER_URL=https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev \
//	  STAGE_NAMESPACE=yuga3bse \
//	  go test -run TestSubmitFeedbackStageManual -v -timeout 60s .
import (
	"fmt"
	"os"
	"testing"
	"time"
)

func TestSubmitFeedbackStageManual(t *testing.T) {
	if os.Getenv("RUN_STAGE_FEEDBACK") != "1" {
		t.Skip("一次性／可重跑的手動驗收，設 RUN_STAGE_FEEDBACK=1 才跑（見本檔頂端 usage 註解）")
	}
	cypherURL := os.Getenv("STAGE_CYPHER_URL")
	namespace := os.Getenv("STAGE_NAMESPACE")
	if cypherURL == "" || namespace == "" {
		t.Fatal("需要 STAGE_CYPHER_URL 與 STAGE_NAMESPACE（見本檔頂端 usage 註解）")
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	stamp := time.Now().UTC().Format("2006-01-02 15:04:05")
	text := fmt.Sprintf(
		"【總管自動化驗收】inkstone/arcrun-rag#210 comment 15334 桌面「?」求救頁候選——"+
			"這是打 stage youlin 的真實回報，走的是 SubmitFeedback 同一段程式碼，"+
			"驗證能不能真的變成一張 Gitea 票。時間戳 %s，可忽略／關閉。", stamp)

	writeCfgWithAccount(t, cypherURL, accountCfg{Namespace: namespace, InstanceName: "youlin-stage"})

	a := &App{}
	if err := a.SubmitFeedback(text, false); err != nil {
		t.Fatalf("送出失敗：%v", err)
	}
	t.Logf("送出成功。去 inkstone/arcrun-rag 的 issues 找標籤 user+s/triage、內文含「%s」的那張新票，核對欄位。", stamp)
}
