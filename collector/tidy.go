// tidy.go — 認出並收拾「daemon 以前寫進使用者資料夾、但還沒帶標記」的舊產物
// （arcrun-rag#60 第二輪驗收條件③）。
//
// 🔴 為什麼光「以後不再撞名」不夠：
//
//	leo 打開資料夾的當下，裡面已經有一批舊產物了（`status.md`／`mistakes.md`／
//	日期檔那些）。修好未來不會讓現在變乾淨——**他抱怨的是他現在看到的東西**。
//	所以這一輪必須同時交出「一次認出來／一次改名」的辦法。
//
// 🔴 這是別人的資料，所以本檔只做兩件可回收的事：**改名**與**搬移**。
//
//	一行 os.Remove 都沒有。誤判時他把檔案搬回去就好，不會有東西不見。
//	同理，目標檔名已經存在時一律**跳過並報告**，不覆蓋（safewrite.go 同一條紅線）。
//
// 兩個入口，責任不同：
//
//	① MigrateCardNames()：daemon 每輪自動跑，只碰**卡片產物區**（那整個目錄是我們寫的，
//	   百分之百不會誤傷）。leo 不必知道它存在——「不該為了保護自己的筆記去學新選項」。
//	② Tidy() / `collector tidy`：人工跑，多處理一類——**template 殘留**。
//	   那一類不能自動搬，因為同樣那幾個路徑在「leo 自己的開發 repo」裡是**他的真檔案**
//	   （TemplateOwns 是路徑身分判準，分不出「daemon 鋪的」還是「repo 本來就有的」）。
//	   ⇒ 只有在**確定是 vault**（沒有人會把 system-dev template 放進 Logseq 筆記庫）
//	     時才動手，其餘一律只列出來讓人自己決定。
package collector

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// 產物分類（報告用；也是「動不動手」的判準）。
const (
	TidyKindCard     = "card"              // 卡片本體
	TidyKindCardBak  = "card-backup"       // safeWriteCard 產生的 .bak-<unixnano>
	TidyKindTemplate = "template-leftover" // 舊版 daemon 代裝的 system-dev template 殘留
)

// 動作（報告用）。dry-run 時只會出現 would-* 與 report-only。
const (
	TidyActionRenamed    = "renamed"
	TidyActionMoved      = "moved"
	TidyActionWillRename = "would-rename"
	TidyActionWillMove   = "would-move"
	TidyActionReport     = "report-only" // 我不動它，請人自己判斷
	TidyActionSkipped    = "skipped"     // 想動但不能動（目標已存在／搬不動）
)

// legacyTemplateRelDir 是 template 殘留的收容處：監看根底下的隱藏目錄，
// 保留原本的相對路徑結構（`.arcrun-rag/legacy-template/system-dev/wiki/status.md`）。
// 刻意留在同一個資料夾裡而不是丟到 ~/ 或垃圾桶——東西還在他手上，要還原只是搬回去。
const legacyTemplateRelDir = ".arcrun-rag/legacy-template"

// bakSuffix 認 safeWriteCard 的備份檔：`<原名>.bak-<unixnano>`。
var bakSuffix = regexp.MustCompile(`\.bak-\d+$`)

// TidyItem＝一筆產物與我們對它做了（或會做）什麼。
type TidyItem struct {
	Rel    string `json:"rel"`            // 相對監看根的路徑（斜線分隔）
	To     string `json:"to,omitempty"`   // 改名/搬移的目的地（同樣相對監看根）
	Kind   string `json:"kind"`           // TidyKind*
	Action string `json:"action"`         // TidyAction*
	Note   string `json:"note,omitempty"` // 沒動它的原因（白話）
}

// TidyReport＝一次收拾的完整帳目。
type TidyReport struct {
	Root      string    `json:"root"`
	VaultType VaultType `json:"vault_type"`
	// VaultRoot＝筆記庫的根。與 Root 不同時代表「監看的是筆記庫底下的一層子資料夾」
	// ——第三輪修的正是這一種（arcrun-rag#60）。空字串＝不在任何筆記庫裡。
	VaultRoot string     `json:"vault_root,omitempty"`
	Applied   bool       `json:"applied"` // false＝只看不動（dry-run）
	Items     []TidyItem `json:"items"`
}

// Counts 依 action 統計，給人看的一行摘要用。
func (r *TidyReport) Counts() map[string]int {
	out := map[string]int{}
	for _, it := range r.Items {
		out[it.Action]++
	}
	return out
}

// cardDirsToScan 回傳「卡片可能住過的所有目錄」（相對監看根）。
// 刻意兩個都掃，不看目前是不是 vault——舊產物可能是在資料夾還沒變成 vault 之前落下的，
// 也可能是第一輪修復前落在 system-dev/wiki/cards/ 的。認人要認全，不能只認現在這一種。
func cardDirsToScan() []string {
	return []string{cardsRelDir, vaultCardsRelDir}
}

// isUnderCardDir 回答「這個相對路徑是不是住在卡片產物區底下」。
func isUnderCardDir(relSlash string) bool {
	for _, d := range cardDirsToScan() {
		if strings.HasPrefix(relSlash, d+"/") {
			return true
		}
	}
	return false
}

// collectCardItems 掃出卡片產物區裡「不在它現在該在的位置／還沒帶標記」的檔案，
// 算出它們該搬去哪、該叫什麼名字。已經到位又帶標記的不列入（冪等：跑第二次是空的）。
//
// 🔴 arcrun-rag#60 第三輪：判準從「有沒有帶標記」擴充成「**位置對不對** ＋ 有沒有帶標記」。
// 只看標記在第三輪不夠——監看根是 vault 子資料夾時，前兩輪的 daemon 已經把一批
// **帶標記但落在可見目錄**（`system-dev/wiki/cards/arcrun-*.md`）的卡寫進使用者的
// 筆記庫了。那些卡在 Logseq 眼裡照樣是一頁一頁的機器頁面，改名救不了，要搬進隱藏目錄。
// 少了這一段，票上「已經寫進去的那一批要能收拾」對這一類就等於沒做。
func collectCardItems(absRoot string) []TidyItem {
	want := cardsRelDirFor(absRoot)
	var items []TidyItem
	for _, relDir := range cardDirsToScan() {
		base := filepath.Join(absRoot, filepath.FromSlash(relDir))
		_ = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			name := d.Name()
			rel, rerr := filepath.Rel(absRoot, p)
			if rerr != nil {
				return nil
			}
			relSlash := filepath.ToSlash(rel)
			if IsMarked(name) && filepath.ToSlash(filepath.Dir(relSlash)) == want {
				return nil // 位置對、標記也有，已經是新的了
			}
			kind := TidyKindCard
			if bakSuffix.MatchString(name) {
				kind = TidyKindCardBak
			}
			items = append(items, TidyItem{
				Rel:  relSlash,
				To:   filepath.ToSlash(filepath.Join(want, MarkName(name))),
				Kind: kind,
			})
			return nil
		})
	}
	return items
}

// collectTemplateItems 掃出 template 殘留（TemplateOwns 命中的路徑）。
//
// vault＝可以搬（沒人會把開發用 template 放進筆記庫，判定為 daemon 舊版鋪的）。
// 非 vault＝**只列不動**：那可能正是使用者自己的開發 repo，搬了會把他的 repo 弄壞。
func collectTemplateItems(absRoot string, isVault bool) []TidyItem {
	var items []TidyItem
	_ = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// 隱藏目錄整棵跳過——收容處自己就在 .arcrun-rag/ 底下，
			// 不跳過的話第二次跑會把搬過去的東西再搬一次。
			if p != absRoot && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(absRoot, p)
		if rerr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if !TemplateOwns(relSlash) {
			return nil
		}
		// 🔴 卡片產物區就住在 `system-dev/wiki/cards/` 底下，而 TemplateOwns 是**目錄前綴**
		// 判準（`system-dev/` 整棵都算 template）⇒ 不排除的話，同一張卡會同時被認成
		// 「卡片（該改名）」與「template 殘留（該搬走）」，兩個動作搶同一個檔，
		// 先跑的改完名、後跑的就 Stat 不到 ⇒ 報告出現假的失敗。卡片一律由 collectCardItems 管。
		if isUnderCardDir(relSlash) {
			return nil
		}
		it := TidyItem{Rel: relSlash, Kind: TidyKindTemplate}
		if isVault {
			it.To = filepath.ToSlash(filepath.Join(legacyTemplateRelDir, relSlash))
		} else {
			it.Action = TidyActionReport
			it.Note = "這不是 vault，可能是你自己的開發 repo（template 本來就該在）——我不動它，要清請自己確認"
		}
		items = append(items, it)
		return nil
	})
	return items
}

// MigrateCardNames 把卡片產物區裡「位置不對或沒帶標記」的舊卡歸位。daemon 每輪自動呼叫。
// 回傳實際動到的筆數。**只碰卡片產物區**，其餘一概不動。
//
// 為什麼可以自動：那兩個目錄從頭到尾只有 daemon 會寫（見 cardsRelDirFor 的註解），
// 不存在「誤把使用者的檔案改名」的可能。目標已存在就跳過，不覆蓋。
//
// 🔴 第三輪起也負責**搬移**（不只改名）：監看根在 vault 裡時，舊版寫在可見目錄的卡
// 會被搬進 `.arcrun-rag/wiki/cards/`。這是自動的，因為紅線寫著「不准要使用者去設定
// 什麼開關才能保護自己的筆記」——他不該為了收拾機器留下的東西去學一個新指令。
func MigrateCardNames(absRoot string) int {
	n := 0
	for _, it := range collectCardItems(absRoot) {
		from := filepath.Join(absRoot, filepath.FromSlash(it.Rel))
		to := filepath.Join(absRoot, filepath.FromSlash(it.To))
		if _, err := os.Stat(to); err == nil {
			continue // 新名字已經有東西了，不覆蓋
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			continue
		}
		if err := os.Rename(from, to); err == nil {
			n++
		}
	}
	return n
}

// Tidy 掃出所有舊產物；apply=false 只報告，apply=true 才真的改名/搬移。
func Tidy(root string, apply bool) (*TidyReport, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absRoot)
	if err != nil {
		return nil, fmt.Errorf("看不到這個資料夾（%s）：%w", absRoot, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s 不是資料夾", absRoot)
	}

	// 🔴 兩個判準，回答兩個不同的問題，不要合併（arcrun-rag#60 第三輪）：
	//
	//	· ctx（含往上找）＝「我寫東西會不會落進誰的筆記庫」——決定卡片該在哪，也是報告顯示的身分。
	//	· DetectVaultType(absRoot)（只看這一層）＝「這個資料夾**本身**是不是筆記庫」——
	//	  只有它才夠格授權「把 template 殘留搬走」。理由：一個住在筆記庫底下的
	//	  **使用者自己的開發 repo**（`KB/some-repo/system-dev/…`）在 ctx 眼中也「在 vault 裡」，
	//	  但那些 template 檔是他的真檔案，不是 daemon 鋪的。搬了就是弄壞他的 repo。
	//	  分不出來的時候只列不動——這條在第二輪就寫了，第三輪擴大偵測範圍時更要守住。
	ctx := DetectVaultContext(absRoot)
	rep := &TidyReport{Root: absRoot, VaultType: ctx.Type, VaultRoot: ctx.Root, Applied: apply}

	items := collectCardItems(absRoot)
	items = append(items, collectTemplateItems(absRoot, DetectVaultType(absRoot) != VaultNone)...)
	sort.Slice(items, func(i, j int) bool { return items[i].Rel < items[j].Rel })

	for _, it := range items {
		if it.Action == TidyActionReport { // 已經判定只列不動
			rep.Items = append(rep.Items, it)
			continue
		}
		// 換了目錄就是「搬走」，只換名字才是「改名」——報告要說實話，
		// 使用者才知道去哪裡找他的東西（第三輪起卡片也會換目錄）。
		willMove := it.Kind == TidyKindTemplate ||
			filepath.ToSlash(filepath.Dir(it.Rel)) != filepath.ToSlash(filepath.Dir(it.To))
		from := filepath.Join(absRoot, filepath.FromSlash(it.Rel))
		to := filepath.Join(absRoot, filepath.FromSlash(it.To))

		if _, serr := os.Stat(to); serr == nil {
			it.Action = TidyActionSkipped
			it.Note = "目的地已經有同名檔案了，我不覆蓋——請自己看一眼哪一份要留"
			rep.Items = append(rep.Items, it)
			continue
		}
		if !apply {
			it.Action = TidyActionWillRename
			if willMove {
				it.Action = TidyActionWillMove
			}
			rep.Items = append(rep.Items, it)
			continue
		}
		if merr := os.MkdirAll(filepath.Dir(to), 0o755); merr != nil {
			it.Action, it.Note = TidyActionSkipped, "建目的地資料夾失敗："+merr.Error()
			rep.Items = append(rep.Items, it)
			continue
		}
		if rerr := os.Rename(from, to); rerr != nil {
			it.Action, it.Note = TidyActionSkipped, "搬不動："+rerr.Error()
			rep.Items = append(rep.Items, it)
			continue
		}
		it.Action = TidyActionRenamed
		if willMove {
			it.Action = TidyActionMoved
		}
		rep.Items = append(rep.Items, it)
	}
	return rep, nil
}

// runTidy 是 `collector tidy` 子命令主體。
// 預設**只看不動**（要真的動手得自己加 --apply）——別人的資料夾，預設值就該是安全的那一邊。
func runTidy(args []string) int {
	fs2 := newFlagSet()
	folder := fs2.String("folder", "", "要收拾的資料夾（必填，就是 daemon 在看守的那個）")
	apply := fs2.Bool("apply", false, "真的動手改名/搬移（不加＝只列出會動到什麼）")
	asJSON := fs2.Bool("json", false, "輸出 JSON（給程式讀；不加＝給人看的清單）")
	if err := fs2.Parse(args); err != nil {
		return 2
	}
	if *folder == "" {
		fmt.Fprintln(os.Stderr, "錯誤：--folder 為必填")
		return 2
	}
	rep, err := Tidy(*folder, *apply)
	if err != nil {
		fmt.Fprintln(os.Stderr, "collector tidy:", err)
		return 1
	}
	if *asJSON {
		data, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(data))
		return 0
	}

	if len(rep.Items) == 0 {
		fmt.Printf("%s：沒有找到任何沒帶標記的舊產物，這個資料夾是乾淨的。\n", rep.Root)
		return 0
	}
	kind := "一般資料夾"
	switch {
	case rep.VaultType != VaultNone && rep.VaultRoot != rep.Root:
		// 第三輪的那一種擺法——講清楚是誰的庫，不然使用者看不懂為什麼要搬。
		kind = fmt.Sprintf("%s 筆記庫「%s」底下的子資料夾", rep.VaultType, rep.VaultRoot)
	case rep.VaultType != VaultNone:
		kind = string(rep.VaultType) + " 筆記庫"
	}
	fmt.Printf("%s（%s）\n", rep.Root, kind)
	if !rep.Applied {
		fmt.Println("※ 這只是預覽，什麼都還沒動。確認清單沒問題後，同一行指令加上 --apply 才會真的執行。")
	}
	for _, it := range rep.Items {
		switch it.Action {
		case TidyActionRenamed, TidyActionWillRename:
			fmt.Printf("  改名  %s  →  %s\n", it.Rel, it.To)
		case TidyActionMoved, TidyActionWillMove:
			why := "舊版 daemon 鋪的開發用檔案，不是你的筆記"
			if it.Kind != TidyKindTemplate {
				why = "舊版寫在看得見的位置，你的筆記軟體會把它當成一頁——搬進隱藏目錄"
			}
			fmt.Printf("  搬走  %s  →  %s（%s）\n", it.Rel, it.To, why)
		case TidyActionReport:
			fmt.Printf("  略過  %s（%s）\n", it.Rel, it.Note)
		case TidyActionSkipped:
			fmt.Printf("  沒動  %s（%s）\n", it.Rel, it.Note)
		}
	}
	c := rep.Counts()
	fmt.Printf("合計：改名 %d、搬走 %d、只列出 %d、沒動 %d\n",
		c[TidyActionRenamed]+c[TidyActionWillRename],
		c[TidyActionMoved]+c[TidyActionWillMove],
		c[TidyActionReport], c[TidyActionSkipped])
	fmt.Println("（本指令從不刪除任何東西：只有改名與搬移，覺得不對就自己搬回去。）")
	return 0
}
