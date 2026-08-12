#!/usr/bin/env bash
# verify-60.sh — arcrun-rag#60 第二輪的五項驗收，一次跑完並把實測輸出印出來。
#
# 用法（在 repo 任何位置都可以）：
#   bash collector/verify-60.sh 2>&1 | tee /tmp/verify-60.log
#
# 這支腳本不碰網路、不碰任何真實資料夾——fixture 全建在自己的暫存目錄裡，
# 跑完就刪。它印出的東西就是要貼進 issue #60 的證據。
#
# ⚠️ collector/ 自己是一個獨立的 Go module（module arcrun-rag/collector），
#    所有 go 指令都必須在 collector/ 裡面跑，不是在 repo 根目錄。
set -uo pipefail

cd "$(dirname "$0")" || exit 1   # ← collector/（module 根）
FAIL=0

hr() { printf '\n══════════════════════════════════════════════════════════════\n%s\n══════════════════════════════════════════════════════════════\n' "$1"; }

hr "① 格式與編譯"
if [ -n "$(gofmt -l .)" ]; then
  echo "⚠️  下列檔案未照 gofmt 格式化，跑一次 gofmt -w ."; gofmt -l .
else
  echo "gofmt：乾淨"
fi
go vet ./... || FAIL=1
go build ./... || { echo "❌ 編譯失敗"; exit 1; }
echo "編譯：通過"

hr "② 既有 Go 測試全綠（驗收條件⑤）"
go test ./... || FAIL=1

hr "③ 足跡測試：真的有既有日誌檔的 vault，跑之前／跑之後的完整檔案清單（驗收條件①②④）"
go test . -run 'Footprint' -v || FAIL=1

hr "④ 舊產物收拾：在一個「已經被舊版 daemon 弄髒」的真 vault 上實跑（驗收條件③）"
VAULT="$(mktemp -d)"
trap 'rm -rf "$VAULT"' EXIT

# ── 使用者自己的東西 ────────────────────────────────────────────
mkdir -p "$VAULT/logseq" "$VAULT/pages" "$VAULT/journals"
echo '{:default-home {:page "contents"}}' > "$VAULT/logseq/config.edn"
echo '- 我自己的目錄頁'        > "$VAULT/pages/contents.md"
echo '- 我自己寫的讀書筆記'     > "$VAULT/pages/讀書筆記.md"
echo '- 我自己寫的日記'         > "$VAULT/journals/2026_08_10.md"
echo '- 昨天的日記'             > "$VAULT/journals/2026_08_11.md"

# ── 舊版 daemon 已經弄進去的產物（leo 實際看到的那批）─────────────
mkdir -p "$VAULT/system-dev/wiki/cards" "$VAULT/.arcrun-rag/wiki/cards" "$VAULT/scripts"
echo '# status'   > "$VAULT/system-dev/wiki/status.md"
echo '# mistakes' > "$VAULT/system-dev/wiki/mistakes.md"
echo '#!/bin/sh'  > "$VAULT/scripts/sdd-active-check.sh"
echo '# 2026_08_10' > "$VAULT/.arcrun-rag/wiki/cards/2026_08_10.md"
echo '# 舊卡'       > "$VAULT/.arcrun-rag/wiki/cards/2026_08_10.md.bak-1723459200000000000"
echo '# 會議記錄'   > "$VAULT/system-dev/wiki/cards/會議記錄.md"

# 使用者檔案的內容指紋，最後要逐一比對「一個都沒被動到」
BEFORE_HASH="$(find "$VAULT/pages" "$VAULT/journals" "$VAULT/logseq" -type f -exec shasum {} \; | sed "s|$VAULT/||" | sort)"

echo "── 收拾之前的完整檔案清單 ──"
LIST_BEFORE="$(cd "$VAULT" && find . -type f | sort)"
echo "$LIST_BEFORE"

echo
echo "── collector tidy（預設只看不動）──"
go run ./cmd/collector tidy --folder "$VAULT" || FAIL=1

echo
echo "── 確認 dry-run 真的什麼都沒動 ──"
LIST_AFTER_DRYRUN="$(cd "$VAULT" && find . -type f | sort)"
if [ "$LIST_BEFORE" = "$LIST_AFTER_DRYRUN" ]; then
  echo "✅ dry-run 後檔案清單與之前逐字相同"
else
  echo "❌ dry-run 竟然動了東西："; diff <(echo "$LIST_BEFORE") <(echo "$LIST_AFTER_DRYRUN"); FAIL=1
fi

echo
echo "── collector tidy --apply（真的動手）──"
go run ./cmd/collector tidy --folder "$VAULT" --apply || FAIL=1

echo
echo "── 收拾之後的完整檔案清單 ──"
(cd "$VAULT" && find . -type f | sort)

echo
echo "── 檢查一：使用者原本的檔案，一個都沒被動到 ──"
AFTER_HASH="$(find "$VAULT/pages" "$VAULT/journals" "$VAULT/logseq" -type f -exec shasum {} \; | sed "s|$VAULT/||" | sort)"
if [ "$BEFORE_HASH" = "$AFTER_HASH" ]; then
  echo "✅ 使用者的 5 個檔案內容與路徑完全未變"
else
  echo "❌ 使用者的檔案被動過："; diff <(echo "$BEFORE_HASH") <(echo "$AFTER_HASH"); FAIL=1
fi

echo
echo "── 檢查二：機器產物一律帶 arcrun- 前綴，且沒有任何一個與使用者頁面同名 ──"
STRAY=0
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in arcrun-*) ;; *) echo "  ❌ 沒帶前綴：$f"; STRAY=1;; esac
done < <(cd "$VAULT" && find ./.arcrun-rag/wiki/cards ./system-dev/wiki/cards -type f 2>/dev/null)
[ "$STRAY" -eq 0 ] && echo "✅ 卡片產物區全部帶前綴" || FAIL=1

echo
echo "── 檢查三：template 殘留被搬走而不是被刪掉（東西還在） ──"
for f in system-dev/wiki/status.md system-dev/wiki/mistakes.md scripts/sdd-active-check.sh; do
  if [ -f "$VAULT/.arcrun-rag/legacy-template/$f" ]; then
    echo "  ✅ $f → .arcrun-rag/legacy-template/$f（內容還在）"
  else
    echo "  ❌ $f 不見了"; FAIL=1
  fi
done

echo
echo "── 檢查四：冪等（再跑一次不該有任何動作） ──"
go run ./cmd/collector tidy --folder "$VAULT" --apply || FAIL=1

hr "結果"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 全部通過"
else
  echo "❌ 有項目未通過，往上找 ❌"
fi
exit "$FAIL"
