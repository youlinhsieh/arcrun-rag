#!/bin/bash
# PreToolUse hook 範本骨架 —— 專案自訂禁令（預設空殼，不攔任何東西）
#
# ⚠️ 定位（讀清楚再用）：
#   這支跟其他三支 hook 不同——它不是「裝上就生效的警察」，而是一個「按需手填的
#   空插槽」。預設狀態下 FORBIDDEN_PATTERNS 是空的，它【不攔任何東西】。
#   別誤以為裝了它就有保護——空殼 = 沒保護。
#
# 🤖 有 CC 在場的話，通常不需要這個範本：
#   直接叫你的 CC「幫我寫一支 guard hook，禁止改 X」。CC 現寫的條件邏輯，
#   表達力遠勝這裡的 glob FORBIDDEN_PATTERNS（例如「禁子 repo 的 code 但放行 .md」
#   這種細緻規則，glob 寫不出來，CC 的條件判斷寫得出來）。
#   這個範本只對「不靠 CC、想自己手動 DIY bash」的用戶有價值。
#
# 要啟用（手動 DIY 路線）：
#   1. 在下面 FORBIDDEN_PATTERNS 填禁改的路徑/檔名 pattern
#   2. 到 .claude/settings.json 的 PreToolUse 加掛這支
#
# 掛在 PreToolUse（matcher: Write|Edit）。stdin 收 JSON：{ tool_name, tool_input:{ file_path } }
# 命中禁令 → exit 2 擋。
#
# 誠實限制：只擋直接寫檔。bash 繞道、helper 間接改動擋不到。留痕可審 ≠ 技術防偽。

set -euo pipefail

# ── 專案自訂：禁改的 pattern（一行一個，case glob 語法）──────
# 範例（已註解，啟用前請改成自己的）：
#   "*/db/schema.sql"      # 禁手改 schema
#   "*/migrations/*"        # migration 一旦建立不可改
FORBIDDEN_PATTERNS=(
  # "*/your/protected/path/*"
)

# 沒設任何禁令 → 空殼狀態，安靜放行。
# （不在這裡 print——PreToolUse 每次 Write/Edit 都會跑，每次喊話會洗版。
#  「這是空殼」的提醒改由 install.sh / update.sh 安裝時告知，那裡用戶一定看得到。）
[ ${#FORBIDDEN_PATTERNS[@]} -eq 0 ] && exit 0

INPUT=$(cat)

if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
else
  FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//')
fi

[ -z "$FILE_PATH" ] && exit 0

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  # shellcheck disable=SC2254
  case "$FILE_PATH" in
    $pattern)
      cat >&2 <<EOF
🚫 專案禁令攔截：$FILE_PATH 命中禁改規則（$pattern）。

這是本專案 .claude/hooks/pre-write-guard.sh 設定的硬底線。
要動 → 先和負責人確認，並更新禁令設定。
EOF
      exit 2
      ;;
  esac
done

exit 0
