#!/usr/bin/env bash
# build-mac.sh — 打包 Arcrun RAG 托盤 app（daemon-beta t7/t8，真機執行）。
#
# leo 07-24 裁決：**選單列托盤 icon 是唯一指示器，不佔 Dock**——
# fyne 預設 bundle 會出現 Dock icon，打包後把 LSUIElement=true 寫進 Info.plist 即隱。
#
# 用法（真機、需 Xcode CLT）：
#   cd collector/cmd/arcrun-tray && bash build-mac.sh
# 產物：Arcrun.app（含同綑 arcrun-collector）。簽章/公證另行（見 README）。
set -euo pipefail
cd "$(dirname "$0")"

# 版本編號（leo 2026-07-27：「daemon 要加上版本編號」）——沒版本號就只能靠 shasum 對帳，
# 使用者回報問題時我們也不知道他跑的是哪一版（見 t63「修好的東西傳不到用戶」）。
# 用法：VERSION=v0.9.0 bash build-mac.sh（未給則用 git 描述，再不行才 dev）
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
BUILD_TIME="$(date '+%Y%m%d-%H%M')"
LDFLAGS_VER="-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}"
echo "🏷  版本：${VERSION}（build ${BUILD_TIME}）"

echo "① 編 collector（同綑執行檔）"
# t150（leo 07-29「我的和下載下來的會是同一個嗎」）：collector **也要**注入版本，
# 否則托盤顯示的是 tray 的版本、實際幹活的 collector 無版本可查（兩支獨立編譯）。
( cd ../.. && go build -ldflags "-s -w ${LDFLAGS_VER}" -o "cmd/arcrun-tray/arcrun-collector" . )

echo "② fyne package"
go run fyne.io/fyne/v2/cmd/fyne@latest package -os darwin -icon icon.png -name "Arcrun" -appID dev.arcrun.rag.tray

# ②b 用 -s -w 重編托盤覆蓋回 bundle（2026-07-27，t72/t63）。
# 為什麼：`fyne package` 內部自己 go build，吃不到 -ldflags，產出含符號表與 DWARF 的胖執行檔。
# 實測（本機）：托盤 28.6MB → 21.3MB，**整包 zip 21.1MB → 14.65MB**
# ＝**掉進 jsDelivr 單檔 20MB 上限內**（此前 Mac 版超標，jsDelivr 直接回
# "File size exceeded the configured limit of 20 MB."，只能走 raw；Windows 版 13MB 無此問題）。
# ⇒ 這一步讓 Mac 版也能走 CDN，且**免除拆檔工程**。功能指紋與簽章實測皆不受影響。
echo "②b strip 重編托盤（-s -w；為了掉進 jsDelivr 20MB 線內）＋注入版本號"
go build -ldflags "-s -w ${LDFLAGS_VER}" -o "Arcrun.app/Contents/MacOS/arcrun-tray" .

APP="Arcrun.app"
PLIST="$APP/Contents/Info.plist"

echo "③ LSUIElement=true（托盤唯一指示器，隱 Dock icon——leo 07-24 裁決）"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"

echo "④ 同綑 collector 進 app bundle（托盤 collectorBinPath 找同層）"
cp arcrun-collector "$APP/Contents/MacOS/arcrun-collector"

echo "⑤ ad-hoc 重簽（Apple Silicon：改過 plist/塞過檔必重簽，否則 launchd 拒開 error 162——07-24 真機實撞）"
codesign --force --deep -s - "$APP"

echo "✅ 完成：$APP"
echo "驗法：open '$APP' → 選單列出現 icon、Dock **不出現** icon → 選單列出資料夾清單"
