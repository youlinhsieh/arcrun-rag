// wikiindex_sync.go — 把分層目錄卡送上雲端（inkstone/arcrun-rag#264）。
//
// 🔴 為什麼以前「連一次嘗試都沒有」：`.wiki/` 是點開頭的資料夾，掃描整棵跳過，
// 所以裡面的 00-INDEX.md 從來不是「檔案」，不在 manifest.entries；而 folderindex.go 的資料夾卡
// 又只做子資料夾（根由 inventory 總覽卡負責）。沒有任何一段程式把根目錄卡送出去，也就沒有失敗紀錄可看。
// 雲端 `kbdb_get_index` 找不到名叫 00-INDEX 的卡，只能退回機械清單（上限 500 張）。
//
// 本檔補上：每輪（冪等、雜湊沒變不送）把本機 `.wiki` 的目錄樹做成「雲端版」目錄卡送出——
// 連結指向**雲端頁名**（原稿檔名去副檔名，與 kbdb_get_card 讀得到的名字一致），
// 不是本機卡名。送失敗＝記進 manifest.wiki_index_fails（畫面 !N 看得到、退避後自動重送，不安靜跳過）。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// 單輪最多送幾張目錄卡（其餘下一輪接著送，會指名講出來）。
const maxIndexCardsPerRun = 300

// cloudIndexRootName＝某節點在雲端的根目錄卡名。根節點固定叫 00-INDEX（雲端 library-index.ts 認這個名字）。
func cloudIndexRootName(node string) string {
	if node == "" {
		return "00-INDEX"
	}
	return "00-INDEX@" + strings.ReplaceAll(node, "/", "~")
}

func cloudIndexCardPath(library, name string) string {
	return ".arcrun-rag/wiki/index/arcrun-目錄-" + library + "-" + pathSlug(name) + ".md"
}

// cloudDocsOf：只留「真的已經送上雲端」的文件（否則目錄會連到不存在的頁）。
func cloudDocsOf(wm *wikiManifest, entries map[string]*ManifestEntry) *wikiManifest {
	out := &wikiManifest{Version: wm.Version}
	for _, d := range wm.Docs {
		if d.Status == "no_concept" {
			continue
		}
		e := entries[d.Path]
		if e == nil {
			if n := nodeFromKey(d.Node); n != "" {
				e = entries[n+"/"+d.Path]
			}
		}
		if e == nil || e.IngestedHash == "" || e.IngestedHash != e.ContentHash || e.NoCloudCard {
			continue
		}
		out.Docs = append(out.Docs, d)
	}
	return out
}

// buildCloudIndexCards 回雲端版目錄卡（上層在前，根卡第一）。純函式。
func buildCloudIndexCards(wm *wikiManifest) []idxCard { return buildCloudIndexCardsAt("", wm) }

// buildCloudIndexCardsAt：absRoot 非空時，gloss 是空話的行改用原稿節錄（wikiblurb.go）。
func buildCloudIndexCardsAt(absRoot string, wm *wikiManifest) []idxCard {
	need := map[string]bool{}
	for _, d := range wm.Docs {
		n := nodeFromKey(d.Node)
		need[n] = true
		for n != "" {
			n = parentNode(n)
			need[n] = true
		}
	}
	if len(need) == 0 {
		return nil
	}
	nodes := make([]string, 0, len(need))
	for n := range need {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		di, dj := strings.Count(nodes[i], "/"), strings.Count(nodes[j], "/")
		if nodes[i] == "" || nodes[j] == "" {
			return nodes[i] == ""
		}
		if di != dj {
			return di < dj
		}
		return nodes[i] < nodes[j]
	})
	var out []idxCard
	for _, node := range nodes {
		nk := nodeKeyOf(node)
		var docs []wikiDoc
		for _, d := range wm.Docs {
			if d.Node == nk {
				docs = append(docs, d)
			}
		}
		sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
		kids, kidCount := childNodesOf(node, wm)
		var pre strings.Builder
		if len(kids) > 0 {
			pre.WriteString("## 子節點\n")
			for _, k := range kids {
				child := k
				if node != "" {
					child = node + "/" + k
				}
				pre.WriteString("- 📁 [[" + cloudIndexRootName(child) + "]] — `" + k + "/` 內含 " + itoa(kidCount[k]) + " 篇文件\n")
			}
			pre.WriteString("\n")
		}
		entries := make([]idxEntry, 0, len(docs))
		blurbs := blurbsFor(absRoot, node, docs)
		for _, d := range docs {
			stem := pageNameOf(d.Path)
			gloss := blurbs[d.Path]
			if gloss == strings.TrimSpace(d.Gloss) { // 沒被換成原稿節錄的，維持原本 60 字上限
				if r := []rune(gloss); len(r) > 60 {
					gloss = string(r[:60]) + "…"
				}
			}
			entries = append(entries, idxEntry{Key: stem, Lines: "- [[" + stem + "]] — " + gloss + "\n"})
		}
		root := cloudIndexRootName(node)
		cards := buildIdxCards(entries, idxOpts{
			RootName: root, Preface: pre.String(), WithGloss: true, NameJoiner: "-",
			EmptyMsg: "（本層沒有文件；見子節點。）",
			Footer:   "## 說明\n本目錄由 Arcrun RAG 自動維護：先讀分組，再點進子目錄，最後點到文件卡。\n",
		})
		if node != "" {
			// 子節點根卡回指父節點根卡
			parent := cloudIndexRootName(parentNode(node))
			cards[0].Content = strings.Replace(cards[0].Content, "# "+root+"\n\n", "# "+root+"\n\n← [["+parent+"]]\n\n", 1)
		}
		out = append(out, cards...)
	}
	return out
}

// syncWikiIndexCards 送雲端版目錄卡。回傳每張實際嘗試的結果（含失敗）。
func syncWikiIndexCards(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) []DirectResult {
	wm := cloudDocsOf(loadWikiManifest(absRoot), m.Entries)
	cards := buildCloudIndexCardsAt(absRoot, wm)
	lib := cfg.libraryFor(absRoot)
	if m.WikiIndexHashes == nil {
		m.WikiIndexHashes = map[string]string{}
	}
	live := map[string]bool{}
	for _, c := range cards {
		live[c.Name] = true
	}
	// 這輪已不存在的目錄卡（分組改了、文件被刪光）：撤掉雲端那張。
	for name := range m.WikiIndexHashes {
		if !live[name] {
			delete(m.WikiIndexHashes, name)
			m.QueueTakedown(cloudIndexCardPath(lib, name), name)
		}
	}
	for name := range m.WikiIndexFails {
		if !live[name] {
			delete(m.WikiIndexFails, name)
		}
	}
	if len(cards) == 0 {
		return nil
	}
	if !dryRun {
		if note := cfg.routeNote(cfg.triggerURL(cfg.cardWF())); note != "" {
			// 🔴 收卡路正在退避：這輪不送，但**不准安靜**（#264 c19383）。
			// 還沒送達的目錄卡記一筆「等收卡路恢復」的病歷：畫面算進 !N；NextRetry=0 ⇒ 退避一結束
			// 下一輪立刻送。Count 不加、不動退避階梯（這不是這張卡自己的病，是路在休息）。
			nowU := now.Unix()
			waiting := 0
			for _, c := range cards {
				sum := sha256.Sum256([]byte(c.Content))
				h := "sha256:" + hex.EncodeToString(sum[:])
				if m.WikiIndexHashes[c.Name] == h {
					continue
				}
				waiting++
				if m.WikiIndexFails == nil {
					m.WikiIndexFails = map[string]*IndexCardFail{}
				}
				f := m.WikiIndexFails[c.Name]
				if f == nil {
					f = &IndexCardFail{}
					m.WikiIndexFails[c.Name] = f
				}
				if f.Count == 0 || f.Hash != h {
					f.Hash, f.NextRetry = h, 0
				} else if f.NextRetry > nowU {
					f.NextRetry = nowU // 路退避結束就該送，不再疊自己的退避
				}
				f.LastError = "目錄卡「" + c.Name + "」等收卡路恢復後自動補送：" + note
				f.LastFail = nowU
			}
			if waiting == 0 {
				return nil
			}
			return []DirectResult{{Type: "index", Status: "skipped",
				Error: fmt.Sprintf("%d 張目錄卡還沒送上知識庫，等收卡路恢復後自動補送：%s", waiting, note)}}
		}
	}
	var out []DirectResult
	mach := cfg.machineIdentity()
	nowU := now.Unix()
	sent, consecFail := 0, 0
	for _, c := range cards {
		sum := sha256.Sum256([]byte(c.Content))
		h := "sha256:" + hex.EncodeToString(sum[:])
		if m.WikiIndexHashes[c.Name] == h {
			continue
		}
		if f := m.WikiIndexFails[c.Name]; f != nil && f.Hash == h && nowU < f.NextRetry {
			continue // 還在退避；病歷已計入畫面的 !N
		}
		if sent >= maxIndexCardsPerRun {
			out = append(out, DirectResult{Type: "index", Status: "skipped",
				Error: fmt.Sprintf("目錄卡超過單輪上限 %d 張，其餘下一輪接著送", maxIndexCardsPerRun)})
			break
		}
		res := DirectResult{Type: "index", Path: cloudIndexCardPath(lib, c.Name)}
		if dryRun {
			res.Status = "planned"
			out = append(out, res)
			continue
		}
		var err error
		var status int
		if len(c.Content) > idxCardMaxBytes {
			err = fmt.Errorf("目錄卡「%s」太大（%d 位元組，上限 %d），無法上傳", c.Name, len(c.Content), idxCardMaxBytes)
		} else {
			pace()
			status, _, err = cfg.postJSON(stepFolderCard, cfg.triggerURL(cfg.cardWF()), map[string]any{
				"page_name":     c.Name,
				"path":          res.Path,
				"card_content":  c.Content,
				"library":       lib,
				"machine":       mach.ID,
				"machine_label": mach.Label,
			})
		}
		sent++
		res.HTTPStatus = status
		if err != nil {
			msg := "目錄卡「" + c.Name + "」上傳失敗：" + err.Error()
			if isQuotaExhausted(err.Error()) {
				msg = "雲端今天的額度用完了，目錄卡「" + c.Name + "」會稍後自動補送"
			}
			res.Status, res.Error = "failed", msg
			if m.WikiIndexFails == nil {
				m.WikiIndexFails = map[string]*IndexCardFail{}
			}
			f := m.WikiIndexFails[c.Name]
			if f == nil {
				f = &IndexCardFail{}
				m.WikiIndexFails[c.Name] = f
			}
			f.Count++
			f.Hash, f.LastError, f.LastFail = h, msg, nowU
			idx := f.Count - 1
			if idx >= len(retryBackoff) {
				idx = len(retryBackoff) - 1
			}
			f.NextRetry = nowU + int64(retryBackoff[idx].Seconds())
			out = append(out, res)
			consecFail++
			if isQuotaExhausted(err.Error()) || consecFail >= 3 {
				break // 同一面牆，別連撞（t195）
			}
			continue
		}
		consecFail = 0
		res.Status = "ingested"
		m.WikiIndexHashes[c.Name] = h
		delete(m.WikiIndexFails, c.Name)
		out = append(out, res)
	}
	return out
}

// cardWF＝收卡 workflow 名（空＝rag_ingest_card）。
func (c *DirectConfig) cardWF() string {
	if c.CardIngestWF == "" {
		return "rag_ingest_card"
	}
	return c.CardIngestWF
}
