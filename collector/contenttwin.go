// contenttwin.go — 同內容的檔只萃一張卡，出處多寫一行（inkstone/arcrun-rag#246 c18722／c18734）。
//
// leo 2026-10-10 的裁示（原話）：「同名檔案的 hash 一樣嗎？如果完全同一個檔案重複就擇一並指向它，
// 如果有 2 個資料夾，就指兩者，反正只是加一行字。」
//
//	內容相同（hash 一樣）→ 不論在哪兩個互不相關的路徑，只萃一次、只上雲一張卡，卡上列出所有出處。
//	內容不同             → 各留一張（那是 wikishape.go 的消歧，這裡不管）。
//
// 做法（真相源只有 manifest，不另養一份名單）：
//   - 本尊＝第一個把這個 hash 萃成卡並上雲的檔（IngestedHash == ContentHash，沒有 Twin 欄位）。
//   - 之後遇到同 hash 的檔＝雙胞胎：不萃、不上雲，manifest 記 TwinRoot／TwinPath 指向本尊，
//     然後**重畫本尊那張卡的「### 出處」**（本尊＋所有指向它的雙胞胎，每個一行）並原樣重推（零 LLM，
//     與 sourcerepair.go 同一招，rag_ingest_card 以 page_name＋source_path 取代不疊加）。
//   - 出處清單永遠由 manifest 現算（twinOrigins），所以雙胞胎被刪／改名／改內容時，
//     只要把它的 Twin 欄位拿掉再重畫一次就對了。
//   - 本尊消失、內容變了、或它的資料夾不再被監看 ⇒ 雙胞胎在下一輪開頭被放回佇列自己萃
//     （sweepOrphanTwins；沿用「IngestedHash 為空 ⇒ 補一發 added」的既有語意）。
//   - 同一輪內兩份同內容的檔同時在途：後到的這輪先跳過（claim），等本尊落地後下一輪併成雙胞胎。
package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type twinRef struct{ Root, Path string }

func (r twinRef) key() string { return r.Root + "\x00" + r.Path }

// canonicalOK＝這個條目可以當「本尊」嗎？
func canonicalOK(e *ManifestEntry) bool {
	return e != nil && e.IngestedHash != "" && e.IngestedHash == e.ContentHash &&
		e.TwinPath == "" && e.FormatDupOf == "" && e.Size > 0
}

type twinIndex struct {
	cfg     *DirectConfig
	curRoot string
	curM    *Manifest
	watched map[string]bool // 這個帳號正在監看的根（絕對路徑）

	mu     sync.Mutex
	byHash map[string][]twinRef
	others map[string]*Manifest // 其他根的 manifest（本輪開頭讀一次，只讀）
}

// 同一輪內「正在萃」的 hash（跨根；key＝帳號主機＋hash）。
var twinClaims sync.Map

func (c *DirectConfig) watchedRoots(curRoot string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		a, err := filepath.Abs(p)
		if err != nil {
			a = p
		}
		if seen[a] {
			return
		}
		seen[a] = true
		out = append(out, a)
	}
	add(curRoot)
	for _, f := range c.Folders() {
		add(f)
	}
	return out
}

func (c *DirectConfig) loadOtherManifest(root string) *Manifest {
	om, err := LoadManifest(c.manifestPathFor(root), root)
	if err != nil || om == nil {
		return nil
	}
	return om
}

// buildTwinIndex 在一個根開工時建一次：本根與同帳號其他根裡所有「可當本尊」的條目。
func (c *DirectConfig) buildTwinIndex(curRoot string, curM *Manifest) *twinIndex {
	ix := &twinIndex{cfg: c, curRoot: curRoot, curM: curM, watched: map[string]bool{},
		byHash: map[string][]twinRef{}, others: map[string]*Manifest{}}
	for _, r := range c.watchedRoots(curRoot) {
		ix.watched[r] = true
		var man *Manifest
		if r == curRoot {
			man = curM
		} else if man = c.loadOtherManifest(r); man != nil {
			ix.others[r] = man
		}
		if man == nil {
			continue
		}
		paths := make([]string, 0, len(man.Entries))
		for p, e := range man.Entries {
			if canonicalOK(e) {
				paths = append(paths, p)
			}
		}
		sort.Strings(paths)
		for _, p := range paths {
			h := man.Entries[p].ContentHash
			ix.byHash[h] = append(ix.byHash[h], twinRef{r, p})
		}
	}
	return ix
}

func (ix *twinIndex) manifestOf(root string) *Manifest {
	if root == ix.curRoot {
		return ix.curM
	}
	return ix.others[root]
}

// valid＝這個本尊現在還站得住（條目還在、內容沒變、檔案還在、它的根還被監看）。
func (ix *twinIndex) valid(ref twinRef, hash string) bool {
	if !ix.watched[ref.Root] {
		return false
	}
	man := ix.manifestOf(ref.Root)
	if man == nil {
		return false
	}
	e := man.Entries[ref.Path]
	if !canonicalOK(e) || e.ContentHash != hash {
		return false
	}
	_, err := os.Stat(filepath.Join(ref.Root, filepath.FromSlash(ref.Path)))
	return err == nil
}

// find 回「內容同 hash、站得住、且不是自己」的第一個本尊。
func (ix *twinIndex) find(hash, selfRoot, selfPath string) (twinRef, bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, ref := range ix.byHash[hash] {
		if ref.Root == selfRoot && ref.Path == selfPath {
			continue
		}
		if ix.valid(ref, hash) {
			return ref, true
		}
	}
	return twinRef{}, false
}

// add＝剛把一份檔萃成卡並上雲，它從此是這個 hash 的本尊。
func (ix *twinIndex) add(hash, root, path string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, r := range ix.byHash[hash] {
		if r.Root == root && r.Path == path {
			return
		}
	}
	ix.byHash[hash] = append(ix.byHash[hash], twinRef{root, path})
}

func (ix *twinIndex) claimKey(hash string) string {
	return instanceHostOf(ix.cfg.CypherURL) + "|" + hash
}

// claim 這個 hash 這一刻只准一個人去萃；拿不到＝別份同內容的檔正在萃。
func (ix *twinIndex) claim(hash, root, path string) bool {
	_, loaded := twinClaims.LoadOrStore(ix.claimKey(hash), twinRef{root, path}.key())
	return !loaded
}

func (ix *twinIndex) release(hash, root, path string) {
	if v, ok := twinClaims.Load(ix.claimKey(hash)); ok && v == (twinRef{root, path}).key() {
		twinClaims.Delete(ix.claimKey(hash))
	}
}

// sweepOrphanTwins 把「本尊已經不在了」的雙胞胎放回佇列（清掉指向與章 ⇒ 掃描會當成待送的檔）。
// 必須在 Scan() 之前呼叫。回傳放回的份數。
func (c *DirectConfig) sweepOrphanTwins(absRoot string, m *Manifest) int {
	n := 0
	var ix *twinIndex
	for _, e := range m.Entries {
		if e == nil || e.TwinPath == "" {
			continue
		}
		if ix == nil {
			ix = c.buildTwinIndex(absRoot, m)
		}
		ref := twinRef{e.TwinRoot, e.TwinPath}
		if e.IngestedHash == e.ContentHash && ix.valid(ref, e.ContentHash) {
			continue
		}
		e.TwinRoot, e.TwinPath = "", ""
		e.TwinOriginPending = false
		e.IngestedHash, e.IngestedAt = "", 0
		e.NoCloudCard = false
		n++
	}
	return n
}

// twinOrigins 現算本尊那張卡該列的出處：本尊在前，其後是所有指向它的雙胞胎（含 add、不含 drop）。
func (c *DirectConfig) twinOrigins(canon twinRef, curRoot string, curM *Manifest, add, drop *twinRef) []SourceOrigin {
	mach := c.machineIdentity()
	hash := ""
	if cm := c.manifestFor(canon.Root, curRoot, curM); cm != nil {
		if ce := cm.Entries[canon.Path]; ce != nil {
			hash = ce.ContentHash
		}
	}
	type pr struct{ lib, path string }
	seen := map[string]bool{}
	var twins []twinRef
	push := func(r twinRef) {
		if r == canon || seen[r.key()] {
			return
		}
		if drop != nil && *drop == r {
			return
		}
		seen[r.key()] = true
		twins = append(twins, r)
	}
	for _, r := range c.watchedRoots(curRoot) {
		man := c.manifestFor(r, curRoot, curM)
		if man == nil {
			continue
		}
		for p, e := range man.Entries {
			if e != nil && e.TwinRoot == canon.Root && e.TwinPath == canon.Path && (hash == "" || e.ContentHash == hash) {
				push(twinRef{r, p})
			}
		}
	}
	if add != nil {
		push(*add)
	}
	sort.Slice(twins, func(i, j int) bool {
		li, lj := c.libraryFor(twins[i].Root), c.libraryFor(twins[j].Root)
		if li != lj {
			return li < lj
		}
		return twins[i].Path < twins[j].Path
	})
	out := []SourceOrigin{{MachineLabel: mach.Label, Library: c.libraryFor(canon.Root), LibraryPath: canon.Path}}
	for _, t := range twins {
		out = append(out, SourceOrigin{MachineLabel: mach.Label, Library: c.libraryFor(t.Root), LibraryPath: t.Path})
	}
	return out
}

func (c *DirectConfig) manifestFor(root, curRoot string, curM *Manifest) *Manifest {
	if root == curRoot {
		return curM
	}
	return c.loadOtherManifest(root)
}

// refreshCanonCard 把本尊那份文件的卡的「### 出處」重畫成 origins，文件卡（唯一上雲的那張；
// 走過續讀的大檔連概念卡）原樣重推，推成功才寫本機。沒有卡（無可萃概念）＝什麼都不用做。
func (c *DirectConfig) refreshCanonCard(canon twinRef, origins []SourceOrigin) error {
	rels := WikiDocCardRels(canon.Root, canon.Path)
	if len(rels) == 0 {
		return nil
	}
	multi := docWentThroughResumable(canon.Root, canon.Path)
	mach := c.machineIdentity()
	library := c.libraryFor(canon.Root)
	type fix struct {
		abs, body string
	}
	var writes []fix
	for i, rel := range rels {
		abs := filepath.Join(canon.Root, filepath.FromSlash(rel))
		raw, err := os.ReadFile(abs)
		if err != nil {
			if i == 0 {
				return fmt.Errorf("讀本尊的卡失敗：%w", err)
			}
			continue
		}
		fixed := rewriteSourceBlockMulti(string(raw), origins, cardNameOfFile(rel))
		if fixed == string(raw) {
			continue
		}
		if i == 0 || multi {
			pageName := pageNameOf(canon.Path)
			if i > 0 {
				pageName = pageNameOf(rel)
			}
			cardBody := map[string]any{
				"page_name":     pageName,
				"path":          canon.Path,
				"card_content":  fixed,
				"library":       library,
				"machine":       mach.ID,
				"machine_label": mach.Label,
			}
			// arcrun-rag#255：跟收卡同一套送法（三元組的名字＋關係多的卡切段），
			// 否則重推會把原本分段存的卡整張寫進第一批、與後面幾段重複。
			for _, sl := range planCardSlices(fixed, i, pageName, cloudHasSlicedNotes(c.CloudVersion)) {
				status, _, perr := c.postJSONAs(stepIngestCard, c.triggerURL(c.CardIngestWF), sl.body(cardBody), false)
				if perr != nil {
					return perr
				}
				if status < 200 || status >= 300 {
					return fmt.Errorf("更新卡片出處失敗（HTTP %s）", itoa(status))
				}
			}
		}
		writes = append(writes, fix{abs, fixed})
	}
	for _, w := range writes {
		if err := writeWikiFile(canon.Root, w.abs, []byte(w.body)); err != nil {
			return err
		}
	}
	return nil
}

func twinNote(canon twinRef) string {
	return "內容和「" + strings.TrimPrefix(filepath.ToSlash(canon.Path), "/") + "」一模一樣，已併成同一張卡（出處多寫一行）"
}

// twinOriginFlushBatch＝單輪最多更新幾張本尊的卡。與 cloudAuditBatch 同一個精神：
// 巨量積壓（例如一個 1 萬檔的資料夾整份被另一個資料夾複製）不該一輪湧完，剩下的下一輪接著做。
const twinOriginFlushBatch = 20

// flushTwinOrigins 把「雙胞胎已記帳、本尊的卡還沒補上那一行出處」的卡補推上雲，
// **每張本尊的卡一輪只推一次**，不管有幾份副本指向它（inkstone/arcrun-rag#209 c10693）。
//
// 為什麼要這支：本尊的卡在雲端是整張刪掉重寫，一次一整張卡的寫入列；
// 在雙胞胎那一刻就推，k 份副本就把同一張沒改過的卡重寫 k 次，而且全擠在使用者按
// 「立刻同步」的那一輪、跟真正的上傳搶當天的寫入額度。
//
// 約束：
//   - 只推「還站得住」的本尊（canonicalOK）；站不住的由 sweepOrphanTwins 在下一輪放回佇列，標記跟著清掉。
//   - 推失敗就停手（不連打剩下的），標記留著下一輪再試；回傳那個失敗的原文（不改寫）。
//   - 單輪上限 twinOriginFlushBatch 張。
//   - 出處清單仍由 manifest 現算（twinOrigins），所以順序、內容與立即推的舊作法逐字相同。
func (c *DirectConfig) flushTwinOrigins() (pushed int, err error) {
	roots := c.watchedRoots("")
	mans := map[string]*Manifest{}
	for _, r := range roots {
		if m := c.loadOtherManifest(r); m != nil {
			mans[r] = m
		}
	}
	type pend struct {
		root string
		e    *ManifestEntry
	}
	groups := map[string][]pend{}
	canons := map[string]twinRef{}
	for root, m := range mans {
		for _, e := range m.Entries {
			if e == nil || !e.TwinOriginPending || e.TwinPath == "" {
				continue
			}
			ref := twinRef{e.TwinRoot, e.TwinPath}
			groups[ref.key()] = append(groups[ref.key()], pend{root, e})
			canons[ref.key()] = ref
		}
	}
	if len(groups) == 0 {
		return 0, nil
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	dirty := map[string]bool{}
	for _, k := range keys {
		if pushed >= twinOriginFlushBatch {
			break
		}
		canon := canons[k]
		cm := mans[canon.Root]
		if cm == nil || !canonicalOK(cm.Entries[canon.Path]) {
			continue // 本尊站不住：下一輪 sweepOrphanTwins 會把這些雙胞胎放回佇列
		}
		origins := c.twinOrigins(canon, "", nil, nil, nil)
		paceFor(c)
		if rerr := c.refreshCanonCard(canon, origins); rerr != nil {
			err = rerr
			break
		}
		for _, p := range groups[k] {
			p.e.TwinOriginPending = false
			dirty[p.root] = true
		}
		pushed++
	}
	for root := range dirty {
		if serr := mans[root].Save(c.manifestPathFor(root)); serr != nil && err == nil {
			err = serr
		}
	}
	return pushed, err
}
