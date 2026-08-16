// ignorerules_test.go — `.gitignore` 是使用者已經寫好的宣告（arcrun-rag#104）。
//
// 🔴 邊界（leo 2026-08-16 當場立的）：**只用它的內容當線索，不用它的存在當門檻。**
// 沒有 `.gitignore` 的資料夾必須被正確處理；有 `.gitignore` 也不代表那是軟體專案。
package collector

import (
	"os"
	"path/filepath"
	"testing"
)

func loadIgnoreFixture(t *testing.T, files map[string]string) *IgnoreRules {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return LoadIgnoreRules(root)
}

func TestIgnoreRules_基本語法(t *testing.T) {
	// leo 真實的 `pms/.gitignore`，逐字。
	r := loadIgnoreFixture(t, map[string]string{
		".gitignore": "node_modules/\ndist/\n.wrangler/\n*.log\n.dev.vars\n",
	})

	cases := []struct {
		path  string
		isDir bool
		want  bool
		why   string
	}{
		{"node_modules", true, true, "第一行就寫了"},
		{"workers/x/node_modules", true, true, "沒有 / 開頭＝任何深度"},
		{"node_modules/undici/docs/api/Pool.md", false, true, "被排除的目錄底下整棵都算"},
		{"dist", true, true, "第二行"},
		{"dist", false, false, "`dist/` 只管目錄，同名的檔案不算"},
		{"build.log", false, true, "*.log"},
		{"docs/x.log", false, true, "*.log 任何深度"},
		{".dev.vars", false, true, "具名檔"},
		{"docs/PMS_USER_STORIES.md", false, false, "使用者自己的文件"},
		{"README.md", false, false, "使用者自己的文件"},
	}
	for _, c := range cases {
		if got := r.Ignores(c.path, c.isDir); got != c.want {
			t.Errorf("Ignores(%q, dir=%v)=%v，want %v（%s）", c.path, c.isDir, got, c.want, c.why)
		}
	}
}

func TestIgnoreRules_錨定與反向(t *testing.T) {
	r := loadIgnoreFixture(t, map[string]string{
		".gitignore": "/build\ntmp/**\n*.bak\n!keep.bak\ndocs/generated\n",
	})
	cases := []struct {
		path  string
		isDir bool
		want  bool
		why   string
	}{
		{"build", true, true, "/build 綁在根"},
		{"src/build", true, false, "以 / 開頭＝只有根那一個"},
		{"tmp/a/b", true, true, "tmp/** 任意深度"},
		{"x.bak", false, true, "*.bak"},
		{"keep.bak", false, false, "! 把它救回來"},
		{"docs/generated", true, true, "含 / ⇒ 錨定在根"},
		{"other/docs/generated", true, false, "錨定的不該在別處命中"},
	}
	for _, c := range cases {
		if got := r.Ignores(c.path, c.isDir); got != c.want {
			t.Errorf("Ignores(%q, dir=%v)=%v，want %v（%s）", c.path, c.isDir, got, c.want, c.why)
		}
	}
}

// 巢狀 `.gitignore`：深的那一份只管自己底下（monorepo 每個 package 各有一份）。
func TestIgnoreRules_巢狀只管自己底下(t *testing.T) {
	r := loadIgnoreFixture(t, map[string]string{
		".gitignore":             "*.log\n",
		"workers/api/.gitignore": "cache/\n",
	})
	if !r.Ignores("workers/api/cache", true) {
		t.Error("子目錄自己的 .gitignore 沒生效")
	}
	if r.Ignores("cache", true) {
		t.Error("子目錄的規則不該套用到根")
	}
	if !r.Ignores("workers/api/x.log", false) {
		t.Error("根的規則應該往下套用")
	}
}

// 🔴 邊界一：沒有 `.gitignore` 的資料夾必須完全正常（不是門檻）。
func TestIgnoreRules_沒有這個檔也要正常(t *testing.T) {
	r := loadIgnoreFixture(t, map[string]string{"筆記.md": "# 我的"})
	if r.Present {
		t.Error("沒有 .gitignore 卻回報有")
	}
	if r.Ignores("任何東西", true) || r.Ignores("筆記.md", false) {
		t.Error("沒有規則時不該排除任何東西")
	}
	// nil 接收者也要安全——IngestPlan 零值就是 nil。
	var nilRules *IgnoreRules
	if nilRules.Ignores("x", true) {
		t.Error("nil IgnoreRules 不該排除任何東西")
	}
}

// 🔴 邊界二：有 `.gitignore` **不代表**這是軟體專案。
// 一個筆記庫放了 `.gitignore`（很多人拿 git 做版本備份），它的 `build/` 仍是他的東西。
func TestIgnoreRules_有這個檔不代表是軟體專案(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		".gitignore":     ".DS_Store\n", // 只是不想收系統垃圾
		"build/樂高作品集.md": "# 我的模型",
		"日記.md":          "# 日記",
	})
	payload, plan := scanWithPlan(t, root)
	got := eventPaths(payload)
	t.Logf("策略=%s｜送出：%v", plan.Mode, got)
	if len(got) != 2 {
		t.Fatalf("有 .gitignore 就把 `build/` 當成產物殺掉了——那只是他不想收 .DS_Store。實得：%v", got)
	}
}

// 看不懂的樣式一律「不排除」——漏判只是多收一個資料夾，誤判是把使用者的東西弄不見。
func TestIgnoreRules_看不懂的樣式不亂殺(t *testing.T) {
	r := loadIgnoreFixture(t, map[string]string{
		".gitignore": "# 註解\n\n\\escaped\n[unclosed\n",
	})
	if r.Ignores("escaped", false) {
		t.Error("跳脫語法未支援，就不該命中")
	}
}
