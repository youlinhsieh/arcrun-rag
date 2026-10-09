package collector

import (
	"os"
	"path/filepath"
	"time"
)

// IngestedSince 數一個帳號底下各監看資料夾的 manifest 裡，「送上雲端的時間」晚於 since 的份數。
// 給畫面的「近一小時送了幾份」用（inkstone/arcrun-rag#240 c18413）：要量得出「變快了沒」，
// 數字就得來自每份檔實際送上去的時間（manifest.IngestedAt），不是另記一份會漂的計數。
func IngestedSince(manifestBase, cypherURL string, roots []string, since time.Time) int {
	n := 0
	cut := since.Unix()
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		p := ManifestPathFor(manifestBase, cypherURL, abs)
		if _, err := os.Stat(p); err != nil {
			continue
		}
		m, err := LoadManifest(p, abs)
		if err != nil {
			continue
		}
		for _, e := range m.Entries {
			if e != nil && e.IngestedAt >= cut && e.IngestedHash != "" {
				n++
			}
		}
	}
	return n
}
