#!/usr/bin/env bash
# build-win.sh — 打包 Arcrun Windows 版（Wails，t196／2026-08-05）
#
# leo 08-05：「Windows 版一定要重編，因為我只有 Mac，我需要人家測試，
#              要做到最完善不要給人家找麻煩」
#
# 🎯 **在 Mac 上就能交叉編譯**，不需要 Windows 機器／Docker。
#    條件只有一個：`brew install mingw-w64`（提供 x86_64-w64-mingw32-gcc）。
#    Wails 的 Windows 版要 CGo（WebView2 綁定），所以 CGO_ENABLED=1 + mingw。
#
# 與 build-mac.sh 同一個要點：**必須把 collector 同綑進去**。
#   daemon 的本體是 `collector direct`（監看／萃卡／上傳），App 只是門面；
#   沒同綑 ⇒ 使用者裝了也不會同步（t194 在 Mac 版就漏過一次）。
#
# ⚠️ 誠實界定（沿用 build-windows.sh 的自陳）：
#    本腳本只證明「**編得出來**」，不證明「**跑起來對**」。
#    托盤圖示會不會出現、WebView2 有沒有裝、SmartScreen 攔截行為，
#    **只有真的在 Windows 上跑才驗得到**——那一步歸 leo／封測者真機。
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$PATH:$(go env GOPATH)/bin"

# 🔴 2026-08-06：版本號**不再手打、也不再靠 git describe**。
#   舊寫法 `git describe --tags` 在這個 repo 永遠拿不到 v0.18.x（一個 tag 都沒有）
#   ⇒ 版本只能靠打包時人工 `VERSION=v0.18.4 ./build-win.sh` 敲 ⇒ manifest 說謊的病根。
#   現在由 daemon-version.py 從 DAEMON_LINE + collector/ 的 commit 數算出來，
#   兩條打包線（win／mac）在同一個 commit 上必得同一個號碼。理由全文見該腳本。
VERSION="${VERSION:-$(./daemon-version.py --stamp)}"
BUILD_TIME="$(date '+%Y%m%d-%H%M')"
echo "🏷  版本：${VERSION}（build ${BUILD_TIME}）"

# 🔴 2026-08-06 機械閘：這一版的「更新內容」沒寫進 changelog ⇒ 不准打包。
#   leo：「給版本號、本版更新內容、打包產品、顯示在前端，這一整串都應該是機械化」。
#   單一真相源＝docs-site/.../help/changelog.md；manifest.notes 與前端全部投影自它。
#   理由與格式見 changelog-section.sh。
./changelog-section.sh "$VERSION" --check

command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || {
  echo "❌ 缺 mingw-w64（Wails Windows 版需要 CGo 交叉編譯器）"
  echo "   裝一次就好：brew install mingw-w64"
  exit 1
}

echo "⓪ 由 appicon.png 產生 Windows 圖示（icon.ico／trayicon.ico）"
# 🔴 2026-08-06：不產就會沿用上一次留在磁碟上的檔——而上一次那顆是 `wails init`
#   留下的 Wails 預設「W」圖，leo 封測看到視窗與托盤兩處都是 W。
#   每次 build 都重產 ⇒ 「換了 appicon 卻沒換 Windows」這種漂移不可能再發生。
python3 gen-icons.py

# 🔴 2026-08-06 起**不再單獨編 collector.exe**（leo：「不要兩支，寫成一支檔案」）。
#   collector 已改成可被引用的套件（arcrun-rag/collector.Run），直接編進 Arcrun.exe，
#   靠 `--collector` 參數換身分。磁碟上永遠只有一個 exe。
#   為什麼要這樣：前一版把 collector.exe embed 進去、執行時攤到磁碟再跑，
#   那是 Windows Defender 眼中的 dropper 特徵（封測者實撞 Trojan:Win32/Sabsik.FL.A!ml）。

# 🔴 同 build-mac.sh：wails.json 沒 info.productVersion ⇒ exe 內容資訊永遠是 1.0.0。
#   Windows 使用者在「內容→詳細資料」看到的版本讀這個欄位；MSIX 送審也會對照。
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

# 🔴 makensis 壞掉時**不能**還帶 -nsis：wails 會整個中止，連 exe 都不產
#   （2026-08-06 實撞：Homebrew makensis 3.12 在這台 macOS 連兩行的最小腳本都丟
#    std::bad_alloc ⇒ 三種壓縮器全崩、brew extract 舊版也被 homebrew/core 擋）。
#   ⇒ 先用最小腳本煙霧測試，過了才開安裝程式。
NSIS_FLAG=""
if command -v makensis >/dev/null 2>&1; then
  SMOKE="$(mktemp -d)"
  printf 'OutFile "%s/s.exe"\nSection\nSectionEnd\n' "$SMOKE" > "$SMOKE/s.nsi"
  if makensis "$SMOKE/s.nsi" >/dev/null 2>&1; then
    NSIS_FLAG="-nsis"
    echo "   ✅ makensis 可用 → 會一併產生安裝程式"
  else
    echo "   ⚠️ makensis 裝了但**跑不起來**（最小腳本就崩）⇒ 這次不產安裝程式，只出裸 exe"
  fi
  rm -rf "$SMOKE"
else
  echo "   ⚠️ 沒有 makensis ⇒ 這次不產安裝程式，只出裸 exe（brew install makensis）"
fi

echo "② wails build（windows/amd64，CGo 走 mingw）"
CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc \
  wails build -platform windows/amd64 -clean ${NSIS_FLAG} \
    -ldflags "-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME} \
              -X arcrun-rag/collector.version=${VERSION} -X arcrun-rag/collector.buildTime=${BUILD_TIME}"

OUT="dist"; mkdir -p "$OUT"

echo "③ 產出**單一執行檔**"
# 🔴 2026-08-06 交付形態改變（leo 封測回報②，圖一標註）：
#   「下載還是 ZIP ⇒ 應該是 MSIX 或 EXE」「解開還是 2 個檔 ⇒ 應該只有 1 個檔案」
#   「兩個檔案令人很迷惑，User unfriendly」
#
#   舊做法一＝zip 裡放兩支 exe 同層。使用者只要少解一個檔，同步就永遠不會動。
#   舊做法二（v0.18.7-8）＝把 collector.exe embed 起來、執行時攤到磁碟再跑。
#     ⇒ **Defender 判 dropper**：封測者實撞 `Trojan:Win32/Sabsik.FL.A!ml`，檔案當場被隔離。
#   現在＝collector 是套件，直接編進同一個執行檔，`--collector` 換身分。
#     **下載下來就是一個檔，雙擊就跑，磁碟上不會多出任何東西。**
#
#   為什麼不出 MSIX：未上架的 MSIX 要使用者先開「開發人員模式」才裝得起來，
#   比 zip 更麻煩。上架 MS Store 後再回頭走 build-msix.sh。
EXE="$(cd "$OUT" && pwd)/Arcrun-win-${VERSION}.exe"
rm -f "$EXE"
cp build/bin/arcrun-app.exe "$EXE"

# 🔴 機械閘：這一顆必須**自己就會當 collector**。
#   過去的閘是比大小（確認 embed 進去了）；現在改成**直接問它**——
#   跑 `--collector --version`，回得出版本才算數。編成空殼、或分派寫錯，都會在這裡紅。
#   （不能用 wine 跑 .exe，所以驗的是同一份原始碼編出來的原生版；分派邏輯與平台無關。）
PROBE="$(mktemp -d)/probe"
go build -ldflags "-X main.version=${VERSION} -X arcrun-rag/collector.version=${VERSION}" -o "$PROBE" . || { echo "❌ 探針編不出來"; exit 1; }
PROBE_OUT="$("$PROBE" --collector --version 2>&1 | head -1)"
rm -rf "$(dirname "$PROBE")"
if [ -z "$PROBE_OUT" ]; then
  echo "❌ 這顆 exe 不會當 collector（--collector --version 沒有輸出）"
  echo "   ⇒ 裝了也不會同步。中止。"
  exit 1
fi
echo "   ✅ 自帶同步引擎（--collector --version → ${PROBE_OUT}）"

# 🔴 2026-08-06 leo 封測回報③：「Windows 用戶通常習慣 install 過程，它則只是一個執行檔，
#   表示安裝後不會在 Windows 開始資料夾出現，關掉下次要用就找不到了，也沒有 uninstall，
#   希望跟 Mac 一樣用建議的安裝方式」⇒ 出 NSIS 安裝程式（`-nsis`）。
#   裝完會有：開始功能表項目、桌面捷徑、控制台可解除安裝——與 Mac 的 DMG 拖曳同級的「正常」。
#   裸 exe 仍保留（給想免安裝試用的人），但**主打是安裝程式**。
SETUP_SRC="build/bin/arcrun-app-amd64-installer.exe"
if [ -f "$SETUP_SRC" ]; then
  SETUP="$(cd "$OUT" && pwd)/Arcrun-setup-${VERSION}.exe"
  cp "$SETUP_SRC" "$SETUP"
  echo "   ✅ 安裝程式：$(basename "$SETUP")（$(ls -lh "$SETUP" | awk '{print $5}')）"
else
  echo "⚠️  沒產出 NSIS 安裝程式 —— **leo 08-06 要的『正常安裝流程』尚未兌現**"
  echo "   真兇：Homebrew 的 makensis 3.12 在這台 macOS 壞掉（連兩行的最小腳本都"
  echo "   在寫檔階段丟 std::bad_alloc，三種壓縮器全崩 ⇒ 工具鏈問題，不是我們的 .nsi）。"
  echo "   已試過且無效：zlib/bzip2/lzma 三壓縮器、brew extract 舊版（homebrew/core 不給 tap）。"
  echo "   ⇒ 本次仍只產裸 exe。安裝程式的替代路線見 docs/store-submission.md（MSIX/Store）。"
fi

SIZE=$(ls -lh "$EXE" | awk '{print $5}')
echo "✅ 完成：${EXE}（${SIZE}，單一檔案、自帶同步引擎）"
echo
echo "🔬 使用者流程：下載 → 雙擊 Arcrun.exe（不必解壓縮、不必找第二個檔）"
echo "   ⚠️ 未簽章 ⇒ SmartScreen 會攔（「更多資訊」→「仍要執行」）。"
echo "      要免除這一步＝上 MS Store（見 build-msix.sh）或買 EV 憑證。"
