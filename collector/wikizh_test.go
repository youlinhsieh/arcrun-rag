package collector

import (
	"strings"
	"testing"
)

func TestZhTag_terminology(t *testing.T) {
	cfg := "**Error message**\n\nConfiguration file '%1' cannot be written.\n\n**Cause of error**\n\nThe file cannot be opened for writing.\n- File is write-protected\n\n**Error correction**\n\n- Remove the write protection.\n"
	tag := zhTag(cfg)
	for _, w := range []string{"設定檔", "無法寫入", "寫不進去", "寫入保護"} {
		if !strings.Contains(tag, w) {
			t.Errorf("tag 缺 %q：%s", w, tag)
		}
	}
	tool := "**Error message**\n\nUnsuitable tool for machining.\n\n**Cause of error**\n\nAn unsuitable tool was selected.\n"
	if tag := zhTag(tool); !strings.Contains(tag, "刀具") || strings.Contains(tag, "工具") {
		t.Errorf("tool 必須一律譯刀具：%s", tag)
	}
	arc := "**Error message**\n\nIncorrect circular arc\n\n**Cause of error**\n\nThe specified radius is too small to connect the start point and end point.\n"
	tag = zhTag(arc)
	for _, w := range []string{"圓弧", "半徑太小"} {
		if !strings.Contains(tag, w) {
			t.Errorf("tag 缺 %q：%s", w, tag)
		}
	}
}

func TestZhEnglishDominant(t *testing.T) {
	if !zhEnglishDominant("Error message：Incorrect circular arc") || zhEnglishDominant("錯誤訊息：圓弧不正確") {
		t.Fatal("語言判斷不對")
	}
	if zhTag("# 標題\n\n只有中文內容") != "" {
		t.Fatal("無英文術語命中不該產生 tag")
	}
}

func TestIdxFirstClause_ignoresZhTag(t *testing.T) {
	got := idxFirstClause("- [[a]] — Error message：Incorrect arc｜中：錯誤圓弧｜詞：圓弧\n")
	if strings.Contains(got, "中：") {
		t.Fatal(got)
	}
}
