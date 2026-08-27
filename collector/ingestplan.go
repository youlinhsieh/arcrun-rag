// ingestplan.go — 掃描之前先問一句「這個資料夾是什麼」，再決定要讀哪些檔
// （arcrun-rag#104，2026-08-14 leo 規格）。
//
// 🔴 leo 的原話就是這支檔的規格，順序不能顛倒：
//
//	「這些庫都早就萃好了，所以它要**辨識這個庫已經有 wiki，那就直接 ingest 了**」
//	「它應該**第一步查看 wiki 裡有沒有內容**，再去辨識哪些檔案是需要讀的，
//	 **只有文件要讀，程式碼不用讀**」
//
// 🔴 為什麼非做不可（實測，非推測）：leo 把 5 個資料夾接上去，App 顯示
// 12,022 份檔案、11,183 卡在佇列。光 `InkStoneCo` 一個就 8,339 份——
// **而那個 repo 真正整理好的知識庫只有 `system-dev/wiki/` 的幾十張，差兩個數量級。**
// 更糟的是掃到 45 個名為 `wiki` 的目錄（8 份 `.claude/worktrees`、5 份出貨用 worktree、
// 8 份 `templatefs` 範本、還有 `.next`／`.vercel` 建置產物）⇒ **同一份被收十幾次**，
// 與 2026-08-13 查明的「48 萬筆廢資料」是同款成因（重複放大）。
//
// ⇒ 本檔回答一個問題：**這個監看根該收哪些檔**。三種答案：
//
//	IngestAll        一般資料夾／筆記庫——收全部（行為與先前完全一致，零改變）
//	IngestCuratedWiki 軟體專案，而且**已經有整理好的 wiki** ⇒ 只收那一份
//	IngestDocsOnly   軟體專案，但沒有現成 wiki ⇒ 只收文件區，程式碼一律不讀
//
// 🔴 「是不是軟體專案」**看資料夾裡實際裝了什麼**，不看有沒有 `.git`
// （2026-08-16 第二層修正，判準在 foldershape.go；為什麼見 PlanIngest 的說明）。
//
// 🔴 「不要用副檔名白名單當唯一判準」（票上的紅線）：本檔的主判準是**路徑身分**
// （這個目錄在這個 repo 裡扮演什麼角色），副檔名只是最後一道。`.md` 在 repo 裡
// 大多不是知識——是 README、是 CHANGELOG、是 template 範本、是建置產物。
//
// 🔴 「排除規則要看得見」（票上的紅線，同 #121）：本檔算出來的每一條理由都會經由
// TriggerPayload.Plan 走進 status.json ⇒ 使用者看得到「有 8,000 個檔沒被收，因為它們是程式碼」，
// 而不是安靜地少收。
package collector

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// IngestMode＝這個監看根的收檔策略。
type IngestMode string

const (
	IngestAll         IngestMode = "all"          // 收全部（一般資料夾／筆記庫）
	IngestCuratedWiki IngestMode = "curated-wiki" // 只收現成的整理好的 wiki
	IngestDocsOnly    IngestMode = "docs-only"    // 只收文件區
)

// IngestPlan＝掃描前算出來的策略，連同「講給使用者聽的理由」。
//
// 🔴 Reason 不是 debug 訊息，是**產品文案**：使用者看到「12,022 個檔只送了 32 個」
// 的當下，唯一能讓他不慌的東西就是這句話。用他的話寫，不要寫路徑術語。
type IngestPlan struct {
	Mode IngestMode `json:"mode"`
	// Shape＝「這個資料夾裡實際裝了什麼」的實測結果，也就是模式是怎麼決定的
	// （foldershape.go）。**取代了原本的 RepoRoot（`.git` 的位置）**——
	// leo 2026-08-16 推翻版控判準，判準改成內容，那麼「為什麼這樣判」的證據
	// 也該是內容（幾個專案檔、幾個原始碼檔），不是一個路徑。
	Shape FolderShape `json:"shape"`
	// WikiRelDir＝現成 wiki 的相對路徑（僅 IngestCuratedWiki）。
	WikiRelDir string `json:"wiki_rel_dir,omitempty"`
	// DocRelDirs＝要收的文件目錄（僅 IngestDocsOnly；根層 .md 另由 keepsRootDoc 放行）。
	// 來源有兩種，合併後去重排序（見 mergeDocDirs）：固定三名字（existingDocDirs）
	// ＋ Phase 0 內容判準自動找到的非標準命名文件目錄（scanAuxDirs 的 autoDocDirs，
	// `arcrun-rag#136`）。
	DocRelDirs []string `json:"doc_rel_dirs,omitempty"`
	// Reason＝一句話講給使用者聽的「為什麼只收這些」。
	Reason string `json:"reason"`
	// OtherWikiDirs＝這個 repo 底下**其他**子專案自己的 wiki（相對路徑）。
	// 刻意不收（見 wantsPath 的說明），但一定要列出來——不然使用者只會覺得東西不見了。
	OtherWikiDirs []string `json:"other_wiki_dirs,omitempty"`

	// ── 以下不外露成 JSON：判準的材料，不是給使用者看的結論 ──────────────────
	// ignore＝使用者自己寫的 `.gitignore` 的**內容**（見 ignorerules.go）。
	// 🔴 只用內容，不把「有沒有這個檔」當門檻——leo 2026-08-16：他的 KB 筆記庫也有 git，
	//    版控訊號分辨不出「筆記庫 vs 軟體專案」。沒有 `.gitignore` 的資料夾同樣要被正確處理。
	ignore *IgnoreRules
}

// ExcludedDir＝走訪時整棵跳過的一個目錄，連同「講給使用者聽的理由」。
//
// 🔴 票上的紅線是「排除規則要看得見」，而原本的做法只數了**檔案層**被擋掉的數量
// （ExcludedByPlan）；整棵剪掉的子樹一個都沒數 ⇒ 拿 leo 真實的 `pms` 跑一輪，
// 2,127 個檔裡排除了絕大多數，畫面上的數字卻是 **0**。
// 「安靜地少收」與「講了一個 0」對使用者是同一件事。
//
// 為什麼記目錄而不是記檔案數：整棵剪掉的重點就是**不走進去**，要數就得走一趟，
// 那正是這一票要省掉的成本。而使用者真正要知道的本來就是
// 「哪幾個資料夾沒收、為什麼」，不是「少收了幾千個檔」。
type ExcludedDir struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// curatedWikiCandidates＝「整理好的知識庫」慣例位置，依優先序。
// `system-dev/wiki` 是 system-dev-template 的規約（leo 全部的 repo 都是這個），
// 其餘兩個是一般開源專案的慣例。
var curatedWikiCandidates = []string{"system-dev/wiki", "docs/wiki", "wiki"}

// docDirCandidates＝沒有現成 wiki 時，「文件住在哪」的慣例位置。
var docDirCandidates = []string{"docs", "doc", "documentation"}

// ─────────────────────────────────────────────────────────────────────────────
// 排除一個目錄的三種理由。**順序就是強度**，理由不同、要求的佐證也不同。
//
// 🔴 2026-08-16 修正（本檔原本只有一張大表 noiseDirNames，任何模式一律照殺）：
// 那張表把「沒有人會這樣命名」與「這是普通英文字」混在一起，於是同時犯了兩個方向的錯——
//
//	實測：一個一般筆記庫（無 `.git`）放 8 個 .md，其中 7 個分別住在
//	`build/`、`專案/dist/`、`out/`、`target/`、`coverage/`、`bin/`、`fixtures/`，
//	**只送出 1 個，而且 ExcludedByPlan 回報 0**——安靜地弄丟使用者七份筆記。
//	（`build` 可以是樂高作品集，`out` 可以是外出旅遊，`vendor` 可以是廠商。）
//
// ⇒ 判準要問的不是「這個名字像不像雜訊」，是「**這東西是誰放的**」。
// ─────────────────────────────────────────────────────────────────────────────

// toolOwnedDirNames＝名字本身就不是人話的目錄——沒有人會把自己的筆記
// 放進一個叫 `node_modules` 或 `__pycache__` 的資料夾。
// **任何模式、任何脈絡下都跳過，不需要佐證。**
var toolOwnedDirNames = map[string]bool{
	// 依賴（別人的原始碼，不是使用者的）
	"node_modules": true, "bower_components": true, "site-packages": true,
	"venv": true, "virtualenv": true, "__pycache__": true,
	"Pods": true, "Carthage": true,
	// 建置產物／快取（從別的檔生出來的，收了就是同一份內容收兩次）
	// #104 實據：`.next`／`.vercel`。這些以 `.` 開頭的其實已被 Scan 的隱藏目錄規則擋下，
	// 列在這裡是為了讓「為什麼跳過」講得出理由，也讓 LoadIgnoreRules 少走幾趟。
	".next": true, ".nuxt": true, ".vercel": true, ".output": true, ".turbo": true,
	".parcel-cache": true, ".pytest_cache": true, ".gradle": true,
	// 範本／樣板：我們自己要鋪給別人的檔，收自己鋪的東西最荒謬
	// （#104 實據：8 份 `collector/templatefs/system-dev/wiki`）
	"templatefs": true, "template-fs": true,
	// 給程式吃的樣本，不是知識
	"__fixtures__": true, "__snapshots__": true,
}

// ambiguousBuildDirNames＝**旁邊擺著專案檔時**是建置產物／依賴，但在別的脈絡下
// 完全可能是使用者真正的內容的目錄名。
//
// 🔴 只有 looksGenerated 為真時才生效。
// 一般筆記庫裡的 `build/`（樂高作品集）、`out/`（外出）、`vendor/`（廠商）一律照收。
var ambiguousBuildDirNames = map[string]bool{
	"dist": true, "build": true, "out": true, "target": true,
	"bin": true, "obj": true, "coverage": true,
	"vendor": true, "skeleton": true, "testdata": true, "fixtures": true,
}

// toolOwnedFileNames＝機器產生的鎖定檔。與 toolOwnedDirNames 同一條理由
// （名字本身就不是人話），只是它們是檔不是目錄。
//
// 🔴 為什麼要另外列：`.yaml`／`.yml` 在 2026-08-15 被加進 allowedExt（InkStoneCo#44 ④，
// 因為 `.feature`／`.yaml` 常常真的是知識文件）。副作用是 **`pnpm-lock.yaml` 變成了
// 「知識」**——實測 pms 那棵樹時它真的被送出去了。鎖定檔是解析器的輸出，
// 幾千行雜湊值，萃出來的卡只會跟使用者真正的筆記競爭排序（同授權條款那個病）。
var toolOwnedFileNames = map[string]bool{
	"pnpm-lock.yaml": true, "package-lock.json": true, "yarn.lock": true,
	"go.sum": true, "Cargo.lock": true, "composer.lock": true,
	"Gemfile.lock": true, "poetry.lock": true, "pnpm-workspace.yaml": true,
}

// 🔴 這裡以前有第四張表：`templateOwnedDirNames = {"system-dev": true}`
// ——「目錄名等於 system-dev ⇒ 任何深度、所有模式，整棵剪掉」。
// **inkstone/Arcrun#180（leo 2026-08-28）把它拿掉了，但不是放行，是換成分辨。**
//
// leo 的原話：「**cards 在 system-dev 下，wiki 就在裡面，所以不允許跳過它**，
// 而且**所有的 system-dev 都可以展開，因為就算沒有可萃的它也有下層**。」
//
// 實據（`~/Desktop/youlinhsieh-test1`）：
//
//	system-dev/wiki/        ← 6 個範本空殼（Jul 28 同一秒鋪下來的）
//	system-dev/wiki/cards/  ← 9 張真的卡（火星座標／Leo-Hsieh-填答／小果被AFTEE詐貸…）
//
// 一張名字表沒有辦法分辨這兩層——它只看得到「這個目錄叫 system-dev」，
// 於是把空殼和真內容一起丟掉，而且**連底下有哪些子資料夾都沒生出來**
// （地端 find 有 13 個目錄，雲端的樹只有 3 個節點）。
//
// 換掉的是問題本身：
//
//	舊：這個目錄叫什麼名字？                      ⇒ 整棵剪掉
//	新：這一個檔，和安裝器鋪下去的原版一不一樣？   ⇒ 逐檔決定（templateuntouched.go）
//
// 空殼與原版逐字相同 ⇒ 照舊不收（紅線①：不准變成放行）；
// 使用者寫過、或安裝器根本沒鋪過的檔（那 9 張卡）⇒ 收。
// 而目錄一律照走 ⇒ 樹長得出來（紅線②：展開 ≠ 收檔）。

// projectManifestFiles＝「有人在這一層跑建置工具」的佐證檔。
//
// 🔴 為什麼**不是**看 `.git`（leo 2026-08-16 當場推翻）：
//
//	「**你不需要判斷有沒有 git，我的 KB 筆記庫也有 git，
//	  是否用 github/gitea 追蹤完全沒意義。**」
//
// ⇒ 版控是「這個人有沒有在做版本備份」，與「這個資料夾是不是軟體專案」無關。
// 同理 `.gitignore` 的**存在**也不是門檻（它的**內容**仍是有用的線索，見 ignorerules.go）。
// ⇒ 判準只准建在「**這個目錄本身／旁邊是什麼**」上——這樣筆記庫與軟體專案一視同仁。
var projectManifestFiles = []string{
	"package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt",
	"pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json",
	"CMakeLists.txt", "Makefile", "pnpm-workspace.yaml", "tsconfig.json",
}

// looksGenerated 回答「這個叫 build／dist／out… 的目錄，真的是工具生出來的嗎」。
//
// 判準是**目錄局部的**：它的**上一層**有沒有擺著專案檔（package.json、go.mod…）。
// 建置產物一定跟產生它的專案檔同一層——`pms/workers/x/package.json` 旁邊的
// `pms/workers/x/dist` 是產物；筆記庫 `專案/build`（樂高作品集）旁邊什麼都沒有。
//
// 為什麼用「上一層」而不是「整棵樹有沒有專案檔」：monorepo 底下同時有程式與筆記，
// 用整棵樹當旗標會把筆記那一半也一起殺掉。局部判斷才不會誤傷。
func looksGenerated(absDir string) bool {
	parent := filepath.Dir(absDir)
	for _, n := range projectManifestFiles {
		if _, err := os.Stat(filepath.Join(parent, n)); err == nil {
			return true
		}
	}
	return false
}

// PlanIngest 決定某個監看根的收檔策略。**這支是 #104 的入口，Scan 在走訪前呼叫一次。**
//
// 判斷順序刻意照 leo 的原話：先問「是不是專案」，再問「有沒有現成 wiki」，最後才退到文件區。
//
// 🔴 「是不是專案」怎麼判：**看這個資料夾裡實際裝了什麼**（foldershape.go），不看版控。
// leo 2026-08-16 當場推翻了原本的 `.git` 判準：
//
//	「**你不需要判斷有沒有 git，我的 KB 筆記庫也有 git，
//	  是否用 github/gitea 追蹤完全沒意義。**」
//
// 舊判準是一顆定時炸彈：`~/Documents/KB`（leo 的真知識庫）今天沒有 `.git` ⇒ all
// ⇒ 5,915 份文件全收；而它**真的有 `system-dev/wiki`**（他在那裡也裝過 template）
// ⇒ 只要有人在那跑一次 `git init`，就翻成 curated-wiki、靜默塌成 14 張，
// 而畫面上不會有任何提示。**引信早就接好了，只差一個很自然的動作。**
// 換成內容判準之後，`git init` 跑幾次都不會改變答案
// （TestPlanIngest_同一棵樹有沒有版控收到的必須一模一樣 釘死這件事）。
//
// ⚠️ **只有「用哪種收法」這個判斷改掉了。** `repoguard.go` 的另一個用途
// （#105「版控中的資料夾一個檔都不自動改名搬移」，見 tidy.go）**沒有動、也不該動**
// ——那一個問的真的是版控，而且問對了。
func PlanIngest(absRoot string) IngestPlan {
	shape := InspectFolder(absRoot)
	// 使用者自己寫的排除宣告——只讀它的**內容**當線索，不拿它的存在當門檻。
	ignore := LoadIgnoreRules(absRoot)

	if !shape.IsSoftwareProject() {
		return IngestPlan{
			Mode:  IngestAll,
			Shape: shape,
			Reason: "這是一般資料夾或筆記庫（裡面沒有成套的程式碼），" +
				"裡面的文件我全部都會讀（別人的套件與建置產物除外）。",
			ignore: ignore,
		}
	}

	evidence := shape.Evidence()
	aux := scanAuxDirs(absRoot)
	if wiki := findCuratedWiki(absRoot); wiki != "" {
		return IngestPlan{
			Mode:       IngestCuratedWiki,
			Shape:      shape,
			WikiRelDir: wiki,
			Reason: "這是一個開發專案（" + evidence + "），而且你已經整理好一份知識庫（" + wiki + "）——" +
				"我直接讀那一份就好，不再把整個專案的原始碼與零散檔案重萃一次。",
			OtherWikiDirs: aux.otherWikiDirs,
			ignore:        ignore,
		}
	}

	docs := mergeDocDirs(existingDocDirs(absRoot), aux.autoDocDirs)
	reason := "這是一個開發專案（" + evidence + "），我只讀文件、不讀程式碼。"
	if len(docs) > 0 {
		reason = "這是一個開發專案（" + evidence + "），我只讀文件（" +
			strings.Join(docs, "、") + "）與根目錄的說明檔，不讀程式碼。"
	}
	return IngestPlan{
		Mode:          IngestDocsOnly,
		Shape:         shape,
		DocRelDirs:    docs,
		Reason:        reason,
		OtherWikiDirs: aux.otherWikiDirs,
		ignore:        ignore,
	}
}

// mergeDocDirs 合併「固定三名字」與「內容判準自動找到的」兩份文件目錄清單，去重排序。
// 兩份清單本來就可能重疊（例如根層真的叫 `docs` 又剛好零程式碼）——去重才不會讓
// Reason 文案讀起來像「docs、docs」。
func mergeDocDirs(fixed, auto []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, d := range fixed {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	for _, d := range auto {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out
}

// findCuratedWiki 回傳第一個「存在且真的有內容」的現成 wiki 目錄（相對路徑），沒有回空字串。
//
// 「有內容」＝底下至少有一個 `.md`。空目錄不算——不然一個剛跑完 template 安裝、
// wiki 還沒寫的 repo 會被判成 curated-wiki，結果一個檔都不收（那比收太多更糟：
// 使用者會以為系統壞了）。
func findCuratedWiki(absRoot string) string {
	for _, rel := range curatedWikiCandidates {
		dir := filepath.Join(absRoot, filepath.FromSlash(rel))
		if !isDir(dir) {
			continue
		}
		if dirHasMarkdown(dir) {
			return rel
		}
	}
	return ""
}

// dirHasMarkdown 淺層回答「這個目錄樹裡有沒有 .md」，找到一個就停（不走完整棵）。
func dirHasMarkdown(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || found {
			return nil
		}
		if d.IsDir() {
			if p != dir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ".md") && !strings.HasPrefix(d.Name(), ".") {
			found = true
		}
		return nil
	})
	return found
}

func existingDocDirs(absRoot string) []string {
	var out []string
	for _, rel := range docDirCandidates {
		if isDir(filepath.Join(absRoot, filepath.FromSlash(rel))) {
			out = append(out, rel)
		}
	}
	return out
}

// auxDirScan＝一次全樹走訪同時算出來的兩種結果（合併走訪，見 scanAuxDirs）。
type auxDirScan struct {
	otherWikiDirs []string // 子專案自己的 wiki（找到但刻意不收，只講出來）
	autoDocDirs   []string // Phase 0：內容判準找到的「非標準命名文件目錄」（要收）
}

// scanAuxDirs 走訪一次監看根，同時算出「其他子專案的 wiki 在哪」與
// 「Phase 0：非標準命名但整棵零程式碼的文件目錄」（`inkstone/arcrun-rag#136`
// leo 2026-08-24 第三次追加，優先度高於樹狀 UI）。
//
// 🔴 兩者原本是兩支各自獨立的函式（otherWikiDirs／新的內容判準），這裡合併成一次
// 走訪——理由是研究文件（`docs-only-skip-visibility-override-research.md` §2.5）
// 明講的經濟性：兩者都要「走一次監看根、套用同一組排除規則、在沒被排除的節點上
// 做判斷」，差別只在判斷內容。合併之後每輪同步只走一次樹，不是兩次。
//
// 🔴 合併還解決了一個正確性問題（不是效能問題）：如果分開各自跑一次 WalkDir，
// 一個子專案自己的 `xxx/wiki/` 會被 otherWikiDirs 判定「找到但刻意不收」，
// 但新的內容判準若獨立走訪，會用「零程式碼＋有文件」的邏輯把同一個 `wiki` 目錄
// **又收了一次**，直接推翻 otherWikiDirs 那條「這是別人的知識，不混進來」的
// 既有設計（該函式原本的說明就在解釋為什麼刻意不收）。同一次走訪、同一個節點只判
// 一次，兩件事天生不會互相打架。
//
// 🔴 判準只在**通過既有排除規則、沒被任何一條攔下**的節點上跑（隱藏目錄、
// `toolOwnedDirNames`、`ambiguousBuildDirNames`+`looksGenerated`、linked worktree）
// ——與 `SkipsDirWhy` 的優先序一致，所以 `node_modules` 底下的任何內容
// **根本沒有機會被走到**，不會重新引入 `#104` 的套件洩漏洞。
func scanAuxDirs(absRoot string) auxDirScan {
	seenWiki := map[string]bool{}
	for _, rel := range curatedWikiCandidates {
		seenWiki[rel] = true
	}
	var result auxDirScan
	_ = filepath.WalkDir(absRoot, func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() || p == absRoot {
			return nil
		}
		name := d.Name()
		// 與 SkipsDirWhy 的 ②③ 同一組判準（泛用名同樣要旁邊有專案檔才算）。
		if strings.HasPrefix(name, ".") || toolOwnedDirNames[name] ||
			(ambiguousBuildDirNames[name] && looksGenerated(p)) {
			return filepath.SkipDir
		}
		if IsLinkedWorktree(p) {
			return filepath.SkipDir // 同一個 repo 的第二份簽出，內容重複
		}
		rel, rerr := filepath.Rel(absRoot, p)
		if rerr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)

		// ① 別人的 wiki——找到就講出來，但不收、不繼續往下走訪（其餘同舊行為）。
		if name == "wiki" && !seenWiki[relSlash] && dirHasMarkdown(p) {
			result.otherWikiDirs = append(result.otherWikiDirs, relSlash)
			return filepath.SkipDir
		}

		// ② Phase 0：這個目錄「自己直接放的檔案」零程式碼、且至少一個文件類副檔名
		//    ⇒ 即使名字不叫 docs，也當文件目錄收。
		//
		//    🔴 只看「這個目錄自己直接放的檔案」，不遞迴檢查整棵子樹——
		//    研究文件原本建議整棵子樹零程式碼才算，但真實案例
		//    （`pms_v1_legacy` 巢狀 `pms-backup/pms_db_backup.sql`）證明那樣會讓
		//    `pms_v1_legacy` 自己直接放的 `PMS_USER_STORIES.md`／`PMS_GAP_ANALYSIS.md`
		//    因為巢狀兩層深的一個 .sql 備份檔而整批繼續被跳過——治標的判準沒解決
		//    票上真正的案例。改成逐層各自判斷之後，`pms_v1_legacy` 用自己的直接內容
		//    合格，`pms-backup`（自己直接放著 .sql）不合格但不影響外層，而巢狀更深的
		//    `pms-backup/.wiki`（自己直接內容零程式碼＋有 .md）又重新合格——
		//    這與 Scan／畫面本來就「每個節點只算自己直接放的檔案」（`total_files` 等
		//    欄位的既有語意，見 `collector/foldertree.go`）一致，不是另立一套算法。
		//
		//    合格就整棵收（`SkipsDirWhy`／`KeepsFile` 的 `onPathTo` 前綴比對本來就會
		//    涵蓋子孫），不必再往下走訪找子孫裡還有沒有另一個合格點。
		//    不合格則繼續遞迴——巢狀更深處仍可能有獨立合格的文件子目錄。
		if !seenWiki[relSlash] && dirQualifiesAsAutoDoc(p) {
			result.autoDocDirs = append(result.autoDocDirs, relSlash)
			return filepath.SkipDir
		}
		return nil
	})
	sort.Strings(result.otherWikiDirs)
	sort.Strings(result.autoDocDirs)
	return result
}

// dirQualifiesAsAutoDoc 回答「這個目錄自己直接放的檔案，算不算文件目錄」——
// Phase 0 的核心判準（`inkstone/arcrun-rag#136`）：零程式碼副檔名＋至少一個
// 文件類副檔名。**只看直接放在這個目錄裡的檔案**，不遞迴看子目錄（見呼叫端說明）。
//
// 🔴 「零程式碼」而非「程式碼佔比低於門檻」：leo 08-24 第三次留言明講不要用比例——
// 一個真正的程式碼目錄（`scripts/` 這種文件寫得多的）不該因為比例低就被誤判成文件夾。
// 副檔名表沿用既有的（`codeFileExts`／`allowedExt`／`docLikeExt`），不重新發明一套。
func dirQualifiesAsAutoDoc(absDir string) bool {
	entries, err := os.ReadDir(absDir)
	if err != nil {
		return false
	}
	hasDoc := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		if codeFileExts[ext] {
			return false // 一個程式碼副檔名就整個不合格——零門檻，見上方說明
		}
		if allowedExt[ext] || docLikeExt[ext] {
			hasDoc = true
		}
	}
	return hasDoc
}

// ─────────────────────────────────────────────────────────────────────────────
// 走訪判準：Scan 在 WalkDir 裡逐目錄／逐檔問這兩支
// ─────────────────────────────────────────────────────────────────────────────

// SkipsDir 回答「走訪時要不要整棵跳過這個目錄」。relSlash 是相對監看根的路徑。
//
// 🔴 **「不走進去」與「不收這裡的檔」是兩件事**（inkstone/Arcrun#180 紅線②，
// leo 2026-08-28：「所有的 system-dev 都可以展開，**因為就算沒有可萃的它也有下層**」）。
// 這支只回答前者，而且**只剩「走進去也沒有意義」的那幾種**：
//
//  1. 使用者自己宣告不要的（`.gitignore`）
//  2. 工具產生的（別人的套件、快取、建置產物）——名字本身就不是人話
//  3. 泛用名的建置目錄（旁邊擺著產生它的專案檔才算）
//  4. linked worktree——同一個 repo 的第二份簽出，整棵是重複的
//  5. 巢狀 repo——那是另一個獨立專案，要收請自己加進看守清單
//
// 這五種每一種都是「裡面長什麼樣不必知道」，剪掉不會讓使用者少看到自己的東西
// （而且 `node_modules` 這種走進去就是幾萬個節點，畫面反而看不了）。
//
// **拿掉的是「收檔範圍」那幾條**：以前 curated-wiki 只走那份 wiki 的路、docs-only 只走
// 文件區、範本目錄整棵剪掉——那三條講的是「要不要**收**」，卻長在剪枝上，
// 於是樹在那一節就斷了（實測：地端 13 個目錄，雲端的樹只有 3 個節點）。
// 它們搬去 CollectsDirWhy，只影響收檔，不影響走訪。
// （隱藏目錄由 Scan 自己擋，那條規則比本檔更早存在，不搬過來。）
func (p IngestPlan) SkipsDir(relSlash, absPath string) bool {
	skip, _ := p.SkipsDirWhy(relSlash, absPath)
	return skip
}

// SkipsDirWhy 同 SkipsDir，但一併回「講給使用者聽的理由」。
//
// 🔴 理由不是 debug 字串，是產品文案：使用者看到「兩千個檔只送了九個」的當下，
// 唯一能讓他不慌的東西就是這一句（票上的紅線，同 #121「不要讓用戶猜」）。
func (p IngestPlan) SkipsDirWhy(relSlash, absPath string) (bool, string) {
	name := filepath.Base(relSlash)

	// ① 使用者自己宣告過的（最有力的理由——他親手寫的，不是我們猜的）
	if p.ignore.Ignores(relSlash, true) {
		return true, "你的 .gitignore 說不要收這裡"
	}
	// ② 名字本身就不是人話（不需要佐證）
	if toolOwnedDirNames[name] {
		return true, "這是工具產生的（別人的套件、快取或建置產物），不是你寫的東西"
	}
	// ③ 泛用名（build／dist／out…）——只有在它旁邊真的擺著專案檔時才算。
	//    判準是目錄局部的，與版控無關（leo 2026-08-16：他的筆記庫也有 git）。
	if ambiguousBuildDirNames[name] && looksGenerated(absPath) {
		return true, "這是建置工具產生的目錄（旁邊就是產生它的專案檔）"
	}
	if IsLinkedWorktree(absPath) {
		return true, "這是同一個專案的第二份簽出（git worktree），內容與主資料夾重複"
	}
	// 巢狀 repo：監看根自己不算（relSlash == "." 走不到這裡，Scan 只對子目錄呼叫）。
	if IsRepoRoot(absPath) {
		return true, "這是另一個獨立的專案，要收請把它自己加進看守清單"
	}
	return false, ""
}

// CollectsDirWhy 回答「這一層的檔案，這次收不收」——**走訪照走，只影響收檔**。
//
// 回 (false, 理由) ＝ 這一層的檔不收，理由講給使用者聽；(true, "") ＝ 照收檔規則走。
//
// 這裡裝的正是從剪枝搬過來的那幾條收檔範圍：curated-wiki 只讀那份整理好的 wiki、
// docs-only 只讀文件區。**它們是好的判斷，錯的只是它們以前長在剪枝上**
// ——把「不收」實作成「不走進去」，代價是使用者連自己有哪些子資料夾都看不到。
func (p IngestPlan) CollectsDirWhy(relSlash string) (bool, string) {
	switch p.Mode {
	case IngestCuratedWiki:
		if !onPathTo(relSlash, p.WikiRelDir) {
			return false, "這次只讀你整理好的 " + p.WikiRelDir
		}
	case IngestDocsOnly:
		for _, d := range p.DocRelDirs {
			if onPathTo(relSlash, d) {
				return true, ""
			}
		}
		return false, "這是一個開發專案，這次只讀文件區，不讀程式碼"
	}
	return true, ""
}

// KeepsFile 回答「這個檔要不要收」。relSlash 是相對監看根的路徑。
//
// curated-wiki：只收那份 wiki 底下的檔。
// docs-only：收文件目錄底下的檔，外加**根層的說明檔**（README／CONTRIBUTING 那些是
// 專案唯一的入門文件，把它們漏掉，一個只有 README 的 repo 會變成一個檔都不收）。
// all：全收，判準交回 Scan 原本的副檔名白名單。
func (p IngestPlan) KeepsFile(relSlash string) bool {
	// 使用者自己宣告過的檔案（`*.log`、`.dev.vars`…）同樣當真——與目錄同一條理由。
	if p.ignore.Ignores(relSlash, false) {
		return false
	}
	// 機器產生的鎖定檔不是知識（見 toolOwnedFileNames）。
	if toolOwnedFileNames[filepath.Base(relSlash)] {
		return false
	}
	// 🔴 inkstone/Arcrun#134（2026-08-28 實測）：**我們自己產的卡不是原稿。**
	//
	// curated-wiki 模式收的是「他親手整理的 `system-dev/wiki/`」，而那個目錄底下
	// 同時住著 daemon 上一版寫進去的卡（`cards/arcrun-*.md`，帶 MachineMark）。
	// 少了這一問，daemon 會把自己 8/4 產的卡當成新原稿再萃一次，得到「卡片的卡片」
	// ——實測 `youlinhsieh-test1` 一輪長出 10 份第二代文件卡（`arcrun-換柱`、
	// `arcrun-官架子`…），而它們又會變成第三代的原稿。
	//
	// 判準用 IsMachineOwnedRel 而不是「在不在某個目錄」：那支是規約的完整判準
	// （帶 MachineMark 前綴 ∪ 路徑上有 `.arcrun-rag/` 或 `.wiki/`），
	// 而使用者自己寫的卡不帶前綴 ⇒ 照收不誤，curated-wiki 的規格（#104 第二層，
	// 「那份 wiki 是他寫的，正是他要我們讀的」）不受影響。
	if InMachineOwnedDir(relSlash) {
		return false
	}
	// 🔴 inkstone/Arcrun#180（2026-08-28）把上面那一問**收窄成只在 curated-wiki 生效**，
	// 因為 #134 與 #180 的迴歸網在同一個路徑上要求相反的答案：
	//
	//	#134 cardloop_test.go：`system-dev/wiki/cards/arcrun-換柱.md`        **不准收**
	//	#180 template_not_knowledge_test.go：`system-dev/wiki/cards/arcrun-火星座標_短片劇本_v1.md` **必須收**
	//
	// 同一個目錄、同一個前綴 ⇒ **靠名字分不開**，實測 #151 併入後四種模式全部回 false，
	// leo 的那 9 張卡一張都收不到（而他 08-14 的原話是「這些庫都早就萃好了⋯⋯直接 ingest」，
	// #180 票上第 3 條驗收就是「那 9 張卡的內容進得了雲端」）。
	//
	// 收窄的依據是 #134 自己寫下的理由——它整段講的是 curated-wiki：
	// 「curated-wiki 模式收的是『他親手整理的 system-dev/wiki/』，而那個目錄底下
	//   同時住著 daemon 上一版寫進去的卡」。**接一個開發 repo 時那個重疊是結構性的**
	//（`cardsRelDir` 就等於 `system-dev/wiki/cards`）⇒ 該擋。
	// 一般資料夾／筆記庫（mode=all）沒有那個結構性重疊，而 leo 對這一種明確表過態。
	//
	// 🔴 **這一格是我的假設，不是 leo 的裁決**：兩張票的驗收互斥，需要他選一邊。
	//    假設寫在這裡與 PR／票上，錯了打回即可（`inkstone/Arcrun#180`）。
	// 迴圈安不安全：#134 三個環裡真正關掉迴圈的是 tidy／snapshotCards 那兩個
	//（產物只落 `.wiki/`，上面那一問就擋得住）。實測 4 輪 mode=all 收這 9 張卡，
	// `system-dev/wiki/cards/` 從頭到尾維持 9 個檔、沒有第二代。
	//
	// 🔴 第二格收窄：**再加一問「在不在卡片產物區」**。
	// `IsMarked` 只看 basename 前綴，而 `arcrun-` 是這個專案的人也會用的命名習慣——
	// 實測 leo 的 `youlinhsieh-test1` **根層**就有三個他自己寫的檔中招：
	//	`arcrun-1457驗收-20260827.md`／`arcrun-md-test.md`／
	//	`arcrun-複驗用-請勿刪-20260827c.md`（檔名裡就寫著「請勿刪」）
	// 對照組實跑（#151 原樣、dry-run）：這三個連同那 9 張卡共 **12 個檔被排進「下架」**
	// ——不是不收而已，是**把雲端已經有的內容撤掉**。
	// #134 要擋的是「daemon 寫在他 wiki 裡的卡」，那些卡一律住在卡片產物區
	//（`system-dev/wiki/cards/`／`.arcrun-rag/wiki/cards/`，`cardRelFor` 的落點），
	// 所以多這一問不會放過任何一個它要擋的東西，卻救回使用者自己命名的檔。
	if p.Mode == IngestCuratedWiki && IsMarked(filepath.Base(relSlash)) && isUnderCardDir(relSlash) {
		return false
	}
	switch p.Mode {
	case IngestCuratedWiki:
		return strings.HasPrefix(relSlash, p.WikiRelDir+"/")
	case IngestDocsOnly:
		for _, d := range p.DocRelDirs {
			if strings.HasPrefix(relSlash, d+"/") {
				return true
			}
		}
		return !strings.Contains(relSlash, "/") // 根層說明檔
	}
	return true
}

// OverridesTemplateOwned 回答「這個檔雖然被 TemplateOwns 認成『開發用的』，
// 但本次策略仍然要收它嗎」。
//
// 🔴 只有 curated-wiki 模式、且只針對那份 wiki 底下的檔會回 true。
//
// 為什麼需要這個開關：`TemplateOwns` 把 `system-dev/` 整棵當成「開發用的、不該進知識庫」
// （2026-08-06，理由是「我們代裝進使用者資料夾的 template 產物不是他的知識」）。
// 但 leo 2026-08-14 的規格要的正是那個位置——`system-dev/wiki/` 在**他自己的 repo** 裡
// 是他親手整理的知識庫，而且是唯一該收的東西。
//
// 兩條規則對撞，用**身分**化解而不是拿掉任何一條：
//   - 我們代裝進使用者筆記資料夾的那份，那個資料夾裡沒有成套的程式碼
//     ⇒ PlanIngest 回 IngestAll ⇒ 這裡回 false ⇒ 舊規則照舊
//   - 他自己的軟體專案（有專案檔、有成堆原始碼）且有現成 wiki
//     ⇒ curated-wiki ⇒ 這裡回 true ⇒ 收那份 wiki
//
// 🔴 2026-08-16 更新：以前這兩行寫的是「沒有 `.git`／有 `.git`」，而那正是
// 本票第二層要拔掉的判準——leo 的 KB 筆記庫也有 git。現在兩邊都改看內容。
func (p IngestPlan) OverridesTemplateOwned(relSlash string) bool {
	if p.Mode != IngestCuratedWiki {
		return false
	}
	return strings.HasPrefix(relSlash, p.WikiRelDir+"/")
}

// onPathTo 回答「relSlash 是不是 target 的祖先、target 自己、或 target 的子孫」
// ——也就是走訪時「這條路要不要繼續走下去」。
func onPathTo(relSlash, target string) bool {
	if relSlash == target ||
		strings.HasPrefix(relSlash, target+"/") ||
		strings.HasPrefix(target, relSlash+"/") {
		return true
	}
	return false
}
