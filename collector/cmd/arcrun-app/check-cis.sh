#!/usr/bin/env bash
# check-cis.sh — CIS 合規機械檢查（t193）
#
# 🔴 leo 2026-08-04：「CIS 已經提供規範，你做的**連 Logo 都沒放上去**，
#    這跟美不美有關係嗎？要求放進 CIS 是**硬要求**，**你做為檢查有嗎？沒有怎麼交貨？**」
# ⇒ 交貨前先跑這支。不過就不准交。
set -uo pipefail
cd "$(dirname "$0")"
# 色票/字體/紋理在共用底層；版面在 style.css ⇒ 兩份都要看
CSS=frontend/src/arcrun-cis.css
LAYOUT=frontend/src/style.css
HTML=frontend/index.html
FAIL=0
ok(){ printf "  ✅ %s\n" "$1"; }
ng(){ printf "  ❌ %s\n" "$1"; FAIL=1; }

echo "━━━ CIS 合規檢查 ━━━"

# ① 官方色票（arcrun-cis/README.md 的 Colour 表）必須逐個出現
for t in "#FDFCFB:Paper" "#F2F1ED:Canvas" "#17181A:Ink" "#B04A2F:Relation" "#D9784F:Relation-dark"; do
  hex="${t%%:*}"; name="${t##*:}"
  grep -qi "$hex" "$CSS" && ok "色票 $name $hex" || ng "缺色票 $name $hex"
done

# ② 不准自創顏色：抓不在白名單內的 hex
# 版面檔**一個 hex 都不准有**（顏色一律 var(--...)）
STRAY_LAYOUT=$(grep -oiE '#[0-9a-f]{6}' "$LAYOUT" || true)
[ -z "$STRAY_LAYOUT" ] && ok "版面檔沒有寫死顏色" || ng "版面檔出現 hex：$STRAY_LAYOUT"

STRAY=$(grep -oiE '#[0-9a-f]{6}' "$CSS" | tr 'a-f' 'A-F' | sort -u \
  | grep -vE '#(FDFCFB|F2F1ED|17181A|B04A2F|D9784F|1D7A48|7FE0A8|B03A26|E58575|1B1C1E|1E1F21|1D6B40|A8E8C4)' || true)
[ -z "$STRAY" ] && ok "沒有自創顏色" || ng "出現非 CIS 色：$(echo $STRAY | tr '\n' ' ')"

# ③ Logo 必須真的放進去（leo 點名的那條）
grep -q "arcrun-lockup-h-ink-trimmed.png" "$HTML" && ok "淺色 lockup（裁淨版）已放" || ng "缺淺色裁淨版 lockup"
grep -q "arcrun-lockup-h-paper-trimmed.png" "$HTML" && ok "深色 lockup（裁淨版）已放" || ng "缺深色裁淨版 lockup"
[ -f frontend/src/assets/arcrun-lockup-h-ink-trimmed.png ] && ok "lockup 檔案存在" || ng "lockup 檔案不存在"
# 🔴 不准用未裁淨的原始 PNG：1840x560 只有 32% 高是字形，同 height 看起來字很小
grep -qE 'lockup-h-(ink|paper-on-ink)\.png' "$HTML" && ng "用到未裁淨的原始 lockup（字會太小）" || ok "沒用未裁淨的原始圖"
# 側邊欄選中態要照 portal（amber 字＋8% 底＋右緣 2px），不是實心膠囊
grep -q "border-right-color: var(--amber)" "$LAYOUT" && ok "選中態同 portal（右緣 amber）" || ng "選中態未照 portal"
grep -q "border-radius: 999px" "$LAYOUT" && ng "還在用膠囊選中態（leo 已否決）" || ok "沒有膠囊選中態"
grep -q "lockup-h.svg" "$HTML" 2>/dev/null && ng "用到已作廢的 SVG lockup（字腔缺失）" || ok "沒用作廢的 SVG lockup"

# ④ 深淺色都要成立（portal 有 data-theme，這裡也要）
grep -q 'data-theme="dark"' "$CSS" && ok "有深色模式色票" || ng "缺深色模式"

# ⑤ 字體與背景紋理要與 portal 一致
grep -q "IBM Plex Sans" "$CSS" && ok "字體同 portal" || ng "字體與 portal 不一致"
grep -q "repeating-linear-gradient" "$CSS" && ok "紙張紋理同 portal" || ng "缺 portal 的紙張紋理"

# ⑥ App icon 用官方檔
[ -f build/appicon.png ] && ok "app icon 存在" || ng "缺 app icon"

echo
[ $FAIL -eq 0 ] && echo "✅ CIS 檢查全過" || echo "❌ CIS 檢查未過——**不准交貨**"
exit $FAIL
