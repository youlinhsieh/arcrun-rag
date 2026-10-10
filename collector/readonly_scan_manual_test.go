package collector

// 手動對帳（#240 c18620）：只讀掃描 leo 本機的 manifest 副本，印出「舊口徑 vs 新口徑」的 排隊／完成／!N。
// 用法：ARCRUN_READONLY_SCAN=1 go test -run TestManualReadonlyScan -v ./
// 只讀：manifest 先複製到暫存、不 Save；掃描只算 hash，不寫任何檔、不連網。

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestManualReadonlyScan(t *testing.T) {
	if os.Getenv("ARCRUN_READONLY_SCAN") == "" {
		t.Skip("手動")
	}
	home, _ := os.UserHomeDir()
	files, _ := filepath.Glob(filepath.Join(home, ".arcrun-rag", "manifest-official-*.json"))
	sort.Strings(files)
	var oT, nT SyncProgress
	for _, f := range files {
		b, _ := os.ReadFile(f)
		tmp := filepath.Join(t.TempDir(), "m.json")
		_ = os.WriteFile(tmp, b, 0o600)
		m, err := LoadManifest(tmp, "")
		if err != nil || m == nil || m.Root == "" {
			continue
		}
		if _, err := os.Stat(m.Root); err != nil {
			continue
		}
		// 舊口徑：照舊規則數儲存的 entries（副本計入、無法處理的要撞滿 8 次才算 !）
		var o SyncProgress
		for _, e := range m.Entries {
			if e == nil {
				continue
			}
			o.Total++
			switch {
			case e.IngestedHash != "" && e.IngestedHash == e.ContentHash:
				o.Done++
			case isLocalNetworkText(e.LastError):
				o.Pending++
			case e.FailCount >= MaxFailBeforeSkip:
				o.Stuck++
			default:
				o.Pending++
			}
		}
		pendNoFail := 0
		for _, e := range m.Entries {
			if e != nil && e.FailCount == 0 && e.IngestedHash != e.ContentHash {
				pendNoFail++
			}
		}
		payload, err := Scan(m.Root, m, ScanOptions{})
		if err == nil {
			added := 0
			for _, ev := range payload.Events {
				if ev.Type == "added" || ev.Type == "modified" {
					added++
				}
			}
			fmt.Printf("   ↳ %s：舊排隊中從沒試過的 %d 份；新版掃描排進送出佇列 %d 份、副本不計 %d 份\n", filepath.Base(m.Root), pendNoFail, added, len(payload.DuplicateFormats))
		}
		if err != nil {
			t.Logf("%s scan: %v", m.Root, err)
			continue
		}
		n := m.Progress()
		fmt.Printf("%-70s 舊 總%5d 完成%5d 排隊%5d !%4d ｜ 新 總%5d 完成%5d 排隊%5d !%4d\n", m.Root, o.Total, o.Done, o.Pending, o.Stuck, n.Total, n.Done, n.Pending, n.Stuck)
		oT = oT.Add(o)
		nT = nT.Add(n)
	}
	fmt.Printf("%-70s 舊 總%5d 完成%5d 排隊%5d !%4d ｜ 新 總%5d 完成%5d 排隊%5d !%4d\n", "合計", oT.Total, oT.Done, oT.Pending, oT.Stuck, nT.Total, nT.Done, nT.Pending, nT.Stuck)
}
