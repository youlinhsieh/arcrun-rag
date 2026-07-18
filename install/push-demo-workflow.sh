#!/usr/bin/env bash
# push-demo-workflow.sh — 把 workflows/*.local.yaml 推上 rag-demo（uncle6）實例
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
NS="${NS:-demo}"
CYPHER="${CYPHER:-https://arcrun-cypher-executor.uncle6-me.workers.dev}"
KBDB="${KBDB:-https://arcrun-kbdb.uncle6-me.workers.dev}"
HTTPREQ="${HTTPREQ:-https://arcrun-http-request.uncle6-me.workers.dev}"
CODE="${CODE:-https://arcrun-code.uncle6-me.workers.dev}"
LLM_MODEL="${LLM_MODEL:-gemma-4-31b-it}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"

if grep -q "__GEMINI_API_KEY__" "$YAML" && [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ $YAML 需要 GEMINI_API_KEY（env 或 repo 根 .env）" >&2; exit 1
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
    "__KBDB_BASE__": os.environ["KBDB"],
    "__HTTP_REQ_URL__": os.environ["HTTPREQ"],
    "__CODE_URL__": os.environ["CODE"],
    "__LLM_MODEL__": os.environ["LLM_MODEL"],
    "__GEMINI_API_KEY__": os.environ.get("GEMINI_API_KEY", ""),
    # graph-neighbors.local.yaml 的 input 佔位（demo bake 版：portal 只傳 node/depth）
    "{{input.kbdb_base}}": os.environ["KBDB"],
    "{{input.template}}": "triplet",
    "{{input.namespace}}": NS,
}
raw = open(yaml_path).read()
for k, v in subs.items():
    raw = raw.replace(k, v)
wf = yaml.safe_load(raw)

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
