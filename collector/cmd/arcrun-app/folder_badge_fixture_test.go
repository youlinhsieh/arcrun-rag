package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	collector "arcrun-rag/collector"
)

// TestDumpBadgeFixture 拿**這台機器上真的 status.json**跑一次 folderBadge，
// 把結果印出來／落成畫面驗收要用的 fixture（`inkstone/arcrun-rag#159`）。
//
// 🔴 為什麼不用手寫 fixture：驗收要貼的是「改後的實際畫面」，而畫面上的圖示
// 必須是**真的那個函式**算出來的。手抄一份 fixture 就是第二套實作，
// 貼出來的截圖也就不再是證據。
//
// 預設跳過（要真機資料才有意義）：`DUMP_BADGE_FIXTURE=1 go test -run TestDumpBadgeFixture`
func TestDumpBadgeFixture(t *testing.T) {
	if os.Getenv("DUMP_BADGE_FIXTURE") == "" {
		t.Skip("設 DUMP_BADGE_FIXTURE=1 才跑（要讀這台機器真的 status.json）")
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".arcrun-rag")

	var st struct {
		FolderProgress map[string]collector.SyncProgress `json:"folder_progress"`
		Resync         map[string]collector.ResyncStatus `json:"resync"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}

	// status.json 還沒有 folder_progress（那台跑的是舊版）⇒ 從 manifest 現算，
	// 用的仍是 (*Manifest).Progress() 本尊，不是另一套數法。
	if len(st.FolderProgress) == 0 {
		st.FolderProgress = map[string]collector.SyncProgress{}
		ms, _ := filepath.Glob(filepath.Join(dir, "manifest-official-*.json"))
		for _, mp := range ms {
			m, err := collector.LoadManifest(mp, "")
			if err != nil || m == nil || m.Root == "" {
				continue
			}
			st.FolderProgress[m.Root] = m.Progress()
		}
	}

	roots := make([]string, 0, len(st.FolderProgress))
	for r := range st.FolderProgress {
		roots = append(roots, r)
	}
	sort.Strings(roots)
	out := []map[string]any{}
	for _, r := range roots {
		p := st.FolderProgress[r]
		state, tip := folderBadge(p, true)
		fmt.Printf("%-56s total=%-5d done=%-5d pending=%-5d stuck=%-3d failing=%-4d  → %-8s %s\n",
			filepath.Base(r), p.Total, p.Done, p.Pending, p.Stuck, p.Failing, state, tip)
		out = append(out, map[string]any{
			"path": r, "sync": state, "syncTip": tip,
			"resyncNote": st.Resync[r].Note,
		})
	}
	if dest := os.Getenv("BADGE_FIXTURE_OUT"); dest != "" {
		j, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(dest, j, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("fixture 寫到 %s", dest)
	}
}
