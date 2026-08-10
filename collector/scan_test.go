package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var baseTime = time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

func writeFile(t *testing.T, root, rel, content string, mtime time.Time) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func hashOf(content string) string {
	sum := sha256.Sum256([]byte(content))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func newTestManifest() *Manifest {
	return &Manifest{FolderID: "test-folder-id", Entries: map[string]*ManifestEntry{}}
}

// markIngested 模擬「上一輪 ingest 全部成功」：ingested_hash 補成 content_hash。
func markIngested(m *Manifest) {
	for _, e := range m.Entries {
		e.IngestedHash = e.ContentHash
		e.IngestedAt = 1
	}
}

func mustScan(t *testing.T, root string, m *Manifest) *TriggerPayload {
	t.Helper()
	p, err := Scan(root, m, ScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func eventsOfType(p *TriggerPayload, typ string) []Event {
	var out []Event
	for _, e := range p.Events {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

// 情境 1：added——新檔進來，事件帶 source_hash / size / r2_key，manifest 記錄但不標已 ingest。
func TestAdded(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "hello world\n", baseTime)
	m := newTestManifest()

	p := mustScan(t, root, m)

	if p.SchemaVersion != 1 || p.FolderID != "test-folder-id" {
		t.Fatalf("payload 頭部不對: %+v", p)
	}
	if len(p.Events) != 1 {
		t.Fatalf("要 1 個事件，得到 %d: %+v", len(p.Events), p.Events)
	}
	ev := p.Events[0]
	wantHash := hashOf("hello world\n")
	if ev.Type != "added" || ev.Path != "a.md" || ev.SourceHash != wantHash {
		t.Fatalf("added 事件不對: %+v", ev)
	}
	if ev.R2Key != "raw/"+wantHash[len("sha256:"):] {
		t.Fatalf("r2_key 不對: %s", ev.R2Key)
	}
	if ev.Size == nil || *ev.Size != int64(len("hello world\n")) {
		t.Fatalf("size 不對: %+v", ev.Size)
	}
	e := m.Entries["a.md"]
	if e == nil || e.ContentHash != wantHash || e.IngestedHash != "" {
		t.Fatalf("manifest 記錄不對: %+v", e)
	}

	// R3：模擬 ingest 成功後重掃（＝daemon 重啟），未變更檔案零事件。
	markIngested(m)
	p2 := mustScan(t, root, m)
	if len(p2.Events) != 0 {
		t.Fatalf("未變更檔案不得重送，得到: %+v", p2.Events)
	}
}

// 情境 2：modified——內容變（mtime 也變）→ modified 事件帶新 hash；ingested_hash 保留舊值（可重試語意）。
func TestModified(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "v1\n", baseTime)
	m := newTestManifest()
	mustScan(t, root, m)
	markIngested(m)
	oldIngested := m.Entries["a.md"].IngestedHash

	writeFile(t, root, "a.md", "v2 changed\n", baseTime.Add(time.Hour))
	p := mustScan(t, root, m)

	if len(p.Events) != 1 {
		t.Fatalf("要 1 個事件，得到: %+v", p.Events)
	}
	ev := p.Events[0]
	wantHash := hashOf("v2 changed\n")
	if ev.Type != "modified" || ev.Path != "a.md" || ev.SourceHash != wantHash || ev.R2Key == "" {
		t.Fatalf("modified 事件不對: %+v", ev)
	}
	e := m.Entries["a.md"]
	if e.ContentHash != wantHash {
		t.Fatalf("manifest content_hash 未更新: %+v", e)
	}
	if e.IngestedHash != oldIngested {
		t.Fatalf("ingested_hash 不該在掃描階段被動（上傳成功才回寫）: %+v", e)
	}
}

// 情境 3：removed——比例低於防呆門檻時正常發下架事件（帶最後已知 hash），manifest 條目移除。
func TestRemoved(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "aaa\n", baseTime)
	writeFile(t, root, "b.md", "bbb\n", baseTime)
	writeFile(t, root, "c.md", "ccc\n", baseTime)
	m := newTestManifest()
	mustScan(t, root, m)
	markIngested(m)

	if err := os.Remove(filepath.Join(root, "b.md")); err != nil {
		t.Fatal(err)
	}
	p := mustScan(t, root, m) // 1/3 = 33% ≤ 40% → 放行

	if len(p.Warnings) != 0 {
		t.Fatalf("不該觸發防呆: %+v", p.Warnings)
	}
	rm := eventsOfType(p, "removed")
	if len(rm) != 1 || rm[0].Path != "b.md" || rm[0].SourceHash != hashOf("bbb\n") {
		t.Fatalf("removed 事件不對: %+v", rm)
	}
	if len(p.Events) != 1 {
		t.Fatalf("其餘檔案不該有事件: %+v", p.Events)
	}
	if _, ok := m.Entries["b.md"]; ok {
		t.Fatal("removed 後 manifest 條目應移除")
	}
	if len(m.Entries) != 2 {
		t.Fatalf("manifest 應剩 2 條: %+v", m.Entries)
	}
}

// 情境 4：renamed——改名/搬移以 content_hash 配對，只更新路徑映射：
// 不重萃（ingested_hash 原樣搬）、不誤刪（零 removed/added 事件）。
func TestRenamed(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "same content\n", baseTime)
	writeFile(t, root, "keep.md", "keep\n", baseTime)
	m := newTestManifest()
	mustScan(t, root, m)
	markIngested(m)
	ingestedAt := m.Entries["a.md"].IngestedAt

	// 搬進子資料夾＋改名（同內容）
	writeFile(t, root, "sub/b.md", "same content\n", baseTime.Add(time.Hour))
	if err := os.Remove(filepath.Join(root, "a.md")); err != nil {
		t.Fatal(err)
	}
	p := mustScan(t, root, m)

	if len(p.Events) != 1 {
		t.Fatalf("改名只該有 1 個 renamed 事件，得到: %+v", p.Events)
	}
	ev := p.Events[0]
	if ev.Type != "renamed" || ev.Path != "sub/b.md" || ev.OldPath != "a.md" || ev.SourceHash != hashOf("same content\n") {
		t.Fatalf("renamed 事件不對: %+v", ev)
	}
	if len(eventsOfType(p, "removed"))+len(eventsOfType(p, "added")) != 0 {
		t.Fatalf("改名不得產生 removed/added（誤刪/重萃）: %+v", p.Events)
	}
	if _, ok := m.Entries["a.md"]; ok {
		t.Fatal("舊路徑條目應消失")
	}
	ne := m.Entries["sub/b.md"]
	if ne == nil || ne.IngestedHash != hashOf("same content\n") || ne.IngestedAt != ingestedAt {
		t.Fatalf("路徑映射未保留 ingest 狀態（會導致重萃）: %+v", ne)
	}
}

// 情境 5：大量刪除防呆——資料夾整個清空（100% > 40%），卡片零下架＋警告有發出，manifest 條目保留。
func TestMassDeleteGuard(t *testing.T) {
	root := t.TempDir()
	names := []string{"a.md", "b.md", "c.md", "d.md", "e.md"}
	for _, n := range names {
		writeFile(t, root, n, n+" content\n", baseTime)
	}
	m := newTestManifest()
	mustScan(t, root, m)
	markIngested(m)

	for _, n := range names { // 模擬資料夾未掛載/清空
		if err := os.Remove(filepath.Join(root, n)); err != nil {
			t.Fatal(err)
		}
	}
	p := mustScan(t, root, m)

	if len(eventsOfType(p, "removed")) != 0 {
		t.Fatalf("防呆觸發時 removed 必須全數壓下: %+v", p.Events)
	}
	if len(p.Warnings) != 1 || p.Warnings[0].Code != "mass_delete_guard" {
		t.Fatalf("警告未發出: %+v", p.Warnings)
	}
	w := p.Warnings[0]
	if w.RemovedCount != 5 || w.ManifestCount != 5 || w.ThresholdRatio != DefaultMaxRemovedRatio {
		t.Fatalf("警告數字不對: %+v", w)
	}
	if len(m.Entries) != 5 {
		t.Fatalf("防呆觸發時 manifest 條目必須保留（下輪重評）: %d", len(m.Entries))
	}

	// 檔案回來（誤刪復原）→ 內容沒變、mtime 相同 → 零事件、警告消失。
	for _, n := range names {
		writeFile(t, root, n, n+" content\n", baseTime)
	}
	p2 := mustScan(t, root, m)
	if len(p2.Events) != 0 || len(p2.Warnings) != 0 {
		t.Fatalf("復原後應零事件零警告: events=%+v warnings=%+v", p2.Events, p2.Warnings)
	}
}

// 附加：mtime fast-path——mtime/size 沒變不重算 hash（用「內容偷偷改但 mtime 不動」驗證 fast-path 真的生效）。
func TestMtimeFastPath(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.md", "AAAA\n", baseTime) // 與替換內容等長 → size 相同
	m := newTestManifest()
	mustScan(t, root, m)
	markIngested(m)

	// 同 size、同 mtime、內容不同：fast-path 應沿用舊 hash → 零事件（設計如此：mtime 只是 fast-path）
	writeFile(t, root, "a.md", "BBBB\n", baseTime)
	p := mustScan(t, root, m)
	if len(p.Events) != 0 {
		t.Fatalf("fast-path 未生效（mtime/size 未變不該重算 hash）: %+v", p.Events)
	}
	// mtime 一變就會重算 → 抓到真變更
	writeFile(t, root, "a.md", "BBBB\n", baseTime.Add(time.Minute))
	p2 := mustScan(t, root, m)
	if len(p2.Events) != 1 || p2.Events[0].Type != "modified" {
		t.Fatalf("mtime 變更後應抓到 modified: %+v", p2.Events)
	}
}

// 附加：manifest 存讀往返。
func TestManifestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	mp := filepath.Join(dir, "manifest.json")
	m, err := LoadManifest(mp, "/tmp/kb")
	if err != nil {
		t.Fatal(err)
	}
	if m.FolderID == "" {
		t.Fatal("新 manifest 應生成 folder_id")
	}
	m.Entries["x.md"] = &ManifestEntry{ContentHash: hashOf("x"), Size: 1, Mtime: 2, IngestedHash: hashOf("x"), IngestedAt: 3}
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	m2, err := LoadManifest(mp, "")
	if err != nil {
		t.Fatal(err)
	}
	if m2.FolderID != m.FolderID || m2.Entries["x.md"] == nil || m2.Entries["x.md"].IngestedAt != 3 {
		t.Fatalf("往返不一致: %+v", m2)
	}
}
