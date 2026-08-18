// inventory.go — 結構先行：掃描一結束就把「這個資料夾有哪些檔案／最近改了什麼」
// 做成**機械總覽卡**送上知識庫（InkStoneCo#43，2026-08-15）。
//
// 為什麼要有這個（leo 2026-08-15 量測）：266 個可萃檔真正花在算的只有 ~20 分鐘、
// 成本 < $0.5，但使用者實際等了 ~4 天——多數時間在等 Workers AI 每日額度隔天恢復。
// 而「這裡面有哪些檔案／最近改了什麼」這種**本地掃一遍就有答案、免費、秒級**的問題
// （實測 1,335 檔含逐檔 SHA256 只要 0.254 秒），原本跟「這份文件在講什麼」排同一條隊、
// 撞同一面額度牆——因為 part_of 目錄邊只在雲端 parse_card（LLM 萃取之後）才會長出來。
//
// 設計取捨（為什麼走 rag_ingest_card、不開新 workflow）：
//   - 每個用戶實例**本來就裝著** rag_ingest_card（compile-workflows.mjs 的四條之一），
//     走它＝今天所有既有實例直接受益，不需要任何雲端部署／升級。
//   - 它自帶同頁名 upsert（pick_stale 先刪舊再寫）＝重送不堆副本，冪等免費拿到。
//   - 它零 LLM（機械切塊＋寫 KBDB）＝不吃 neurons、額度冷卻期間照常可用。
//   - 卡片的「## 關聯」段天生會被 parse 成 triplets ⇒ 目錄結構直接長進圖譜，
//     rag-chat 的 fetch_triplets／kw_search 都查得到，檢索端零改動。
//
// 紅線對齊：本檔**不寫任何本機檔案**（總覽卡只存在於雲端），不動使用者原稿；
// 資料一律走 webhook API（KBDB API-as-Wall，D38）。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"
)

const (
	// maxInventoryListed：「## 檔案清單」逐檔點名的上限。超過就改列各目錄份數——
	// 與 scan.go maxOtherNames 同一個判準：少量點名有資訊量，巨量點名是噪音；
	// 也守住 rag_ingest_card 端的量（block 過大／foreach 過多都會踩雲端上限，
	// 見 wiki mistakes「http_request 零件抓大回應直接爆」）。
	maxInventoryListed = 200
	// maxInventoryRecent：「## 最近改了什麼」條數上限。
	maxInventoryRecent = 20
	// maxInventoryRels：「## 關聯」（目錄 part_of）條數上限。刻意壓低：
	// rag_ingest_card 對每條 rel 各發一個 POST（foreach），加上 upsert 前置的
	// 逐筆 DELETE，rel 太多會撞 Workers 免費層 50 subrequests/請求的天花板。
	maxInventoryRels = 10
	// maxInventoryDirLines：巨量模式下「各目錄份數」最多列幾行。
	maxInventoryDirLines = 30
)

// inventoryPageName 回傳總覽卡的頁名。含資料夾 basename＝人看得懂「這是哪個資料夾」；
// 不同監看根的 basename 相同時靠 library（每根唯一）分頁，見 inventoryCardPath。
func inventoryPageName(absRoot string) string {
	base := path.Base(strings.ReplaceAll(strings.TrimRight(absRoot, "/\\"), "\\", "/"))
	if base == "" || base == "." || base == "/" {
		base = "知識資料夾"
	}
	return "資料夾總覽：" + base
}

// inventoryCardPath 回傳總覽卡的合成路徑（雲端 source_uri 用的鍵，**不落地本機**）。
// 掛在 .arcrun-rag/（機器工作區目錄，machinemark.go 的既有標記慣例）底下＝一眼可辨
// 「這是 Arcrun 產的、不是使用者的檔」；帶 library（每個監看根唯一，librarySlug 有
// 雜湊後備）＝同帳號多資料夾時 source_uri 不互撞。
func inventoryCardPath(library string) string {
	return ".arcrun-rag/wiki/cards/arcrun-資料夾總覽-" + library + ".md"
}

// invFile 是總覽卡的最小輸入（從 manifest entries 抽出，便於排序與測試）。
type invFile struct {
	path  string
	mtime int64
}

// invDateOf 把 mtime 格式化成使用者看的日期（本機時區；使用者要的是「哪天改的」量級）。
func invDateOf(mtime int64) string {
	if mtime <= 0 {
		return "（日期不明）"
	}
	return time.Unix(mtime, 0).Local().Format("2006-01-02")
}

// invTopDirOf 回傳相對路徑的第一層目錄；根層檔案回「（根目錄）」。
func invTopDirOf(rel string) string {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if i := strings.IndexByte(rel, '/'); i > 0 {
		return rel[:i]
	}
	return "（根目錄）"
}

// BuildInventoryCard 把 manifest entries（Scan 後＝檔案系統現況）做成一張機械總覽卡。
// 純函式、零 IO、輸出確定（同一份輸入永遠同一份輸出）——冪等判斷（內容雜湊）與
// 測試都靠這一點。回傳（頁名, 卡片 markdown）。
func BuildInventoryCard(absRoot string, entries map[string]*ManifestEntry, library string) (string, string) {
	page := inventoryPageName(absRoot)

	files := make([]invFile, 0, len(entries))
	for p, e := range entries {
		if e == nil {
			continue
		}
		files = append(files, invFile{path: strings.ReplaceAll(p, "\\", "/"), mtime: e.Mtime})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })

	var b strings.Builder
	sep := " " + strings.Repeat(">", 2) + " " // 三元組分隔符（組字串產生，同 lint_test 慣例）

	b.WriteString("# " + page + "\n\n")

	// ── 一句話定義：總數＋格式分佈 ──
	extCount := map[string]int{}
	for _, f := range files {
		ext := strings.ToLower(path.Ext(f.path))
		if ext == "" {
			ext = "（無副檔名）"
		}
		extCount[ext]++
	}
	exts := make([]string, 0, len(extCount))
	for e := range extCount {
		exts = append(exts, e)
	}
	sort.Slice(exts, func(i, j int) bool {
		if extCount[exts[i]] != extCount[exts[j]] {
			return extCount[exts[i]] > extCount[exts[j]]
		}
		return exts[i] < exts[j]
	})
	extParts := []string{}
	for i, e := range exts {
		if i >= 5 {
			rest := 0
			for _, e2 := range exts[i:] {
				rest += extCount[e2]
			}
			extParts = append(extParts, fmt.Sprintf("其他 %d 份", rest))
			break
		}
		extParts = append(extParts, fmt.Sprintf("%s %d 份", strings.TrimPrefix(e, "."), extCount[e]))
	}
	b.WriteString("## 一句話定義\n")
	if len(files) == 0 {
		b.WriteString("這個資料夾目前沒有可收錄的文件（本頁由掃描自動整理，隨檔案變動即時更新，不經 AI 萃取）。\n\n")
	} else {
		b.WriteString(fmt.Sprintf("這個資料夾目前有 %d 份文件（%s），本頁由掃描自動整理，隨檔案變動即時更新，不經 AI 萃取。\n\n",
			len(files), strings.Join(extParts, "、")))
	}

	// ── 最近改了什麼：mtime 新到舊，路徑字母序破平 ──
	recent := make([]invFile, len(files))
	copy(recent, files)
	sort.Slice(recent, func(i, j int) bool {
		if recent[i].mtime != recent[j].mtime {
			return recent[i].mtime > recent[j].mtime
		}
		return recent[i].path < recent[j].path
	})
	if n := len(recent); n > maxInventoryRecent {
		recent = recent[:maxInventoryRecent]
	}
	b.WriteString("## 最近改了什麼\n")
	if len(recent) == 0 {
		b.WriteString("（目前沒有檔案）\n")
	}
	for _, f := range recent {
		b.WriteString("- " + invDateOf(f.mtime) + "　" + f.path + "\n")
	}
	b.WriteString("\n")

	// ── 檔案清單：少量逐檔點名（含日期），巨量改列各目錄份數＋每目錄最新一檔 ──
	dirCount := map[string]int{}
	dirNewest := map[string]invFile{}
	for _, f := range files {
		d := invTopDirOf(f.path)
		dirCount[d]++
		if cur, ok := dirNewest[d]; !ok || f.mtime > cur.mtime || (f.mtime == cur.mtime && f.path < cur.path) {
			dirNewest[d] = f
		}
	}
	dirs := make([]string, 0, len(dirCount))
	for d := range dirCount {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool {
		if dirCount[dirs[i]] != dirCount[dirs[j]] {
			return dirCount[dirs[i]] > dirCount[dirs[j]]
		}
		return dirs[i] < dirs[j]
	})

	b.WriteString("## 檔案清單\n")
	switch {
	case len(files) == 0:
		b.WriteString("（目前沒有檔案）\n")
	case len(files) <= maxInventoryListed:
		for _, f := range files {
			b.WriteString("- " + f.path + "（" + invDateOf(f.mtime) + "）\n")
		}
	default:
		b.WriteString(fmt.Sprintf("共 %d 份，檔案較多，以下列各目錄的份數與最新一檔：\n", len(files)))
		for i, d := range dirs {
			if i >= maxInventoryDirLines {
				rest := 0
				for _, d2 := range dirs[i:] {
					rest += dirCount[d2]
				}
				b.WriteString(fmt.Sprintf("- （其餘 %d 個目錄共 %d 份）\n", len(dirs)-i, rest))
				break
			}
			nf := dirNewest[d]
			b.WriteString(fmt.Sprintf("- %s：%d 份（最新：%s，%s）\n", d, dirCount[d], nf.path, invDateOf(nf.mtime)))
		}
	}
	b.WriteString("\n")

	// ── 關聯：目錄 part_of 總覽頁（parse_card 會再自動補「總覽頁 part_of knowledge-base」）──
	b.WriteString("## 關聯\n")
	relDirs := dirs
	if len(relDirs) > maxInventoryRels {
		relDirs = relDirs[:maxInventoryRels]
	}
	for _, d := range relDirs {
		if d == "（根目錄）" {
			continue
		}
		b.WriteString("- " + d + sep + "part_of" + sep + page + "\n")
	}

	return page, b.String()
}

// inventoryRetryDelay：總覽卡送失敗後，同一份內容多久以後才准再試。
// 積壓卡住時每輪都有事件（hasEvents 恆真），沒有這道退避，雲端一壞就是
// 每 5 秒撞一次（t195 的 1387 輪教訓，同款病）。內容變了（雜湊不同）不受此限。
const inventoryRetryDelay = 10 * time.Minute

// syncInventory 在每輪掃描後、逐檔萃取**之前**送總覽卡。回 nil＝這輪不必送。
//
// 冪等／防撞四層：①卡片內容 sha256 記在 manifest.inventory_hash，內容沒變不送；
// ②同一份內容剛送失敗過（inventory_fail_hash）→ 10 分鐘內不重試；
// ③已有成功版本且本輪無事件 → 不送（總覽跟著變動走，不跟著輪詢走）；
// ④雲端 rag_ingest_card 自帶同頁名 upsert，就算重送也不堆副本。
//
// 失敗不擋同步主流程（不設 exit）：總覽是加值層，它壞了檔案同步照常走；
// 但誠實回報 failed result，不假綠。額度用完的失敗換成人話（不裸露 4006/502，
// 同 2026-08-07 task 2 的判準），其餘失敗保留原文（遠端查得到真因，08-06 教訓）。
func syncInventory(cfg *DirectConfig, absRoot string, m *Manifest, hasEvents, dryRun bool, now time.Time) *DirectResult {
	lib := cfg.libraryFor(absRoot)
	page, card := BuildInventoryCard(absRoot, m.Entries, lib)
	if len(m.Entries) == 0 && m.InventoryHash == "" {
		return nil // 空資料夾且從沒公告過＝沒東西好說
	}
	sum := sha256.Sum256([]byte(card))
	h := "sha256:" + hex.EncodeToString(sum[:])
	if h == m.InventoryHash {
		return nil // 冪等①：內容沒變（也涵蓋大量刪除防呆輪：entries 保留＝雜湊不變）
	}
	if h == m.InventoryFailHash && now.Unix() < m.InventoryNextRetry {
		return nil // 防撞②：同一份內容剛失敗過，退避窗口內不重撞
	}
	if !hasEvents && m.InventoryHash != "" {
		return nil // ③：已有成功版本的靜止輪不重送
	}
	res := &DirectResult{Type: "inventory", Path: inventoryCardPath(lib)}
	if dryRun {
		res.Status = "planned"
		return res
	}
	pace() // 觸發雲端前一律節流（2026-08-07 pacing 慣例）
	wf := cfg.CardIngestWF
	if wf == "" {
		wf = "rag_ingest_card"
	}
	// machine（`inkstone/mira#6`）：總覽卡的 path 是**合成**的（inventoryCardPath），
	// 只帶 library ⇒ 兩台機器上同名的資料夾會生出一模一樣的鍵，後同步的那台會把
	// 前一台的總覽卡蓋掉。這裡與逐檔卡走同一組欄位，不另開一種。
	mach := cfg.machineIdentity()
	status, _, err := cfg.postJSON(cfg.triggerURL(wf), map[string]any{
		"page_name":     page,
		"path":          res.Path,
		"card_content":  card,
		"library":       lib,
		"machine":       mach.ID,
		"machine_label": mach.Label,
	})
	res.HTTPStatus = status
	if err != nil {
		res.Status = "failed"
		if isQuotaExhausted(err.Error()) {
			// 額度訊息不裸露錯誤碼（同 task 2 判準）；額度的完整三句話由萃取路的
			// quotaState 負責，這裡只講「這件事」的狀態與下一步。
			res.Error = "雲端今天的額度用完了，資料夾總覽會稍後自動補送（不影響檔案同步）"
		} else {
			res.Error = "資料夾總覽上傳失敗（不影響檔案同步）：" + err.Error()
		}
		m.InventoryFailHash = h
		m.InventoryNextRetry = now.Add(inventoryRetryDelay).Unix()
		return res
	}
	res.Status = "ingested"
	m.InventoryHash = h
	m.InventoryFailHash = ""
	m.InventoryNextRetry = 0
	return res
}
