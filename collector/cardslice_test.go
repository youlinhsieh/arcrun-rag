package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 與雲端 rag_ingest_card 的 prep／parse_card 數同一件事。期望值是用 workflows/rag-ingest-card.local.yaml
// 裡真的那段 prep code 跑出來的（node），不是手算：改雲端那條正則時，這裡要一起對。
func TestCountCardRelationsMatchesCloud(t *testing.T) {
	const sep = " >> "
	cases := []struct {
		name string
		md   string
		want int
	}{
		{"none", "# T\n## 摘要\nx\n", 1},
		{"basic", "# T\n## 關聯\n- a" + sep + "b" + sep + "c\n- d" + sep + "e" + sep + "f\n", 3},
		{"h3", "# T\n## 關聯\n### 內文知識關係\n- a" + sep + "b" + sep + "c\n### 卡片關係\n- d" + sep + "e" + sep + "f\n### 出處\n- 路徑\n## 其他\n- x" + sep + "y" + sep + "z\n", 3},
		{"dash", "# T\n## 關聯\n- a" + sep + "b" + sep + "c\n---\n- x" + sep + "y" + sep + "z\n", 2},
		{"noBullet", "# T\n## 關聯\na" + sep + "b" + sep + "c\n\n  * d" + sep + "e" + sep + "f\n壞行 >> 只有兩段\n", 3},
		{"h1after", "# T\n## 關聯\n- a" + sep + "b" + sep + "c\n# 下一章\n- x" + sep + "y" + sep + "z\n", 2},
	}
	for _, c := range cases {
		if got := countCardRelations(c.md); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}

func bigCardMD(n int) string {
	var b strings.Builder
	b.WriteString("# 大卡\n## 摘要\nx\n## 關聯\n")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "- S%d >> 依賴 >> O%d\n", i, i)
	}
	return b.String()
}

func TestPlanCardSlicesSmallCardIsOneCallLikeBefore(t *testing.T) {
	got := planCardSlices(bigCardMD(relsPerCall-1), 0, "大卡", true)
	if len(got) != 1 || got[0] != (cardSlice{}) {
		t.Fatalf("小卡（≤%d 條）應與從前一樣整張一發、不帶任何新欄位：%+v", relsPerCall, got)
	}
	if body := got[0].body(map[string]any{"a": 1}); len(body) != 1 {
		t.Fatalf("沒分段沒命名時 body 要原樣：%+v", body)
	}
}

func TestPlanCardSlicesBigHubOrderAndCoverage(t *testing.T) {
	md := bigCardMD(2*relsPerCall + 30) // + part_of ⇒ 比兩段多一點 ⇒ 3 段
	got := planCardSlices(md, 0, "大卡", true)
	if len(got) != 3 {
		t.Fatalf("應切 3 段：%+v", got)
	}
	// 送的順序：最後一段先、第一段最後（第一段是整份的提交標記）
	if got[0].Offset != 2*relsPerCall || got[0].Limit != 0 || got[0].Scope != "s2" {
		t.Errorf("第一發應是最後一段（offset 200、寫到最後、s2）：%+v", got[0])
	}
	if got[1].Offset != relsPerCall || got[1].Limit != relsPerCall || got[1].Scope != "s1" {
		t.Errorf("第二發：%+v", got[1])
	}
	if got[2].Offset != 0 || got[2].Scope != "" || got[2].Limit != relsPerCall {
		t.Errorf("最後一發應是第一段（offset 0、文件卡本人的名字 ''）：%+v", got[2])
	}
	if b := got[2].body(map[string]any{}); b["rel_limit"] != relsPerCall || b["rel_offset"] != nil || b["triplet_scope"] != nil {
		t.Errorf("第一段只帶 rel_limit：%+v", b)
	}
}

func TestPlanCardSlicesOldCloudNeverSlices(t *testing.T) {
	got := planCardSlices(bigCardMD(900), 0, "大卡", false)
	if len(got) != 1 || got[0] != (cardSlice{}) {
		t.Fatalf("舊版雲端看不懂分段：切段送過去每一段都會把整張卡全寫一遍，所以一定整張一發：%+v", got)
	}
}

func TestConceptCardsGetTheirOwnTripletName(t *testing.T) {
	got := planCardSlices(bigCardMD(3), 7, "KDDI", false)
	if len(got) != 1 || got[0].Scope != "c.KDDI" {
		t.Fatalf("概念卡的三元組要有自己的名字（否則會刪光同一份文件其他卡的）：%+v", got)
	}
	big := planCardSlices(bigCardMD(relsPerCall+10), 7, "KDDI", true)
	if len(big) != 2 || big[0].Scope != "c.KDDI.s1" || big[1].Scope != "c.KDDI" {
		t.Fatalf("概念卡也能切段，名字接在自己後面：%+v", big)
	}
}

func TestCloudHasSlicedNotes(t *testing.T) {
	for v, want := range map[string]bool{
		"": false, "2026-07-31+8e83589": false, "1.4.97": false, "1.4.102": false,
		"1.4.103": true, "1.4.103+abc": true, "1.4.110": true, "1.5.0": true,
	} {
		if got := cloudHasSlicedNotes(v); got != want {
			t.Errorf("%q: got %v want %v", v, got, want)
		}
	}
}

func TestSliceNamesAreUniquePerCardAndSlice(t *testing.T) {
	seen := map[string]string{}
	for _, c := range []struct {
		idx  int
		page string
	}{{0, "hub"}, {1, "A"}, {2, "B"}} {
		for _, sl := range planCardSlices(bigCardMD(7*relsPerCall), c.idx, c.page, true) {
			key := sl.Scope
			if prev, dup := seen[key]; dup {
				t.Fatalf("名字撞了（%q）：%s 與 %s——撞名就會互相刪對方的三元組", key, prev, c.page)
			}
			seen[key] = c.page
		}
	}
}

func TestPlanTakedownCallsCoversConceptCardsAndSlices(t *testing.T) {
	root := t.TempDir()
	rel := "doc.pdf"
	hub := filepath.Join(wikiRelDir, "hub.md")
	concept := filepath.Join(wikiRelDir, "概念甲.md")
	for p, md := range map[string]string{hub: bigCardMD(2*relsPerCall + 30), concept: bigCardMD(relsPerCall + 10)} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(md), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cards := []string{filepath.ToSlash(hub), filepath.ToSlash(concept)}

	with := planTakedownCallsFrom(root, rel, cards, true)
	want := []takedownCall{{"doc", "s1"}, {"doc", "s2"}, {"概念甲", "c.概念甲"}, {"概念甲", "c.概念甲.s1"}}
	if fmt.Sprint(with) != fmt.Sprint(want) {
		t.Errorf("走過續讀的文件：\n got %+v\nwant %+v", with, want)
	}
	without := planTakedownCallsFrom(root, rel, cards, false)
	if fmt.Sprint(without) != fmt.Sprint(want[:2]) {
		t.Errorf("沒走過續讀的文件概念卡沒上雲，只補 hub 的段：%+v", without)
	}
}
