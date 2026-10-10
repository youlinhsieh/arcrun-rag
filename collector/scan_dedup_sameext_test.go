package collector

import "testing"

// #240 c18614：各資料夾同名的同副檔名檔（README.md／SKILL.md／00-INDEX.md）不是「同一份文件的多種格式」，
// 不能被去重吃掉（否則永遠不送、永遠算排隊）。
func TestDetectFormatDuplicatesIgnoresSameExtension(t *testing.T) {
	cur := map[string]fileState{
		"a/SKILL.md": {}, "b/SKILL.md": {}, "c/SKILL.md": {},
		"x/report.docx": {}, "x/report.md": {}, "z/report.md": {},
	}
	loser, _ := detectFormatDuplicates(cur)
	for _, p := range []string{"a/SKILL.md", "b/SKILL.md", "c/SKILL.md", "x/report.docx"} {
		if loser[p] != "" {
			t.Errorf("%s 不該是 loser（被 %s 吃掉）", p, loser[p])
		}
	}
	if loser["x/report.md"] != "x/report.docx" || loser["z/report.md"] != "" {
		t.Errorf("同目錄不同格式的同名檔應去重、不同目錄的同名檔不去重：%v", loser)
	}
}

// #240 c18620：不同資料夾的同名檔（含不同副檔名）永遠是不同的兩份內容。
func TestDetectFormatDuplicatesNeverAcrossDirectories(t *testing.T) {
	cur := map[string]fileState{"a/spec.docx": {}, "b/spec.md": {}, "c/spec.pdf": {}}
	loser, dups := detectFormatDuplicates(cur)
	if len(loser) != 0 || len(dups) != 0 {
		t.Fatalf("不同資料夾不該合併：%v", loser)
	}
}
