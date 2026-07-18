#!/usr/bin/env bash
# redeploy-demo-cypher.sh — 重部 rag-demo（uncle6）的 arcrun-cypher-executor
#
# 用法：CLOUDFLARE_API_TOKEN=<uncle6-scoped token> bash install/redeploy-demo-cypher.sh [Arcrun repo 路徑]
#
# 忠實複刻原則（deploy-record §3/§9 的教訓自動化）：
#   1. 先 CF API dump 現役 settings → KV id / vars 照抄（stock toml 的 KV id 是官方那批，
#      直接部會把 demo 的 workflow/credential 換回官方舊庫；vars 若只帶品牌三件會弄丟
#      07-17 後加的 PORTAL_UPLOAD_* → 上傳頁 404）。
#   2. 移除 [ai] binding（現役無）；MULTI_TENANT=false；CF_ACCOUNT_ID=uncle6。
#   3. 本次新增：PORTAL_SOURCE_WEB_BASE（來源回溯超連結，Arcrun PR#62）。
#   4. 暫存注入 toml 部署完即還原，Arcrun repo tree 保持乾淨。
# secrets（GITEA_TOKEN/PORTAL_UPLOAD_TOKEN/MCP_*…）不受 deploy 影響，自動保留。
set -euo pipefail

ACCOUNT_ID="58309bb90fd93ad6d0fe0aae99170e9d"   # uncle6
SCRIPT_NAME="arcrun-cypher-executor"
ARCRUN_REPO="${1:-${ARCRUN_REPO:-$HOME/Arcrun}}"
SOURCE_WEB_BASE="${SOURCE_WEB_BASE:-https://git.uncle6.me/Leo/arcrun-rag-demo-knowledge/src/branch/main}"

: "${CLOUDFLARE_API_TOKEN:?需要 uncle6-scoped 的 CLOUDFLARE_API_TOKEN}"
[ -d "$ARCRUN_REPO/cypher-executor" ] || { echo "❌ 找不到 Arcrun repo：$ARCRUN_REPO"; exit 1; }

echo "== 1/4 dump 現役 settings（KV id / vars 照抄源）=="
SETTINGS_JSON="$(mktemp)"
curl -sf "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/settings" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" > "$SETTINGS_JSON"

echo "== 2/4 產生注入 toml =="
CYPHER_DIR="$ARCRUN_REPO/cypher-executor"
python3 - "$SETTINGS_JSON" "$CYPHER_DIR/wrangler.toml" "$SOURCE_WEB_BASE" <<'PYEOF' > "$CYPHER_DIR/wrangler.toml.demo"
import json, re, sys

settings = json.load(open(sys.argv[1]))["result"]
stock = open(sys.argv[2]).read()
source_web_base = sys.argv[3]

live_kv = {}
live_vars = {}
for b in settings.get("bindings", []):
    if b.get("type") == "kv_namespace":
        live_kv[b["name"]] = b["namespace_id"]
    elif b.get("type") == "plain_text":
        live_vars[b["name"]] = b["text"]

# 安全閘：現役 WEBHOOKS 必須是 demo 專屬 namespace（deploy-record §3 表），不是就中止。
assert live_kv.get("WEBHOOKS", "").startswith("a259bfcf"), f"WEBHOOKS id 不符 demo 現役：{live_kv.get('WEBHOOKS')}"

out = stock
# ① KV id 換現役
def swap_kv(m):
    binding = m.group(1)
    live = live_kv.get(binding)
    return f'[[kv_namespaces]]\nbinding = "{binding}"\nid = "{live}"' if live else m.group(0)
out = re.sub(r'\[\[kv_namespaces\]\]\s*\nbinding = "(\w+)"\s*\nid = "[0-9a-f]+"', swap_kv, out)

# ② 移除 [ai] 區塊（現役無 AI binding）
out = re.sub(r'\n\[ai\]\nbinding = "AI"\n', '\n', out)

# ③ [vars] 整段重寫＝現役 vars 照抄 ＋ 本次新增/覆寫
live_vars["CF_ACCOUNT_ID"] = "58309bb90fd93ad6d0fe0aae99170e9d"
live_vars["MULTI_TENANT"] = "false"
live_vars["PORTAL_SOURCE_WEB_BASE"] = source_web_base
vars_block = "[vars]\n" + "\n".join(
    f'{k} = {json.dumps(v)}' for k, v in sorted(live_vars.items())
)
out = re.sub(r'\[vars\][\s\S]*?(?=\n\[\[routes\]\])', vars_block + "\n\n", out)

sys.stdout.write(out)
print("# demo 注入版（redeploy-demo-cypher.sh 產生；部署完即刪）", file=sys.stderr)
PYEOF

echo "-- 注入結果 vars/KV 摘要 --"
grep -E '^(id|binding|[A-Z_]+ =)' "$CYPHER_DIR/wrangler.toml.demo" | head -40

echo "== 3/4 部署（暫存 toml 就地換入，完畢還原）=="
cd "$CYPHER_DIR"
[ -d node_modules ] || pnpm install --silent
mv wrangler.toml wrangler.toml.stock
cp wrangler.toml.demo wrangler.toml
trap 'mv -f wrangler.toml.stock wrangler.toml; rm -f wrangler.toml.demo' EXIT
# 環境可能殘留 CLOUDFLARE_ACCOUNT_ID=leo21c（arcrun-config-scope-gap 家族雷）——強制鎖 uncle6
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
npx wrangler deploy

echo "== 4/4 煙測 =="
sleep 3
curl -s -o /dev/null -w "portal 殼: %{http_code}\n" "https://rag-demo.arcrun.dev/portal"
echo "✅ 完成。接著到 portal 用圖譜搜 rag 應看到節點名（非 [object Object]）、卡片詳頁來源回溯應為超連結。"
