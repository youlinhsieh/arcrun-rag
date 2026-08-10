#!/bin/bash
# wiki-first-search.sh — PreToolUse hook：要去翻原文/程式碼前，先把 wiki 命中結果推到眼前
#
# 病根（2026-07-20 leo 點破，mistakes 第一鐵律）：
#   總管 session 開頭讀了 agent-memory 前 50 行就開工，關鍵那條在第 56 行 → 拿過期記憶擋了 leo 三輪。
#   leo：「如果你不是讀而是**搜尋** wiki 就不會只讀 50 行就下定論，
#         而是就像我直接在頁面 cmd+F，那些都會高亮。」
#
# 設計要點（為什麼是這個形狀）：
#   1. **搜尋 ≠ 通讀**：開場 push 全文（session-start-recall.sh）解決不了這題——量大必然只讀開頭。
#      這支反過來：在「你正要去查 code/原文」的當下，用你自己的關鍵字 grep wiki，只推命中行。
#   2. **時機是關鍵**：不是開場推、不是寫入時擋，而是**查詢動作發生的那一刻**介入。
#   3. **提醒不阻擋**（exit 0）：wiki 沒記載時本來就該去翻原文，擋下來反而礙事。
#      唯一目的是消滅「不知道 wiki 有寫」這件事。
#
# 觸發：Grep / Glob / Read 打向 code 或 docs 時（見下方 should_check）。
# 輸出：stdout 注入 context（命中的 wiki 行 + 檔名:行號）。
set -euo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")

# 取出這次查詢的關鍵字：Grep 用 pattern，Glob/Read 用路徑的檔名部分
QUERY=$(printf '%s' "$INPUT" | python3 -c "
import json,sys,os,re
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{})
    q = ti.get('pattern') or ''
    if not q:
        p = ti.get('file_path') or ti.get('path') or ''
        q = os.path.splitext(os.path.basename(p))[0] if p else ''
    if not q:
        # Bash：2026-07-21 補的破口——原版只掛 Grep|Glob|Read，
        # 但「用 curl/wrangler 亂試部署方法」走的是 Bash，整支 hook 不觸發。
        # leo 當場點破：wiki 早記著「寄信已驗證可用」，我卻沒查又自創方法。
        # 只認「會動到外部系統/部署」的高風險指令，避免每個 ls 都洗版。
        cmd = ti.get('command') or ''
        if re.search(r'\b(wrangler|curl|npx|acr|gh|deploy|push)\b', cmd):
            # 取指令中最具識別度的詞（worker 名/資源名/子命令）當搜尋詞
            cand = re.findall(r'[A-Za-z_][A-Za-z0-9_-]{4,}', cmd)
            skip = {'https','http','client','accounts','workers','scripts',
                    'application','content','Authorization','Bearer','python3',
                    'curl','npx','bash','echo','grep','local','branch','origin'}
            cand = [c for c in cand if c not in skip and not c.startswith('-')]
            q = max(cand, key=len) if cand else ''
    # grep pattern 常含 regex 元字元；取最長的英數/底線詞當搜尋詞
    words = re.findall(r'[A-Za-z_][A-Za-z0-9_]{3,}', q)
    print(max(words, key=len) if words else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

[ -z "$QUERY" ] && exit 0

WIKI_DIR="system-dev/wiki"
[ -d "$WIKI_DIR" ] || exit 0

# 只在「查程式碼/文件」時提醒；查 wiki 本身就不用了（已經在讀了）
TARGET=$(printf '%s' "$INPUT" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{})
    print(ti.get('file_path') or ti.get('path') or '')
except Exception: print('')
" 2>/dev/null || echo "")
case "$TARGET" in
  *system-dev/wiki*) exit 0 ;;
esac

# grep wiki（不分大小寫、含行號），最多 12 行避免洗版
HITS=$(grep -rin --include="*.md" -- "$QUERY" "$WIKI_DIR" 2>/dev/null | head -12 || true)

# 🔴 grep 零命中時**不能靜默退出**——那正是今天失敗的模式（2026-07-21）：
#    grep 查不到 → 以為 wiki 沒記載 → 結論「這件事沒查過」。
#    但 grep 只認字面，查不到往往只代表「沒猜中用詞」。
#    → 零命中反而是**最該改用語意搜尋**的時刻，必須出聲。
if [ -z "$HITS" ]; then
  echo "════════════════════════════════════════════════"
  printf '🔍 grep 在 wiki 找不到「%s」——但這**不代表沒記載**\n' "$QUERY"
  echo "════════════════════════════════════════════════"
  echo "grep 只認字面，查不到通常只是「沒猜中用詞」。**改用語意搜尋再確認一次**："
  echo "   kbdb_search(q=\"<用一句話描述你要找什麼>\", mode=\"semantic\")"
  echo "   不知道該查哪個庫 → kbdb_get_map()｜要沿關係展開 → kbdb_graph_neighbors()"
  echo ""
  echo "實例：查「CF 上的 git 託管」時 grep 全零命中，語意搜尋第一筆就命中"
  echo "（Cloudflare Artifacts >> 若提供 git 倉庫則可取代 >> Gitea，負責人 15 天前就記了）。"
  echo ""
  exit 0
fi

COUNT=$(printf '%s\n' "$HITS" | wc -l | tr -d ' ')

echo "════════════════════════════════════════════════"
printf '📚 wiki 已有「%s」的記載（%s 處，先看這裡再翻原文）\n' "$QUERY" "$COUNT"
echo "════════════════════════════════════════════════"
printf '%s\n' "$HITS" | sed 's|^system-dev/wiki/|  |'
echo ""
echo "⚠️  wiki 是判準，程式碼與歷史文件只是稿子（mistakes 第一鐵律）。"
echo "   • 上面若與你將要查的原文衝突 → **以 wiki 為準**，別用 code 推翻 wiki。"
echo "   • 看到「不可動／待廢除／進行中」→ 先讀它的**解除條件**並逐條核對，"
echo "     那是當時狀態不是永久禁令；條件已滿足就是可動。"
echo "   • wiki 沒答案才值得翻原文——翻完若得到新結論，**回頭更新 wiki**。"
echo ""
echo "🔎 以上是 **grep（最弱的查法）** 的結果，只認字面，且搜尋詞是從你的指令**猜**出來的"
echo "   （很可能太籠統而命中一堆無關的，同時漏掉真正的主題詞）。"
echo "   **重要判斷一律補一次語意搜尋**——它不需要你猜對用詞："
echo "      kbdb_search(q=\"<一句話描述你要找什麼>\", mode=\"semantic\")"
echo "   實例：查「CF 的 git 託管」時 grep 猜到的詞是 cloudflare → 命中 12 處全無關、"
echo "   真正的答案（Artifacts）一筆沒撈到；語意搜尋第一筆就命中。"
echo ""

exit 0
