# arcrun-rag 本機測試使用手冊（零 Cloudflare 帳號）

> 版本：2026-07-12（依 P1 地端 spike 實證撰寫）
> 實測環境：macOS（Apple Silicon）、Node v22.21.0、pnpm 11、wrangler 4.98.0
> 鐵律：本手冊**只寫實際跑通、驗證過的指令**；本機測不到的功能誠實列在 §1 對照表與 §5，不寫猜測步驟。

---

## 🤖 AI 一條龍入口（建議走這條）

把這份手冊（或整個 repo 路徑）丟給你自己的 Claude / AI 助手，說：

> 「照這份手冊幫我在本機裝起 arcrun-rag 測試環境，裝完帶我走一輪 §4 的測試。」

手冊裡的腳本（§4.2 ingest、§4.4 graph 註冊）都是完整可執行的程式碼區塊，AI 會自己抽出來存檔執行。下面的手動步驟是 fallback——AI 不在手邊時照打即可。

---

## 1. 這是什麼

arcrun-rag 是「把檔案丟進知識資料夾，公司知識庫自動長出來」的企業 RAG 產品：三模式查詢（關鍵字／語意／知識圖譜）＋ MCP。引擎是 [Arcrun](https://git.uncle6.me/Leo/Arcrun)（開源工作流引擎，正式版跑在 Cloudflare Workers）。本手冊教你**在自己電腦上、完全不需要 Cloudflare 帳號**，用 `wrangler dev`（miniflare 本機模擬）把整套引擎跑起來測試。

### 本機測試能看到什麼／看不到什麼（誠實對照表）

| 功能 | 本機可測？ | 說明 |
|---|---|---|
| KBDB 知識庫（存文件、萬用表、triplet 圖資料） | ✅ | 本機 SQLite（miniflare 模擬 D1），資料落在你指定的 state 目錄 |
| 關鍵字查詢（keyword） | ✅ | D1 LIKE，全功能 |
| 知識圖譜查詢（graph，BFS 找 N 跳鄰居） | ✅ | 全鏈走通：cypher-executor → http_request WASM 零件 → KBDB → code 零件（QuickJS 沙箱）BFS |
| 語意查詢（semantic） | ❌（優雅降級） | 需要 Workers AI + Vectorize，兩者都必須連真 Cloudflare 帳號。查詢**不會 crash**，會自動降級成關鍵字並回 `capability_hint` 誠實告知 |
| 工作流引擎（cypher-executor）＋同步查詢 `/q` | ✅ | 含 workflow 註冊、觸發、trace |
| WASM 零件（TinyGo / QuickJS） | ✅ | repo 自帶編譯好的 `.wasm`，miniflare 跑得動，實測通過 |
| 邏輯零件（if/switch/filter…13 個） | ✅ | 各自 `wrangler dev` 起來後，cypher 的 service binding 會自動連上（dev registry） |
| cron 定時觸發 | ⚠️ 半可測 | 本機**不會自動 tick**；`--test-scheduled` 起服務後可手動 `curl /__scheduled` 觸發，實測 scheduled handler 正常執行 |
| `acr` CLI（push 部署工作流） | ✅（有版本坑） | 要用 repo 內建的 CLI；npm 上的 1.3.13 是舊版會卡住（見 §5） |
| MCP / OAuth、搜尋 Portal（Console 網頁） | 未驗證 | 本次 spike 未涵蓋，不寫步驟 |
| LLM Wiki 精耕（AI 蒸餾知識） | ❌ | 需要 LLM provider，地端接縫（Ollama）還在開發 |

---

## 2. 前置需求

照實測環境寫，其他組合未驗證：

- **macOS**（Apple Silicon 實測；Linux 理論可行但未驗證）
- **Node.js 22**（實測 v22.21.0；建議用 nvm 裝）
- **pnpm**（實測 11.x）：`npm i -g pnpm`
- **wrangler 4.98+（全域）**：`npm i -g wrangler` —— ⚠️ 必裝全域新版，cypher-executor 目錄內 lockfile 釘的舊版 workerd 在本機會一直 crash（見 §5）
- **git**
- 磁碟約 2 GB（repo ＋各目錄 node_modules）
- **不需要** Cloudflare 帳號、不需要綁卡、不需要 `wrangler login`

取得引擎原始碼（URL 已驗證可達；本手冊實測時使用既有 checkout）：

```bash
git clone https://git.uncle6.me/Leo/Arcrun.git arcrun
cd arcrun
```

以下所有路徑都相對這個 `arcrun/` repo 根目錄；另準備一個工作目錄放測試腳本與資料（下稱 `$WORK`），和一個 state 目錄放本機資料庫（下稱 `$STATE`，例如 `$WORK/state`）。

---

## 3. 安裝與啟動

整套共 4 個服務（4 個終端機視窗，或都丟背景）：

| 服務 | 目錄 | port | 角色 |
|---|---|---|---|
| KBDB | `kbdb/` | 8787 | 知識庫 API（資料面那面牆） |
| cypher-executor | `cypher-executor/` | 8788 | 工作流引擎＋查詢入口 |
| http_request 零件 | `.component-builds/http_request/` | 8789 | TinyGo WASM 零件 worker |
| code 零件 | `registry/components/code/` | 8790 | QuickJS 沙箱 JS 零件 worker |

### 3.1 裝依賴（每個目錄一次，指令不同——照抄）

```bash
cd kbdb && npm ci && cd ..
cd cypher-executor && pnpm install --frozen-lockfile && cd ..   # ⚠️ 別用 npm ci，會 ERESOLVE 失敗（§5）
cd .component-builds/http_request && CI=true pnpm install --frozen-lockfile && cd ../..
cd registry/components/code && npm ci && cd ../../..            # postinstall 會自動 vendor quickjs.wasm
```

預期：每條最後印 `Done in ...`（pnpm）或 `found 0 vulnerabilities`（npm），exit 0。

### 3.2 KBDB：建 schema ＋ 啟動（port 8787）

```bash
cd kbdb
npx wrangler d1 migrations apply DB --local --persist-to $STATE/kbdb
```

預期輸出（兩個 migration 都 ✅）：

```
│ 0001_base.sql        │ ✅ │
│ 0002_credentials.sql │ ✅ │
🚣 3 commands executed successfully.
```

啟動（佔住一個終端機）：

```bash
npx wrangler dev --port 8787 --persist-to $STATE/kbdb
```

驗證：

```bash
curl http://127.0.0.1:8787/health
# → {"ok":true}
curl http://127.0.0.1:8787/
# → {"service":"arcrun-kbdb","tier":"base","status":"ok"}
```

### 3.3 cypher-executor：啟動（port 8788）

⚠️ 兩個關鍵：**用全域 `wrangler`**（不是 `npx wrangler`，那會撿到目錄內 lockfile 的舊版）；**帶 `--var` 覆蓋**把所有外部端點指向本機（否則引擎會拿 toml 裡官方帳號的預設值去打真網路）。

```bash
cd cypher-executor
wrangler dev --port 8788 --test-scheduled \
  --persist-to $STATE/cypher \
  --var WORKER_SUBDOMAIN:spike-local-offline \
  --var KBDB_BASE_URL:http://127.0.0.1:8787 \
  --var GITEA_BASE_URL: \
  --var CONSOLE_TENANT:spike
```

啟動時你會看到（這些都是正常的、也是本機邊界的誠實訊號）：

- `env.AI  AI  remote` ＋ 警告 `Using Workers AI always accesses your Cloudflare account...` → AI binding 本機模擬不了，別碰用到 AI 的功能即可
- 13 個 `env.SVC_*  Worker  local [not connected]` → 邏輯零件 worker 沒起（本手冊測試路線用不到；要用時到對應 `.component-builds/<零件>/` 目錄 `npx wrangler dev` 起來，binding 會自動變 `[connected]`）
- `Miniflare does not currently trigger scheduled Workers automatically` → cron 不自動跑（§5）

驗證＋seed（把內建 recipe 種進本機 KV，一次即可）：

```bash
curl http://127.0.0.1:8788/health
# → {"ok":true}
curl -X POST http://127.0.0.1:8788/init/seed
# → {"success":true,"api_recipes":{"seeded":10,...},"auth_recipes":{"seeded":26,...},...}
```

### 3.4 兩個零件 worker（port 8789 / 8790）

各開一個終端機：

```bash
cd .component-builds/http_request
npx wrangler dev --port 8789 --persist-to $STATE/http-request
```

```bash
cd registry/components/code
npx wrangler dev --port 8790 --persist-to $STATE/code
```

驗證（這一步同時證明 WASM 零件在你機器上跑得動）：

```bash
curl http://127.0.0.1:8789/
# → {"ok":true,"component":"http_request"}
curl http://127.0.0.1:8790/
# → {"ok":true,"component":"code"}
curl -X POST http://127.0.0.1:8790/ -H 'Content-Type: application/json' \
  -d '{"code":"return { doubled: input.x * 2 }","input":{"x":21}}'
# → {"success":true,"data":{"doubled":42}}
```

---

## 4. 測試走一輪（丟文件 → ingest → 三模式查詢）

### 4.1 準備一份測試文件

任何 markdown 檔都行。沒有的話：

```bash
cat > $WORK/sample.md <<'EOF'
# 測試知識庫文件

arcrun-rag 是企業 RAG 知識庫產品，三模式查詢：關鍵字、語意、知識圖譜。

## 部署模式

self-hosted 佈建，資料在客戶自己的帳號或機器上，不是 SaaS。
EOF
```

### 4.2 機械 ingest（走 KBDB HTTP API，零 SQL）

存成 `$WORK/ingest-md.mjs`：

```javascript
#!/usr/bin/env node
// 機械 ingest：md 檔 → 機械切塊 → 走 KBDB HTTP API 灌進本機 kbdb。
// 用法：node ingest-md.mjs <md檔路徑> [kbdb_base] [owner_id]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
const base = (process.argv[3] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const owner = process.argv[4] ?? 'spike';
if (!file) { console.error('用法：node ingest-md.mjs <md檔> [kbdb_base] [owner_id]'); process.exit(1); }

const md = readFileSync(file, 'utf8');
const pageName = basename(file).replace(/\.md$/, '');

// 機械切塊：以標題行為界，段落聚成 block（零 LLM，決定性）。
const blocks = [];
let cur = [];
for (const line of md.split('\n')) {
  if (/^#{1,6}\s/.test(line) && cur.join('').trim()) { blocks.push(cur.join('\n').trim()); cur = []; }
  cur.push(line);
}
if (cur.join('').trim()) blocks.push(cur.join('\n').trim());

let ok = 0, fail = 0;
for (const [i, content] of blocks.entries()) {
  const res = await fetch(`${base}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entry_type: 'block',
      content,
      owner_id: owner,
      page_name: pageName,
      metadata_json: JSON.stringify({ source: `spike://${basename(file)}#${i}`, embed: true }),
    }),
  });
  const j = await res.json().catch(() => null);
  if (res.ok && j?.success) { ok++; console.log(`✓ block ${i} → ${j.entry.id}`); }
  else { fail++; console.error(`✗ block ${i} → HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`); }
}
console.log(`\ningest 完成：${ok} 成功 / ${fail} 失敗（${pageName}，owner=${owner}）`);
process.exit(fail ? 1 : 0);
```

執行：

```bash
node $WORK/ingest-md.mjs $WORK/sample.md
```

預期輸出：

```
✓ block 0 → e_xxxxxxxx-....
✓ block 1 → e_xxxxxxxx-....
ingest 完成：2 成功 / 0 失敗（sample，owner=spike）
```

### 4.3 查詢模式一＋二：keyword ✅／semantic 降級 ✅

```bash
# keyword（q 要 URL encode；「知識庫」= %E7%9F%A5%E8%AD%98%E5%BA%AB）
curl "http://127.0.0.1:8787/entries/search?q=%E7%9F%A5%E8%AD%98%E5%BA%AB&owner_id=spike"
```

預期：`{"success":true,"entries":[...命中的 block...],"count":N,"mode":"keyword"}`。

```bash
# semantic（預期：不 crash、誠實降級）
curl "http://127.0.0.1:8787/entries/search?q=%E7%9F%A5%E8%AD%98%E5%BA%AB&owner_id=spike&mode=semantic"
```

預期回應含（這就是「本機語意查詢不可用」的正確行為）：

```json
{"success":true, "mode":"keyword", "requested_mode":"semantic",
 "capability_hint":"語義查詢需先開 vectorize（embed 模組）。..."}
```

### 4.4 查詢模式三：graph（全鏈工作流）

先灌圖資料（triplet 萬用表，走 API）：

```bash
curl -X POST http://127.0.0.1:8787/templates -H 'Content-Type: application/json' \
  -d '{"name":"graph_triplet","slots":["subject","predicate","object"],"description":"graph triplets"}'

for t in \
 '{"template":"graph_triplet","owner_id":"spike","values":{"subject":"arcrun-rag","predicate":"depends_on","object":"Arcrun"}}' \
 '{"template":"graph_triplet","owner_id":"spike","values":{"subject":"Arcrun","predicate":"contains","object":"KBDB"}}' \
 '{"template":"graph_triplet","owner_id":"spike","values":{"subject":"Arcrun","predicate":"contains","object":"cypher-executor"}}' \
 '{"template":"graph_triplet","owner_id":"spike","values":{"subject":"KBDB","predicate":"stores","object":"triplets"}}' ; do
  curl -s -X POST http://127.0.0.1:8787/records -H 'Content-Type: application/json' -d "$t" | head -c 80; echo
done
```

再註冊 graph_neighbors 工作流（照抄官方示範 `registry/examples/graph-neighbors/`，僅把零件指向本機 worker URL）。存成 `$WORK/register-graph-neighbors.mjs`：

```javascript
#!/usr/bin/env node
// 註冊 graph_neighbors 工作流到本機 cypher-executor。
// 等同 acr push 的兩步：POST /cypher/search 取圖 → merge config → POST /webhooks/named。
const CYPHER = process.env.CYPHER_BASE ?? 'http://127.0.0.1:8788';
const NS = process.env.NAMESPACE ?? 'spike';
const HTTP_REQ_URL = process.env.HTTP_REQ_URL ?? 'http://127.0.0.1:8789';
const CODE_URL = process.env.CODE_URL ?? 'http://127.0.0.1:8790';

const flow = [
  'input >> ON_SUCCESS >> fetch_triplets',
  'fetch_triplets >> ON_SUCCESS >> bfs_neighbors',
];

// BFS inline JS —— 照抄 registry/examples/graph-neighbors/workflow.yaml 的 code 節點，
// 僅一處在地化：records 同時容忍「已解析物件」與「JSON 字串 body」兩種上游形狀。
const BFS_CODE = `
let records = input.records;
if (typeof records === 'string') { try { records = JSON.parse(records); } catch (e) { records = []; } }
if (records && !Array.isArray(records) && Array.isArray(records.records)) records = records.records;
if (!Array.isArray(records)) records = [];
const start = String(input.start == null ? '' : input.start);
const maxDepth = Math.max(1, parseInt(String(input.depth == null ? 1 : input.depth), 10) || 1);
const directed = String(input.directed == null ? '' : input.directed) === 'true';
if (!start) return { success: false, error: 'graph_neighbors 缺 start（node）參數' };
const adj = new Map();
function addEdge(from, to, predicate) {
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push({ node: to, predicate: predicate });
}
for (const r of records) {
  const v = (r && typeof r === 'object' && r.values && typeof r.values === 'object') ? r.values : r;
  if (!v || typeof v !== 'object') continue;
  const s = v.subject, p = v.predicate, o = v.object;
  if (!s || !o) continue;
  addEdge(s, o, p);
  if (!directed) addEdge(o, s, p);
}
const visited = new Set([start]);
let frontier = [start];
const neighbors = [];
for (let d = 1; d <= maxDepth; d++) {
  const next = [];
  for (const cur of frontier) {
    const outs = adj.get(cur) || [];
    for (const e of outs) {
      if (visited.has(e.node)) continue;
      visited.add(e.node);
      neighbors.push({ node: e.node, predicate: e.predicate, from: cur, depth: d });
      next.push(e.node);
    }
  }
  frontier = next;
  if (frontier.length === 0) break;
}
return { success: true, start: start, depth: maxDepth, directed: directed, neighbors: neighbors, count: neighbors.length };
`;

const config = {
  fetch_triplets: {
    component: HTTP_REQ_URL, // 本機 http_request 零件 worker
    method: 'GET',
    url: '{{input.kbdb_base}}/records/by-template/{{input.template}}?owner_id={{input.namespace}}',
    headers: { Accept: 'application/json' },
  },
  bfs_neighbors: {
    component: CODE_URL, // 本機 code 零件 worker
    code: BFS_CODE,
    input: {
      records: '{{fetch_triplets.data.body}}',
      start: '{{input.node}}',
      depth: '{{input.depth}}',
      directed: '{{input.directed}}',
    },
    limits: { timeout_ms: 3000, max_output_bytes: 2097152 },
  },
};

// 1) 取執行圖
const searchRes = await fetch(`${CYPHER}/cypher/search`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Arcrun-API-Key': NS },
  body: JSON.stringify({ triplets: flow }),
});
const search = await searchRes.json();
if (!searchRes.ok || search.missing?.length) {
  console.error('cypher/search 失敗：', JSON.stringify(search).slice(0, 300));
  process.exit(1);
}

// 2) merge config（照抄 cli/src/commands/push.ts 的邏輯）
const raw = search.cypher;
const nodes = raw.nodes.map((node) => {
  const nodeCfg = config[node.id];
  if (!nodeCfg) return node;
  const { component, ...params } = nodeCfg;
  return {
    ...node,
    componentId: typeof component === 'string' ? component : node.componentId,
    data: Object.keys(params).length > 0 ? { ...(node.data ?? {}), ...params } : node.data,
  };
});
const graph = { id: 'graph_neighbors', name: 'graph_neighbors', nodes, edges: raw.edges };

// 3) 註冊
const res = await fetch(`${CYPHER}/webhooks/named`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Arcrun-API-Key': NS },
  body: JSON.stringify({
    name: 'graph_neighbors',
    graph,
    config,
    description: '同步查詢：從 KBDB triplet 記錄建鄰接表，記憶體 BFS 找 N 跳鄰居（本機版，零件走 localhost）',
  }),
});
console.log(res.status, JSON.stringify(await res.json()).slice(0, 300));
```

執行＋查詢：

```bash
node $WORK/register-graph-neighbors.mjs
# → 201 {"name":"graph_neighbors","webhook_url":"...", ...}

curl "http://127.0.0.1:8788/q/spike/graph_neighbors?node=Arcrun&depth=2&template=graph_triplet&namespace=spike&kbdb_base=http://127.0.0.1:8787"
```

預期（2 跳 BFS，實測回應）：

```json
{"success":true,"data":{"success":true,"start":"Arcrun","depth":2,"directed":false,
 "neighbors":[
  {"node":"arcrun-rag","predicate":"depends_on","from":"Arcrun","depth":1},
  {"node":"KBDB","predicate":"contains","from":"Arcrun","depth":1},
  {"node":"cypher-executor","predicate":"contains","from":"Arcrun","depth":1},
  {"node":"triplets","predicate":"stores","from":"KBDB","depth":2}],
 "count":4}}
```

走到這裡＝**三模式全部驗完**：keyword ✅、semantic 誠實降級 ✅、graph 全鏈（工作流引擎＋兩個 WASM 零件）✅。

### 4.5（選配）用 acr CLI 部署工作流

用 **repo 內建** CLI（`cli/dist/`），env vars 指向本機：

```bash
cat > $WORK/wf-hello-local.yaml <<'EOF'
name: spike_hello_local
description: 本機冒煙：code 零件把輸入字串反轉

flow:
  - "input >> ON_SUCCESS >> reverse_text"

config:
  reverse_text:
    component: "http://127.0.0.1:8790"   # 本機 code 零件 worker
    code: |
      const s = String(input.text == null ? '' : input.text);
      return { success: true, original: s, reversed: s.split('').reverse().join('') };
    input:
      text: "{{input.text}}"
EOF

cd $WORK
ARCRUN_MODE=self-hosted ARCRUN_NAMESPACE=spike \
ARCRUN_CYPHER_EXECUTOR_URL=http://127.0.0.1:8788 \
node <arcrun repo 路徑>/cli/dist/index.js push wf-hello-local.yaml

curl "http://127.0.0.1:8788/q/spike/spike_hello_local?text=arcrun"
# → {"success":true,"data":{"success":true,"original":"arcrun","reversed":"nurcra"}}
```

---

## 5. 已知限制與常見錯誤（都是實測撞過的）

1. **`cypher-executor` 跑 `npm ci` 失敗（ERESOLVE）**
   錯誤：`Conflicting peer dependency: zod@4.4.3`（package-lock 內 @hono/zod-openapi@1.4.0 要 zod ^4，package.json 釘 zod ~3.23.8）。
   → 正解：該目錄用 `pnpm install --frozen-lockfile`（repo 慣例本來就是 pnpm）。

2. **cypher-executor 用目錄內 wrangler 起服務 → 請求全掛（hang 或 503 `worker restarted mid-request`）**
   lockfile 釘的舊版 workerd（1.20250906.0）在本機 dev 會 crash-restart。
   → 正解：cypher-executor 用**全域** `wrangler dev`（4.98+ 實測正常）。其他三個目錄用 `npx wrangler dev` 沒問題。

3. **semantic 查詢回 keyword 結果**——不是 bug，是本機的預期行為（無 Vectorize/AI binding，優雅降級，回應裡有 `capability_hint`）。

4. **cron 工作流不會自己跑**——miniflare 不自動 tick。cypher 用 `--test-scheduled` 起，然後手動觸發：
   ```bash
   curl "http://127.0.0.1:8788/__scheduled?cron=*+*+*+*+*"   # → 200，log 印 [scheduled] tick
   ```

5. **workflow 裡寫 `component: http_request` / `component: code`（零件名）→ 本機跑不通**
   引擎會把零件名推導成官方雲端 URL（`arcrun-{零件}.{subdomain}.workers.dev`），本機沒有這些站。
   → 正解：本機 workflow 的 config 一律用 `component: "http://127.0.0.1:<port>"` 直接指本機零件 worker（§4.4 範例就是這樣做）。這是引擎的已知地端缺口，已回報上游。

6. **npm 全域的 `acr`（1.3.13）push 會卡「需人類明示同意」**——npm 版落後 repo（consent 閘已在新版移除）。
   → 正解：用 repo 內建 `node cli/dist/index.js push ...`（§4.5）。

7. **裝依賴時把正在跑的服務弄死**——`npm ci`/pnpm purge 會整個抽換 node_modules，正在跑的 `wrangler dev` 會變殭屍（占著 port 但不回應）。
   → 正解：**先裝完所有依賴、再起服務**。撞到了就 `lsof -ti :<port> | xargs kill -9` 再重起。

8. **啟動時看到 `Using Workers AI always accesses your Cloudflare account...` 警告**——正常。表示 AI binding 沒有本機模擬；只要不觸發用到 AI 的 workflow，就不會有任何真帳號流量（本手冊路線不會觸發）。

9. **資料收在哪／怎麼重置**——全部在你 `--persist-to` 指的 `$STATE` 目錄（SQLite＋KV 檔案）。整個刪掉＝重置，重跑 §3.2 的 migrations 即可。

---

## 6. 回報問題

- 有 Gitea 帳號（git.uncle6.me）：開 issue 到 **`Leo/arcrun-rag`**，附：跑到哪一步、完整指令、完整錯誤訊息、`node --version`／`wrangler --version`。
- 沒有帳號：把上述資訊記成一份文字檔，直接回報給 leo。
