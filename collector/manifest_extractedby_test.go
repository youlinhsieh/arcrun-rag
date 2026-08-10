package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 這一組回答 leo 2026-07-27 的三個問題，用測試把「現在的實際行為」釘死，
// 免得下次再靠讀碼推論：
//   ① 已經萃過了它知道嗎？        → 知道，靠 ingested_hash
//   ② gemma 會重萃 claude 萃過的嗎？→ 不會重萃（hash 相同就跳過），但原本分辨不出誰萃的
//   ③ 誰負責萃？                  → cfg.Extractor 一個資料夾一個設定，無自動判斷

func mfEntry(t *testing.T, m *Manifest, path string) *ManifestEntry {
	t.Helper()
	e, ok := m.Entries[path]
	if !ok {
		t.Fatalf("manifest 缺 %s", path)
	}
	return e
}

// ① 萃過就記得：ingested_hash 與 content_hash 相同 → 下輪 Scan 不產生事件
func TestExtractedBy_萃過就不重萃(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.md")
	os.WriteFile(p, []byte("內容一"), 0o644)

	m := &Manifest{FolderID: "f", Entries: map[string]*ManifestEntry{}}
	first, err := Scan(dir, m, ScanOptions{})
	if err != nil {
		t.Fatalf("首輪 scan 失敗: %v", err)
	}
	if len(first.Events) != 1 {
		t.Fatalf("首輪應有 1 個 added，實得 %d", len(first.Events))
	}
	// 模擬萃取成功回寫
	m.MarkIngestedBy("a.md", first.Events[0].SourceHash, 100, "gemma")

	second, err := Scan(dir, m, ScanOptions{})
	if err != nil {
		t.Fatalf("次輪 scan 失敗: %v", err)
	}
	if len(second.Events) != 0 {
		t.Errorf("內容沒改就不該再萃，實得事件: %+v", second.Events)
	}
}

// ① 反面：內容改了就要重萃
func TestExtractedBy_內容改了要重萃(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.md")
	os.WriteFile(p, []byte("內容一"), 0o644)

	m := &Manifest{FolderID: "f", Entries: map[string]*ManifestEntry{}}
	first, _ := Scan(dir, m, ScanOptions{})
	m.MarkIngestedBy("a.md", first.Events[0].SourceHash, 100, "gemma")

	os.WriteFile(p, []byte("內容二（改過）"), 0o644)
	second, err := Scan(dir, m, ScanOptions{})
	if err != nil {
		t.Fatalf("scan 失敗: %v", err)
	}
	if len(second.Events) != 1 || second.Events[0].Type != "modified" {
		t.Errorf("內容改了應產生 modified，實得: %+v", second.Events)
	}
}

// ① 失敗不回寫 → 下輪自動重試（避免漏檔）
func TestExtractedBy_萃取失敗下輪要重試(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("內容"), 0o644)

	m := &Manifest{FolderID: "f", Entries: map[string]*ManifestEntry{}}
	Scan(dir, m, ScanOptions{}) // 首輪偵測到，但「萃取失敗」→ 不呼叫 MarkIngested

	second, err := Scan(dir, m, ScanOptions{})
	if err != nil {
		t.Fatalf("scan 失敗: %v", err)
	}
	if len(second.Events) != 1 {
		t.Errorf("上輪未成功者下輪應重試，實得: %+v", second.Events)
	}
}

// ② 核心：要分辨得出誰萃的
func TestExtractedBy_記錄萃取器(t *testing.T) {
	m := &Manifest{FolderID: "f", Entries: map[string]*ManifestEntry{
		"a.md": {ContentHash: "h1"},
		"b.md": {ContentHash: "h2"},
	}}
	m.MarkIngestedBy("a.md", "h1", 100, "claude")
	m.MarkIngestedBy("b.md", "h2", 100, "gemma")

	if got := mfEntry(t, m, "a.md").ExtractedBy; got != "claude" {
		t.Errorf("a.md 應記 claude，實得 %q", got)
	}
	if got := mfEntry(t, m, "b.md").ExtractedBy; got != "gemma" {
		t.Errorf("b.md 應記 gemma，實得 %q", got)
	}
}

// 舊簽名不可被破壞（多處呼叫，含 sync 路的 MarkIngestedEvents）
func TestExtractedBy_舊MarkIngested仍可用(t *testing.T) {
	m := &Manifest{FolderID: "f", Entries: map[string]*ManifestEntry{"a.md": {ContentHash: "h"}}}
	if !m.MarkIngested("a.md", "h", 1) {
		t.Fatal("舊簽名應仍可用")
	}
	if got := mfEntry(t, m, "a.md").ExtractedBy; got != "" {
		t.Errorf("無萃取器路徑應留空，實得 %q", got)
	}
}

// 向後相容：舊 manifest 沒有 extracted_by 欄位，讀進來不可爆
func TestExtractedBy_舊manifest讀得進來(t *testing.T) {
	dir := t.TempDir()
	mp := filepath.Join(dir, "manifest.json")
	old := `{"folder_id":"f","root":"/x","entries":{"a.md":{"content_hash":"h","size":1,"mtime":2,"ingested_hash":"h","ingested_at":3}}}`
	os.WriteFile(mp, []byte(old), 0o644)

	m, err := LoadManifest(mp, dir)
	if err != nil {
		t.Fatalf("舊 manifest 應讀得進來: %v", err)
	}
	if got := mfEntry(t, m, "a.md").ExtractedBy; got != "" {
		t.Errorf("舊資料應為空字串（未知），實得 %q", got)
	}
	// 寫回去時空值不該污染 JSON（omitempty）
	if err := m.Save(mp); err != nil {
		t.Fatalf("存檔失敗: %v", err)
	}
	b, _ := os.ReadFile(mp)
	if strings.Contains(string(b), "extracted_by") {
		t.Errorf("空值不該寫進 JSON（omitempty），實得:\n%s", b)
	}
}

// 有值時要真的存得進 JSON（不能只活在記憶體）
func TestExtractedBy_有值要存得進檔案(t *testing.T) {
	dir := t.TempDir()
	mp := filepath.Join(dir, "manifest.json")
	m := &Manifest{FolderID: "f", Root: dir, Entries: map[string]*ManifestEntry{"a.md": {ContentHash: "h"}}}
	m.MarkIngestedBy("a.md", "h", 100, "claude")
	if err := m.Save(mp); err != nil {
		t.Fatalf("存檔失敗: %v", err)
	}
	var back Manifest
	b, _ := os.ReadFile(mp)
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("讀回失敗: %v", err)
	}
	if back.Entries["a.md"].ExtractedBy != "claude" {
		t.Errorf("extracted_by 應存進檔案，實得 %q", back.Entries["a.md"].ExtractedBy)
	}
}
