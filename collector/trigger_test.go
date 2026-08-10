package collector

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockTrigger 用 httptest 模擬 arcrun named-webhook 觸發端點。
type mockTrigger struct {
	mu       sync.Mutex
	status   int // 回應狀態碼（預設 200）
	payloads []*TriggerPayload
}

func newMockTrigger(t *testing.T) (*httptest.Server, *mockTrigger) {
	t.Helper()
	m := &mockTrigger{status: http.StatusOK}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("Content-Type 應為 application/json，得到 %q", ct)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var p TriggerPayload
		if err := json.Unmarshal(body, &p); err != nil {
			t.Errorf("payload 不是合法 JSON: %v", err)
		}
		m.mu.Lock()
		m.payloads = append(m.payloads, &p)
		st := m.status
		m.mu.Unlock()
		w.WriteHeader(st)
		if st >= 500 {
			io.WriteString(w, `{"error":"mock 觸發失敗"}`)
		} else {
			io.WriteString(w, `{"success":true,"execution_id":"mock-exec"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, m
}

// syncRound 模擬 sync 的一輪：scan → upload（真 mock R2）→ 過濾 → POST → 2xx 才回寫。
// 與 main.run 的 sync 分支同邏輯（單測不跑 CLI 殼，直接組核心函式）。
func syncRound(t *testing.T, root string, m *Manifest, r2 *R2Client, url string) (*TriggerPayload, []UploadResult, *TriggerResult) {
	t.Helper()
	p := mustScan(t, root, m)
	uploads := UploadChanged(root, p.Events, r2)
	sendable, dropped := BuildSendablePayload(p, uploads)
	res := &TriggerResult{DroppedPaths: dropped}
	if len(sendable.Events) == 0 && len(sendable.Warnings) == 0 {
		res.Status = "skipped_no_changes"
		return sendable, uploads, res
	}
	status, err := SendTrigger(url, sendable, nil)
	res.HTTPStatus = status
	if err != nil {
		res.Status = "failed"
		res.Error = err.Error()
		return sendable, uploads, res
	}
	res.Status = "sent"
	res.MarkedCount = MarkIngestedEvents(m, sendable.Events, dropped, time.Now().Unix())
	return sendable, uploads, res
}

// 情境 1：成功回寫——上傳全成、觸發 2xx → added 事件的檔回寫 ingested_hash，
// 下一輪掃描歸零（不重發）；伺服器收到的 payload 帶 schema_version/folder_id/r2_key。
func TestSyncSuccessMarksIngested(t *testing.T) {
	_, _, r2 := newMockR2(t)
	srv, trig := newMockTrigger(t)
	root := t.TempDir()
	content := "sync 測試內容\n"
	writeFile(t, root, "a.md", content, baseTime)
	m := newTestManifest()

	_, uploads, res := syncRound(t, root, m, r2, srv.URL)

	if len(uploads) != 1 || uploads[0].Status != "uploaded" {
		t.Fatalf("要 1 筆 uploaded: %+v", uploads)
	}
	if res.Status != "sent" || res.MarkedCount != 1 || len(res.DroppedPaths) != 0 {
		t.Fatalf("要 sent＋marked 1: %+v", res)
	}
	e := m.Entries["a.md"]
	if e.IngestedHash != hashOf(content) || e.IngestedAt == 0 {
		t.Fatalf("觸發 2xx 後應回寫 ingested_hash: %+v", e)
	}
	// 伺服器收到的 payload 符合約定
	if len(trig.payloads) != 1 {
		t.Fatalf("要恰好 1 發觸發: %d", len(trig.payloads))
	}
	got := trig.payloads[0]
	if got.SchemaVersion != 1 || got.FolderID == "" {
		t.Fatalf("payload 頭欄位不對: %+v", got)
	}
	if len(got.Events) != 1 || got.Events[0].Type != "added" || got.Events[0].R2Key == "" {
		t.Fatalf("要 1 筆帶 r2_key 的 added: %+v", got.Events)
	}
	// 下一輪：無變更＝零事件、不再觸發
	_, _, res2 := syncRound(t, root, m, r2, srv.URL)
	if res2.Status != "skipped_no_changes" || len(trig.payloads) != 1 {
		t.Fatalf("無變更輪不該再觸發: %+v（觸發數 %d）", res2, len(trig.payloads))
	}
}

// 情境 2：觸發失敗（500）——不回寫 ingested_hash，下一輪同檔重發＝自然重試；
// 修好後（200）重試成功才回寫。
func TestSyncFailureNoMarkThenRetry(t *testing.T) {
	_, _, r2 := newMockR2(t)
	srv, trig := newMockTrigger(t)
	trig.status = http.StatusInternalServerError
	root := t.TempDir()
	content := "會先失敗的內容\n"
	writeFile(t, root, "b.md", content, baseTime)
	m := newTestManifest()

	_, _, res := syncRound(t, root, m, r2, srv.URL)
	if res.Status != "failed" || res.Error == "" || res.HTTPStatus != 500 {
		t.Fatalf("要 failed＋錯誤訊息: %+v", res)
	}
	if m.Entries["b.md"].IngestedHash != "" {
		t.Fatal("觸發失敗不得回寫 ingested_hash")
	}

	// 修好 → 下一輪重發（R2 端 skipped_exists no-op）→ 2xx → 回寫
	trig.status = http.StatusOK
	sendable, uploads, res2 := syncRound(t, root, m, r2, srv.URL)
	if res2.Status != "sent" || res2.MarkedCount != 1 {
		t.Fatalf("重試輪應 sent＋marked 1: %+v", res2)
	}
	if len(uploads) != 1 || uploads[0].Status != "skipped_exists" {
		t.Fatalf("重試輪 R2 應 no-op: %+v", uploads)
	}
	if len(sendable.Events) != 1 || sendable.Events[0].Type != "added" {
		t.Fatalf("重試輪應重發 added: %+v", sendable.Events)
	}
	if m.Entries["b.md"].IngestedHash != hashOf(content) {
		t.Fatal("重試成功後應回寫 ingested_hash")
	}
}

// 情境 3：防呆警告輪（mass_delete_guard）——removed 事件被壓下，但 payload 連同
// warnings 照送（消費端看得到警告、不執行下架）；沒有任何回寫。
func TestSyncGuardRoundStillSendsWarnings(t *testing.T) {
	_, _, r2 := newMockR2(t)
	srv, trig := newMockTrigger(t)
	root := t.TempDir()
	m := newTestManifest()
	// 先建 3 檔並完成一輪成功 sync（全部標 ingested）
	for _, n := range []string{"a.md", "b.md", "c.md"} {
		writeFile(t, root, n, n+" content\n", baseTime)
	}
	if _, _, res := syncRound(t, root, m, r2, srv.URL); res.Status != "sent" || res.MarkedCount != 3 {
		t.Fatalf("前置輪應全成: %+v", res)
	}
	// 刪 2/3（67% > 40% 門檻）→ 防呆
	os.Remove(root + "/a.md")
	os.Remove(root + "/b.md")

	sendable, _, res := syncRound(t, root, m, r2, srv.URL)
	if res.Status != "sent" {
		t.Fatalf("警告輪應照送: %+v", res)
	}
	if len(sendable.Events) != 0 {
		t.Fatalf("防呆輪不得夾帶任何事件（removed 已壓下）: %+v", sendable.Events)
	}
	if len(sendable.Warnings) != 1 || sendable.Warnings[0].Code != "mass_delete_guard" {
		t.Fatalf("要 mass_delete_guard 警告: %+v", sendable.Warnings)
	}
	got := trig.payloads[len(trig.payloads)-1]
	if len(got.Warnings) != 1 || got.Warnings[0].Code != "mass_delete_guard" || len(got.Events) != 0 {
		t.Fatalf("伺服器端收到的警告輪不對: %+v", got)
	}
	if res.MarkedCount != 0 {
		t.Fatalf("警告輪無內容事件，不該回寫: %+v", res)
	}
}

// 情境 4（純函式）：上傳失敗的 added/modified 不隨 payload 送出；同路徑的 renamed
// 也不得回寫（否則內容從未上 R2 卻被標 ingested）。
func TestBuildSendableDropsFailedUploads(t *testing.T) {
	h1, h2 := hashOf("one"), hashOf("two")
	p := &TriggerPayload{
		SchemaVersion: 1, FolderID: "f",
		Events: []Event{
			{Type: "added", Path: "ok.md", SourceHash: h1, R2Key: r2KeyOf(h1)},
			{Type: "added", Path: "bad.md", SourceHash: h2, R2Key: r2KeyOf(h2)},
			{Type: "renamed", Path: "bad.md", OldPath: "old-bad.md", SourceHash: h2},
			{Type: "removed", Path: "gone.md", SourceHash: hashOf("g")},
		},
	}
	uploads := []UploadResult{
		{Path: "ok.md", Status: "uploaded"},
		{Path: "bad.md", Status: "failed", Error: "mock"},
	}
	sendable, dropped := BuildSendablePayload(p, uploads)
	if len(dropped) != 1 || dropped[0] != "bad.md" {
		t.Fatalf("要擋下 bad.md: %v", dropped)
	}
	types := []string{}
	for _, ev := range sendable.Events {
		types = append(types, ev.Type+":"+ev.Path)
	}
	want := "added:ok.md renamed:bad.md removed:gone.md"
	if strings.Join(types, " ") != want {
		t.Fatalf("送出清單不對：%v（要 %s）", types, want)
	}
	// 回寫：ok.md 回寫；bad.md 的 renamed 因同路徑被擋下也不回寫
	m := newTestManifest()
	m.Entries["ok.md"] = &ManifestEntry{ContentHash: h1}
	m.Entries["bad.md"] = &ManifestEntry{ContentHash: h2}
	n := MarkIngestedEvents(m, sendable.Events, dropped, 42)
	if n != 1 || m.Entries["ok.md"].IngestedHash != h1 {
		t.Fatalf("只該回寫 ok.md: n=%d %+v", n, m.Entries["ok.md"])
	}
	if m.Entries["bad.md"].IngestedHash != "" {
		t.Fatal("上傳失敗檔的 renamed 不得回寫 ingested_hash")
	}
}

// 附加：ARCRUN_TRIGGER_URL 缺漏／格式錯，清楚報錯。
func TestLoadTriggerURL(t *testing.T) {
	t.Setenv("ARCRUN_TRIGGER_URL", "")
	if _, err := LoadTriggerURLFromEnv(); err == nil || !strings.Contains(err.Error(), "ARCRUN_TRIGGER_URL") {
		t.Fatalf("缺 env 應報含變數名的錯: %v", err)
	}
	t.Setenv("ARCRUN_TRIGGER_URL", "not-a-url")
	if _, err := LoadTriggerURLFromEnv(); err == nil {
		t.Fatal("非完整 URL 應報錯")
	}
	t.Setenv("ARCRUN_TRIGGER_URL", "https://example.com/webhooks/named/demo/rag_ingest/trigger")
	u, err := LoadTriggerURLFromEnv()
	if err != nil || u == "" {
		t.Fatalf("合法 URL 應通過: %v", err)
	}
}
