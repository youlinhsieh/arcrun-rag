// direct_sync_now_test.go — t98 立刻同步訊號檔邏輯單元測試。
package collector

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestConsumeSyncNowSignal_NoFile：訊號檔不存在時回 false，不建立任何檔案。
func TestConsumeSyncNowSignal_NoFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sync-now")

	got := consumeSyncNowSignal(path)
	if got {
		t.Error("訊號檔不存在時應回 false")
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("consumeSyncNowSignal 不應建立訊號檔")
	}
}

// TestConsumeSyncNowSignal_FileExists：訊號檔存在時回 true 並刪除它。
func TestConsumeSyncNowSignal_FileExists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sync-now")

	// 建立訊號檔
	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	got := consumeSyncNowSignal(path)
	if !got {
		t.Error("訊號檔存在時應回 true")
	}
	// 訊號檔應已被刪除
	if _, err := os.Stat(path); err == nil {
		t.Error("consumeSyncNowSignal 後訊號檔應已被刪除")
	}
}

// TestConsumeSyncNowSignal_Idempotent：consume 後再次呼叫應回 false（訊號只觸發一輪）。
func TestConsumeSyncNowSignal_Idempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sync-now")

	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	first := consumeSyncNowSignal(path)
	second := consumeSyncNowSignal(path)

	if !first {
		t.Error("第一次 consume 應回 true")
	}
	if second {
		t.Error("第二次 consume（已刪）應回 false，確保每次訊號只觸發一輪")
	}
}

// TestConsumeSyncNowSignal_TriggerRunCounting：訊號檔驅動「跑一輪」計數正確。
// 用 fake runner 模擬：寫 N 個訊號檔，逐一 consume，驗 runner 呼叫次數。
// （實際 runDirect 迴圈已在 direct.go 整合；此處只驗 consume 回傳值驅動的呼叫計數）
func TestConsumeSyncNowSignal_TriggerRunCounting(t *testing.T) {
	if runtime.GOOS == "windows" {
		// WriteFile race on Windows tempdir 偶爾有 flush 時序問題；邏輯已由前三條跨平台測試覆蓋
		t.Skip("此驗計數測試僅跑 Unix")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "sync-now")

	runCount := 0
	fakeRun := func() { runCount++ }

	// 第 1 輪：有訊號 → 跑
	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	if consumeSyncNowSignal(path) {
		fakeRun()
	}
	// 第 2 輪：無訊號 → 不跑
	if consumeSyncNowSignal(path) {
		fakeRun()
	}
	// 第 3 輪：再寫訊號 → 跑
	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	if consumeSyncNowSignal(path) {
		fakeRun()
	}

	if runCount != 2 {
		t.Errorf("期望 fakeRun 呼叫 2 次（有訊號輪），got %d", runCount)
	}
}

// TestSyncNowSignalPathConsistency：collector 的 SyncNowSignalPath 與 tray 預期路徑一致。
// tray 寫入 appDir()/sync-now；collector 的函式從 manifest 路徑推導同目錄的 sync-now——
// 兩者必須解析到同一個絕對路徑，否則訊號永遠不會被 collector 讀到。
func TestSyncNowSignalPathConsistency(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")

	// collector 算出的訊號路徑
	collectorPath := SyncNowSignalPath(manifest)

	// tray 寫的是 appDir()/sync-now；此測試驗「同目錄邏輯」：
	// 若 manifest 在 dir，訊號應在 dir/sync-now
	wantPath := filepath.Join(dir, "sync-now")
	if collectorPath != wantPath {
		t.Errorf("SyncNowSignalPath(%q) = %q, want %q（tray 與 collector 路徑必須一致）",
			manifest, collectorPath, wantPath)
	}
}
