#!/usr/bin/env bash
# Arcrun 企業私有雲（大前地端）安裝腳本。現場只需要：Linux、Docker、bash、sha256sum。不需要 node、不需要連外網。
# 票：inkstone/arcrun-rag#339（里程碑 80 / InkStoneCo#203）
#
#   ./install.sh check        驗安裝包檔案沒壞（sha256）、環境夠不夠
#   ./install.sh up           載入映像檔、起容器、印出「安裝識別碼」（拿去跟原廠要啟用碼）
#   ./install.sh status       這台現在的狀態（啟用／精靈／知識庫筆數）
#   ./install.sh import       把大前知識庫放進這一台（要在走精靈之前做；啟用前後都可以）
#   ./install.sh n8n-test     用這台的 MCP 金鑰實打一次（金鑰不印出來），給 n8n 改完網址前先驗
#   ./install.sh import-app [檔…]  把同仁用的小幫手安裝檔（.dmg／.exe）放到這台，Portal 的「下載」就從這台給（不連外網）。
#                              沒給檔名＝放 apps/ 資料夾裡的全部
#   ./install.sh set-url <網頁網址> <API 網址>  對外網址填錯（例如存成 127.0.0.1）時改對，不用重走精靈、資料不動
#
# 可用環境變數改預設：NAME（容器名 arcrun）VOLUME（資料卷 arcrun-data）UI_PORT（8080）API_PORT（8081）
#                    ARCRUN_NETWORK（指定 docker 網路；預設用主機的 -p 對外開埠）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${NAME:-arcrun}"; VOLUME="${VOLUME:-arcrun-data}"
UI_PORT="${UI_PORT:-8080}"; API_PORT="${API_PORT:-8081}"
KB="$HERE/kb"

die() { echo "✗ $*" >&2; exit 2; }
say() { echo "▶ $*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "這台沒有 $1"; }
need docker; need sha256sum

image_file() { ls "$HERE"/images/arcrun-private-cloud-*.tar.gz 2>/dev/null | head -1; }
image_tag() { local f; f="$(image_file)"; [ -n "$f" ] || die "找不到 images/arcrun-private-cloud-*.tar.gz"; f="$(basename "$f" .tar.gz)"; echo "arcrun-private-cloud:${f#arcrun-private-cloud-}"; }
tenant_want() { sed -n 's/.*"tenant": *"\([^"]*\)".*/\1/p' "$KB/MANIFEST.json" | head -1; }
exists() { docker inspect "$NAME" >/dev/null 2>&1; }
# 在容器裡用它自己的 node 讀管理埠（只綁 127.0.0.1:8090，從外面讀不到）
adm() { docker exec "$NAME" node -e "fetch('http://127.0.0.1:8090/$1').then(r=>r.text()).then(console.log)"; }
jget() { docker exec -i "$NAME" node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(String(($2)))}catch(e){console.log('?')}})" <<<"$1"; }
wait_healthy() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  die "容器 3 分鐘內沒變健康。看日誌：docker logs $NAME"
}
host_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }
ui_url() {
  if [ -n "${ARCRUN_NETWORK:-}" ]; then
    echo "http://$(docker inspect -f '{{(index .NetworkSettings.Networks "'"$ARCRUN_NETWORK"'").IPAddress}}' "$NAME"):8080"
  else echo "http://$(host_ip):$UI_PORT"; fi
}

cmd_check() {
  say "核對安裝包檔案（sha256）"
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "有檔案對不上摘要：複製不完整或被改過，請重新複製安裝包"
  docker info >/dev/null 2>&1 || die "docker 沒在跑，或這個帳號不能用 docker（試試 sudo）"
  say "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)　架構 $(docker version -f '{{.Server.Arch}}' 2>/dev/null)（安裝包是 amd64／x86_64）"
  [ "$(docker version -f '{{.Server.Arch}}')" = amd64 ] || echo "⚠ 這台不是 amd64，映像檔可能跑不起來"
  if [ -z "${ARCRUN_NETWORK:-}" ] && ! exists; then
    for p in "$UI_PORT" "$API_PORT"; do
      if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then die "埠 $p 已被占用（可用 UI_PORT／API_PORT 換埠）"; fi
    done
    say "埠 $UI_PORT、$API_PORT 空著"
  fi
  say "OK"
}

cmd_up() {
  cmd_check
  local tag; tag="$(image_tag)"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    say "載入映像檔 $tag（約 140 MB，離線）"; docker load -i "$(image_file)" >/dev/null
  fi
  exists && die "容器 $NAME 已存在。要重來：docker rm -f $NAME && docker volume rm $VOLUME（會清掉這台的全部資料）"
  local T; T="$(tenant_want)"; [ -n "$T" ] || die "kb/MANIFEST.json 讀不到 tenant"
  say "起容器 $NAME（租戶 $T，資料卷 $VOLUME）"
  local net=(-p "$UI_PORT:8080" -p "$API_PORT:8081")
  [ -n "${ARCRUN_NETWORK:-}" ] && net=(--network "$ARCRUN_NETWORK")
  # 精靈的網址預設值：用這台主機的內網位址（不是瀏覽器地址列的 localhost）——同仁電腦要連的是它（inkstone/arcrun-rag#389）
  local adv=()
  if [ -z "${ARCRUN_NETWORK:-}" ] && [ -n "$(host_ip)" ]; then
    adv=(-e "ARCRUN_ADVERTISE_UI_URL=http://$(host_ip):$UI_PORT" -e "ARCRUN_ADVERTISE_API_URL=http://$(host_ip):$API_PORT")
  fi
  docker run -d --name "$NAME" --restart unless-stopped -e "ARCRUN_TENANT=$T" "${adv[@]}" "${net[@]}" -v "$VOLUME:/data" "$tag" >/dev/null
  wait_healthy
  echo
  echo "✓ 容器已起來。這一台目前是「未啟用」狀態（精靈與 API 都鎖著，正常）。"
  echo "  安裝識別碼：$(jget "$(adm license)" 'j.install_id')"
  echo "  UI 網址　　：$(ui_url)"
  echo
  echo "下一步：把「安裝識別碼」交給原廠換啟用碼 → 瀏覽器開 UI 網址貼上啟用碼 → ./install.sh import → 走精靈。"
}

cmd_status() {
  exists || die "找不到容器 $NAME（先跑 ./install.sh up）"
  local l s; l="$(adm license)"; s="$(adm status)"
  echo "啟用　：$(jget "$l" 'j.state+"　識別碼 "+j.install_id+(j.expires_at?"　到期 "+j.expires_at:"")')"
  echo "精靈　：$(jget "$s" 'j.setup_done?"已完成":"未完成"')"
  echo "版本　：$(docker exec "$NAME" cat /app/VERSION)"
  echo "子行程：$(jget "$s" 'Object.entries(j.children).map(([k,v])=>k+"="+v).join(" ")')"
  if docker exec "$NAME" test -f /data/kbdb.sqlite; then
    docker exec "$NAME" node --no-warnings -e '
      const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/kbdb.sqlite",{readOnly:true});
      const c=q=>db.prepare(q).get().c;console.log("知識庫："+c("SELECT count(*) c FROM entries")+" 筆（templates "+c("SELECT count(*) c FROM templates")+"）")' 2>/dev/null || true
  fi
  echo "UI　　：$(ui_url)"
}

cmd_import() {
  exists || die "找不到容器 $NAME（先跑 ./install.sh up）"
  for f in kbdb.sqlite vectors.sqlite MANIFEST.json; do [ -f "$KB/$f" ] || die "快照缺 kb/$f"; done
  say "核對快照檔沒被動過（sha256）"
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "檔案摘要不符"
  local T have; T="$(tenant_want)"
  have="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n 's/^ARCRUN_TENANT=//p')"
  [ "${have:-main}" = "$T" ] || die "容器租戶是「${have:-main}」，快照是「$T」，要一樣才查得到卡。docker rm -f $NAME 後用 ./install.sh up 重建（資料卷不動）。"
  local setup; setup="$(jget "$(adm status)" 'j.setup_done')"
  if [ "$setup" = "true" ] && [ "${WIPE:-0}" != 1 ]; then
    die "這台已走完精靈。匯入會整個換掉知識庫檔（連同精靈建的管理員）。確定要重來：WIPE=1 ./install.sh import，之後再走一次精靈。"
  fi
  local IMAGE; IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
  say "停容器、把快照放進 /data"
  docker stop "$NAME" >/dev/null
  docker run --rm --user 0 --volumes-from "$NAME" -v "$KB":/snap:ro -e "WIPE=${WIPE:-0}" --entrypoint sh "$IMAGE" -c '
    set -e
    rm -f /data/kbdb.sqlite* /data/vectors.sqlite*
    if [ "$WIPE" = 1 ]; then rm -f /data/config.json; fi
    cp /snap/kbdb.sqlite /data/kbdb.sqlite; cp /snap/vectors.sqlite /data/vectors.sqlite
    chown --reference=/data /data/kbdb.sqlite /data/vectors.sqlite; sync'
  docker start "$NAME" >/dev/null
  say "等容器健康"; wait_healthy
  say "對快照清單（MANIFEST）驗筆數"
  docker exec -i "$NAME" node --no-warnings -e '
    const {DatabaseSync}=require("node:sqlite");const m=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const db=new DatabaseSync("/data/kbdb.sqlite",{readOnly:true});
    const e=db.prepare("SELECT count(*) c FROM entries").get().c,t=db.prepare("SELECT count(*) c FROM templates").get().c;
    const bt=Object.fromEntries(db.prepare("SELECT entry_type t,count(*) c FROM entries GROUP BY 1").all().map(r=>[r.t,r.c]));
    const bad=[];if(e!==m.entries)bad.push("entries "+e+"≠"+m.entries);if(t!==m.templates)bad.push("templates "+t+"≠"+m.templates);
    for(const [k,v] of Object.entries(m.by_entry_type))if((bt[k]||0)!==v)bad.push(k+" "+(bt[k]||0)+"≠"+v);
    console.log("entries "+e+"／templates "+t+"／向量（清單）"+m.vectors);
    if(bad.length){console.error("✗ "+bad.join("；"));process.exit(1)}console.log("✓ 與快照清單一致")' < "$KB/MANIFEST.json"
  echo
  echo "下一步：瀏覽器開 $(ui_url) 走精靈（管理員 email／密碼自己設）。"
}

cmd_n8n_test() {
  exists || die "找不到容器 $NAME"
  say "用這台的 MCP 金鑰（不印出）打 /mcp：initialize、工具清單、知識庫"
  docker exec "$NAME" node --no-warnings -e '
    const tok=require("/data/secrets/secrets.json").mcp_token;
    const H={authorization:"Bearer "+tok,"content-type":"application/json",accept:"application/json, text/event-stream"};
    const call=async(id,method,params)=>{const r=await fetch("http://127.0.0.1:8081/mcp",{method:"POST",headers:H,body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
      const t=await r.text();const m=t.match(/data: (.*)/);return {status:r.status,j:JSON.parse(m?m[1]:t)}};
    (async()=>{
      const i=await call(1,"initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"install-test",version:"1"}});
      console.log("initialize HTTP "+i.status);
      const l=await call(2,"tools/list",{});const names=(l.j.result?.tools||[]).map(t=>t.name);
      console.log("工具 "+names.length+" 個："+["kbdb_get_index","kbdb_get_card","kbdb_search"].map(n=>n+(names.includes(n)?" ✓":" ✗")).join("　"));
      const g=await call(3,"tools/call",{name:"kbdb_get_map",arguments:{}});
      const txt=JSON.stringify(g.j.result||g.j);
      console.log("知識庫 "+["lib_473ed4","lib_1e221c","error_codes"].map(n=>n+(txt.includes(n)?" ✓":" ✗")).join("　"));
      const bad=await fetch("http://127.0.0.1:8081/mcp",{method:"POST",headers:{...H,authorization:"Bearer wrong"},body:"{}"});
      console.log("錯的金鑰 HTTP "+bad.status+"（要 401）");
    })().catch(e=>{console.error("✗ "+e.message);process.exit(1)})'
}

cmd_import_app() {
  exists || die "找不到容器 $NAME（先跑 ./install.sh up）"
  shift || true
  local files=("$@")
  if [ "${#files[@]}" -eq 0 ]; then
    shopt -s nullglob; files=("$HERE"/apps/*.dmg "$HERE"/apps/*.exe "$HERE"/apps/*.msix "$HERE"/apps/*.zip); shopt -u nullglob
  fi
  [ "${#files[@]}" -gt 0 ] || die "沒有要放的安裝檔：把 .dmg（Mac）／.exe（Windows）放進 $HERE/apps/，或把檔名寫在指令後面"
  docker exec "$NAME" mkdir -p /data/downloads
  for f in "${files[@]}"; do
    [ -f "$f" ] || die "找不到 $f"
    docker cp "$f" "$NAME:/data/downloads/$(basename "$f")"
    say "已放到這台：$(basename "$f")（$(du -h "$f" | cut -f1)）"
  done
  say "Portal「設定」裡同仁按下載就會從這台拿；現在可下載的："
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:8080/downloads/index.json').then(r=>r.text()).then(console.log)" 2>/dev/null \
    || docker exec "$NAME" ls -1 /data/downloads
}

cmd_set_url() {
  exists || die "找不到容器 $NAME（先跑 ./install.sh up）"
  local ui="${2:-}" api="${3:-}"
  [ -n "$ui" ] && [ -n "$api" ] || die "用法：./install.sh set-url http://<內網位址>:8080 http://<內網位址>:8081"
  docker exec -i "$NAME" node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',async()=>{
      const r=await fetch('http://127.0.0.1:8090/set-public-urls',{method:'POST',headers:{'content-type':'application/json'},body:s});
      const t=await r.text();console.log(r.status+' '+t);process.exit(r.ok?0:1)})" <<<"{\"ui_url\":\"$ui\",\"api_url\":\"$api\"}" \
    || die "沒改成（上面是原因）"
  wait_healthy
  say "改好了。同仁的小幫手要用新的網頁網址重新連線一次。"
}

case "${1:-}" in
  check) cmd_check;; up) cmd_up;; status) cmd_status;; import) cmd_import;; n8n-test) cmd_n8n_test;;
  import-app) cmd_import_app "$@";; set-url) cmd_set_url "$@";;
  *) sed -n '2,16p' "$0"; exit 1;;
esac
