#!/usr/bin/env bash
# 示範知識庫建置（inkstone/arcrun-rag#349）：在乾淨的私有雲容器上，用小幫手（collector direct）走正規萃取，
# 再把 /data 的知識庫取出、濾掉建置機自己的營運資料，產出 install.sh import 吃的快照。
# 需要：docker、node 22、go 建好的 collector（COLLECTOR）、跑著的 shim（Workers AI 轉接，:11434）
# 用法：TENANT=demokb01 IMAGE=arcrun-private-cloud:demo-lictest LK=lic.key bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
TENANT="${TENANT:-demokb01}"; IMAGE="${IMAGE:-arcrun-private-cloud:demo-lictest}"; CT=demokb-build; VOL=demokb-build-data
COLLECTOR="${COLLECTOR:-/tmp/collector}"; E2E="${E2E:-/home/user/src/Arcrun/docker/private-cloud/e2e}"
GW=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
docker rm -f "$CT" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true
rm -rf src/示範知識庫/.arcrun-rag manifest*.json lic.state
docker run -d --name "$CT" -e ARCRUN_TENANT="$TENANT" -p 18090:8080 -p 18091:8081 -v "$VOL:/data" "$IMAGE" >/dev/null
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$CT")" = healthy ] && break; sleep 2; done
node "$E2E/license-tool.mjs" activate --key "$LK" --state lic.state --ui http://127.0.0.1:18090 --seats 1 >/dev/null
PW=$(openssl rand -hex 12)
curl -sS -X POST localhost:18090/__setup/apply -H 'content-type: application/json' -d "{\"admin\":{\"email\":\"builder@demo.local\",\"password\":\"$PW\"},\"ui_url\":\"http://localhost:18090\",\"api_url\":\"http://localhost:18091\",\"embed\":{\"provider\":\"ollama\",\"ollama_url\":\"http://$GW:11434\",\"model\":\"bge-m3\"},\"extract_ai\":{\"recipe\":\"extract_ai_openai_compat\",\"base_url\":\"http://$GW:11434\",\"model\":\"demo-chat\"}}" | head -c 200; echo
curl -sS -X POST localhost:18091/portal/daemon/config -H 'content-type: application/json' -d "{\"email\":\"builder@demo.local\",\"password\":\"$PW\"}" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).config;const F=process.cwd()+"/src/示範知識庫";
   require("fs").writeFileSync("collector-build.json",JSON.stringify({accounts:[{cypher_url:"http://localhost:18091",namespace:c.namespace,api_key:c.namespace,kbdb_key:c.kbdb_key,email:c.email,watch_folders:[F],libraries:{[F]:"demo"}}],manifest:process.cwd()+"/manifest.json",library:"demo",machine_label:"示範知識庫",poll_interval_sec:5},null,2),{mode:0o600})})'
for round in 1 2 3; do
  "$COLLECTOR" direct --config collector-build.json --once > "collector-build-$round.log" 2>&1 || true
  if ! grep -q '"status": "failed"' "collector-build-$round.log"; then echo "萃取第 $round 輪全部成功"; break; fi
  echo "第 $round 輪有檔失敗，再跑一輪"; done
rm -f collector-build.json
