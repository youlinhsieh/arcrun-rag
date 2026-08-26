// scan.go — 掃描迴圈與差異分類（SDD ingest-hash-trigger design §3）。
// 事件順序：先把本輪 removed×added 以 content_hash 配對成 renamed（只更新路徑映射），
// 再分類其餘 added/modified/removed；removed 數 > manifest 條目 × 門檻（預設 40%）
// → removed 全部不執行、改發警告（R6）。本階段不接網路，事件輸出到 stdout。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 收檔白名單。**注意這只是「收不收」，能不能讀由 convert.go 的 extractors 決定**——
// 兩者要一起看（2026-07-27 t73：`.pdf` 早就在這裡，但 ingest 端擋著＝檔案上了 R2 卻進不了
// 知識庫，使用者看到的是「丟檔進去沒反應」）。
//
// .csv/.xlsx 於 2026-07-27 加入——leo：「要思考 Excel 和 csv 的問題，**因為企業用很多**」。
var allowedExt = map[string]bool{
	".md":       true,
	".markdown": true,
	".txt":      true,
	".docx":     true,
	".pptx":     true,
	".pdf":      true,
	".csv":      true,
	".xlsx":     true,
	// 2026-08-15 InkStoneCo#44 ④：《llm-wiki-作業規範》洞 6 的掃描白名單——
	// .feature（Gherkin 規格）、.yaml/.yml、.org、.rst 都是知識文件（真實 repo 實測
	// 34 個非 md 檔裡 9 個是 .feature）。它們是純文字，走 passthrough（見 IsPlainText）。
	".feature": true,
	".yaml":    true,
	".yml":     true,
	".org":     true,
	".rst":     true,
}

// docLikeExt＝「使用者明顯把它當文件、但我們還讀不了」的副檔名。
//
// 🔴 為什麼要有這張表（J-1/S6 考題 G-6.2，2026-08-06）：
// 下面那道 `!allowedExt[...]` 的閘**直接 return nil**——不進事件、不進 manifest、
// 不進 status、不進畫面。使用者把一份 `.doc` 丟進資料夾，**整個系統從頭到尾一個字都不說**，
// 他只會覺得「這東西壞了」。G-6.2 的判準是：要嘛查得到，**要嘛當場被告知不支援**；
// 「安靜地略過」不是可接受的第三種結果。
//
// 為什麼是白名單、而不是「非 allowedExt 一律點名」：後者在 Obsidian 附件庫（幾百張 .png）
// 或程式碼資料夾裡會炸出幾百行「處理不了」＝噪音，使用者反而學會忽略整塊訊息。
// ⇒ **像文件的逐檔點名，其餘只報一個總數**（見 Scan 的 SkippedOther）。兩種都不沉默，
// 但只有前者值得佔用他的注意力。
//
// 加新格式的順序：先列在這裡（使用者立刻看得到「還不支援」），
// 等 convert.go 真的接上抽取器，再把它從這裡搬去 allowedExt。
// maxOtherNames＝非文件檔最多點名幾個。超過就只報總數（避免幾百張圖洗版）。
const maxOtherNames = 5

var docLikeExt = map[string]bool{
	// 舊版 Office（OLE2 二進位，與 .docx/.xlsx/.pptx 是完全不同的格式）
	".doc": true, ".xls": true, ".ppt": true,
	// Apple iWork
	".pages": true, ".numbers": true, ".key": true,
	// OpenDocument（LibreOffice）
	".odt": true, ".ods": true, ".odp": true,
	// 其他常見文件容器
	".rtf": true, ".epub": true, ".wpd": true, ".msg": true, ".eml": true,
}

// SkippedFile＝這一輪被略過、且值得對使用者逐檔點名的檔案。
//
// ⚠️ 刻意**不寫進 manifest**：它每輪由檔案系統重算，永遠反映現況。
// （對照 t195 的坑：凡是存進 ManifestEntry 的跨輪欄位都得記得在 carry 段補一行，
//
//	漏了就靜默歸零。這裡不建立那份債。）
type SkippedFile struct {
	Path string `json:"path"`
	Ext  string `json:"ext"`
}

// ---- 輸出 payload（對應 schemas/collector-trigger.v1.schema.json）----

type Event struct {
	Type       string `json:"type"`
	Path       string `json:"path"`
	OldPath    string `json:"old_path,omitempty"`
	SourceHash string `json:"source_hash"`
	Size       *int64 `json:"size,omitempty"`
	R2Key      string `json:"r2_key,omitempty"`
}

type Warning struct {
	Code           string  `json:"code"`
	Message        string  `json:"message"`
	RemovedCount   int     `json:"removed_count,omitempty"`
	ManifestCount  int     `json:"manifest_count,omitempty"`
	ThresholdRatio float64 `json:"threshold_ratio,omitempty"`
}

type TriggerPayload struct {
	SchemaVersion int       `json:"schema_version"`
	FolderID      string    `json:"folder_id"`
	Root          string    `json:"root,omitempty"`
	GeneratedAt   int64     `json:"generated_at,omitempty"`
	Events        []Event   `json:"events"`
	Warnings      []Warning `json:"warnings,omitempty"`

	// 🔴 兩個 `json:"-"`（G-6.2，2026-08-06）：被略過的檔案是**給本機使用者看的**，
	// 不是給雲端 ingest 的料。collector-trigger.v1.schema.json 頂層寫死
	// `additionalProperties: false`，多帶一個欄位上線就會被 schema 擋掉
	//（BuildSendablePayload 是 `sendable := *p` 淺拷貝，有 tag 就會一起送出去）。
	// ⇒ 留在記憶體裡，由 direct.go 收進 status.json，給 App 首頁用。
	Skipped      []SkippedFile `json:"-"` // 像文件、但還讀不了的（逐檔點名）
	SkippedOther int           `json:"-"` // 其餘非文件檔（圖片/影音/程式碼…）總數
	// SkippedOtherNames＝上面那些檔的檔名，**最多 maxOtherNames 個**。
	// 🔴 2026-08-06（leo 封測）：封測者放了一個 .md 進去說「無法通過」，而畫面只寫
	//    「有 1 個不是文件的檔案」——**沒說是哪一個**，於是誰也判斷不出發生什麼事
	//    （.md 明明在白名單裡，所以那個 1 一定是別的東西：可能副檔名被 Windows 藏起來、
	//     可能存成了別的格式）。只報總數在「幾百張圖」時是對的，在「1 個」時等於沒說。
	//    ⇒ 少量時就點名，讓使用者自己一眼看出「喔，我存錯格式了」。
	SkippedOtherNames []string `json:"-"`

	// DuplicateFormats＝本輪偵測到、同檔名主幹的多格式重複（2026-08-07，見 FormatDuplicate）。
	// 同 Skipped：只給本機使用者看，不隨 payload 送雲端（schema additionalProperties:false 會擋）。
	DuplicateFormats []FormatDuplicate `json:"-"`

	// Plan／ExcludedByPlan＝這一輪用了什麼收檔策略、據此擋掉幾個檔（arcrun-rag#104）。
	// 同上，`json:"-"`：給本機使用者看的，不送雲端。
	// 🔴 這兩個欄位就是 #104 那條紅線的載體——「排除規則要看得見」。少了它們，
	//    使用者接上一個一萬檔的 repo 只看到 32 個進度，會以為系統壞了。
	Plan           IngestPlan `json:"-"`
	ExcludedByPlan int        `json:"-"`
	// ExcludedDirs／ExcludedDirCount＝整棵被剪掉的目錄與理由（2026-08-16 補）。
	// 🔴 ExcludedByPlan 只數得到「走進去了才被逐檔擋下」的檔；整棵剪掉的子樹
	//    一個都數不到 ⇒ 拿 leo 真實的 pms 跑一輪，2,127 個檔裡絕大多數被排除，
	//    而畫面上的數字是 **0**。講一個 0 跟安靜地少收，對使用者是同一件事。
	ExcludedDirs     []ExcludedDir `json:"-"` // 已排序，上限 MaxExcludedDirsListed
	ExcludedDirCount int           `json:"-"` // 總數（可能大於清單長度）

	// ── InkStoneCo#44 線 A：portal 的資料夾樹（leo 2026-08-17）─────────────────
	// DirStats＝走訪時**逐目錄**數出來的分母（key＝相對監看根的路徑，`""`＝根）。
	// AllExcludedDirs＝整棵被剪掉的目錄，**未裁切**（上面那個 ExcludedDirs 為了畫面
	// 只留 20 筆；樹要畫得完整需要全量，不然「哪些沒收」會缺角）。
	//
	// 🔴 為什麼分母一定要在這裡數、不能另外走一趟：判斷「支不支援／收不收」的那一整套
	// 判準就活在這個 WalkDir 裡（allowedExt／docLikeExt／Plan.KeepsFile／TemplateOwns）。
	// 另外走一趟＝同一件事第二份實作，必然漂移 ⇒ 畫面上的數字與實際收的檔對不起來，
	// 而 leo 要的正是「兩個數字的差額解釋得了」。
	// 同 `json:"-"`：給本機與 portal 用的，不進 collector-trigger schema。
	DirStats        map[string]*dirStat `json:"-"`
	AllExcludedDirs []ExcludedDir       `json:"-"`
}

// dirStat＝一個目錄「這一層直接放的檔案」的分類計數（不含子目錄；子樹合計由畫面自己疊，
// 存兩套就是同一件事兩份實作，遲早對不起來）。
//
// 🔴 不變式：`total == supported + unsupported + excluded`。
// 少一類就會出現「兩個數字的差額解釋不了」，而那正是 leo 這條規格要解掉的病。
type dirStat struct {
	total       int // 這一層看得到的檔案總數（分母）
	supported   int // 通過所有閘、進了 manifest 的（＝分子的候選）
	unsupported int // 副檔名還讀不了的（docLikeExt 與其他）
	excluded    int // 收檔策略／範本身分決定不收的（程式碼多半落這裡）
}

// MaxExcludedDirsListed：最多逐筆列幾個被跳過的目錄。超過的只反映在 ExcludedDirCount
// （同 MaxSkippedListed 的道理：狀態檔不該被撐成一面看不完的清單牆）。
const MaxExcludedDirsListed = 20

// FormatDuplicate＝同一份內容被偵測到有多種格式並存（同檔名主幹、不同副檔名）。
//
// 🔴 為什麼要有這個（2026-08-07，leo 實據）：封測者 Evan 給的資料集
// 27,164 檔＝9,045 個 md＋9,044 個 json＋9,043 個 html，是同一批來源轉出的三種格式
// （`markdown/160-00F3_001.md` 與 `json/160-00F3_001.json` 逐一對應，同錯誤碼、同變體號）。
// 現行設計不知道這件事，會把三種格式各當一份新檔，萃三次、吃三倍額度——
// 使用者不會知道要挑一種，這是我們該擋的，不是他該懂的。
//
// 判準：檔名主幹（去副檔名、轉小寫）在整個看守根內相同 → 視為同一份內容的不同格式匯出，
// 只留優先序最高的一份進事件管線，其餘標記在這裡（不產生 added/modified/renamed 事件）。
//
// ⚠️ 已知的取捨：純靠檔名主幹比對，不比對內容——兩個不相干的檔恰好同名不同副檔名
// （如兩個專案各自的 `README.md`／`README.pdf`）會被誤判成同一份。刻意接受這個風險，
// 因為：①這不是靜默丟棄——DuplicateFormats 會被 direct.go 收進 status.json 讓使用者看到
// 「跳過：與 X 視為同一格式」，看起來不對可以改檔名破解誤判；②不比對，就是 leo 實據的
// md/json 案例（不同目錄、不同副檔名，唯一共同點正是檔名主幹）根本擋不掉。
//
// 🔴 刻意不寫進 manifest（同 Skipped 的理由，見上方 SkippedFile 註解）：每輪由檔案系統
// 重算，勝出者若之後消失，下一輪換另一份自然遞補，不留跨輪狀態要維護。
type FormatDuplicate struct {
	Path     string `json:"path"`      // 被跳過的那份
	KeptPath string `json:"kept_path"` // 真正進事件管線的那份
	Stem     string `json:"stem"`      // 判定依據：去副檔名、轉小寫後的檔名主幹
}

// dedupFormatPriority：格式去重時「留誰」的優先序（越前面越優先留下）。
// 原則：越接近「使用者原始編輯」的格式排越前面（docx/pptx 是可編輯原稿），
// md/markdown 常是**從別的格式轉出的產物**（leo 實據的資料集正是 html→chm 轉出 md/json），
// 排在轉檔產物之前但在原生辦公格式之後。不在表內的副檔名排最後（理論上不會發生，
// current 只收 allowedExt）。
var dedupFormatPriority = []string{".docx", ".pptx", ".xlsx", ".csv", ".pdf", ".md", ".markdown", ".txt"}

func formatPriority(relPath string) int {
	ext := strings.ToLower(filepath.Ext(relPath))
	for i, e := range dedupFormatPriority {
		if e == ext {
			return i
		}
	}
	return len(dedupFormatPriority)
}

// dedupStemOf 回傳去重判準：檔名主幹（basename 去副檔名），轉小寫（跨平台大小寫不敏感）。
// 刻意只看 basename、不看目錄——leo 實據的 md/json 恰好活在不同的兄弟目錄
// （markdown/160-00F3_001.md vs json/160-00F3_001.json），只有 basename 主幹相同。
func dedupStemOf(relPath string) string {
	base := filepath.Base(relPath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	return strings.ToLower(stem)
}

// detectFormatDuplicates 在 current（本輪掃到、通過 allowedExt 的檔）裡找出同檔名主幹的分組，
// 每組留優先序最高的一份，其餘回報為 loser（path -> winner path）。
// 走訪用 stem 字母序＝確定性輸出（map 迭代順序不穩定）。
func detectFormatDuplicates(current map[string]fileState) (map[string]string, []FormatDuplicate) {
	byStem := map[string][]string{}
	for p := range current {
		stem := dedupStemOf(p)
		byStem[stem] = append(byStem[stem], p)
	}
	stems := make([]string, 0, len(byStem))
	for s := range byStem {
		stems = append(stems, s)
	}
	sort.Strings(stems)

	loserOf := map[string]string{}
	var dups []FormatDuplicate
	for _, stem := range stems {
		group := byStem[stem]
		if len(group) < 2 {
			continue
		}
		sort.Slice(group, func(i, j int) bool {
			pi, pj := formatPriority(group[i]), formatPriority(group[j])
			if pi != pj {
				return pi < pj
			}
			return group[i] < group[j] // 同優先序時字母序，確定性
		})
		winner := group[0]
		for _, loser := range group[1:] {
			loserOf[loser] = winner
			dups = append(dups, FormatDuplicate{Path: loser, KeptPath: winner, Stem: stem})
		}
	}
	return loserOf, dups
}

type ScanOptions struct {
	// MaxRemovedRatio：單輪 removed 數 > manifest 條目數 × 本值 → 觸發大量刪除防呆（R6）。
	MaxRemovedRatio float64
	// SkipPaths：絕對路徑黑名單（如 manifest 檔自己住在 root 底下時）。
	SkipPaths map[string]bool
	// SkipDirNames：目錄名黑名單（任一層命中整棵跳過）。daemon-beta task 2：
	// template 代裝後 `system-dev/`（wiki 產物區）不得被當成原稿掃進 ingest。
	SkipDirNames map[string]bool
	// Plan：收檔策略（arcrun-rag#104）。
	//
	// 🔴 2026-08-16 改成「不填就自己算」（Mode == "" ⇒ Scan 自己呼叫 PlanIngest）。
	// 原本的註解寫著「要拿到 #104 的效果就傳 PlanIngest(root)」——也就是**排除規則
	// 要不要生效，取決於呼叫端記不記得傳**。那正是這一票（以及同一天 #88、#46、
	// Arcrun#125）的共同形狀：**能力做好了，而它不在會被執行的那條路上**。
	// 讓走訪器自己裝上判準，「忘了接」這個失敗模式就不存在了。
	// 呼叫端仍可覆寫（測試要造特定情境時照傳即可）。
	Plan IngestPlan
}

const DefaultMaxRemovedRatio = 0.4

type fileState struct {
	hash  string // sha256:<hex>
	size  int64
	mtime int64
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

func r2KeyOf(sourceHash string) string {
	return "raw/" + strings.TrimPrefix(sourceHash, "sha256:")
}

// Scan 走訪 root、對照並更新 manifest、產出一輪事件。
// manifest 更新原則：content_hash/size/mtime 反映現況；ingested_hash/ingested_at
// 只搬運（renamed）與保留（modified），本函式永不設值——那是上傳成功後的事。
func Scan(root string, m *Manifest, opts ScanOptions) (*TriggerPayload, error) {
	if opts.MaxRemovedRatio <= 0 {
		opts.MaxRemovedRatio = DefaultMaxRemovedRatio
	}
	// 🔴 呼叫端沒給策略就自己算——見 ScanOptions.Plan 的說明。
	// 這一行就是「排除規則不可能不在執行路徑上」的保證本身。
	if opts.Plan.Mode == "" {
		opts.Plan = PlanIngest(root)
	}
	orig := m.Entries
	manifestCountBefore := len(orig)

	// 1) 走訪檔案系統，建立現況（mtime+size fast-path：沒變→沿用 manifest hash，變了才算 sha256）。
	current := map[string]fileState{}
	var skipped []SkippedFile
	skippedOther := 0
	var skippedOtherNames []string
	// arcrun-rag#104：被策略擋掉的檔案數。**一定要數出來**——票上的紅線是
	// 「用戶要知道有 8,000 個檔沒被收，因為它們是程式碼」，不是安靜地少收。
	excludedByPlan := 0
	// 整棵剪掉的目錄與理由。**剪掉的重點就是不走進去**，所以這裡記的是目錄不是檔案數
	// ——使用者要知道的本來就是「哪幾個資料夾沒收、為什麼」。見 ExcludedDir 的說明。
	var excludedDirs []ExcludedDir
	// InkStoneCo#44 線 A：逐目錄的分母。與上面幾個計數器同一趟走訪算出來——
	// 判準只有這一份，畫面上的數字才可能與實際收的檔對得起來。
	dirStats := map[string]*dirStat{"": {}} // 根一定存在（空資料夾也要有節點，arcrun-rag#106）
	statOf := func(relSlash string) *dirStat {
		dir := folderOfRel(relSlash)
		st, ok := dirStats[dir]
		if !ok {
			st = &dirStat{}
			dirStats[dir] = st
		}
		return st
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		name := d.Name()
		relOf := func() (string, bool) {
			rel, rerr := filepath.Rel(root, p)
			if rerr != nil {
				return "", false
			}
			return filepath.ToSlash(rel), true
		}
		if d.IsDir() {
			if p != root && strings.HasPrefix(name, ".") {
				return filepath.SkipDir // 隱藏目錄（.git、.obsidian…）整棵跳過
			}
			if p != root && opts.SkipDirNames[name] {
				return filepath.SkipDir // 名單目錄（呼叫端自訂）整棵跳過
			}
			// #104：依策略整棵跳過（使用者的 .gitignore／依賴／建置產物／範本／
			// worktree／巢狀 repo／以及非本次策略要收的區域）。
			// 🔴 每一次剪枝都要留下「哪一個、為什麼」——票上的紅線是排除規則要看得見，
			//    而 2026-08-16 實測發現原本整棵剪掉的部分完全沒有被記錄。
			if p != root {
				if rel, ok := relOf(); ok {
					if skip, why := opts.Plan.SkipsDirWhy(rel, p); skip {
						excludedDirs = append(excludedDirs, ExcludedDir{Path: rel, Reason: why})
						return filepath.SkipDir
					}
					// #44 線 A：走得進去的目錄一律登記，**就算它一個檔都沒有**
					// ——leo 的規格是「不管那層有沒有文件，整棵樹都要採」。
					if _, ok := dirStats[rel]; !ok {
						dirStats[rel] = &dirStat{}
					}
				}
			}
			return nil
		}
		if strings.HasPrefix(name, ".") {
			return nil
		}
		if rel, ok := relOf(); ok && !opts.Plan.KeepsFile(rel) {
			excludedByPlan++
			// #44 線 A：這是「使用者看得到、但我們決定不收」的檔（程式碼多半落在這裡）。
			// 它**要算進分母**——leo 的規格就是「兩個數字不相等是正常的，差額＝不支援」，
			// 而分母裡沒有它，差額就永遠解釋不了。
			s := statOf(rel)
			s.total++
			s.excluded++
			return nil
		}
		if abs, aerr := filepath.Abs(p); aerr == nil && opts.SkipPaths[abs] {
			return nil
		}
		// 🔴 2026-08-06 leo：template 的東西不是使用者的知識，一律不收。
		//    **用路徑身分認，不用「有沒有以點開頭」認**——leo 自己的 repo 裡
		//    template 本來就不是隱藏的，靠隱藏判斷會漏掉一大半。
		//    也不計進「有 N 個檔案沒有被整理」——那是給使用者看他自己的檔案的，
		//    我們自己鋪的東西不該佔用他的注意力。
		//
		// 🔴 arcrun-rag#104 例外：curated-wiki 模式下，`system-dev/wiki/` **正是要收的那一份**。
		//    上面那條規則（2026-08-06）與 leo 2026-08-14 的規格直接對撞，衝突由身分化解：
		//    · 我們代裝 template 的資料夾（沒有 `.git`）⇒ 那些檔是**我們鋪的**，照舊不收
		//    · 使用者自己的 repo（有 `.git`）⇒ 那份 wiki 是**他寫的**，正是他要我們讀的
		//    判準只有 PlanIngest 一個地方，見 ingestplan.go。
		if rel, rerr := filepath.Rel(root, p); rerr == nil {
			relSlash := filepath.ToSlash(rel)
			if TemplateOwns(relSlash) && !opts.Plan.OverridesTemplateOwned(relSlash) {
				return nil
			}
		}
		ext := strings.ToLower(filepath.Ext(name))
		// #44 線 A：走到這裡的都是「使用者自己的、看得見的」檔——上面三道
		// （隱藏檔／SkipPaths 的機器檔／TemplateOwns 我們自己鋪的範本）刻意不算進分母，
		// 理由與 scan.go 既有註解同一條：**我們自己鋪的東西不該佔用他的注意力**。
		if rel, ok := relOf(); ok {
			s := statOf(rel)
			s.total++
			if allowedExt[ext] {
				s.supported++
			} else {
				s.unsupported++
			}
		}
		if !allowedExt[ext] {
			// G-6.2：**這裡以前是條死巷**——`return nil` 之後這個檔就從世界上消失了。
			// 現在留個名，讓 direct.go 有東西可以寫進 status.json、App 有東西可以顯示。
			if docLikeExt[ext] {
				if rel, rerr := filepath.Rel(root, p); rerr == nil {
					skipped = append(skipped, SkippedFile{Path: filepath.ToSlash(rel), Ext: ext})
				}
			} else {
				skippedOther++
				// 只留前幾個：多了就變噪音（Obsidian 附件庫可能有幾百張 .png）。
				if len(skippedOtherNames) < maxOtherNames {
					if rel, rerr := filepath.Rel(root, p); rerr == nil {
						skippedOtherNames = append(skippedOtherNames, filepath.ToSlash(rel))
					}
				}
			}
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		st := fileState{size: info.Size(), mtime: info.ModTime().Unix()}
		if e, ok := orig[rel]; ok && e.ContentHash != "" && e.Mtime == st.mtime && e.Size == st.size {
			st.hash = e.ContentHash // fast-path：mtime+size 沒變，跳過重算
		} else {
			h, herr := hashFile(p)
			if herr != nil {
				return herr
			}
			st.hash = h
		}
		current[rel] = st
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 1.5) 同內容多格式去重（2026-08-07）：先決定誰是 loser，事件管線全程跳過它們。
	dupLoser, duplicateFormats := detectFormatDuplicates(current)

	// 2) 初分：added 候選（現況有、manifest 無）與 removed 候選（manifest 有、現況無）。
	//    loser 不進候選——它不該被當成新檔，也不該被當成 rename 的另一端。
	var addedPaths, removedPaths []string
	for p := range current {
		if dupLoser[p] != "" {
			continue
		}
		if _, ok := orig[p]; !ok {
			addedPaths = append(addedPaths, p)
		}
	}
	for p := range orig {
		if _, ok := current[p]; !ok {
			removedPaths = append(removedPaths, p)
		}
	}
	sort.Strings(addedPaths)
	sort.Strings(removedPaths)

	// 3) 先配對 renamed（design §3 順序 1）：removed×added 以 content_hash 配對，
	//    配上＝只更新路徑映射，不 retire、不重萃、不重傳。同 hash 多候選→排序後貪婪配對（確定性）。
	removedByHash := map[string][]string{}
	for _, p := range removedPaths {
		h := orig[p].ContentHash
		removedByHash[h] = append(removedByHash[h], p)
	}
	renamedOldOf := map[string]string{} // newPath -> oldPath
	pairedOld := map[string]bool{}
	var events []Event
	for _, np := range addedPaths {
		h := current[np].hash
		cands := removedByHash[h]
		if len(cands) == 0 {
			continue
		}
		op := cands[0]
		removedByHash[h] = cands[1:]
		pairedOld[op] = true
		renamedOldOf[np] = op
		events = append(events, Event{Type: "renamed", Path: np, OldPath: op, SourceHash: h})
	}

	// 4) added：真新檔＋「曾偵測但從未成功 ingest」的檔（重試語意，design §2）。
	sortedCurrent := make([]string, 0, len(current))
	for p := range current {
		sortedCurrent = append(sortedCurrent, p)
	}
	sort.Strings(sortedCurrent)
	addedEvent := func(p string) Event {
		st := current[p]
		size := st.size
		return Event{Type: "added", Path: p, SourceHash: st.hash, Size: &size, R2Key: r2KeyOf(st.hash)}
	}
	for _, p := range sortedCurrent {
		if dupLoser[p] != "" { // 同內容的另一格式已在事件管線，這份跳過（1.5）
			continue
		}
		if op, isRenamed := renamedOldOf[p]; isRenamed {
			if orig[op].IngestedHash == "" { // 改名的檔其實從未 ingest 成功 → 補一發 added
				events = append(events, addedEvent(p))
			}
			continue
		}
		if _, existed := orig[p]; !existed {
			events = append(events, addedEvent(p)) // 真新檔
		} else if orig[p].IngestedHash == "" {
			events = append(events, addedEvent(p)) // 上輪偵測過但 ingest 未成功 → 重試
		}
	}

	// 5) modified：manifest 有、現況有、content_hash != ingested_hash（design §3 順序 3）。
	for _, p := range sortedCurrent {
		if dupLoser[p] != "" { // 同內容的另一格式已在事件管線，這份跳過（1.5）
			continue
		}
		e, existed := orig[p]
		if !existed {
			continue
		}
		if _, isRenamed := renamedOldOf[p]; isRenamed {
			continue
		}
		if e.IngestedHash != "" && current[p].hash != e.IngestedHash {
			st := current[p]
			size := st.size
			events = append(events, Event{Type: "modified", Path: p, SourceHash: st.hash, Size: &size, R2Key: r2KeyOf(st.hash)})
		}
	}

	// 6) removed（扣掉已配對走的）＋大量刪除防呆（R6）。
	var finalRemoved []string
	for _, p := range removedPaths {
		if !pairedOld[p] {
			finalRemoved = append(finalRemoved, p)
		}
	}
	var warnings []Warning
	guardTripped := manifestCountBefore > 0 &&
		float64(len(finalRemoved)) > opts.MaxRemovedRatio*float64(manifestCountBefore)
	if guardTripped {
		warnings = append(warnings, Warning{
			Code: "mass_delete_guard",
			Message: fmt.Sprintf(
				"本輪偵測到 %d/%d 個檔案消失（超過 %.0f%% 門檻）——可能是資料夾未掛載或同步半途。本輪全部「不」下架，請確認資料夾完好後再放行。",
				len(finalRemoved), manifestCountBefore, opts.MaxRemovedRatio*100),
			RemovedCount:   len(finalRemoved),
			ManifestCount:  manifestCountBefore,
			ThresholdRatio: opts.MaxRemovedRatio,
		})
	} else {
		for _, p := range finalRemoved {
			events = append(events, Event{Type: "removed", Path: p, SourceHash: orig[p].ContentHash})
		}
	}

	// 7) 更新 manifest（rebuild）：現況檔全數收錄；ingested_* 由舊 entry（或 renamed 的舊路徑）搬運。
	//    防呆觸發時 removed 條目保留（下輪重評、警告會再響，直到人確認或檔案回來）。
	newEntries := make(map[string]*ManifestEntry, len(current))
	for p, st := range current {
		ne := &ManifestEntry{ContentHash: st.hash, Size: st.size, Mtime: st.mtime}
		var carry *ManifestEntry
		if op, isRenamed := renamedOldOf[p]; isRenamed {
			carry = orig[op]
		} else if e, ok := orig[p]; ok {
			carry = e
		}
		if carry != nil {
			ne.IngestedHash = carry.IngestedHash
			ne.IngestedAt = carry.IngestedAt
			// 🔴 t195：掃描每輪都**重建** entry，原本只 carry 上面兩欄 ⇒ 其餘欄位靜默歸零。
			//   實撞：失敗退避（fail_count/next_retry）寫進去了，下一輪掃描卻被抹掉
			//   ⇒ 退避永遠停在「第 1 次失敗」，等同沒有退避（1387 輪的病根之一）。
			//   ExtractedBy（t73 記的「誰萃的」）原本也一樣悄悄丟失。
			//   ⚠️ 之後在 ManifestEntry 新增任何「跨輪要記住」的欄位，都必須加在這裡。
			ne.ExtractedBy = carry.ExtractedBy
			ne.FailCount = carry.FailCount
			ne.LastFailAt = carry.LastFailAt
			ne.NextRetry = carry.NextRetry
			// 🔴 2026-08-08（Evan 封測回報「20 份沒送進知識庫」但展開看不到真因）：
			//   LastError 是 t195 同一批加的欄位，卻**漏在這個 carry 裡** ⇒
			//   每輪掃描（預設 5 秒）就把失敗真因抹掉一次，下一輪退避訊息組不出「｜原因：」
			//   ⇒ 畫面只剩 humanizeFailure 的最後退路「當時沒有記下原因」。
			//   這正是上面那句警告的第二次實例——真因是我們自己刪掉的，不是沒記。
			ne.LastError = carry.LastError
			// 🔴 #140（2026-08-26）：雲端對帳的三個欄位同樣要 carry，而且漏了會**很貴**：
			//   - CloudCheckedAt 歸零 ⇒ 每輪都判「太久沒對帳」⇒ 每輪重問整批（請求風暴）
			//   - CloudMissingAt 歸零 ⇒ **防重送迴圈的 grace 消失** ⇒ 補送 → 下一輪又拔章
			//     → 再補送…把使用者的 AI 額度燒光（票上明文禁止的「把一個 bug 換成另一個」）
			//   - NoCloudCard 歸零 ⇒ 沒卡可送的檔每天被重萃一次，永遠停不下來
			//   這正是上面那句警告（t195／LastError 5fcc139）的第三次實例，所以照著它走。
			ne.CloudCheckedAt = carry.CloudCheckedAt
			ne.CloudMissingAt = carry.CloudMissingAt
			ne.NoCloudCard = carry.NoCloudCard
		}
		newEntries[p] = ne
	}
	if guardTripped {
		for _, p := range finalRemoved {
			newEntries[p] = orig[p]
		}
	}
	m.Entries = newEntries
	m.Root = root

	if events == nil {
		events = []Event{}
	}
	sort.Slice(skipped, func(i, j int) bool { return skipped[i].Path < skipped[j].Path })
	// 排序＝畫面每輪穩定；裁切前先記總數，不然「等 N 個」會少報。
	sort.Slice(excludedDirs, func(i, j int) bool { return excludedDirs[i].Path < excludedDirs[j].Path })
	excludedDirCount := len(excludedDirs)
	// #44 線 A：樹要畫得完整，需要**未裁切**的全量（下面那個裁切是給狀態列用的）。
	// 先複製再裁切——共用同一個底層陣列的話，裁切會讓樹跟著少一截。
	allExcludedDirs := make([]ExcludedDir, len(excludedDirs))
	copy(allExcludedDirs, excludedDirs)
	if len(excludedDirs) > MaxExcludedDirsListed {
		excludedDirs = excludedDirs[:MaxExcludedDirsListed]
	}
	return &TriggerPayload{
		SchemaVersion:     1,
		FolderID:          m.FolderID,
		Root:              root,
		GeneratedAt:       time.Now().Unix(),
		Events:            events,
		Warnings:          warnings,
		Skipped:           skipped,
		SkippedOther:      skippedOther,
		SkippedOtherNames: skippedOtherNames,
		DuplicateFormats:  duplicateFormats,
		Plan:              opts.Plan,
		ExcludedByPlan:    excludedByPlan,
		ExcludedDirs:      excludedDirs,
		ExcludedDirCount:  excludedDirCount,
		DirStats:          dirStats,
		AllExcludedDirs:   allExcludedDirs,
	}, nil
}
