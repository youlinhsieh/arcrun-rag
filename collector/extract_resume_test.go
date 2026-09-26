// extract_resume_test.go — arcrun-rag#213：「大檔分次讀、本機存書籤、隔天接著讀」
// 一般化機制的測試。核心驗證：①書籤跨呼叫存活 ②額度用完時停下但保住已完成的進度
// ③內容變了書籤作廢重切 ④完成後 direct.go 判得出「這份文件的概念卡要上雲」。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func isValidUTF8(s string) bool { return utf8.ValidString(s) }

// bigTableLikeText 造一份會被切成多段、每段都能萃出恰好一個概念的測試原稿——
// 模擬客戶那份「查表型手冊」的形狀（大量短記錄），但**不依賴任何查表型偵測**，
// 純粹是「內容量體超過單發上限」這一件事觸發續讀機制。
func bigTableLikeText(records int) string {
	var b strings.Builder
	b.WriteString("# 測試手冊\n\n")
	for i := 0; i < records; i++ {
		b.WriteString("錯誤碼 " + strconv.Itoa(i) + "\n")
		b.WriteString(strings.Repeat("原因與處置的說明文字。", 40))
		b.WriteString("\n\n")
	}
	return b.String()
}

// segmentConceptHandler 回傳一個 httptest handler：每次呼叫都回一個「這是第 N 段」
// 的合法概念（名字帶呼叫序號，確保跨段不會被 mergeConcept 誤判成同一個概念）。
// hits 讓測試斷言呼叫次數；quotaExhaustAfter>0 時，第幾次呼叫（1-based）之後
// 全部回「額度用完」的錯誤文案（isQuotaExhausted 認得的那段文字）。
func segmentConceptHandler(t *testing.T, hits *int32, quotaExhaustAfter int32) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(hits, 1)
		if quotaExhaustAfter > 0 && n > quotaExhaustAfter {
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "8007: 4006: you have used up your daily free allocation of 10,000 neurons",
			})
			return
		}
		body := `{"gloss":"段落` + strconv.Itoa(int(n)) + `","summary":"這是第 ` + strconv.Itoa(int(n)) + ` 段的摘要句子",` +
			`"points":["這是第 ` + strconv.Itoa(int(n)) + ` 段的重點句"],` +
			`"concepts":[{"name":"概念` + strconv.Itoa(int(n)) + `","gloss":"一句話","summary":"摘要內容一段話",` +
			`"points":["重點一句話"]}]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": body})
	}
}

func writeBigDoc(t *testing.T, root, rel string, records int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, rel), []byte(bigTableLikeText(records)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestExtractResumable_額度用完時停下但保住已完成的進度
// ——這是續讀機制的核心承諾（leo 2026-09-22：「一天讀不完可以多讀幾天，就像續傳」）。
func TestExtractResumable_額度用完時停下但保住已完成的進度(t *testing.T) {
	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 200) // 內容量體遠超單發上限，會被切成多段

	var hits int32
	srv := httptest.NewServer(segmentConceptHandler(t, &hits, 2)) // 第 3 發開始撞額度
	defer srv.Close()
	url := workersAIExtractURL(srv.URL)

	cards, err := extractResumableWorkersAI(url, "k", root, "手冊.md", bigTableLikeText(200), testOrigin(), false)
	pe, isPartial := asExtractInProgress(err)
	if !isPartial {
		t.Fatalf("額度用完但已有進度時應該回 *extractInProgress，實際：%v", err)
	}
	if !pe.QuotaHit {
		t.Errorf("這次停下來的原因是額度，QuotaHit 應該是 true")
	}
	if pe.Done != 2 {
		t.Errorf("應該正好完成 2 段（第 3 發撞額度），實際 Done=%d", pe.Done)
	}
	if pe.Done >= pe.Total {
		t.Errorf("不該全部完成（測試設計成一定會撞額度）：Done=%d Total=%d", pe.Done, pe.Total)
	}
	if len(cards) == 0 {
		t.Errorf("已完成的段落應該已經組出卡片（至少 hub），實際 0 張")
	}

	// 進度沒有蓋掉——hub 檔案確實寫出來了（BuildWikiDoc 用累積到現在的 2 個概念組卡）。
	if _, rerr := os.ReadFile(filepath.Join(root, filepath.FromSlash(cards[0]))); rerr != nil {
		t.Fatalf("hub 卡應該已經寫出來：%v", rerr)
	}

	// docWentThroughResumable／ExtractProgressPercent 要看得到「進行中」的狀態。
	if !docWentThroughResumable(root, "手冊.md") {
		t.Errorf("撞額度停下的檔也該被認成「走過續讀機制」")
	}
	percent, has := ExtractProgressPercent(root, "手冊.md")
	if !has {
		t.Fatal("應該有進度可查")
	}
	if percent <= 0 || percent >= 100 {
		t.Errorf("進度應該介於 0-100 之間（不是 0 也不是 100，因為還沒完成）：%d", percent)
	}
}

// TestExtractResumable_第一段就撞額度時不寫書籤
// ——inkstone/arcrun-rag#213 c10683 實錄：09-22 08:05 stage 實跑撞到「額度重置後幾分鐘內
// 就被用光」，`.extract-progress/` 一次都沒被寫出來。這裡證明那是**正確行為**、不是缺陷：
// 一段都沒完成（Done==0）代表沒有任何「已完成的進度」可以保——書籤本來就只記錄已完成的
// 段落，Done==0 時沒有東西可存，也就沒有檔案被寫出來。呼叫端拿到的仍是一般的額度用完
// error（不是 *extractInProgress），跟撞額度前既有的「帳號冷卻／使用者訊息」路徑一致，
// 不會誤判成「進行中」而略過既有的冷卻機制。
func TestExtractResumable_第一段就撞額度時不寫書籤(t *testing.T) {
	root := t.TempDir()
	writeBigDoc(t, root, "手冊.md", 200)

	// 🔴 不能借用 segmentConceptHandler 的 quotaExhaustAfter：那個參數 0 的意思是
	// 「不設上限、全部成功」（見該函式簽章），不是「第一發就爆」。這裡直接寫一個
	// 每次呼叫都回額度用完錯誤的 handler，精準對應 c10683 的實況（重置後幾分鐘內
	// 額度已經是 0，連第一段都打不過去）。
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": "8007: 4006: you have used up your daily free allocation of 10,000 neurons",
		})
	}))
	defer srv.Close()
	url := workersAIExtractURL(srv.URL)

	cards, err := extractResumableWorkersAI(url, "k", root, "手冊.md", bigTableLikeText(200), testOrigin(), false)
	if err == nil {
		t.Fatal("第一段就撞額度應該回錯誤")
	}
	if _, isPartial := asExtractInProgress(err); isPartial {
		t.Errorf("Done==0 時不該回 *extractInProgress（那代表有部分進度）：%v", err)
	}
	if !isQuotaExhausted(err.Error()) {
		t.Errorf("錯誤內容應該讓既有的 isQuotaExhausted 認得出來（帳號冷卻要靠它觸發）：%v", err)
	}
	if len(cards) != 0 {
		t.Errorf("一段都沒完成不該有任何卡片，實際 %d 張", len(cards))
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("應該只打了第 1 發就停（額度用完不該重試同一段），實際 hits=%d", hits)
	}

	// 核心斷言：書籤檔沒有被寫出來（不是「寫了但空」，是整份不存在）。
	node, base := docNodeAndPath(root, "手冊.md")
	nodeKey := nodeKeyOf(node)
	bookmarkPath := extractProgressPath(root, node, nodeKey, base)
	if _, statErr := os.Stat(bookmarkPath); !os.IsNotExist(statErr) {
		t.Errorf("Done==0 時不該有書籤檔案：%s（stat err=%v）", bookmarkPath, statErr)
	}
	if docWentThroughResumable(root, "手冊.md") {
		t.Errorf("沒有任何進度的檔不該被判成「走過續讀機制」")
	}
	if _, has := ExtractProgressPercent(root, "手冊.md"); has {
		t.Errorf("沒有書籤時 ExtractProgressPercent 應該回 hasProgress=false")
	}
}

// TestExtractResumable_下次呼叫從書籤接著讀_不重算已完成的段
func TestExtractResumable_下次呼叫從書籤接著讀不重算已完成的段(t *testing.T) {
	root := t.TempDir()
	src := bigTableLikeText(200)
	writeBigDoc(t, root, "手冊.md", 200)

	var hits int32
	srv := httptest.NewServer(segmentConceptHandler(t, &hits, 2)) // 第一輪只做得完 2 段
	defer srv.Close()
	url := workersAIExtractURL(srv.URL)

	_, err := extractResumableWorkersAI(url, "k", root, "手冊.md", src, testOrigin(), false)
	pe, ok := asExtractInProgress(err)
	if !ok {
		t.Fatalf("第一輪應該因為額度用完而回進行中：%v", err)
	}
	firstDone, total := pe.Done, pe.Total
	if firstDone == 0 || firstDone >= total {
		t.Fatalf("測試前提不成立：firstDone=%d total=%d", firstDone, total)
	}
	hitsAfterFirst := atomic.LoadInt32(&hits)

	// 第二輪：額度恢復（handler 換成永遠成功），從書籤接著讀，直到全部完成。
	srv2 := httptest.NewServer(func() http.HandlerFunc {
		var h2 int32
		return segmentConceptHandler(t, &h2, 0) // 0＝不設額度上限，全部成功
	}())
	defer srv2.Close()
	url2 := workersAIExtractURL(srv2.URL)

	cards2, err2 := extractResumableWorkersAI(url2, "k", root, "手冊.md", src, testOrigin(), false)
	if err2 != nil {
		t.Fatalf("第二輪額度恢復、剩下的段數不多，應該能全部讀完：%v", err2)
	}
	if len(cards2) == 0 {
		t.Fatal("完成後應該有卡片")
	}
	// 續讀成功後書籤仍在（docWentThroughResumable 之後還要靠它判斷概念卡要不要上雲），
	// 但已經是「Done==Total」的完賽紀錄。
	percent, has := ExtractProgressPercent(root, "手冊.md")
	if !has || percent != 100 {
		t.Errorf("完成後進度應該是 100%%，實際 has=%v percent=%d", has, percent)
	}
	_ = hitsAfterFirst // 這個測試不斷言第二台 server 的呼叫次數（用的是不同 server）
}

// TestExtractResumable_內容變了書籤作廢重切
func TestExtractResumable_內容變了書籤作廢重切(t *testing.T) {
	root := t.TempDir()
	src1 := bigTableLikeText(200)
	writeBigDoc(t, root, "手冊.md", 200)

	var hits int32
	srv := httptest.NewServer(segmentConceptHandler(t, &hits, 1)) // 只做 1 段就停
	defer srv.Close()
	url := workersAIExtractURL(srv.URL)

	_, err := extractResumableWorkersAI(url, "k", root, "手冊.md", src1, testOrigin(), false)
	pe1, ok := asExtractInProgress(err)
	if !ok || pe1.Done != 1 {
		t.Fatalf("前提：第一輪只完成 1 段，實際：ok=%v err=%v", ok, err)
	}

	// 內容變了（記錄數不同 ⇒ srcText 不同 ⇒ sha256 不同）。
	src2 := bigTableLikeText(260)
	writeBigDoc(t, root, "手冊.md", 260)

	var hits2 int32
	srv2 := httptest.NewServer(segmentConceptHandler(t, &hits2, 1))
	defer srv2.Close()
	url2 := workersAIExtractURL(srv2.URL)

	_, err2 := extractResumableWorkersAI(url2, "k", root, "手冊.md", src2, testOrigin(), false)
	pe2, ok2 := asExtractInProgress(err2)
	if !ok2 {
		t.Fatalf("內容變大之後應該還是需要續讀：%v", err2)
	}
	// 關鍵斷言：新內容重新從 0 開始切段整理，這輪只做得完 1 段（跟第一輪的
	// handler 設定一樣，若書籤沒有作廢、把舊的 Done=1 誤當成新內容也讀過 1 段，
	// 這裡看不出差別——所以下面直接檢查新內容的段數確實跟舊內容不同）。
	if pe2.Done != 1 {
		t.Errorf("新內容書籤應該從 0 開始重算，這輪只做 1 段：Done=%d", pe2.Done)
	}
	if pe1.Total == pe2.Total {
		t.Errorf("260 則記錄跟 200 則記錄切出來的段數不該剛好相同（測試前提可能被破壞）："+
			"pe1.Total=%d pe2.Total=%d", pe1.Total, pe2.Total)
	}
}

// TestDocWentThroughResumable_一般小文件不受影響
func TestDocWentThroughResumable_一般小文件不受影響(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "small.md"), []byte("# 小檔\n\n沒什麼內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	if docWentThroughResumable(root, "small.md") {
		t.Errorf("沒有書籤的一般小檔不該被判成「走過續讀機制」")
	}
	if _, has := ExtractProgressPercent(root, "small.md"); has {
		t.Errorf("一般小檔不該有進度可查")
	}
}

// TestChunkForWorkersAI_不切斷UTF8字元且可還原
func TestChunkForWorkersAI_不切斷UTF8字元且可還原(t *testing.T) {
	src := bigTableLikeText(50)
	chunks := chunkForWorkersAI(src, 500)
	if len(chunks) < 2 {
		t.Fatalf("500 bytes 上限對這份測試稿應該切出至少 2 段，實際 %d 段", len(chunks))
	}
	var rebuilt strings.Builder
	for _, c := range chunks {
		// 每段都要是合法的 UTF-8（沒被從字元中間切斷）；不合法會在這裡就地報出來。
		if !isValidUTF8(c) {
			t.Errorf("段落切斷了 UTF-8 字元：%q", c)
		}
		rebuilt.WriteString(c)
	}
	if rebuilt.String() != src {
		t.Fatalf("切段後重組應該逐位元組等於原文")
	}
}
