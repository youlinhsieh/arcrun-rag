#!/usr/bin/env bash
# build-windows.sh — 打包 Arcrun RAG 托盤（Windows 未簽章版，daemon-beta t72）。
#
# 🎯 這支腳本的重點：**在 Mac 上就能交叉編譯出 Windows 版**，不需要 Windows 機器、
#    不需要 Docker、不需要 fyne-cross。條件只有一個——裝 mingw-w64。
#    （這推翻了先前「fyne GUI 編不了 CGo+GL → 歸屬真機」的假設；2026-07-27 本機實測通過。）
#
# t77-lite（2026-07-28）：arcrun-collector.exe 用 //go:embed 吃進 tray，
# 產物只剩一個 exe，瀏覽器不再多擋一個（leo：「如果只有 1 個，我還可以把 exe 改成 e_e
# 讓朋友改回來，但現在這樣完全不行」）。
#
# 前置（一次就好）：
#   brew install mingw-w64        # 提供 x86_64-w64-mingw32-gcc
#
# 用法：
#   cd collector/cmd/arcrun-tray && bash build-windows.sh
# 產物：dist-windows/ArcrunRAG-win-unsigned.zip（只含 arcrun-tray.exe）
#
# ⚠️ 誠實界定：**本腳本只證明「編得出來」，沒證明「跑起來對」**。
#    托盤 icon 會不會出現、選資料夾對話框、SmartScreen 實際攔截行為，
#    **只有真的在 Windows 上跑才驗得到**——那一步歸 leo/真機。
set -euo pipefail
cd "$(dirname "$0")"

# 版本編號（leo 2026-07-27：「daemon 要加上版本編號」）——與 build-mac.sh 同一套。
# 沒版本號時只能靠 shasum 對帳，使用者根本做不到（見 daemon-beta tasks t63）。
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
BUILD_TIME="$(date '+%Y%m%d-%H%M')"
LDFLAGS_VER="-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}"
echo "🏷  版本：${VERSION}（build ${BUILD_TIME}）"

OUT="dist-windows"
CC_WIN="${CC_WIN:-x86_64-w64-mingw32-gcc}"

echo "① 檢查交叉編譯器"
if ! command -v "$CC_WIN" >/dev/null 2>&1; then
  echo "❌ 找不到 $CC_WIN。先跑：brew install mingw-w64" >&2
  exit 1
fi
echo "   $($CC_WIN --version | head -1)"

rm -rf "$OUT" && mkdir -p "$OUT"

echo "② 編 collector.exe 到本目錄（供 //go:embed 吃進 tray）"
( cd ../.. && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
    # t150（leo 07-29）：collector 也要注入版本，否則顯示的與實際跑的可能不同版。
    go build -ldflags "-s -w ${LDFLAGS_VER}" -o "cmd/arcrun-tray/arcrun-collector.exe" . )

echo "③ 編托盤 GUI（fyne＝CGo+GL，走 mingw；collector.exe embed 進去成為單一 exe）"
CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC="$CC_WIN" \
  go build -ldflags "-H windowsgui -s -w ${LDFLAGS_VER}" -o "$OUT/arcrun-tray.exe" .

echo "④ 打包 zip（單一 exe，瀏覽器下載只有一個）"
( cd "$OUT" && zip -9 -q ArcrunRAG-win-unsigned.zip arcrun-tray.exe )

echo "⑤ 刪除本目錄臨時用的 collector.exe（已 embed 進 tray，不進版控）"
rm -f arcrun-collector.exe

echo
echo "✅ 完成：$OUT/ArcrunRAG-win-unsigned.zip"
ls -lh "$OUT"/*.exe "$OUT"/*.zip | awk '{print "   "$9"  "$5}'
echo
echo "📏 體積基準（t77-lite embed 後 tray 吃進 collector，+~6.5 MB）："
echo "   arcrun-tray.exe   ~30 MB（含內嵌 collector；未加 -s -w 是 ~47 MB）"
echo "   zip 單檔          ~14 MB（和舊版雙檔 zip 相近，同樣在 jsDelivr 20 MB 上限內）"
echo
echo "🔬 驗法（這台機器上驗得到的部分）："
echo "   file $OUT/arcrun-tray.exe  → 應為 'PE32+ executable (GUI) x86-64, for MS Windows'"
echo "   unzip -l $OUT/ArcrunRAG-win-unsigned.zip → 只應有 arcrun-tray.exe 一個檔案"
echo "   grep -c 'PDF 打不開' $OUT/arcrun-tray.exe → 應輸出 1（collector 特徵字串在肚裡）"
echo "⛔ 驗不到、必須真 Windows 機器的部分：托盤 icon 顯示／選資料夾對話框／SmartScreen 實際行為。"
