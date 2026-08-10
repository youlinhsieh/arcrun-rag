package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// t184：更新必須蓋在「正在跑的那個 .app」，不是寫死 /Applications。
// leo 08-04 實撞：Oscar 從下載資料夾跑 → ditto 自動建 /Applications 副本並回成功
// → 他重開仍是舊版，畫面卻說更新完成（靜默失敗）。
func TestRunningAppBundlePathNotHardcoded(t *testing.T) {
	got, err := runningAppBundlePath()
	// 測試執行檔不在 .app 裡 → 應誠實回錯，**不可**回傳寫死的 /Applications 路徑
	if err == nil && strings.HasPrefix(got, "/Applications/") {
		t.Errorf("不該回寫死的 /Applications 路徑：%q", got)
	}
	if err == nil && !strings.HasSuffix(got, ".app") {
		t.Errorf("回傳的不是 .app：%q", got)
	}
}

// 模擬真實 .app 結構：<dir>/Arcrun.app/Contents/MacOS/arcrun-tray
// 驗證「往上三層」的推導正確——放在哪個目錄都要算得出來。
func TestAppBundleDerivationFromExePath(t *testing.T) {
	for _, base := range []string{"/Applications", "/Users/oscar/Downloads", "/Volumes/USB"} {
		exe := filepath.Join(base, "Arcrun.app", "Contents", "MacOS", "arcrun-tray")
		app := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
		want := filepath.Join(base, "Arcrun.app")
		if app != want {
			t.Errorf("從 %s 推導錯：got %q want %q", base, app, want)
		}
	}
}

// ditto 對不存在的目標會自動建目錄且回成功——這正是靜默失敗的成因，留測防回歸認知。
func TestDittoCreatesMissingTargetSilently(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "Fake.app", "Contents")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "x"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "nowhere", "Fake.app")
	if _, err := runCmd("ditto", filepath.Join(dir, "Fake.app"), dst); err != nil {
		t.Skipf("此環境沒有 ditto：%v", err)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatal("前提失效：ditto 應自動建出目標")
	}
	t.Log("確認：ditto 蓋到不存在的路徑會成功建出 ⇒ 寫死路徑必然靜默失敗")
}
