package main

// selfupdate_test.go — 2026-08-08 leo 真機實測撞到「檢查更新」壞掉兩個症狀後補的迴歸測試。
//
// 症狀一：manifest.daemon.mac.file 出貨格式從 zip 換成 dmg，但 applyStagedAndRestart
//
//	只認 zip（ditto -x -k）⇒ 拿 dmg 餵它 ⇒ ditto: Couldn't read PKZip signature，
//	Mac 自我更新從 v0.18.5 斷到 v0.18.22（至少七代）。
//
// 症狀二：手動裝好新版後按「檢查更新」，仍顯示「已下載完成，重新啟動就會套用」——
//
//	殘留的 staged.json 沒人清，判斷依據是「有沒有下載過」而不是「目前版本 vs 最新版本」。
//
// 本檔測兩件事的迴歸：
//  1. extractAppFrom 兩種格式（.dmg／.zip）都真的解得出 Arcrun.app（用真的 hdiutil／ditto，
//     不是 mock——症狀一就是「編譯期看起來對，跑真檔案才炸」，mock 測不出來）。
//  2. stagedDecision 的四種版本組合，涵蓋症狀二的所有分支。

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// ── 症狀二：staged 旗標的判準要是「當前 vs 最新」，不是「有沒有下載過」 ──────────

func TestStagedDecision(t *testing.T) {
	cases := []struct {
		name          string
		available     bool
		stagedVersion string
		latestVersion string
		wantReport    bool
		wantClear     bool
	}{
		{
			name:          "已經追上（leo 08-08 實測的那個病）：手動裝好新版，殘留 staged 版本剛好等於 latest",
			available:     false, // newerThanCurrent(latest) == false ⇒ 目前版本已經是最新
			stagedVersion: "v0.18.22",
			latestVersion: "v0.18.22",
			wantReport:    false,
			wantClear:     true,
		},
		{
			name:          "真的落後、staged 正是這次查到的最新版 ⇒ 該回報已就緒",
			available:     true,
			stagedVersion: "v0.18.22",
			latestVersion: "v0.18.22",
			wantReport:    true,
			wantClear:     false,
		},
		{
			name:          "落後，但 staged 的是更舊的一版（線上又出新的了）⇒ 舊 staged 作廢",
			available:     true,
			stagedVersion: "v0.18.21",
			latestVersion: "v0.18.22",
			wantReport:    false,
			wantClear:     true,
		},
		{
			name:          "已追上、且 staged 版本本來就對不上 ⇒ 一樣要清",
			available:     false,
			stagedVersion: "v0.18.20",
			latestVersion: "v0.18.22",
			wantReport:    false,
			wantClear:     true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			report, clear := stagedDecision(c.available, c.stagedVersion, c.latestVersion)
			if report != c.wantReport || clear != c.wantClear {
				t.Fatalf("stagedDecision(%v, %q, %q) = (%v, %v)，want (%v, %v)",
					c.available, c.stagedVersion, c.latestVersion, report, clear, c.wantReport, c.wantClear)
			}
		})
	}
}

// TestCheckUpdate_ClearsStaleStagedFile 端到端驗症狀二：staged.json 與暫存檔案
// 在「已追上」時真的從磁碟上消失，不是只清記憶體變數（否則下次啟動 loadStaged() 又撿回來）。
func TestCheckUpdate_ClearsStaleStagedFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// 準備一個「已備妥」的殘留檔案＋標記，版本跟目前正在跑的一樣（模擬手動裝好新版）。
	stalePath := updateStagePath("v0.18.22-fake.dmg")
	if err := os.WriteFile(stalePath, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	staged := stagedUpdate{Version: "v0.18.22", ZipPath: stalePath, Ready: true}
	saveStaged(staged)
	currentStaged = staged
	t.Cleanup(func() { currentStaged = stagedUpdate{} })

	if _, err := os.Stat(stalePath); err != nil {
		t.Fatalf("前置條件不成立：暫存檔沒建起來：%v", err)
	}

	// available=false、stagedVersion==latestVersion ⇒ 直接測 clearStaleStaged 路徑本身
	// （CheckUpdate 會打真網路，這裡只驗「決定要清」之後磁碟真的乾淨——那才是症狀二的核心）。
	report, clear := stagedDecision(false, staged.Version, staged.Version)
	if report || !clear {
		t.Fatalf("前置判斷不對：report=%v clear=%v，這個案例應該是 (false, true)", report, clear)
	}
	clearStaleStaged()

	if _, err := os.Stat(stalePath); !os.IsNotExist(err) {
		t.Fatalf("clearStaleStaged 後暫存檔還在：%v", err)
	}
	if _, err := os.Stat(stagedMarkerPath()); !os.IsNotExist(err) {
		t.Fatalf("clearStaleStaged 後 staged.json 還在：%v", err)
	}
	if reloaded := loadStaged(); reloaded.Ready {
		t.Fatalf("清完之後重新 loadStaged() 還是 Ready=true：%+v", reloaded)
	}
}

// ── 症狀一：extractAppFrom 兩種格式都要吃得下，且是用真的系統工具驗，不是 mock ──────

// fakeApp 在 dir 底下造一個看起來像 Arcrun.app 的最小骨架，回傳其路徑。
// 只需要「能被辨識出是這個 app」，不需要真的能跑（selfupdate 的解壓/覆蓋邏輯不在乎內容物）。
func fakeApp(t *testing.T, dir string) string {
	t.Helper()
	app := filepath.Join(dir, "Arcrun.app")
	contents := filepath.Join(app, "Contents", "MacOS")
	if err := os.MkdirAll(contents, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(contents, "arcrun-app")
	if err := os.WriteFile(marker, []byte("#!/bin/sh\necho fake\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return app
}

func TestExtractAppFrom_UnknownExtension(t *testing.T) {
	work := t.TempDir()
	_, err := extractAppFrom(filepath.Join(work, "update.tar.gz"), work)
	if err == nil {
		t.Fatal("非 .dmg 非 .zip 應該要報錯，卻沒有")
	}
}

func TestExtractAppFrom_Zip(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ditto 是 macOS 專用工具")
	}
	if _, err := exec.LookPath("ditto"); err != nil {
		t.Skip("這台機器沒有 ditto，略過")
	}

	src := t.TempDir()
	app := fakeApp(t, src)

	zipPath := filepath.Join(t.TempDir(), "update.zip")
	if out, err := exec.Command("ditto", "-c", "-k", "--keepParent", app, zipPath).CombinedOutput(); err != nil {
		t.Fatalf("測試前置：打包 zip 失敗：%v\n%s", err, out)
	}

	work := t.TempDir()
	got, err := extractAppFrom(zipPath, work)
	if err != nil {
		t.Fatalf("extractAppFrom(.zip) 失敗：%v", err)
	}
	marker := filepath.Join(got, "Contents", "MacOS", "arcrun-app")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("解出來的 .app 裡找不到標記檔：%v", err)
	}
}

// TestExtractAppFrom_DMG 是症狀一的核心迴歸：用真的 hdiutil 造一顆 dmg（與出貨的
// build-dmg.sh 同一款工具），餵給 extractAppFrom，驗證解得出 Arcrun.app。
// 這正是 08-08 之前會爆「ditto: Couldn't read PKZip signature」的那條路徑。
func TestExtractAppFrom_DMG(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("hdiutil 是 macOS 專用工具")
	}
	if _, err := exec.LookPath("hdiutil"); err != nil {
		t.Skip("這台機器沒有 hdiutil，略過")
	}

	stage := t.TempDir()
	fakeApp(t, stage)

	dmgPath := filepath.Join(t.TempDir(), "update.dmg")
	out, err := exec.Command("hdiutil", "create",
		"-volname", "ArcrunTest",
		"-srcfolder", stage,
		"-fs", "HFS+",
		"-ov", "-format", "UDZO",
		dmgPath).CombinedOutput()
	if err != nil {
		t.Fatalf("測試前置：造 dmg 失敗：%v\n%s", err, out)
	}

	work := t.TempDir()
	got, err := extractAppFrom(dmgPath, work)
	if err != nil {
		t.Fatalf("extractAppFrom(.dmg) 失敗（症狀一沒修好就會在這裡炸）：%v", err)
	}
	marker := filepath.Join(got, "Contents", "MacOS", "arcrun-app")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("解出來的 .app 裡找不到標記檔：%v", err)
	}
}

// ── moveFile：Windows 自我更新覆蓋新 exe 那一步，同磁碟區要用 rename 般的效果 ──────

func TestMoveFile_SameDir(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	want := []byte("new version content")
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := moveFile(src, dst); err != nil {
		t.Fatalf("moveFile 失敗：%v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("moveFile 後來源檔還在：%v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("目的檔讀不到：%v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("內容不符：got %q want %q", got, want)
	}
}
