// cleanup.go — 斷連時把 daemon 自己寫進使用者資料夾的東西收回來
// （arcrun-rag#138，leo 2026-08-24：「碎型會在每個資料夾安裝隱藏資料夾，人工刪除不容易，
// 所以當它斷連，應該要可以幫它把 Arcrun RAG 建立的資料夾刪掉」）。
//
// 🔴 這是本 repo 唯一一支會**刪使用者資料夾裡的檔**的程式碼。tidy.go 的紅線是
// 「一行 os.Remove 都沒有」——那條紅線在這裡不成立（使用者要的就是刪掉），
// 所以改用另一組更嚴的規矩：
//
//	① **只刪帳面上認得出來的東西。** 不靠「路徑看起來像我們的」「副檔名是 .md」
//	   這類推測——每一筆都要說得出一句**我們自己寫下的證據**（見 CleanupItem.Evidence）。
//	② **一個認不出來的鄰居，就讓整個目錄留下。** `.wiki/` 裡只要有一個檔不在帳本上、
//	   也沒有標記，就從「刪整個目錄」降級成「只刪認得出來的那幾個檔」，目錄本身留著。
//	   ⇒ 誤留一點殘渣是可接受的；誤刪使用者的知識不是。
//	③ **先看清單再動手。** PlanCleanup 只讀不寫，ApplyCleanup 動手前**重算一次**計畫
//	   （不吃呼叫端傳回來的舊清單）——畫面上看到的是快照，刪的當下才是真相。
//
// 認人的三種證據（全部是 daemon 自己寫下去的字，不是猜的）：
//
//	E1 `.arcrun-rag/` 工作區：目錄裡的 `.gitignore` 內容**逐字**等於 workspaceIgnoreBody
//	   （repoguard.go 寫的那份，自己寫著「整個資料夾可以安全刪除」）。
//	E2 `.wiki/` 卡片目錄：目錄裡的 `.gitignore` 內容逐字等於 wikiIgnoreBody
//	   （wikishape.go 寫的，自己寫著「不是你的檔案」），或目錄裡有解析得開的
//	   `manifest.json`（我們的 wiki 帳本）。
//	E3 `system-dev/wiki/cards/` 底下帶 MachineMark（`arcrun-`）前綴的檔
//	   ——machinemark.go 的規約：daemon 在監看根底下產生的每個檔名都帶這個前綴。
//
// 🔴 三個**刻意不刪**的東西（每一個都是實查出來的，不是保守而已）：
//
//	① `.arcrun-rag/legacy-template/`：那是 tidy.go 的**收容處**，裡面裝的是從使用者
//	   資料夾**搬進來的檔**。tidy 自己說得很清楚：「TemplateOwns 是路徑身分判準，
//	   分不出『daemon 鋪的』還是『repo 本來就有的』」⇒ 那些檔的所有權我們判不了。
//	   而 `.arcrun-rag/.gitignore` 上「整個資料夾可以安全刪除」那句話是 #105 寫的，
//	   當時工作區裡還沒有收容處。**不把那句話套到收容處上**（#138 紅線第三條問的正是這題）。
//	② 另一個**還在監看清單裡**的資料夾底下的東西：實務上真的會巢狀
//	   （2026-08-24 現場：`pms` 與 `pms/pms_v1_legacy` 同時在看守）。移除外層時把內層的
//	   工作區刪掉＝把一個還在跑的同步弄壞。
//	③ 任何 symlink：不跟隨、不刪。刪一條指出去的連結會刪到監看根以外的東西。
package collector

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// 產物分類（給畫面分組用，也是 Apply 的處理方式）。
const (
	CleanupKindWorkspace = "workspace"   // `.arcrun-rag/` 工作區（整個目錄）
	CleanupKindWorkFile  = "work-file"   // 工作區裡的單一項目（收容處存在時的降級路徑）
	CleanupKindWikiDir   = "wiki-dir"    // `.wiki/` 卡片目錄（整個目錄）
	CleanupKindWikiFile  = "wiki-file"   // `.wiki/` 裡的單一產物（有陌生鄰居時的降級路徑）
	CleanupKindMarked    = "marked-card" // 帶 arcrun- 標記的卡片（非隱藏的卡片產物區）
)

// CleanupItem＝一筆「打算刪掉」的東西。Evidence 是白話的認人依據，會直接顯示給使用者看
// ——沒有 Evidence 的東西不准進這個清單。
type CleanupItem struct {
	Rel      string `json:"rel"` // 相對監看根，斜線分隔
	IsDir    bool   `json:"is_dir"`
	Kind     string `json:"kind"`
	Evidence string `json:"evidence"`
	Files    int    `json:"files"` // 這一筆底下有幾個檔（目錄才 > 1）
	Bytes    int64  `json:"bytes"`
}

// CleanupKeep＝一筆「認得出來但刻意不刪」或「認不出來所以不敢刪」的東西。
// 這份清單和 Remove 一樣要給使用者看——沉默地留下殘渣，跟沉默地刪掉一樣糟。
type CleanupKeep struct {
	Rel    string `json:"rel"`
	Reason string `json:"reason"`
}

// CleanupPlan＝一次清理的完整帳目。PlanCleanup 只讀不寫，這份東西就是「動手前的清單」。
type CleanupPlan struct {
	Root   string        `json:"root"`
	Remove []CleanupItem `json:"remove"`
	Keep   []CleanupKeep `json:"keep"`
	Files  int           `json:"files"` // Remove 涵蓋的檔案總數
	Bytes  int64         `json:"bytes"`
}

// CleanupFailure＝刪不掉的那一筆（權限、檔案正被開著…）。
type CleanupFailure struct {
	Rel   string `json:"rel"`
	Error string `json:"error"`
}

// CleanupResult＝實際刪掉了什麼。
type CleanupResult struct {
	Removed []string         `json:"removed"`
	Failed  []CleanupFailure `json:"failed"`
	Files   int              `json:"files"`
	Bytes   int64            `json:"bytes"`
}

var cleanupBakRe = regexp.MustCompile(`^(.*)\.bak-\d+$`)

// WorkspaceIgnoreBodyForTest／WikiIgnoreBodyForTest 讓**別的 package 的迴歸網**
// （cmd/arcrun-app）造得出「與 daemon 真正寫下去一字不差」的宣告檔。
//
// 為什麼不讓測試自己抄一份字串：抄的那份會漂。認人的判準是「逐字相等」，
// 判準與樣本一旦不同源，這兩份 .gitignore 改一個字就會有一整層測試靜默失效。
// 名字帶 ForTest 是說給讀 code 的人聽的——**production 路徑不准依賴它們**。
func WorkspaceIgnoreBodyForTest() string { return workspaceIgnoreBody }
func WikiIgnoreBodyForTest() string      { return wikiIgnoreBody }

// PlanCleanup 列出「把 root 從監看清單移除時，可以連帶收掉的 daemon 產物」。
//
// **這支函式不寫任何檔案。** otherRoots＝其他仍在監看清單裡的資料夾（絕對路徑）；
// 落在它們底下的東西一律不碰（見檔頭不刪清單②）。
func PlanCleanup(root string, otherRoots []string) (*CleanupPlan, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	absRoot = filepath.Clean(absRoot)
	if st, serr := os.Lstat(absRoot); serr != nil {
		return nil, serr
	} else if !st.IsDir() {
		return nil, &fs.PathError{Op: "cleanup", Path: absRoot, Err: fs.ErrInvalid}
	}

	// 只留「真的在 absRoot 底下」的其他根——不在底下的本來就走不到，留著只會拖慢比對。
	var others []string
	for _, o := range otherRoots {
		a, oerr := filepath.Abs(o)
		if oerr != nil {
			continue
		}
		a = filepath.Clean(a)
		if a != absRoot && pathWithin(absRoot, a) {
			others = append(others, a)
		}
	}

	p := &cleanupPlanner{
		root:   absRoot,
		others: others,
		cards:  collectWikiCardIndex(absRoot, others),
		plan:   &CleanupPlan{Root: absRoot},
	}
	p.walk(absRoot)
	sort.Slice(p.plan.Remove, func(i, j int) bool { return p.plan.Remove[i].Rel < p.plan.Remove[j].Rel })
	sort.Slice(p.plan.Keep, func(i, j int) bool { return p.plan.Keep[i].Rel < p.plan.Keep[j].Rel })
	return p.plan, nil
}

// ApplyCleanup 真的動手刪。
//
// 🔴 它**重算一次計畫**，不接受呼叫端傳進來的舊清單——使用者看清單、按確定之間可能過了
// 幾秒或幾分鐘，那段時間裡他可能剛好把一個自己的檔存進 `.wiki/`。畫面上那份是快照，
// 刪的當下重算的這份才是判準。回傳的 plan 就是實際執行的那一份（呼叫端要顯示就用它）。
func ApplyCleanup(root string, otherRoots []string) (*CleanupPlan, *CleanupResult, error) {
	plan, err := PlanCleanup(root, otherRoots)
	if err != nil {
		return nil, nil, err
	}
	res := &CleanupResult{}
	// 由深到淺刪：先刪目錄裡的東西，再刪目錄自己（降級路徑會同時出現父目錄底下的多筆）。
	items := append([]CleanupItem(nil), plan.Remove...)
	sort.Slice(items, func(i, j int) bool { return len(items[i].Rel) > len(items[j].Rel) })
	for _, it := range items {
		abs := filepath.Join(plan.Root, filepath.FromSlash(it.Rel))
		// 最後一道機械閘：不管計畫怎麼算的，目標一定要在監看根底下，而且不是 symlink。
		if !pathWithin(plan.Root, abs) {
			res.Failed = append(res.Failed, CleanupFailure{Rel: it.Rel, Error: "路徑不在這個資料夾底下，沒有刪"})
			continue
		}
		st, serr := os.Lstat(abs)
		if serr != nil {
			if os.IsNotExist(serr) {
				continue // 已經不在了（重複按、或上一輪刪過）＝不是失敗
			}
			res.Failed = append(res.Failed, CleanupFailure{Rel: it.Rel, Error: serr.Error()})
			continue
		}
		if st.Mode()&os.ModeSymlink != 0 {
			res.Failed = append(res.Failed, CleanupFailure{Rel: it.Rel, Error: "這是一條捷徑（symlink），沒有刪"})
			continue
		}
		var derr error
		if it.IsDir {
			derr = os.RemoveAll(abs)
		} else {
			derr = os.Remove(abs)
		}
		if derr != nil {
			res.Failed = append(res.Failed, CleanupFailure{Rel: it.Rel, Error: derr.Error()})
			continue
		}
		res.Removed = append(res.Removed, it.Rel)
		res.Files += it.Files
		res.Bytes += it.Bytes
	}
	sort.Strings(res.Removed)
	return plan, res, nil
}

// ── 以下是實作細節 ────────────────────────────────────────────────

type cleanupPlanner struct {
	root   string
	others []string
	cards  map[string]bool // 帳本上每張卡的絕對路徑
	plan   *CleanupPlan
}

func (p *cleanupPlanner) rel(abs string) string {
	r, err := filepath.Rel(p.root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(r)
}

func (p *cleanupPlanner) remove(abs, kind, evidence string, isDir bool) {
	files, bytes := countTree(abs)
	p.plan.Remove = append(p.plan.Remove, CleanupItem{
		Rel: p.rel(abs), IsDir: isDir, Kind: kind, Evidence: evidence, Files: files, Bytes: bytes,
	})
	p.plan.Files += files
	p.plan.Bytes += bytes
}

func (p *cleanupPlanner) keep(abs, reason string) {
	p.plan.Keep = append(p.plan.Keep, CleanupKeep{Rel: p.rel(abs), Reason: reason})
}

// walk 走整棵樹。刻意**不用 filepath.WalkDir**：我們要在「進不進去某個目錄」這件事上
// 完全自己說了算（其他隱藏目錄整棵跳過、別的監看根整棵跳過、symlink 不跟隨）。
func (p *cleanupPlanner) walk(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		abs := filepath.Join(dir, e.Name())
		if e.Type()&os.ModeSymlink != 0 {
			continue // 捷徑一律不碰（可能指到監看根以外）
		}
		if !e.IsDir() {
			continue // 目錄以外的檔，只有在下面那幾個已認定的目錄裡才會被處理
		}
		if p.underOtherRoot(abs) {
			p.keep(abs, "這個資料夾也還在同步清單裡，它底下的東西留給它自己管")
			continue
		}
		switch e.Name() {
		case workspaceRelDir:
			p.planWorkspace(abs)
			continue
		case wikiRelDir:
			p.planWikiDir(abs)
			continue
		}
		if strings.HasPrefix(e.Name(), ".") {
			continue // 其他隱藏目錄整棵跳過——daemon 的 Scan 也不進去，那裡不會有我們的東西
		}
		if p.rel(abs) == cardsRelDir {
			p.planMarkedCards(abs)
			continue
		}
		p.walk(abs)
	}
}

func (p *cleanupPlanner) underOtherRoot(abs string) bool {
	for _, o := range p.others {
		if abs == o || pathWithin(o, abs) {
			return true
		}
	}
	return false
}

// planWorkspace 處理 `.arcrun-rag/`。
func (p *cleanupPlanner) planWorkspace(abs string) {
	if !fileHasExactBody(filepath.Join(abs, ".gitignore"), workspaceIgnoreBody) {
		p.keep(abs, "這個 .arcrun-rag 目錄裡沒有我們寫的 .gitignore 宣告，認不出是不是我們建的，所以不動它")
		return
	}
	const ev = "目錄裡的 .gitignore 逐字等於我們寫的那份（自己寫著「整個資料夾可以安全刪除」）"

	quarantine := filepath.Join(abs, "legacy-template")
	if st, err := os.Lstat(quarantine); err == nil && st.IsDir() && !isEmptyDir(quarantine) {
		// 收容處裡是「從你的資料夾搬進來的檔」⇒ 整個目錄不能一次刪，改成逐項刪、留下收容處。
		p.keep(quarantine, "這裡面是以前從你的資料夾搬進來的檔案（不是我們產生的），所有權判不了，一律留著讓你自己處理")
		entries, err := os.ReadDir(abs)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.Name() == "legacy-template" {
				continue
			}
			child := filepath.Join(abs, e.Name())
			if e.Type()&os.ModeSymlink != 0 {
				p.keep(child, "這是一條捷徑（symlink），不碰")
				continue
			}
			p.remove(child, CleanupKindWorkFile, ev, e.IsDir())
		}
		return
	}
	p.remove(abs, CleanupKindWorkspace, ev, true)
}

// planWikiDir 處理一個 `.wiki/`。
//
// 兩步：① 這個目錄是不是我們的（要有我們寫下的宣告）② 裡面**每一個**東西是不是都認得。
// 第二步是這支函式的重點——認得全部才刪整個目錄，有一個認不得就降級成逐檔刪。
func (p *cleanupPlanner) planWikiDir(abs string) {
	evidence := ""
	if fileHasExactBody(filepath.Join(abs, ".gitignore"), wikiIgnoreBody) {
		evidence = "目錄裡的 .gitignore 逐字等於我們寫的那份（自己寫著「這個資料夾是 Arcrun RAG 產生的 wiki，不是你的檔案」）"
	} else if isOurWikiManifest(filepath.Join(abs, "manifest.json")) {
		evidence = "目錄裡有我們寫的 manifest.json（wiki 帳本，記著每張卡對應哪份原稿）"
	} else {
		p.keep(abs, "這個 .wiki 目錄裡既沒有我們寫的 .gitignore、也沒有我們的 manifest.json，認不出是不是我們建的，所以不動它")
		return
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		p.keep(abs, "讀不到這個目錄的內容（"+err.Error()+"），所以不動它")
		return
	}
	type known struct {
		name  string
		isDir bool
	}
	var ours []known
	var strangers []string
	accounted := map[string]bool{}
	for _, e := range entries {
		if p.wikiEntryIsOurs(abs, e) {
			accounted[e.Name()] = true
		}
	}
	for _, e := range entries {
		if accounted[e.Name()] {
			ours = append(ours, known{e.Name(), e.IsDir()})
			continue
		}
		// `.bak-<unixnano>` 是 safeWriteCard 的備份：本體認得，它就認得。
		if m := cleanupBakRe.FindStringSubmatch(e.Name()); m != nil && accounted[m[1]] {
			ours = append(ours, known{e.Name(), e.IsDir()})
			continue
		}
		strangers = append(strangers, e.Name())
	}

	if len(strangers) == 0 {
		p.remove(abs, CleanupKindWikiDir, evidence, true)
		return
	}
	// 降級：只刪認得出來的那幾個，目錄與陌生鄰居原封不動。
	for _, k := range ours {
		p.remove(filepath.Join(abs, k.name), CleanupKindWikiFile, evidence, k.isDir)
	}
	for _, s := range strangers {
		p.keep(filepath.Join(abs, s), "這個檔不在我們的帳本上、也沒有 arcrun- 標記——可能是你自己放進來的，留著")
	}
}

// wikiEntryIsOurs 回答「`.wiki/` 裡的這一項是不是我們寫的」。四條路，全部要拿得出證據。
func (p *cleanupPlanner) wikiEntryIsOurs(dir string, e os.DirEntry) bool {
	if e.Type()&os.ModeSymlink != 0 {
		return false // 捷徑一律不算我們的
	}
	abs := filepath.Join(dir, e.Name())
	if e.IsDir() {
		return false // 我們從來不在 .wiki/ 底下開子目錄
	}
	switch {
	case e.Name() == ".gitignore":
		return fileHasExactBody(abs, wikiIgnoreBody)
	case e.Name() == "manifest.json":
		return isOurWikiManifest(abs)
	case e.Name() == "00-INDEX.md":
		return fileHasPrefix(abs, "# 00-INDEX")
	case p.cards[abs]:
		return true // 帳本上有這張卡
	case IsMarked(e.Name()):
		return true // machinemark.go 的規約前綴
	}
	return false
}

// planMarkedCards 處理 `system-dev/wiki/cards/`——那是**看得見**的卡片產物區
// （監看根不在筆記庫也不在版控時的落點）。這裡不刪目錄，只刪帶標記的檔：
// 那個目錄是 system-dev-template 的規約路徑，使用者自己的卡也住在那裡（#105 的教訓）。
func (p *cleanupPlanner) planMarkedCards(abs string) {
	_ = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if IsMarked(d.Name()) {
			p.remove(path, CleanupKindMarked, "檔名帶 arcrun- 標記——daemon 產生的每個檔都帶這個前綴（machinemark.go 規約）", false)
		}
		return nil
	})
}

// collectWikiCardIndex 把樹裡每一份 `.wiki/manifest.json` 讀出來，攤成「這些絕對路徑是我們的卡」。
//
// 為什麼要掃整棵樹而不是只讀監看根那一份：實務上樹裡會有**別的監看根**留下的帳本
// （`pms/pms_v1_legacy/.wiki/manifest.json`）。帳本裡的卡路徑是相對**它自己的根**
// （＝那個 `.wiki` 的上層目錄），所以每份帳本各自解析。
func collectWikiCardIndex(absRoot string, others []string) map[string]bool {
	out := map[string]bool{}
	var walk func(dir string)
	walk = func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
				continue
			}
			abs := filepath.Join(dir, e.Name())
			if e.Name() == wikiRelDir {
				addManifestCards(out, abs)
				continue
			}
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			walk(abs)
		}
	}
	walk(absRoot)
	// 別的監看根底下那份帳本也要讀——它記的卡可能落在**我們這一側**（節點在共同祖先下）。
	// 讀帳本是純讀取，不代表會刪那邊的東西（刪不刪由 underOtherRoot 決定）。
	for _, o := range others {
		addManifestCards(out, filepath.Join(o, wikiRelDir))
	}
	return out
}

func addManifestCards(out map[string]bool, wikiDir string) {
	path := filepath.Join(wikiDir, "manifest.json")
	m, ok := readOurWikiManifest(path)
	if !ok {
		return
	}
	owner := filepath.Dir(wikiDir) // 帳本裡的路徑相對這一層
	for _, d := range m.Docs {
		for _, c := range d.Cards {
			c = strings.TrimSpace(c)
			if c == "" || strings.Contains(c, "..") || filepath.IsAbs(filepath.FromSlash(c)) {
				continue // 帳本被改壞時不讓它把我們指到樹外面
			}
			out[filepath.Join(owner, filepath.FromSlash(c))] = true
		}
	}
}

func readOurWikiManifest(path string) (*wikiManifest, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var m wikiManifest
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	// 認的是形狀，不是「檔名叫 manifest.json」：要有版本號，而且每筆 doc 都要有我們的鍵。
	if m.Version <= 0 {
		return nil, false
	}
	for _, d := range m.Docs {
		if d.Node == "" || d.DocID == "" {
			return nil, false
		}
	}
	return &m, true
}

func isOurWikiManifest(path string) bool {
	_, ok := readOurWikiManifest(path)
	return ok
}

// fileHasExactBody：檔案內容**逐字**等於 want。逐字比對是刻意的——「開頭像」不夠，
// 有人可能在我們的宣告後面接自己的規則，那份 .gitignore 就不只是我們的了。
func fileHasExactBody(path, want string) bool {
	data, err := os.ReadFile(path)
	return err == nil && string(data) == want
}

func fileHasPrefix(path, want string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, len(want))
	n, _ := f.Read(buf)
	return n == len(want) && string(buf) == want
}

// pathWithin 回答 child 是不是 parent 底下（不含 parent 自己）。純字串比對，
// 呼叫端傳進來的都已經是 Abs+Clean 過的路徑。
func pathWithin(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func isEmptyDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) == 0
}

// countTree 算一筆刪除目標涵蓋幾個檔、多少位元組（給清單顯示「會刪掉 N 個檔」）。
func countTree(abs string) (files int, bytes int64) {
	st, err := os.Lstat(abs)
	if err != nil {
		return 0, 0
	}
	if !st.IsDir() {
		return 1, st.Size()
	}
	_ = filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, ierr := d.Info(); ierr == nil {
			files++
			bytes += info.Size()
		}
		return nil
	})
	return files, bytes
}
