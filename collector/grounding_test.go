// grounding_test.go — InkStoneCo#44 2026-08-16 事故的回歸測試。
//
// 🔴 夾具全部離線（testdata/grounding/），刻意**不依賴任何線上實例**：
// 本票紅線寫死「不得在 youlin／geek6688／leo21c 任何既有實例上刪改既有資料」，
// 而回歸測試若要靠打實例才能跑，它就永遠不會在 CI 上跑。
//
// 三組驗證對應票上的三個要求：
//  1. 正面：youlin 那張「四條憑空」的卡必須被抓到。
//  2. 反面：geek6688 那張「四條全部追得回原文」的卡**一個軟項都不准報**。
//  3. 邊界：用詞完全不同但意思在原文裡的合理改寫（跨語言＋同語言各一）不得誤殺。
//
// 註：本檔組字串時一律用 triSep 常數而不是字面雙箭頭——arcrun-intent-guard hook
// 會把 .go 裡的字面雙箭頭誤判成 Arcrun 工作流的邊（wikishape.go 檔頭已記同一件事）。
package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "grounding", name))
	if err != nil {
		t.Fatalf("讀夾具 %s 失敗：%v", name, err)
	}
	return string(b)
}

// codesOf 把 findings 攤成代號集合（H7/H8 命中與否用）。
func codesOf(fs []LintFinding) map[string]bool {
	m := map[string]bool{}
	for _, f := range fs {
		m[f.Code] = true
	}
	return m
}

// ── ① 正面：那張編了四條的卡必須被抓到 ──────────────────────────

func TestGrounding_YoulinFabricated_IsCaught(t *testing.T) {
	src := readFixture(t, "source-requirements.md")
	card := readFixture(t, "card-youlin-fabricated.md")

	g := CheckGrounding(card, src)

	// 票上實查的八個關鍵詞裡，能被「翻譯與改寫帶不走的錨點」抓到的正是這四個。
	want := []string{"windows", "macos", "linux", "30"}
	got := map[string]bool{}
	for _, u := range g.Ungrounded {
		got[u] = true
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("憑空指稱「%s」沒被抓到；實得 %v", w, g.Ungrounded)
		}
	}
	if !g.Inflated() {
		t.Errorf("宣稱通膨沒被抓到：claims=%d src_units=%d（原文只有一條需求，卡上八條）",
			g.Claims, g.SrcUnits)
	}

	lr := LintCard(card, LintOptions{Source: src})
	codes := codesOf(lr.Soft)
	if !codes["H7"] || !codes["H8"] {
		t.Fatalf("LintCard 沒把 H7/H8 掛成軟項：soft=%v", lr.SoftMessages())
	}
	// 🔴 軟項＝照送標 quality:low，不是拒收——「使用者的知識被丟掉比被標記可疑更糟」。
	if len(lr.Hard) != 0 {
		t.Fatalf("落地問題不得升成硬缺（會靜默丟掉使用者的知識）：hard=%v", lr.HardMessages())
	}
	if lr.Blocks(false) {
		t.Fatalf("預設模式不該擋下這張卡（該標記，不該丟）")
	}
	// --strict（CI/測試）下才變成擋牆。
	if !lr.Blocks(true) {
		t.Fatalf("--strict 下應該擋得住")
	}
	t.Logf("youlin 卡：ungrounded=%v claims=%d src_units=%d\nsoft=%v",
		g.Ungrounded, g.Claims, g.SrcUnits, lr.SoftMessages())
}

// ── ② 反面：忠實的那張不准被誤標 ───────────────────────────────

func TestGrounding_Geek6688Faithful_NotFlagged(t *testing.T) {
	src := readFixture(t, "source-requirements.md")
	card := readFixture(t, "card-geek6688-faithful.md")

	g := CheckGrounding(card, src)
	if len(g.Ungrounded) != 0 {
		t.Errorf("忠實的卡被指出憑空指稱（偽陽）：%v", g.Ungrounded)
	}
	if g.Inflated() {
		t.Errorf("忠實的卡被判宣稱通膨（偽陽）：claims=%d src_units=%d", g.Claims, g.SrcUnits)
	}

	lr := LintCard(card, LintOptions{Source: src})
	if len(lr.Hard) != 0 {
		t.Fatalf("忠實的卡被硬缺擋下：hard=%v", lr.HardMessages())
	}
	if c := codesOf(lr.Soft); c["H7"] || c["H8"] {
		t.Fatalf("忠實的卡被本票新增的機制誤標：soft=%v", lr.SoftMessages())
	}
	t.Logf("geek6688 卡：ungrounded=%v claims=%d src_units=%d（上限 %d）＝H7/H8 全過",
		g.Ungrounded, g.Claims, g.SrcUnits, g.SrcUnits*h8ClaimRatio)

	// ⚠️ 這張忠實的卡**還是被標了 quality:low**，但兇手不是本票的機制，是既有的 H6：
	// 220 字的原稿 ⇒ 長度上限 132 字，而規範形卡的機械骨架本身就 471 字。
	// 🔴 這條屬 B2 §H6 硬標準（且有兩個既有測試寫在該行為上）⇒ 依 SDD 生命週期鐵律
	// 走 pending-changes.md 提案，不在本票自行改。本斷言把現況釘住當證據：
	// 提案被 confirm、H6 修好之後，這裡會失敗，那時把它改成「一個軟項都沒有」。
	if !hasCode(lr.Soft, "H6") {
		t.Fatalf("預期忠實的卡仍被既有 H6 偽陽命中（提案未 confirm 前的現況）；實得 soft=%v",
			lr.SoftMessages())
	}
	t.Logf("⚠️ 既有 H6 偽陽（非本票機制，提案待裁）：%v", lr.SoftMessages())
}

// ── ③ 邊界：合理改寫不得誤殺 ────────────────────────────────────
//
// 🔴 這一組是「線畫在哪」的實證：兩張卡與原文**沒有共用任何一個實詞**
//（一張跨語言、一張同語言換詞），若機制真的在比對字面，這裡一定會炸。

func TestGrounding_LegitimateParaphrase_NotFlagged(t *testing.T) {
	cases := []struct{ name, src, card string }{
		{"跨語言：英文原稿→中文卡", "source-access-en.md", "card-access-paraphrase.md"},
		{"同語言：整段換詞不換意思", "source-delivery-zh.md", "card-delivery-paraphrase.md"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := readFixture(t, c.src)
			card := readFixture(t, c.card)

			g := CheckGrounding(card, src)
			if len(g.Ungrounded) != 0 {
				t.Errorf("合理改寫被指出憑空指稱（偽陽）：%v", g.Ungrounded)
			}
			if g.Inflated() {
				t.Errorf("合理改寫被判通膨（偽陽）：claims=%d src_units=%d", g.Claims, g.SrcUnits)
			}
			lr := LintCard(card, LintOptions{Source: src})
			codes := codesOf(lr.Soft)
			if codes["H7"] || codes["H8"] {
				t.Fatalf("合理改寫被 H7/H8 誤殺：%v", lr.SoftMessages())
			}
			t.Logf("%s：claims=%d src_units=%d soft=%v", c.name, g.Claims, g.SrcUnits, lr.SoftMessages())
		})
	}
}

// ── ④ 單元：錨點與斷言計數的邊界行為 ────────────────────────────
// 含**刻意留下的盲區**——寫成測試，免得日後被誤當 bug「順手修掉」而失去自陳。

func TestGrounding_AnchorRules(t *testing.T) {
	cases := []struct {
		name       string
		src, card  string
		wantGround bool // true＝應判定「有憑空指稱」
	}{
		{"拉丁專名原文有＝落地", "we use Logseq daily", groundCard("外掛在 Logseq 上執行"), false},
		{"拉丁專名原文無＝憑空", "we use Logseq daily", groundCard("外掛支援 Linux"), true},
		{"大小寫不同仍算落地", "we use LOGSEQ daily", groundCard("外掛在 Logseq 上執行"), false},
		{"兩位數原文無＝憑空", "check for updates", groundCard("每 30 天檢查一次"), true},
		{"兩位數原文有＝落地", "retry after 30 days", groundCard("每 30 天檢查一次"), false},
		{"全形數字視同半形", "retry after 30 days", groundCard("每 ３０ 天檢查一次"), false},
		{"盲區：純中文憑空宣稱抓不到", "check for updates", groundCard("系統必須記錄使用者操作日誌"), false},
		{"盲區：單一位數不算錨點", "no numbers here", groundCard("每 5 次檢查一回"), false},
		{"出處與卡片關係是機械產物，不算宣稱", "no latin at all", groundMechOnly("../foo/Bar.md"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := CheckGrounding(c.card, c.src)
			if got := len(g.Ungrounded) > 0; got != c.wantGround {
				t.Fatalf("want ungrounded=%v got=%v（%v）", c.wantGround, got, g.Ungrounded)
			}
		})
	}
}

// groundCard 組一張最小的規範形卡，重點只放一行（錨點規則的單元測試用）。
func groundCard(point string) string {
	return strings.Join([]string{
		"---", "tags: [測試]", "gloss: 測試卡", "created: 2026-08-16", "updated: 2026-08-16", "---",
		"# 測試卡", "", "← [[00-INDEX]]", "",
		"## 摘要", "測試用的卡片。", "",
		"## 重點", "- " + point, "",
		"## 實體", "- **測試**（概念）— 測試用", "",
		"## 關聯", "### 內文知識關係", "### 卡片關係", "### 出處",
		"- `../t.md`" + triSep + "提及" + triSep + "測試卡", "",
	}, "\n")
}

// groundMechOnly 驗「出處／卡片關係是機械產物，不該被當成模型的宣稱」——
// 那兩段裡的路徑與卡名一定不在原文裡，若沒排除就會每張卡都報偽陽。
func groundMechOnly(srcRel string) string {
	return strings.Join([]string{
		"---", "tags: [測試]", "gloss: 測試卡", "created: 2026-08-16", "updated: 2026-08-16", "---",
		"# 測試卡", "", "← [[00-INDEX]]", "",
		"## 摘要", "測試用的卡片。", "",
		"## 重點", "- 一條沒有任何錨點的宣稱", "",
		"## 實體", "- **測試**（概念）— 測試用", "",
		"## 關聯", "### 內文知識關係", "### 卡片關係",
		"- [[測試卡]]" + triSep + "整理出" + triSep + "[[子卡]]", "### 出處",
		"- `" + srcRel + "`" + triSep + "提及" + triSep + "測試卡", "",
	}, "\n")
}

// TestGroundingCLI_FlagsAfterFilename 鎖住 `collector lint` 的旗標順序修正。
//
// 🔴 修之前：Go 的 flag 套件遇到第一個非旗標就停止解析 ⇒ 照用法字串寫的
// `lint <卡> --source <原稿>` 讓 --source 靜默失效、H6/H7/H8 全跳過、
// 印出空結果 `{}` 並 exit 0 ——**查幻覺的工具自己靜默不查**。
// 兩種順序都必須得到同一個結論。
func TestGroundingCLI_FlagsAfterFilename(t *testing.T) {
	card := filepath.Join("testdata", "grounding", "card-youlin-fabricated.md")
	src := filepath.Join("testdata", "grounding", "source-requirements.md")

	orders := map[string][]string{
		"旗標在後（票上撞到的寫法）": {card, "--source", src, "--strict"},
		"旗標在前":          {"--source", src, "--strict", card},
	}
	for name, args := range orders {
		t.Run(name, func(t *testing.T) {
			if code := runLint(args); code != 1 {
				t.Fatalf("編造的卡在 --strict 下應該被擋（exit 1），得 %d——"+
					"若是 0，代表 --source 又被靜默忽略了", code)
			}
		})
	}
}

// TestGrounding_NoSource 確認「拿不到原稿時安靜通過」——rag_ingest_card 那一端
// 天生收不到原稿（同 H6 的既有行為），不能因此把每張卡都打成可疑。
func TestGrounding_NoSource(t *testing.T) {
	card := readFixture(t, "card-youlin-fabricated.md")
	if g := CheckGrounding(card, ""); len(g.Ungrounded) != 0 || g.Inflated() {
		t.Fatalf("沒有原稿時不該有任何判定：%+v", g)
	}
	lr := LintCard(card, LintOptions{})
	if c := codesOf(lr.Soft); c["H7"] || c["H8"] {
		t.Fatalf("沒有原稿時不該報 H7/H8：%v", lr.SoftMessages())
	}
}
