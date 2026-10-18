// cardslice_e2e_test.go — arcrun-rag#255：關係多的卡切段送、送的順序、舊版雲端不切。
// 端到端：原稿 → 本機萃卡 → POST rag_ingest_card（假雲端記下每一發的欄位）。
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
)

// chunkWithFacts＝續讀機制每一段萃取回的模型輸出：一個概念＋factsPerChunk 條事實。
// 文件卡（hub）會把各段的事實併成「## 關聯」，所以段數 × factsPerChunk ≈ hub 的關係條數。
func chunkWithFacts(n, factsPerChunk int) string {
	facts := make([]string, 0, factsPerChunk)
	for i := 0; i < factsPerChunk; i++ {
		facts = append(facts, fmt.Sprintf(`["主體%d-%d","依賴","客體%d-%d"]`, n, i, n, i))
	}
	return fmt.Sprintf(`{"gloss":"段落%d","summary":"這是第 %d 段的摘要句子","points":["這是第 %d 段的重點句"],`+
		`"concepts":[{"name":"概念%d","gloss":"一句話","summary":"摘要內容一段話","points":["重點一句話"],`+
		`"entities":[{"name":"主體%d-0","type":"概念","desc":"測試主體"},{"name":"客體%d-0","type":"組織","desc":"測試客體"}],`+
		`"facts":[%s],"relations":[]}]}`, n, n, n, n, n, n, strings.Join(facts, ","))
}

type sliceCall struct {
	Page   string
	Scope  string
	Offset float64
	Limit  float64
	Rels   int
}

// runBigDoc＝跑一份走續讀機制的大檔（所以概念卡也會上雲），回假雲端收到的每一發。
func runBigDoc(t *testing.T, bundleVersion string, records int) []sliceCall {
	t.Helper()
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	t.Cleanup(func() { resetD1Quota(); resetCloudChecks(); cloudRoutes.reset() })
	// 測試環境預設把查雲端版本換成替身（不打網路）；這裡要的是「真的去問假雲端的 /health」。
	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	t.Cleanup(func() { fetchCloudVersion = origFetch })

	root := t.TempDir()
	writeBigDoc(t, root, "大報告.md", records)
	var mu sync.Mutex
	var calls []sliceCall
	var extractHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(`{"ok":true,"status":"ok","data_layer":{"ok":true,"summary":"ok"},"bundle_version":"` + bundleVersion + `"}`))
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			if isWorkersAIProbeBody(r) {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "{}"})
				return
			}
			n := int(atomic.AddInt32(&extractHits, 1))
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": chunkWithFacts(n, 3)})
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree"):
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		case strings.Contains(r.URL.Path, "rag_ingest_card/trigger"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			pn, _ := m["page_name"].(string)
			if strings.HasPrefix(pn, "00-INDEX") || strings.HasPrefix(pn, "資料夾總覽") {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
				return
			}
			c := sliceCall{Page: pn}
			c.Scope, _ = m["triplet_scope"].(string)
			c.Offset, _ = m["rel_offset"].(float64)
			c.Limit, _ = m["rel_limit"].(float64)
			cc, _ := m["card_content"].(string)
			c.Rels = countCardRelations(cc)
			mu.Lock()
			calls = append(calls, c)
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
	// 續讀一輪讀不完（見 maxChunksPerInvocation）⇒ 跑到蓋章為止；卡只在蓋章那輪之前陸續送，
	// 每輪重送的都是同一批，所以只取最後一輪的呼叫。
	for round := 0; round < 12; round++ {
		resetCloudChecks()
		mu.Lock()
		calls = nil
		mu.Unlock()
		RunDirectOnce(cfg, false)
		m1, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			t.Fatal(err)
		}
		if e := m1.Entries["大報告.md"]; e != nil && e.IngestedHash != "" {
			break
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return append([]sliceCall(nil), calls...)
}

func hubCalls(calls []sliceCall) (hub []sliceCall) {
	for _, c := range calls {
		if c.Page == "大報告" {
			hub = append(hub, c)
		}
	}
	return
}

// 新版雲端：關係超過上限的文件卡切段、從最後一段往前送、第一段最後送；
// 概念卡各有自己的三元組名字（不再刪光同一份文件其他卡的）。
func TestBigDocToNewCloud_HubSlicedLastSliceFirst_ConceptsHaveOwnNames(t *testing.T) {
	calls := runBigDoc(t, "1.4.103", 700)
	hub := hubCalls(calls)
	if len(hub) < 2 {
		t.Fatalf("hub 關係 %d 條（>%d）應切成多段送，實際 %d 發：%+v", hub[0].Rels, relsPerCall, len(hub), hub)
	}
	first, last := hub[0], hub[len(hub)-1]
	if first.Limit != 0 || first.Offset == 0 || first.Scope == "" {
		t.Errorf("第一發應是最後一段（有 offset、名字非空、寫到最後＝沒帶 rel_limit）：%+v", first)
	}
	if last.Offset != 0 || last.Scope != "" || last.Limit != float64(relsPerCall) {
		t.Errorf("最後一發應是第一段（offset 0、文件卡本人的名字 ''、負責 block＝整份的提交標記）：%+v", last)
	}
	prev := 1e9
	names := map[string]bool{}
	for _, c := range calls {
		if names[c.Page+"|"+c.Scope+"|"+fmt.Sprint(c.Offset)] {
			t.Errorf("同一發送了兩次：%+v", c)
		}
		names[c.Page+"|"+c.Scope+"|"+fmt.Sprint(c.Offset)] = true
	}
	scopes := map[string]string{}
	for _, c := range calls {
		if c.Scope == "" {
			continue
		}
		if p, dup := scopes[c.Scope]; dup && p != c.Page {
			t.Errorf("兩張不同的卡用了同一個三元組名字 %q（%s／%s）——會互相刪對方的", c.Scope, p, c.Page)
		}
		scopes[c.Scope] = c.Page
	}
	for _, c := range hub {
		if c.Offset >= prev {
			t.Errorf("hub 各段 offset 要嚴格遞減：%+v", hub)
		}
		prev = c.Offset
	}
	concept := 0
	for _, c := range calls {
		if c.Page == "大報告" {
			continue
		}
		concept++
		if c.Scope != "c."+c.Page {
			t.Fatalf("概念卡 %q 的三元組名字應是 c.<頁名>，實際 %q", c.Page, c.Scope)
		}
	}
	if concept == 0 {
		t.Fatal("前提：這份檔應該有概念卡上雲")
	}
}

// 舊版雲端看不懂分段（切段送過去每一段都會把整張卡全寫一遍）⇒ hub 一定整張一發、不帶 rel_*。
func TestBigDocToOldCloud_HubIsStillOneCall(t *testing.T) {
	calls := runBigDoc(t, "1.4.97", 700)
	hub := hubCalls(calls)
	if len(hub) != 1 || hub[0].Scope != "" || hub[0].Offset != 0 || hub[0].Limit != 0 {
		t.Fatalf("舊版雲端：hub 整張一發、不帶新欄位：%+v", hub)
	}
	if hub[0].Rels <= relsPerCall {
		t.Fatalf("前提：這張 hub 的關係要超過上限才有意義，實際 %d", hub[0].Rels)
	}
}

// 關係沒超過上限的文件卡：就算雲端是新版也不分段、不帶新欄位（與從前逐位元組相同）。
func TestSmallHubToNewCloud_NoNewFields(t *testing.T) {
	calls := runBigDoc(t, "1.4.103", 120)
	hub := hubCalls(calls)
	if len(hub) != 1 || hub[0].Scope != "" || hub[0].Offset != 0 || hub[0].Limit != 0 {
		t.Fatalf("小卡不分段、不帶新欄位：%+v", hub)
	}
}

// 改版前（或舊雲端）蓋過章的大檔：內容沒變，升級到新雲端後也要排回佇列重送一次，之後不再重複。
func TestRequeueSharedSourceDocsOnceAfterUpgrade(t *testing.T) {
	resetD1Quota()
	resetCloudChecks()
	cloudRoutes.reset()
	root := t.TempDir()
	writeBigDoc(t, root, "大報告.md", 230)
	var cloudVer = "1.4.97"
	var mu sync.Mutex
	var posts []sliceCall
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/health"):
			mu.Lock()
			v := cloudVer
			mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true,"status":"ok","data_layer":{"ok":true,"summary":"ok"},"bundle_version":"` + v + `"}`))
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/extract"):
			if isWorkersAIProbeBody(r) {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "{}"})
				return
			}
			n := int(atomic.AddInt32(&hits, 1))
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": chunkWithFacts(n, 3)})
		case strings.Contains(r.URL.Path, "rag_ingest_card/trigger"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			pn, _ := m["page_name"].(string)
			if !strings.HasPrefix(pn, "00-INDEX") && !strings.HasPrefix(pn, "資料夾總覽") {
				sc, _ := m["triplet_scope"].(string)
				mu.Lock()
				posts = append(posts, sliceCall{Page: pn, Scope: sc})
				mu.Unlock()
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	}))
	defer srv.Close()
	origFetch := fetchCloudVersion
	fetchCloudVersion = fetchBundleVersion
	defer func() { fetchCloudVersion = origFetch }()
	cfg := &DirectConfig{
		WatchFolders: []string{root}, Manifest: filepath.Join(t.TempDir(), "m.json"),
		CypherURL: srv.URL, Namespace: "demo", APIKey: "demo", Library: "kb",
		Extractor: "workers-ai", ExtractorExplicit: true, CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	stamped := func() *ManifestEntry {
		m, err := LoadManifest(cfg.manifestPathFor(root), root)
		if err != nil {
			t.Fatal(err)
		}
		return m.Entries["大報告.md"]
	}
	for round := 0; round < 12; round++ { // 舊雲端先讀完蓋章
		resetCloudChecks()
		RunDirectOnce(cfg, false)
		if e := stamped(); e != nil && e.IngestedHash != "" {
			break
		}
	}
	e := stamped()
	if e == nil || e.IngestedHash == "" || e.TripletRev != 0 {
		t.Fatalf("前提：舊雲端蓋章，且不算新送法：%+v", e)
	}
	// 還在舊雲端：不重送
	mu.Lock()
	posts = nil
	mu.Unlock()
	resetCloudChecks()
	RunDirectOnce(cfg, false)
	mu.Lock()
	n0 := len(posts)
	cloudVer = "1.4.103"
	mu.Unlock()
	if n0 != 0 {
		t.Fatalf("舊雲端上不該重送：%d 發", n0)
	}
	// 升級：重送一次，概念卡帶自己的名字，且蓋上新世代
	resetCloudChecks()
	RunDirectOnce(cfg, false)
	mu.Lock()
	got := append([]sliceCall(nil), posts...)
	posts = nil
	mu.Unlock()
	scoped := 0
	for _, c := range got {
		if strings.HasPrefix(c.Scope, "c.") {
			scoped++
		}
	}
	if scoped == 0 {
		t.Fatalf("升級後概念卡應重送（帶 c.<頁名>）：%+v", got)
	}
	if e := stamped(); e == nil || e.TripletRev != currentTripletRev || e.IngestedHash == "" {
		t.Fatalf("重送後應蓋新世代的章：%+v", e)
	}
	// 再一輪：不再重送
	resetCloudChecks()
	RunDirectOnce(cfg, false)
	mu.Lock()
	again := len(posts)
	mu.Unlock()
	if again != 0 {
		t.Fatalf("只該重送一次，第三輪又送了 %d 發", again)
	}
}
