#!/usr/bin/env bash
# arcrun-rag 本機 demo 一鍵全拆（與 install.sh 對稱）
set -uo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${RAG_STATE_DIR:-$INSTALL_DIR/state}"
echo "── 停背景程序"
for name in collector cypher kbdb http-request code; do
  f="$STATE/$name.pid"
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "  停 ${name}（pid $(cat "$f")）"
  rm -f "$f"
done
# wrangler dev 有子行程，補掃 port
for p in 8787 8788 8789 8790; do lsof -ti :$p 2>/dev/null | xargs kill -9 2>/dev/null; done
echo "── 移除 Gitea 容器"
docker rm -f arcrun-rag-gitea 2>/dev/null && echo "  容器已移除" || echo "  （容器不存在）"
echo "── 清 state（資料庫/KV/repo/token；demo 資料夾 ~/arcrun-rag-demo 留給你自己刪）"
rm -rf "$STATE"
echo "✅ 拆完"
