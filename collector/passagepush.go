// passagepush.go — 已萃過、但沒送過原稿段落的檔，小幫手更新後自動補送一次（inkstone/Arcrun#343）。
//
// 背景：雲端改成「收卡（rag_ingest_card）時產生原稿段落」。新收的卡自然有段落；但更新前就萃好、送好的檔，
// 原檔內容沒變 ⇒ 小幫手判「送過了」⇒ 永遠不會再送 ⇒ 永遠沒有段落。
//
// 作法與 secretrescan.go 同一條路（那是這類「既有資料」處置的前例）：
//
//	重萃    要再燒一次 AI 額度、模型每次判斷不同、使用者眼前的卡會無故變樣 ⇒ 不用。
//	重推    ✅ 本機卡還在 ⇒ 原樣再送一次 rag_ingest_card（零 LLM）。雲端卡內容沒變就只補段落
//	         （同 id 覆寫、已是最新的原樣不動），卡與三元組一個字不動。
//
// 約束：
//   - 每個檔只補一次：ManifestEntry.PassageRev < passageRevision 才送，送成功蓋章；改 chunker 要補送時把它加一。
//   - 只送「有原文層」的檔（卡上有原文表格／條列／段落／讀圖原文其中一段）；沒有原文層＝零段落，不必送。
//   - 雲端還沒更新（不認得段落）時不送、不蓋章：等雲端更新後的下一輪自然補。
//   - 一次只處理一批（passageRepushBatch 份）；沒處理完下一輪接著來。收卡那條路在退避、省電模式都不做。
//   - 使用者什麼都不用按：跟著每輪同步自己跑。
package collector

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// passageRevision＝原稿段落補送的世代。1＝收卡時產生段落（Arcrun#343）。
const passageRevision = 1

// cardPassageRelease＝雲端第一個在收卡時產生原稿段落的版本。
const cardPassageRelease = "1.4.216"

// passageRepushBatch＝單輪最多補送幾份文件。
const passageRepushBatch = 20

// cloudHasCardPassages＝這個雲端版本收卡時會產生原稿段落（""、舊日期格式、比 1.4.216 舊 ⇒ false）。
func cloudHasCardPassages(version string) bool {
	head := strings.TrimSpace(strings.SplitN(version, "+", 2)[0])
	return isSemverLike(head) && compareSemver(head, cardPassageRelease) >= 0
}

var passageLayerHeads = []string{"## 原文表格", "## 原文條列", "## 原文段落", "## 讀圖原文"}

// cardHasSourceLayer＝這張卡有沒有原文層（與雲端切段認的四個二級標題一致）。
func cardHasSourceLayer(md string) bool {
	for _, h := range passageLayerHeads {
		if strings.Contains(md, "\n"+h) || strings.HasPrefix(md, h) {
			return true
		}
	}
	return false
}

type passageRepushResult struct {
	Scanned  int // 這一輪看過幾份要補送的文件
	Repushed int // 成功補送的文件數
	Err      string
	Done     bool
}

// repushCardPassages 掃一個監看根的 wiki manifest，把上過雲、卡上有原文層、還沒補過段落的文件原樣重推一次。
func repushCardPassages(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) *passageRepushResult {
	if m == nil || cfg.SaverMode || !cloudHasCardPassages(cfg.CloudVersion) {
		return nil
	}
	if !dryRun && cfg.routeNote(cfg.triggerURL(cfg.CardIngestWF)) != "" {
		return nil // #121：收卡那條路正在退避，這輪整個不做
	}
	wm := loadWikiManifest(absRoot)
	if len(wm.Docs) == 0 {
		return nil
	}
	mach := cfg.machineIdentity()
	library := cfg.libraryFor(absRoot)

	res := &passageRepushResult{}
	remaining := 0
	for di := range wm.Docs {
		d := &wm.Docs[di]
		if len(d.Cards) == 0 {
			continue
		}
		libPath := path.Join(nodeFromKey(d.Node), filepath.ToSlash(d.Path))
		e := m.Entries[libPath]
		if e == nil || strings.TrimSpace(e.IngestedHash) == "" || e.NoCloudCard || e.PassageRev >= passageRevision {
			continue // 沒上過雲的檔，之後收卡時自然有段落；補過的不再補
		}
		multiCard := docWentThroughResumable(absRoot, libPath)

		type sendCard struct {
			idx  int
			body string
		}
		var sends []sendCard
		for ci, c := range d.Cards {
			if ci > 0 && !multiCard {
				continue // 概念卡沒走續讀＝只落本機、雲端沒有
			}
			raw, rerr := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(c)))
			if rerr != nil {
				continue // 卡不見了（使用者刪過）
			}
			if !cardHasSourceLayer(string(raw)) {
				continue
			}
			sends = append(sends, sendCard{idx: ci, body: string(raw)})
		}
		if len(sends) == 0 {
			if !dryRun {
				e.PassageRev = passageRevision // 沒有原文層＝沒有段落可補，蓋章不再看
			}
			continue
		}
		res.Scanned++
		if res.Scanned > passageRepushBatch {
			remaining++
			continue
		}
		if dryRun {
			continue
		}
		pushFailed := false
		for _, sc := range sends {
			cardData := sc.body
			if sc.idx == 0 && !multiCard && len(d.Cards) > 1 {
				cardData = unlinkUnsentConceptCards(cardData, conceptCardNames(d.Cards[1:]))
			}
			pageName := pageNameOf(libPath)
			if sc.idx > 0 {
				pageName = pageNameOf(d.Cards[sc.idx])
			}
			base := map[string]any{
				"page_name":     pageName,
				"path":          libPath,
				"card_content":  cardData,
				"library":       library,
				"machine":       mach.ID,
				"machine_label": mach.Label,
			}
			for _, sl := range planCardSlices(cardData, sc.idx, pageName, cloudHasSlicedNotes(cfg.CloudVersion)) {
				status, _, perr := cfg.postJSON(stepRepairOrigin, cfg.triggerURL(cfg.CardIngestWF), sl.body(base))
				if perr != nil || status < 200 || status >= 300 {
					if perr != nil {
						res.Err = perr.Error()
					} else {
						res.Err = "補送原稿段落失敗（HTTP " + itoa(status) + "）"
					}
					pushFailed = true
					break
				}
			}
			if pushFailed {
				break
			}
		}
		if pushFailed {
			remaining++ // 不蓋章、下一輪再試；後面幾份打同一條路，一份失敗就停手（#121）
			break
		}
		e.PassageRev = passageRevision
		res.Repushed++
	}
	res.Done = remaining == 0 && res.Err == ""
	if res.Scanned == 0 && res.Repushed == 0 && res.Err == "" {
		return nil
	}
	return res
}
