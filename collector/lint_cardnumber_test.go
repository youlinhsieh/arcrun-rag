package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#240 c18236：品質閘 H5「疑似信用卡號」把頁碼／檔名裡的長數字當卡號，
// error_codes 91 份正常錯誤碼卡被擋。真卡號仍要擋、長數字代碼不能擋。
func TestScanSecretsCardNumber(t *testing.T) {
	blocked := []string{
		"付款卡號 4111 1111 1111 1111 請勿外流",
		"card: 5555-5555-5555-4444",
		"- 卡號 4012888888881881。",
		"amex 3782 822463 10005",
		"4111111111111111",
		"`4111111111111111`",
	}
	for _, s := range blocked {
		if len(scanSecrets(s)) == 0 {
			t.Errorf("真卡號應被擋：%q", s)
		}
	}
	passed := []string{
		"- 來源頁面 `1424194141044_N183C46.html`。",
		"- Source page: `1424194141044_N183C46.html`",
		"頁碼 1424194141044",                   // 13 位數，Luhn／前綴都不是卡號
		"序號 1234 5678 9012 3456",             // 形狀像，校驗碼不過
		"檔案 4111111111111111_backup.html",    // 卡號長度但緊鄰底線＝檔名一段
		"id=a4111111111111111",               // 緊鄰字母
		"timestamp 1791261259000 ms",         // 13 位時間戳
		"版本 2026-10-09 build 20261009123456", // 14 位日期時間
	}
	for _, s := range passed {
		if hits := scanSecrets(s); len(hits) != 0 {
			t.Errorf("長數字代碼不該被當卡號：%q → %v", s, hits)
		}
	}
}

// 實檔回歸：被擋的 error_codes 卡（若本機有）通過 H5；每份至少也不能新增別的硬缺。
func TestErrorCodesRealCardsNoCardNumberFalsePositive(t *testing.T) {
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, "Documents", "tech_projects", "ken_cnc", "error_codes")
	files, _ := filepath.Glob(filepath.Join(root, ".wiki", "*.md"))
	if len(files) < 10 {
		t.Skip("本機沒有 error_codes 實檔（至少 10 份），略過")
	}
	n := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil || !strings.Contains(string(b), "Source page") && !strings.Contains(string(b), "來源頁面") {
			continue
		}
		n++
		if hits := scanSecrets(string(b)); len(hits) != 0 {
			t.Errorf("%s 不該被判機敏：%v", filepath.Base(f), hits)
		}
	}
	t.Logf("掃了 %d 份含來源頁面代碼的卡", n)
}
