package collector

import (
	"strings"
	"testing"
)

// ent 造一份最小 manifest entries（只有 path 有意義）。
func ent(paths ...string) map[string]*ManifestEntry {
	m := map[string]*ManifestEntry{}
	for i, p := range paths {
		m[p] = &ManifestEntry{ContentHash: "sha256:x", Mtime: int64(1787000000 + i)}
	}
	return m
}

// 這份就是 leo 08-19 要 demo 的形狀：4 層巢狀。
var nested = ent(
	"README.md",
	"01-公司制度/請假規則.md",
	"01-公司制度/資訊安全/密碼原則.md",
	"02-專案/教育部標案/RFP摘要.md",
	"02-專案/教育部標案/會議紀錄/20260801-啟動會議.md",
	"02-專案/教育部標案/會議紀錄/20260812-期中檢討.md",
	"03-產品/價目表.csv",
)

func TestDirsIncludeIntermediateLevels(t *testing.T) {
	got := dirsFromEntries(nested)
	want := []string{
		"01-公司制度", "01-公司制度/資訊安全",
		"02-專案", "02-專案/教育部標案", "02-專案/教育部標案/會議紀錄",
		"03-產品",
	}
	if len(got) != len(want) {
		t.Fatalf("目錄數 %d，期望 %d：%v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 個是 %q，期望 %q", i, got[i], want[i])
		}
	}
}

// 🔴 本檔的核心宣稱：每個巢狀資料夾各一張卡，而且父子接得起來。
func TestFractalOneCardPerFolderAndChainReachesRoot(t *testing.T) {
	cards := BuildFolderCards("/x/demo-test1", nested, "test1")
	if len(cards) != 6 {
		t.Fatalf("卡數 %d，期望 6（每個子資料夾一張）", len(cards))
	}

	byPage := map[string]FolderCard{}
	for _, c := range cards {
		byPage[c.Page] = c
		// 每張卡的「## 關聯」恰好一條——這是「不撞 50 subrequests」的結構保證
		rel := c.Content[strings.Index(c.Content, "## 關聯"):]
		if n := strings.Count(rel, "\n- "); n != 1 {
			t.Fatalf("%s 的關聯有 %d 條，必須恰好 1 條", c.Page, n)
		}
		if !strings.Contains(rel, c.Page+" >> part_of >> "+c.Parent) {
			t.Fatalf("%s 的關聯不是指向父層 %s：%q", c.Page, c.Parent, rel)
		}
	}

	// 從最深的一格一路往上走，必須走得到根（＝總覽卡頁名），且步數正確。
	deepest := folderCardPageName("/x/demo-test1", "02-專案/教育部標案/會議紀錄")
	cur, hops := byPage[deepest], 0
	if cur.Page == "" {
		t.Fatalf("找不到最深的那張卡 %q", deepest)
	}
	for {
		hops++
		parent, ok := byPage[cur.Parent]
		if !ok {
			if cur.Parent != inventoryPageName("/x/demo-test1") {
				t.Fatalf("鏈斷在 %q，它的父 %q 既不是卡也不是根", cur.Page, cur.Parent)
			}
			break
		}
		cur = parent
		if hops > 10 {
			t.Fatal("往上走超過 10 步，疑似有環")
		}
	}
	if hops != 3 {
		t.Fatalf("從第三層走到根走了 %d 步，期望 3", hops)
	}
}

// 卡片要講得出「這一層有幾份、含子層幾份」與子資料夾清單——那是給人看的「指向子層」。
func TestCardCountsAndChildrenListing(t *testing.T) {
	cards := BuildFolderCards("/x/demo-test1", nested, "test1")
	var top FolderCard
	for _, c := range cards {
		if c.Rel == "02-專案" {
			top = c
		}
	}
	if top.Page == "" {
		t.Fatal("找不到 02-專案 的卡")
	}
	if !strings.Contains(top.Content, "本層直接放了 0 份文件，連同子資料夾共 3 份") {
		t.Fatalf("份數講錯了：\n%s", top.Content)
	}
	if !strings.Contains(top.Content, "- 教育部標案（3 份）") {
		t.Fatalf("子資料夾清單不對：\n%s", top.Content)
	}
}

// t89 同款：slug 會把 "A/B" 與 "A_B" 壓成同一個字串，只靠 slug 會讓兩個資料夾共用一張卡。
func TestPathSlugDoesNotCollapseDifferentPaths(t *testing.T) {
	if pathSlug("a/b") == pathSlug("a_b") {
		t.Fatal("a/b 與 a_b 的鍵相同 ⇒ 兩個資料夾會共用一張卡（靜默混層）")
	}
	// 純中文路徑 slug 後為空，必須退成雜湊而不是空字串
	z := pathSlug("專案/會議")
	if z == "" || strings.HasPrefix(z, "-") {
		t.Fatalf("純中文路徑的鍵不合法：%q", z)
	}
	if pathSlug("專案/會議") == pathSlug("專案/紀錄") {
		t.Fatal("兩個不同的純中文路徑得到同一個鍵")
	}
}

// 🔴 迴歸守門：上限必須套在「要送的」上，不是套在「全部」上。
// 反過來寫的話，第 201 個之後的資料夾永遠送不上去，而畫面上一切正常。
func TestCapAppliesToPendingNotAll(t *testing.T) {
	paths := make([]string, 0, maxFolderCards+20)
	for i := 0; i < maxFolderCards+20; i++ {
		paths = append(paths, "d"+pad(i)+"/f.md")
	}
	entries := ent(paths...)
	cards := BuildFolderCards("/x/root", entries, "lib")
	if len(cards) != maxFolderCards+20 {
		t.Fatalf("卡數 %d，期望 %d", len(cards), maxFolderCards+20)
	}

	m := &Manifest{Entries: entries, FolderCardHashes: map[string]string{}}
	// 假裝前 maxFolderCards 個都已經送成功（雜湊相同）
	for _, c := range cards[:maxFolderCards] {
		m.FolderCardHashes[c.Rel] = hashOf(c.Content)
	}
	cfg := &DirectConfig{}
	res := syncFolderCards(cfg, "/x/root", m, true, true /*dryRun*/, nowFixed())
	if len(res) != 20 {
		t.Fatalf("這輪排到 %d 張，期望剩下的 20 張——上限若套在全部上，這裡會是 0", len(res))
	}
}

func TestIdempotentWhenNothingChanged(t *testing.T) {
	m := &Manifest{Entries: nested, FolderCardHashes: map[string]string{}}
	cfg := &DirectConfig{}
	first := syncFolderCards(cfg, "/x/demo-test1", m, true, true, nowFixed())
	if len(first) != 6 {
		t.Fatalf("第一輪 %d 張，期望 6", len(first))
	}
	// dryRun 不寫雜湊，改用真的算一次填進去模擬送成功
	for _, c := range BuildFolderCards("/x/demo-test1", nested, "") {
		m.FolderCardHashes[c.Rel] = hashOf(c.Content)
	}
	if second := syncFolderCards(cfg, "/x/demo-test1", m, true, true, nowFixed()); second != nil {
		t.Fatalf("內容沒變卻還要送 %d 張", len(second))
	}
}
