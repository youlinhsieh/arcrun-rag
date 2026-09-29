// quota_account_test.go — inkstone/arcrun-rag#207：「額度爆了」那張卡要寫出是哪一台雲端爆了，
// 不能讓人以為爆的是自己正在看、其實沒事的那一台。
//
// 情境照票面實測（leo 2026-09-19）：同時看守兩個帳號，一台像 leo21c（付費、沒事），
// 一台像 youlin（免費、當天 D1 讀取額度爆了）。修這張票之前，`QuotaNotice` 沒有帳號欄位，
// `pickQuotaNotice`（App 端）挑出通知後帳號身份就丟了——連著沒事那台的人，會被那張卡
// 誤導成「我這台爆了」。這裡直接跑一輪 `RunDirectOnce`，釘住兩件事：
//
//	① 爆掉那台的 QuotaMessage.Account 必須是自己的 host（不是空、更不是另一台的）
//	② 沒爆的那台不准被牽連出一份 QuotaMessage
package collector

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirect_D1Quota_NoticeCarriesWhichAccountHitIt(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() }()

	base := t.TempDir()
	rootBusted := filepath.Join(base, "rootBusted")
	rootFine := filepath.Join(base, "rootFine")
	for _, d := range []string{rootBusted, rootFine} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// 爆掉那台：/health 回 youlin 2026-09-13 實打過的「D1 讀取額度用完」原文
	// （同一份常數見 cloudquota_test.go）。
	busted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/health") {
			_, _ = w.Write([]byte(youlinHealthD1ReadExhausted))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":true}}`))
	}))
	defer busted.Close()

	// 沒事那台：/health 回正常。
	fine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/health") {
			_, _ = w.Write([]byte(healthyNew))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":true}}`))
	}))
	defer fine.Close()

	// 走真的 /health 解析（noteD1Quota 在 fetchBundleVersion 裡才會被叫到），
	// 與 direct_quota_resume_test.go 同一個做法。
	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFetch }()

	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{
			{InstanceName: "leo21c", CypherURL: busted.URL, Namespace: "nsBusted", WatchFolders: []string{rootBusted}},
			{InstanceName: "youlin", CypherURL: fine.URL, Namespace: "nsFine", WatchFolders: []string{rootFine}},
		},
		MaxRemoved: DefaultMaxRemovedRatio,
	}

	RunDirectOnce(cfg, false)

	st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if err != nil {
		t.Fatalf("讀 status.json 失敗：%v", err)
	}

	hostBusted := instanceHostOf(busted.URL)
	hostFine := instanceHostOf(fine.URL)

	accB, ok := st.AccountDetails[hostBusted]
	if !ok || accB.QuotaMessage == nil {
		t.Fatalf("爆掉那台應該有 QuotaMessage，got %+v（帳號清單：%+v）", accB, st.AccountDetails)
	}
	if accB.QuotaMessage.Account != hostBusted {
		t.Errorf("爆掉那台的 QuotaMessage.Account 應該是自己的 host %q，got %q——"+
			"這正是票面的病：使用者連的是這一台，卻分不出爆的是不是它自己",
			hostBusted, accB.QuotaMessage.Account)
	}

	accF, ok := st.AccountDetails[hostFine]
	if !ok {
		t.Fatalf("沒爆的那台也該有紀錄，got %+v", st.AccountDetails)
	}
	if accF.QuotaMessage != nil {
		t.Errorf("沒爆的那台不該有 QuotaMessage，got %+v——不能把爆掉那台的訊息牽連過來", accF.QuotaMessage)
	}
}
