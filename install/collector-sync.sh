#!/bin/bash
# collector sync 包裝：掃描→R2 上傳→觸發 rag_ingest_fs→成功回寫 manifest。
# 用法：CF_ACCOUNT_ID=… CF_API_TOKEN=… R2_BUCKET=… ARCRUN_TRIGGER_URL=… \
#         bash install/collector-sync.sh <知識資料夾> [manifest路徑]
#      （四個值放 repo 根 .env 也認；key 不過指令行。之後掛 launchd 即為常駐 daemon。）
#
# 🔴 2026-08-08：這支原本預設 uncle6（`CF_ACCOUNT_ID=58309b…`／`UNCLE6_CF_API_KEY`／
#   trigger 指 `rag-demo` 實例）。那個示範站已退場，**uncle6 是官方件帳號、不是測試場**
#   （判準見 repo `CLAUDE.md`「範例在哪、測試在哪」）。
#   **預設值本身就是指令**——沒明講要打哪就報錯，不猜；測試一律走 youlin（D37 stage）。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="${1:?用法: collector-sync.sh <知識資料夾> [manifest路徑]}"
MANIFEST="${2:-$ROOT/.collector-manifest.json}"

set -a
source .env
set +a

export CF_ACCOUNT_ID="${CF_ACCOUNT_ID:?必須指定 CF_ACCOUNT_ID（目標實例所在的 CF 帳號，不再預設）}"
export CF_API_TOKEN="${CF_API_TOKEN:?必須指定 CF_API_TOKEN（該帳號的 R2 寫入 token）}"
export R2_BUCKET="${R2_BUCKET:?必須指定 R2_BUCKET（原稿桶名）}"
export ARCRUN_TRIGGER_URL="${ARCRUN_TRIGGER_URL:?必須指定 ARCRUN_TRIGGER_URL（該實例的 rag_ingest_fs webhook 網址）}"

# 機械閘：擋掉指向 uncle6（官方件／已退場示範站）的目標
case "$ARCRUN_TRIGGER_URL|$CF_ACCOUNT_ID" in
  *rag-demo.arcrun.dev*|*uncle6-me.workers.dev*|*58309bb90fd93ad6d0fe0aae99170e9d*)  # sanitize-ok
    echo "❌ 目標指向 uncle6（官方件／已退場的示範站）——一律不碰。" >&2
    echo "   測試請用 youlin 實例（見 CLAUDE.md「範例在哪、測試在哪」）。" >&2
    exit 1 ;;
esac

[ -x collector/collector ] || (cd collector && go build -o collector .)
# EXTRA_FLAGS：測試用（如 --max-removed-ratio 0.9）
exec ./collector/collector sync --root "$ROOT" --manifest "$MANIFEST" ${EXTRA_FLAGS:-}
