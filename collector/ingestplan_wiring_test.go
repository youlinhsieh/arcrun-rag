// ingestplan_wiring_test.go — arcrun-rag#104 第二輪。
//
// 🔴 這一組測的是**接線**，不是規則本身（那在 ingestplan_test.go）。
//
// 為什麼要獨立測（本票 2026-08-16 的真正教訓）：
// 那天讀源碼的人看到 `direct.go` 裡一行 `skipDirNames := {"system-dev": true}`，
// 就宣告「排除清單完整正確，但跑的走訪器不讀它」——並把它寫成三次同款事故的第三次。
// **實測之後那個診斷是錯的**：同一個呼叫裡下面幾行就寫著 `Plan: plan`，兩張表都接上了。
//
// 但那個誤判本身是有原因的，而原因是真的缺陷：
//
//	① 同一件事有**兩張表分居兩處** ⇒ 讀源碼的人只看到一張
//	② 排除規則生不生效，取決於**呼叫端記不記得傳** `Plan`
//	③ 真正沒接上的是**可見性**：`ExcludedByPlan`／`Plan` 只有 CLI 讀，
//	   daemon（使用者真正走的那條路）拿到就丟掉
//
// ⇒ 本檔把這三件事各釘一根釘子。**如果哪天有人又走了一條沒接上排除規則的路，
//
//	這裡要紅。**
package collector

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ───────────────────────────────────────────────────────────────────────────
// 釘子 ①：走訪器自己裝判準——呼叫端「忘了傳 Plan」這個失敗模式不存在
// ───────────────────────────────────────────────────────────────────────────

// 這是本輪修法的核心性質：**裸呼叫 Scan（完全不給策略）也必須排除掉別人的套件。**
// 以前這會整包收進去，因為排除規則要呼叫端主動接上。
func TestWiring_裸呼叫Scan也必須排除別人的套件(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"我的筆記.md": "# 我自己寫的",
		// 票上的實據：undici 的 API 文件與別人的授權條款被做成了「知識卡」
		"node_modules/undici/docs/api/Pool.md":       "# Pool",
		"node_modules/undici/docs/api/Dispatcher.md": "# Dispatcher",
		"node_modules/undici/README.md":              "# undici",
		"node_modules/crypto-browserify/LICENSE.md":  "MIT License",
	})

	m := &Manifest{Entries: map[string]*ManifestEntry{}}
	payload, err := Scan(root, m, ScanOptions{}) // ← 刻意什麼都不給
	if err != nil {
		t.Fatal(err)
	}
	got := eventPaths(payload)
	t.Logf("裸呼叫送出：%v", got)

	if payload.Plan.Mode == "" {
		t.Fatal("Scan 沒有自己算出收檔策略——排除規則又變成「呼叫端記得傳才生效」了")
	}
	for _, p := range got {
		if strings.Contains(p, "node_modules/") {
			t.Fatalf("裸呼叫 Scan 收進了別人的套件：%s", p)
		}
	}
	if len(got) != 1 || got[0] != "我的筆記.md" {
		t.Fatalf("應該只送使用者自己的那一份，實得：%v", got)
	}
}

// 釘子 ①之二：**源碼層**——每一個 Scan 的呼叫端，要嘛不給 Plan（讓 Scan 自己算），
// 要嘛給一個真的算過的 Plan。禁止再出現「自己手捏一張目錄黑名單」的第二條路。
//
// 這一條會在有人新增 `SkipDirNames: map[string]bool{...}` 當排除清單時變紅
// ——那正是 2026-08-16 讓人誤判的那個形狀。
func TestWiring_不准再有第二張排除清單(t *testing.T) {
	fset := token.NewFileSet()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := parser.ParseFile(fset, f, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("解析 %s 失敗：%v", f, err)
		}
		ast.Inspect(src, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok || id.Name != "Scan" || len(call.Args) != 3 {
				return true
			}
			checked++
			lit, ok := call.Args[2].(*ast.CompositeLit)
			if !ok {
				return true // 選項是變數，交給行為測試把關
			}
			for _, el := range lit.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key, ok := kv.Key.(*ast.Ident)
				if !ok || key.Name != "SkipDirNames" {
					continue
				}
				// SkipDirNames 是呼叫端自訂的逃生門，不該被拿來當排除清單用。
				if _, isLit := kv.Value.(*ast.CompositeLit); isLit {
					t.Errorf("%s:%d 又在 Scan 的呼叫端手捏排除清單（SkipDirNames）。"+
						"排除判準只准住在 ingestplan.go——兩張表分居兩處，正是 #104 誤判的成因。",
						f, fset.Position(kv.Pos()).Line)
				}
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatal("一個 Scan 呼叫端都沒掃到——這個測試沒有在守任何東西（是不是檔案改名了？）")
	}
	t.Logf("檢查了 %d 個 Scan 呼叫端", checked)
}

// ───────────────────────────────────────────────────────────────────────────
// 釘子 ②：排除掉的東西必須看得見——而且不能是一個 0
// ───────────────────────────────────────────────────────────────────────────

// 🔴 2026-08-16 實測 leo 的 `pms`（2,127 檔、78% 在依賴目錄底下）：
// 絕大多數被排除，而 `ExcludedByPlan` 回報 **0**——因為它只數「走進去才被逐檔擋下」的檔，
// 整棵剪掉的子樹一個都不算。講一個 0 跟安靜地少收，對使用者是同一件事。
func TestWiring_整棵剪掉的資料夾要講得出是哪些為什麼(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"我的筆記.md":                       "# 我的",
		"package.json":                  `{"name":"x"}`,
		"node_modules/undici/README.md": "# undici",
		"dist/bundle-notes.md":          "# 建置產物",
		"secret-stuff/內部.md":            "# 不想收",
		".gitignore":                    "secret-stuff/\n",
	})

	payload, _ := scanWithPlan(t, root)
	if payload.ExcludedDirCount == 0 {
		t.Fatal("整棵剪掉了東西卻回報 0 個資料夾——使用者無從知道少收了什麼")
	}
	byPath := map[string]string{}
	for _, d := range payload.ExcludedDirs {
		byPath[d.Path] = d.Reason
		t.Logf("跳過 %s — %s", d.Path, d.Reason)
	}
	for _, want := range []string{"node_modules", "dist", "secret-stuff"} {
		if byPath[want] == "" {
			t.Errorf("%s 被跳過了，卻沒有講出理由（實得清單：%v）", want, byPath)
		}
	}
	// 理由必須是人話，不是路徑術語或規則代號。
	if r := byPath["secret-stuff"]; !strings.Contains(r, ".gitignore") {
		t.Errorf("使用者自己宣告的排除，理由要講明是他的 .gitignore 說的，實得：%q", r)
	}
}

// 可見性接線：daemon（使用者真正走的那條路）必須把策略寫進 status.json。
//
// 🔴 這一條就是 2026-08-16 抓到的第四例「東西做好了但不在執行路徑上」：
// #104 第一階段的收工留言宣稱策略「走進 status.json」，實際上整個 repo 裡
// 只有 CLI 的 stderr 讀過它，daemon 拿到 payload 就把兩個欄位丟掉。
func TestWiring_status要帶得出收檔策略(t *testing.T) {
	st := SyncStatus{FolderPlans: map[string]FolderPlanStatus{
		"/tmp/x": {Mode: "docs-only", Reason: "只讀文件", ExcludedDirCount: 3},
	}}
	path := filepath.Join(t.TempDir(), "status.json")
	if err := SaveSyncStatus(path, st); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"folder_plans", "docs-only", "只讀文件", "excluded_dir_count"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("status.json 裡沒有 %q——使用者的畫面就講不出「為什麼只收這些」\n%s", want, raw)
		}
	}
	back, err := LoadSyncStatus(path)
	if err != nil || back.FolderPlans["/tmp/x"].Mode != "docs-only" {
		t.Fatalf("讀回來對不上：%+v（err=%v）", back.FolderPlans, err)
	}
}
