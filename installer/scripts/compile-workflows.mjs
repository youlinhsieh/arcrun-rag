#!/usr/bin/env node
/**
 * compile-workflows.mjs — 打包期（非 runtime）把 5 條 RAG workflow 的 .local.yaml
 * 預編成 src/workflows.json，讓「零依賴」的安裝器 worker 不必在 runtime 帶 YAML parser。
 *
 * ⚠️ 不重寫 RAG 邏輯：只把既有 workflows/*.local.yaml 的 { name, description, flow, config }
 *    原封抽出成 JSON，__PLACEHOLDER__ 佔位一律保留（安裝器 worker 在 /api/finish 時才依實例
 *    值代換，手法對齊 install/push-demo-workflow.sh）。這是「搬運」，不是「產生」。
 *
 * 血統：install/push-demo-workflow.sh（python + pyyaml 讀 yaml → /cypher/search → /webhooks/named）。
 *   本檔只負責前半「讀 yaml → 抽 flow/config」，後半的推送搬進 worker。
 *
 * 用法：node installer/scripts/compile-workflows.mjs
 *   需 python3 + pyyaml（與 push-demo-workflow.sh 相同前置）。輸出 installer/src/workflows.json。
 *
 * ── `--check`（唯讀模式，機械閘用；inkstone/InkStoneCo#141，2026-09-20）─────────
 * 一個字都不寫，只回答一個問題：**磁碟上那份 `workflows.json`，是不是現在這些 YAML 編出來的？**
 * 不是就 exit 1。
 *
 * 🔴 為什麼要有它：工作流的真身是 `workflows/*.local.yaml`，但**使用者拿到的是
 *   `workflows.json`**（安裝器 import 它、`/api/finish` 照它推）。兩者之間唯一的橋
 *   就是「有人記得跑這支」——而整條出貨線上**沒有任何一站在驗這件事**。
 *   ⇒ 改完 YAML 沒重編：測試全綠、版本照跳、出貨全過、`/health` 報新 commit，
 *     而使用者實例上被種下去的還是舊圖。**失效是完全靜默的。**
 *   跟 `verify-manifest.mjs` 治的是同一個病（宣告與磁碟脫鉤），只是換一層。
 *
 * ⚠️ `--check` 不連網，所以「flow 變了、需要重編圖」這種情況它只能**報告**
 *   （叫你帶 `CYPHER_BASE` 跑一次），不能代勞——編圖要用引擎自己的 parser，猜不得。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ragRoot = join(here, '..', '..');            // arcrun-rag repo 根
const wfDir = join(ragRoot, 'workflows');
const outPath = join(here, '..', 'src', 'workflows.json');
// oauth-prototype/worker.js 直接 import ./workflows.json，需同步更新
const outPathProto = join(here, '..', 'oauth-prototype', 'workflows.json');

// 推送順序＝cf-install-guide.md §4：graph-neighbors → rag-chat → rag-extract →
//   rag-extract-one → rag-ingest-cards（design task 13 的 5 條）。
const FILES = [
  // 用戶實例集（daemon-beta 四步定稿）：萃取在用戶機器本地做，rag_extract 鏈不進實例；
  // 收卡走 rag_ingest_card（零 LLM 零 credential）。網頁上傳鏈（extract/ingest-cards）屬 demo 站專用。
  'graph-neighbors.local.yaml',
  'rag-chat.local.yaml',
  'rag-ingest-card.local.yaml',
  'rag-takedown-direct.local.yaml',
];

const py = `
import json, sys, yaml
out = []
for path in sys.argv[1:]:
    with open(path) as f:
        wf = yaml.safe_load(f)
    raw = open(path).read()
    import re
    tokens = sorted(set(re.findall(r'__[A-Z0-9_]+__', raw)))
    out.append({
        "file": path.split('/')[-1],
        "name": wf.get("name"),
        "description": wf.get("description", ""),
        "flow": wf.get("flow", []),
        "config": wf.get("config") or {},
        "placeholders": tokens,
    })
print(json.dumps(out, ensure_ascii=False, indent=2))
`;

const paths = FILES.map((f) => join(wfDir, f));
const json = execFileSync('python3', ['-c', py, ...paths], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const parsed = JSON.parse(json);

// ── 🔴 預編圖保全閘（t152，2026-08-03）──────────────────────────────────────────
//
// 病史：t158 P0 把 graph **預編**進 workflows.json，讓安裝＝純上傳、全程 0 次
//   `/cypher/search`（冷實例 search 25.7s vs 15s timeout ⇒ 正常安裝被判死）。
//   但**本腳本從來不產 `graph`**——出貨那份的圖是別的地方生的。
//   ⇒ 任何人照文件跑一次 `node installer/scripts/compile-workflows.mjs`，
//     就會把 4 支 workflow 的預編圖**靜默刪掉**，t158 修好的東西當場又壞。
//   實際發生過：本次改 rag_chat 生成端時第一版重編，diff 顯示 -336 行全是 graph。
//
// 規則（守「東西還在不在也要進機械閘」）：
//   · flow 沒變 → 沿用既有 graph（圖只由 flow 決定；node 的 componentId 在推送時會被
//     config 覆蓋，見 worker.js pushWorkflowTo ⇒ 只改 config 不影響圖的正確性）。
//   · flow 變了或本來就沒有圖 → 需要重編：給 `CYPHER_BASE`（＋選填 `CYPHER_NS`）
//     用引擎自己的 parser（`/cypher/search` mode=compile）產圖。
//   · 兩者都不成立 → **exit 1**，絕不產出「沒有圖」的 workflows.json。
const prev = (() => {
  try { return JSON.parse(readFileSync(outPathProto, 'utf8')); } catch { return []; }
})();
const prevByName = new Map(prev.map((w) => [w.name, w]));
const sameFlow = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const checkOnly = process.argv.includes('--check');
const cypherBase = process.env.CYPHER_BASE;
const needCompile = [];
for (const w of parsed) {
  const old = prevByName.get(w.name);
  if (old?.graph && sameFlow(old.flow, w.flow)) {
    w.graph = old.graph;            // flow 未變 ⇒ 沿用（不是「假裝有圖」，是同一張圖）
  } else {
    needCompile.push(w);
  }
}

// ── `--check`：唯讀比對，不寫任何檔 ───────────────────────────────────────────
// 判準只有一句：**照現在的 YAML 重編一次，會不會編出跟磁碟上不一樣的東西？**
// 會 ⇒ 那份 `workflows.json` 已經不是這些 YAML 的成品 ⇒ exit 1。
if (checkOnly) {
  const problems = [];
  if (needCompile.length > 0) {
    for (const w of needCompile) {
      problems.push(prevByName.get(w.name)
        ? `${w.name}（${w.file}）：flow 改過了，但 workflows.json 裡還是舊的圖`
        : `${w.name}（${w.file}）：workflows.json 裡根本沒有這一支`);
    }
  } else {
    const expected = JSON.stringify(parsed, null, 2) + '\n';
    for (const out of [outPath, outPathProto]) {
      let actual = null;
      try { actual = readFileSync(out, 'utf8'); } catch { /* 不存在 */ }
      if (actual === null) problems.push(`${out}：檔案不存在`);
      else if (actual !== expected) problems.push(`${out}：內容與 YAML 編出來的不一致（description／config／佔位符其中之一改過了）`);
    }
  }
  if (problems.length) {
    console.error('\n❌ workflows.json 與 workflows/*.local.yaml 已經脫鉤：');
    for (const p of problems) console.error(`   · ${p}`);
    console.error('\n   ⇒ 使用者實例上被種下去的是 workflows.json，不是 YAML。');
    console.error('     現在出貨的話，YAML 上的修法**不會**到任何人手上，而且沒有任何訊息會提醒你。');
    console.error('\n   修法：重編一次（flow 有變就要帶 CYPHER_BASE，用引擎自己的 parser 產圖）：');
    console.error('     node installer/scripts/compile-workflows.mjs');
    console.error('     CYPHER_BASE=https://arcrun-cypher-executor.<subdomain>.workers.dev \\');
    console.error('       CYPHER_NS=<namespace> node installer/scripts/compile-workflows.mjs');
    process.exit(1);
  }
  console.log(`✓ workflows.json 與 ${parsed.length} 支 YAML 一致（${parsed.map((w) => w.name).join('、')}）`);
  process.exit(0);
}

if (needCompile.length > 0) {
  if (!cypherBase) {
    console.error('\n❌ 編譯中止：下列 workflow 的 flow 有變（或本來就沒有預編圖），需要重編圖：');
    for (const w of needCompile) console.error(`   · ${w.name}（${w.file}）`);
    console.error('\n   重編要用引擎自己的 parser。設好 CYPHER_BASE 再跑一次，例如：');
    console.error('     CYPHER_BASE=https://arcrun-cypher-executor.<subdomain>.workers.dev \\');
    console.error('     CYPHER_NS=<namespace> node installer/scripts/compile-workflows.mjs');
    console.error('\n   （沒有圖的 workflows.json 會讓安裝退回 runtime 編圖 ⇒ 冷實例 timeout，t158 的病復發）');
    process.exit(1);
  }
  const ns = process.env.CYPHER_NS ?? 'demo';
  for (const w of needCompile) {
    const res = await fetch(`${cypherBase}/cypher/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Arcrun-API-Key': ns, 'user-agent': 'curl/8.5.0' },
      body: JSON.stringify({ triplets: w.flow, mode: 'compile' }),
    });
    if (!res.ok) {
      console.error(`❌ ${w.name} 編圖失敗：/cypher/search HTTP ${res.status}`);
      process.exit(1);
    }
    const compiled = await res.json();
    w.graph = compiled.cypher;
    console.log(`  ↻ ${w.name} 重編圖（flow 有變）：nodes=${w.graph?.nodes?.length ?? 0} edges=${w.graph?.edges?.length ?? 0}`);
  }
}

// 最後一道：每支都必須帶圖，否則不准落檔
const noGraph = parsed.filter((w) => !w.graph?.nodes?.length);
if (noGraph.length > 0) {
  console.error(`❌ 編譯中止：${noGraph.map((w) => w.name).join('／')} 沒有預編圖，拒絕產出。`);
  process.exit(1);
}

const outJson = JSON.stringify(parsed, null, 2);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, outJson + '\n', 'utf8');
mkdirSync(dirname(outPathProto), { recursive: true });
writeFileSync(outPathProto, outJson + '\n', 'utf8');
console.log(`✓ 編出 ${parsed.length} 條 workflow → ${outPath} + ${outPathProto}`);
for (const w of parsed) {
  console.log(`  · ${w.name.padEnd(18)} flow=${w.flow.length} 步  config keys=${Object.keys(w.config).length}  佔位=${w.placeholders.length}`);
}
