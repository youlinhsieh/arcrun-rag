#!/usr/bin/env bash
# build-msix.sh — 把 Windows 托盤打包成 Microsoft Store 用的 .msix（rag-beta 關 8）。
#
# 🎯 重點：**在 Mac 上就打得出 msix**，不需要 Windows 機器、不需要 MakeAppx。
#    靠的是微軟自家的開源跨平台工具 msix-packaging 的 `makemsix`。
#    （2026-07-31 本機實測通過：pack 出 17 MB msix，unpack 回讀 SHA 與原 exe 一致。）
#
# ⚠️ **不必自購簽章憑證**：送 Store 的 msix 不用簽——微軟過審後會用自己的憑證重簽。
#    （官方原文見 docs/store-submission.md §2）。但**側載**（不走 Store）就必須自己簽。
#
# 前置（一次就好）：
#   brew install mingw-w64 cmake icu4c        # 交叉編譯器 + 建置工具 + Xerces 需要的 ICU
#   bash build-msix.sh --setup                # 建 makemsix（約 5-10 分鐘，只需跑一次）
#
# 用法：
#   bash build-msix.sh                        # 產出 dist-msix/ArcrunRAG.msix
# 產物：dist-msix/ArcrunRAG.msix（**未簽章，這是對的**——Store 會重簽）
set -euo pipefail
cd "$(dirname "$0")"

MSIX_SDK_DIR="${MSIX_SDK_DIR:-$HOME/.cache/msix-packaging}"
MAKEMSIX="$MSIX_SDK_DIR/.vs/bin/makemsix"

# ── --setup：建 makemsix（一次性）────────────────────────────────────────
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

[[ -x "$MAKEMSIX" ]] || { echo "❌ 找不到 makemsix。先跑一次：bash build-msix.sh --setup" >&2; exit 1; }

# ── 版本號 ────────────────────────────────────────────────────────────────
# ⚠️ Store 規定第四段固定 0（保留給 Store 用），前三段各 0-65535、第一段不可為 0。
VERSION_RAW="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 1.0.0)}"
VERSION_NUM="$(echo "$VERSION_RAW" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[[ -n "$VERSION_NUM" ]] || VERSION_NUM="1.0.0"
MSIX_VERSION="${VERSION_NUM}.0"
# ⚠️ 變數後緊接全形括號必須用 ${} 包起來——全形字元會被 bash 當成變數名的一部分。
echo "🏷  msix 版本：${MSIX_VERSION}（來源 ${VERSION_RAW}）"

# Identity 三值——**必須與 Partner Center 完全一致**，故從環境變數帶入，預設佔位。
IDENTITY_NAME="${IDENTITY_NAME:-PLACEHOLDER.ArcrunRAG}"
PUBLISHER="${PUBLISHER:-CN=PLACEHOLDER}"
PUBLISHER_DISPLAY="${PUBLISHER_DISPLAY:-PLACEHOLDER}"

echo "① 編 Windows exe（沿用既有腳本，單一 exe 內嵌 collector）"
bash build-windows.sh >/dev/null
[[ -f dist-windows/arcrun-tray.exe ]] || { echo "❌ exe 沒編出來" >&2; exit 1; }

OUT="dist-msix"
rm -rf "$OUT" && mkdir -p "$OUT/root/Assets"
cp dist-windows/arcrun-tray.exe "$OUT/root/"

echo "② 複製 Store 圖示（品牌素材，2026-07-31 換成 leo 的 CIS）"
# 為什麼不用 `sips -z` 現產：`sips -z 150 310` 會**把方形 icon 橫向拉扁**成 310×150
#（實測產出的 `a>>` 明顯變形）——CIS 的 Don't 明講「never skew or stretch」。
# ⇒ 改成預先產好、隨 repo 版控的 assets/store/：
#   方形磚＝方形 icon 直接等比縮；寬磚 310×150＝**橫式 lockup**（arc >>run）置中於墨底。
# 產生方式與規範見 assets/store/README.md（可重跑）。
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
    <DisplayName>Arcrun RAG</DisplayName>
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
    <Application Id="ArcrunRAG" Executable="arcrun-tray.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Arcrun RAG"
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
"$MAKEMSIX" pack -d "$OUT/root" -p "$OUT/ArcrunRAG.msix" >/dev/null

echo "⑤ 回讀驗證（unpack 會驗 blockmap 雜湊，能過＝結構合法）"
"$MAKEMSIX" unpack -p "$OUT/ArcrunRAG.msix" -d "$OUT/verify" -ss >/dev/null
a="$(shasum < dist-windows/arcrun-tray.exe)"; b="$(shasum < "$OUT/verify/arcrun-tray.exe")"
[[ "$a" == "$b" ]] || { echo "❌ 回讀的 exe 與原檔不一致" >&2; exit 1; }
rm -rf "$OUT/verify" "$OUT/root"

echo
echo "✅ 完成：$OUT/ArcrunRAG.msix（$(du -h "$OUT/ArcrunRAG.msix" | cut -f1)，未簽章＝送 Store 正確狀態）"
if [[ "$IDENTITY_NAME" == PLACEHOLDER* ]]; then
  echo
  echo "⚠️  現在是**佔位身分**，這顆還不能送審。leo 在 Partner Center 保留名稱後，照這樣重跑："
  echo "    IDENTITY_NAME='<Package/Identity Name>' PUBLISHER='<Publisher>' \\"
  echo "    PUBLISHER_DISPLAY='<發行者顯示名稱>' bash build-msix.sh"
  echo "    三個值抄自 Partner Center →〔產品〕→〔產品管理〕→〔產品識別資料〕"
fi
echo
echo "⛔ 這台機器驗不到、必須真 Windows 的部分：實際安裝、托盤 icon、選資料夾對話框。"
