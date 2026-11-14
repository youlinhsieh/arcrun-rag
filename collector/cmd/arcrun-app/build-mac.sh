#!/usr/bin/env bash
# build-mac.sh — 打包 Arcrun.app（Wails 版，t194）
#
# 🔴 inkstone/arcrun-rag#135：`CHANNEL=stage ./build-mac.sh` 打出 **Arcrun Stage.app**
#   （bundle id com.wails.arcrun-app-stage、資料目錄 ~/.arcrun-rag-stage、檢查更新讀 youlin、圖示右下有 STAGE 角標），
#   可以和正式版 Arcrun.app 同時安裝、同時開。不帶 CHANNEL ＝ 今天的 Arcrun，一個位元都不變。
#   身分只由一個參數決定，來源是同一份原始碼（見 channel-env.sh／collector/channel）。
#
# 與 fyne 版最重要的差別：**要把 collector 同綑進 .app**。
# daemon 的本體是 `collector direct`（監看/萃卡/上傳），App 只是它的門面；
# 沒同綑 ⇒ 裝了也不會同步。
set -euo pipefail
cd "$(dirname "$0")"
source ./channel-env.sh   # CHANNEL=stage|prod → APP_NAME／BUNDLE_NAME／CH_LDFLAGS…
# 🔴 2026-08-06：版本號改由 daemon-version.py 機械產生（不再手打／不靠 git describe）。
#   病根：本 repo 一個 git tag 都沒有 ⇒ git describe 永遠拿不到 v0.18.x
#   ⇒ 只能靠打包時人工敲 VERSION= ⇒ 兩條打包線各敲各的 ⇒ manifest 說謊。
#   理由與算法全文見 daemon-version.py。
VERSION="${VERSION:-$(./daemon-version.py --stamp)}"

# 🔴 2026-08-06 機械閘：這一版的「更新內容」沒寫進 changelog ⇒ 不准打包。
#   leo：「給版本號、本版更新內容、打包產品、顯示在前端，這一整串都應該是機械化」。
#   單一真相源＝collector/CHANGELOG.md；manifest.notes 與前端全部投影自它。
#   （2026-08-18 D95 第一輪：從 docs-site 搬進 collector/，daemon 才算得出自己的版本。）
#   理由與格式見 changelog-section.sh。
./changelog-section.sh "$VERSION" --check

# 🔴 畫面字數預算（inkstone/arcrun-rag#240 c18306）：超出就不准打包。
./check-text-budget.sh

BUILD_TIME="$(date '+%Y%m%d-%H%M')"
LDFLAGS_VER="-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME} -X arcrun-rag/collector.version=${VERSION} -X arcrun-rag/collector.buildTime=${BUILD_TIME} ${CH_LDFLAGS}"
export PATH="$PATH:$(go env GOPATH)/bin"
echo "🏷  版本：${VERSION}（build ${BUILD_TIME}）頻道：${CHANNEL}（${APP_NAME}）"

# 🔴 2026-08-06 起**不再單獨編 collector**（leo：「不要兩支，寫成一支檔案」）。
#   collector 已改成可被引用的套件，直接編進同一個執行檔，靠 `--collector` 換身分。
#   Mac 這邊原本是 .app 裡放兩個執行檔（沒有 dropper 問題），但兩邊做法統一才不會再漂移
#   ——「Mac 有、Windows 漏了」這種病本 repo 已經犯過兩次（2b83c47、v0.18.6 版本注入）。

# 🔴 2026-08-05（leo 開 DMG 檢查時抓到）：Info.plist 的 CFBundleShortVersionString
#   是 **1.0.0**（Wails 預設），不是我們的版本號——因為 wails.json 沒有 info.productVersion，
#   而 `wails build` **沒有** CLI 旗標可指定。
#   ⇒ 建置前把版本寫進 wails.json 的 info，建完還原（不污染版控）。
#   為什麼要修：使用者「關於」看到的、以及 Finder 顯示的版本都讀這個欄位；
#   永遠顯示 1.0.0 ⇒ 用戶無從判斷自己是不是新版（同 leo「版本號是唯一驗收介面」的病）。
PLIST_VER="${VERSION#v}"
cp wails.json wails.json.bak
python3 - "$PLIST_VER" "$APP_NAME" "$BUNDLE_NAME" <<'PY'
import json, sys
c = json.load(open('wails.json'))
c.setdefault('info', {})
c['info']['productVersion'] = sys.argv[1]
c['info']['productName'] = sys.argv[2]
# 🔴 #135：`name` 決定 Info.plist 的 bundle id（com.wails.<name>）。正式版仍是 arcrun-app（不變）；
#    Stage 版是 arcrun-app-stage ⇒ 與正式版是兩個不同的 App，安裝時不會互蓋、也能同時開。
#    outputfilename 不動（執行檔名不影響身分，少動一處少一個風險）。
c['name'] = sys.argv[3]
json.dump(c, open('wails.json', 'w'), indent=2, ensure_ascii=False)
PY
# 🔴 #135：Stage 版的 Dock／Finder 圖示換成帶 STAGE 角標的版本（wails 從 build/appicon.png 產 .icns）。
#    打完一定還原——版控裡的 appicon.png 永遠是正式版那張。
cp build/appicon.png build/appicon.png.bak
if [ "$CHANNEL" = "stage" ]; then
  python3 gen-stage-icon.py build/appicon.png
fi
trap 'mv -f wails.json.bak wails.json 2>/dev/null || true; mv -f build/appicon.png.bak build/appicon.png 2>/dev/null || true' EXIT

echo "② wails build"
wails build -clean -ldflags "${LDFLAGS_VER}"

APP="build/bin/${APP_NAME}.app"
[ -d "build/bin/arcrun-app.app" ] && { rm -rf "$APP"; mv "build/bin/arcrun-app.app" "$APP"; }
[ -d "build/bin/${BUNDLE_NAME}.app" ] && [ "$BUNDLE_NAME" != "arcrun-app" ] && { rm -rf "$APP"; mv "build/bin/${BUNDLE_NAME}.app" "$APP"; }
# 🔴 #135：打完自己驗一次身分真的進了 bundle（不是只信 wails.json 改了）。
BID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ "$BID" = "com.wails.${BUNDLE_NAME}" ] || { echo "❌ bundle id 不對：${BID:-（讀不到）}，預期 com.wails.${BUNDLE_NAME}" >&2; exit 1; }
echo "   ✅ bundle id：$BID"

echo "③ 同綑 collector 進 .app（App 用 os.Executable() 找同層）"

echo "④ ad-hoc 重簽（改過 bundle 內容必重簽，否則 launchd 拒開）"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "✅ 完成：$APP"
echo "   驗法：open '$APP' → 選單列出現 icon、Dock **不出現** icon（Stage 版 icon 旁另有「Stage」字樣）"
echo "         點 icon → 立刻展開視窗；右鍵 → 只有「結束 Arcrun」"
