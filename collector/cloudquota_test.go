package collector

// cloudquota_test.go — arcrun-rag#197：雲端資料庫（D1）免費額度用完時，
// ① 認得出來 ② 整個帳號不再打雲端 ③ 用戶看得到白話 ④ 恢復後自己接上。
//
// /health 的回應原文照抄 2026-09-13 20:3x 對 youlin（1.4.63）實打的結果，不是編的。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const youlinHealthD1ReadExhausted = `{"ok":true,"status":"degraded","data_layer":{"ok":false,"summary":"資料層探測失敗——連 schema 都讀不到（D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.）。這台的知識庫現在不可用。","expected_generation":9,"actual_generation":-1,"behind_by":-1,"missing":[],"legacy_tables":[],"remedy":"確認 D1 binding（DB）指向正確的 arcrun-kbdb，並重跑安裝器或 ` + "`acr update`" + `。","probe_error":"D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."},"bundle_version":"1.4.63","bundle_commit":"be6bff7cf10a","auth_store":{"console":{"home":"sessions-kv","writable":true,"legacy_secrets_present":false},"portal_users":{"home":"kbdb","writable":true,"legacy_secrets_present":false}},"mail_relay_configured":true}`

// geek6688 同一時間（1.4.46，沒有 data_layer）的原文：認不出來就不編故事。
const geekHealthOld = `{"ok":true,"bundle_version":"1.4.46","auth_store":{"console":{"home":"sessions-kv","writable":true,"legacy_secrets_present":false},"portal_users":{"home":"kbdb","writable":true,"legacy_secrets_present":false}},"mail_relay_configured":true}`

const healthyNew = `{"ok":true,"status":"ok","data_layer":{"ok":true,"summary":"ok"},"bundle_version":"1.4.64"}`

func TestD1QuotaKind(t *testing.T) {
	cases := map[string]string{
		"D1_ERROR: Your account has exceeded D1's free tier daily row read limit.":  QuotaKindD1Read,
		"D1_ERROR: Your account has exceeded D1's free tier daily row write limit.": QuotaKindD1Write,
		"D1_ERROR: no such table: entries":                                          "",
		"4006: you have used up your daily free allocation of 10,000 neurons":       "", // Workers AI，不是 D1
		"":                                                                          "",
	}
	for in, want := range cases {
		if got := d1QuotaKind(in); got != want {
			t.Errorf("d1QuotaKind(%q)=%q，要 %q", in, got, want)
		}
	}
	if got := d1QuotaFromHealth([]byte(youlinHealthD1ReadExhausted)); got != QuotaKindD1Read {
		t.Fatalf("youlin 實打的 /health 應認出讀取額度用完，got %q", got)
	}
	if got := d1QuotaFromHealth([]byte(geekHealthOld)); got != "" {
		t.Fatalf("舊版雲端沒有 data_layer，不准猜，got %q", got)
	}
	if got := d1QuotaFromHealth([]byte(healthyNew)); got != "" {
		t.Fatalf("資料層正常不准報額度，got %q", got)
	}
}

func TestD1QuotaNotice_TellsUserEverything(t *testing.T) {
	// 台北 2026-09-13 20:30 ＝ UTC 12:30 ⇒ 下一次重置是台北 09-14 08:00（明天）
	now := time.Date(2026, 9, 13, 12, 30, 0, 0, time.UTC)
	n := buildD1QuotaNotice(QuotaKindD1Read, now, nextQuotaResetTaiwan(now))
	all := n.Headline + n.Usage + n.Guarantee + n.ExitOptions
	for _, must := range []string{"讀取", "額度用完", "500 萬", "已經用到上限", "台北時間明天早上 8:00", "自動接著傳", "不用做任何事"} {
		if !strings.Contains(all, must) {
			t.Errorf("訊息少了「%s」：%+v", must, n)
		}
	}
	for _, banned := range []string{"D1_ERROR", "HTTP", "credential", "UTC"} {
		if strings.Contains(all, banned) {
			t.Errorf("用戶看得到的字不准出現 %q：%+v", banned, n)
		}
	}
	if n.ResumeAt != "2026-09-14T08:00:00+08:00" {
		t.Errorf("ResumeAt=%s", n.ResumeAt)
	}
	w := buildD1QuotaNotice(QuotaKindD1Write, now, nextQuotaResetTaiwan(now))
	if !strings.Contains(w.Headline, "寫入") || !strings.Contains(w.Usage, "10 萬") {
		t.Errorf("寫入額度要講寫入與 10 萬：%+v", w)
	}
	// 台北凌晨 02:00（UTC 前一天 18:00）⇒ 重置是「今天」早上 8 點
	early := time.Date(2026, 9, 13, 18, 0, 0, 0, time.UTC)
	if e := buildD1QuotaNotice(QuotaKindD1Read, early, nextQuotaResetTaiwan(early)); !strings.Contains(e.Guarantee, "今天早上 8:00") {
		t.Errorf("凌晨要說今天：%s", e.Guarantee)
	}
	// 被擋下的檔要帶著原因上畫面（explainsWhySkipped 認得）
	resetD1Quota()
	defer resetD1Quota()
	noteD1Quota("https://x.example", QuotaKindD1Read, now)
	if note := d1QuotaNote("https://x.example", now); !explainsWhySkipped(note) {
		t.Errorf("擋下的訊息畫面認不出原因：%s", note)
	}
}

// 核心驗收：額度用完期間，整輪同步對雲端**零寫入**；/health 說恢復了就自己接上。
func TestD1Quota_NoCloudWritesUntilRecovered(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	var healthBody atomic.Value
	healthBody.Store(youlinHealthD1ReadExhausted)
	var posts, healths int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			atomic.AddInt64(&healths, 1)
			_, _ = w.Write([]byte(healthBody.Load().(string)))
			return
		}
		atomic.AddInt64(&posts, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":true}}`))
	}))
	defer srv.Close()

	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion // 走真的 /health 解析
	defer func() { fetchCloudVersion = origFetch }()

	if _, ok := cloudVersionThrottled(srv.URL, false); !ok {
		t.Fatal("/health 應可達")
	}
	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k"}
	url := srv.URL + "/webhooks/named/ns/rag_ingest_card/trigger"

	for i := 0; i < 5; i++ {
		_, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{"i": i})
		if err == nil || !isRouteBackoff(err) {
			t.Fatalf("第 %d 發：額度用完應被擋成『沒打出去』，got %v", i, err)
		}
		if !strings.Contains(err.Error(), "額度用完") {
			t.Fatalf("擋下的原因要講額度：%v", err)
		}
	}
	// 按「立刻同步」也不打（但會重問 /health）
	force := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k", ForceSync: true}
	cloudVersionThrottled(srv.URL, true)
	if _, _, err := force.postJSON(stepIngestCard, url, map[string]any{}); err == nil {
		t.Fatal("額度沒恢復時立刻同步也不該打出去")
	}
	if got := atomic.LoadInt64(&posts); got != 0 {
		t.Fatalf("額度用完期間打了 %d 發寫入，要 0", got)
	}

	// 雲端恢復：下一次強制重問 /health 就放行
	healthBody.Store(healthyNew)
	cloudVersionThrottled(srv.URL, true)
	if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); err != nil {
		t.Fatalf("恢復後應自動接上，got %v", err)
	}
	if got := atomic.LoadInt64(&posts); got != 1 {
		t.Fatalf("恢復後應打出 1 發，got %d", got)
	}
}

// 寫入那一發自己帶回 D1 額度原文（不等下一分鐘的 /health）⇒ 下一發起就停。
func TestD1Quota_LearnsFromFailedWrite(t *testing.T) {
	resetD1Quota()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); cloudRoutes.reset() }()
	var posts int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&posts, 1)
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"success":false,"error":"D1_ERROR: Your account has exceeded D1's free tier daily row write limit."}`))
	}))
	defer srv.Close()
	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k"}
	url := srv.URL + "/webhooks/named/ns/rag_ingest_card/trigger"
	if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); err == nil || isRouteBackoff(err) {
		t.Fatalf("第一發應真的打出去並失敗，got %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); !isRouteBackoff(err) {
			t.Fatalf("認出寫入額度用完後應停打，got %v", err)
		}
	}
	if got := atomic.LoadInt64(&posts); got != 1 {
		t.Fatalf("只該打出 1 發，got %d", got)
	}
	if st, ok := activeD1Quota(srv.URL, directNow()); !ok || st.kind != QuotaKindD1Write {
		t.Fatalf("應記成寫入額度，got %+v %v", st, ok)
	}
}

// 過了重置時間（台北 08:00）舊紀錄一定失效——就算那之後 /health 一次都沒打到。
func TestD1Quota_ExpiresAtReset(t *testing.T) {
	resetD1Quota()
	defer resetD1Quota()
	now := time.Date(2026, 9, 13, 12, 30, 0, 0, time.UTC)
	noteD1Quota("https://x.example", QuotaKindD1Read, now)
	if _, ok := activeD1Quota("https://x.example", now.Add(11*time.Hour)); !ok {
		t.Fatal("重置前應仍有效")
	}
	if _, ok := activeD1Quota("https://x.example", time.Date(2026, 9, 14, 0, 0, 1, 0, time.UTC)); ok {
		t.Fatal("過了 00:00 UTC 應失效")
	}
}
