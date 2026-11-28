// slicememo_test.go — inkstone/arcrun-rag#399：大卡分段送斷在中途，下一輪只補沒送達的段。
package collector

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSliceMemoBasics(t *testing.T) {
	m := &Manifest{Entries: map[string]*ManifestEntry{"a.md": {}}, CloudVersion: "1.4.336"}
	body := map[string]any{"card_content": "x", "page_name": "p"}
	sl := cardSlice{Offset: 50, Limit: 50, Scope: "s1"}
	key := sliceMemoKey(body, sl)
	if m.SliceSent("a.md", key, sl.Offset, 100) {
		t.Fatal("沒記過不該略過")
	}
	m.MarkSliceSent("a.md", key, 100)
	if !m.SliceSent("a.md", key, sl.Offset, 200) {
		t.Fatal("記過、同雲端版本、沒過期，應略過")
	}
	if m.SliceSent("a.md", key, 0, 200) {
		t.Fatal("第一段（offset 0）是提交標記，永遠要送")
	}
	body2 := map[string]any{"card_content": "y", "page_name": "p"}
	if m.SliceSent("a.md", sliceMemoKey(body2, sl), sl.Offset, 200) {
		t.Fatal("卡片內容變了＝另一段，不能略過")
	}
	if m.SliceSent("a.md", key, sl.Offset, 100+sliceMemoTTL+1) {
		t.Fatal("過了 TTL 不該再信")
	}
	m.CloudVersion = "1.4.337"
	if m.SliceSent("a.md", key, sl.Offset, 200) {
		t.Fatal("雲端版本變了（可能重裝過）不該再信")
	}
	m.CloudVersion = "1.4.336"
	m.ClearSentSlices("a.md")
	if m.SliceSent("a.md", key, sl.Offset, 200) {
		t.Fatal("清掉之後不該略過")
	}
	m.MarkSliceSent("a.md", key, 300)
	m.MarkIngestedBy("a.md", "h", 301, "")
	if m.Entries["a.md"].SentSlices != nil {
		t.Fatal("整份蓋章後記帳要清掉")
	}
}

// 重現 inkstone/arcrun-rag#399：知識庫資料庫忙（每 5 發就有 1 發回 503 d1_overloaded），
// 一份要切 N 段的大卡，一輪得連續過完所有段。沒有分段記帳時永遠送不完；有了就幾輪內送完，
// 而且**每一段只寫一次**（不再白刪白寫已經送達的段）。
func TestBigDocSurvivesBusyKnowledgeBase_SlicesResumeInsteadOfRewrite(t *testing.T) {
	done, rounds, writes := runBusyKnowledgeBase(t, false)
	if !done {
		t.Fatalf("跑了 %d 輪仍沒送完——分段送的進度沒有留住", rounds)
	}
	for k, n := range writes {
		parts := strings.Split(k, "|")
		if parts[2] != "0" && n > 1 { // parts：頁名｜名字｜offset｜內容長度（同一版內容）
			t.Errorf("後面的段 %q 被寫了 %d 次——已經送達的段不該再重寫", k, n)
		}
	}
	if len(writes) < 4 {
		t.Fatalf("前提：這份檔應切成多段，實際只有 %d 種寫入：%v", len(writes), writes)
	}
	t.Logf("%d 輪送完、雲端共收 %d 種段、每段只寫一次", rounds, len(writes))
}

// 對照組：關掉分段記帳（＝#399 之前的行為），同一個忙碌的知識庫送不完，且白白重寫已送達的段。
func TestBigDocSurvivesBusyKnowledgeBase_WithoutMemoNeverFinishes(t *testing.T) {
	done, rounds, writes := runBusyKnowledgeBase(t, true)
	rewrote := 0
	for k, n := range writes {
		if parts := strings.Split(k, "|"); parts[2] != "0" && n > 1 {
			rewrote++
		}
	}
	t.Logf("沒有分段記帳：%d 輪 done=%v，重寫了 %d 段", rounds, done, rewrote)
	if done {
		t.Fatal("對照組不該送完：雲端每 5 發寫入就有 1 發 503，一輪要連續過完 12 段本來就過不了")
	}
	if rewrote == 0 {
		t.Fatal("對照組應該看得到白白重寫已送達的段")
	}
}

func runBusyKnowledgeBase(t *testing.T, memoOff bool) (done bool, rounds int, writes map[string]int) {
	sliceMemoDisabled = memoOff
	t.Cleanup(func() { sliceMemoDisabled = false })
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	t.Cleanup(func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() })
	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	t.Cleanup(func() { fetchCloudVersion = origFetch })

	root := t.TempDir()
	writeBigDoc(t, root, "大報告.md", 700)

	var mu sync.Mutex
	writes = map[string]int{} // 頁名|三元組名字|offset|內容長度 → 實際寫了幾次（模擬雲端的 delete＋rewrite）
	var cardReqs int32
	cloudDone := map[string]bool{}
	failEvery := 5
	var extractHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(`{"ok":true,"status":"ok","data_layer":{"ok":true,"summary":"ok"},"bundle_version":"1.4.336"}`))
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			if isWorkersAIProbeBody(r) {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "{}"})
				return
			}
			n := int(atomic.AddInt32(&extractHits, 1))
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": chunkWithFacts(n, 3)})
		case strings.Contains(r.URL.Path, "rag_ingest_card/trigger"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			pn, _ := m["page_name"].(string)
			if strings.HasPrefix(pn, "00-INDEX") || strings.HasPrefix(pn, "資料夾總覽") {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
				return
			}
			scope, _ := m["triplet_scope"].(string)
			off, _ := m["rel_offset"].(float64)
			cc, _ := m["card_content"].(string)
			key := pn + "|" + scope + "|" + jsonNum(off) + "|" + cc[:min(len(cc), 64)] + fmt.Sprint(len(cc))
			mu.Lock()
			// 模擬雲端 pick_stale：第一段（或整張一發）寫過同樣內容＝沒變、什麼都不寫；
			// 後面的段要等「第一段已提交」才認得自己是寫好的，否則照舊刪光重寫（#399 的病根）。
			firstKey := pn + "|" + "" + "|0|" + cc[:min(len(cc), 64)] + fmt.Sprint(len(cc))
			isWrite := true
			if off == 0 {
				isWrite = !cloudDone[key]
			} else {
				isWrite = !(cloudDone[key] && cloudDone[pn+"|committed|"+fmt.Sprint(len(cc))])
			}
			_ = firstKey
			if isWrite {
				if pn == "大報告" {
					cardReqs++
				}
				if pn == "大報告" && cardReqs%int32(failEvery) == 0 {
					mu.Unlock()
					w.Header().Set("Retry-After", "2")
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"success":false,"error":"kbdb_busy","reason":"d1_overloaded","retryable":true}`))
					return
				}
				writes[pn+"|"+scope+"|"+jsonNum(off)+"|"+fmt.Sprint(len(cc))]++
				cloudDone[key] = true
				if off == 0 && scope == "" {
					cloudDone[pn+"|committed|"+fmt.Sprint(len(cc))] = true
				}
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	}))
	defer srv.Close()

	cfg := &DirectConfig{
		WatchFolders: []string{root}, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true, CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	old := directNow
	directNow = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	t.Cleanup(func() { directNow = old })

	for rounds = 1; rounds <= 25 && !done; rounds++ {
		resetCloudChecks()
		cloudRoutes.reset()
		clock.Add(int64(7 * time.Hour)) // 過了上一輪的退避窗口（最長 6 小時），但還在記帳有效期內
		res, _, _ := RunDirectOnce(cfg, false)
		for _, r := range res {
			if r.Path == "大報告.md" {
				t.Logf("round %d: %s %s", rounds, r.Status, r.Error)
			}
		}
		m1, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			t.Fatal(err)
		}
		if e := m1.Entries["大報告.md"]; e != nil && e.IngestedHash != "" {
			done = true
		}
	}
	mu.Lock()
	defer mu.Unlock()
	out := map[string]int{}
	for k, v := range writes {
		out[k] = v
	}
	return done, rounds - 1, out
}

func jsonNum(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}
