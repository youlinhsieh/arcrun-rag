#!/bin/bash
# publish-lag-check.sh — SessionStart hook：偵測「公開 mirror 落後工作區」並出聲
#
# 病根（leo 2026-07-21 點名的真實風險）：
#   Gitea（草稿/工作現場）與 GitHub（正稿/成品櫥窗）是**手動同步**的
#   （靠人跑 scripts/publish-github.sh --push，且需 D20 arm）。
#   → 改了零件、重編 wasm 後若沒人記得發佈，**用戶抓到舊版且沒有任何錯誤訊息，
#     只是行為不對**——這種靜默失敗只有外部使用者會撞到，我們自己永遠測不到。
#
#   實例：安裝器的懶載會從
#   cdn.jsdelivr.net/gh/youlinhsieh/Arcrun@main/.component-builds/<名>/component.wasm
#   抓 wasm。那個位址永遠指向 GitHub 上的**最後一次發佈**，不是我們本機的最新版。
#
# 原理：比對「工作區 HEAD」與「.github-public 最後一個 release commit 記錄的 snapshot」。
#   publish-github.sh 的 commit 訊息格式固定為：release: snapshot <短hash> (<日期>)
#   → 從中取出 hash，看它是不是工作區 HEAD 的祖先／相同。
#
# 只提醒不阻擋（exit 0）：發不發佈是人的決定（且 push GitHub 需 leo 親跑 arm），
#   hook 的職責只是消滅「忘了」這個失敗模式。
set -euo pipefail

MIRROR_DIR=".github-public"

# 沒裝發佈管線的 repo 直接安靜退出
[ -d "$MIRROR_DIR/.git" ] || exit 0
[ -f "scripts/publish-github.sh" ] || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

HEAD_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
[ -z "$HEAD_SHORT" ] && exit 0

# 從 mirror 最後一個 commit 訊息取出它當初發佈的來源 hash
LAST_MSG="$(git -C "$MIRROR_DIR" log -1 --format=%s 2>/dev/null || echo '')"
PUBLISHED="$(printf '%s' "$LAST_MSG" | sed -n 's/.*snapshot \([0-9a-f]\{6,\}\).*/\1/p')"

if [ -z "$PUBLISHED" ]; then
  # mirror 存在但沒有可辨識的 release commit（可能還沒發過）
  echo "════════════════════════════════════════════════"
  echo "📦 這個 repo 有公開發佈管線，但 mirror 還沒發過任何版本"
  echo "════════════════════════════════════════════════"
  echo "   若已有用戶依賴公開版（例如安裝器從 jsDelivr 抓 wasm），現在是空的。"
  echo "   發佈：leo 在頂層跑 scripts/github-arm.sh，再於本 repo 跑"
  echo "         GITHUB_REMOTE=... bash scripts/publish-github.sh --push"
  echo ""
  exit 0
fi

# 已發佈的那個 commit 就是現在的 HEAD → 同步，安靜
if [ "$PUBLISHED" = "$HEAD_SHORT" ]; then
  exit 0
fi

# 算出落後幾個 commit（發佈點 → HEAD）。取不到就不顯示數字。
BEHIND="$(git rev-list --count "${PUBLISHED}..HEAD" 2>/dev/null || echo '')"

# 落後 0 且 hash 不同 → 可能是 mirror 比工作區新（罕見，例如剛 rebase），一樣提醒
echo "════════════════════════════════════════════════"
if [ -n "$BEHIND" ] && [ "$BEHIND" != "0" ]; then
  printf '📤 公開 mirror 落後工作區 %s 個 commit（最後發佈：%s，現在：%s）\n' \
    "$BEHIND" "$PUBLISHED" "$HEAD_SHORT"
else
  printf '📤 公開 mirror 與工作區不一致（最後發佈：%s，現在：%s）\n' "$PUBLISHED" "$HEAD_SHORT"
fi
echo "════════════════════════════════════════════════"
echo "⚠️  外部使用者拿到的仍是舊版，而且**不會有任何錯誤訊息**——只是行為不對。"
echo "   （安裝器的懶載直接從公開位址抓 wasm，落後＝裝到舊零件。）"
echo ""
echo "   要發佈：① leo 在頂層跑  bash scripts/github-arm.sh \"<任務描述>\" 30"
echo "           ② 本 repo 跑    GITHUB_REMOTE=https://github.com/<帳號>/<repo>.git \\"
echo "                            bash scripts/publish-github.sh --push"
echo "   不急著發也沒關係——這只是提醒，別讓它靜默漏掉。"

# 若這次落後的內容碰到 wasm，額外警告（那是用戶會直接抓的東西）
if git diff --name-only "${PUBLISHED}..HEAD" 2>/dev/null | grep -q '\.wasm$'; then
  echo ""
  echo "   🔴 這批改動**包含 .wasm 變更** → 用戶抓到的零件會跟你本機不同，優先發佈。"
fi
echo ""

exit 0
