package collector

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIngestedSinceCountsOnlyRecent(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "r")
	_ = os.MkdirAll(root, 0o755)
	url := "https://x.example"
	mp := ManifestPathFor(filepath.Join(base, "manifest.json"), url, root)
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	now := time.Now()
	m.Entries["a"] = &ManifestEntry{IngestedHash: "h", IngestedAt: now.Add(-10 * time.Minute).Unix()}
	m.Entries["b"] = &ManifestEntry{IngestedHash: "h", IngestedAt: now.Add(-2 * time.Hour).Unix()}
	m.Entries["c"] = &ManifestEntry{IngestedAt: now.Unix()} // 沒送成功（無 IngestedHash）不算
	if err := m.Save(mp); err != nil {
		t.Fatal(err)
	}
	if got := IngestedSince(filepath.Join(base, "manifest.json"), url, []string{root}, now.Add(-time.Hour)); got != 1 {
		t.Fatalf("近一小時應只有 1 份，得到 %d", got)
	}
}
