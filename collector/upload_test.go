package collector

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testAccount = "acct-test"
	testBucket  = "bkt-test"
	testToken   = "tok-test" // 假 token，只給 httptest mock 驗 header 用
)

// mockR2 用 httptest 模擬 Cloudflare R2 REST API 的 objects 端點。
// 對齊 2026-07-19 live 實測行為：HEAD 回 405（真 API 不支援）、存在檢查走 GET。
type mockR2 struct {
	mu          sync.Mutex
	objects     map[string][]byte
	existsCount int // GET（存在檢查）次數
	putCount    int
	failPut     bool // true＝PUT 一律回 500（模擬上傳失敗）
}

func newMockR2(t *testing.T) (*httptest.Server, *mockR2, *R2Client) {
	t.Helper()
	m := &mockR2{objects: map[string][]byte{}}
	prefix := "/client/v4/accounts/" + testAccount + "/r2/buckets/" + testBucket + "/objects/"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if !strings.HasPrefix(r.URL.Path, prefix) {
			t.Errorf("非預期路徑: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, prefix)
		m.mu.Lock()
		defer m.mu.Unlock()
		switch r.Method {
		case http.MethodHead: // 真 API 行為：objects 端點不支援 HEAD
			w.WriteHeader(http.StatusMethodNotAllowed)
		case http.MethodGet:
			m.existsCount++
			body, ok := m.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				io.WriteString(w, `{"success":false,"errors":[{"code":10007,"message":"object not found"}]}`)
				return
			}
			if r.Header.Get("Range") != "" && len(body) > 0 {
				w.WriteHeader(http.StatusPartialContent)
				w.Write(body[:1])
				return
			}
			w.Write(body)
		case http.MethodPut:
			m.putCount++
			if m.failPut {
				w.WriteHeader(http.StatusInternalServerError)
				io.WriteString(w, `{"success":false,"errors":[{"code":10000,"message":"mock 上傳失敗"}]}`)
				return
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			m.objects[key] = body
			io.WriteString(w, `{"success":true}`)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	client := NewR2Client(R2Config{
		AccountID: testAccount, APIToken: testToken, Bucket: testBucket,
		BaseURL: srv.URL + "/client/v4",
	})
	return srv, m, client
}

// 情境 1：新檔上傳——PUT 到 raw/<sha256hex>、body 與檔案內容一致、帶 Bearer token；
// 上傳成功也「不」標 ingested（ingested_hash 由 task 4 整鏈成功後經 MarkIngested 回寫）。
func TestUploadNew(t *testing.T) {
	_, mock, client := newMockR2(t)
	root := t.TempDir()
	content := "上傳測試內容 v1\n"
	writeFile(t, root, "a.md", content, baseTime)
	m := newTestManifest()
	p := mustScan(t, root, m)

	results := UploadChanged(root, p.Events, client)

	if len(results) != 1 || results[0].Status != "uploaded" {
		t.Fatalf("要 1 筆 uploaded，得到: %+v", results)
	}
	wantKey := "raw/" + strings.TrimPrefix(hashOf(content), "sha256:")
	if results[0].R2Key != wantKey {
		t.Fatalf("r2_key 不對: %s", results[0].R2Key)
	}
	if got, ok := mock.objects[wantKey]; !ok || string(got) != content {
		t.Fatalf("R2 端物件內容不符: ok=%v got=%q", ok, string(got))
	}
	if mock.putCount != 1 || mock.existsCount != 1 {
		t.Fatalf("要 1 存在檢查 + 1 PUT，得到 exists=%d put=%d", mock.existsCount, mock.putCount)
	}
	if m.Entries["a.md"].IngestedHash != "" {
		t.Fatal("上傳成功 ≠ ingest 完成，掃描/上傳階段不得寫 ingested_hash")
	}
}

// 情境 2：同 hash 重傳＝no-op——存在檢查命中就不 PUT（content-addressed 冪等，design §4）。
func TestUploadExistingNoOp(t *testing.T) {
	_, mock, client := newMockR2(t)
	root := t.TempDir()
	content := "同一份內容\n"
	writeFile(t, root, "b.md", content, baseTime)
	key := "raw/" + strings.TrimPrefix(hashOf(content), "sha256:")
	mock.objects[key] = []byte(content) // 模擬先前已上傳過同 hash（可能來自別的路徑/別台機器）

	m := newTestManifest()
	p := mustScan(t, root, m)
	results := UploadChanged(root, p.Events, client)

	if len(results) != 1 || results[0].Status != "skipped_exists" {
		t.Fatalf("要 skipped_exists，得到: %+v", results)
	}
	if mock.putCount != 0 {
		t.Fatalf("存在檢查命中後不得 PUT，putCount=%d", mock.putCount)
	}
	if mock.existsCount != 1 {
		t.Fatalf("要恰好 1 次存在檢查，得到 %d", mock.existsCount)
	}
}

// 情境 3：上傳失敗（PUT 500）——結果標 failed 帶錯誤、絕不標 ingested；
// manifest 的 content_hash 照掃描更新（ingested_hash 仍空＝下輪自然重試，design §2）。
func TestUploadFailedNotIngested(t *testing.T) {
	_, mock, client := newMockR2(t)
	mock.failPut = true
	root := t.TempDir()
	writeFile(t, root, "c.md", "會失敗的內容\n", baseTime)
	m := newTestManifest()
	p := mustScan(t, root, m)

	results := UploadChanged(root, p.Events, client)

	if len(results) != 1 || results[0].Status != "failed" || results[0].Error == "" {
		t.Fatalf("要 failed＋錯誤訊息，得到: %+v", results)
	}
	e := m.Entries["c.md"]
	if e == nil || e.IngestedHash != "" || e.IngestedAt != 0 {
		t.Fatalf("上傳失敗不得標 ingested: %+v", e)
	}
	if e.ContentHash != hashOf("會失敗的內容\n") {
		t.Fatalf("content_hash 應照掃描更新（重試靠 ingested_hash 空）: %+v", e)
	}
	// 失敗後同檔重掃＝事件重發（重試語意）
	p2 := mustScan(t, root, m)
	if len(p2.Events) != 1 || p2.Events[0].Type != "added" {
		t.Fatalf("失敗後下輪應重發 added: %+v", p2.Events)
	}
}

// 附加：renamed/removed 事件不上傳（內容未變/已留底，design §3+§4）。
func TestUploadSkipsNonContentEvents(t *testing.T) {
	_, mock, client := newMockR2(t)
	root := t.TempDir()
	results := UploadChanged(root, []Event{
		{Type: "renamed", Path: "x.md", OldPath: "y.md", SourceHash: hashOf("x")},
		{Type: "removed", Path: "z.md", SourceHash: hashOf("z")},
	}, client)
	if len(results) != 0 {
		t.Fatalf("renamed/removed 不該有上傳結果: %+v", results)
	}
	if mock.existsCount != 0 || mock.putCount != 0 {
		t.Fatalf("不該碰網路: head=%d put=%d", mock.existsCount, mock.putCount)
	}
}

// 附加：content-addressed 完整性——檔案在掃描後被改動（hash 不符 key）＝failed 不上傳，
// 不能把新內容塞進舊 hash 的 key。
func TestUploadHashMismatch(t *testing.T) {
	_, mock, client := newMockR2(t)
	root := t.TempDir()
	writeFile(t, root, "d.md", "掃描時內容\n", baseTime)
	m := newTestManifest()
	p := mustScan(t, root, m)

	// 掃描後、上傳前檔案被改動
	writeFile(t, root, "d.md", "上傳前偷偷改了\n", baseTime.Add(time.Second))
	results := UploadChanged(root, p.Events, client)

	if len(results) != 1 || results[0].Status != "failed" {
		t.Fatalf("hash 不符應 failed: %+v", results)
	}
	if mock.putCount != 0 {
		t.Fatalf("hash 不符不得 PUT: %d", mock.putCount)
	}
}

// 附加：設定缺環境變數＝清楚報缺哪幾個。
func TestLoadR2ConfigMissing(t *testing.T) {
	t.Setenv("CF_ACCOUNT_ID", "")
	t.Setenv("CF_API_TOKEN", "")
	t.Setenv("R2_BUCKET", "b")
	_, err := LoadR2ConfigFromEnv()
	if err == nil {
		t.Fatal("缺 env 應報錯")
	}
	msg := err.Error()
	if !strings.Contains(msg, "CF_ACCOUNT_ID") || !strings.Contains(msg, "CF_API_TOKEN") || strings.Contains(msg, "R2_BUCKET,") {
		t.Fatalf("錯誤訊息應列出缺的變數: %s", msg)
	}
}

// 附加：MarkIngested 回寫鉤子（task 4 用）——存在的路徑回寫成功、消失的路徑回 false。
func TestMarkIngested(t *testing.T) {
	m := newTestManifest()
	m.Entries["a.md"] = &ManifestEntry{ContentHash: hashOf("a"), Size: 1, Mtime: 2}
	if !m.MarkIngested("a.md", hashOf("a"), 99) {
		t.Fatal("存在的路徑應回寫成功")
	}
	if m.Entries["a.md"].IngestedHash != hashOf("a") || m.Entries["a.md"].IngestedAt != 99 {
		t.Fatalf("回寫值不對: %+v", m.Entries["a.md"])
	}
	if m.MarkIngested("gone.md", hashOf("g"), 1) {
		t.Fatal("不存在的路徑應回 false")
	}
}
