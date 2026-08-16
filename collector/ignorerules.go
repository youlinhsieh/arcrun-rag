// ignorerules.go — 把使用者自己寫的 `.gitignore` 當成「他已經宣告過的排除清單」
// （arcrun-rag#104，2026-08-16 leo 實撞）。
//
// 🔴 為什麼要有這支檔：
//
//	2026-08-16 leo 把 `tech_projects/pms` 掛上同步，九分鐘後停掉。產出的 27 張卡裡
//	16 張是 undici 這個套件的 API 文件、5 張是別人的 MIT 授權條款，他自己的只有 5 張。
//	而 `pms/.gitignore` **第一行就是 `node_modules/`**。
//	⇒ 他早就講過那不是他的東西了，是我們沒讀。
//
// 🔴 但它不能是**唯一**判準（票上的紅線）：不是每個資料夾都是 git repo
//
//	（同日另一個試驗品 `Logseq-plugin` 就沒有 `.git`），一般筆記庫更不會有 `.gitignore`。
//	⇒ 本檔是**三種排除理由裡最有力的那一種**，不是全部。另兩種在 ingestplan.go：
//	  ① 使用者自己宣告過（本檔）
//	  ② 名字本身就不是人話（node_modules 這一類，見 toolOwnedDirNames）
//	  ③ 泛用名（build／dist／out…）＋ 有佐證這是程式專案（見 ambiguousBuildDirNames）
//
// 支援的語法（刻意是 git 的子集，不支援的一律「不排除」——漏判只是多收一個資料夾，
// 誤判是把使用者的東西弄不見，代價不對稱就往安全那邊倒）：
//
//	# 註解、空行
//	name              任何深度的 name（檔或目錄）
//	name/             只有目錄
//	/name             綁在這份 .gitignore 所在的目錄
//	a/b               含 `/` ⇒ 同樣綁在 .gitignore 所在的目錄
//	*.log  ?  [abc]   萬用字元（`*` 不跨 `/`）
//	**/x   x/**       任意深度
//	!name             反向（把上面排除掉的救回來）
//
// 未支援：`\` 跳脫、大小寫不敏感檔案系統的特例、`.git/info/exclude`、全域 gitignore。
package collector

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// IgnoreRules＝一棵樹裡所有 `.gitignore` 的合集。
//
// 巢狀 `.gitignore` 照 git 的規矩：深的那份優先於淺的，同一份裡「最後命中的那條贏」。
type IgnoreRules struct {
	sets []ignoreSet // 依所在目錄深度由淺至深
	// Present＝這棵樹裡到底有沒有 `.gitignore`。
	// 🔴 **只供診斷／測試，不准拿來當任何判準的門檻**（leo 2026-08-16：
	// 他的 KB 筆記庫也有 git，版控相關的訊號分辨不出「筆記庫 vs 軟體專案」）。
	// 沒有 `.gitignore` 的資料夾照樣要被正確處理，有的也不代表它是軟體專案。
	Present bool
}

type ignoreSet struct {
	dir  string // 這份 .gitignore 所在目錄，相對監看根（"" ＝根）
	pats []ignorePattern
}

type ignorePattern struct {
	negate  bool
	dirOnly bool
	// re＝命中「這個路徑本身」；reUnder＝命中「這個路徑底下的東西」。
	//
	// 🔴 為什麼要拆成兩支：`node_modules/` 是 dirOnly，但它排除的**不只是那個目錄**
	// ——底下的每一個檔案也都被排除了（git 的語意）。只用一支正規表示式、
	// 再靠 `dirOnly && !isDir` 一律跳過，會讓
	// `node_modules/undici/docs/api/Pool.md` 逃過去——那正是這一票的頭號實據。
	re      *regexp.Regexp
	reUnder *regexp.Regexp
	raw     string
}

// matches 回答這條樣式命不命中。dirOnly 的樣式只有在「路徑本身是目錄」
// 或「路徑在它底下」時才算。
func (p ignorePattern) matches(rel string, isDir bool) bool {
	if p.reUnder.MatchString(rel) {
		return true // 在被排除的目錄底下——與它自己是不是目錄無關
	}
	if p.dirOnly && !isDir {
		return false
	}
	return p.re.MatchString(rel)
}

// maxIgnoreScanDepth＝找 `.gitignore` 時最多往下鑽幾層。
//
// 為什麼要有上限：找 ignore 檔本身也要走訪，而**走訪整棵樹正是這一票要避免的事**
// （2,127 個檔、78% 在依賴目錄底下）。真實專案的 `.gitignore` 幾乎都在根或第一、二層
// （monorepo 的 `packages/*/`、`workers/*/`）；再深的漏掉，代價只是那一層少一種判準，
// 上面還有 toolOwned／ambiguous 兩道接著擋。
const maxIgnoreScanDepth = 3

// LoadIgnoreRules 從監看根往下收集 `.gitignore`（深度上限 maxIgnoreScanDepth）。
//
// 收集時就套用 toolOwnedDirNames 與隱藏目錄的規則——不然光是為了找 ignore 檔，
// 就得先走進 `node_modules` 一趟，那正是我們要省掉的那件事。
func LoadIgnoreRules(absRoot string) *IgnoreRules {
	r := &IgnoreRules{}
	var walk func(absDir, relDir string, depth int)
	walk = func(absDir, relDir string, depth int) {
		if pats := parseIgnoreFile(filepath.Join(absDir, ".gitignore")); len(pats) > 0 {
			r.sets = append(r.sets, ignoreSet{dir: relDir, pats: pats})
			r.Present = true
		}
		if depth >= maxIgnoreScanDepth {
			return
		}
		entries, err := os.ReadDir(absDir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasPrefix(name, ".") || toolOwnedDirNames[name] {
				continue
			}
			child := name
			if relDir != "" {
				child = relDir + "/" + name
			}
			walk(filepath.Join(absDir, name), child, depth+1)
		}
	}
	walk(absRoot, "", 0)
	return r
}

// Ignores 回答「使用者的 .gitignore 有沒有說不要這一個」。relSlash 相對監看根。
//
// 語意照 git：先看淺的、再看深的；每一層裡最後命中的那條贏（所以 `!` 救得回來）。
func (r *IgnoreRules) Ignores(relSlash string, isDir bool) bool {
	if r == nil || len(r.sets) == 0 {
		return false
	}
	ignored := false
	for _, set := range r.sets {
		rel, ok := relativeTo(relSlash, set.dir)
		if !ok {
			continue // 這份 .gitignore 管不到這條路徑
		}
		for _, p := range set.pats {
			if p.matches(rel, isDir) {
				ignored = !p.negate // 同一份裡「最後命中的那條贏」（所以 `!` 救得回來）
			}
		}
	}
	return ignored
}

// relativeTo 把 relSlash 換算成「相對於 base 目錄」的路徑；不在 base 底下回 false。
func relativeTo(relSlash, base string) (string, bool) {
	if base == "" {
		return relSlash, true
	}
	if relSlash == base {
		return "", false
	}
	if strings.HasPrefix(relSlash, base+"/") {
		return strings.TrimPrefix(relSlash, base+"/"), true
	}
	return "", false
}

func parseIgnoreFile(path string) []ignorePattern {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var out []ignorePattern
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		p, ok := compileIgnorePattern(line)
		if ok {
			out = append(out, p)
		}
	}
	return out
}

// compileIgnorePattern 把一條 gitignore 樣式編成 regexp。
// 看不懂的樣式回 false（＝不排除任何東西），理由見檔頭的「代價不對稱」。
func compileIgnorePattern(line string) (ignorePattern, bool) {
	p := ignorePattern{raw: line}
	if strings.HasPrefix(line, "!") {
		p.negate = true
		line = line[1:]
	}
	if strings.HasPrefix(line, "\\") { // 跳脫未支援
		return p, false
	}
	if strings.HasSuffix(line, "/") {
		p.dirOnly = true
		line = strings.TrimSuffix(line, "/")
	}
	// 含 `/`（非結尾）或以 `/` 開頭 ⇒ 綁在這份 .gitignore 所在目錄；否則任何深度都算。
	anchored := strings.HasPrefix(line, "/") || strings.Contains(line, "/")
	line = strings.TrimPrefix(line, "/")
	if line == "" {
		return p, false
	}

	body := globToRegexp(line)
	head := "^"
	if !anchored {
		head = "^(?:.*/)?" // 不含 `/` 的樣式在任何深度都算（git 語意）
	}
	re, err := regexp.Compile(head + body + "$")
	if err != nil {
		return p, false
	}
	// 「在它底下」的那一支——目錄被排除，底下整棵都跟著排除。
	reUnder, err := regexp.Compile(head + body + "/.*$")
	if err != nil {
		return p, false
	}
	p.re, p.reUnder = re, reUnder
	return p, true
}

// globToRegexp：`**` 跨目錄、`*` 不跨 `/`、`?` 單字元、`[...]` 原樣當字元類。
func globToRegexp(glob string) string {
	var b strings.Builder
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		switch c {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				i++
				if i+1 < len(glob) && glob[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?") // `**/` ＝任意層數（含零層）
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			end := strings.IndexByte(glob[i:], ']')
			if end < 0 {
				b.WriteString(regexp.QuoteMeta(string(c)))
				continue
			}
			b.WriteString(glob[i : i+end+1])
			i += end
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	return b.String()
}
