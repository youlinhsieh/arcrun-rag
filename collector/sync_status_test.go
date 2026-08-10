// sync_status_test.go — t91/t92 狀態檔與 fallback 路徑邏輯單元測試。
package collector

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ── FindClaudeBin fallback（t92）──────────────────────────────────────────────

// TestFindClaudeBinPathHit：hint 在 PATH 能找到時，直接回傳，不進 fallback。
func TestFindClaudeBinPathHit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("此測試僅在 Unix 執行")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	orig := claudeFallbackPaths
	claudeFallbackPaths = nil
	defer func() { claudeFallbackPaths = orig }()

	found, err := FindClaudeBin("")
	if err != nil {
		t.Fatalf("PATH 有 claude 卻找不到：%v", err)
	}
	if found != bin {
		t.Errorf("found=%q want=%q", found, bin)
	}
}

// TestFindClaudeBinFallback：PATH 找不到時，依序掃 claudeFallbackPaths 並命中。
// 模擬 Finder 啟動的 GUI app PATH 不含 /opt/homebrew/bin 的情境（t92 根因）。
func TestFindClaudeBinFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("此測試僅在 Unix 執行")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho fake"), 0o755); err != nil {
		t.Fatal(err)
	}

	orig := claudeFallbackPaths
	// 清單：第一個不存在（跳過）、第二個是 bin（命中）
	claudeFallbackPaths = []string{filepath.Join(dir, "no-such"), bin}
	defer func() { claudeFallbackPaths = orig }()

	found, err := FindClaudeBin("/definitely/not/there")
	if err != nil {
		t.Fatalf("fallback 應找到 %s，got err=%v", bin, err)
	}
	if found != bin {
		t.Errorf("found=%q want=%q", found, bin)
	}
}

// TestFindClaudeBinAllMiss：PATH 和所有 fallback 都找不到 → 回誠實錯誤。
func TestFindClaudeBinAllMiss(t *testing.T) {
	orig := claudeFallbackPaths
	claudeFallbackPaths = []string{"/does/not/exist/claude"}
	defer func() { claudeFallbackPaths = orig }()

	_, err := FindClaudeBin("/also/does/not/exist")
	if err == nil {
		t.Fatal("全部找不到應回錯誤")
	}
}

// TestFindClaudeBinNotExecutable：fallback 路徑存在但不可執行，不應採用。
func TestFindClaudeBinNotExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("此測試僅在 Unix 執行")
	}
	dir := t.TempDir()
	notExec := filepath.Join(dir, "claude")
	if err := os.WriteFile(notExec, []byte("not exec"), 0o644); err != nil { // 0644 無執行位
		t.Fatal(err)
	}
	orig := claudeFallbackPaths
	claudeFallbackPaths = []string{notExec}
	defer func() { claudeFallbackPaths = orig }()

	_, err := FindClaudeBin("/no/such")
	if err == nil {
		t.Fatal("不可執行的檔不應被當成可用 claude")
	}
}

// ── SyncStatus 狀態檔寫入/讀取（t91）────────────────────────────────────────

// TestSyncStatusRoundTrip：寫進去的結構讀出來完全相同。
func TestSyncStatusRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "status.json")

	want := SyncStatus{
		LastSync:      "2026-07-28T10:00:00Z",
		ExtractedOK:   3,
		ExtractFailed: 1,
		Failures: []ExtractFail{
			{Path: "重要文件.md", Error: "找不到 Claude 指令"},
		},
		ExtractorOK:    false,
		ExtractorError: "找不到 Claude 指令",
	}
	if err := SaveSyncStatus(path, want); err != nil {
		t.Fatalf("SaveSyncStatus 失敗：%v", err)
	}
	got, err := LoadSyncStatus(path)
	if err != nil {
		t.Fatalf("LoadSyncStatus 失敗：%v", err)
	}
	if got.LastSync != want.LastSync {
		t.Errorf("LastSync=%q want=%q", got.LastSync, want.LastSync)
	}
	if got.ExtractedOK != want.ExtractedOK || got.ExtractFailed != want.ExtractFailed {
		t.Errorf("counts: ok=%d fail=%d, want ok=%d fail=%d",
			got.ExtractedOK, got.ExtractFailed, want.ExtractedOK, want.ExtractFailed)
	}
	if len(got.Failures) != 1 || got.Failures[0].Path != "重要文件.md" {
		t.Errorf("Failures=%+v", got.Failures)
	}
	if got.ExtractorOK || got.ExtractorError != want.ExtractorError {
		t.Errorf("extractor: ok=%v err=%q", got.ExtractorOK, got.ExtractorError)
	}
}

// TestLoadSyncStatusMissingFile：檔不存在回零值＋error，不 panic。
func TestLoadSyncStatusMissingFile(t *testing.T) {
	_, err := LoadSyncStatus(filepath.Join(t.TempDir(), "no-status.json"))
	if err == nil {
		t.Fatal("不存在的檔應回 error")
	}
}

// TestStatusFilePath：依 manifest 路徑回傳同目錄 status.json。
func TestStatusFilePath(t *testing.T) {
	got := StatusFilePath("/home/leo/.arcrun-rag/manifest.json")
	want := "/home/leo/.arcrun-rag/status.json"
	if got != want {
		t.Errorf("StatusFilePath=%q want=%q", got, want)
	}
}

// TestSyncNowSignalPath：依 manifest 路徑回傳同目錄 sync-now（t98）。
func TestSyncNowSignalPath(t *testing.T) {
	got := SyncNowSignalPath("/home/leo/.arcrun-rag/manifest.json")
	want := "/home/leo/.arcrun-rag/sync-now"
	if got != want {
		t.Errorf("SyncNowSignalPath=%q want=%q", got, want)
	}
}

// ── RunDirectOnce 寫狀態檔（t91 整合）────────────────────────────────────────

// TestRunDirectOnceWritesStatus：RunDirectOnce 完成後應在 manifest 同目錄寫出 status.json。
// 使用空資料夾（無事件）確保不觸發 HTTP，只驗 extractor 預檢結果與 LastSync。
func TestRunDirectOnceWritesStatus(t *testing.T) {
	// 空資料夾 → 零事件 → 無 HTTP 呼叫
	root := t.TempDir()
	manifestDir := t.TempDir()
	// t176：extractor 寫 "claude" 也會被正規化成 gemma（claude 路已不支援），
	// 故預檢看的是「Gemini 金鑰有沒有填」——這裡填了，ExtractorOK 應為 true。
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(manifestDir, "manifest.json"),
		CypherURL:    "https://unused.example", Namespace: "demo",
		Extractor: "claude", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	RunDirectOnce(cfg, false)

	statusPath := StatusFilePath(cfg.Manifest)
	if _, err := os.Stat(statusPath); err != nil {
		t.Fatalf("RunDirectOnce 後應存在 status.json：%v", err)
	}
	st, err := LoadSyncStatus(statusPath)
	if err != nil {
		t.Fatalf("LoadSyncStatus 失敗：%v", err)
	}
	if !st.ExtractorOK {
		t.Errorf("可用 stub claude 時 ExtractorOK 應為 true，ExtractorError=%q", st.ExtractorError)
	}
	if st.LastSync == "" {
		t.Error("LastSync 應非空")
	}
	// 空資料夾 → 零事件
	if st.ExtractedOK != 0 || st.ExtractFailed != 0 {
		t.Errorf("空資料夾應零計數，got ok=%d fail=%d", st.ExtractedOK, st.ExtractFailed)
	}
}

// TestRunDirectOnceWritesStatusExtractorFail：找不到 claude 時 status 應記 ExtractorOK=false。
func TestRunDirectOnceWritesStatusExtractorFail(t *testing.T) {
	orig := claudeFallbackPaths
	claudeFallbackPaths = []string{} // 空 fallback，確保找不到
	defer func() { claudeFallbackPaths = orig }()

	root := t.TempDir()
	manifestDir := t.TempDir()
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(manifestDir, "manifest.json"),
		CypherURL:    "https://unused.example", Namespace: "demo",
		Extractor: "claude", ExtractorExplicit: true, ClaudeBin: "/no/such/claude",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	RunDirectOnce(cfg, false)

	st, err := LoadSyncStatus(StatusFilePath(cfg.Manifest))
	if err != nil {
		t.Fatalf("LoadSyncStatus 失敗：%v", err)
	}
	if st.ExtractorOK {
		t.Error("找不到 claude 時 ExtractorOK 應為 false")
	}
	if st.ExtractorError == "" {
		t.Error("ExtractorError 應有白話說明")
	}
}

// TestCarryForwardActivity 鎖住「做完的證據不會被下一輪抹掉」（2026-08-05 leo 實撞的 status 假象）。
//
// 症狀：拖檔進資料夾 → 萃取上傳都跑完了，但首頁自始至終顯示「等待中」、綠燈沒動。
// 真兇：ExtractedOK 是本輪計數，每輪覆寫整份 status.json ⇒ 有產出那輪寫下 N，
// 十幾秒後沒事做的那輪把它蓋成 0，使用者永遠看不到自己剛做完的事。
func TestCarryForwardActivity(t *testing.T) {
	t.Run("本輪有產出→記本輪", func(t *testing.T) {
		st := SyncStatus{LastSync: "2026-08-05T17:18:34+08:00", ExtractedOK: 3, ExtractFailed: 1}
		CarryForwardActivity(SyncStatus{}, &st)
		if st.LastActivityAt != st.LastSync || st.LastActivityOK != 3 || st.LastActivityFailed != 1 {
			t.Fatalf("有產出的一輪應記成 last_activity，得到 %+v", st)
		}
	})

	t.Run("本輪沒事做→沿用上一輪，不歸零", func(t *testing.T) {
		prev := SyncStatus{LastActivityAt: "2026-08-05T17:18:34+08:00", LastActivityOK: 3, LastActivityFailed: 1}
		st := SyncStatus{LastSync: "2026-08-05T17:36:38+08:00"} // 空轉的一輪
		CarryForwardActivity(prev, &st)
		if st.LastActivityOK != 3 || st.LastActivityFailed != 1 {
			t.Fatalf("空轉的一輪不該抹掉上次成果，得到 OK=%d Failed=%d", st.LastActivityOK, st.LastActivityFailed)
		}
		if st.LastActivityAt != prev.LastActivityAt {
			t.Fatalf("時間也要沿用上一輪：want %q got %q", prev.LastActivityAt, st.LastActivityAt)
		}
	})

	t.Run("只有失敗也算有做事", func(t *testing.T) {
		st := SyncStatus{LastSync: "2026-08-05T18:00:00+08:00", ExtractFailed: 2}
		CarryForwardActivity(SyncStatus{}, &st)
		if st.LastActivityFailed != 2 || st.LastActivityAt == "" {
			t.Fatalf("全失敗的一輪也要留痕（否則使用者不知道剛剛出過事），得到 %+v", st)
		}
	})

	t.Run("從沒跑過→全空，不編造", func(t *testing.T) {
		st := SyncStatus{LastSync: "2026-08-05T18:00:00+08:00"}
		CarryForwardActivity(SyncStatus{}, &st)
		if st.LastActivityAt != "" || st.LastActivityOK != 0 || st.LastActivityFailed != 0 {
			t.Fatalf("沒有任何歷史時應保持空值，得到 %+v", st)
		}
	})
}
