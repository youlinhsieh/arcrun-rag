// sourcerepair.go — 既有卡片的「### 出處」就地修正（`inkstone/Arcrun#167`）。
//
// 病（leo 2026-08-27 用 n8n 實測抓到）：卡片內文的「### 出處」寫的是 `../<檔名>`，
// 那是**卡片檔相對於原檔**的內部目錄結構。它被當成知識內容存進 KBDB，於是任何
// 接上 MCP 的 AI 問「原文在哪」都照著答——而使用者拿著 `../小果被AFTEE詐貸.pdf`
// 走不到任何地方。原稿在子資料夾時更慘：資料夾整段被弄丟。
//
// 修在產生端（wikishape.go 的 renderSourceLine）只治得了**新卡**。
// 票上寫死了「不能只修新的」⇒ 這支檔是對**既有資料**的處置。
//
// 為什麼是「就地修 + 重推」而不是「重萃」（三選一的取捨）：
//
//	重萃    每份檔要再燒一次 AI 額度，而且模型每次判斷不同 ⇒ 使用者眼前的卡會無故變樣。
//	        出處那一塊**根本不是模型寫的**（它是機械組裝的），為它重萃是白花錢。
//	留著    票上明文禁止。
//	就地修  ✅ 卡片檔在本機還在 ⇒ 重畫那一塊、原樣重推。零 LLM、內容其餘一字不動。
//
// 重推為什麼是安全的：`rag_ingest_card` 進門先刪同 page_name＋同 source_path 的舊
// blocks／triplets 再寫（見該 workflow 的 list_old_blocks／pick_stale）⇒ 同一張卡
// 推第二次是取代，不是疊加。
//
// 三條自我約束：
//   - **一次只修一批**（sourceRepairBatch）：巨量資料夾不該一輪湧完。
//   - **修完蓋章就不再跑**（Manifest.SourceOriginRepairedAt）：不是每輪掃一次全庫。
//   - **推失敗不蓋章**：下一輪繼續，但也不重推已經成功的（章是逐檔記在 wiki manifest 上）。
package collector

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// sourceRepairBatch＝單輪最多修幾份文件（含重推）。
// 與 cloudAuditBatch 同一個精神：積壓再多也不該一輪湧完。
const sourceRepairBatch = 20

// legacySourceMark＝舊形出處的指紋。只認這一個字面，認不到就不動它
//（已經是新形的、或使用者自己手改過的，一律不碰）。
const legacySourceMark = "- `../"

// sourceHeading＝出處那一塊的標題行。
const sourceHeading = "### 出處"

type sourceRepairResult struct {
	Scanned  int    // 這一輪看過幾份文件
	Rewrote  int    // 本機卡片被重畫的份數
	Repushed int    // 成功重推上雲的份數
	Err      string // 最後一個錯誤（原文照留，leo 2026-08-06 的原則）
	Done     bool   // 這個監看根已經全部處理完
}

// hasLegacySourceLine 回答「這張卡的出處還是舊形嗎」。
func hasLegacySourceLine(card string) bool {
	i := strings.Index(card, sourceHeading)
	if i < 0 {
		return false
	}
	return strings.Contains(card[i:], legacySourceMark)
}

// rewriteSourceBlock 把卡片裡的「### 出處」整塊換成新形。
// 找不到那一塊＝不是本塑形層產的卡，原樣回傳（不亂加東西）。
func rewriteSourceBlock(card string, o SourceOrigin, cardName string) string {
	i := strings.Index(card, sourceHeading)
	if i < 0 {
		return card
	}
	rest := card[i+len(sourceHeading):]
	// 區塊結束＝下一個標題行或檔尾。出處是「## 關聯」的最後一個 H3，
	// 實務上就是檔尾，但仍照界線處理（之後有人在它後面加段落也不會被吃掉）。
	end := len(card)
	for off := 0; ; {
		nl := strings.Index(rest[off:], "\n")
		if nl < 0 {
			break
		}
		off += nl + 1
		line := rest[off:]
		if j := strings.Index(line, "\n"); j >= 0 {
			line = line[:j]
		}
		if strings.HasPrefix(line, "#") {
			end = i + len(sourceHeading) + off
			break
		}
	}
	var b strings.Builder
	renderSourceLine(&b, o, cardName)
	return card[:i] + b.String() + card[end:]
}

// cardNameOfFile 從卡片相對路徑取卡名（＝檔名去副檔名；BuildWikiDoc 的落點規則）。
func cardNameOfFile(rel string) string {
	return strings.TrimSuffix(path.Base(filepath.ToSlash(rel)), ".md")
}

// repairCardSourceBlocks 掃一個監看根的 wiki manifest，把還是舊形出處的卡就地修好，
// 並把**文件卡**（唯一上雲的那張）原樣重推一次。
//
// dryRun 時只看不改（與整條 direct 路徑的 --dry-run 語意一致）。
// force＝不看「本機卡是不是還是舊形」，一律重推一次。
// 這是給**手動補救**用的（雲端被清空過、或某一輪推到一半被中斷 ⇒ 本機新形、雲端舊形
// ⇒ 常規判準會判「不用修」而永遠不補推）。daemon 常規路徑一律 false。
func repairCardSourceBlocks(cfg *DirectConfig, absRoot string, m *Manifest, dryRun, force bool, now time.Time) *sourceRepairResult {
	if m == nil || (!force && m.SourceOriginRepairedAt > 0) {
		return nil // 這個根已經修完，不再每輪掃
	}
	wm := loadWikiManifest(absRoot)
	if len(wm.Docs) == 0 {
		if !dryRun {
			m.SourceOriginRepairedAt = now.Unix() // 沒有 .wiki 產物＝沒東西可修，蓋章收工
		}
		return nil
	}
	mach := cfg.machineIdentity()
	library := cfg.libraryFor(absRoot)

	res := &sourceRepairResult{}
	remaining := 0
	for di := range wm.Docs {
		d := &wm.Docs[di]
		if len(d.Cards) == 0 {
			continue
		}
		libPath := path.Join(nodeFromKey(d.Node), filepath.ToSlash(d.Path))
		// 這一份的卡有沒有舊形出處？先看文件卡（第一張），它就是上雲的那張。
		docAbs := filepath.Join(absRoot, filepath.FromSlash(d.Cards[0]))
		body, rerr := os.ReadFile(docAbs)
		if rerr != nil {
			continue // 卡不見了（使用者刪過／被搬走）＝不是這支檔的題目
		}
		// 🔴 判準只看**文件卡**（＝唯一上雲的那張），而且它是「已修好**且已推上去**」的
		// 唯一憑據。實撞（2026-08-27，第一輪跑到一半被中斷）：先改本機再推，被中斷之後
		// 本機已是新形、雲端還是舊的 ⇒ 下一輪看本機判「不用修」⇒ **那份永遠不會補推**。
		// 所以順序是**先推、推成功才寫本機**——推失敗的話本機留著舊形，下一輪自然重試。
		if !force && !hasLegacySourceLine(string(body)) {
			// 文件卡已是新形（代表也推過了）；概念卡只落本機、不上雲，順手補齊即可。
			for _, c := range d.Cards[1:] {
				abs := filepath.Join(absRoot, filepath.FromSlash(c))
				raw, e := os.ReadFile(abs)
				if e != nil || !hasLegacySourceLine(string(raw)) {
					continue
				}
				fixed := rewriteSourceBlock(string(raw), SourceOrigin{
					MachineLabel: mach.Label, Library: library, LibraryPath: libPath,
				}, cardNameOfFile(c))
				if werr := writeWikiFile(absRoot, abs, []byte(fixed)); werr != nil {
					res.Err = werr.Error()
				}
			}
			continue
		}
		res.Scanned++
		if res.Scanned > sourceRepairBatch {
			remaining++
			continue
		}
		if dryRun {
			continue
		}
		origin := SourceOrigin{MachineLabel: mach.Label, Library: library, LibraryPath: libPath}
		docCard := rewriteSourceBlock(string(body), origin, cardNameOfFile(d.Cards[0]))

		// ① 先重推（零 LLM）。欄位與 direct.go 送新卡時逐欄一致，
		//    workflow 進門會先刪同 page_name＋同 source_path 的舊 blocks ⇒ 取代不疊加。
		status, _, perr := cfg.postJSON(stepRepairOrigin, cfg.triggerURL(cfg.CardIngestWF), map[string]any{
			"page_name":     pageNameOf(libPath),
			"path":          libPath,
			"card_content":  docCard,
			"library":       library,
			"machine":       mach.ID,
			"machine_label": mach.Label,
		})
		if perr != nil || status < 200 || status >= 300 {
			if perr != nil {
				res.Err = perr.Error()
			} else {
				res.Err = "重推知識庫失敗（HTTP " + itoa(status) + "）"
			}
			remaining++ // 這一份沒推成功 ⇒ 本機不動（留著舊形當重試訊號）、這個根不能蓋章
			continue
		}

		// ② 推成功了才寫本機（文件卡＋概念卡）。
		for _, c := range d.Cards {
			abs := filepath.Join(absRoot, filepath.FromSlash(c))
			raw, e := os.ReadFile(abs)
			if e != nil {
				continue
			}
			fixed := rewriteSourceBlock(string(raw), origin, cardNameOfFile(c))
			if fixed == string(raw) {
				continue
			}
			if werr := writeWikiFile(absRoot, abs, []byte(fixed)); werr != nil {
				res.Err = werr.Error()
			}
		}
		res.Rewrote++
		res.Repushed++
	}
	if !dryRun && remaining == 0 {
		m.SourceOriginRepairedAt = now.Unix()
		res.Done = true
	}
	if res.Scanned == 0 && res.Rewrote == 0 {
		return nil
	}
	return res
}
