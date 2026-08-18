#!/usr/bin/env bash
# build-msix.sh — 把 Wails 版 Arcrun 打包成 Microsoft Store 用的 .msix（t196／2026-08-05）
#
# leo 08-05：「當測試者給我截圖安裝成功就要提交 ms store」
#
# 🎯 **在 Mac 上就打得出 msix**，不需要 Windows 機器、不需要 MakeAppx。
#    靠微軟自家開源跨平台工具 msix-packaging 的 `makemsix`。
#
# ⚠️ **不必自購簽章憑證**：送 Store 的 msix 不用簽——微軟過審後會用自己的憑證重簽。
#    但**側載**（不走 Store）就必須自己簽。
#
# 沿革：舊 fyne 版（`../arcrun-tray/`）是單一 exe（collector 用 //go:embed 吃進去）；
#   （2026-08-06 起改回一個 exe：collector 編進 Arcrun.exe，`--collector` 換身分。
#   以下敘述保留為沿革）**Wails 版曾是兩個 exe**（見 supervise.go 的
#   os.Executable() 同層查找）⇒ 兩個都要進 msix root，缺一個就「裝了不會同步」。
#   🔴 2026-08-18（D95 第一輪）：`arcrun-tray/` 已整個下架，
#   它的 `--setup`（建 makemsix）與 Store 圖示都已搬進本目錄——見下方 --setup 段與 assets/store/。
#
# 前置（一次就好）：
#   brew install mingw-w64 cmake icu4c
#   bash build-msix.sh --setup                   # 建 makemsix（約 5-10 分鐘）
#
# 用法：
#   IDENTITY_NAME=<Partner Center 的 Name> \
#   PUBLISHER=<Partner Center 的 Publisher> \
#   PUBLISHER_DISPLAY=<顯示名> \
#   bash build-msix.sh
set -euo pipefail
cd "$(dirname "$0")"

MSIX_SDK_DIR="${MSIX_SDK_DIR:-$HOME/.cache/msix-packaging}"
MAKEMSIX="$MSIX_SDK_DIR/.vs/bin/makemsix"

# ── --setup：建 makemsix（一次性）────────────────────────────────────────
# 🔴 2026-08-18：**逐字取自 `arcrun-tray/build-msix.sh`**（512ea9f 之後未再改動），不是重寫。
#    那個目錄是死碼要下架，但**這一段不是死的**——本腳本原本第 34 行就叫人去跑它。
#    死碼下架時最容易犯的錯是「連還活著的那一塊一起丟掉」，所以先搬過來再刪。
if [[ "${1:-}" == "--setup" ]]; then
  echo "① clone msix-packaging（微軟開源，匿名讀取，不碰 GitHub 寫入）"
  [[ -d "$MSIX_SDK_DIR" ]] || git clone --depth 1 https://github.com/microsoft/msix-packaging.git "$MSIX_SDK_DIR"

  echo "② 修 C++ 標準：14 → 17"
  # 為什麼要修：這套 SDK 停在 2022 年、寫死 C++14，但 Homebrew 現在的 ICU 標頭
  # 用了 std::is_same_v 等 C++17 語法 ⇒ 不修必炸 'no template named is_same_v'。
  # **兩個檔都要改**——頂層改了還會被 xerces 子專案的設定蓋回去（實際踩過的坑）。
  for f in "$MSIX_SDK_DIR/CMakeLists.txt" "$MSIX_SDK_DIR/lib/xerces/CMakeLists.txt"; do
    sed -i.bak 's/set(CMAKE_CXX_STANDARD 14)/set(CMAKE_CXX_STANDARD 17)/' "$f"
  done

  ICU_PREFIX="$(brew --prefix icu4c@77 2>/dev/null || brew --prefix icu4c)"
  [[ -f "$ICU_PREFIX/include/unicode/uset.h" ]] || { echo "❌ 找不到 ICU 標頭。先跑：brew install icu4c" >&2; exit 1; }

  echo "③ cmake 配置（--pack 才會有打包功能，預設是關的）"
  mkdir -p "$MSIX_SDK_DIR/.vs" && cd "$MSIX_SDK_DIR/.vs"
  cmake -DCMAKE_BUILD_TYPE=MinSizeRel -DXML_PARSER=xerces -DSKIP_BUNDLES=off \
        -DUSE_VALIDATION_PARSER=on -DMSIX_PACK=on -DMSIX_SAMPLES=off -DMSIX_TESTS=off \
        -DCMAKE_OSX_ARCHITECTURES="$(uname -m)" -DCMAKE_TOOLCHAIN_FILE=../cmake/macos.cmake \
        -DUSE_MSIX_SDK_ZLIB=on -DMACOS=on -DCMAKE_CXX_FLAGS="-I$ICU_PREFIX/include" ..
  echo "④ 編（約 5-10 分鐘）"
  make -j"$(sysctl -n hw.ncpu)"
  echo "✅ makemsix 完成：$MAKEMSIX"
  exit 0
fi

[[ -x "$MAKEMSIX" ]] || {
  echo "❌ 找不到 makemsix：$MAKEMSIX"
  echo "   先跑一次：bash build-msix.sh --setup"
  exit 1
}

VERSION_RAW="${VERSION:-$(./daemon-version.py --stamp)}"   # 版本由 daemon-version.py 機械產生（2026-08-06）
# msix 版本必須是四段數字 a.b.c.d，且**最後一段必須是 0**（Store 規定，保留給微軟）。
MSIX_VERSION="$(echo "$VERSION_RAW" | sed 's/^v//' | awk -F. '{printf "%d.%d.%d.0", $1, $2, $3}')"
# ⚠️ 變數後緊接全形括號必須用 ${} 包起來——全形字元會被 bash 當成變數名的一部分。
echo "🏷  msix 版本：${MSIX_VERSION}（來源 ${VERSION_RAW}）"

# Identity 三值——**必須與 Partner Center 完全一致**，故從環境變數帶入，預設佔位。
# 🔴 2026-08-06 leo：「**每次都問一次..**」——三個值一直都在頂層 `.env`，
#    我卻每次都當成「只有他有」而開口問。**腳本自己去讀，不要再問人。**
#    （對應鐵律：`system-dev/wiki/credentials-map.md` —— 用任何金鑰前先查那張表；
#      查得到就自己拿，不要說「我沒有」。）
#
# 🔴 2026-08-18（D95 第一輪）：原本是 `git rev-parse --show-toplevel`/../../.env
#    ——那是**用本 repo 在磁碟上的位置**去推 InkStoneCo 頂層，
#    collector/ 一旦搬成獨立 repo（或只是被 clone 到別處）就指到不存在的路徑。
#    改成**往上找那個帶著這把鍵的 .env**：leo 08-06 的要求原樣保留
#    （腳本自己去讀、不再問人，金鑰的家仍是頂層那一份），
#    但**不再依賴目錄結構長什麼樣**。找不到就照舊落到 PLACEHOLDER 並印警告，
#    不會安靜出一顆送不了審的 msix。
if [[ -z "${ENV_FILE:-}" ]]; then
  _d="$(pwd)"                       # 腳本開頭已 cd 到自己的目錄
  while [[ "$_d" != "/" ]]; do
    if [[ -f "$_d/.env" ]] && grep -qE '^MS_STORE_ARCRUN_APP_NAME=' "$_d/.env" 2>/dev/null; then
      ENV_FILE="$_d/.env"; break
    fi
    _d="$(dirname "$_d")"
  done
fi
ENV_FILE="${ENV_FILE:-}"
if [[ -z "${IDENTITY_NAME:-}" && -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  # 只取這三個鍵，不把整包 .env 灌進環境（其他都是不該碰的金鑰）
  IDENTITY_NAME="$(grep -E '^MS_STORE_ARCRUN_APP_NAME=' "$ENV_FILE" | cut -d= -f2-)"
  PUBLISHER="$(grep -E '^MS_STORE_ARCRUN_APP_PUBLISHER=' "$ENV_FILE" | cut -d= -f2-)"
  PUBLISHER_DISPLAY="$(grep -E '^MS_STORE_ARCRUN_APP_PUBLISHER_DISPLAY_NAME=' "$ENV_FILE" | cut -d= -f2-)"
  [[ -n "$IDENTITY_NAME" ]] && echo "   ℹ️ Store Identity 由 ${ENV_FILE} 自動帶入（不必再問人）"
fi
IDENTITY_NAME="${IDENTITY_NAME:-PLACEHOLDER.ArcrunRAG}"
PUBLISHER="${PUBLISHER:-CN=PLACEHOLDER}"
PUBLISHER_DISPLAY="${PUBLISHER_DISPLAY:-PLACEHOLDER}"
if [[ "$IDENTITY_NAME" == PLACEHOLDER* ]]; then
  echo "⚠️  Identity 仍是佔位值——**這顆 msix 不能送 Store**，只能拿來驗打包流程。"
  echo "   送審前要帶：IDENTITY_NAME / PUBLISHER / PUBLISHER_DISPLAY（三值從 Partner Center 抄）"
fi

echo "① 編 Windows 版（兩個 exe）"
VERSION="$VERSION_RAW" bash build-win.sh >/dev/null
[[ -f build/bin/arcrun-app.exe ]] || { echo "❌ Arcrun.exe 沒編出來" >&2; exit 1; }
# 2026-08-06 起只有一支 exe（collector 編進去了），不再檢查第二個檔。

OUT="dist-msix"
rm -rf "$OUT" && mkdir -p "$OUT/root/Assets"
cp build/bin/arcrun-app.exe "$OUT/root/Arcrun.exe"

echo "② 複製 Store 圖示（沿用 CIS 版，不重產——sips 縮放會把方形拉扁）"
# 2026-08-18（D95 第一輪）：素材從 `../arcrun-tray/assets/store/` 搬到本目錄底下。
cp assets/store/*.png "$OUT/root/Assets/"

echo "③ 寫 AppxManifest.xml（能力宣告誠實且最小化）"
cat > "$OUT/root/AppxManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="$IDENTITY_NAME" Publisher="$PUBLISHER" Version="$MSIX_VERSION" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Arcrun</DisplayName>
    <PublisherDisplayName>$PUBLISHER_DISPLAY</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22631.0" />
  </Dependencies>
  <Resources>
    <Resource Language="zh-TW" />
    <Resource Language="en-US" />
  </Resources>
  <Applications>
    <Application Id="Arcrun" Executable="Arcrun.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Arcrun"
        Description="把你選的資料夾變成可以問問題的知識庫，檔案留在自己電腦裡。"
        BackgroundColor="#17181A"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile
          Wide310x150Logo="Assets\Wide310x150Logo.png"
          Square71x71Logo="Assets\Square71x71Logo.png"
          Square310x310Logo="Assets\Square310x310Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <Capability Name="internetClient" />
    <rescap:Capability Name="broadFileSystemAccess" />
  </Capabilities>
</Package>
EOF

echo "④ 打包 msix"
"$MAKEMSIX" pack -d "$OUT/root" -p "$OUT/Arcrun.msix" >/dev/null

# 🔴 2026-08-18：把成品放進 `dist/` 並帶上版號——與 build-dmg.sh／build-win.sh 一致。
#   以前只留在 dist-msix/Arcrun.msix，而出貨線的 daemon-sync 找的是
#   `dist/Arcrun-<版本>.msix`；因為 msix 標 required:false，**它會安靜地少一個檔**，
#   出貨線照樣印綠。上一版的 msix 是人手搬進去的——那正是 daemon-sync 要根治的
#   「只活在人的記憶裡的步驟」。
DIST_MSIX="dist/Arcrun-$(echo "$VERSION_RAW" | sed 's/^v//').msix"
mkdir -p dist && cp "$OUT/Arcrun.msix" "$DIST_MSIX"
echo "📦 已放進出貨線會找的位置：$DIST_MSIX"

SIZE=$(ls -lh "$OUT/Arcrun.msix" | awk '{print $5}')
echo "✅ 完成：$OUT/Arcrun.msix（${SIZE}，未簽章＝送 Store 的正確狀態）"
echo
echo "🔬 送審前必做（否則會被退件）："
echo "   · Identity 三值要與 Partner Center 完全一致（現在：${IDENTITY_NAME}）"
echo "   · broadFileSystemAccess 是受限能力，送審要寫明用途"
echo "     （本 App 需要它才能讀使用者自選的任意資料夾）"
