#!/usr/bin/env bash
# build-mac.sh — 打包 Arcrun.app（Wails 版，t194）
#
# 與 fyne 版最重要的差別：**要把 collector 同綑進 .app**。
# daemon 的本體是 `collector direct`（監看/萃卡/上傳），App 只是它的門面；
# 沒同綑 ⇒ 裝了也不會同步。
set -euo pipefail
cd "$(dirname "$0")"
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

BUILD_TIME="$(date '+%Y%m%d-%H%M')"
LDFLAGS_VER="-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME} -X arcrun-rag/collector.version=${VERSION} -X arcrun-rag/collector.buildTime=${BUILD_TIME}"
export PATH="$PATH:$(go env GOPATH)/bin"
echo "🏷  版本：${VERSION}（build ${BUILD_TIME}）"

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
python3 - "$PLIST_VER" <<'PY'
import json, sys
c = json.load(open('wails.json'))
c.setdefault('info', {})
c['info']['productVersion'] = sys.argv[1]
c['info']['productName'] = 'Arcrun'
json.dump(c, open('wails.json', 'w'), indent=2, ensure_ascii=False)
PY
trap 'mv -f wails.json.bak wails.json 2>/dev/null || true' EXIT

echo "② wails build"
wails build -clean -ldflags "${LDFLAGS_VER}"

APP="build/bin/Arcrun.app"
[ -d "build/bin/arcrun-app.app" ] && { rm -rf "$APP"; mv "build/bin/arcrun-app.app" "$APP"; }

echo "③ 同綑 collector 進 .app（App 用 os.Executable() 找同層）"

echo "④ ad-hoc 重簽（改過 bundle 內容必重簽，否則 launchd 拒開）"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "✅ 完成：$APP"
echo "   驗法：open '$APP' → 選單列出現 icon、Dock **不出現** icon"
echo "         點 icon → 立刻展開視窗；右鍵 → 只有「結束 Arcrun」"
