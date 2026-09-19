package collector

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// realCredential500 是 2026-09-10 09:20 UTC 從 youlin 抄回來的**原文**
// （`inkstone/arcrun-rag#179` comment 6867 貼的那一份）。
// 這一份不是虛構樣本，是這一票的物證——改動這裡等於改動證據。
const realCredential500 = `{"success":false,` +
	`"error":"Node list_old_blocks failed: credential resolve 失敗: 缺少 credential: kbdb_internal_token。修復: 編輯 credentials.yaml 後執行 acr creds push",` +
	`"trace":[{"node":"input","status":"success"},{"node":"list_old_blocks","status":"failed","error":"...缺少 credential: kbdb_internal_token"}]}`

// 使用者看得到這幾句 ⇒ 不准裸露技術細節，也不准出現上游那句寫死的修法。
var 使用者文案禁字 = []string{"HTTP", "500", "{", "credentials.yaml", "acr creds", "unreachable"}

func 檢查禁字(t *testing.T, msg string) {
	t.Helper()
	for _, bad := range 使用者文案禁字 {
		if strings.Contains(msg, bad) {
			t.Errorf("訊息裸露了技術細節 %q：%q", bad, msg)
		}
	}
}

func probeReturning(rep credDirReport) credentialProbe {
	return func() credDirReport { return rep }
}

func TestCredential文案_資料層讀不到時要說得出是資料層不是金鑰不見(t *testing.T) {
	msg := webhookFailure(realCredential500, probeReturning(credDirReport{Status: credDirUnreachable}))
	if msg == "" {
		t.Fatal("這份回應自稱 success=false ⇒ 必須判失敗")
	}
	if !strings.Contains(msg, "資料層") {
		t.Errorf("要講出「是資料層讀不到」：%q", msg)
	}
	if !strings.Contains(msg, "不是金鑰不見") {
		t.Errorf("要明講「不是金鑰不見」——這正是總管 2026-09-10 被誤導的那一格：%q", msg)
	}
	if strings.Contains(msg, "重裝") {
		t.Errorf("資料層抖一下就叫使用者重裝整座雲端＝舊版那個假修法：%q", msg)
	}
	檢查禁字(t, msg)
}

func TestCredential文案_金鑰真的缺席時仍然講那件事(t *testing.T) {
	msg := webhookFailure(realCredential500, probeReturning(credDirReport{
		Status: credDirReadable,
		Names:  map[string]bool{"gitea_token": true}, // 目錄讀得到，就是沒有 kbdb_internal_token
	}))
	if !strings.Contains(msg, "沒有裝上去") {
		t.Errorf("目錄讀得到而這一把不在 ⇒ 要講「沒有裝上去」：%q", msg)
	}
	if !strings.Contains(msg, "回報給我們") {
		t.Errorf("使用者做不了任何事時，唯一合法出路是交回我們：%q", msg)
	}
	if strings.Contains(msg, "重裝") {
		t.Errorf("重裝跑的是同一支安裝步驟，叫他重裝＝把我們的活推給他：%q", msg)
	}
	檢查禁字(t, msg)
}

func TestCredential文案_目錄裡有那把時不准說金鑰不見(t *testing.T) {
	msg := webhookFailure(realCredential500, probeReturning(credDirReport{
		Status: credDirReadable,
		Names:  map[string]bool{"kbdb_internal_token": true},
	}))
	if !strings.Contains(msg, "取不到它的值") {
		t.Errorf("目錄有它、壞的是取值那一段 ⇒ 要分得出來：%q", msg)
	}
	if strings.Contains(msg, "沒有裝上去") {
		t.Errorf("目錄裡明明有它，不准講成沒裝上去：%q", msg)
	}
	檢查禁字(t, msg)
}

func TestCredential文案_問不出來就說不知道不編原因(t *testing.T) {
	for name, probe := range map[string]credentialProbe{
		"沒有探針":  nil,
		"探針問不到": probeReturning(credDirReport{Status: credDirUnknown}),
	} {
		msg := webhookFailure(realCredential500, probe)
		if !strings.Contains(msg, "還沒能分辨") {
			t.Errorf("%s：問不出來要誠實說不知道，不准編一個原因出來：%q", name, msg)
		}
		if strings.Contains(msg, "重裝") {
			t.Errorf("%s：不知道原因卻指定修法，就是舊版那個病：%q", name, msg)
		}
		檢查禁字(t, msg)
	}
}

func TestCredential文案_舊版那句假修法不准再出現(t *testing.T) {
	// 舊版：「知識庫的內部金鑰不對，要重裝一次雲端才會通。」
	// 四種目錄狀況全掃一遍，任何一種都不准長回那句。
	for _, rep := range []credDirReport{
		{Status: credDirUnknown},
		{Status: credDirUnreachable},
		{Status: credDirReadable, Names: map[string]bool{}},
		{Status: credDirReadable, Names: map[string]bool{"kbdb_internal_token": true}},
	} {
		msg := credentialSentence(headAccepted, realCredential500, probeReturning(rep))
		if strings.Contains(msg, "重裝") || strings.Contains(msg, "內部金鑰不對") {
			t.Errorf("status=%d 又長回舊版那句：%q", rep.Status, msg)
		}
	}
}

func TestTriggerRejected_非2xx也要講人話而不是把上游原文印給使用者(t *testing.T) {
	// 這是 c6867 實測那一發：HTTP 500，body 就是 realCredential500。
	// 舊路徑會回 `HTTP 500：{"success":false,"error":"…修復: 編輯 credentials.yaml…"}`。
	msg := triggerRejectedSentence(realCredential500, probeReturning(credDirReport{Status: credDirUnreachable}))
	if msg == "" {
		t.Fatal("認得出來的失敗要換成人話，不能把上游 JSON 原封不動丟給使用者")
	}
	if !strings.HasPrefix(msg, headRejected) {
		t.Errorf("非 2xx＝根本沒收下，不准講成「收下了但沒寫進去」：%q", msg)
	}
	檢查禁字(t, msg)
}

func TestTriggerRejected_看不懂的回應保留原本的技術字串(t *testing.T) {
	for _, body := range []string{
		``,
		`Too Many Requests`,
		`{"error":"unauthorized"}`, // 沒有 success 欄位 ⇒ 不是我們認得的形狀
	} {
		if msg := triggerRejectedSentence(body, nil); msg != "" {
			t.Errorf("看不懂就該回空字串讓呼叫端保留原字串，卻回了 %q（body=%q）", msg, body)
		}
	}
}

func TestReadCredentialDirectory_三種回應各自的判定(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   credDirStatus
	}{
		{"資料層回錯 502", 502, `{"success":false,"error":"credential 目錄查詢失敗：HTTP 503"}`, credDirUnreachable},
		{"資料層回錯 500", 500, `{"success":false,"error":"boom"}`, credDirUnreachable},
		{"200 卻自稱失敗", 200, `{"success":false,"error":"credential 目錄查詢失敗"}`, credDirUnreachable},
		{"200 正常", 200, `{"success":true,"credentials":[{"name":"gitea_token"}],"total":1}`, credDirReadable},
		{"200 空目錄", 200, `{"success":true,"credentials":[],"total":0}`, credDirReadable},
		{"401 是我們問錯了", 401, `{"error":"缺少 X-Arcrun-API-Key header"}`, credDirUnknown},
		{"404 舊世代沒這條路由", 404, `not found`, credDirUnknown},
		{"200 但看不懂", 200, `<html>`, credDirUnknown},
		{"200 但沒有 success 欄位", 200, `{"credentials":[]}`, credDirUnknown},
	}
	for _, c := range cases {
		got := readCredentialDirectory(c.status, []byte(c.body))
		if got.Status != c.want {
			t.Errorf("%s：want status %d, got %d（detail=%q）", c.name, c.want, got.Status, got.Detail)
		}
		if got.Detail == "" {
			t.Errorf("%s：Detail 是檢修孔要看的原文，不准是空的", c.name)
		}
	}
	// 🔴 這一格單獨挑出來講：**空目錄不等於問不到**。
	// 把它們壓成同一個值，就是 Arcrun 核心 credentials.ts:251-254 犯的那個錯，
	// 也是這整張票的來由——本檔不准在這裡重演一次。
	empty := readCredentialDirectory(200, []byte(`{"success":true,"credentials":[]}`))
	if empty.Status != credDirReadable {
		t.Fatal("目錄讀得到但是空的 ⇒ Readable，不是 Unknown")
	}
	if empty.has("kbdb_internal_token") {
		t.Fatal("空目錄裡不該有任何名字")
	}
}

func TestCredentialNameIn_挖得出名字挖不到就不猜(t *testing.T) {
	if got := credentialNameIn(realCredential500); got != "kbdb_internal_token" {
		t.Errorf("要從實測原文挖出金鑰名，got %q", got)
	}
	if got := credentialNameIn("credential resolve 失敗: 未知錯誤"); got != "" {
		t.Errorf("挖不到就回空字串（文案會走「不知道」那格），got %q", got)
	}
}

func TestCredentialDirectoryProbe_一輪只問一次而且問不到不快取(t *testing.T) {
	resetCredDirCache()
	t.Cleanup(resetCredDirCache)

	var hits int32
	var status int32 = 500
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Header.Get("X-Arcrun-API-Key") != "ns-1" {
			t.Errorf("探針要帶與收卡同一把 key，got %q", r.Header.Get("X-Arcrun-API-Key"))
		}
		code := int(atomic.LoadInt32(&status))
		w.WriteHeader(code)
		if code == http.StatusOK {
			fmt.Fprint(w, `{"success":true,"credentials":[{"name":"gitea_token"}]}`)
			return
		}
		fmt.Fprint(w, `{"success":false,"error":"credential 目錄查詢失敗"}`)
	}))
	t.Cleanup(srv.Close)

	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "ns-1"}
	probe := cfg.credentialDirectoryProbe()
	if probe == nil {
		t.Fatal("有連線設定就該問得到")
	}
	for i := 0; i < 5; i++ {
		if rep := probe(); rep.Status != credDirUnreachable {
			t.Fatalf("第 %d 次：want Unreachable, got %d", i, rep.Status)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("同一個實例 60 秒內只該問一次（3,620 份檔不能變成 3,620 發），實際 %d 發", got)
	}

	// 快取過期後才會重問——用推時間驗，不睡 60 秒。
	real := credDirNow
	credDirNow = func() time.Time { return real().Add(credDirTTL + time.Second) }
	t.Cleanup(func() { credDirNow = real })
	atomic.StoreInt32(&status, http.StatusOK)
	if rep := probe(); rep.Status != credDirReadable || !rep.has("gitea_token") {
		t.Errorf("過期後要重問並拿到新答案，got %+v", rep)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Errorf("過期後應恰好多問一次，實際共 %d 發", got)
	}
}

func TestCredentialDirectoryProbe_問不到不快取(t *testing.T) {
	resetCredDirCache()
	t.Cleanup(resetCredDirCache)

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusUnauthorized) // 401 ⇒ Unknown ⇒ 不准快取
		fmt.Fprint(w, `{"error":"no key"}`)
	}))
	t.Cleanup(srv.Close)

	probe := (&DirectConfig{CypherURL: srv.URL, APIKey: "ns-1"}).credentialDirectoryProbe()
	for i := 0; i < 3; i++ {
		if rep := probe(); rep.Status != credDirUnknown {
			t.Fatalf("401 ⇒ Unknown, got %d", rep.Status)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Errorf("一次網路抖動不該讓整輪都變成「不知道」⇒ Unknown 不快取，實際只打了 %d 發", got)
	}
}

func TestCredentialDirectoryProbe_沒有連線設定就誠實回nil(t *testing.T) {
	for _, cfg := range []*DirectConfig{
		{},
		{CypherURL: "https://x.example"},
		{APIKey: "ns"},
	} {
		if cfg.credentialDirectoryProbe() != nil {
			t.Errorf("沒有連線設定就問不到，該回 nil：%+v", cfg)
		}
	}
}

func TestIngestFailureSentence_既有三條分支一個字都沒動(t *testing.T) {
	cases := []struct{ raw, want string }{
		{`{"success":false,"error":"unreachable"}`, headAccepted + "：連不到知識庫的資料層。稍後會自動再試。"},
		{"card_content 為空", headAccepted + "：這份檔萃出來是空的。"},
		{"某種我們沒見過的錯", headAccepted + "，稍後會自動再試。"},
	}
	for _, c := range cases {
		if got := ingestFailureSentence(headAccepted, c.raw, nil); got != c.want {
			t.Errorf("raw=%q\n want %q\n got  %q", c.raw, c.want, got)
		}
	}
}

// TestPostJSON_兩張臉_使用者讀人話而檢修孔留得住原文 是本票的端到端那一格：
// 實測那一發（HTTP 500 ＋ realCredential500）進去，出來的 Error() 是人話，
// 而上游原文一個字都沒丟——它搬到 Detail 給檢修孔。
func TestPostJSON_兩張臉_使用者讀人話而檢修孔留得住原文(t *testing.T) {
	resetCredDirCache()
	t.Cleanup(resetCredDirCache)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/credentials" {
			// 目錄讀得到、但沒有 kbdb_internal_token ⇒ 「金鑰真的沒裝上」那一格
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `{"success":true,"credentials":[{"name":"gitea_token"}]}`)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, realCredential500)
	}))
	t.Cleanup(srv.Close)

	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns-1", APIKey: "ns-1"}
	status, _, err := cfg.postJSON(stepIngestCard, srv.URL+"/webhooks/named/ns-1/rag_ingest_card/trigger", map[string]any{})
	if err == nil {
		t.Fatal("HTTP 500 卻回 nil error")
	}
	if status != http.StatusInternalServerError {
		t.Errorf("狀態碼要照實回，got %d", status)
	}

	// ① 使用者那一面：人話，且不准帶上游那句寫死的假修法
	檢查禁字(t, err.Error())
	if !strings.Contains(err.Error(), "沒有裝上去") {
		t.Errorf("目錄讀得到、這一把不在 ⇒ 要講「沒有裝上去」：%q", err.Error())
	}
	if strings.Contains(err.Error(), "重裝") {
		t.Errorf("不准叫使用者重裝：%q", err.Error())
	}

	// ② 檢修孔那一面：原文一個字都不能少
	detail := upstreamDetail(err)
	if !strings.Contains(detail, "kbdb_internal_token") || !strings.Contains(detail, "credentials.yaml") {
		t.Errorf("上游原文是證據，不准連它一起丟掉：%q", detail)
	}
	if !strings.Contains(detail, "500") {
		t.Errorf("狀態碼要留在檢修孔那一面：%q", detail)
	}
}
