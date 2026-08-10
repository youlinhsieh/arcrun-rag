#!/bin/bash
# PreToolUse hook — 寫入 wiki 前掃機敏資訊（L3 硬攔截）
#
# 為什麼存在：wiki 的 ignore 規則（.wikiignore + 行內標記）是「協議層」，靠 CC 遵守。
# 但密碼/金鑰/個資外洩是「不可逆」後果——只靠口頭約束太危險。
# 這支 hook 是機械式底線：CC 真的把機敏資訊寫進 system-dev/wiki/ 的那一刻 → exit 2 擋下。
#
# 掛在 settings.json 的 PreToolUse（matcher: Write|Edit）。
# stdin 收到 JSON：{ tool_name, tool_input: { file_path, content?, new_string? } }
# 行為：只在目標路徑是 system-dev/wiki/** 時啟動，掃要寫入的內容，命中機敏特徵 → exit 2。
#
# 誠實限制（抄 sdd-guard）：regex 偵測有偽陰/偽陽。
# 擋的是「明顯特徵的機敏字串被自動抄進 wiki」，擋不了刻意混淆/編碼的繞道。
# 價值是「意外外洩的機械底線 + 留痕可審」，不是技術防偽。絕不聲稱「不可能繞過」。

set -euo pipefail

INPUT=$(cat)

# ── 解析 file_path 與要寫入的內容。優先 jq，無 jq 退回 grep（容錯）──────
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
  # Write 用 content；Edit 用 new_string。兩個都抓，合起來掃。
  CONTENT=$(printf '%s' "$INPUT" | jq -r '[.tool_input.content, .tool_input.new_string] | map(select(. != null)) | join("\n")')
else
  FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//')
  # 無 jq 時內容解析不可靠（JSON 跳脫），退回掃整包 INPUT，寧可多掃不漏掃
  CONTENT="$INPUT"
fi

# 拿不到路徑 → 不擋（容錯，寧可放過也不誤殺）
[ -z "$FILE_PATH" ] && exit 0

# 只管寫進 wiki 的動作。其他路徑放行（這支專責 wiki 洩漏，不是全域 secret scanner）
case "$FILE_PATH" in
  *system-dev/wiki/*) ;;
  *) exit 0 ;;
esac

[ -z "$CONTENT" ] && exit 0

# 行內豁免：若該段內容已被標記為刻意保留（例：範例文件要示範格式），略過該行
# 標記：行尾加  # wiki-secret-ok  （或 <!-- wiki-secret-ok -->）
# 先把標記過的行抽掉再掃。
SCAN=$(printf '%s' "$CONTENT" | grep -v -E 'wiki-secret-ok' || true)
[ -z "$SCAN" ] && exit 0

# ── 機敏特徵 pattern。一行一類，命中即攔。──────────────────────────
# 設計取捨：偏向高訊號 pattern（有明確結構的金鑰/標記），降低偽陽。
# 純「password=xxx」這類也納入，因為那正是使用者最擔心的場景。
HITS=""

check() {
  local label="$1" regex="$2"
  # -e 讓以 - 開頭的 pattern（如 PEM 的 -----BEGIN）不被當成選項。
  # grep 無命中回傳 1，在 set -e 下會中止 → 用 if 包住吸收掉。
  if printf '%s' "$SCAN" | grep -qiE -e "$regex"; then
    HITS="${HITS}
   • ${label}"
  fi
}

# 密碼/密鑰賦值（password = ..., secret: ..., api_key=...）
check "密碼/密鑰賦值 (password/secret/api_key/token = ...)" \
  '(pass(word)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|priv(ate)?[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]<>"'"'"']{6,}'

# 私鑰 PEM 區塊
check "私鑰檔內容 (BEGIN ... PRIVATE KEY)" \
  '-----BEGIN[[:space:]].*PRIVATE KEY-----'

# 常見雲端/服務金鑰前綴
check "服務金鑰特徵 (AWS/GitHub/Slack/Google/Stripe 等)" \
  '(AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{20,}|sk_(live|test)_[0-9A-Za-z]{16,})'

# JWT
check "JWT token" \
  'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'

# 連線字串內嵌帳密 (proto://user:pass@host)
check "連線字串內嵌帳密 (proto://user:pass@host)" \
  '[a-z][a-z0-9+.-]*://[^[:space:]:/@]+:[^[:space:]:/@]+@'

# 台灣身分證字號（個資）。BSD/GNU grep 都支援 ERE，避免 \b（BSD 不認），改用字元類邊界。
check "台灣身分證字號 (個資)" \
  '(^|[^A-Za-z0-9])[A-Z][12][0-9]{8}([^0-9]|$)'

# 信用卡號（個資，粗略 13-16 連續數字，可含空格/連字號分隔）。避免 PCRE，用 ERE 近似。
check "疑似信用卡號 (個資)" \
  '(^|[^0-9])[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{0,4}([^0-9]|$)'

# Email 不擋（wiki 常需記聯絡人），手機號也不擋（偽陽太高）——刻意留白。

if [ -n "$HITS" ]; then
  cat >&2 <<EOF
🚫 Wiki 機敏攔截：偵測到可能的機敏資訊要寫進 ${FILE_PATH}。

命中特徵：${HITS}

wiki 是會被 CC 反覆讀取、可能進版控的記憶空間。
密碼 / 金鑰 / 個資寫進去 = 不可逆外洩風險。

請改成下列任一做法：
  1. 不要把機敏值寫進 wiki，改記「位置」（例：「DB 密碼放 1Password / .env，不入 wiki」）
  2. 確定是誤判（例：在示範格式）→ 該行尾加註記  wiki-secret-ok  後重寫
  3. 整個來源檔本就機敏 → 加進 system-dev/wiki/.wikiignore，別讓它被編入

誠實限制：本掃描靠特徵比對，有偽陽/偽陰，是「意外外洩的機械底線」而非保險箱。
真正的密鑰本就不該進版控。
EOF
  exit 2
fi

exit 0
