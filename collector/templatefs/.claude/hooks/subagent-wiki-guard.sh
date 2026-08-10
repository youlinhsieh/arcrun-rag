#!/bin/bash
# subagent-wiki-guard.sh — PreToolUse(Task) hook：subagent 聽到「查」就自己先查 wiki
#
# 病根（2026-07-20）：總管兩次派 agent 查 ENCRYPTION_KEY，prompt 都只叫它「去查 repo 程式碼」。
#   agent 於是從**稿子**推論出「這東西還活著、不能動」，總管照單全收去擋 leo 三輪。
#
# 🔑 設計轉向（leo 2026-07-21）：
#   第一版是「上游沒交代讀 wiki 就擋下」——但那**還是依賴上游記得寫**，
#   跟「我記得讀 wiki」是同一個病。leo 點破：
#     「subagent 的問題跟你一樣。你叫它去查，就算你沒說要先查 wiki，
#       但它**只要聽到查，就應該主動查 wiki**，因為每個 repo 都有維護自己的 wiki。」
#   → 改成 **注入式**：不擋、不要求上游改 prompt，直接把「先查 wiki」這條
#     以 additionalContext 注入給 subagent，讓它自己做。零依賴任何人記得。
#
# 行為：偵測到查證/實作類任務 → exit 0 並用 hookSpecificOutput 注入指示。
#       已含 wiki 指示、或非查證類任務 → 靜默放行（不重複注入）。
set -euo pipefail

INPUT=$(cat)

PROMPT=$(printf '%s' "$INPUT" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('tool_input',{}).get('prompt',''))
except Exception: print('')
" 2>/dev/null || echo "")

[ -z "$PROMPT" ] && exit 0

# 上游已經交代了 → 不必重複注入
if printf '%s' "$PROMPT" | grep -qiE "wiki|agent-memory|mistakes\.md|decisions-summary"; then
  exit 0
fi

# 只對「查證/實作」類任務注入（純寫作、計算、潤稿等不需要）
if ! printf '%s' "$PROMPT" | grep -qiE "查|盤點|核實|確認|調查|研究|找出|repo|程式碼|原始碼|source|實作|移除|刪除|重構|修|grep|codebase|\.ts|\.go|src/"; then
  exit 0
fi

python3 - <<'PY'
import json

guidance = """【自動注入：查任何東西之前，先查 wiki】

你所在的 repo 有維護自己的 wiki（通常在 `system-dev/wiki/`，舊結構在 `.claude/wiki/`）。
**接到「查／盤點／核實／實作」類任務時，第一個動作是搜尋 wiki，不是翻程式碼。**

🔴 **查法有強弱之分，一律從最強的開始——沒有那個能力才降級。**
（leo 2026-07-21：「它一定是用最好的搜尋，如果沒有才 fallback，
  但那不是你要指定的，對搜尋者來說，我就是要去搜尋，如果你沒這個機制才降。」）

  **① 語意搜尋（最強，優先）**——有 Arcrun RAG MCP 就用它，用**自然語言問句**，不是關鍵字：
       kbdb_search(q="<用一句話描述你要找什麼>", mode="semantic")
       不確定該查哪個庫 → 先 kbdb_get_map() 看藏書地圖
       要沿關係展開 → kbdb_graph_neighbors()
  **② 關鍵字搜尋**——語意不可用時：kbdb_search(q="...", mode="keyword")
  **③ grep（最弱，最後手段）**——連 MCP 都沒有時：
       grep -rin "<關鍵字>" system-dev/wiki/ 2>/dev/null || grep -rin "<關鍵字>" .claude/wiki/

🔴 **為什麼順序是硬規定（2026-07-21 實際事故）**：
   查「CF 上的 git 託管」時只用了 grep，搜 Gitea/freeze/D43 等字面詞 → **零命中**，
   結論寫成「這件事沒查過、申請表沒送」。
   事後用**同一個問題**跑語意搜尋，**第一筆就命中**（score 0.858）：
   「Cloudflare Artifacts：假設內建 git 倉庫機制的 CF 功能，成立則可全 CF 化」，
   還帶出三元組「Cloudflare Artifacts >> 若提供 git 倉庫則可取代 >> Gitea」——
   **負責人 15 天前就記在筆記裡了。**
   → **grep 只認字面，要求你先猜對那個詞；語意搜尋不需要你猜對。**
     用 grep 查不到 ≠ wiki 沒記載，只代表你沒猜中用詞。

🔴 **凡結論涉及「某人沒做某事」，回報前必須先用語意搜尋查該事的記載**——
   這種結論錯了會變成**指控**，成本遠高於技術判斷錯誤。

為什麼這是划算的：
  • wiki 是前人已經查過、驗證過、被負責人糾正過的結論——**判準**。
  • 程式碼與歷史文件是**稿子**：它反映「還沒清乾淨」，不等於「還在用」。
    從稿子推論會系統性得出過時結論。
  • wiki 沒記載，才值得花力氣翻原文。
  • **凡結論涉及「某人沒做某事」，回報前必須先 grep 該事在 wiki 的記載**——
    這種結論錯了會變成指控，成本遠高於技術判斷錯誤。

三條硬規則：
  1. **wiki 與程式碼衝突 → 以 wiki 為準**，並在回報中明確指出衝突，
     不要自行用 code 推翻 wiki。
  2. wiki 寫「不可動／待廢除／進行中」→ **讀它的解除條件並逐條核對**。
     那是當時狀態，不是永久禁令；條件已滿足就是可動。
     （2026-07-20 實際事故：agent 只看到「不可動」就回報不能動，
       實際上解除條件早已滿足，害負責人被擋三輪。）
  3. 翻原文後若得到**新結論**，回報時明講「wiki 該更新」——wiki 過時是債，要還。
"""

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": guidance
    }
}, ensure_ascii=False))
PY

exit 0
