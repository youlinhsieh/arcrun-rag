// d1_write_quota_test.go — 寫入側撞頂的畫面要對齊讀取側（`inkstone/InkStoneCo#140` 條件③，
// 讀取側＝`inkstone/arcrun-rag#197`）。
//
// 讀取側當初接得起來，靠的是 `/health` 的 `data_layer.probe_error`：那支探針是**讀**，
// 讀的額度爆了它自己就會講。**寫入的額度爆了，那支探針照樣是綠的**——
// 寫入撞頂只會在「送一張卡出去」的那一發回來。而那一發的形狀是這個 repo 已經吃過一次虧的：
// named-webhook 觸發成功一律回 **HTTP 200**，失敗證據住在 body 裡（triggeroutcome.go 檔頭）。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

// d1WriteLimitText＝Cloudflare D1 免費層寫入撞頂的原文（讀取側那句的寫入版）。
const d1WriteLimitText = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. " +
	"Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."

// 送卡那一發回 HTTP 200，而寫入額度用完的證據在外殼裡面。
// 這是送卡真正會拿到的形狀，不是 500。
func TestD1WriteQuota_LearnsFromEnvelopedFailure(t *testing.T) {
	resetD1Quota()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); cloudRoutes.reset() }()

	var posts int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&posts, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":false,"status":500,` +
			`"error":"` + strings.ReplaceAll(d1WriteLimitText, `"`, `\"`) + `"},"duration_ms":2476}`))
	}))
	defer srv.Close()

	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k"}
	url := srv.URL + "/webhooks/named/ns/rag_ingest_card/trigger"

	_, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{})
	if err == nil {
		t.Fatal("外殼說 success、工作流說失敗 ⇒ 這一發要算失敗")
	}
	if st, ok := activeD1Quota(srv.URL, directNow()); !ok || st.kind != QuotaKindD1Write {
		t.Fatalf("200 外殼裡的寫入額度原文也要認得出來，got %+v ok=%v", st, ok)
	}
	// 認出來之後就不准再打——每一發都只會拿到同一個錯，還在燒同一個帳號的別的額度。
	for i := 0; i < 3; i++ {
		if _, _, err := cfg.postJSON(stepIngestCard, url, map[string]any{}); !isRouteBackoff(err) {
			t.Fatalf("第 %d 發應被擋下，got %v", i+2, err)
		}
	}
	if got := atomic.LoadInt64(&posts); got != 1 {
		t.Fatalf("只該打出 1 發，got %d", got)
	}
}

// 撞頂那一張卡自己的錯誤訊息，就是使用者在畫面上讀到的那句。
// 它要講清楚「是額度、幾點恢復、你不用做事」，不能只說「沒寫進去，稍後再試」。
func TestD1WriteQuota_SentenceSaysQuotaNotJustRetry(t *testing.T) {
	resetD1Quota()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); cloudRoutes.reset() }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"success":false,` +
			`"error":"` + strings.ReplaceAll(d1WriteLimitText, `"`, `\"`) + `"}}`))
	}))
	defer srv.Close()

	cfg := &DirectConfig{CypherURL: srv.URL, Namespace: "ns", APIKey: "k"}
	_, _, err := cfg.postJSON(stepIngestCard, srv.URL+"/webhooks/named/ns/rag_ingest_card/trigger", map[string]any{})
	if err == nil {
		t.Fatal("應該失敗")
	}
	msg := err.Error()
	for _, want := range []string{"額度", "8:00", "自動"} {
		if !strings.Contains(msg, want) {
			t.Errorf("撞頂的訊息要講「%s」：%q", want, msg)
		}
	}
	// 讀取側的紅線：不裸露上游的技術原文（cloudquota.go／triggeroutcome.go 檔頭）。
	for _, banned := range []string{"D1_ERROR", "free tier", "midnight UTC", "HTTP"} {
		if strings.Contains(msg, banned) {
			t.Errorf("不該裸露上游原文 %q：%q", banned, msg)
		}
	}
	// #153：被擋下的檔要帶著「講得出為什麼」的句子出現在畫面上，不能安靜消失。
	if note := d1QuotaNote(srv.URL, directNow()); !explainsWhySkipped(note) {
		t.Errorf("退避那句要講得出原因：%q", note)
	}
}

// 「無法同步 N 份」展開的分類，不准把雲端資料庫的寫入額度講成 AI 額度——
// 那正是 #197 在治的歸錯因（使用者會以為換一個模型就好，但換模型救不了資料庫）。
func TestClassifyFailure_D1WriteQuotaIsNotAIQuota(t *testing.T) {
	now := directNow()
	sentence := buildD1QuotaNotice(QuotaKindD1Write, now, nextQuotaResetTaiwan(now)).Combined()
	for name, raw := range map[string]string{
		"上游原文":        d1WriteLimitText,
		"我們組給使用者看的那句": sentence,
	} {
		got := ClassifyFailure(raw)
		if got == FailQuotaExhausted {
			t.Errorf("%s 被歸成 AI 額度（%q），會叫使用者去換模型", name, got)
		}
		if got == FailOther {
			t.Errorf("%s 被歸成「其他」（%q），畫面等於沒講原因", name, got)
		}
	}
}

// 文案與判準分居兩處 ⇒ 改了措辭就對不上，而後果不是報錯，是畫面上一句原因都沒有
// （routebackoff.go `explainsWhySkipped` 檔頭那筆實錄）。這支把兩邊釘在一起。
func TestD1QuotaMarks_StayInSyncWithTheWording(t *testing.T) {
	now := directNow()
	for _, kind := range []string{QuotaKindD1Read, QuotaKindD1Write} {
		n := buildD1QuotaNotice(kind, now, nextQuotaResetTaiwan(now))
		if !isD1QuotaText(n.Headline) {
			t.Errorf("%s 的 Headline 認不出來了，d1QuotaMarks 要跟著文案改：%q", kind, n.Headline)
		}
		if !isD1QuotaText(n.Combined()) {
			t.Errorf("%s 的三句話認不出來了：%q", kind, n.Combined())
		}
		if !explainsWhySkipped(d1QuotaSentence("測試", kind, now)) {
			t.Errorf("%s 的人話句要講得出為什麼（#153）", kind)
		}
	}
}

// 端到端：一個新用戶把資料夾拖進來，送到一半雲端寫入額度撞頂。
// 驗的是他真的會看到的那份 status.json——首頁那張卡與「送不上去」的分類都吃它。
func TestDirect_D1WriteQuota_StatusFileSpeaksHuman(t *testing.T) {
	resetD1Quota()
	cloudRoutes.reset()
	defer func() { resetD1Quota(); cloudRoutes.reset() }()

	root := t.TempDir()
	for _, name := range []string{"a.md", "b.md", "c.md"} {
		writeFile(t, root, name, "# 報銷規則\n\n上限 3000 元。", baseTime)
	}

	var cardPosts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/webhooks/named/demo/rag_ingest_card/trigger") {
			atomic.AddInt32(&cardPosts, 1)
			// 送卡撞到寫入上限的真實形狀：外殼 200、失敗住在 data 裡。
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"data":{"success":false,"status":500,` +
				`"error":"` + strings.ReplaceAll(d1WriteLimitText, `"`, `\"`) + `"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	defer gemmaStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content": map[string]any{"parts": []map[string]any{{"text": cardFixture("報銷規則", "財務")}}},
			}},
		})
	})()

	manifest := filepath.Join(t.TempDir(), "m.json")
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     manifest,
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, _, _ := RunDirectOnce(cfg, false)

	// 三份檔都該被「擋下」而不是「失敗」——沒打出去就不是這個檔的錯（#121），
	// 而且每一則都要帶著講得出原因的那句話，不准安靜消失（#153）。
	var skipped int
	for _, r := range results {
		if r.Type == "added" {
			if r.Status != "skipped" {
				t.Errorf("撞頂後這一份不該再打出去：%+v", r)
			}
			if !strings.Contains(r.Error, "額度") || !explainsWhySkipped(r.Error) {
				t.Errorf("被擋下的檔要講得出為什麼：%q", r.Error)
			}
			skipped++
		}
	}
	if skipped != 3 {
		t.Fatalf("三份檔都該出現在畫面上，got %d：%+v", skipped, results)
	}

	raw, err := os.ReadFile(filepath.Join(filepath.Dir(manifest), "status.json"))
	if err != nil {
		t.Fatalf("讀不到 status.json：%v", err)
	}
	var st SyncStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("status.json 壞了：%v", err)
	}

	// ① 首頁那張卡：kind 要是 d1_write，畫面才會走 #197 那一支（main.js cardQuota）。
	var notice *QuotaNotice
	for _, acc := range st.AccountDetails {
		if acc.QuotaMessage != nil {
			notice = acc.QuotaMessage
		}
	}
	if notice == nil {
		t.Fatal("status.json 裡沒有額度訊息 ⇒ 首頁那張卡不會出現，使用者只看得到「送不上去 N 份」")
	}
	if notice.Kind != QuotaKindD1Write {
		t.Fatalf("要標成寫入額度（前端靠 kind 分支，不猜字串），got %q", notice.Kind)
	}
	for _, want := range []string{"寫入", "8:00"} {
		if !strings.Contains(notice.Headline+notice.Usage+notice.Guarantee, want) {
			t.Errorf("畫面上的三句話要講「%s」：%+v", want, notice)
		}
	}

	// ② 「送不上去」展開的分類，不准說成 AI 額度、也不准落到「其他」。
	var cats []string
	for _, g := range st.FailureBreakdown.Groups {
		cats = append(cats, g.Category)
		if g.Category == FailQuotaExhausted {
			t.Errorf("雲端資料庫的寫入額度被講成 AI 額度 ⇒ 使用者會去換模型，而換模型救不了資料庫")
		}
	}
	if len(cats) > 0 && !slices.Contains(cats, FailCloudDBQuota) {
		t.Errorf("分類要是 %q，got %v", FailCloudDBQuota, cats)
	}

	// ③ 認出來之後不再重打——撞頂期間每一發都只會拿到同一個錯，還在燒同帳號別的額度。
	if got := atomic.LoadInt32(&cardPosts); got != 1 {
		t.Errorf("撞頂後應停打，送卡只該打出 1 發，got %d", got)
	}
}
