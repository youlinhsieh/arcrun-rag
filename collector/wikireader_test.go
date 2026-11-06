package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readerFixture(t *testing.T) (string, *wikiManifest) {
	t.Helper()
	root := t.TempDir()
	m := &wikiManifest{Version: 1, Docs: []wikiDoc{
		{Node: wikiRootNodeKey, Path: "145-0001.md", SHA256: "aaa", Status: "extracted", Card: "145-0001", Gloss: "Configuration file write failed"},
		{Node: wikiRootNodeKey, Path: "145-0002.md", SHA256: "bbb", Status: "extracted", Card: "145-0002", Gloss: "Tool not suitable"},
	}}
	if err := saveWikiManifest(root, m); err != nil {
		t.Fatal(err)
	}
	return root, m
}

func TestReaderTag_format(t *testing.T) {
	r := &docReader{Ver: 1, SHA: "x", Zh: "設定檔\n寫入失敗｜請檢查", Ask: []string{"設定存不進去", "設定存不進去", "存檔；失敗", "", "[[連結]]"}}
	tag := readerTag(r)
	if !strings.HasPrefix(tag, "｜中：設定檔 寫入失敗/請檢查｜問：") {
		t.Fatalf("格式不對：%q", tag)
	}
	if strings.Count(tag, "設定存不進去") != 1 {
		t.Fatalf("問法沒去重：%q", tag)
	}
	if strings.Contains(tag, "\n") || strings.Contains(tag, "[[") || strings.Contains(tag, "存檔；") {
		t.Fatalf("目錄行被打斷：%q", tag)
	}
	// 分組摘要不吃讀者段
	if got := idxFirstClause("- [[145-0001]] — Write failed" + tag + "\n"); got != "Write failed" {
		t.Fatalf("idxFirstClause = %q", got)
	}
}

func TestMergeReaderLines_shaGate(t *testing.T) {
	_, m := readerFixture(t)
	rep := &readerMergeReport{}
	changed := mergeReaderLines(m, []readerInLine{
		{Path: "145-0001.md", SHA: "aaa", Zh: "設定檔寫入失敗", Ask: []string{"設定存不進去"}},
		{Path: "145-0002.md", SHA: "OLD", Zh: "刀具不適用"}, // 原稿已改
		{Path: "999.md", SHA: "zzz", Zh: "不存在"},        // 帳本沒有
		{Path: "145-0002.md", SHA: "bbb"},              // 缺內容
	}, rep)
	if !changed || rep.Merged != 1 || rep.Stale != 1 || rep.Missing != 1 || rep.Bad != 1 {
		t.Fatalf("報告不對：%+v", rep)
	}
	if d := m.find(wikiRootNodeKey, "145-0001.md"); d.Reader == nil || d.Reader.Ver != readerLayerVer {
		t.Fatalf("沒併進去：%+v", d.Reader)
	}
	if m.find(wikiRootNodeKey, "145-0002.md").Reader != nil {
		t.Fatal("雜湊不符卻併進去了")
	}
	// 同樣內容再併一次＝未變
	rep2 := &readerMergeReport{}
	if mergeReaderLines(m, []readerInLine{{Path: "145-0001.md", SHA: "aaa", Zh: "設定檔寫入失敗", Ask: []string{"設定存不進去"}}}, rep2) || rep2.Unchanged != 1 {
		t.Fatalf("重複併入應為未變：%+v", rep2)
	}
}

func TestReaderUsable_andBacklog(t *testing.T) {
	d := wikiDoc{Node: "n", Path: "a.md", SHA256: "aaa", Status: "extracted", Reader: &docReader{Ver: readerLayerVer, SHA: "aaa", Zh: "中"}}
	if !readerUsable(d) || readerNeedsWork(d) != "" {
		t.Fatal("新鮮的讀者欄應可用、不必重做")
	}
	d.SHA256 = "changed"
	if readerUsable(d) || readerNeedsWork(d) != "原稿改過" {
		t.Fatal("原稿改了應作廢並列入重做")
	}
	d.SHA256 = "aaa"
	d.Reader.Ver = readerLayerVer - 1
	if !readerUsable(d) || !strings.HasPrefix(readerNeedsWork(d), "策略版本舊") {
		t.Fatal("策略版本舊：照用、但列入重做")
	}
	m := &wikiManifest{Docs: []wikiDoc{d,
		{Node: "n", Path: "b.md", SHA256: "b", Status: "extracted"},
		{Node: "other", Path: "c.md", SHA256: "c", Status: "extracted"}}}
	bl := readerBacklog(m)
	if len(bl["沒有讀者欄"]) != 1 || bl["沒有讀者欄"][0] != "n/b.md" {
		t.Fatalf("只該列有啟用讀者欄的節點：%v", bl)
	}
}

func TestMergeReaderInbox_inPlaceNoResidue(t *testing.T) {
	root, _ := readerFixture(t)
	inbox := readerInboxDir(root)
	if err := os.MkdirAll(inbox, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"node":"(根)","path":"145-0001.md","sha256":"aaa","ver":1,"zh":"設定檔寫入失敗","ask":["設定存不進去","參數無法儲存"],"by":"llama-4-scout"}` + "\n" + "不是 JSON\n"
	if err := os.WriteFile(filepath.Join(inbox, "reader-001.jsonl"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	before := listFiles(t, root)
	rep, err := mergeReaderInbox(root)
	if err != nil || rep == nil || rep.Merged != 1 || rep.Bad != 1 {
		t.Fatalf("rep=%+v err=%v", rep, err)
	}
	if _, err := os.Stat(inbox); !os.IsNotExist(err) {
		t.Fatal("收件匣應該收乾淨")
	}
	m := loadWikiManifest(root)
	if d := m.find(wikiRootNodeKey, "145-0001.md"); d.Reader == nil || d.Reader.By != "llama-4-scout" {
		t.Fatalf("帳本沒寫入：%+v", d)
	}
	idx, err := os.ReadFile(filepath.Join(root, wikiRelDir, "00-INDEX.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(idx), "｜問：設定存不進去；參數無法儲存") {
		t.Fatalf("本機目錄沒帶讀者欄：\n%s", idx)
	}
	// 就地：除了重算的目錄卡，沒有多出任何檔（收件匣的檔已刪）
	after := listFiles(t, root)
	for p := range after {
		if !before[p] && !strings.HasSuffix(p, "00-INDEX.md") {
			t.Fatalf("多出檔案：%s", p)
		}
	}
	// 沒有收件匣＝什麼都不做
	if rep, err := mergeReaderInbox(root); rep != nil || err != nil {
		t.Fatalf("空收件匣不該有動作：%+v %v", rep, err)
	}
}

func TestCloudIndex_usesReaderInsteadOfZhPatch(t *testing.T) {
	wm := &wikiManifest{Docs: []wikiDoc{
		{Node: wikiRootNodeKey, Path: "145-0001.md", SHA256: "aaa", Status: "extracted", Card: "145-0001", Gloss: "Configuration file write failed",
			Reader: &docReader{Ver: 1, SHA: "aaa", Zh: "設定檔寫入失敗", Ask: []string{"設定存不進去"}}},
		{Node: wikiRootNodeKey, Path: "145-0002.md", SHA256: "bbb", Status: "extracted", Card: "145-0002", Gloss: "Tool not suitable",
			Reader: &docReader{Ver: 1, SHA: "OLD", Zh: "刀具不適用"}}, // 原稿已改：不用
	}}
	cards := buildCloudIndexCards(wm)
	c := cards[0].Content
	if !strings.Contains(c, "[[145-0001]] — Configuration file write failed｜中：設定檔寫入失敗｜問：設定存不進去") {
		t.Fatalf("讀者欄沒進目錄行：\n%s", c)
	}
	if strings.Contains(c, "刀具不適用") {
		t.Fatalf("過期讀者欄不該出現：\n%s", c)
	}
}

func listFiles(t *testing.T, root string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			r, _ := filepath.Rel(root, p)
			out[r] = true
		}
		return nil
	})
	return out
}
