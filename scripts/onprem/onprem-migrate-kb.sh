#!/usr/bin/env bash
# 把「雲端的知識庫」搬進公司自己 server 上的 Arcrun 私有雲（inkstone/arcrun-rag#339）。
# 兩段，各一條指令，都可以重跑：
#
#   export  （在能連 Cloudflare 的機器上跑）
#           D1 → SQLite 快照（走 Arcrun#271 的 kbdb-copy，內建逐表筆數＋sha256 驗證）
#           → 拿掉來源自己的營運資料 → Vectorize → sqlite-vec 向量檔 → MANIFEST.json
#   import  （在客戶 server 上跑，要有 docker；不需要連 Cloudflare）
#           把快照放進「還沒走精靈」的私有雲容器的 /data，重開，再對 MANIFEST 驗一次
#
# 例：
#   CLOUDFLARE_API_TOKEN=… ./onprem-migrate-kb.sh export --out ./snap \
#       --account <CF accountId> --d1 <D1 databaseId> --vectorize <index 名> \
#       --tenant <來源實例的 namespace> --arcrun-dir <Arcrun 工作目錄（已 pnpm i）>
#   ./onprem-migrate-kb.sh import --snapshot ./snap --container arcrun
#
# 紅線：金鑰只從環境變數讀（不收命令列參數）；對來源只讀；不碰 prod。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "✗ $*" >&2; exit 2; }
say() { echo "▶ $*"; }

cmd="${1:-}"; [ -n "$cmd" ] || die "用法：$0 export|import …（見檔頭）"; shift
OUT=""; SNAP=""; ACCOUNT=""; D1=""; VEC=""; TENANT=""; ARCRUN_DIR=""; CONTAINER="arcrun"; WIPE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --snapshot) SNAP="$2"; shift 2;;
    --account) ACCOUNT="$2"; shift 2;;
    --d1) D1="$2"; shift 2;;
    --vectorize) VEC="$2"; shift 2;;
    --tenant) TENANT="$2"; shift 2;;
    --arcrun-dir) ARCRUN_DIR="$2"; shift 2;;
    --container) CONTAINER="$2"; shift 2;;
    --wipe) WIPE=1; shift;;
    *) die "不認得的參數：$1";;
  esac
done

# ───────────────────────────── export ─────────────────────────────
do_export() {
  [ -n "$OUT" ] && [ -n "$ACCOUNT" ] && [ -n "$D1" ] && [ -n "$VEC" ] && [ -n "$TENANT" ] && [ -n "$ARCRUN_DIR" ] \
    || die "export 需要 --out --account --d1 --vectorize --tenant --arcrun-dir"
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "要設環境變數 CLOUDFLARE_API_TOKEN（只需 D1 讀取＋Vectorize 讀取）"
  command -v node >/dev/null || die "要有 Node ≥ 22.5"
  mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
  KB="$ARCRUN_DIR/kbdb"
  [ -f "$KB/package.json" ] || die "$KB 不是 Arcrun 的 kbdb 目錄"
  if [ ! -f "$KB/dist/kbdb-copy.mjs" ]; then say "編 kbdb-copy"; (cd "$KB" && pnpm run build:node >/dev/null); fi

  rm -f "$OUT/kbdb.sqlite" "$OUT/kbdb.sqlite-wal" "$OUT/kbdb.sqlite-shm"
  say "1/4 D1 → SQLite（唯讀來源；完成會自動驗兩邊筆數與內容摘要）"
  node --no-warnings "$KB/dist/kbdb-copy.mjs" --from "d1:$ACCOUNT/$D1" --to "sqlite:$OUT/kbdb.sqlite" | tee "$OUT/copy.log" | grep -v '已讀' || true
  grep -q '驗證通過' "$OUT/copy.log" || die "搬庫驗證沒過，看 $OUT/copy.log"

  say "2/4 拿掉來源自己的營運資料（只動複本）"
  node --no-warnings "$HERE/filter-snapshot.mjs" "$OUT/kbdb.sqlite" > "$OUT/filter.json"; cat "$OUT/filter.json"

  say "3/4 Vectorize → 向量檔"
  rm -f "$OUT/vectors.sqlite" "$OUT/vectors.jsonl"
  CF_ACCOUNT="$ACCOUNT" CF_TOKEN="$CLOUDFLARE_API_TOKEN" INDEX="$VEC" OUT="$OUT/vectors.jsonl" node "$HERE/vec-export.mjs" | tail -1
  node --no-warnings "$HERE/vec-load.mjs" "$OUT/vectors.jsonl" "$OUT/vectors.sqlite" "$KB/sidecar/vector-store.mjs"
  rm -f "$OUT/vectors.jsonl"

  say "4/4 寫 MANIFEST.json"
  TENANT="$TENANT" OUT="$OUT" HERE="$HERE" node --no-warnings "$HERE/write-manifest.mjs"
  say "完成：$OUT（整個資料夾帶去客戶 server，跑 import）"
}

# ───────────────────────────── import ─────────────────────────────
adm() { docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8090/status').then(r=>r.text()).then(console.log)"; }
do_import() {
  [ -n "$SNAP" ] || die "import 需要 --snapshot <資料夾>"
  command -v docker >/dev/null || die "要有 docker"
  SNAP="$(cd "$SNAP" && pwd)"
  for f in kbdb.sqlite vectors.sqlite MANIFEST.json; do [ -f "$SNAP/$f" ] || die "快照缺 $f"; done
  say "核對快照檔沒被動過（sha256）"
  node --no-warnings "$HERE/write-manifest.mjs" --check "$SNAP"
  TENANT_WANT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/MANIFEST.json")).tenant)' "$SNAP")"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "找不到容器 $CONTAINER。先：docker run -d --name $CONTAINER -e ARCRUN_TENANT=$TENANT_WANT -p 8080:8080 -p 8081:8081 -v arcrun-data:/data <映像檔>"
  TENANT_HAVE="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n 's/^ARCRUN_TENANT=//p')"
  [ "${TENANT_HAVE:-main}" = "$TENANT_WANT" ] || die "容器的 ARCRUN_TENANT 是「${TENANT_HAVE:-main}」，快照的知識屬於「$TENANT_WANT」，兩個要一樣，否則查不到卡。用 -e ARCRUN_TENANT=$TENANT_WANT 重建容器（同一個 volume）。"
  IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
  DONE="$(adm | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).setup_done))')"
  if [ "$DONE" = "true" ] && [ "$WIPE" != 1 ]; then
    die "這個容器已經走完精靈。匯入會整個換掉知識庫檔（連同精靈建的管理員），要先清空重來：加 --wipe，匯入後再走一次精靈。"
  fi
  say "停容器、把快照放進 /data（映像檔 $IMAGE）"
  docker stop "$CONTAINER" >/dev/null
  docker run --rm --user 0 --volumes-from "$CONTAINER" -v "$SNAP":/snap:ro --entrypoint sh "$IMAGE" -c '
    set -e
    rm -f /data/kbdb.sqlite /data/kbdb.sqlite-wal /data/kbdb.sqlite-shm /data/vectors.sqlite /data/vectors.sqlite-wal /data/vectors.sqlite-shm
    if [ "'"$WIPE"'" = 1 ]; then rm -f /data/config.json; fi
    cp /snap/kbdb.sqlite /data/kbdb.sqlite; cp /snap/vectors.sqlite /data/vectors.sqlite
    chown --reference=/data /data/kbdb.sqlite /data/vectors.sqlite; sync'
  docker start "$CONTAINER" >/dev/null
  say "等容器健康"
  for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" = healthy ] && break; sleep 2; done
  say "對 MANIFEST 驗證（筆數）"
  docker exec -i "$CONTAINER" node --no-warnings -e '
    const {DatabaseSync}=require("node:sqlite");const m=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const db=new DatabaseSync("/data/kbdb.sqlite",{readOnly:true});
    const e=db.prepare("SELECT count(*) c FROM entries").get().c,t=db.prepare("SELECT count(*) c FROM templates").get().c;
    const bt=Object.fromEntries(db.prepare("SELECT entry_type t,count(*) c FROM entries GROUP BY 1").all().map(r=>[r.t,r.c]));
    let bad=[];if(e!==m.entries)bad.push("entries "+e+"≠"+m.entries);if(t!==m.templates)bad.push("templates "+t+"≠"+m.templates);
    for(const [k,v] of Object.entries(m.by_entry_type))if((bt[k]||0)!==v)bad.push(k+" "+(bt[k]||0)+"≠"+v);
    console.log(JSON.stringify({entries:e,templates:t,vectors_in_manifest:m.vectors}));
    if(bad.length){console.error("✗ "+bad.join("；"));process.exit(1)}console.log("✓ 與 MANIFEST 一致")' < "$SNAP/MANIFEST.json"
  echo
  echo "下一步：瀏覽器開 http://<這台>:8080 走精靈（管理員自己設）；再把 n8n 的 MCP 網址與憑證改掉（見「大前地端 n8n 改法」一頁）。"
}

case "$cmd" in
  export) do_export;;
  import) do_import;;
  *) die "只有 export 與 import";;
esac
