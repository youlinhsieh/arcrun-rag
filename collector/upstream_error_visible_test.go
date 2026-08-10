package collector

import (
	"strings"
	"testing"
)

// TestUpstreamErrorSurvivesBackoff 釘住 leo 2026-08-06 立的原則：
//
//	「**別人的錯誤一律要顯示給用戶看，不然就會變成我的錯誤，導致客服**」
//
// 事故現場：Cloudflare 回「當日免費額度用完」、某 PDF「沒有可抽取的文字」，
// 但檔案一進退避，畫面就只剩「上次失敗（第 4 次），58m 後重試」
// ⇒ 上游的錯被我們吞掉，使用者只看得到「Arcrun 在失敗」。
//
// 這支測試從**上游錯誤字串**出發，驗它一路活到給使用者看的那句話裡。
func TestUpstreamErrorSurvivesBackoff(t *testing.T) {
	const upstream = "雲端萃取失敗（HTTP 502）：Workers AI 執行失敗：4006: you have used up your daily free allocation of 10,000 neurons"

	m := &Manifest{Entries: map[string]*ManifestEntry{"報告.pdf": {}}}
	if !m.MarkFailed("報告.pdf", 1000, upstream) {
		t.Fatal("MarkFailed 應該成功")
	}

	// ① 原因要存得住（退避跨輪次，不能只活在當次記憶體裡）
	if got := m.Entries["報告.pdf"].LastError; got != upstream {
		t.Fatalf("上游原因沒存下來，實得 %q", got)
	}

	// ② 使用者看到的那句話裡要有它
	reason := retrySkipReason(m, "報告.pdf", 1010)
	if !strings.Contains(reason, "neurons") {
		t.Fatalf("退避訊息吞掉了上游的錯 ⇒ 使用者會以為是我們壞掉。實得：%s", reason)
	}
	if !strings.Contains(reason, "後重試") {
		t.Errorf("重試排程也要講（兩件事都要說），實得：%s", reason)
	}

	// ③ 成功之後要清乾淨，不能一直掛著舊錯誤嚇人
	m.MarkIngestedBy("報告.pdf", "hash", 2000, "workers-ai")
	if m.Entries["報告.pdf"].LastError != "" {
		t.Error("成功後舊的失敗原因應該清掉")
	}
}
