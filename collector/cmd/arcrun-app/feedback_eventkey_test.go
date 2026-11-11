package main

// feedback_eventkey_test.go — 回報的事件鍵與重複處理（inkstone/arcrun-rag#309）
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
)

var akeyOK = regexp.MustCompile(`^[A-Za-z0-9_.:@/~-]{1,120}$`)

func TestEventKey_SameEventSameKey_DifferentEventDifferentKey(t *testing.T) {
	h := "abc-123.workers.dev"
	a1 := fileEventKey(h, "/Users/王/文件/合約", "二〇二六/甲方.docx", "雲端萃取失敗（HTTP 502）")
	a2 := fileEventKey(h, "/Users/王/文件/合約", "二〇二六/甲方.docx", "雲端萃取失敗（HTTP 503）") // 同類原因（cloud_ai）
	if a1 != a2 {
		t.Errorf("同一份檔、同一類原因要同一個 key：%s ≠ %s", a1, a2)
	}
	if b := fileEventKey(h, "/Users/王/文件/合約", "二〇二六/乙方.docx", "雲端萃取失敗（HTTP 502）"); b == a1 {
		t.Errorf("換一份檔 key 要不同：%s", b)
	}
	if c := fileEventKey(h, "/Users/王/文件/合約", "二〇二六/甲方.docx", "卡片位置被佔用"); c == a1 {
		t.Errorf("換一類原因 key 要不同：%s", c)
	}
	if d := fileEventKey("other.workers.dev", "/Users/王/文件/合約", "二〇二六/甲方.docx", "雲端萃取失敗（HTTP 502）"); d == a1 {
		t.Errorf("換知識庫 key 要不同：%s", d)
	}
	for _, k := range []string{a1, a2,
		buildEventKey(strings.Repeat("長", 80), "file", strings.Repeat("x/", 90), "quality:H1+H2"),
		problemEventKey(h, "", "idle", ""), problemEventKey(h, "/a/b", "stuck", "連不上你的知識庫"),
		buildEventKey(h, "stall", "all", "quality:H1+H2"), textEventKey(h, "搜尋壞了")} {
		if !akeyOK.MatchString(k) {
			t.Errorf("key 含 AHub 不收的字元或超長（%d 字）：%q", len(k), k)
		}
	}
	if strings.Contains(a1, "王") || strings.Contains(a1, "甲方") {
		t.Errorf("key 不該帶中文原文：%s", a1)
	}
}

func TestEventKey_FreeTextNormalised(t *testing.T) {
	if textEventKey("h", "搜尋  壞了\n") != textEventKey("h", " 搜尋 壞了") {
		t.Error("空白差異不該產生不同事件")
	}
	if textEventKey("h", "搜尋壞了") == textEventKey("h", "上傳壞了") {
		t.Error("不同的話不該同一個事件")
	}
}

// 自動回報被 AHub 當成「相近票」擋下 ⇒ 帶逐張交代重送一次；事件鍵一路帶著。
func TestPostFeedback_DuplicateCandidates_RetriesOnceWithCompared(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		bodies = append(bodies, b)
		n := len(bodies)
		mu.Unlock()
		if n == 1 {
			w.WriteHeader(500) // 引擎：工作流失敗 ＝ HTTP 500
			_, _ = w.Write([]byte(`{"success":false,"data":{"success":false,"error":"開票前比對到相近的票，沒有開新票。重複候選=inkstone/arcrun-rag#198 inkstone/Arcrun#95"},"error":"x"}`))
			return
		}
		_, _ = w.Write([]byte(feedbackOK))
	}))
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL)

	key := "h:file:x-1:cloud_ai"
	if err := postFeedback(feedbackPayload{Text: "t", EventKey: key}); err != nil {
		t.Fatalf("重送後應成功：%v", err)
	}
	if len(bodies) != 2 {
		t.Fatalf("該打 2 次（原送＋帶交代重送），got %d", len(bodies))
	}
	if bodies[0]["compared"] != nil {
		t.Errorf("第一次不帶 compared：%v", bodies[0]["compared"])
	}
	cmp, _ := bodies[1]["compared"].([]any)
	if len(cmp) != 2 || bodies[1]["event_key"] != key {
		t.Fatalf("重送要帶事件鍵與兩張候選的交代：%v", bodies[1])
	}
	r0 := cmp[0].(map[string]any)["reason"].(string)
	r1 := cmp[1].(map[string]any)["reason"].(string)
	if r0 == r1 || len([]rune(r0)) < 10 {
		t.Errorf("每張交代要各不相同、夠長：%q／%q", r0, r1)
	}
}

// 重送仍被擋 ⇒ 不再無限重送，照實回錯。沒有事件鍵的送法（舊行為）不重送。
func TestPostFeedback_DuplicateRetryIsBounded(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":false,"error":"重複候選=inkstone/arcrun-rag#198"}}`))
	}))
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL)
	if err := postFeedback(feedbackPayload{Text: "t", EventKey: "h:x:y:z"}); err == nil {
		t.Error("重送仍被擋要回錯")
	}
	if hits != 2 {
		t.Errorf("最多 2 次，got %d", hits)
	}
	hits = 0
	if err := postFeedback(feedbackPayload{Text: "t"}); err == nil || hits != 1 {
		t.Errorf("沒事件鍵不重送：err=%v hits=%d", err, hits)
	}
}

// 小幫手送出的 body 一定有 event_key，且同一事件兩次相同。
func TestSubmitFeedback_SendsEventKey(t *testing.T) {
	tempHome(t)
	inbox := &feedbackFakeServer{respBody: feedbackOK}
	srv := newFeedbackFakeServer(inbox)
	defer srv.Close()
	t.Setenv("ARCRUN_FEEDBACK_INBOX", srv.URL)
	a := &App{}
	if err := a.SubmitFeedback("搜尋壞了", false); err != nil {
		t.Fatal(err)
	}
	k1, _ := inbox.gotBody["event_key"].(string)
	if !akeyOK.MatchString(k1) {
		t.Fatalf("event_key 不合法：%q", k1)
	}
	if err := a.SubmitFeedback("搜尋壞了", false); err != nil {
		t.Fatal(err)
	}
	if k2, _ := inbox.gotBody["event_key"].(string); k2 != k1 {
		t.Errorf("同一段話兩次要同一個 key：%s ≠ %s", k1, k2)
	}
}
