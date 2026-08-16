#!/usr/bin/env bash
# push-workflow-update.sh — 把 installer/src/workflows.json 裡**已編譯好的 graph**
# 增量推上一台**既有的新版實例**（bundle_version 1.4.11+，工作流由安裝器鏈帶上去的那批）。
#
# 🔴 這支解的洞：`push-demo-workflow.sh` 只適用「舊版」實例——它走
#   POST /cypher/search（不帶 mode）對節點名做目錄比對，而 workflows/*.local.yaml 裡
#   `prep`／`parse_card`／`pick_dead_triplets` 這種自訂 URL 元件的節點名根本不在目錄裡，
#   一定回「缺零件」exit 1。新版實例本來就不吃 push-demo-workflow.sh（它自己的文件
#   也這樣寫），但**新版實例事後要「補推」單一 workflow 的修法**——目前沒有工具，
#   只能整套重跑安裝器 `/api/finish`（且 `installer/src/index.js` 的 pushWorkflow()
#   同款也是不帶 mode 呼叫 /cypher/search，一樣會撞上同一顆缺零件雷；沒驗證過對這兩支
#   workflow 有效）。
#
# 手法＝逐字對齊真正跑得動、線上驗證過的那條路——
# `installer/oauth-prototype/worker.js` 的 pushWorkflowTo()：
#   graph 已在**打包期**由 compile-workflows.mjs 用引擎自己的 parser（mode:'compile'）編好，
#   直接沿用該 graph（完全不呼叫 /cypher/search）→ 用 config 把 componentId／data 合進節點
#   → POST /webhooks/named。跳過「對節點名做目錄比對」那條會誤判的路。
#
# 用法：
#   NS=yuga3bse \
#   CYPHER=https://arcrun-cypher-executor.<subdomain>.workers.dev \
#   KBDB=https://arcrun-kbdb.<subdomain>.workers.dev \
#   HTTPREQ=https://arcrun-http-request.<subdomain>.workers.dev \
#   CODE=https://arcrun-code.<subdomain>.workers.dev \
#   bash install/push-workflow-update.sh rag_ingest_card rag_takedown_direct
#   （不給 workflow 名 = 推 installer/src/workflows.json 裡全部）
#
# 動手前務必 `acr whoami`／`arcrun_whoami` 核對 CF 帳號／namespace／cypher 主機三項全對
# （見 InkStoneCo#44）；本腳本沿用 push-demo-workflow.sh 同款機械閘，禁止指向 uncle6。
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
WORKFLOWS_JSON="${WORKFLOWS_JSON:-$REPO_ROOT/installer/src/workflows.json}"

NS="${NS:?必須指定 NS（實例 namespace，如 yuga3bse）}"
CYPHER="${CYPHER:?必須指定 CYPHER（該實例的 cypher-executor URL）}"
KBDB="${KBDB:?必須指定 KBDB}"
HTTPREQ="${HTTPREQ:?必須指定 HTTPREQ}"
CODE="${CODE:?必須指定 CODE}"
CARDS_DIR="${CARDS_DIR:-system-dev/wiki/cards}"

# 機械閘（沿用 push-demo-workflow.sh 2026-08-08 那道）：擋掉指向 uncle6 的目標。
case "$CYPHER|$KBDB|$HTTPREQ|$CODE" in
  *rag-demo.arcrun.dev*|*uncle6-me.workers.dev*)  # sanitize-ok
    echo "❌ 目標指向 uncle6（官方件／已退場的示範站）——一律不碰。" >&2
    echo "   測試請用 youlin 實例（見 CLAUDE.md「範例在哪、測試在哪」）。" >&2
    exit 1 ;;
esac

export NS CYPHER KBDB HTTPREQ CODE CARDS_DIR WORKFLOWS_JSON

python3 - "$@" <<'PYEOF'
import json, os, sys, urllib.request

NS = os.environ["NS"]
CYPHER = os.environ["CYPHER"]
CARDS_DIR = os.environ["CARDS_DIR"]
SUBS = {
    "__NAMESPACE__": NS,
    "__CYPHER_BASE__": CYPHER,
    "__KBDB_BASE__": os.environ["KBDB"],
    "__HTTP_REQ_URL__": os.environ["HTTPREQ"],
    "__CODE_URL__": os.environ["CODE"],
    "__CARDS_DIR__": CARDS_DIR,
    "__CARDS_PREFIX__": CARDS_DIR + "/",
}

def apply_subs(obj, subs):
    s = json.dumps(obj)
    for k, v in subs.items():
        s = s.replace(k, v)
    return json.loads(s)

def api(path, body):
    req = urllib.request.Request(
        CYPHER + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Arcrun-API-Key": NS,
                 "User-Agent": "curl/8.5.0"},  # WAF 對 python UA 403（agent-memory 工具坑）
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

wanted = set(sys.argv[1:]) or None
wf_path = os.environ["WORKFLOWS_JSON"]
all_wf = json.load(open(wf_path))
targets = [w for w in all_wf if wanted is None or w["name"] in wanted]
if wanted:
    missing = wanted - {w["name"] for w in targets}
    if missing:
        sys.exit(f"❌ workflows.json 裡沒有這些名字: {sorted(missing)}")

# 🔴 實撞教訓（InkStoneCo#44 comment 2749 驗收時）：這支預設從「腳本自己所在路徑」
# 推出 WORKFLOWS_JSON（見上面 REPO_ROOT）。若在別的 worktree／別的 checkout 底下
# 執行這支腳本，會誤讀那個 worktree 自己的 workflows.json（可能還沒帶到要推的修法）
# ——當下不會有任何錯誤訊息，「部署成功」照樣印出來，只是內容是舊的。
# 印出實際讀取的檔案路徑＋每支 workflow 的 config 指紋，逼操作者推送前肉眼核對來源。
import hashlib
print(f"📄 讀取 workflows.json：{wf_path}", file=sys.stderr)
for wf in targets:
    h = hashlib.sha256(json.dumps(wf.get("config") or {}, sort_keys=True).encode()).hexdigest()[:12]
    print(f"   · {wf['name']}  config sha256={h}", file=sys.stderr)

exit_code = 0
for wf in targets:
    name = wf["name"]
    g = wf.get("graph")
    if not g or not g.get("nodes"):
        print(f"❌ {name} 沒有預編圖（workflows.json 沒 graph 欄位），拒絕推送——先跑 compile-workflows.mjs 重編。", file=sys.stderr)
        exit_code = 1
        continue
    g = apply_subs(g, SUBS)
    cfg = apply_subs(wf.get("config") or {}, SUBS)
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
    body = {
        "name": name,
        "graph": {"id": name, "name": name, "nodes": nodes, "edges": g.get("edges", [])},
        "config": cfg,
        "description": wf.get("description", ""),
    }
    try:
        res = api("/webhooks/named", body)
        print(f"✅ \"{res.get('name')}\" 已部署 → {res.get('webhook_url')}")
    except Exception as e:
        print(f"❌ {name} 推送失敗: {e}", file=sys.stderr)
        exit_code = 1

sys.exit(exit_code)
PYEOF
