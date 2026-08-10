#!/bin/bash
# sdd-active-check.sh — 單一活性 SDD 獨立硬約束（SDD 生命週期鐵律，issue #6）
# 規則全文：system-dev/docs/3-specs/SDD-LIFECYCLE.md
#
# 用法：bash sdd-active-check.sh [specs目錄]
#   參數 1（可選）＝specs 目錄，預設 system-dev/docs/3-specs
#
# 行為：統計 status: active 的 design.md（design.md 前 10 行有 ^status: active，
#   排除 archive/ 與 TEMPLATE）——
#   >1 份 → stderr 列出清單，exit 1（違反單一活性）
#   ≤1 份 → exit 0
#
# pre-commit 掛法（.git/hooks/pre-commit，記得 chmod +x）：
#   #!/bin/sh
#   bash system-dev/scripts/sdd-active-check.sh || exit 1
# CI 也是同一行，違反即紅。
#
# 誠實限制：與 sdd-guard.sh 同精神——只做語法層機械檢查，繞道可行但留痕可審，
# 不聲稱不可繞過。價值是「不變量被違反時一定有機器出聲」。

set -euo pipefail

SPECS_DIR="${1:-system-dev/docs/3-specs}"

# 沒有 specs 目錄（沒裝 SDD 模組）→ 無事可查，放行
[ -d "$SPECS_DIR" ] || exit 0

ACTIVE_COUNT=0
ACTIVE_LIST=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if head -10 "$f" 2>/dev/null | grep -q '^status:[[:space:]]*active'; then
    ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
    ACTIVE_LIST="${ACTIVE_LIST}   • ${f}
"
  fi
done < <(find "$SPECS_DIR" -name 'design.md' -not -path '*TEMPLATE*' -not -path '*/archive/*' 2>/dev/null)

if [ "$ACTIVE_COUNT" -gt 1 ]; then
  cat >&2 <<EOF
🚫 SDD 單一活性鐵律違反：${SPECS_DIR}/ 下有 ${ACTIVE_COUNT} 份 status: active 的 SDD（任何時刻最多一份）：
${ACTIVE_LIST}
請收斂到一份：其餘改 status: paused / closed（closed 且被取代者填 superseded_by 並移入 archive/）。
規則見 system-dev/docs/3-specs/SDD-LIFECYCLE.md。
EOF
  exit 1
fi

exit 0
