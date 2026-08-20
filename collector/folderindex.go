// folderindex.go — 讓目錄索引變成**碎形**：每一層資料夾各有自己的一格，父子接得起來
// （`inkstone/Arcrun#146`，leo 2026-08-19）。
//
// leo 的原話（兩句，就是本檔的全部規格）：
//
//	「daemon 可以**碎形**的在每個巢狀資料夾中產生 index & wiki」
//	「**每一層目錄指向子層次目錄**」
//
// 🔴 為什麼不是把 inventory.go 的上限調大：
//
//	`inventory.go` 的資料模型只有**兩層**——`inventoryCardPath(library)` 讓一個監看根
//	只能有一張卡，`invTopDirOf(rel)` 只取相對路徑第一段。實測（14 檔／4 層巢狀）產出
//	1 張卡、3 條「第一層 >> part_of >> 總覽頁」，第二層以下一個節點都沒有。
//	深度是**寫死在模型裡的**，不是參數。
//
// 🔴 為什麼是「一個資料夾一張卡」而不是「一張卡帶全部關聯」：
//
//	`rag_ingest_card` 對每條 rel 各發一個 POST（foreach）＋upsert 前置的逐筆 DELETE。
//	把 N 個目錄的關聯塞進同一張卡 ⇒ 單一請求 N 條 rel ⇒ 撞 Workers 免費層
//	**50 subrequests／請求**的天花板（`inventory.go` 的 `maxInventoryRels = 10`
//	就是為了這面牆才壓的）。拆成一卡一關聯後，**每個請求恆定 1 條 rel**，
//	天花板與資料夾數量脫鉤；變多的是請求「次數」，那個由既有的 `pace()` 節流吸收。
//
// 誠實界線（不要讓讀的人以為它做了沒做的事）：
//   - **空目錄不會有卡**。目錄集合是從 manifest 的檔案路徑反推的，而 `scan.go` 從來
//     沒有記錄過目錄本身（`d.IsDir()` 只用來決定要不要整棵跳過）。
//     「空資料夾也要看得見」是 `inkstone/arcrun-rag#106`，要先讓掃描記得目錄才做得到。
//   - 卡片內容是**機械統計**（檔數、子資料夾、最近改了什麼），不經 LLM ——
//     與 `inventory.go` 同一個理由：這種問題本機掃一遍就有答案，不該跟萃取排同一條隊。
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
	// maxFolderCards＝單一監看根最多產幾張資料夾卡。
	//
	// 🔴 這是一道**會被講出來**的上限，不是安靜截斷（principles「no silent caps」）：
	// 超過時 `syncFolderCards` 會在結果訊息裡指名少送了幾個、從哪一層以下開始少。
	// 200 的由來：一次同步 200 個請求已經是既有 `MaxEventsPerRun`（預設同量級）的規模，
	// 再多就該讓使用者知道「你的資料夾深到要分批」，而不是我們自己吞掉。
	maxFolderCards = 200
	// maxFolderChildrenListed＝卡片上「子資料夾」段最多列幾個。純顯示上限，
	// 不影響關聯（關聯永遠由子卡自己宣告，見檔頭）。
	maxFolderChildrenListed = 50
	// maxFolderFilesListed＝卡片上「本層檔案」最多列幾個。
	maxFolderFilesListed = 100
)

// FolderCard＝一個資料夾在雲端的那一格。
type FolderCard struct {
	// Rel＝相對監看根的路徑（`""`＝根本身，根不由本檔產卡，見 BuildFolderCards）。
	Rel string
	// Page＝雲端頁名（也是三元組裡的節點名）。
	Page string
	// Path＝合成的 source_uri 鍵（不落地本機，同 inventoryCardPath 的慣例）。
	Path string
	// Parent＝父資料夾的頁名。這就是「每一層指向子層次目錄」的那條邊的另一端。
	Parent string
	// Content＝卡片全文（markdown）。
	Content string
}

// folderCardPageName 回傳某個相對路徑的卡片頁名。
// 根用 inventoryPageName（沿用既有那張總覽卡，不另開一張打對台）；
// 子層用 `資料夾：<根名>/<相對路徑>`——帶根名是因為不同監看根可能有同名子資料夾。
func folderCardPageName(absRoot, rel string) string {
	if rel == "" {
		return inventoryPageName(absRoot)
	}
	base := path.Base(strings.ReplaceAll(strings.TrimRight(absRoot, "/\\"), "\\", "/"))
	if base == "" || base == "." || base == "/" {
		base = "知識資料夾"
	}
	return "資料夾：" + base + "/" + rel
}

// folderCardPath 回傳子資料夾卡的合成路徑。
// 帶 library（每個監看根唯一）＋相對路徑的 slug ⇒ 同帳號多資料夾不互撞。
// slug 為空（例如純中文路徑）時退成路徑雜湊，理由同 librarySlug 的 t89。
func folderCardPath(library, rel string) string {
	slug := pathSlug(rel)
	return ".arcrun-rag/wiki/cards/arcrun-資料夾-" + library + "-" + slug + ".md"
}

// pathSlug 把相對路徑轉成檔名安全的鍵。非 ASCII 一律轉底線分段（同 librarySlug 的規則），
// 全轉光就退成 sha256 前 8 hex——**路徑穩定所以鍵穩定，兩個不同路徑必然不同鍵**。
func pathSlug(rel string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range rel {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_':
			b.WriteRune(r)
			lastUnderscore = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
			lastUnderscore = false
		default:
			if !lastUnderscore && b.Len() > 0 {
				b.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	s := strings.Trim(b.String(), "_")
	sum := sha256.Sum256([]byte(rel))
	short := hex.EncodeToString(sum[:])[:8]
	if s == "" {
		return "d_" + short
	}
	// 一律接上雜湊尾碼：slug 會把「A/B」與「A_B」壓成同一個字串，
	// 只靠 slug 會讓兩個不同資料夾共用一張卡（靜默混層，同 t89 的形狀）。
	return s + "-" + short
}

// dirsFromEntries 從 manifest 的檔案路徑反推出**所有祖先目錄**（含中間層）。
// 回傳排序過的相對路徑（不含根的 ""）。
func dirsFromEntries(entries map[string]*ManifestEntry) []string {
	set := map[string]bool{}
	for p, e := range entries {
		if e == nil {
			continue
		}
		rel := strings.ReplaceAll(p, "\\", "/")
		seg := strings.Split(rel, "/")
		if len(seg) < 2 {
			continue // 根層檔案，沒有祖先目錄
		}
		for i := 1; i < len(seg); i++ {
			set[strings.Join(seg[:i], "/")] = true
		}
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// parentRel 回傳某個相對目錄的父目錄（頂層目錄的父是根，回 ""）。
func parentRel(rel string) string {
	if i := strings.LastIndexByte(rel, '/'); i > 0 {
		return rel[:i]
	}
	return ""
}

// BuildFolderCards 為每一個（含有檔案的）子資料夾各做一張卡。純函式、零 IO、輸出確定。
//
// 根本身不在回傳值裡——根那張是 `inventory.go` 的總覽卡，兩者分工不重疊：
// 總覽卡回答「這個監看根整體有什麼」，資料夾卡回答「這一層有什麼、它掛在誰底下」。
func BuildFolderCards(absRoot string, entries map[string]*ManifestEntry, library string) []FolderCard {
	dirs := dirsFromEntries(entries)

	// 每層直屬檔案 ／ 每層子目錄 ／ 每層含子孫的總檔數
	direct := map[string][]invFile{}
	subtotal := map[string]int{}
	children := map[string][]string{}
	for p, e := range entries {
		if e == nil {
			continue
		}
		rel := strings.ReplaceAll(p, "\\", "/")
		d := path.Dir(rel)
		if d == "." {
			d = ""
		}
		direct[d] = append(direct[d], invFile{path: path.Base(rel), mtime: e.Mtime})
		for cur := d; ; cur = parentRel(cur) {
			subtotal[cur]++
			if cur == "" {
				break
			}
		}
	}
	for _, d := range dirs {
		p := parentRel(d)
		children[p] = append(children[p], d)
	}
	for k := range children {
		sort.Strings(children[k])
	}

	cards := make([]FolderCard, 0, len(dirs))
	for _, rel := range dirs {
		page := folderCardPageName(absRoot, rel)
		var b strings.Builder
		sep := " " + strings.Repeat(">", 2) + " "

		b.WriteString("# " + page + "\n\n")

		b.WriteString("## 一句話定義\n")
		b.WriteString(fmt.Sprintf("這是「%s」底下的資料夾 `%s`：本層直接放了 %d 份文件，連同子資料夾共 %d 份。本頁由掃描自動整理，隨檔案變動即時更新，不經 AI 萃取。\n\n",
			path.Base(strings.ReplaceAll(strings.TrimRight(absRoot, "/\\"), "\\", "/")),
			rel, len(direct[rel]), subtotal[rel]))

		// 子資料夾：這一段就是「每一層目錄指向子層次目錄」給人看的那一面
		// （給機器看的那一面是子卡自己的「## 關聯」）。
		b.WriteString("## 子資料夾\n")
		kids := children[rel]
		if len(kids) == 0 {
			b.WriteString("（沒有子資料夾）\n")
		}
		for i, c := range kids {
			if i >= maxFolderChildrenListed {
				b.WriteString(fmt.Sprintf("- （其餘 %d 個子資料夾未列出）\n", len(kids)-i))
				break
			}
			b.WriteString(fmt.Sprintf("- %s（%d 份）\n", path.Base(c), subtotal[c]))
		}
		b.WriteString("\n")

		b.WriteString("## 本層檔案\n")
		files := direct[rel]
		sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
		if len(files) == 0 {
			b.WriteString("（本層沒有直接放文件，內容都在子資料夾裡）\n")
		}
		for i, f := range files {
			if i >= maxFolderFilesListed {
				b.WriteString(fmt.Sprintf("- （其餘 %d 份未列出）\n", len(files)-i))
				break
			}
			b.WriteString("- " + f.path + "（" + invDateOf(f.mtime) + "）\n")
		}
		b.WriteString("\n")

		// ── 關聯：**恰好一條**，指向父層。天花板與資料夾數量脫鉤的關鍵就在這裡。──
		parent := folderCardPageName(absRoot, parentRel(rel))
		b.WriteString("## 關聯\n")
		b.WriteString("- " + page + sep + "part_of" + sep + parent + "\n")

		cards = append(cards, FolderCard{
			Rel: rel, Page: page, Path: folderCardPath(library, rel),
			Parent: parent, Content: b.String(),
		})
	}
	return cards
}

// syncFolderCards 在總覽卡之後送資料夾卡。回 nil＝這輪不必送。
//
// 冪等：每張卡的內容雜湊記在 `manifest.folder_card_hashes[rel]`，沒變不送。
// 失敗不擋主流程（同 syncInventory）；額度訊息換成人話。
// 上限：`maxFolderCards`，超過的**指名講出來**，不安靜吞掉。
func syncFolderCards(cfg *DirectConfig, absRoot string, m *Manifest, hasEvents, dryRun bool, now time.Time) []DirectResult {
	if !hasEvents && len(m.FolderCardHashes) > 0 {
		return nil // 靜止輪不重送（同 syncInventory 的③）
	}
	lib := cfg.libraryFor(absRoot)
	cards := BuildFolderCards(absRoot, m.Entries, lib)
	if len(cards) == 0 {
		return nil
	}
	if m.FolderCardHashes == nil {
		m.FolderCardHashes = map[string]string{}
	}

	// 先刪掉「這輪已經不存在的資料夾」的記帳，避免雜湊表無限長大。
	live := map[string]bool{}
	for _, c := range cards {
		live[c.Rel] = true
	}
	for rel := range m.FolderCardHashes {
		if !live[rel] {
			delete(m.FolderCardHashes, rel)
		}
	}

	// 🔴 先挑「這輪真的要送的」，**再**套上限——順序反過來就會變成永遠只重試前 200 個，
	// 後面的資料夾一輩子送不上去（而且畫面上看起來一切正常）。
	type pending struct {
		card FolderCard
		hash string
	}
	var todo []pending
	for _, c := range cards {
		sum := sha256.Sum256([]byte(c.Content))
		h := "sha256:" + hex.EncodeToString(sum[:])
		if m.FolderCardHashes[c.Rel] == h {
			continue // 冪等：內容沒變
		}
		todo = append(todo, pending{card: c, hash: h})
	}
	if len(todo) == 0 {
		return nil
	}

	var dropped []string
	if len(todo) > maxFolderCards {
		for _, t := range todo[maxFolderCards:] {
			dropped = append(dropped, t.card.Rel)
		}
		todo = todo[:maxFolderCards]
	}

	var out []DirectResult
	wf := cfg.CardIngestWF
	if wf == "" {
		wf = "rag_ingest_card"
	}
	mach := cfg.machineIdentity()
	for _, t := range todo {
		c := t.card
		res := DirectResult{Type: "folder", Path: c.Path}
		if dryRun {
			res.Status = "planned"
			out = append(out, res)
			continue
		}
		pace()
		status, _, err := cfg.postJSON(cfg.triggerURL(wf), map[string]any{
			"page_name":     c.Page,
			"path":          c.Path,
			"card_content":  c.Content,
			"library":       lib,
			"machine":       mach.ID,
			"machine_label": mach.Label,
		})
		res.HTTPStatus = status
		if err != nil {
			res.Status = "failed"
			if isQuotaExhausted(err.Error()) {
				res.Error = "雲端今天的額度用完了，資料夾索引會稍後自動補送（不影響檔案同步）"
			} else {
				res.Error = "資料夾索引上傳失敗（不影響檔案同步）：" + err.Error()
			}
			out = append(out, res)
			// 這一張失敗就停手：後面幾百張多半會撞同一面牆，繼續撞只是把
			// 「一個壞掉的雲端」變成「幾百筆一樣的錯誤」（t195 的 1387 輪教訓）。
			break
		}
		res.Status = "ingested"
		m.FolderCardHashes[c.Rel] = t.hash
		out = append(out, res)
	}

	if len(dropped) > 0 {
		out = append(out, DirectResult{
			Type:   "folder",
			Status: "skipped",
			Error: fmt.Sprintf("資料夾超過單輪上限 %d 個，這輪少送 %d 個（例：%s）——下一輪會接著送",
				maxFolderCards, len(dropped), strings.Join(firstN(dropped, 3), "、")),
		})
	}
	return out
}

// firstN 取前 n 個（不足就全給）。只給訊息用。
func firstN(ss []string, n int) []string {
	if len(ss) <= n {
		return ss
	}
	return ss[:n]
}
