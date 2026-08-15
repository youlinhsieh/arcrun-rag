// template_install_test.go — daemon-beta task 2（代裝冪等／wiki 產物區不被掃）。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

// 空資料夾一鍵鋪好：關鍵檔齊、版本讀得到。
func TestInstallTemplateFresh(t *testing.T) {
	root := t.TempDir()
	res, err := InstallTemplate(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Installed) == 0 || len(res.Skipped) != 0 {
		t.Fatalf("首鋪帳目異常：installed=%d skipped=%d", len(res.Installed), len(res.Skipped))
	}
	if res.Version == "unknown" || res.Version == "" {
		t.Fatalf("版本讀不到：%q", res.Version)
	}
	for _, must := range []string{
		"system-dev/wiki/status.md",
		"system-dev/wiki/mistakes.md",
		".claude/commands/wiki-capture.md", // claude 萃取路（task 3）依賴它
	} {
		if _, err := os.Stat(filepath.Join(root, must)); err != nil {
			t.Fatalf("缺關鍵檔 %s：%v", must, err)
		}
	}
	if !TemplateInstalled(root) {
		t.Fatal("TemplateInstalled 應為 true")
	}
}

// 冪等：重跑不覆寫；用戶改過的檔保持原樣。
func TestInstallTemplateIdempotent(t *testing.T) {
	root := t.TempDir()
	if _, err := InstallTemplate(root); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "system-dev", "wiki", "status.md")
	if err := os.WriteFile(marker, []byte("用戶自己的進度，不准動"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InstallTemplate(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Installed) != 0 {
		t.Fatalf("重跑不應再鋪檔：installed=%v", res.Installed)
	}
	data, _ := os.ReadFile(marker)
	if string(data) != "用戶自己的進度，不准動" {
		t.Fatal("用戶檔被覆寫＝冪等鐵律破功")
	}
}

// 代裝後的 system-dev/ 不得被 direct 掃描當成原稿。
func TestScanSkipsTemplateArtifacts(t *testing.T) {
	root := t.TempDir()
	if _, err := InstallTemplate(root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "我的筆記.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &DirectConfig{
		WatchFolders: []string{root},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    "https://x.example", Namespace: "demo",
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, true)
	if exit != 0 {
		t.Fatalf("dry-run 失敗：%+v", results)
	}
	_, fileResults := splitInventory(results) // 結構先行：總覽卡另計
	if len(fileResults) != 1 || fileResults[0].Path != "我的筆記.md" {
		t.Fatalf("應只掃到用戶檔（template 產物須跳過），got %+v", results)
	}
}
