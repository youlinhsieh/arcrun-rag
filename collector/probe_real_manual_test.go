package collector

// probe_real_manual_test.go — 手動探針（**唯讀**）：拿真實資料夾對照
// 「舊判準（看 `.git`）」與「新判準（看內容）」，arcrun-rag#104 第二層。
//
// 🔴 為什麼留在 repo 裡而不是用完就丟：這一票的驗收條件是「**leo 真實的資料夾
// 換判準之後會收到什麼**」——那不是 fixture 答得出來的問題。下一個人要重新確認
// 存量影響（誰會多收、誰會少收），跑這兩支就有答案，不必再從頭想一次怎麼量。
// 預設 skip，不進 CI；`Scan` 全程不寫檔（scan.go 裡沒有任何 os.Write/Remove/Rename）。
//
//	PROBE_REAL=1 PROBE_SCAN=1 PROBE_ROOTS="/路徑A,/路徑B" go test -run TestProbeRealFolders -v ./
//	PROBE_REAL=1 PROBE_MINE="$HOME/Documents/KB"          go test -run TestProbeMine -v ./

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// oldMode 重現 2026-08-16 之前的模式選擇：用 DetectRepoRoot（找 .git）判是不是專案。
func oldMode(root string) IngestMode {
	if DetectRepoRoot(root) == "" {
		return IngestAll
	}
	if findCuratedWiki(root) != "" {
		return IngestCuratedWiki
	}
	return IngestDocsOnly
}

// mirrorTree 把 src 的**結構**（每個目錄、每個檔名）複製到 dst，內容一律換成一個字。
// 用途：拿真實資料夾的形狀當地雷測試的素材，而**完全不碰真實資料夾**。
func mirrorTree(t *testing.T, src, dst string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(src, p)
		if rerr != nil {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		n++
		return os.WriteFile(target, []byte("x\n"), 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// 🔴 地雷測試（真實形狀版）：拿 `~/Documents/KB` 的**結構**造兩份拋棄式副本，
// 一份有 `.git`、一份沒有，比對兩邊收到的檔案集合。**全程不碰 KB 本身。**
//
//	PROBE_REAL=1 PROBE_MINE="$HOME/Documents/KB" go test -run TestProbeMine -v ./ -timeout 30m
func TestProbeMine(t *testing.T) {
	if os.Getenv("PROBE_REAL") != "1" || os.Getenv("PROBE_MINE") == "" {
		t.Skip("手動探針")
	}
	src := os.Getenv("PROBE_MINE")
	base := t.TempDir()

	noGit := filepath.Join(base, "nogit")
	withGit := filepath.Join(base, "withgit")
	n := mirrorTree(t, src, noGit)
	mirrorTree(t, src, withGit)
	if err := os.MkdirAll(filepath.Join(withGit, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Logf("拿 %s 的結構造了兩份拋棄式副本（各 %d 個檔），一份跑過 git init", src, n)

	var first []string
	for _, tc := range []struct{ name, root string }{
		{"沒有版控（今天的 KB）", noGit}, {"有版控（有人跑了一次 git init）", withGit},
	} {
		plan := PlanIngest(tc.root)
		m := &Manifest{Entries: map[string]*ManifestEntry{}}
		payload, err := Scan(tc.root, m, ScanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got := eventPaths(payload)
		t.Logf("%s：舊模式=%s｜新模式=%s｜送出 %d 個檔",
			tc.name, oldMode(tc.root), plan.Mode, len(got))
		if first == nil {
			first = got
			continue
		}
		if strings.Join(got, "\n") != strings.Join(first, "\n") {
			t.Fatalf("🔴 跑一次 git init 就改變了收到的東西：%d → %d 個檔", len(first), len(got))
		}
		t.Logf("✅ 兩邊收到的檔案集合完全相同（%d 個）", len(got))
	}
}

func TestProbeRealFolders(t *testing.T) {
	if os.Getenv("PROBE_REAL") != "1" {
		t.Skip("手動探針")
	}
	for _, root := range strings.Split(os.Getenv("PROBE_ROOTS"), ",") {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		shape := InspectFolder(root)
		plan := PlanIngest(root)
		t.Logf("═══ %s ═══", root)
		t.Logf("  版控訊號（舊判準用的）：DetectRepoRoot=%q", DetectRepoRoot(root))
		t.Logf("  實測形狀：專案檔 %d 個 %v／原始碼 %d／文件 %d（truncated=%v）",
			shape.ManifestCount, shape.ManifestRels, shape.CodeFiles, shape.DocFiles, shape.Truncated)
		t.Logf("  舊模式＝%s   →   新模式＝%s", oldMode(root), plan.Mode)
		t.Logf("  理由：%s", plan.Reason)

		if os.Getenv("PROBE_SCAN") == "1" {
			m := &Manifest{Entries: map[string]*ManifestEntry{}}
			payload, err := Scan(root, m, ScanOptions{})
			if err != nil {
				t.Logf("  掃描失敗：%v", err)
				continue
			}
			t.Logf("  ⇒ 這一輪會送出 %d 個檔（逐檔擋掉 %d，整棵跳過 %d 個資料夾）",
				len(payload.Events), payload.ExcludedByPlan, payload.ExcludedDirCount)
			for i, e := range payload.Events {
				if i >= 12 {
					t.Logf("     …等 %d 個", len(payload.Events))
					break
				}
				t.Logf("     ✓ %s", e.Path)
			}
			for i, d := range payload.ExcludedDirs {
				if i >= 8 {
					break
				}
				t.Logf("     ✗ %s — %s", d.Path, d.Reason)
			}
		}
	}
}
