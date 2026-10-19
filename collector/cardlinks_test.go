package collector

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// #280 c21932：上雲的文件卡上，每個 [[X]] 都必須是雲端讀得到的卡
// （只送文件卡時：文件自己、00-INDEX；概念卡沒送，就不准有連結）。
func TestUnlinkUnsentConceptCards_NoDanglingLinks(t *testing.T) {
	root := t.TempDir()
	src := "# 測試文件\n\n內文若干"
	mustWrite(t, filepath.Join(root, "測試文件.md"), src)
	cards, err := BuildWikiDoc(root, "測試文件.md", src, wsExtract(), wsOrigin("測試文件.md"), wsNow)
	if err != nil {
		t.Fatal(err)
	}
	doc := mustRead(t, filepath.Join(root, filepath.FromSlash(cards[0])))
	if !strings.Contains(doc, "[[概念甲]]") {
		t.Fatalf("前提不成立：本機文件卡應含概念連結\n%s", doc)
	}
	sent := unlinkUnsentConceptCards(doc, conceptCardNames(cards[1:]))
	reachable := map[string]bool{"00-INDEX": true, "測試文件": true}
	for _, m := range regexp.MustCompile(`\[\[([^\]]+)\]\]`).FindAllStringSubmatch(sent, -1) {
		if !reachable[m[1]] {
			t.Fatalf("送上雲的文件卡仍有斷連結 [[%s]]：\n%s", m[1], sent)
		}
	}
	if strings.Contains(sent, "整理出") {
		t.Fatalf("指向未上雲概念卡的『整理出』邊應拿掉：\n%s", sent)
	}
	if !strings.Contains(sent, "概念甲") || !strings.Contains(sent, "概念乙") {
		t.Fatalf("拆殼後文字應保留：\n%s", sent)
	}
	// 內文知識關係、文件自己的連結不受影響
	if !strings.Contains(sent, "甲 >> 屬於 >> 測試域") || !strings.Contains(sent, "← [[00-INDEX]]") {
		t.Fatalf("不該動到其他內容：\n%s", sent)
	}
}

func TestUnlinkUnsentConceptCards_MechanicalCountLineAndNoop(t *testing.T) {
	card := "## 重點\n- 本文件整理成 2 張概念卡，入口是 [[機規格]]\n- 別的判斷 [[機規格]]\n"
	got := unlinkUnsentConceptCards(card, map[string]bool{"機規格": true})
	if strings.Contains(got, "本文件整理成") || strings.Contains(got, "[[") || !strings.Contains(got, "別的判斷 機規格") {
		t.Fatalf("got=%q", got)
	}
	if unlinkUnsentConceptCards(card, nil) != card {
		t.Fatal("沒有未上雲概念卡時應原樣回傳")
	}
}
