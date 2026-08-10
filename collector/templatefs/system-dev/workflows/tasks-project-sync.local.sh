#!/usr/bin/env bash
# tasks-project-sync.local.sh — 本地觸發端（投影的「本地一半」）
#
# 來源：issue #16；設計：system-dev/docs/3-specs/tasks-project-projection/design.md
#
# ── 為什麼有這支（職責邊界）──────────────────────────────────────
# arcrun workflow 跑在遠端 CF Workers，沒有本地 fs / git / shell。
# 所以「讀 tasks.md / git diff / 回寫 <!-- gh:id -->」這三件本地事
# 不能放進 workflow（arcrun 也沒有對應零件，這是架構邊界、不是缺口）。
# 這支就是那「本地一半」：分類好增量 → 交給 acr run 打 GitHub。
#
#   這支（本地）：讀 tasks.md → git diff → 分類四動作 → acr run 投影 → 回寫新 id
#                                                   │
#                                                   ▼
#   tasks-project-sync.yaml（遠端）：foreach → switch → github API
#
# ── 怎麼觸發（守 flag 紅線）─────────────────────────────────────
# push 後「本機觸發單次」，非 cron、非輪詢、非 GitHub Actions。
# 掛載點建議：本機 git post-push 類 hook，或叫 CC 在 push 後跑這支一次。
# ⚠️ 具體掛載點與「分類四動作」的精確 parse，待 leo21c 端到端驗證後定稿；
#    目前是 code-done 骨架，標出該做什麼、邊界在哪，不假裝已通。
#
# ── 用法 ───────────────────────────────────────────────────────
#   tasks-project-sync.local.sh <owner> <repo> <project_id>
#
# 前置：acr 在 PATH、github_token 已 acr creds push、workflow 已 acr push。

set -euo pipefail

OWNER="${1:?需要 owner}"
REPO="${2:?需要 repo}"
PROJECT_ID="${3:?需要 GitHub Projects v2 node id}"

# 多組 SDD 全同步：glob 掃所有 tasks.md（新 folder 自動成組，免手動登記）。
GLOB="system-dev/docs/3-specs/*/tasks.md"

# ── 1. 分類增量（git diff 知道改了哪幾行 → 四動作）──────────────
# 這裡是「本地一半」的核心。實作策略（待端到端驗證後落地）：
#   - 拿 push 前後的 git diff，限定 $GLOB 範圍，只看動到的行。
#   - 每行 task 解析：有無 `<!-- gh:N -->` id、checkbox 是否 [ ]→[x]、文字/負責人/日期變動。
#   - 行不見（diff 的刪除行）且原本有 id → archive。
#   - 子系統 = 該 tasks.md 的 folder 名（當 label 分組）。
#   - 產出 tasks_json 陣列（格式見 yaml 註解）。
#
# ⚠️ 刻意不在這支用 TS/Python 刻複雜 parser（守薄殼）。複雜分類交給 CC 在 push 後
#    讀 diff 直接產 tasks_json；這支保持「薄殼 + 交棒 acr run」。若未來證明需要可重用的
#    parser 零件，那屬於 arcrun 零件缺口 → 回報 issue #16 由 arcrun 端補，不在此自刻。
#
# 佔位：實際 tasks_json 由 CC 依上述策略產生後填入。
TASKS_JSON="${TASKS_JSON:-[]}"

if [ "$TASKS_JSON" = "[]" ]; then
  echo "（無增量 → 本次 no-op，不呼叫 GitHub）"
  exit 0
fi

# ── 2. 交給遠端 workflow 投影 ───────────────────────────────────
acr run tasks_project_sync \
  -i owner="$OWNER" \
  -i repo="$REPO" \
  -i project_id="$PROJECT_ID" \
  -i tasks_json="$TASKS_JSON"

# ── 3. 回寫新 task 的 id（唯一對 md 的寫入，只在 create 時做一次）──
# create 動作的回傳 issue number → append `<!-- gh:N -->` 到該行末。
# ⚠️ 防迴圈：回寫造成 working tree 變動，這次回寫「不得」再觸發一輪投影
#    （否則 push→觸發→回寫→又一個 diff→又觸發…）。實作時觸發端要排除
#    「只動到 <!-- gh:N --> 註解」的 diff，或回寫走 [skip-sync] 標記。
#    具體機制待端到端驗證定稿。
echo "（新 task 的 id 回寫：待端到端驗證後接上 acr run 的回傳 → append <!-- gh:N -->）"
