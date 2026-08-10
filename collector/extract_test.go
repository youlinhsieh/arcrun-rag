// extract_test.go — task 3 claude 萃取路（用 stub 執行檔驗呼叫契約，不需真 claude）。
package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// writeStubClaude 產生一支假 claude：驗證收到的參數與 cwd，並寫一張卡進 cards/。
func writeStubClaude(t *testing.T, dir string, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("stub 腳本測試僅跑 unix")
	}
	p := filepath.Join(dir, "claude")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// 正常路：stub 收到 -p "/rag-extract-file <檔>"、cwd＝監看根，寫卡後被 diff 偵測到。
func TestExtractWithClaudeHappyPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "system-dev", "wiki", "cards"), 0o755); err != nil {
		t.Fatal(err)
	}
	stub := writeStubClaude(t, t.TempDir(), fmt.Sprintf(`
[ "$1" = "-p" ] || { echo "第一參數應為 -p，got $1" >&2; exit 9; }
case "$2" in "/rag-extract-file 我的筆記.md") ;; *) echo "prompt 錯：$2" >&2; exit 9;; esac
[ "$(pwd)" = "%s" ] || { echo "cwd 錯：$(pwd)" >&2; exit 9; }
mkdir -p system-dev/wiki/cards
printf '# 我的筆記\n\n## 摘要\nstub 卡\n' > "system-dev/wiki/cards/我的筆記.md"
`, root))
	cards, err := ExtractWithClaude(stub, root, "我的筆記.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0] != "system-dev/wiki/cards/我的筆記.md" {
		t.Fatalf("cards=%v", cards)
	}
}

// claude 跑完但沒寫卡＝誠實報錯（不假綠）。
func TestExtractWithClaudeNoCard(t *testing.T) {
	root := t.TempDir()
	stub := writeStubClaude(t, t.TempDir(), "exit 0\n")
	if _, err := ExtractWithClaude(stub, root, "x.md"); err == nil {
		t.Fatal("沒寫卡應報錯")
	}
}

// 找不到執行檔＝引導改用 gemma 路的錯誤訊息。
// t92：覆蓋 fallback 清單為空，確保即使本機有 claude 安裝，測試仍能驗到「找不到」路徑。
func TestExtractWithClaudeMissingBin(t *testing.T) {
	orig := claudeFallbackPaths
	claudeFallbackPaths = nil // 停用 fallback，讓找不到 /no/such/claude-bin 就直接報錯
	defer func() { claudeFallbackPaths = orig }()

	if _, err := ExtractWithClaude("/no/such/claude-bin", t.TempDir(), "x.md"); err == nil {
		t.Fatal("缺執行檔應報錯")
	}
}
