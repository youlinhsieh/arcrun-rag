#!/bin/bash
# 2026-07-28 大掃除＋重送：兩實例的舊塊（無庫章/重複）全下架 → 清帳本 → 立即同步
# 前提：兩個帳號都已「重跑安裝」（workflow 才是會寫庫章的新版）。冪等，可重跑。
set -u
A="$HOME/.arcrun-rag"
takedown_all() { # $1=host $2=ns $3...=資料夾
  local host=$1 ns=$2; shift 2
  for d in "$@"; do
    [ -d "$d" ] || continue
    find "$d" -maxdepth 2 -type f \( -name "*.md" -o -name "*.pdf" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.csv" -o -name "*.txt" -o -name "*.pptx" \) ! -path "*/system-dev/*" | while read -r f; do
      rel="${f#$d/}"; pn=$(basename "$rel"); pn="${pn%.*}"
      code=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -X POST "https://$host/webhooks/named/$ns/rag_takedown_direct/trigger" \
        -H "Content-Type: application/json" -H "X-Arcrun-API-Key: $ns" \
        -d "{\"page_name\":\"$pn\",\"path\":\"$rel\"}")
      echo "  下架 $ns/$pn → $code"
    done
    # 卡片頁也掃一輪（cards/ 底下）
    if [ -d "$d/system-dev/wiki/cards" ]; then
      for f in "$d"/system-dev/wiki/cards/*.md; do
        [ -f "$f" ] || continue
        pn=$(basename "$f"); pn="${pn%.*}"
        curl -s -m 30 -o /dev/null -X POST "https://$host/webhooks/named/$ns/rag_takedown_direct/trigger" \
          -H "Content-Type: application/json" -H "X-Arcrun-API-Key: $ns" \
          -d "{\"page_name\":\"$pn\",\"path\":\"$pn.md\"}"
      done
    fi
  done
}
echo "① geek6688 下架舊份"
takedown_all arcrun-cypher-executor.arcrun-fc9490d5.workers.dev ckxt8yr9 \
  "$HOME/Desktop/geek6688-test1" "$HOME/Desktop/geek6688-test2"
echo "② youlin 下架舊份"
takedown_all arcrun-cypher-executor.youlin-hsieh-dev.workers.dev yuga3bse \
  "$HOME/Desktop/youlinhsieh-test1" "$HOME/Desktop/youlinhsieh-test2"
echo "③ 清帳本＋立即同步"
mkdir -p "$A/manifest-backup-resync" && mv "$A"/manifest-official*.json "$A/manifest-backup-resync/" 2>/dev/null
touch "$A/sync-now"
echo "✅ 已觸發重送。等托盤顯示「已萃 N 檔」後，刷新兩個 portal 的庫目錄——資料夾應自動出現。"
