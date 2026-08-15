// extract.go — 可插拔本地萃取器（daemon-beta task 3/4，四步定稿第 3 步）。
//
// leo 定稿：「由現在的 gemma4 幫你本地萃，或是用你自己的訂閱帳號，例如叫起 claude 幫你萃。」
//   - claude 路（task 3）：執行 `claude -p "/rag-extract-file <檔>"`，cwd＝監看根——
//     template 既有萃取流**原樣重用**（prompt 都不搬），卡片由 CC 寫進 system-dev/wiki/cards/。
//     用戶自己的訂閱＝我們零 API 成本。
//   - gemma 路（task 4）：Go 內直呼 Gemini API，卡片由 daemon 自己寫進 cards/。
//
// 兩路的產出契約相同：回傳「本次新增/變動的卡片相對路徑」，交 task 6 推 ingest。
// 原文永不出本函式（claude 路整段在用戶機器；gemma 路內容過境 API 但不落任何雲儲存）。
package collector

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// claudeFallbackPaths 是 PATH 找不到 claude 時依序嘗試的絕對路徑清單。
// Finder 啟動的 GUI app 只拿最小 PATH（/usr/bin:/bin 等），brew 裝的 claude 在此找不到（t92）。
// 測試可覆蓋此變數注入暫存目錄，無需真的安裝 Claude Code。
var claudeFallbackPaths = defaultClaudeFallbackPaths()

func defaultClaudeFallbackPaths() []string {
	home, _ := os.UserHomeDir()
	paths := []string{
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	}
	if home != "" {
		paths = append(paths,
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, ".claude", "local", "claude"),
		)
	}
	return paths
}

// FindClaudeBin 找可執行的 claude 二進位：先試 hint（空＝"claude"）在 PATH；
// 找不到再依序掃 claudeFallbackPaths（解決 Finder 啟動 app PATH 不含 /opt/homebrew/bin 的問題）。
// 回傳完整絕對路徑，或「全都找不到」的白話錯誤。
func FindClaudeBin(hint string) (string, error) {
	if hint == "" {
		hint = "claude"
	}
	if p, err := exec.LookPath(hint); err == nil {
		return p, nil
	}
	for _, p := range claudeFallbackPaths {
		info, err := os.Stat(p)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	tried := append([]string{hint}, claudeFallbackPaths...)
	return "", fmt.Errorf("找不到 Claude 指令（試了 %s）——請確認 Claude Code 已安裝，或改用 Gemma 萃取路",
		strings.Join(tried, "、"))
}

// cardsRelDir 是 template 規約的卡片產物區（相對監看根）——一般資料夾（非 vault）用這個，
// 行為與改 Go 版之前完全一致。
const cardsRelDir = "system-dev/wiki/cards"

// vaultCardsRelDir 是監看根**落在** Logseq/Obsidian vault 範圍內時，卡片改落的位置（arcrun-rag#60）。
// 刻意用點開頭的隱藏目錄：Logseq/Obsidian 預設都不掃描點開頭的資料夾（跟 .git/.obsidian
// 同待遇），daemon 自己的 Scan() 也一樣（見 scan.go「隱藏目錄整棵跳過」）——三邊一致，
// 卡片仍然落在監看根底下（呼叫端「路徑相對監看根」的假設不用改），但不會被筆記軟體
// 收編成新頁面，vault 的頁面數不會因為 daemon 跑過而增加。
const vaultCardsRelDir = ".arcrun-rag/wiki/cards"

// cardsRelDirFor 決定某次萃取的卡片該落在哪個相對路徑：
// 監看根既不在筆記庫、也不在版控裡＝cardsRelDir（一般資料夾行為，零改變）；
// 落在筆記庫或版控範圍內＝vaultCardsRelDir（隱藏目錄）。
//
// 🔴 arcrun-rag#60 第三輪：判準從 IsVault（只看監看根**這一層**）換成 DetectVaultContext
// （監看根**在不在**某個筆記庫裡）。前者在「監看根是 vault 底下的子資料夾」時回 false，
// 於是卡片落回 `<監看根>/system-dev/wiki/cards/`——那個位置就在使用者的 vault 裡面，
// 而且不是隱藏目錄，Logseq/Obsidian 會把每一張卡收編成一頁。全文見 vault.go 第三輪那段。
//
// 🔴 arcrun-rag#105：**版控中的資料夾與 vault 同待遇**。理由是同一個形狀——
// `system-dev/wiki/cards/` 在 repo 裡不是空地，那是 template 規約路徑，
// 使用者自己的卡就住在那裡；而且不管撞不撞名，往那裡寫東西就是往他的 git status
// 裡塞 untracked 檔。落進 `.arcrun-rag/`（配 EnsureWorkspaceIgnored 自我忽略）
// ＝寫得進去、又不弄髒他的版控。
func cardsRelDirFor(absRoot string) string {
	if DetectVaultContext(absRoot).InVault() || UnderVersionControl(absRoot) {
		return vaultCardsRelDir
	}
	return cardsRelDir
}

// cardRelFor 回傳「這份原稿萃出來的卡片」相對監看根的完整路徑。
//
// 🔴 arcrun-rag#60 第二輪：**daemon 在監看根底下產生的檔名一律經過這裡**，
// 誰都不准自己拼 `pageName + ".md"`。目前三個呼叫端必須拿到同一個答案，
// 少一個對齊就會留下孤兒檔或清不掉的卡：
//
//	① 落卡（extract_gemma.go／extract_workersai.go）
//	② 下架時清本地卡（direct.go 的 removed 分支）
//	③ 萃取前後的快照比對（snapshotCards，claude 路用）
//
// 檔名帶 MachineMark 前綴＝Logseq/Obsidian 的頁名變成 `arcrun-<原頁名>`，
// 與使用者自己的頁面**永不同名**（上一輪漏的正是這一層，見 machinemark.go 開頭）。
func cardRelFor(absRoot, pageName string) string {
	return filepath.ToSlash(filepath.Join(cardsRelDirFor(absRoot), MarkName(pageName+".md")))
}

// snapshotCards 記卡片產物區目前每檔 mtime+size（偵測萃取後的新卡/變卡）。
//
// 🔴 這裡原本硬寫 cardsRelDir 一個目錄，兩邊都不對：
//   - vault 上，落卡其實去了 .arcrun-rag/wiki/cards/ ⇒ snapshot 到一個永遠是空的目錄，
//     diffCards 算不到新卡，claude 路必定誤報「跑完但沒有新卡片」。
//   - 而 claude 路的**寫檔位置是 skill（prompt）決定的**，它硬寫 system-dev/wiki/cards/，
//     連在 vault 上也一樣 ⇒ 只看 cardsRelDirFor 那一個目錄同樣會漏。
//
// ⇒ 兩個目錄都掃。誰寫到哪裡都逃不掉，之後由 enforceCardMarks 統一歸位＋補標記。
func snapshotCards(absRoot string) map[string]fileState {
	out := map[string]fileState{}
	for _, relDir := range []string{cardsRelDir, vaultCardsRelDir} {
		base := filepath.Join(absRoot, filepath.FromSlash(relDir))
		_ = filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || filepath.Ext(p) != ".md" {
				return nil
			}
			rel, rerr := filepath.Rel(absRoot, p)
			if rerr != nil {
				return nil
			}
			out[filepath.ToSlash(rel)] = fileState{size: info.Size(), mtime: info.ModTime().UnixNano()}
			return nil
		})
	}
	return out
}

// diffCards 比對兩次快照，回傳新增或內容變動的卡片相對路徑（排序穩定交由呼叫端）。
func diffCards(before, after map[string]fileState) []string {
	var changed []string
	for p, st := range after {
		if b, ok := before[p]; !ok || b.size != st.size || b.mtime != st.mtime {
			changed = append(changed, p)
		}
	}
	return changed
}

// claudeExtractTimeout：單檔萃取上限。CC 冷啟＋讀檔＋寫卡實測分鐘級，給足裕度。
const claudeExtractTimeout = 10 * time.Minute

// ExtractWithClaude 叫起用戶自己的 claude 跑 template 的 /rag-extract-file（task 3）。
// binPath 空或 PATH 找不到時，自動掃 claudeFallbackPaths（t92 Finder 啟動 PATH 不完整）。
// 回傳本次產出的卡片相對路徑。
func ExtractWithClaude(binPath, absRoot, relPath string) ([]string, error) {
	resolved, err := FindClaudeBin(binPath)
	if err != nil {
		return nil, err
	}
	before := snapshotCards(absRoot)

	ctx, cancel := context.WithTimeout(context.Background(), claudeExtractTimeout)
	defer cancel()
	// /rag-extract-file＝template 既有萃取 skill；cwd＝監看根（template 已代裝，skill 就在 .claude/commands/）。
	// --permission-mode acceptEdits：headless 無人按核准，寫卡會卡在權限確認（07-24 真機 e2e 實撞）；
	// acceptEdits 只自動放行檔案編輯、不放行任意 Bash，範圍侷限在監看根（cwd）。
	cmd := exec.CommandContext(ctx, resolved, "-p", fmt.Sprintf("/rag-extract-file %s", relPath), "--permission-mode", "acceptEdits")
	cmd.Dir = absRoot
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("claude 萃取逾時（%s）", claudeExtractTimeout)
	}
	if err != nil {
		snippet := string(out)
		if len(snippet) > 400 {
			snippet = snippet[len(snippet)-400:]
		}
		return nil, fmt.Errorf("claude 萃取失敗：%w；輸出尾段：%s", err, snippet)
	}

	cards := diffCards(before, snapshotCards(absRoot))
	if len(cards) == 0 {
		return nil, fmt.Errorf("claude 跑完但 %s 沒有新卡片（輸出尾段：%.200s）", cardsRelDirFor(absRoot), string(out))
	}
	return enforceCardMarks(absRoot, cards, before), nil
}

// enforceCardMarks 把「不是我們親手命名」的卡片**歸位並補上標記**。
//
// 🔴 為什麼這條路需要它：claude 路的檔名與寫入目錄都是**skill 檔（prompt）決定的**，
// 不是 Go 決定的（/rag-extract-file 自己寫 `system-dev/wiki/cards/<頁名>.md`，
// 而且不認得 vault）。若放著不管，同一個 daemon 就會出現「gemma 路的卡有前綴、
// claude 路的卡沒有」，而且在 vault 上還會落在**可見目錄**——正好踩中
// 「一部分加一部分不加，比全不加更難分」那條紅線，且破口在 prompt 裡，改 Go 永遠修不到。
//
// ⇒ **命名與落點的契約收回 Go 這一側強制執行**：不管上游寫成什麼、寫到哪，
// 離開這個函式時一定是 cardRelFor 算出來的那個位置與名字。
// 目標已被佔用或搬不動時，照實回報原路徑（不覆蓋、不假裝成功），剩下的交給 tidy。
func enforceCardMarks(absRoot string, cards []string, before map[string]fileState) []string {
	want := cardsRelDirFor(absRoot)
	out := make([]string, 0, len(cards))
	for _, rel := range cards {
		base := filepath.Base(rel)
		dir := filepath.ToSlash(filepath.Dir(rel))
		if IsMarked(base) && dir == want {
			out = append(out, rel)
			continue
		}
		// 🔴 arcrun-rag#105 第二輪（2026-08-15）：**本來就存在的檔案，一律不搬。**
		//
		// 這是 `cc6e500`（08-14，`MigrateCardNames`）同一個事故的第二次，連數字都一樣：
		// 那次「把 system-dev/wiki/cards/autonomy/ 整個子目錄壓平改名，16 個版控中的檔案
		// 變成刪除」；今天換成 `cards/decisions/`，同樣 16 個。
		// **上次只修了 MigrateCardNames，這支做一模一樣的事卻被漏掉。**
		//
		// 真兇在 `cards` 這份清單的來源：`diffCards` 把「**新增**」與「**內容變動**」
		// 併成同一個回傳值，而 `snapshotCards` **同時掃 cardsRelDir 與 vaultCardsRelDir
		// 兩棵樹**。於是萃取 skill 正當地更新一張既有索引卡（`cards/decisions/00-INDEX.md`）
		// ⇒ mtime 變了 ⇒ 被當成「本次產出的卡」⇒ 判定「不在 want 目錄」⇒ 搬走改名。
		// **更新一張索引卡，就會害它被踢出自己的桶子。**
		// 而子資料夾不是意外，是規約：`system-dev/wiki/INDEX.md` 寫著
		// 「INDEX →『cards/<bucket>/00-INDEX.md』→ 概念原子卡」。壓平＝把那條檢索鏈剪斷。
		//
		// 🔴 分界是「**這次新生的，還是本來就在的**」，不是「在不在某個目錄底下」：
		//   - 這次新生 ⇒ 就是 skill 剛寫的那張，歸位＋加前綴（#60 防撞名、#105 落 .arcrun-rag，
		//     兩條保護都要留著，那是這支存在的理由）
		//   - 本來就在 ⇒ **不管它在哪、叫什麼，都不准動**。它可能是使用者手寫的 wiki。
		// `IsMarked` 分不出「上游寫錯位置的卡」與「使用者自己的檔案」，而猜錯的代價不對等：
		// 名字沒前綴只是難看，**搬走使用者的檔案是不可逆的**。
		if _, existed := before[rel]; existed {
			out = append(out, rel)
			continue
		}
		newRel := cardRelFor(absRoot, UnmarkName(strings.TrimSuffix(base, ".md")))
		if newRel == rel {
			out = append(out, rel)
			continue
		}
		from := filepath.Join(absRoot, filepath.FromSlash(rel))
		to := filepath.Join(absRoot, filepath.FromSlash(newRel))
		if _, err := os.Stat(to); err == nil {
			out = append(out, rel) // 新位置已被佔用，不覆蓋
			continue
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			out = append(out, rel)
			continue
		}
		if err := os.Rename(from, to); err != nil {
			out = append(out, rel) // 搬不動就照實回報原路徑，不假裝成功
			continue
		}
		out = append(out, newRel)
	}
	return out
}
