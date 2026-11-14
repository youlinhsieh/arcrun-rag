#!/usr/bin/env bash
# build-dmg.sh — 打包成 Mac 標準安裝檔（t194，leo：「你應該包成 Mac 安裝檔，我完整做一次」）
#
# DMG 裡放 Arcrun.app ＋ Applications 捷徑 ⇒ 開啟就是「把 App 拖進去」的標準畫面。
# 為什麼一定要：使用者若直接在下載資料夾裡跑，自更新會蓋錯位置（t184 Oscar 的病）；
# 而且 macOS 對「不在 /Applications 的常駐程式」權限行為也不一致。
set -euo pipefail
cd "$(dirname "$0")"
source ./channel-env.sh   # #135：CHANNEL=stage → dist-stage/、Arcrun Stage.app、磁碟名 Arcrun Stage
# 🔴 2026-08-06：版本號改由 daemon-version.py 機械產生（不再手打／不靠 git describe）。
#   病根：本 repo 一個 git tag 都沒有 ⇒ git describe 永遠拿不到 v0.18.x
#   ⇒ 只能靠打包時人工敲 VERSION= ⇒ 兩條打包線各敲各的 ⇒ manifest 說謊。
#   理由與算法全文見 daemon-version.py。
VERSION="${VERSION:-$(./daemon-version.py --stamp)}"

echo "① 先確保 .app 是最新的"
CHANNEL="$CHANNEL" VERSION="$VERSION" bash build-mac.sh >/dev/null

APP="build/bin/${APP_NAME}.app"
[ -d "$APP" ] || { echo "❌ 找不到 $APP" >&2; exit 1; }

# 🔴 #135：檔名兩個頻道相同（Arcrun-<版>.dmg，出貨線的檔名規則不動），**目錄不同**（dist／dist-stage），內容不同——
#    出貨線 daemon-sync 依登錄簿 targets.<目標>.daemonDist 取檔，不會把正式版的 DMG 送進 stage。
OUT="$DIST_DIR"; DMG="$OUT/Arcrun-${VERSION}.dmg"
STAGE="$(mktemp -d)/${DMG_VOLUME}"
mkdir -p "$OUT" "$STAGE"

echo "② 放 app ＋ Applications 捷徑"
ditto "$APP" "$STAGE/${APP_NAME}.app"
ln -s /Applications "$STAGE/Applications"

echo "③ 產可寫 DMG（-fs HFS+：否則含空格/中文的名稱會被截斷）"
rm -f "$DMG"
RW="$(mktemp -d)/rw.dmg"
hdiutil create -volname "$DMG_VOLUME" -srcfolder "$STAGE" -fs HFS+ -ov -format UDRW "$RW" >/dev/null
rm -rf "$(dirname "$STAGE")"

# ── ④ 排版面：讓「拖進去」這件事一眼可見 ────────────────────────────────────
# 🔴 leo 2026-08-05：「要跳出虛擬隨身碟，打開一個 finder 的視窗，**顯示 Arcrun 和
#    Application 的捷徑**，用戶把 App 拖進 Application」。
#    光是「裡面有兩個項目」不夠——預設是清單視圖、位置隨機，使用者看不出「要往右拖」。
#    ⇒ 設成大圖示、固定視窗大小、兩個 icon 左右並排。
#    best-effort：Finder 自動化在沒有桌面工作階段時（ssh／CI）會失敗，
#    失敗只警告不中止——版面是加分，DMG 本身照樣可用，不該讓打包整個掛掉。
hdiutil attach "$RW" -noautoopen -quiet
if osascript - "$DMG_VOLUME" "${APP_NAME}.app" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
set volName to item 1 of argv
set appItem to item 2 of argv
tell application "Finder"
  tell disk volName
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 160, 800, 560}
    set vopts to the icon view options of container window
    set arrangement of vopts to not arranged
    set icon size of vopts to 128
    set position of item appItem of container window to {150, 190}
    set position of item "Applications" of container window to {450, 190}
    update without registering applications
    close
  end tell
end tell
end run
APPLESCRIPT
then
  echo "   ✅ 版面已設定（大圖示，Arcrun 在左、Applications 在右）"
else
  echo "   ⚠️  Finder 版面設定失敗（多半是沒有桌面工作階段）——DMG 仍可用，只是視圖是預設值" >&2
fi
sync
hdiutil detach "/Volumes/${DMG_VOLUME}" -quiet

echo "⑤ 壓成唯讀發佈檔"
hdiutil convert "$RW" -format UDZO -o "$DMG" >/dev/null
rm -rf "$(dirname "$RW")"

SIZE=$(ls -lh "$DMG" | awk '{print $5}')
echo "✅ 完成：${DMG}（${SIZE}）頻道：${CHANNEL}"
echo
echo "🔬 使用者流程：開 DMG → 把 Arcrun 拖到 Applications → 退出這個虛擬磁碟 → 從啟動台開啟"
