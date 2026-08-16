// foldershape.go — 「這個資料夾裡實際裝了什麼」：用內容回答，不看版控
// （arcrun-rag#104 第二層，2026-08-16 leo 規格）。
//
// 🔴 leo 2026-08-16 原話（本檔的規格）：
//
//	「**你不需要判斷有沒有 git，我的 KB 筆記庫也有 git，
//	  是否用 github/gitea 追蹤完全沒意義。**」
//
// #104 第一層已經把「哪些目錄算雜訊」改成不看版控（見 ingestplan.go 的三種強度）。
// 但「**這個資料夾整體該用哪種收法**」（all／curated-wiki／docs-only）那一層，
// 當時仍然由 `DetectRepoRoot`（找 `.git`）決定——本檔就是要把它換掉。
//
// 🔴 為什麼非換不可（實測，非推測）：`~/Documents/KB` 是 leo 的真知識庫。
//
//	今天：沒有版控   ⇒ all         ⇒ 5,915 份文件全收（正確）
//	只要有人在那跑一次 `git init`：
//	          有版控 ⇒ curated-wiki ⇒ 只剩 `system-dev/wiki` 的 14 張
//
//	而 KB 真的有 `system-dev/wiki`（leo 在那裡也裝過 template）——
//	**炸彈的引信早就接好了，只差一個 `git init`。**
//	而在自己的筆記資料夾開版控是完全正常的行為，畫面上不會有任何提示。
//
// ⇒ 判準改成問：**這個資料夾裡有沒有一整套軟體專案？**
// 那正是「該不該跳過原始碼」這個問題本身，而版控只是「這個人有沒有在做版本備份」。
//
// ── 判準（三個條件同時成立才算軟體專案）──────────────────────────────────────
//
//	① 找得到專案檔（package.json／go.mod／Cargo.toml…）  ── 有人在這裡跑建置工具
//	② 原始碼檔 ≥ softwareProjectMinCodeFiles              ── 不是零星幾個範例
//	③ 原始碼檔 × 4 ≥ 文件檔                                ── 程式碼不是文件旁邊的零頭
//
// 實測三個真實資料夾（2026-08-16，唯讀 `find` 計數）：
//
//	                 專案檔   原始碼   文件    判定
//	~/Documents/KB      0       15    5,915   ✗ 筆記庫（①②③ 三條全不過）
//	InkStoneCo         20+   5,901    8,036   ✓ 軟體專案
//	tech_projects/pms   有    大量       41    ✓ 軟體專案
//
// 三條都不看 `.git`，所以 `git init` 跑幾次都不會改變答案。
//
// 🔴 為什麼要三條而不是一條：**漏判的代價是多收一些檔，誤判的代價是使用者的知識
// 靜默消失** ——代價不對稱，就往安全那邊倒（同 ingestplan.go 排除判準的那條）。
//
//	· 只看專案檔：筆記庫裡放一個 `Makefile` 就整個塌掉
//	· 只看原始碼數：筆記庫裡存了幾十個程式碼片段就整個塌掉
//	· 加上第③條：筆記庫裡放一整份下載回來的範例專案（有專案檔、有上百個原始碼檔），
//	  只要它相對於那幾千份筆記仍是零頭，整個資料夾就照樣全收
package collector

import (
	"os"
	"path/filepath"
	"strings"
)

// softwareProjectMinCodeFiles＝要幾個原始碼檔才算「一整套」。
//
// 20 這個數字的來源不是拍腦袋，是「**低於它就沒有東西需要防**」：
// 一個只有三五個原始碼檔的資料夾，散落的 `.md` 本來就寥寥可數，
// 全收也不會淹掉使用者的知識庫——而這一票要防的正是「幾千個檔淹掉幾十張卡」。
const softwareProjectMinCodeFiles = 20

// codeToDocRatioDenominator＝第③條的分母：原始碼檔 × 4 ≥ 文件檔。
//
// 白話是「**程式碼至少要佔到文件的四分之一**，才算這個資料夾是拿來寫程式的」。
// KB：15 × 4 = 60，遠小於 5,915 ⇒ 筆記庫。InkStoneCo：5,901 × 4 遠大於 8,036 ⇒ 專案。
const codeToDocRatioDenominator = 4

// shapeProbeMaxEntries＝探測時最多看幾個檔案系統項目。
//
// 為什麼要有上限：這支在每一輪同步、每一個看守根各跑一次。真的碰到一個病態大的
// 資料夾時，寧可拿「已經看過的六萬個項目」下判斷，也不要把同步卡在這裡。
// 看滿六萬個項目還沒湊齊三個條件，本來就不是軟體專案。
const shapeProbeMaxEntries = 60000

// codeFileExts＝算得上「原始碼」的副檔名。
//
// 🔴 刻意**不收** `.html`／`.css`／`.json`／`.xml`：筆記軟體匯出的網頁、
// 存下來的資料、設定檔都長這樣，把它們算成程式碼會讓筆記庫誤判成專案。
// 這裡只留「不寫程式的人不會有」的那些。
var codeFileExts = map[string]bool{
	".go": true, ".rs": true, ".java": true, ".kt": true, ".kts": true,
	".swift": true, ".m": true, ".mm": true, ".c": true, ".h": true,
	".cc": true, ".cpp": true, ".hpp": true, ".cs": true,
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".vue": true, ".svelte": true,
	".py": true, ".rb": true, ".php": true, ".pl": true, ".lua": true,
	".ex": true, ".exs": true, ".erl": true, ".hs": true, ".clj": true,
	".scala": true, ".dart": true, ".groovy": true,
	".sh": true, ".bash": true, ".zsh": true, ".ps1": true, ".bat": true,
	".sql": true, ".proto": true, ".tf": true, ".wat": true,
}

// FolderShape＝探測結果。欄位不只是判準的材料，也是**講給使用者聽的證據**
// （票上的紅線：排除要看得見，不能只丟一個結論給他）。
type FolderShape struct {
	// ManifestRels＝找到的專案檔（相對路徑），最多留 maxShapeEvidence 個當證據。
	ManifestRels []string `json:"manifest_files,omitempty"`
	// ManifestCount／CodeFiles／DocFiles＝實際數到的量。
	ManifestCount int `json:"manifest_count"`
	CodeFiles     int `json:"code_files"`
	DocFiles      int `json:"doc_files"`
	// Truncated＝有沒有撞到 shapeProbeMaxEntries 上限。
	Truncated bool `json:"truncated,omitempty"`
}

// maxShapeEvidence＝證據最多列幾個專案檔（給使用者看的，不是清單）。
const maxShapeEvidence = 3

// IsSoftwareProject 回答「這個資料夾裡有沒有一整套軟體專案」。
//
// 🔴 三條同時成立才算，理由見檔頭。任一條不過就當成一般資料夾／筆記庫（全收）。
func (s FolderShape) IsSoftwareProject() bool {
	if s.ManifestCount == 0 || s.CodeFiles < softwareProjectMinCodeFiles {
		return false
	}
	return s.CodeFiles*codeToDocRatioDenominator >= s.DocFiles
}

// Evidence 把判定的依據講成一句人話，塞進 IngestPlan.Reason 給使用者看。
//
// 「我判斷這是軟體專案」不附證據，等於要使用者相信一個黑盒；附上「看到 go.mod、
// package.json，還有 5,901 個原始碼檔」，他自己就看得出對不對。
func (s FolderShape) Evidence() string {
	if !s.IsSoftwareProject() {
		return ""
	}
	var b strings.Builder
	b.WriteString("我看到 ")
	if len(s.ManifestRels) > 0 {
		b.WriteString(strings.Join(s.ManifestRels, "、"))
		if s.ManifestCount > len(s.ManifestRels) {
			b.WriteString(" 等專案檔")
		} else {
			b.WriteString(" 這類專案檔")
		}
		b.WriteString("，還有 ")
	}
	b.WriteString(plainCount(s.CodeFiles))
	b.WriteString(" 個原始碼檔")
	return b.String()
}

// plainCount 把數字寫成人看的樣子（超過上限就講「多」，不假裝精準）。
func plainCount(n int) string {
	if n >= shapeProbeMaxEntries {
		return "非常多"
	}
	return itoaWithComma(n)
}

func itoaWithComma(n int) string {
	s := ""
	if n == 0 {
		return "0"
	}
	for i := 0; n > 0; i++ {
		if i > 0 && i%3 == 0 {
			s = "," + s
		}
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

// InspectFolder 走一趟資料夾，數出「裡面實際裝了什麼」。
//
// 🔴 走訪時**不看任何版控訊號**——不看 `.git`、不看 `.gitignore` 的存在、
// 也不因為某個子目錄是巢狀 repo 或 linked worktree 就跳過它。
// 那些訊號正是這一票要拔掉的東西；而且要判斷「裡面裝了什麼」，本來就該把裡面看完。
//
// 只跳過三種目錄，理由與 ingestplan.go 的排除判準同源（都不是版控訊號）：
//   - 隱藏目錄（`.` 開頭）：Scan 本來就不走
//   - toolOwnedDirNames：`node_modules` 底下是別人的原始碼，數它等於數別人的專案
//   - ambiguousBuildDirNames ＋ looksGenerated：建置產物是同一份程式碼的第二份拷貝
func InspectFolder(absRoot string) FolderShape {
	var s FolderShape
	manifestNames := map[string]bool{}
	for _, n := range projectManifestFiles {
		manifestNames[n] = true
	}
	seen := 0

	_ = filepath.WalkDir(absRoot, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if seen >= shapeProbeMaxEntries {
			s.Truncated = true
			return filepath.SkipAll
		}
		seen++

		if d.IsDir() {
			if p == absRoot {
				return nil
			}
			name := d.Name()
			if strings.HasPrefix(name, ".") || toolOwnedDirNames[name] ||
				(ambiguousBuildDirNames[name] && looksGenerated(p)) {
				return filepath.SkipDir
			}
			return nil
		}

		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return nil
		}
		if manifestNames[name] {
			s.ManifestCount++
			if len(s.ManifestRels) < maxShapeEvidence {
				if rel, rerr := filepath.Rel(absRoot, p); rerr == nil {
					s.ManifestRels = append(s.ManifestRels, filepath.ToSlash(rel))
				}
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(name))
		switch {
		case codeFileExts[ext]:
			s.CodeFiles++
		case allowedExt[ext]:
			s.DocFiles++
		}
		return nil
	})
	return s
}
