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

// vaultCardsRelDir 是監看根被判定成 Logseq/Obsidian vault 時，卡片改落的位置（arcrun-rag#60）。
// 刻意用點開頭的隱藏目錄：Logseq/Obsidian 預設都不掃描點開頭的資料夾（跟 .git/.obsidian
// 同待遇），daemon 自己的 Scan() 也一樣（見 scan.go「隱藏目錄整棵跳過」）——三邊一致，
// 卡片仍然落在監看根底下（呼叫端「路徑相對監看根」的假設不用改），但不會被筆記軟體
// 收編成新頁面，vault 的頁面數不會因為 daemon 跑過而增加。
const vaultCardsRelDir = ".arcrun-rag/wiki/cards"

// cardsRelDirFor 決定某次萃取的卡片該落在哪個相對路徑：非 vault 用 cardsRelDir（不變），
// vault 用 vaultCardsRelDir（arcrun-rag#60）。vault 判準見 vault.go，與 install.sh 對齊。
func cardsRelDirFor(absRoot string) string {
	if IsVault(absRoot) {
		return vaultCardsRelDir
	}
	return cardsRelDir
}

// snapshotCards 記 cards/ 目前每檔 mtime+size（偵測萃取後的新卡/變卡）。
func snapshotCards(absRoot string) map[string]fileState {
	out := map[string]fileState{}
	base := filepath.Join(absRoot, filepath.FromSlash(cardsRelDir))
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
		return nil, fmt.Errorf("claude 跑完但 %s 沒有新卡片（輸出尾段：%.200s）", cardsRelDir, string(out))
	}
	return cards, nil
}
