package main

// stall_consent_stage_manual_test.go — inkstone/arcrun-rag#330「修不了才問、同意才寄」在 stage 上的實測（預設 SKIP）。
//
// 走的是畫面按鈕背後同一組方法：uiStalls（出不出卡）→ StallPreview（看內容）→ ReportStall（同意）／DeclineStall（不用了）。
// 失敗字串是 collector 真的打到「被切斷的連線」得到的真實文字，不是手寫。
// 🔴 只准打隔離租戶（ahub-stage-*），不打 inbox-feedback 主實例，更不碰 leo21c。
//
//	RUN_STAGE_330=1 STAGE_CYPHER_URL=https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev \
//	  STAGE_INBOX_NS=ahub-stage-377b STAGE_TAG=<本次唯一字串> \
//	  go test -run TestStallConsentStageManual -v -timeout 300s .
import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector"
)

func TestStallConsentStageManual(t *testing.T) {
	if os.Getenv("RUN_STAGE_330") != "1" {
		t.Skip("手動驗收，設 RUN_STAGE_330=1（見檔頭）")
	}
	cy, ns, tag := os.Getenv("STAGE_CYPHER_URL"), os.Getenv("STAGE_INBOX_NS"), os.Getenv("STAGE_TAG")
	if cy == "" || !strings.HasPrefix(ns, "ahub-stage-") || tag == "" {
		t.Fatal("需要 STAGE_CYPHER_URL、STAGE_INBOX_NS（ahub-stage- 開頭的隔離租戶）、STAGE_TAG")
	}
	inbox := cy + "/webhooks/named/" + ns + "/feedback_report/trigger"
	t.Setenv("ARCRUN_FEEDBACK_INBOX", inbox)
	tempHome(t)

	// 一個「連線一接上就被掛斷」的知識庫，讓真的 collector 程式碼吐出真實的失敗字串。
	cutSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close()
	}))
	defer cutSrv.Close()
	watch := filepath.Join(t.TempDir(), "KB")
	_ = os.MkdirAll(watch, 0o755)
	writeCfgWithAccount(t, cutSrv.URL, accountCfg{Namespace: "ns-test", InstanceName: "測試知識庫-" + tag, WatchFolders: []string{watch}})

	_, cerr := (&http.Client{Timeout: 5 * time.Second}).Post(cutSrv.URL+"/portal/daemon/extract", "application/json", strings.NewReader("{}"))
	if cerr == nil {
		t.Fatal("掛斷的伺服器應該讓請求失敗")
	}
	realErr := "本地萃取失敗：" + collector.CloudCallErr(cerr).Error()
	t.Logf("真實失敗字串：%s", realErr)
	base := filepath.Join(appDir(), "manifest.json")
	mp := collector.ManifestPathFor(base, cutSrv.URL, watch)
	m := &collector.Manifest{FolderID: "t", Root: watch, Entries: map[string]*collector.ManifestEntry{}}
	for _, n := range []string{"NRI-期中報告-A.pdf", "NRI-期中報告-B.pdf"} {
		m.Entries[n] = &collector.ManifestEntry{ContentHash: "h", FailCount: 12, LastError: realErr}
	}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}

	cfg, _ := loadCfg()
	cards := uiStalls(cfg)
	t.Logf("① 小幫手判斷：%+v", cards)
	if len(cards) != 1 || cards[0].State != stallAsk || cards[0].Count != 2 {
		t.Fatalf("修不了的 2 份要問用戶：%+v", cards)
	}
	a := &App{}
	if err := a.ReportStall(cards[0].Fingerprint); err == nil {
		t.Fatal("沒看內容不准寄")
	}
	shown, err := a.StallPreview(cards[0].Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	head := shown
	if len(head) > 1500 {
		head = head[:1500] + "\n…（診斷資料以下略，畫面上可捲動看全部）"
	}
	t.Logf("② 給用戶看的內容（要寄出的就是這份）：\n%s", head)

	// 同一組卡，用戶先說「不用了」→ 什麼都不寄
	if err := a.DeclineStall(cards[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	cachedStalls(cfg, true)
	if again := uiStalls(cfg); len(again) != 0 {
		t.Fatalf("不用了之後不該再問：%+v", again)
	}
	t.Log("③ 按「不用了」：沒有寄出任何東西，卡片消失")

	// 換成「同意」：清掉剛才的決定（模擬 7 天後再問）
	_ = updateHelp(func(st *collector.HelpStore) { st.Items = map[string]collector.HelpEntry{} })
	cachedStalls(cfg, true)
	cards = uiStalls(cfg)
	if len(cards) != 1 {
		t.Fatalf("%+v", cards)
	}
	if _, err := a.StallPreview(cards[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := a.ReportStall(cards[0].Fingerprint); err != nil {
		t.Fatalf("同意後寄出失敗：%v", err)
	}
	cachedStalls(cfg, true)
	r1 := uiStalls(cfg)
	t.Logf("④ 按「同意通報」→ 卡片：%+v", r1)
	if len(r1) != 1 || r1[0].State != stallReported || r1[0].Ticket == "" {
		t.Fatalf("要變成已通報並帶票號：%+v", r1)
	}
	ticket1 := r1[0].Ticket

	// 同一個問題再通報一次（例如別台電腦／之後再卡住）：事件鍵相同 ⇒ 只多一則留言，票號不變
	_ = updateHelp(func(st *collector.HelpStore) { st.Items = map[string]collector.HelpEntry{} })
	t.Setenv("HOME", os.Getenv("HOME")) // 本機每小時 5 則上限：只送了 1 則，沒問題
	cachedStalls(cfg, true)
	cards = uiStalls(cfg)
	if _, err := a.StallPreview(cards[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := a.ReportStall(cards[0].Fingerprint); err != nil {
		t.Fatalf("第二次寄出失敗：%v", err)
	}
	cachedStalls(cfg, true)
	r2 := uiStalls(cfg)
	t.Logf("⑤ 同一個問題第二次通報 → 票號：%s（第一次：%s）", r2[0].Ticket, ticket1)
	if r2[0].Ticket != ticket1 {
		t.Fatalf("同一個問題要併進同一張票：%s vs %s", r2[0].Ticket, ticket1)
	}

	// 小幫手送上雲端的送件帳帶 reported＋票號
	st := collector.LoadHelpStore(collector.HelpStatePath(base))
	mm, _ := collector.LoadManifest(mp, watch)
	l := collector.BuildLedgerSummaryFor(mm.Entries, time.Now(), shortHost(cutSrv.URL), st)
	t.Logf("⑥ 送件帳 reasons：%+v", l.Reasons)
	if l.Reasons[0].Handling != collector.HandlingReported || l.Reasons[0].Ticket != ticket1 {
		t.Fatalf("%+v", l.Reasons)
	}
}
