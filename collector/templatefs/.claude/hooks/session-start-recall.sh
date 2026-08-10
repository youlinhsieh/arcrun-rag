#!/bin/bash
# SessionStart hook — 開 session 自動注入 status.md 重點
# wishlist §1 主路徑：不靠 CC 自覺、不用人說，開 session 就把進度推到眼前。
#
# 掛在 settings.json 的 SessionStart（matcher: startup|resume|clear）。
# stdout 會被當成 context 注入給 CC。
#
# 鐵律：status 是 point-in-time 快照，非即時狀態。
# 這個 hook 只負責「把快照推到眼前」，核實快照是 CC 的責任——下面的提醒就是要它別盲信。

set -euo pipefail

STATUS_FILE="system-dev/wiki/status.md"
PRINCIPLES_FILE="system-dev/wiki/principles.md"
MISTAKES_FILE="system-dev/wiki/mistakes.md"

# ── 舊結構防呆（1.9.0 遷移第 2 層保險）──
# 新版 wiki 收進 system-dev/。若偵測到舊位置 .claude/wiki/ 還在、但新位置沒 status，
# 代表使用者升級了規則卻沒跑遷移（low-code 使用者常見）→ 出聲提示，讓 CC 當場可代為遷移，
# 不要默默用不到新結構而出錯。
if [ -d ".claude/wiki" ] && [ ! -f "$STATUS_FILE" ]; then
  echo "⚠️  偵測到舊版 wiki 結構（.claude/wiki/），尚未遷移到 system-dev/wiki/。"
  echo "    請跑：bash system-dev/scripts/update.sh"
  echo "    或直接叫我（CC）：「幫我把 wiki 遷移到 system-dev/」——我可以代為搬移。"
  echo "    （未遷移時接關與 /wiki-init 會找錯位置。）"
  exit 0
fi

# 三個 push 檔都沒有 → 安靜退出，不干擾還沒 /wiki-init 的專案
if [ ! -f "$STATUS_FILE" ] && [ ! -f "$PRINCIPLES_FILE" ] && [ ! -f "$MISTAKES_FILE" ]; then
  exit 0
fi

# ── push 1/3：principles（全文，行動前必服從）──
# 放最前：原則是「會被遺忘的盲區」，要第一眼看見。全文成本低（一行一條、≤15 條）。
if [ -f "$PRINCIPLES_FILE" ] && grep -q '^- ' "$PRINCIPLES_FILE" 2>/dev/null; then
  echo "════════════════════════════════════════════════"
  echo "📐 設計原則（行動前必服從，來自 principles.md）"
  echo "════════════════════════════════════════════════"
  grep '^- ' "$PRINCIPLES_FILE"   # 只注入原則條目本身，不含說明區
  # context 保護：原則應 ≤15 條（push 全文）。超過 → 提示該合併或下放成 card，不截斷（截斷會漏原則）。
  P_COUNT=$(grep -c '^- ' "$PRINCIPLES_FILE")
  if [ "$P_COUNT" -gt 15 ]; then
    echo ""
    echo "（⚠️ principles 已 ${P_COUNT} 條 > 15：請考慮合併相近原則、或把較細的下放成 card）"
  fi
  echo ""
fi

# ── push 2/3：status（全文，當前進度）──
if [ -f "$STATUS_FILE" ]; then
  echo "════════════════════════════════════════════════"
  echo "📍 接關：上次進度（來自 $STATUS_FILE 快照）"
  echo "════════════════════════════════════════════════"
  echo ""
  cat "$STATUS_FILE"
fi

# ── push 3/3：mistakes（標題清單 + 一行症狀，全文按需展開）──
# 不全文注入（可能累積很多、含長 context）。只給「標題行」讓 CC 認出「我正撞到某條」→ 再去讀全文。
if [ -f "$MISTAKES_FILE" ] && grep -q 'MISTAKE' "$MISTAKES_FILE" 2>/dev/null; then
  echo ""
  echo "────────────────────────────────────────────────"
  echo "⚠️  已知踩坑（標題；撞到時讀 $MISTAKES_FILE 全文）"
  grep -E 'MISTAKE' "$MISTAKES_FILE" | sed 's/^/   /'
fi

echo ""
echo "────────────────────────────────────────────────"
echo "⚠️  以上是 point-in-time 快照，非即時狀態。"
echo "    動手前先核實：快照寫的事項是否真的還沒做完？"
echo "    需要完整脈絡（decisions / mistakes / SDD）→ 執行 /wiki-recall"
echo "════════════════════════════════════════════════"

# ── 遷移殘留偵測（1.9.x）：wiki 已搬到 system-dev/，但 CLAUDE.md 內容裡可能還寫舊路徑 ──
# update.sh 鐵則「絕不碰 CLAUDE.md」（用戶資料），所以遷移不會自動改它內容裡的死引用。
# 這裡只「偵測 + 提示 CC 代修」——由 CC（看得懂語義、不誤傷用戶自寫內容）來改，不讓腳本盲改。
if [ -f "CLAUDE.md" ] && grep -q '\.claude/wiki' CLAUDE.md 2>/dev/null; then
  echo ""
  echo "🔧 偵測到 CLAUDE.md 內仍有舊路徑 \`.claude/wiki/\`（wiki 已遷移到 system-dev/wiki/）。"
  echo "    這些是遷移後的死引用，會讓你（CC）找錯位置。"
  echo "    請主動幫使用者把 CLAUDE.md 裡的 \`.claude/wiki/\` 改成 \`system-dev/wiki/\`、"
  echo "    工具 docs 路徑改成 \`system-dev/docs/\`（但 raw source 宣告的 \`docs/\` 保留不動）。"
fi

exit 0
