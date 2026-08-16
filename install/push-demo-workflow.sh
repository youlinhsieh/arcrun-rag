#!/usr/bin/env bash
# push-demo-workflow.sh — 把 workflows/*.local.yaml 推上**舊版實例**（走 /cypher/search 編圖）
# 🔴 適用範圍：只適用舊版（無 bundle_version 的實例）。新版實例走安裝器鏈，見下方 NS 段註解。
# 🔴 2026-08-08：當初的 rag-demo（uncle6）示範站**已退場**；本腳本禁止指向 uncle6
#    （官方件帳號，不是測試場）——下面有機械閘會擋。判準見 repo CLAUDE.md「範例在哪、測試在哪」。
# 用法：GEMINI_API_KEY=… bash install/push-demo-workflow.sh workflows/rag-chat.local.yaml
#      （repo 根 .env 有 GEMINI_API_KEY 也認；graph-neighbors 等不含 key 的 yaml 不需要）
#
# 機制＝API 復刻 acr push（agent-memory §7）：sed 佔位值 → POST /cypher/search 編圖
#   → 照 cli push.ts 邏輯把 config 合進節點 → POST /webhooks/named。
# ⚠️ G10 同款妥協：__GEMINI_API_KEY__ 直接嵌進 workflow 定義（存 WEBHOOKS KV）；
#   輪換 key 時要重跑本腳本。生產正解＝{{credential.*}}（等 CF_SECRETS_API_TOKEN 機制）。
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then set -a; . "$REPO_ROOT/.env"; set +a; fi

YAML="${1:?用法: push-demo-workflow.sh <workflow yaml 路徑>}"
# 🔴 2026-08-05 t195：這裡原本預設 uncle6（NS=demo）。**uncle6 是官方件不是實例**
#   （rag.arcrun.dev／install.arcrun.dev／零件 bundles，見 agent-memory §9 CF 帳號地圖），
#   預設值會讓「忘了帶 env」靜靜打到官方帳號。實撞：總管推 youlin 失敗後把 NS 改回 demo
#   打 uncle6，得到「成功」的假對照組，反過來誤判新版實例壞掉、白繞一輪。
#   ⇒ 拿掉預設值：沒明講要打哪就報錯，不猜。（用途不變，仍是這支 demo 推法）
#   ⚠️ 新版實例（bundle_version 1.4.11+）的 workflow 由**安裝器**帶上去：
#      workflows/*.local.yaml → installer/scripts/compile-workflows.mjs → workflows.json
#      要更新新版實例走那條鏈，不是這支（這支走 /cypher/search，新版會回 not_found）。
#   🔴 InkStoneCo#44 comment 2749（2026-08-16）：新版實例事後要「補推」單一 workflow 的
#      修法，用 install/push-workflow-update.sh（讀 installer/src/workflows.json 裡已編譯
#      好的 graph，跳過 /cypher/search 的節點名目錄比對，不會撞到「缺零件」）。
NS="${NS:?必須指定 NS（實例 namespace，如 yuga3bse）——不再預設 demo/uncle6}"
CYPHER="${CYPHER:?必須指定 CYPHER（該實例的 cypher-executor URL）}"
KBDB="${KBDB:?必須指定 KBDB}"
HTTPREQ="${HTTPREQ:?必須指定 HTTPREQ}"
CODE="${CODE:?必須指定 CODE}"
# 機械閘（2026-08-08）：擋掉指向 uncle6（官方件／已退場示範站）的目標。
# 「不再預設」還不夠——有人手動把 env 填成 uncle6 一樣會打過去，所以這裡直接拒絕。
case "$CYPHER|$KBDB|$HTTPREQ|$CODE" in
  *rag-demo.arcrun.dev*|*uncle6-me.workers.dev*)  # sanitize-ok
    echo "❌ 目標指向 uncle6（官方件／已退場的示範站）——一律不碰。" >&2
    echo "   測試請用 youlin 實例（見 CLAUDE.md「範例在哪、測試在哪」）。" >&2
    exit 1 ;;
esac
LLM_MODEL="${LLM_MODEL:-gemma-4-31b-it}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
# ⚠ GITEA_* 在 ingest 路徑已 deprecated（SDD ingest-hash-trigger task 4：rag-ingest*
#   已改 collector→R2 鏈，不再吃 Gitea）。保留只為 rag-extract*/其他仍讀 Gitea 的 workflow；
#   全部 de-Gitea 後（Part B）連同本段刪除。
GITEA_BASE="${GITEA_BASE:-https://git.uncle6.me}"
GITEA_TOKEN="${GITEA_TOKEN:-}"
# R2 原稿讀取（rag-ingest* v3 用；collector 上傳的 content-addressed bucket）
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
R2_BUCKET="${R2_BUCKET:-arcrun-rag-raw-demo}"
CF_R2_TOKEN="${CF_R2_TOKEN:-${CF_API_TOKEN:-}}"   # 沒獨立唯讀 token 時退回 CF_API_TOKEN
DOCS_PREFIX="${DOCS_PREFIX:-docs/}"
CARDS_DIR="${CARDS_DIR:-system-dev/wiki/cards}"
INDEX_PATH="${INDEX_PATH:-system-dev/wiki/00-INDEX.md}"
LIBRARY="${LIBRARY:-kb}"             # 藏書地圖庫名（library-map M3；map/recompute 歸庫鍵）
NAME_OVERRIDE="${NAME_OVERRIDE:-}"   # 測試部署用：覆蓋 workflow 名（如 rag_extract_t）
# bash 內設的預設值要進 python heredoc 的 os.environ，必須 export
export NS CYPHER KBDB HTTPREQ CODE LLM_MODEL GEMINI_API_KEY GITEA_BASE GITEA_TOKEN DOCS_PREFIX CARDS_DIR INDEX_PATH LIBRARY NAME_OVERRIDE CF_ACCOUNT_ID R2_BUCKET CF_R2_TOKEN

if grep -q "__GEMINI_API_KEY__" "$YAML" && [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ $YAML 需要 GEMINI_API_KEY（env 或 repo 根 .env）" >&2; exit 1
fi
if grep -q "__GITEA_TOKEN__" "$YAML" && [ -z "$GITEA_TOKEN" ]; then
  echo "❌ $YAML 需要 GITEA_TOKEN（能寫知識庫 repo contents 的 token）" >&2; exit 1
fi
if grep -q "__CF_R2_TOKEN__" "$YAML" && { [ -z "$CF_R2_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; }; then
  echo "❌ $YAML 需要 CF_ACCOUNT_ID＋CF_R2_TOKEN（或 CF_API_TOKEN；讀 R2 原稿 bucket 用）" >&2; exit 1
fi

python3 - "$YAML" <<'PYEOF'
import json, os, sys, urllib.request
try:
    import yaml
except ImportError:
    sys.exit("❌ 需要 python3-yaml（pip install pyyaml）")

yaml_path = sys.argv[1]
NS = os.environ.get("NS", "demo")
CYPHER = os.environ["CYPHER"]
subs = {
    "__NAMESPACE__": NS,
    "__CYPHER_BASE__": CYPHER,
    "__KBDB_BASE__": os.environ["KBDB"],
    "__HTTP_REQ_URL__": os.environ["HTTPREQ"],
    "__CODE_URL__": os.environ["CODE"],
    "__LLM_MODEL__": os.environ["LLM_MODEL"],
    "__GEMINI_API_KEY__": os.environ.get("GEMINI_API_KEY", ""),
    "__GITEA_BASE__": os.environ.get("GITEA_BASE", ""),
    "__GITEA_TOKEN__": os.environ.get("GITEA_TOKEN", ""),
    "__DOCS_PREFIX__": os.environ.get("DOCS_PREFIX", "docs/"),
    "__CARDS_DIR__": os.environ.get("CARDS_DIR", "system-dev/wiki/cards"),
    "__CARDS_PREFIX__": os.environ.get("CARDS_DIR", "system-dev/wiki/cards") + "/",
    "__INDEX_PATH__": os.environ.get("INDEX_PATH", "system-dev/wiki/00-INDEX.md"),
    "__LIBRARY__": os.environ.get("LIBRARY", "kb"),
    "__CF_ACCOUNT_ID__": os.environ.get("CF_ACCOUNT_ID", ""),
    "__R2_BUCKET__": os.environ.get("R2_BUCKET", ""),
    "__CF_R2_TOKEN__": os.environ.get("CF_R2_TOKEN", ""),
    # graph-neighbors.local.yaml 的 input 佔位（demo bake 版：portal 只傳 node/depth）
    "{{input.kbdb_base}}": os.environ["KBDB"],
    "{{input.template}}": "triplet",
    "{{input.namespace}}": NS,
}
raw = open(yaml_path).read()
for k, v in subs.items():
    raw = raw.replace(k, v)
wf = yaml.safe_load(raw)
if os.environ.get("NAME_OVERRIDE"):
    wf["name"] = os.environ["NAME_OVERRIDE"]

def api(path, body):
    req = urllib.request.Request(
        CYPHER + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Arcrun-API-Key": NS,
                 "User-Agent": "curl/8.5.0"})  # WAF 對 python UA 403（agent-memory 工具坑）
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

compiled = api("/cypher/search", {"triplets": wf["flow"]})
if compiled.get("missing"):
    sys.exit(f"❌ 缺零件: {compiled['missing']}")
g = compiled["cypher"]
cfg = wf.get("config") or {}
nodes = []
for node in g["nodes"]:
    c = cfg.get(node["id"])
    if not c:
        nodes.append(node); continue
    params = {k: v for k, v in c.items() if k != "component"}
    n = dict(node)
    if isinstance(c.get("component"), str):
        n["componentId"] = c["component"]
    if params:
        n["data"] = {**(node.get("data") or {}), **params}
    nodes.append(n)
res = api("/webhooks/named", {
    "name": wf["name"],
    "graph": {"id": wf["name"], "name": wf["name"], "nodes": nodes, "edges": g["edges"]},
    "config": cfg,
    "description": wf.get("description", ""),
})
print(f"✅ \"{res.get('name')}\" 已部署 → {res.get('webhook_url')}")
PYEOF
