#!/usr/bin/env bash
# build-dmg.sh — 把 Arcrun.app 打成標準 Mac DMG（t184 配套，leo 2026-08-04 核可）。
#
# 🎯 為什麼要 DMG（不是繼續發 zip）：
#   zip 解出來就是一個 app，使用者**很容易就地雙擊執行**（下載資料夾、桌面）。
#   Oscar 就是這樣 ⇒ 他的 app 不在 /Applications ⇒ 自更新蓋錯地方（t184 真兇）。
#   DMG 裡放「app ＋ Applications 資料夾捷徑」，開起來就是叫你把 app 拖進去的畫面
#   ⇒ **從源頭讓 app 待在該待的位置**，這是 Mac 的標準慣例，使用者一看就懂。
#
#   ⚠️ DMG 治源頭、t184 是安全網，**兩個都要**：
#      已經裝好舊版在別處的人（如 Oscar），不會因為改發 DMG 就自動變好。
#
# 用法：VERSION=v0.15.7 bash build-dmg.sh
# 產物：dist-mac/ArcrunRAG-<version>.dmg
set -euo pipefail
cd "$(dirname "$0")"

APP="Arcrun.app"
[[ -d "$APP" ]] || { echo "❌ 找不到 $APP —— 先跑 build-mac.sh" >&2; exit 1; }

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT_DIR="dist-mac"
DMG="$OUT_DIR/ArcrunRAG-${VERSION}.dmg"
STAGE="$(mktemp -d)/Arcrun RAG"

echo "🏷  版本：${VERSION}"
mkdir -p "$OUT_DIR" "$STAGE"

echo "① 放 app 進暫存區"
ditto "$APP" "$STAGE/$APP"

echo "② 放 Applications 捷徑（使用者拖曳的目標）"
ln -s /Applications "$STAGE/Applications"

echo "③ 產 DMG"
rm -f "$DMG"
hdiutil create -volname "Arcrun" -srcfolder "$STAGE" -fs HFS+ -ov -format UDZO "$DMG" >/dev/null

rm -rf "$(dirname "$STAGE")"
SIZE=$(ls -lh "$DMG" | awk '{print $5}')
# 註：`$DMG（` 要寫成 `${DMG}（`——全形括號不是分隔符，bash 會把它吃進變數名。
echo "✅ 完成：${DMG}（${SIZE}）"
echo
echo "🔬 驗法："
echo "   hdiutil attach '$DMG' → 應看到 Arcrun.app 與 Applications 捷徑並排"
echo "   使用者把左邊拖到右邊即完成安裝（Mac 標準流程）"
