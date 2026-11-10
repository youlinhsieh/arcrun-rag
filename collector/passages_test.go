package collector

import (
	"fmt"
	"strings"
	"testing"
)

func TestClassifyDocKind(t *testing.T) {
	if classifyDocKind("報價.xlsx", "") != docKindTable || classifyDocKind("a.CSV", "x") != docKindTable {
		t.Fatal("表格副檔名要判表格")
	}
	var sb strings.Builder
	for i := 0; i < 10; i++ {
		sb.WriteString(fmt.Sprintf("| E%04d | 馬達過熱 |\n", i))
	}
	if classifyDocKind("codes.md", sb.String()) != docKindTable {
		t.Fatal("內文大半是表格列要判表格")
	}
	if classifyDocKind("手冊.md", "# 標題\n\n一般敘述。\n\n| a | b |\n") != docKindNarrative {
		t.Fatal("零星表格列不算表格類")
	}
}

func TestIsCriticalFolder(t *testing.T) {
	if !isCriticalFolder([]string{"財務"}, "/r", "財務/a.md") || isCriticalFolder([]string{"財務"}, "/r", "財務部備份/a.md") {
		t.Fatal("相對前綴要以路徑邊界比對")
	}
	if !isCriticalFolder([]string{"/r/規範"}, "/r", "規範/x/y.md") {
		t.Fatal("絕對路徑要命中子層")
	}
	if isCriticalFolder(nil, "/r", "a.md") {
		t.Fatal("沒宣告就不是關鍵")
	}
}

func TestPassageRouteFor(t *testing.T) {
	c := &DirectConfig{}
	if ok, _ := c.passageRouteFor("/r", "a.md", nil); ok {
		t.Fatal("預設不開")
	}
	c.NarrativeRoute = "passages"
	if ok, _ := c.passageRouteFor("/r", "a.md", nil); !ok {
		t.Fatal("新檔敘述類走新路")
	}
	if ok, _ := c.passageRouteFor("/r", "a.xlsx", nil); ok {
		t.Fatal("表格類走舊路")
	}
	c.CriticalFolders = []string{"關鍵"}
	if ok, _ := c.passageRouteFor("/r", "關鍵/a.md", nil); ok {
		t.Fatal("關鍵資料夾走舊路")
	}
	if ok, _ := c.passageRouteFor("/r", "b.md", &ManifestEntry{IngestedHash: "h"}); ok {
		t.Fatal("先前已萃成卡的檔不動")
	}
	if ok, _ := c.passageRouteFor("/r", "b.md", &ManifestEntry{IngestedHash: "h", PassageMode: true}); !ok {
		t.Fatal("已走新路的檔繼續走新路")
	}
	if ok, _ := c.passageRouteFor("/r", "b.md", &ManifestEntry{}); !ok {
		t.Fatal("沒成功送過的檔（含先前失敗）走新路")
	}
}

func TestChunkNarrative(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("# 報銷政策\n\n## 差旅\n\n")
	for i := 0; i < 40; i++ {
		sb.WriteString(fmt.Sprintf("第%d條：出差住宿每晚上限三千元，需附發票。\n\n", i))
	}
	sb.WriteString("## 交通\n\n高鐵可報銷二等艙。\n")
	ps := chunkNarrative("報銷政策", sb.String())
	if len(ps) < 2 {
		t.Fatalf("應切成多段，got %d", len(ps))
	}
	for i, p := range ps {
		if p.Idx != i {
			t.Fatalf("idx 要連續：%d", p.Idx)
		}
		if !strings.HasPrefix(p.Text, "報銷政策") {
			t.Fatalf("每段第一行是標題路徑：%q", p.Text[:20])
		}
		if n := len([]rune(p.Text)); n > passageMaxRunes+80 {
			t.Fatalf("段落超過上限：%d", n)
		}
	}
	last := ps[len(ps)-1]
	if !strings.Contains(last.Heading, "交通") || !strings.Contains(last.Text, "二等艙") {
		t.Fatalf("最後一段應帶「交通」標題：%+v", last)
	}
	// 全文都在（沒有靜默丟內容）
	all := ""
	for _, p := range ps {
		all += p.Text
	}
	for _, k := range []string{"第0條", "第39條", "二等艙"} {
		if !strings.Contains(all, k) {
			t.Fatalf("內容遺失：%s", k)
		}
	}
	// 決定性：同輸入同輸出
	ps2 := chunkNarrative("報銷政策", sb.String())
	if len(ps2) != len(ps) || ps2[0].Text != ps[0].Text {
		t.Fatal("切段要是決定性的")
	}
}

func TestChunkLongParagraphAndEmpty(t *testing.T) {
	long := strings.Repeat("這是一個很長的句子沒有空行。", 300)
	ps := chunkNarrative("長文", long)
	if len(ps) < 3 {
		t.Fatalf("長段落要被切開：%d", len(ps))
	}
	if len(chunkNarrative("空", "  \n\n ")) != 0 {
		t.Fatal("空文字不產生段落")
	}
}

func TestPassageIDsStableAndTrim(t *testing.T) {
	a := passageID("m1", "kb", "a.md", 3)
	if a != passageID("m1", "kb", "a.md", 3) || a == passageID("m2", "kb", "a.md", 3) || a == passageID("m1", "kb", "b.md", 3) {
		t.Fatal("id 由機器＋庫＋路徑＋序號決定")
	}
	b := passageDeleteIDs("m1", "kb", "a.md", 0, 95)
	if len(b) != 3 || len(b[0]) != passageTrimPerCall || len(b[2]) != 15 {
		t.Fatalf("刪除要分批：%d", len(b))
	}
}

func TestPushPassagesOrderAndTail(t *testing.T) {
	c := &DirectConfig{}
	ps := make([]Passage, 45)
	for i := range ps {
		ps[i] = Passage{Idx: i, Text: "x"}
	}
	assignPassageIDs(ps, "m", "kb", "a.md")
	var calls []map[string]any
	post := func(b map[string]any) (int, error) { calls = append(calls, b); return 200, nil }
	if err := c.pushPassages(post, "a.md", "a", "kb", "m", "M", "h2", ps, 60); err != nil {
		t.Fatal(err)
	}
	// 3 批寫入（由後往前：第 0 批最後）＋ 1 批尾巴刪除（45..59）
	if len(calls) != 4 {
		t.Fatalf("calls=%d", len(calls))
	}
	first := calls[2]["passages"].([]map[string]any)
	if first[0]["idx"].(int) != 0 {
		t.Fatal("第 0 段要最後送")
	}
	if calls[0]["passages"].([]map[string]any)[0]["idx"].(int) != 40 {
		t.Fatal("最後一批先送")
	}
	del := calls[3]["delete_ids"].([]string)
	if len(del) != 15 || calls[3]["source_hash"] != "h2" {
		t.Fatalf("尾巴刪除不對：%d", len(del))
	}
	// 失敗要往上報，且不刪尾巴
	calls = nil
	bad := func(b map[string]any) (int, error) { calls = append(calls, b); return 500, fmt.Errorf("boom") }
	if err := c.pushPassages(bad, "a.md", "a", "kb", "m", "M", "h2", ps, 60); err == nil {
		t.Fatal("失敗要回錯")
	}
	for _, b := range calls {
		if len(b["delete_ids"].([]string)) > 0 {
			t.Fatal("寫入失敗時不能先刪舊的")
		}
	}
}

func TestManifestPassageLifecycle(t *testing.T) {
	m := &Manifest{Entries: map[string]*ManifestEntry{"a.md": {ContentHash: "h"}}}
	if !m.MarkPassagesIngested("a.md", "h", 1, 7) {
		t.Fatal("蓋章失敗")
	}
	e := m.Entries["a.md"]
	if !e.PassageMode || e.PassageCount != 7 || !e.NoCloudCard || e.IngestedHash != "h" {
		t.Fatalf("%+v", e)
	}
	m.QueueTakedownOf("a.md", "a", e)
	if m.PendingPassageTrims["a.md"] != 7 {
		t.Fatal("待下架要記段數")
	}
	m.ClearTakedown("a.md")
	if len(m.PendingPassageTrims) != 0 || len(m.PendingTakedowns) != 0 {
		t.Fatal("清待辦要一起清")
	}
}
