#!/usr/bin/env bash
# arcrun-rag 本機一鍵安裝（零 Cloudflare 帳號）
# 裝三件：① Gitea 容器（知識 repo 真相源）② Arcrun 引擎（miniflare 本機）③ collector（watch 資料夾）
# ＋ 包內容物：KBDB templates、rag_ingest / graph_neighbors / rag_wiki_digest workflows。
# 冪等：重跑不炸（容器存在就跳過、node_modules 存在就跳過、template/workflow 覆寫註冊）。
set -uo pipefail

# ── 路徑（repo 內相對定位，不寫死任何機器的絕對路徑）─────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"      # repo 的 install/
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"        # arcrun-rag repo 根

# ── .env（選配：repo 根放 .env 可提供 GEMINI_API_KEY / AUTO_DIGEST 等；不進版控）──
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; . "$REPO_ROOT/.env"; set +a
fi

# ── 參數（環境變數可覆蓋）────────────────────────────────────────────────
ARCRUN_REPO="${ARCRUN_REPO:-$HOME/Arcrun}"        # Arcrun 引擎 checkout 位置
COLLECTOR_SRC="${COLLECTOR_SRC:-$REPO_ROOT/collector}"
WORKFLOWS_SRC="${WORKFLOWS_SRC:-$REPO_ROOT/workflows}"
NS="${NS:-${NAMESPACE:-demo}}"                    # 租戶 namespace（.env 的 NAMESPACE 也認）
GITEA_PORT="${GITEA_PORT:-3300}"
KBDB_PORT=8787; CYPHER_PORT=8788; HTTPREQ_PORT=8789; CODE_PORT=8790
GITEA_ADMIN="${GITEA_ADMIN:-ragadmin}"
GITEA_PASS="${GITEA_PASS:-rag-demo-Pass1}"
GITEA_ORG="${GITEA_ORG:-$NS}"
GITEA_REPO="${GITEA_REPO:-knowledge}"
WATCH_DIR="${WATCH_DIR:-$HOME/arcrun-rag-demo/knowledge-inbox}"
STATE="${RAG_STATE_DIR:-$INSTALL_DIR/state}"; LOGS="${RAG_LOG_DIR:-$INSTALL_DIR/logs}"
GITEA_BASE="http://127.0.0.1:$GITEA_PORT"
KBDB_BASE="http://127.0.0.1:$KBDB_PORT"
CYPHER_BASE="http://127.0.0.1:$CYPHER_PORT"
# ── 自動精耕開關（G11，leo 2026-07-13 拍板預設開）───────────────────────
#   AUTO_DIGEST=true（預設）：每檔 ingest 完自動接 rag_wiki_digest（Gemini 精耕）。
#   ⚠ 每檔一次 Gemini API 呼叫＝token 花費；量大可設 AUTO_DIGEST=false 改手動/批次。
#   需要 GEMINI_API_KEY（.env 或環境變數）；沒 key 自動降級為關（誠實告知，不假裝）。
AUTO_DIGEST="${AUTO_DIGEST:-true}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
mkdir -p "$STATE" "$LOGS"

step()  { printf '\n\033[1;36m━━ %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
wait_http() { # wait_http <url> <名稱> [秒數]
  local url=$1 name=$2 t=${3:-60} i=0
  until curl -sf -o /dev/null "$url"; do
    i=$((i+1)); [ $i -ge $t ] && die "$name 在 ${t}s 內未就緒（${url}）；看 $LOGS"
    sleep 1
  done; ok "$name 就緒（${url}）"
}

# ── 步驟 0：前置檢查 ─────────────────────────────────────────────────────
step "0/6 前置檢查"
command -v node >/dev/null || die "缺 node（要 22+）：brew install node@22 或 nvm install 22"
node -e 'process.exit(parseInt(process.versions.node)>=22?0:1)' || die "node 要 22+（現 $(node --version)）"
command -v pnpm >/dev/null || die "缺 pnpm：npm i -g pnpm"
command -v wrangler >/dev/null || die "缺全域 wrangler：npm i -g wrangler（要 4.98+）"
command -v git >/dev/null || die "缺 git"
docker ps >/dev/null 2>&1 || die "docker 不可用（OrbStack/Docker Desktop 要先開）"
[ -d "$ARCRUN_REPO/kbdb" ] || die "找不到 Arcrun 引擎 checkout（${ARCRUN_REPO}）；git clone https://git.uncle6.me/Leo/Arcrun.git"
command -v markitdown >/dev/null && ok "markitdown 有（docx/pptx/pdf 轉檔可用）" || echo "⚠ markitdown 沒裝（docx 轉檔不可用；pip install 'markitdown[docx,pptx,pdf]'）"
if [ "$AUTO_DIGEST" = "true" ] && [ -z "$GEMINI_API_KEY" ]; then
  AUTO_DIGEST=false
  echo "⚠ AUTO_DIGEST 預設開但沒有 GEMINI_API_KEY → 自動精耕本次關閉（repo 根 .env 補 GEMINI_API_KEY=<key> 後重跑即開）"
fi
[ "$AUTO_DIGEST" = "true" ] && ok "自動精耕：開（每檔 ingest 完自動跑 Gemini；每檔一次 API 呼叫）" || echo "ℹ 自動精耕：關（精耕改手動觸發，見完成頁 5)）"
ok "前置檢查通過"

# ── 步驟 1：Gitea 本機容器 ────────────────────────────────────────────────
step "1/6 Gitea 容器（知識 repo 真相源）"
if docker inspect arcrun-rag-gitea >/dev/null 2>&1; then
  docker start arcrun-rag-gitea >/dev/null 2>&1 || true
  ok "容器 arcrun-rag-gitea 已存在（重用）"
else
  docker run -d --name arcrun-rag-gitea \
    -p "$GITEA_PORT:3000" \
    -v "$STATE/gitea:/data" \
    -e GITEA__security__INSTALL_LOCK=true \
    -e GITEA__server__ROOT_URL="$GITEA_BASE/" \
    -e GITEA__server__HTTP_PORT=3000 \
    -e GITEA__webhook__ALLOWED_HOST_LIST='*' \
    -e GITEA__database__DB_TYPE=sqlite3 \
    gitea/gitea:1.24 >/dev/null || die "Gitea 容器起不來"
  ok "容器已起（gitea/gitea:1.24，SQLite，port ${GITEA_PORT}）"
fi
wait_http "$GITEA_BASE/api/v1/version" "Gitea" 90

# admin（冪等：已存在的錯誤放行）
docker exec -u git arcrun-rag-gitea gitea admin user create \
  --admin --username "$GITEA_ADMIN" --password "$GITEA_PASS" \
  --email "$GITEA_ADMIN@local" --must-change-password=false >/dev/null 2>&1 \
  && ok "admin $GITEA_ADMIN 建立" || ok "admin $GITEA_ADMIN 已存在（跳過）"

# token（冪等：同名先刪再建；token 只在本機 state 檔留存）
TOKEN_FILE="$STATE/gitea-token"
if [ ! -s "$TOKEN_FILE" ]; then
  curl -sf -X DELETE -u "$GITEA_ADMIN:$GITEA_PASS" \
    "$GITEA_BASE/api/v1/users/$GITEA_ADMIN/tokens/rag-installer" >/dev/null 2>&1 || true
  GITEA_TOKEN=$(curl -sf -X POST -u "$GITEA_ADMIN:$GITEA_PASS" \
    -H 'Content-Type: application/json' \
    -d '{"name":"rag-installer","scopes":["write:repository","write:organization","write:user"]}' \
    "$GITEA_BASE/api/v1/users/$GITEA_ADMIN/tokens" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).sha1||"")}catch(e){}})')
  [ -n "$GITEA_TOKEN" ] || die "Gitea token 建立失敗"
  printf '%s' "$GITEA_TOKEN" > "$TOKEN_FILE"
fi
GITEA_TOKEN=$(cat "$TOKEN_FILE"); ok "API token 就緒"

# org + repo（冪等）
curl -sf -H "Authorization: token $GITEA_TOKEN" "$GITEA_BASE/api/v1/orgs/$GITEA_ORG" >/dev/null 2>&1 \
  || curl -sf -X POST -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
       -d "{\"username\":\"$GITEA_ORG\"}" "$GITEA_BASE/api/v1/orgs" >/dev/null || die "org 建立失敗"
curl -sf -H "Authorization: token $GITEA_TOKEN" "$GITEA_BASE/api/v1/repos/$GITEA_ORG/$GITEA_REPO" >/dev/null 2>&1 \
  || curl -sf -X POST -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
       -d "{\"name\":\"$GITEA_REPO\",\"private\":true,\"auto_init\":true,\"default_branch\":\"main\"}" \
       "$GITEA_BASE/api/v1/orgs/$GITEA_ORG/repos" >/dev/null || die "repo 建立失敗"
ok "org=$GITEA_ORG repo=$GITEA_REPO 就緒（private）"

# push webhook → cypher rag_ingest（冪等：先清同目標舊 hook）
HOOK_URL="http://host.docker.internal:$CYPHER_PORT/webhooks/named/$NS/rag_ingest/trigger"
EXISTING=$(curl -sf -H "Authorization: token $GITEA_TOKEN" "$GITEA_BASE/api/v1/repos/$GITEA_ORG/$GITEA_REPO/hooks" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s).filter(x=>(x.config&&x.config.url||"").includes("rag_ingest"));process.stdout.write(h.map(x=>x.id).join(" "))}catch(e){}})')
for id in $EXISTING; do curl -sf -X DELETE -H "Authorization: token $GITEA_TOKEN" \
  "$GITEA_BASE/api/v1/repos/$GITEA_ORG/$GITEA_REPO/hooks/$id" >/dev/null || true; done
curl -sf -X POST -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"gitea\",\"active\":true,\"events\":[\"push\"],\"config\":{\"url\":\"$HOOK_URL\",\"content_type\":\"json\"}}" \
  "$GITEA_BASE/api/v1/repos/$GITEA_ORG/$GITEA_REPO/hooks" >/dev/null || die "webhook 建立失敗"
ok "push webhook → $HOOK_URL"

# ── 步驟 2：Arcrun 引擎（4 worker，miniflare）────────────────────────────
step "2/6 Arcrun 引擎（kbdb / cypher / http_request / code）"
cd "$ARCRUN_REPO"
[ -d kbdb/node_modules ] || (cd kbdb && npm ci >/dev/null 2>&1) || die "kbdb 依賴安裝失敗"
[ -d cypher-executor/node_modules ] || (cd cypher-executor && pnpm install --frozen-lockfile >/dev/null 2>&1) || die "cypher 依賴安裝失敗（要用 pnpm，見手冊）"
[ -d .component-builds/http_request/node_modules ] || (cd .component-builds/http_request && CI=true pnpm install --frozen-lockfile >/dev/null 2>&1) || die "http_request 依賴安裝失敗"
[ -d registry/components/code/node_modules ] || (cd registry/components/code && npm ci >/dev/null 2>&1) || die "code 依賴安裝失敗"
ok "依賴就緒"

(cd kbdb && npx wrangler d1 migrations apply DB --local --persist-to "$STATE/kbdb" >/dev/null 2>&1) || die "kbdb migrations 失敗"
ok "kbdb schema（migrations --local）"

start_bg() { # start_bg <名稱> <目錄> <指令...>
  local name=$1 dir=$2; shift 2
  local pidf="$STATE/$name.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then ok "$name 已在跑（pid $(cat "$pidf")）"; return; fi
  (cd "$dir" && nohup "$@" > "$LOGS/$name.log" 2>&1 & echo $! > "$pidf")
  ok "$name 啟動中（log: $LOGS/$name.log）"
}
start_bg kbdb "$ARCRUN_REPO/kbdb" npx wrangler dev --port $KBDB_PORT --inspector-port 9331 --persist-to "$STATE/kbdb"
start_bg http-request "$ARCRUN_REPO/.component-builds/http_request" npx wrangler dev --port $HTTPREQ_PORT --inspector-port 9332 --persist-to "$STATE/http-request"
start_bg code "$ARCRUN_REPO/registry/components/code" npx wrangler dev --port $CODE_PORT --inspector-port 9333 --persist-to "$STATE/code"
# cypher：全域 wrangler（lockfile 舊 workerd 會 crash，手冊 §5）＋ --var 保險（誤推導 URL 打向不存在域名）
# CONSOLE_PROFILE:rag ＝ 企業產品樣 console（搜尋頁落地，藏駕駛艙/分流台/憑證管理；rag-wave1 design §2）
# CONSOLE_BRAND:"Arcrun RAG" ＝ 產品名（leo 拍板 demo 用它）
start_bg cypher "$ARCRUN_REPO/cypher-executor" wrangler dev --port $CYPHER_PORT --test-scheduled --inspector-port 9334 \
  --persist-to "$STATE/cypher" \
  --var WORKER_SUBDOMAIN:spike-local-offline \
  --var KBDB_BASE_URL:"$KBDB_BASE" \
  --var GITEA_BASE_URL: \
  --var CONSOLE_TENANT:"$NS" \
  --var CONSOLE_PROFILE:rag \
  --var CONSOLE_BRAND:"Arcrun RAG"
wait_http "$KBDB_BASE/health" "kbdb"
wait_http "http://127.0.0.1:$HTTPREQ_PORT/" "http_request 零件"
wait_http "http://127.0.0.1:$CODE_PORT/" "code 零件"
wait_http "$CYPHER_BASE/health" "cypher-executor" 90
curl -sf -X POST "$CYPHER_BASE/init/seed" >/dev/null && ok "recipe seed（/init/seed）" || die "seed 失敗"

# ── 步驟 3：KBDB templates（與 leo 實例同構的 triplet/entity schema）────────
step "3/6 KBDB templates"
node "$INSTALL_DIR/ensure-templates.mjs" "$KBDB_BASE" || die "templates 建立失敗"

# ── 步驟 4：workflows 註冊（acr push 指本機）────────────────────────────────
step "4/6 workflows（rag_ingest / graph_neighbors / rag_wiki_digest）"
WFLOCAL="$STATE/workflows-local"; mkdir -p "$WFLOCAL"
# graph-neighbors 用 .local 版（零件 URL 參數化；repo 的 graph-neighbors.yaml 是 canonical 零件名版）
for src in rag-ingest.yaml graph-neighbors.local.yaml rag-wiki-digest.yaml; do
  wf="${src%.local.yaml}"; wf="${wf%.yaml}"
  sed -e "s|__NAMESPACE__|$NS|g" \
      -e "s|__KBDB_BASE__|$KBDB_BASE|g" \
      -e "s|__GITEA_BASE__|$GITEA_BASE|g" \
      -e "s|__GITEA_TOKEN__|$GITEA_TOKEN|g" \
      -e "s|__GEMINI_API_KEY__|$GEMINI_API_KEY|g" \
      -e "s|__HTTP_REQ_URL__|http://127.0.0.1:$HTTPREQ_PORT|g" \
      -e "s|__CODE_URL__|http://127.0.0.1:$CODE_PORT|g" \
      "$WORKFLOWS_SRC/$src" > "$WFLOCAL/$wf.yaml"
  # AUTO_DIGEST=false → 剝掉 rag-ingest 的自動接鏈段（G11 開關；標記行見 rag-ingest.yaml）
  if [ "$wf" = "rag-ingest" ] && [ "$AUTO_DIGEST" != "true" ]; then
    sed -e '/# AUTO_DIGEST BEGIN/,/# AUTO_DIGEST END/d' -e '/# AUTO_DIGEST FLOW/d' \
      "$WFLOCAL/$wf.yaml" > "$WFLOCAL/$wf.yaml.tmp" && mv "$WFLOCAL/$wf.yaml.tmp" "$WFLOCAL/$wf.yaml"
  fi
  (cd "$WFLOCAL" && ARCRUN_MODE=self-hosted ARCRUN_NAMESPACE="$NS" \
    ARCRUN_CYPHER_EXECUTOR_URL="$CYPHER_BASE" \
    node "$ARCRUN_REPO/cli/dist/index.js" push "$wf.yaml" >> "$LOGS/acr-push.log" 2>&1) \
    && ok "workflow $wf 註冊" || die "workflow $wf push 失敗（$LOGS/acr-push.log）"
done

# ── 步驟 5：collector（watch 知識資料夾 → Gitea）────────────────────────────
step "5/6 collector"
if [ ! -d "$STATE/collector" ]; then
  mkdir -p "$STATE/collector"
  cp "$COLLECTOR_SRC"/*.js "$COLLECTOR_SRC"/package.json "$COLLECTOR_SRC"/package-lock.json "$STATE/collector/" || die "collector 原始碼複製失敗"
fi
[ -d "$STATE/collector/node_modules" ] || (cd "$STATE/collector" && npm ci >/dev/null 2>&1) || die "collector 依賴安裝失敗"
mkdir -p "$WATCH_DIR"
if [ ! -d "$STATE/knowledge-repo/.git" ]; then
  git clone "http://$GITEA_ADMIN:$GITEA_TOKEN@127.0.0.1:$GITEA_PORT/$GITEA_ORG/$GITEA_REPO.git" \
    "$STATE/knowledge-repo" >/dev/null 2>&1 || die "knowledge repo clone 失敗"
  (cd "$STATE/knowledge-repo" && git config user.name collector && git config user.email collector@localhost && git lfs install --local >/dev/null 2>&1 || true)
fi
COLL_PIDF="$STATE/collector.pid"
if [ -f "$COLL_PIDF" ] && kill -0 "$(cat "$COLL_PIDF")" 2>/dev/null; then
  ok "collector 已在跑（pid $(cat "$COLL_PIDF")）"
else
  (cd "$STATE/collector" && WATCH_DIR="$WATCH_DIR" TARGET_REPO_DIR="$STATE/knowledge-repo" \
    DEBOUNCE_MS=3000 nohup node index.js > "$LOGS/collector.log" 2>&1 & echo $! > "$COLL_PIDF")
  ok "collector watch 中：$WATCH_DIR"
fi

# ── 步驟 6：完成頁 ───────────────────────────────────────────────────────
step "6/6 完成"
cat <<EOF

✅ 裝完了。你的知識庫已經在動：

  1. 把 .md（有 markitdown 也可 .docx/.pptx/.pdf）丟進：
       $WATCH_DIR
  2. 約 5 秒後 collector 自動 commit → push → Gitea webhook → ingest 進庫。
  3. 打開管理 Console（首次會引導設 email/密碼）：
       $CYPHER_BASE/console
     「總庫搜尋」頁直接搜你丟進去的內容。
  4. API 直查：
     keyword : curl "$KBDB_BASE/entries/search?q=<關鍵字>&owner_id=$NS"
     graph   : curl "$CYPHER_BASE/q/$NS/graph_neighbors?node=knowledge-base&depth=2&template=triplet&namespace=$NS&kbdb_base=$KBDB_BASE"
     semantic: 加 &mode=semantic（本機無 Vectorize → 誠實降級 keyword＋capability_hint）
  5. LLM 精耕（Gemini）：
     自動接鏈（AUTO_DIGEST）目前＝$AUTO_DIGEST
       開＝每檔 ingest 完自動長出 wiki-<頁名> 精耕頁（每檔一次 Gemini API 呼叫）。
       關/手動觸發：
     curl -X POST "$CYPHER_BASE/webhooks/named/rag_wiki_digest/query" \\
       -H "X-Arcrun-API-Key: $NS" -H 'Content-Type: application/json' \\
       -d '{"page_name":"<文件頁名>","gemini_key":"<你的key>"}'
  6. 刪檔＝從庫下架：從資料夾刪掉檔案 → 對應 entries/triplet 標 deprecated
     （append-only 不物理刪；graph 查詢自動略過 deprecated）。

  Gitea 界面：${GITEA_BASE}（$GITEA_ADMIN / 密碼見安裝參數）
  全部日誌：$LOGS/
  一鍵全拆：$INSTALL_DIR/teardown.sh
EOF
