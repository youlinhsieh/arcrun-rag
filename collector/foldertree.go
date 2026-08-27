// foldertree.go — 把「這個看守資料夾長什麼樣」做成**結構化的樹**送上雲端
// （InkStoneCo#44 線 A，leo 2026-08-17 規格）。
//
// 🔴 leo 的原話就是這支檔的規格：
//
//	「昨天我看到的是掃到了指定資料夾，但 **tree 在 portal 上應該顯示該資料夾的 tree**，
//	 並顯示該資料夾**每個子資料夾的「同步文件數/總文件數」**，
//	 不上傳通常是不支援，比如程式碼、不支援的格式。」
//
// ⇒ 這個畫面同時要回答「哪些沒上傳、為什麼」。使用者不必問人、也不必看 log。
//
// ── 為什麼不是重用 inventory.go 的總覽卡 ─────────────────────────────────────
// `inventory.go` 已經在送一張「資料夾總覽」的**知識卡**（markdown），但它服務的是
// **檢索**（讓 rag-chat 查得到「這個資料夾有什麼」），而且：
//   - 它只數 manifest entries ＝**只數收得下的檔**，算不出「總文件數」的分母；
//   - 它只到第一層目錄，沒有樹；
//   - 它是一段 markdown ⇒ portal 沒辦法拿它畫出可摺疊、每節點兩個數字的樹。
//
// ⇒ 兩者消費者不同（一個給 LLM 檢索、一個給 portal 畫面），資料形狀也不同。
// **但分子分母只有一個來源**：本檔的分母（總數／不支援／被排除）由 `Scan()` 走訪時
// 順手數出來（同一趟走訪、同一套判準，見 scan.go 的 dirStat），分子（已同步）由
// manifest 現況導出 ⇒ 不會出現「畫面說 A、檔案說 B」那種兩份實作漂移的病。
//
// ── 為什麼「空資料夾」是這支檔的一等公民 ────────────────────────────────────
// `arcrun-rag#106`（leo 2026-08-15）：
//
//	「如果指定同步的是**空資料夾**，雲端不出現，**這個不行**，因為
//	 我指定資料夾雲端和地端是 navigate 的功能，
//	 **不能因為地端資料夾內沒東西就當作不存在，如果那是他打算放東西的資料夾呢？**」
//
// 今天雲端的庫是「有卡才有庫」的副作用 ⇒ 空資料夾指定了什麼都不會出現。
// 本檔**每一輪都送**（內容沒變才跳過），而且**沒有檔案時照送**——所以指定的當下
// 那個資料夾就在雲端存在了，內容是 0。收端負責順手把庫登記起來（冪等）。
//
// 紅線對齊：本檔不寫任何本機檔案、不動使用者原稿；資料一律走既有的 portal daemon
// HTTP 端點（與 `/portal/daemon/extract`、`/portal/daemon/libraries` 同一族，
// 同一把 `X-Arcrun-API-Key`），不新開第二套上行機制。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// MaxFolderTreeNodes：一棵樹最多送幾個節點。
	//
	// 為什麼要有上限：leo 的 `InkStoneCo` 一個資料夾就掃到 8,339 份檔，目錄數同量級。
	// 一次把幾千個節點推上去，既撞 Workers 的 subrequest 天花板，也會把 portal 畫成
	// 一面沒人看得完的牆。
	//
	// 🔴 **超過不准安靜地截掉**——`FolderTree.Truncated` 會被送上去、由畫面講出來
	//（同 #104「排除規則要看得見」那條紅線：安靜地少講與講一個 0，對使用者是同一件事）。
	//
	// 🔴 2026-08-28（inkstone/Arcrun#180）從 300 提到 2000。leo 的規格是
	// 「**雲端看到所有的 folder**」，而剪枝拿掉之後節點會變多——300 會讓「看得到全部」
	// 在大資料夾上靜默失效（`Truncated` 雖然誠實，但那是在說「我做不到你要的事」）。
	//
	// **實測（本次改動後，同一台機器）**：
	//
	//	youlinhsieh-test1   12 個節點（地端 `find -type d` 非隱藏 12）
	//	youlinhsieh-test2   13（地端 13）
	//	pms                 53（地端 360——差額是 node_modules／dist／.gitignore 宣告的，
	//	                    那幾種仍然剪枝，但節點與理由都在）
	//	InkStoneCo          62（地端 14,923，同上）
	//
	// ⇒ 真實資料夾離 300 都還很遠；2000 是留給「一個沒有 .gitignore 的大筆記庫」的餘裕。
	// 一棵樹在收端是一把 KV、整棵覆寫，2000 個節點約 400 KB，離 KV 的 25 MB 很遠。
	MaxFolderTreeNodes = 2000

	// folderTreeRetryDelay：整棵樹送失敗後，同一份內容多久才准再試。
	// 理由同 inventory.go：積壓時每輪都有事件，沒有退避就是每 5 秒撞一次（t195 教訓）。
	folderTreeRetryDelay = 10 * time.Minute

	// folderTreeMinInterval：**成功送出**之後，同一個資料夾至少隔多久才准再送。
	//
	// 🔴 為什麼需要這道閘（而總覽卡不需要）：總覽卡多了一條「本輪無事件就不送」，
	// 而這棵樹刻意沒有那一條（空資料夾從頭到尾沒有事件，見下面 syncFolderTree 的說明）。
	// 少了那道閘，初次同步時的行為是：每收完一個檔「已同步數」就變一次
	// ⇒ 內容雜湊每輪都不同 ⇒ **每 5 秒送一整棵樹**。
	// 收端一次回報＝一次 KV 寫入，而 Workers KV 免費層是 1000 writes/day
	// ⇒ 沒有這道閘，一個資料夾的初次同步就能在一小時內把當天額度燒光，
	//   而額度燒光的症狀是「畫面停在某個數字不動」——看起來像壞掉，不像額度。
	//
	// 2 分鐘是「人盯著畫面等進度」與「一天的額度」之間的折衷：
	// 最壞 30 次/小時 × 24 ＝ 720 次/天/資料夾，靜止時是 0（雜湊閘擋住）。
	// **首次送出不受此限**（m.FolderTreeHash == ""）——指定資料夾的當下就要看得見它，
	// 那正是 arcrun-rag#106 的重點。
	folderTreeMinInterval = 2 * time.Minute
)

// FolderNode＝樹上的一個節點（＝地端的一個資料夾）。
//
// 🔴 數字全部是**這一層直接放的檔案**（不含子資料夾）。子樹的合計由畫面自己疊——
// 存兩套（直接數＋累計數）就是同一件事兩份實作，遲早對不起來。
type FolderNode struct {
	// Path＝相對監看根的路徑，`""` 代表根自己。一律 `/` 分隔（跨平台一致）。
	Path string `json:"path"`
	// Name＝這一層的名字（根用資料夾 basename，人看得懂「這是哪個資料夾」）。
	Name string `json:"name"`
	// Parent＝上一層的 Path；根自己是 `"-"`（空字串已經被根佔走，要分得出「我是根」）。
	Parent string `json:"parent"`
	Depth  int    `json:"depth"`

	// TotalFiles＝這一層看得到的檔案總數（**分母**）——含不支援的、含被策略排除的。
	// 這就是使用者在 Finder 裡數得出來的那個數字（隱藏檔除外，他也看不到）。
	TotalFiles int `json:"total_files"`
	// SyncedFiles＝已經送進雲端知識庫、而且送上去之後內容沒再變過的（**分子**）。
	SyncedFiles int `json:"synced_files"`
	// PendingFiles＝認得、還沒送完（排隊中／退避中／已放棄自動重試）。
	PendingFiles int `json:"pending_files"`
	// UnsupportedFiles＝副檔名我們還讀不了的（leo 講的「不支援的格式」）。
	UnsupportedFiles int `json:"unsupported_files"`
	// ExcludedFiles＝收檔策略決定不收的（leo 講的「程式碼」多半落在這裡，見 ingestplan.go）。
	ExcludedFiles int `json:"excluded_files"`

	// Skipped＝**這一層的檔案這次一個都不收**。SkipReason 說得出為什麼。
	//
	// 🔴 2026-08-28（inkstone/Arcrun#180）語意收窄了一格，因為 leo 推翻了原本的做法：
	// 以前 Skipped 同時代表「整棵沒走進去」⇒ 數字全是 0 而且不是事實 ⇒ **底下一個
	// 子節點都不會生**。leo 的原話：「**所有的 system-dev 都可以展開，因為就算沒有
	// 可萃的它也有下層**」「我要的就是雲端看到**所有的 folder** 像 tree 一樣呈現」。
	// ⇒ 現在絕大多數 Skipped 節點是**走進去了、數字是真的、子節點也都在**，
	//   只是這一層的檔不收（範本檔、非本次收檔範圍…）。
	//
	// 仍然有數字是 0 而且不是事實的那一種——真的沒走進去的（`node_modules` 這類，
	// 見 IngestPlan.SkipsDirWhy 剩下的五條）。**分辨方法：那種節點沒有子節點。**
	// 畫面看到 Skipped 一律改講 SkipReason，不要只顯示分子分母。
	Skipped bool `json:"skipped,omitempty"`
	// SkipReason＝一句話講給使用者聽的「為什麼整個沒收」（原文來自 IngestPlan.SkipsDirWhy）。
	SkipReason string `json:"skip_reason,omitempty"`
}

// FolderTree＝一個監看根的整棵樹，加上「為什麼只收這些」的那句話。
type FolderTree struct {
	Library     string       `json:"library"`      // 歸庫鍵（cfg.libraryFor(absRoot)，每根唯一）
	DisplayName string       `json:"display_name"` // 資料夾 basename，給人看的
	Root        string       `json:"root"`         // 地端絕對路徑（navigator：回得去地端）
	Mode        string       `json:"mode"`         // 收檔策略（all／curated-wiki／docs-only）
	Reason      string       `json:"reason"`       // 那句人話（IngestPlan.Reason）
	Nodes       []FolderNode `json:"nodes"`
	Truncated   bool         `json:"truncated,omitempty"` // 節點超過上限，畫面要講出來
	TotalNodes  int          `json:"total_nodes"`         // 截斷前的真實節點數
	GeneratedAt int64        `json:"generated_at"`
}

// BuildFolderTree 把「走訪時數出來的分母」與「manifest 現況的分子」合成一棵樹。
//
// 純函式、零 IO、輸出確定（同一份輸入永遠同一份輸出）——冪等判斷（內容雜湊）與測試
// 都靠這一點，與 BuildInventoryCard 同一套慣例。
//
// dirs＝Scan() 走訪時逐目錄數出來的分母（見 scan.go dirStat）。
// entries＝Scan() 之後的 manifest 現況（分子的唯一來源）。
// excludedDirs＝整棵被剪掉的目錄與理由（Scan() 記的那份，**未裁切的全量**）。
func BuildFolderTree(absRoot, library string, dirs map[string]*dirStat, entries map[string]*ManifestEntry, excludedDirs []ExcludedDir, plan IngestPlan, now time.Time) FolderTree {
	nodes := map[string]*FolderNode{}

	// 遞迴閉包（補祖先鏈要呼叫自己）⇒ 必須先宣告再賦值。
	var ensure func(rel string) *FolderNode
	ensure = func(rel string) *FolderNode {
		if n, ok := nodes[rel]; ok {
			return n
		}
		n := &FolderNode{Path: rel, Name: folderNodeName(absRoot, rel), Parent: folderNodeParent(rel), Depth: folderNodeDepth(rel)}
		nodes[rel] = n
		// 中間層可能沒被 dirStat 記到（例如只有被剪掉的子目錄），補齊祖先鏈——
		// 少一層，畫面就接不成一棵樹（會變成一堆浮著的節點）。
		if rel != "" {
			ensure(n.Parent)
		}
		return n
	}
	ensure("") // 根一定存在，就算資料夾是空的（arcrun-rag#106 的整個重點）

	for rel, st := range dirs {
		if st == nil {
			continue
		}
		n := ensure(rel)
		n.TotalFiles = st.total
		n.UnsupportedFiles = st.unsupported
		n.ExcludedFiles = st.excluded
		// #180：這一層走進去了、數字是真的，但**一個檔都沒收** ⇒ 照樣要講得出為什麼。
		// 以前這種節點根本不存在（整棵被剪掉），現在存在了，就不能只給一個沒有解釋的
		// `0 / 6`——那對使用者跟「安靜地少收」是同一件事。
		// 🔴 子節點與真實數字都留著（leo 2026-08-28：「跳過的節點仍要展得開」）。
		if st.total > 0 && st.excluded == st.total && st.excludeWhy != "" {
			n.Skipped = true
			n.SkipReason = st.excludeWhy
		}
	}

	// 分子：manifest 現況。已送達且送上去之後沒再改過＝已同步，其餘＝還在路上。
	// 判準與 progress.go 的 Done 完全一致（同一句 `IngestedHash == ContentHash`），
	// 不另立第二把尺。
	for rel, e := range entries {
		if e == nil {
			continue
		}
		n := ensure(folderOfRel(rel))
		if e.IngestedHash != "" && e.IngestedHash == e.ContentHash {
			n.SyncedFiles++
		} else {
			n.PendingFiles++
		}
	}

	// 整棵被剪掉的目錄：列出來、講理由，數字留 0 但標 Skipped
	//（沒走進去就是不知道裡面有幾個檔——寫 0 當事實就是我們在編數字）。
	for _, ed := range excludedDirs {
		n := ensure(ed.Path)
		n.Skipped = true
		n.SkipReason = ed.Reason
	}

	out := make([]FolderNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, *n)
	}
	// 排序＝畫面每輪穩定（map 迭代順序隨機）。根永遠第一，其餘按路徑字母序。
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Path == "") != (out[j].Path == "") {
			return out[i].Path == ""
		}
		return out[i].Path < out[j].Path
	})

	total := len(out)
	truncated := false
	if total > MaxFolderTreeNodes {
		out = out[:MaxFolderTreeNodes]
		truncated = true
	}

	return FolderTree{
		Library:     library,
		DisplayName: folderNodeName(absRoot, ""),
		Root:        absRoot,
		Mode:        string(plan.Mode),
		Reason:      plan.Reason,
		Nodes:       out,
		Truncated:   truncated,
		TotalNodes:  total,
		GeneratedAt: now.Unix(),
	}
}

// folderOfRel 回傳某個檔案相對路徑所屬的目錄（根層檔案回 `""`）。
func folderOfRel(rel string) string {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if i := strings.LastIndexByte(rel, '/'); i > 0 {
		return rel[:i]
	}
	return ""
}

func folderNodeParent(rel string) string {
	if rel == "" {
		return "-" // 根：刻意不是空字串，不然分不出「我是根」與「我的父親是根」
	}
	return folderOfRel(rel)
}

func folderNodeDepth(rel string) int {
	if rel == "" {
		return 0
	}
	return strings.Count(rel, "/") + 1
}

// folderNodeName 回傳節點顯示名。根用監看資料夾自己的 basename——
// 使用者認得的是「我那個資料夾叫什麼」，不是一個空字串。
func folderNodeName(absRoot, rel string) string {
	if rel != "" {
		return path.Base(rel)
	}
	base := path.Base(strings.ReplaceAll(strings.TrimRight(absRoot, "/\\"), "\\", "/"))
	if base == "" || base == "." || base == "/" {
		return "知識資料夾"
	}
	return base
}

// Hash 回傳整棵樹的內容雜湊（不含 GeneratedAt——時間每輪都變，含進去就等於沒有冪等）。
func (t FolderTree) Hash() string {
	c := t
	c.GeneratedAt = 0
	data, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// syncFolderTree 每輪掃描後把樹送上雲端。回 nil＝這輪不必送。
//
// 冪等／防撞四層（前三層同 inventory.go 的慣例，刻意不另立一套）：
//
//	①整棵樹的內容雜湊記在 manifest.folder_tree_hash，沒變不送；
//	②同一份內容剛失敗過 → 退避窗口內不重撞；
//	③**成功送過之後有最小間隔**（folderTreeMinInterval，理由見該常數）；
//	④收端整棵覆寫（同一個 library 一把 KV），重送不堆副本、也不會留下半棵樹。
//
// 🔴 與 syncInventory 的差別：**沒有「本輪無事件就不送」那一條**。
// 空資料夾從頭到尾都沒有事件（arcrun-rag#106 的情境本身），漏掉這一送，
// 「指定了資料夾雲端就看得到」這件事永遠不會發生。
// ——但正因為拿掉了那道閘，才必須補上第③層，否則初次同步會變成每 5 秒送一次。
//
// 🔴 **整棵樹一次送**（本檔早先的版本切成每批 20 個節點，已拿掉）：
// 分批的唯一理由是「收端每個節點一次 KBDB 寫入＝一個 subrequest」，而收端
// （`cypher-executor` 的 `/portal/daemon/folder-tree`）把樹存成一把 KV、整棵覆寫
// ⇒ 一次回報只有一次寫入。分批在那個設計下只剩壞處：中途失敗留下半棵樹，
// 而且要另一套 prune 邏輯去清「這次沒報上來的節點」。
//
// 失敗不擋同步主流程（不設 exit）：樹是畫面層，它壞了檔案同步照常走；
// 但誠實回報 failed，不假綠。
func syncFolderTree(cfg *DirectConfig, absRoot string, m *Manifest, tree FolderTree, dryRun bool, now time.Time) *DirectResult {
	h := tree.Hash()
	if h != "" && h == m.FolderTreeHash {
		return nil // ①內容沒變
	}
	if h != "" && h == m.FolderTreeFailHash && now.Unix() < m.FolderTreeNextRetry {
		return nil // ②同一份內容剛失敗過，退避窗口內不重撞
	}
	// ③首次送出不受最小間隔限制（指定資料夾的當下就要看得見它）；之後才節流。
	if m.FolderTreeHash != "" && now.Unix() < m.FolderTreeNextSend {
		return nil
	}
	res := &DirectResult{Type: "folder_tree", Path: absRoot}
	if dryRun {
		res.Status = "planned"
		return res
	}

	pace() // 觸發雲端前一律節流（2026-08-07 pacing 慣例）
	// Nodes 至少有根一個（BuildFolderTree 的 ensure("")），空資料夾照送——
	// 收端據此把庫登記起來，這正是 arcrun-rag#106 的解。
	body := map[string]any{
		"library":      tree.Library,
		"display_name": tree.DisplayName,
		"root":         tree.Root,
		"mode":         tree.Mode,
		"reason":       tree.Reason,
		"truncated":    tree.Truncated,
		"total_nodes":  tree.TotalNodes,
		"generated_at": tree.GeneratedAt,
		"sync_token":   h,
		"nodes":        tree.Nodes,
	}
	status, _, err := cfg.postJSON(stepFolderTree, cfg.folderTreeURL(), body)
	res.HTTPStatus = status
	if err != nil {
		res.Status = "failed"
		// 🔴 **這句話會出現在使用者的畫面上**（status.json → 托盤），所以不准裸露
		// 錯誤碼／HTTP 狀態／上游 JSON 原文（同 direct_quota_test.go 那份禁字表：
		// 「4006」「502」「HTTP」「neurons」）。技術細節不必寫進這句——
		// `res.HTTPStatus` 已經把狀態碼結構化地留著了，要查的人查得到。
		//
		// 📌 這是本分支自己踩到的：原本寫成 `… + err.Error()`，於是額度耗盡那天
		// 使用者看到的會是 `HTTP 502：{"error":"4006: you have used up your daily
		// free allocation of 10,000 neurons"}`——技術上正確，人話上是零。
		// 分類走 inventory.go 早就在用的 `isQuotaExhausted`（InkStoneCo#43 立的那支），
		// 不另造第二套判斷。
		if isQuotaExhausted(err.Error()) {
			res.Error = "雲端今天的額度用完了，資料夾結構會稍後自動補送（不影響檔案同步）"
		} else {
			res.Error = "資料夾結構這次沒送上去，稍後會自動再試（不影響檔案同步）"
		}
		m.FolderTreeFailHash = h
		m.FolderTreeNextRetry = now.Add(folderTreeRetryDelay).Unix()
		return res
	}
	res.Status = "ingested"
	m.FolderTreeHash = h
	m.FolderTreeFailHash = ""
	m.FolderTreeNextRetry = 0
	m.FolderTreeNextSend = now.Add(folderTreeMinInterval).Unix()
	return res
}

// ── 本機那一份：桌面小幫手要攤開的，是同一棵樹 ─────────────────────────────
//
// 🔴 為什麼要在本機也落地一份（`inkstone/InkStoneCo#44`，leo 2026-08-26）：
//
// leo 的交付定義第一段是「**在 Portal 和桌面小幫手上**，任何一個連上的資料夾
// 都攤得開它完整的巢狀子資料夾樹」。上面的 syncFolderTree 只完成了前半——
// 樹送上雲端、由 portal 讀回來畫。**桌面小幫手不能走那條路**，三個理由：
//
//	① 它要在**離線**、雲端額度用完、或 syncFolderTree 正在退避窗口裡的時候
//	   照樣攤得開——那些正是使用者最想知道「到底同步到哪了」的時刻；
//	② 樹是**本機算出來的**（分母來自這台電腦的 WalkDir），繞一趟雲端再拿回來，
//	   等於讓本機畫面依賴一條它根本不需要的網路；
//	③ syncFolderTree 有內容雜湊閘與最小間隔，**它回 nil 的輪次遠多於送出的輪次**
//	   ——本機畫面不該跟著那道為了省 KV 額度而設的閘一起沉默。
//
// 🔴 **不另算第二套**（本票紅線）：這裡存下來的就是 BuildFolderTree 交出、
// 也正要送上雲端的那個 `FolderTree`，一個欄位都不重組、一個數字都不重算。
// 桌面與 portal 看到的若有一天不一樣，那只可能是「哪一邊比較舊」，
// 不可能是「兩邊各自算」。

// FolderTreeStore＝本機的樹快照（key＝監看根的絕對路徑）。
//
// 為什麼是「一個檔裝全部」而不是每個根一個檔：桌面小幫手拿得到的是
// config 裡那串資料夾路徑，用路徑當 key 直接查得到；每根一檔就得讓 App 去
// 複製 manifestPathFor 那條 host＋路徑的雜湊公式——**那才是第二份實作**。
type FolderTreeStore struct {
	UpdatedAt string                `json:"updated_at"`
	Trees     map[string]FolderTree `json:"trees"`
}

// FolderTreeStorePath 回傳本機樹快照的路徑：與 manifest／status.json 同目錄。
func FolderTreeStorePath(manifestPath string) string {
	return filepath.Join(filepath.Dir(manifestPath), "folder-trees.json")
}

// LoadFolderTreeStore 讀回上一輪的快照；讀不到／解析失敗都回可用的零值
// （呼叫端當「沒有上一輪」處理，與 LoadSyncStatus 同一套慣例）。
func LoadFolderTreeStore(path string) (FolderTreeStore, error) {
	s := FolderTreeStore{Trees: map[string]FolderTree{}}
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return FolderTreeStore{Trees: map[string]FolderTree{}}, err
	}
	if s.Trees == nil {
		s.Trees = map[string]FolderTree{}
	}
	return s, nil
}

// SaveFolderTreeStore 覆寫快照。
func SaveFolderTreeStore(path string, s FolderTreeStore) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// MergeFolderTreeStore 把「這一輪算出來的樹」併進上一輪的快照。
//
// 三條規則，每一條都對應一個會讓畫面說謊的情境：
//
//	① 這一輪算出來的**覆蓋**舊的——樹永遠是現況，不累積歷史。
//	② 這一輪**沒算出來**（那個根掃描失敗、或還沒輪到）⇒ 沿用上一輪的。
//	   不然使用者會看到自己昨天還好好的資料夾突然變成「還沒回報」——
//	   那是 2026-08-05「明明做完了畫面卻說等待中」同一個形狀的病。
//	③ 已經**不在看守清單**上的根⇒刪掉。留著就是一棵指向不存在設定的幽靈樹，
//	   而且使用者移除資料夾之後還看得到它，會以為沒移掉。
//
// knownRoots＝這一輪 RunDirectOnce 打算處理的所有監看根（不論成功與否）。
func MergeFolderTreeStore(prev FolderTreeStore, fresh map[string]FolderTree, knownRoots []string, now time.Time) FolderTreeStore {
	known := make(map[string]bool, len(knownRoots))
	for _, r := range knownRoots {
		known[r] = true
	}
	out := FolderTreeStore{UpdatedAt: now.UTC().Format(time.RFC3339), Trees: map[string]FolderTree{}}
	for root, t := range prev.Trees {
		if known[root] { // ②③：還在看守清單上才留，其餘丟掉
			out.Trees[root] = t
		}
	}
	for root, t := range fresh {
		out.Trees[root] = t // ①
	}
	return out
}
