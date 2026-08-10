#!/bin/bash
# 2026-07-28 一次性清理：t108 事故（t104 逐帳號同步未繼承萃取設定→原文直送上雲）
# 對兩個測試實例下架 5 個誤傳頁（rag_takedown_direct＝標 deprecated 軟刪，不碰其他資料）。
set -u
clean() { # $1=cypher host  $2=namespace
  for p in "20260720-arcrun-rag-tier-comparison-draft.pdf" "Leo-Hsieh-填答.pdf" "ax-academy-handson-patches-v2.md" "cards/ax-academy-handson-patches-v2.md" "教材授權書-Leov2.pdf"; do
    pn=$(basename "$p"); pn="${pn%.*}"
    code=$(curl -s -m 30 -o /tmp/td.json -w "%{http_code}" -X POST "https://$1/webhooks/named/$2/rag_takedown_direct/trigger" \
      -H "Content-Type: application/json" -H "X-Arcrun-API-Key: $2" \
      -d "{\"page_name\":\"$pn\",\"path\":\"$p\"}")
    echo "$2 $pn → $code $(head -c 100 /tmp/td.json)"
  done
}
clean arcrun-cypher-executor.arcrun-fc9490d5.workers.dev ckxt8yr9
clean arcrun-cypher-executor.youlin-hsieh-dev.workers.dev yuga3bse
echo "✅ 完成。portal 搜尋這些頁名應該搜不到了（deprecated）。"
