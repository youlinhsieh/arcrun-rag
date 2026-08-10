// manifest_retry_test.go — t195 失敗退避（leo 2026-08-05：「有封測者在等，一直出錯」）。
//
// 這組測試守的是一個**架構缺陷**，不是某次的 401：
// 原本 manifest 只記成功不記失敗 ⇒ 每輪重掃都把失敗檔當「新檔」
// ⇒ 實測 1387 輪 × 11 小時撞同一面牆，且壞檔排在前面**拖住整個資料夾**。
// 401 修好了，下次換別的錯照樣卡死——所以要測的是「退避本身」。
package collector

import "testing"

func newRetryTestManifest(path string) *Manifest {
	return &Manifest{
		FolderID: "t", Root: "/tmp/t",
		Entries: map[string]*ManifestEntry{path: {ContentHash: "h1", Size: 1, Mtime: 1}},
	}
}

// 沒失敗過的檔行為與 t195 前一字不變。
func TestShouldRetry_NeverFailed(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	if !m.ShouldRetry("a.pdf", 1000, false) {
		t.Fatal("沒失敗過的檔應該要送")
	}
	// manifest 裡沒有的檔（全新檔）也一樣要送
	if !m.ShouldRetry("never-seen.pdf", 1000, false) {
		t.Fatal("全新檔應該要送")
	}
}

// 核心止血：失敗後在退避窗口內不再重試。
func TestShouldRetry_BackoffWindow(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	m.MarkFailed("a.pdf", 1000, "測試用失敗原因") // 第 1 次失敗 → 退避 60s

	if m.ShouldRetry("a.pdf", 1030, false) {
		t.Fatal("退避窗口內（+30s）不該重試——這正是 1387 輪的病根")
	}
	if !m.ShouldRetry("a.pdf", 1060, false) {
		t.Fatal("退避結束（+60s）應該要重試")
	}
}

// 退避要遞增，不是固定間隔（否則壞檔仍會高頻撞牆）。
func TestMarkFailed_ExponentialBackoff(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	want := []int64{60, 300, 900, 3600, 21600, 21600} // 1m,5m,15m,1h,6h,之後維持 6h
	at := int64(1000)
	for i, w := range want {
		m.MarkFailed("a.pdf", at, "測試用失敗原因")
		got := m.Entries["a.pdf"].NextRetry - at
		if got != w {
			t.Fatalf("第 %d 次失敗：退避 %ds，預期 %ds", i+1, got, w)
		}
	}
}

// 連續失敗達上限 → 暫停自動重試（不再永遠佔用每一輪）。
func TestShouldRetry_MaxFailStops(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	at := int64(1000)
	for i := 0; i < MaxFailBeforeSkip; i++ {
		m.MarkFailed("a.pdf", at, "測試用失敗原因")
	}
	// 就算等再久也不自動重試
	if m.ShouldRetry("a.pdf", at+999999, false) {
		t.Fatalf("連續失敗 %d 次後應暫停自動重試", MaxFailBeforeSkip)
	}
	// 但使用者按「立刻同步」仍要送——人明確要求不該被機器退避擋住
	if !m.ShouldRetry("a.pdf", at+1, true) {
		t.Fatal("force（立刻同步）應忽略退避與上限")
	}
}

// 成功後要清掉失敗狀態，否則下次再壞會從高階退避起跳（等太久）。
func TestMarkIngested_ResetsFailState(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	m.MarkFailed("a.pdf", 1000, "測試用失敗原因")
	m.MarkFailed("a.pdf", 1100, "測試用失敗原因")
	if m.Entries["a.pdf"].FailCount != 2 {
		t.Fatal("失敗次數應累計")
	}

	m.MarkIngestedBy("a.pdf", "h1", 1200, "gemma")
	e := m.Entries["a.pdf"]
	if e.FailCount != 0 || e.NextRetry != 0 || e.LastFailAt != 0 {
		t.Fatalf("成功後應清空失敗狀態，got FailCount=%d NextRetry=%d", e.FailCount, e.NextRetry)
	}
	// 清空後立刻可再送
	if !m.ShouldRetry("a.pdf", 1201, false) {
		t.Fatal("成功後應恢復可送")
	}
}

// 壞檔不該擋住同一輪的其他檔（leo 實撞：整個資料夾被一個 PDF 拖住）。
func TestShouldRetry_OtherFilesUnaffected(t *testing.T) {
	m := newRetryTestManifest("bad.pdf")
	m.Entries["good.md"] = &ManifestEntry{ContentHash: "h2", Size: 1, Mtime: 1}
	m.MarkFailed("bad.pdf", 1000, "測試用失敗原因")

	if m.ShouldRetry("bad.pdf", 1010, false) {
		t.Fatal("壞檔應在退避中")
	}
	if !m.ShouldRetry("good.md", 1010, false) {
		t.Fatal("同一輪的其他檔不該被壞檔連累——這是「拖住整個佇列」的正解")
	}
}
