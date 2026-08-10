#!/bin/bash
# PreToolUse hook — 動 code 前檢查 SDD ＋ 單一活性 SDD 鐵律（issue #6）
# wishlist §2：把 /sdd-check 從「命令要人打」升級成「hook 自動攔」。
# 生命週期規則全文：system-dev/docs/3-specs/SDD-LIFECYCLE.md
#
# 掛在 settings.json 的 PreToolUse（matcher: Write|Edit）。
# stdin 收到 JSON：{ tool_name, tool_input: { file_path, ... } }
# 行為：
#   1. status: active 的 SDD > 1 份 → 單一活性鐵律已被違反，**不論寫什麼檔**一律擋（exit 2），
#      先收斂到一份再說。
#   2. 動 code 檔（.ts/.go/...）→ 需要「恰好 1 份」active SDD；0 份 → 擋。
#   3. 向下相容：3-specs 下完全沒有任何 design.md 帶 frontmatter（老 repo 尚未遷移生命週期制度）
#      → 退回舊行為：有 design.md 就放行＋提醒，沒有才擋。避免 template update 後老 repo 立刻全紅。
#
# 誠實限制（抄 arcrun）：只擋語法層明顯違規（直接寫 code 檔）。
# 藏在 helper 裡、用 bash 繞道的改動擋不到。
# 價值是「想跳過會被抓到 + 留痕可審」，不是技術防偽。絕不聲稱「不可能繞過」。

set -euo pipefail

INPUT=$(cat)

# 解析 file_path。優先用 jq，沒有 jq 退回 grep（容錯）。
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
else
  FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//')
fi

# 拿不到路徑 → 不擋（容錯，寧可放過也不誤殺）
[ -z "$FILE_PATH" ] && exit 0

SPECS_DIR="system-dev/docs/3-specs"

# ── 統計 active / frontmatter ──────────────────────
# 排除 archive/（已封存）與 TEMPLATE（範本自帶 status: draft frontmatter，不算數——
# 否則 update 一鋪新版 TEMPLATE-sdd，老 repo 就被誤判「已遷移」而全紅，向下相容破功）。
# frontmatter 判定＝design.md 前 10 行有 ^status: 行（機器可查，見 SDD-LIFECYCLE.md）。
ACTIVE_COUNT=0
FM_COUNT=0
ACTIVE_LIST=""
if [ -d "$SPECS_DIR" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    HEAD10=$(head -10 "$f" 2>/dev/null || true)
    if printf '%s\n' "$HEAD10" | grep -q '^status:[[:space:]]*'; then
      FM_COUNT=$((FM_COUNT + 1))
      if printf '%s\n' "$HEAD10" | grep -q '^status:[[:space:]]*active'; then
        ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
        ACTIVE_LIST="${ACTIVE_LIST}   • ${f}
"
      fi
    fi
  done < <(find "$SPECS_DIR" -name 'design.md' -not -path '*TEMPLATE*' -not -path '*/archive/*' 2>/dev/null)
fi

# ── 鐵律 1：單一活性被違反（active > 1）→ 不論寫什麼檔一律擋 ──
if [ "$ACTIVE_COUNT" -gt 1 ]; then
  cat >&2 <<EOF
🚫 SDD 單一活性鐵律違反：偵測到 ${ACTIVE_COUNT} 份 status: active 的 SDD（任何時刻整個 repo 最多一份）：
${ACTIVE_LIST}
請先收斂到一份：其餘改 status: paused / closed（closed 且被取代者填 superseded_by 並移入 3-specs/archive/）。
規則全文見 system-dev/docs/3-specs/SDD-LIFECYCLE.md。收斂前擋下所有寫檔。
（本 hook 攔 Write/Edit；修 frontmatter 可用 bash 直改，或由人裁決哪份是現行。）
EOF
  exit 2
fi

# 只管 code 檔。docs/markdown/設定檔等放行。
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.go|*.py|*.rs|*.java|*.rb|*.php|*.c|*.cpp|*.h|*.hpp|*.swift|*.kt) ;;
  *) exit 0 ;;
esac

# 改 SDD 自己 / 測試檔 → 放行
case "$FILE_PATH" in
  *system-dev/docs/3-specs/*) exit 0 ;;
  *_test.*|*.test.*|*.spec.*|*/tests/*|*/test/*) exit 0 ;;
esac

# ── 向下相容：整個 3-specs 沒有任何帶 frontmatter 的 design.md ──
# ＝老 repo 還沒遷移生命週期制度 → 退回舊行為（有 design.md 就放行＋提醒），
# 避免 template update 一裝新 hook，老 repo 所有 code 寫入立刻全紅。
if [ "$FM_COUNT" -eq 0 ]; then
  SDD_COUNT=0
  if [ -d "$SPECS_DIR" ]; then
    SDD_COUNT=$(find "$SPECS_DIR" -name 'design.md' -not -path '*TEMPLATE*' -not -path '*/archive/*' 2>/dev/null | wc -l | tr -d ' ')
  fi

  if [ "$SDD_COUNT" -eq 0 ]; then
    cat >&2 <<EOF
🚫 SDD 協議攔截：要動 code 檔 ($FILE_PATH)，但 ${SPECS_DIR}/ 下找不到任何 SDD。

絕對鐵律：任何 code 變動前必須有對應 SDD（design.md），且遵守單一活性生命週期
（system-dev/docs/3-specs/SDD-LIFECYCLE.md）。

請先：
  1. 確認這個改動屬於哪個子系統
  2. 在 ${SPECS_DIR}/[子系統]/ 建立 design.md（可用 /sdd-check 協助），frontmatter 標 status: active
  3. 在回覆開頭宣告已讀 SDD + 對應 task

小修改（修 bug、改文字）若確定豁免，請明確說明範圍後由人放行。
EOF
    exit 2
  fi

  # 舊行為放行 + 提醒遷移（stderr 警告，不擋）
  echo "📋 提醒：${SPECS_DIR}/ 有 SDD 但尚未掛生命週期 frontmatter（老結構）。動手前確認已讀對應 design.md；建議依 SDD-LIFECYCLE.md 補 status 標記（現行那份標 active）。" >&2
  exit 0
fi

# ── 新行為：寫 code 檔需「恰好 1 份」active SDD ──
if [ "$ACTIVE_COUNT" -eq 0 ]; then
  cat >&2 <<EOF
🚫 SDD 協議攔截：要動 code 檔 ($FILE_PATH)，但 ${SPECS_DIR}/ 下沒有任何 status: active 的 SDD。

單一活性鐵律：所有開發任務唯一對應源＝那份 active SDD（規則見 system-dev/docs/3-specs/SDD-LIFECYCLE.md）。

請先（擇一，都是人的決定，CC 不得自行建 SDD）：
  1. 把現行規格的 design.md frontmatter 標成 status: active（一份、只能一份）
  2. 或依 SDD-LIFECYCLE.md 第 3、4 條：proposal 進 pending-changes.md → 使用者 confirm → 開新 SDD 標 active
然後在回覆開頭宣告已讀 active SDD + 對應 task。

小修改（修 bug、改文字）若確定豁免，請明確說明範圍後由人放行。
EOF
  exit 2
fi

# 恰好 1 份 active：放行，留痕提醒要宣告（stderr 警告，不擋）
printf '📋 提醒：現行 active SDD＝\n%s動手前請確認已讀它的 design.md、對應到 tasks，並在回覆宣告。\n' "$ACTIVE_LIST" >&2
exit 0
