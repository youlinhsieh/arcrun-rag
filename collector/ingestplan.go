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
//	IngestCuratedWiki 版控中的專案，而且**已經有整理好的 wiki** ⇒ 只收那一份
//	IngestDocsOnly   版控中的專案，但沒有現成 wiki ⇒ 只收文件區，程式碼一律不讀
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
	// RepoRoot＝版控工作目錄的根（Mode != IngestAll 時非空）。
	RepoRoot string `json:"repo_root,omitempty"`
	// WikiRelDir＝現成 wiki 的相對路徑（僅 IngestCuratedWiki）。
	WikiRelDir string `json:"wiki_rel_dir,omitempty"`
	// DocRelDirs＝要收的文件目錄（僅 IngestDocsOnly；根層 .md 另由 keepsRootDoc 放行）。
	DocRelDirs []string `json:"doc_rel_dirs,omitempty"`
	// Reason＝一句話講給使用者聽的「為什麼只收這些」。
	Reason string `json:"reason"`
	// OtherWikiDirs＝這個 repo 底下**其他**子專案自己的 wiki（相對路徑）。
	// 刻意不收（見 wantsPath 的說明），但一定要列出來——不然使用者只會覺得東西不見了。
	OtherWikiDirs []string `json:"other_wiki_dirs,omitempty"`
}

// curatedWikiCandidates＝「整理好的知識庫」慣例位置，依優先序。
// `system-dev/wiki` 是 system-dev-template 的規約（leo 全部的 repo 都是這個），
// 其餘兩個是一般開源專案的慣例。
var curatedWikiCandidates = []string{"system-dev/wiki", "docs/wiki", "wiki"}

// docDirCandidates＝沒有現成 wiki 時，「文件住在哪」的慣例位置。
var docDirCandidates = []string{"docs", "doc", "documentation"}

// noiseDirNames＝任何模式下都整棵跳過的目錄名。
//
// 分三類，全部都是「這個 repo 的零件，不是誰的知識」：
//   - 依賴：別人的原始碼，不是使用者的
//   - 建置產物：從別的檔生出來的，收了就是同一份內容收兩次（#104 實據：`.next`／`.vercel`）
//   - 範本／樣板：`templatefs` 是我們自己要鋪給別人的檔，收自己鋪的東西最荒謬
//     （#104 實據：8 份 `collector/templatefs/system-dev/wiki`）
var noiseDirNames = map[string]bool{
	// 依賴
	"node_modules": true, "vendor": true, "bower_components": true,
	"site-packages": true, "venv": true, "virtualenv": true, "__pycache__": true,
	"Pods": true, "Carthage": true,
	// 建置產物／快取
	"dist": true, "build": true, "out": true, "target": true, "bin": true, "obj": true,
	".next": true, ".nuxt": true, ".vercel": true, ".output": true, ".turbo": true,
	".parcel-cache": true, "coverage": true, ".pytest_cache": true, ".gradle": true,
	// 範本／樣板（我們自己鋪給別人的檔）
	"templatefs": true, "template-fs": true, "skeleton": true,
	// 測試素材（不是知識，是給程式吃的樣本）
	"testdata": true, "fixtures": true, "__fixtures__": true, "__snapshots__": true,
}

// PlanIngest 決定某個監看根的收檔策略。**這支是 #104 的入口，Scan 在走訪前呼叫一次。**
//
// 判斷順序刻意照 leo 的原話：先問「是不是專案」，再問「有沒有現成 wiki」，最後才退到文件區。
//
// 為什麼「是不是專案」用版控（`.git`）判：那是唯一不必猜的訊號，而且與 #105 同一個判準
// ——一個資料夾在版控裡，就代表裡面有人在追每個檔案的歷史，那幾乎必然是原始碼專案而不是
// 誰的筆記本。判準只有一個地方（repoguard.go），兩張票共用，不會漂移。
func PlanIngest(absRoot string) IngestPlan {
	repoRoot := DetectRepoRoot(absRoot)
	if repoRoot == "" {
		return IngestPlan{
			Mode:   IngestAll,
			Reason: "這是一般資料夾，裡面的文件我全部都會讀。",
		}
	}

	others := otherWikiDirs(absRoot)
	if wiki := findCuratedWiki(absRoot); wiki != "" {
		return IngestPlan{
			Mode:       IngestCuratedWiki,
			RepoRoot:   repoRoot,
			WikiRelDir: wiki,
			Reason: "這是一個開發專案，而且你已經整理好一份知識庫（" + wiki + "）——" +
				"我直接讀那一份就好，不再把整個專案的原始碼與零散檔案重萃一次。",
			OtherWikiDirs: others,
		}
	}

	docs := existingDocDirs(absRoot)
	reason := "這是一個開發專案，我只讀文件、不讀程式碼。"
	if len(docs) > 0 {
		reason = "這是一個開發專案，我只讀文件（" + strings.Join(docs, "、") + "）與根目錄的說明檔，不讀程式碼。"
	}
	return IngestPlan{
		Mode:          IngestDocsOnly,
		RepoRoot:      repoRoot,
		DocRelDirs:    docs,
		Reason:        reason,
		OtherWikiDirs: others,
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
		if strings.HasPrefix(name, ".") || noiseDirNames[name] {
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
	name := filepath.Base(relSlash)
	if noiseDirNames[name] {
		return true
	}
	if IsLinkedWorktree(absPath) {
		return true
	}
	// 巢狀 repo：監看根自己不算（relSlash == "." 走不到這裡，Scan 只對子目錄呼叫）。
	if IsRepoRoot(absPath) {
		return true
	}
	switch p.Mode {
	case IngestCuratedWiki:
		// 只有「通往那份 wiki 的路」與「那份 wiki 底下」要走。
		return !onPathTo(relSlash, p.WikiRelDir)
	case IngestDocsOnly:
		for _, d := range p.DocRelDirs {
			if onPathTo(relSlash, d) {
				return false
			}
		}
		return true
	}
	return false
}

// KeepsFile 回答「這個檔要不要收」。relSlash 是相對監看根的路徑。
//
// curated-wiki：只收那份 wiki 底下的檔。
// docs-only：收文件目錄底下的檔，外加**根層的說明檔**（README／CONTRIBUTING 那些是
// 專案唯一的入門文件，把它們漏掉，一個只有 README 的 repo 會變成一個檔都不收）。
// all：全收，判準交回 Scan 原本的副檔名白名單。
func (p IngestPlan) KeepsFile(relSlash string) bool {
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
//   - 我們代裝的資料夾沒有 `.git` ⇒ PlanIngest 回 IngestAll ⇒ 這裡回 false ⇒ 舊規則照舊
//   - 他自己的 repo 有 `.git` 且有現成 wiki ⇒ curated-wiki ⇒ 這裡回 true ⇒ 收那份 wiki
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
