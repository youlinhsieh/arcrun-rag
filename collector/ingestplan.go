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

// templateOwnedDirNames＝system-dev-template 鋪出來的產物區，任何深度都不當原稿
// （daemon-beta task 2，2026-08-06，原始出處 commit b4fee43）。
//
// 🔴 這一條以前是 direct.go 自己手捏的第二張表（`SkipDirNames{"system-dev": true}`），
// 而 #104 的排除清單在這裡——**兩張表分居兩處，於是 2026-08-16 讀源碼的人只看到其中一張，
// 把「清單根本沒接上」當成了真兇**（實際上兩張都有接上，見 direct.go 的 `Plan: plan`）。
// 收成同一個地方，就不會再有第二張表可以漏看。
// curated-wiki 模式要收的正是 `system-dev/wiki` ⇒ 那條路由 onPathTo 放行。
var templateOwnedDirNames = map[string]bool{"system-dev": true}

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
	others := otherWikiDirs(absRoot)
	if wiki := findCuratedWiki(absRoot); wiki != "" {
		return IngestPlan{
			Mode:       IngestCuratedWiki,
			Shape:      shape,
			WikiRelDir: wiki,
			Reason: "這是一個開發專案（" + evidence + "），而且你已經整理好一份知識庫（" + wiki + "）——" +
				"我直接讀那一份就好，不再把整個專案的原始碼與零散檔案重萃一次。",
			OtherWikiDirs: others,
			ignore:        ignore,
		}
	}

	docs := existingDocDirs(absRoot)
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
		OtherWikiDirs: others,
		ignore:        ignore,
	}
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

// otherWikiDirs 找出監看根底下**其他**地方的 wiki（子專案自己的知識庫）。
//
// 🔴 為什麼找出來卻不收：leo 的 `InkStoneCo` 底下有 `products/*`、`matrix/*` 這些
// **各自獨立的 repo**，每一個都有自己的 `system-dev/wiki`。它們是**別的專案**的知識，
// 混進這個資料夾的知識庫裡，AR-Mira 搜一個主題就會回一堆分不清屬於誰的東西。
// 要收哪一個，是使用者的決定——把那個子專案自己加進看守清單即可。
//
// 但**一定要講出來**：使用者接了一個 monorepo 卻只看到 32 張卡，不告訴他其餘的在哪，
// 他只會覺得東西不見了（票上的紅線：不要讓他猜）。
//
// 走訪時套用與 Scan 相同的跳過規則（隱藏目錄、noise、linked worktree、
// 已知的 curated 位置自己），所以出貨用 worktree 與 templatefs 的那十幾份不會列進來。
func otherWikiDirs(absRoot string) []string {
	seen := map[string]bool{}
	for _, rel := range curatedWikiCandidates {
		seen[rel] = true
	}
	var out []string
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
		if name == "wiki" && !seen[relSlash] && dirHasMarkdown(p) {
			out = append(out, relSlash)
			return filepath.SkipDir
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 走訪判準：Scan 在 WalkDir 裡逐目錄／逐檔問這兩支
// ─────────────────────────────────────────────────────────────────────────────

// SkipsDir 回答「走訪時要不要整棵跳過這個目錄」。relSlash 是相對監看根的路徑。
//
// 三類跳過，全模式適用：
//  1. noise（依賴／建置產物／範本）——名字判準，見 noiseDirNames
//  2. linked worktree——`.git` 是檔案。#104 實據裡的 `.claude/worktrees/…` 與
//     `products/arcrun-rag-wt60ship` 全是這一種：主 repo 的第二份簽出，收了就是重複
//  3. 巢狀 repo（自己有 `.git` 的子目錄）——那是別的專案，見 otherWikiDirs 的說明
//
// 再加上模式限定的：curated-wiki 只走那一份 wiki 的路；docs-only 只走文件目錄的路。
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
	// ④ template 鋪出來的產物區（任何深度）。curated-wiki 要收的那條路例外。
	if templateOwnedDirNames[name] && !(p.Mode == IngestCuratedWiki && onPathTo(relSlash, p.WikiRelDir)) {
		return true, "這是開發範本鋪出來的目錄，不是你的知識"
	}
	if IsLinkedWorktree(absPath) {
		return true, "這是同一個專案的第二份簽出（git worktree），內容與主資料夾重複"
	}
	// 巢狀 repo：監看根自己不算（relSlash == "." 走不到這裡，Scan 只對子目錄呼叫）。
	if IsRepoRoot(absPath) {
		return true, "這是另一個獨立的專案，要收請把它自己加進看守清單"
	}
	switch p.Mode {
	case IngestCuratedWiki:
		// 只有「通往那份 wiki 的路」與「那份 wiki 底下」要走。
		if !onPathTo(relSlash, p.WikiRelDir) {
			return true, "這次只讀你整理好的 " + p.WikiRelDir
		}
	case IngestDocsOnly:
		for _, d := range p.DocRelDirs {
			if onPathTo(relSlash, d) {
				return false, ""
			}
		}
		return true, "這是一個開發專案，這次只讀文件區，不讀程式碼"
	}
	return false, ""
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
