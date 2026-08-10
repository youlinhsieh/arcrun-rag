// scan_carry_lasterror_test.go — 2026-08-08，Evan 封測回報的第二層病。
//
// 症狀（用戶端）：首頁「有 20 份沒有送進知識庫」，展開每一份看到的都是
// 「已經自動試過 N 次都沒成功⋯⋯這個檔是在舊版失敗的，當時沒有記下原因」。
// 但原因**當時真的記下來了**（MarkFailed 有寫 LastError），是 Scan() 每輪重建
// ManifestEntry 時沒 carry，5 秒就被自己抹掉一次。
//
// 這是 t195「加了欄位卻寫進去就不見」的**第二次實例**（wiki mistakes.md 已立警告，
// 而 LastError 正是同一批新增的欄位卻漏在 carry 名單裡）。
// 這支測試守的是那條規則本身：跨輪欄位必須活過 Scan()。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

// 失敗真因必須活過下一輪掃描——否則畫面只能說「當時沒有記下原因」。
func TestScan_CarriesLastErrorAcrossRounds(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "內容", baseTime)

	m := newTestManifest()
	mustScan(t, root, m) // 第 1 輪：認識這個檔

	const reason = "今天的免費 AI 額度用完了（4006 neurons）"
	m.MarkFailed("a.md", 1000, reason)

	// 檔案內容沒變，只是時間到了下一輪掃描。
	mustScan(t, root, m)

	e := m.Entries["a.md"]
	if e == nil {
		t.Fatal("掃描後 entry 不該消失")
	}
	if e.LastError != reason {
		t.Fatalf("失敗真因被下一輪掃描抹掉了：want %q, got %q\n"+
			"（這會讓畫面退回「當時沒有記下原因」——Evan 2026-08-08 實撞）", reason, e.LastError)
	}
	// 同批的其他跨輪欄位一併守住，避免下次又漏一個。
	if e.FailCount != 1 || e.NextRetry == 0 {
		t.Fatalf("退避狀態也該活過掃描：FailCount=%d NextRetry=%d", e.FailCount, e.NextRetry)
	}
}

// 改名後真因同樣要跟著搬（renamed 走的是另一條 carry 來源）。
func TestScan_CarriesLastErrorAcrossRename(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "old.md", "同一份內容", baseTime)

	m := newTestManifest()
	mustScan(t, root, m)

	const reason = "這份 PDF 看起來是掃描的圖片，沒有文字可以讀"
	m.MarkFailed("old.md", 1000, reason)

	// 內容一字不動，只換檔名 ⇒ Scan 會判為 renamed。
	if err := renameForTest(root, "old.md", "new.md"); err != nil {
		t.Fatal(err)
	}
	mustScan(t, root, m)

	e := m.Entries["new.md"]
	if e == nil {
		t.Fatal("改名後應該在新路徑有 entry")
	}
	if e.LastError != reason {
		t.Fatalf("改名後失敗真因遺失：want %q, got %q", reason, e.LastError)
	}
}

func renameForTest(root, from, to string) error {
	return os.Rename(filepath.Join(root, from), filepath.Join(root, to))
}
