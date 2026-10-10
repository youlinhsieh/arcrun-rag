package collector

import (
	"os"
	"path/filepath"
	"testing"
)

func stalledManifest(n int, lastErr string, fails int) *Manifest {
	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	for i := 0; i < n; i++ {
		m.Entries["sub/f"+itoa(i)+".md"] = &ManifestEntry{FailCount: fails, LastError: lastErr, FailLintRev: lintGateRevision}
	}
	return m
}

func TestStalledGroups_SameReasonOneGroupSamplesNoContent(t *testing.T) {
	m := stalledManifest(5, "品質未過（不送）：H1: 缺段名：重點", 8)
	g := StalledGroups("geek.example", map[string]*Manifest{"/r": m})
	if len(g) != 1 || g[0].Count != 5 || len(g[0].Samples) != 5 || g[0].Key != "quality:H1" {
		t.Fatalf("got %+v", g)
	}
	if g[0].Samples[0] != "f0.md" { // basename，不帶資料夾路徑
		t.Fatalf("樣本應只有檔名：%v", g[0].Samples)
	}
}

func TestStalledGroups_BelowThresholdAndSelfRecoveringIgnored(t *testing.T) {
	if g := StalledGroups("h", map[string]*Manifest{"/r": stalledManifest(2, "品質未過（不送）：H1: x", 8)}); len(g) != 0 {
		t.Fatal("2 份不到門檻，不該跳")
	}
	if g := StalledGroups("h", map[string]*Manifest{"/r": stalledManifest(9, "雲端萃取失敗（HTTP 502）：Workers AI 執行失敗：4007: x", 8)}); len(g) != 0 {
		t.Fatal("會自己續試的暫時性錯誤，剛滿 8 次不該跳")
	}
	if g := StalledGroups("h", map[string]*Manifest{"/r": stalledManifest(9, "雲端萃取失敗（HTTP 502）：Workers AI 執行失敗：4007: x", 12)}); len(g) != 1 {
		t.Fatal("續試又多撞 4 次仍不過，應算停工")
	}
	if g := StalledGroups("h", map[string]*Manifest{"/r": stalledManifest(5, "品質未過（不送）：H1: x", 3)}); len(g) != 0 {
		t.Fatal("還沒滿 8 次不算停工")
	}
}

func TestStalledGroups_DifferentReasonsSeparateGroups(t *testing.T) {
	a := stalledManifest(4, "品質未過（不送）：H1: x", 8)
	b := stalledManifest(3, "雲端沒有把這一份寫進知識庫", 8)
	for k, v := range b.Entries {
		a.Entries["b-"+k] = v
	}
	g := StalledGroups("h", map[string]*Manifest{"/r": a})
	if len(g) != 2 || g[0].Count != 4 || g[1].Key != "cloud_write" {
		t.Fatalf("got %+v", g)
	}
}

// 實資料：leo 機器上 geek 的 error_codes 帳本（沒有就略過）。
func TestStalledGroups_RealErrorCodesManifest(t *testing.T) {
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".arcrun-rag", "manifest-official-20c3d717.json")
	if _, err := os.Stat(p); err != nil {
		t.Skip("沒有實帳本")
	}
	m, err := LoadManifest(p, "/x")
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range StalledGroups("geek", map[string]*Manifest{"/x": m}) {
		t.Logf("%s｜%s｜%d 份｜樣本 %v", g.Key, g.Label, g.Count, g.Samples)
	}
}

// #240 c18374：原因鍵只由穩定分類決定，不含錯誤原文。原文帶引號／JSON／逗號時，
// 鍵仍是固定的 "other"，關閉（×）寫下的鍵才會等於下次判斷用的鍵。
func TestStallReasonKeyNeverContainsRawError(t *testing.T) {
	for _, raw := range []string{
		`HTTP 500：{"success":false,"error":"boom, with comma"}`,
		`雲端回了 {"data":{"success":true}} 但沒寫進去`,
		`HTTP 503：{"success":false,"message":"x"}`,
	} {
		key, label := StallReason(raw)
		if key != "other" || label != "其他原因" {
			t.Fatalf("%q 應歸成固定的 other，得到 %q（%q）", raw, key, label)
		}
	}
}
