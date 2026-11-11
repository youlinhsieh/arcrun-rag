// secretrescan.go — 遮蔽規則升版時，把既有卡片重掃一遍（inkstone/arcrun-rag#294）。
//
// 病（2026-11-06 雲端驗收實見）：遮蔽規則補了一種新金鑰（Cloudflare cfut_／環境變數式賦值），
// 但「原檔內容沒變」⇒ 小幫手判「送過了」⇒ 永遠不會重萃 ⇒ 雲端上舊版規則放過去的卡
// 永遠帶著原值。修產生端只治得了新卡；票上要的是「機敏值不留在雲端」，所以既有的要就地處置。
//
// 作法與 sourcerepair.go 同一條路（那是這類「既有資料」處置的前例）：
//
//	重萃    要再燒一次 AI 額度，模型每次判斷不同、使用者眼前的卡會無故變樣 ⇒ 不用。
//	就地修  ✅ 本機卡還在 ⇒ 用現在這一版遮蔽規則掃一遍、命中的換成指標，
//	         上過雲的卡（文件卡；走過續讀的概念卡）原樣重推——零 LLM，其餘內容一字不動。
//
// 約束：
//   - 規則升版才跑：Manifest.SecretRedactRev < secretRedactRevision ⇒ 掃一輪、掃完蓋章。
//     **之後改規則（加 pattern）必須把 secretRedactRevision 加一**，否則舊卡永遠補不到。
//   - 一次只處理一批（secretRescanBatch 份有命中的文件）；沒處理完不蓋章，下一輪接著來。
//   - 先推、推成功才寫本機：推失敗時本機仍帶原值＝下一輪的重試訊號（同 sourcerepair 的順序理由）。
//   - 不擋、不報紅字、不新增「要人處理」的狀態；日誌只有數量與類別，**永遠不含原值**。
package collector

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// secretRedactRevision＝遮蔽規則的世代。改 secretPatterns／envAssignRe 等判準時加一。
//
//	1＝0.18.119（#294 首版）
//	2＝827c8a2（加 Cloudflare／Anthropic 金鑰格式、環境變數式賦值）
//	3＝網址裡的 token（Telegram bot token、`?secret_token=` 等查詢參數）
const secretRedactRevision = 3

// secretRescanBatch＝單輪最多處理幾份「有命中」的文件（含重推）。與 sourceRepairBatch 同一個精神。
const secretRescanBatch = 20

type secretRescanResult struct {
	Scanned  int      // 這一輪看過幾份文件
	Redacted int      // 本機卡被遮掉的文件數
	Repushed int      // 成功重推上雲的文件數
	Count    int      // 共遮了幾處（只有數量）
	Labels   []string // 命中的類別（只有類別）
	Err      string
	Done     bool
}

// addSecretNoteToCard 把「有幾處機敏值沒萃」那句話補進文件卡的「## 讀不到的內容」段
// （沒有那一段就在「## 關聯」前開一段；都沒有就接在檔尾）。note 為空原樣回傳。
func addSecretNoteToCard(card, note string) string {
	if note == "" || strings.Contains(card, note) {
		return card
	}
	const head = "## 讀不到的內容\n"
	if i := strings.Index(card, head); i >= 0 {
		at := i + len(head)
		return card[:at] + "- " + note + "\n" + card[at:]
	}
	section := head + "- " + note + "\n\n"
	if i := strings.Index(card, "\n## 關聯"); i >= 0 {
		return card[:i+1] + section + card[i+1:]
	}
	return strings.TrimRight(card, "\n") + "\n\n" + section
}

// rescanCardSecrets 掃一個監看根的 wiki manifest，把還帶機敏值的卡就地遮掉，
// 並把上過雲的那幾張原樣重推。dryRun 只看不改。
func rescanCardSecrets(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) *secretRescanResult {
	if m == nil || m.SecretRedactRev >= secretRedactRevision {
		return nil // 這個根已經用這一版規則掃過，不再每輪掃
	}
	// #121：收卡那條路正在退避 ⇒ 這輪整個不做（同 sourcerepair：每發都是雲端寫入，不能在牆前面連撞）。
	if !dryRun && cfg.routeNote(cfg.triggerURL(cfg.CardIngestWF)) != "" {
		return nil
	}
	wm := loadWikiManifest(absRoot)
	if len(wm.Docs) == 0 {
		if !dryRun {
			m.SecretRedactRev = secretRedactRevision // 沒有 .wiki 產物＝沒東西可掃，蓋章收工
		}
		return nil
	}
	mach := cfg.machineIdentity()
	library := cfg.libraryFor(absRoot)

	res := &secretRescanResult{}
	remaining := 0
	for di := range wm.Docs {
		d := &wm.Docs[di]
		if len(d.Cards) == 0 {
			continue
		}
		libPath := path.Join(nodeFromKey(d.Node), filepath.ToSlash(d.Path))
		multiCard := docWentThroughResumable(absRoot, libPath)

		type fix struct {
			idx     int
			abs     string
			body    string
			rep     secretRedaction
			changed bool
		}
		fixes := make([]fix, 0, len(d.Cards))
		hit := false
		for ci, c := range d.Cards {
			abs := filepath.Join(absRoot, filepath.FromSlash(c))
			raw, rerr := os.ReadFile(abs)
			if rerr != nil {
				fixes = append(fixes, fix{idx: ci, abs: abs})
				continue // 卡不見了（使用者刪過）＝不是這份的題目
			}
			red, rep := redactSecretText(string(raw), false)
			f := fix{idx: ci, abs: abs, body: string(raw), rep: rep}
			if rep.Count > 0 {
				f.body, f.changed = red, true
				hit = true
			}
			fixes = append(fixes, f)
		}
		if !hit {
			continue
		}
		res.Scanned++
		if res.Scanned > secretRescanBatch {
			remaining++
			continue
		}
		if dryRun {
			continue
		}
		// 文件卡補「讀不到的內容」說明（只在這一份有命中時；原稿行號對不上卡，所以不帶行號）。
		if fixes[0].changed {
			fixes[0].body = addSecretNoteToCard(fixes[0].body, secretNote(fixes[0].rep, libPath))
		}

		// ① 先重推上過雲的卡（零 LLM；rag_ingest_card 進門先刪同 page_name＋同 source_path 的舊內容 ⇒ 取代不疊加）。
		e := m.Entries[libPath]
		sent := e != nil && strings.TrimSpace(e.IngestedHash) != "" && !e.NoCloudCard
		pushFailed := false
		if sent {
			for _, f := range fixes {
				if !f.changed || (f.idx > 0 && !multiCard) {
					continue // 概念卡沒走續讀＝只落本機、雲端沒有
				}
				cardData := f.body
				if f.idx == 0 && !multiCard && len(d.Cards) > 1 {
					cardData = unlinkUnsentConceptCards(cardData, conceptCardNames(d.Cards[1:]))
				}
				pageName := pageNameOf(libPath)
				if f.idx > 0 {
					pageName = pageNameOf(d.Cards[f.idx])
				}
				base := map[string]any{
					"page_name":     pageName,
					"path":          libPath,
					"card_content":  cardData,
					"library":       library,
					"machine":       mach.ID,
					"machine_label": mach.Label,
				}
				for _, sl := range planCardSlices(cardData, f.idx, pageName, cloudHasSlicedNotes(cfg.CloudVersion)) {
					status, _, perr := cfg.postJSON(stepRepairOrigin, cfg.triggerURL(cfg.CardIngestWF), sl.body(base))
					if perr != nil || status < 200 || status >= 300 {
						if perr != nil {
							res.Err = perr.Error()
						} else {
							res.Err = "重推知識庫失敗（HTTP " + itoa(status) + "）"
						}
						pushFailed = true
						break
					}
				}
				if pushFailed {
					break
				}
				res.Repushed++
			}
		}
		if pushFailed {
			remaining++ // 本機不動（留著當重試訊號）、這個根不蓋章；後面幾份打同一條路，一份失敗就停手（#121）
			break
		}

		// ② 推成功（或這份根本沒上過雲）才寫本機。
		for _, f := range fixes {
			if !f.changed {
				continue
			}
			if werr := writeWikiFile(absRoot, f.abs, []byte(f.body)); werr != nil {
				res.Err = werr.Error()
				remaining++
				continue
			}
			res.Count += f.rep.Count
			for _, l := range f.rep.Labels {
				dup := false
				for _, have := range res.Labels {
					dup = dup || have == l
				}
				if !dup {
					res.Labels = append(res.Labels, l)
				}
			}
		}
		res.Redacted++
	}
	if !dryRun && remaining == 0 {
		m.SecretRedactRev = secretRedactRevision
		res.Done = true
	}
	if res.Scanned == 0 && res.Redacted == 0 {
		return nil
	}
	return res
}
