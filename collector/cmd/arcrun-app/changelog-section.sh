#!/usr/bin/env bash
# changelog-section.sh — 抽出某一版的「更新內容」，並在缺漏時擋下打包（2026-08-06）
#
# 🔴 leo 08-06：「更新內容還要寫在 docs 裡，機械化要怎麼做」
#
# 答：改的是「**寫在哪**」，不是「誰來寫」。
#   文字一定得人寫（機器編不出「語意搜尋什麼都搜不到」這種人話），
#   但**只准寫一個地方**＝ docs-site/src/content/docs/help/changelog.md（用戶語言那份）。
#   其餘全是投影、不准手改（＝頂層 principles「投影不可手改，要改去改源頭」）：
#     · manifest.daemon.notes ← 打包時由本腳本抽出
#     · docs-site 的「版本說明」頁 ← 本來就是它自己
#     · portal／rag.arcrun.dev／App 的「版本與更新」 ← 讀同一份 manifest
#
#   **關鍵是這道閘**：打包時若 changelog 找不到這一版的段落 ⇒ 直接中止、不准打包。
#   ⇒ 「忘了寫更新內容」變成**不可能**，而不是靠誰記得。
#   （病根：manifest.daemon.notes 過去是手寫的，於是可以跟產物完全脫節。）
#
# 用法：
#   ./changelog-section.sh v0.18.7            # 印出該版段落（純文字，供 manifest.notes 用）
#   ./changelog-section.sh v0.18.7 --check    # 只檢查存不存在
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"
FILE="$REPO_ROOT/docs-site/src/content/docs/help/changelog.md"

VERSION="${1:?用法：changelog-section.sh <版本，例 v0.18.7> [--check]}"
CHECK_ONLY="${2:-}"

[ -f "$FILE" ] || { echo "❌ 找不到 changelog：$FILE" >&2; exit 1; }

# 段落格式：「## v0.18.7（2026-08-06）」——標題行以 `## <版本>（` 開頭。
SECTION="$(awk -v ver="## ${VERSION}（" '
  index($0, ver) == 1 { inside = 1; next }
  inside && /^## / { exit }
  inside { print }
' "$FILE")"

if [ -z "$(printf '%s' "$SECTION" | tr -d '[:space:]')" ]; then
  cat >&2 <<MSG
❌ changelog 裡沒有 ${VERSION} 的段落，不准打包。

   請在 docs-site/src/content/docs/help/changelog.md 最上面加一段：

     ## ${VERSION}（$(date '+%Y-%m-%d')）

     **建議更新**——（一句話說明「這版對你意味什麼」）

     - 🔴 **（用戶看得懂的白話標題）**：（發生什麼、現在怎樣）

   ⚠️ 寫給用戶看，不是寫給工程師看：說「以前會怎樣、現在會怎樣」，
      不要寫函式名或 commit 編號。
MSG
  exit 1
fi

[ "$CHECK_ONLY" = "--check" ] && { echo "  ✅ changelog 有 ${VERSION} 的段落"; exit 0; }

# 給 manifest.daemon.notes 用的投影——**只有一個投影器**：installer/scripts/daemon-notes.mjs
#
# 🔴 2026-08-08 修（leo 真機看到 v0.18.24 的更新畫面）：
#   leo 原話「**不要這麼長的散文，簡短講改了什麼，細節去 docs 讀。**」
#
#   本檔原本這一段是 `tr '\n' ' '`——**把整段散文壓成一大坨**。而畫面那個欄位是純文字
#   （`main.js:215` 是 `esc(u.notes)`，且 `.d` 沒有 white-space:pre）
#   ⇒ 既不分行、markdown 符號還會原樣露出來 ⇒ 使用者看到一整面文字牆。
#
#   更根本的問題：**grep 全 repo，沒有任何東西呼叫這段投影**（build-*.sh 只用 --check）。
#   ⇒ 出貨當下都是有人臨時寫一段 python 折行塞進 manifest，每次重寫一次、沒人檢查結果。
#   ⇒ 這正是「機制存在但沒被接上＝等於不存在」的又一例。
#
#   現在改成委派給那唯一的投影器（只取每條的粗體標題、串成一行、超長就截並導去 docs），
#   而 `installer/scripts/ship.mjs` 的 notes 步驟會在每次出貨時自動套用它。
#   ⇒ 兩邊同一份規則，不會漂移。上面的 --check 閘原樣保留（build-*.sh 仍靠它）。
exec node "$REPO_ROOT/installer/scripts/daemon-notes.mjs" "$VERSION"
