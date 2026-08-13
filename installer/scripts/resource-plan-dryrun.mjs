#!/usr/bin/env node
/**
 * resource-plan-dryrun.mjs — 「這次更新會動到哪幾顆資源」**先看、再按**。
 *
 * 🔴 **唯讀**：只呼叫共用規則的 `planResources()`，那一段照設計完全不寫入
 *   （會寫的是 `applyResourcePlan()`，本檔不碰它）。所以拿真 token 跑它是安全的：
 *   它不會建、不會綁、不會部署任何東西。
 *
 * ── 為什麼有這支 ────────────────────────────────────────────────────────────
 * `Leo/Arcrun#97`（我按了更新，工作流和登入全不見了）之後，「更新會不會換掉我的資源」
 * 這件事必須是**按下去之前看得到**的。而驗收也需要它：
 * 「更新前後綁的還是不是原本那幾顆」要有可貼的實測輸出，而不是「應該可以」。
 *
 * 用法：
 *   # ① 不帶 token：拿真的 bundle manifest 跑三種模擬情境（沒裝過／裝過了／名字改過）
 *   node installer/scripts/resource-plan-dryrun.mjs
 *
 *   # ② 帶 token：對**真帳號**看一次現況（唯讀）。token 只要讀權限就夠
 *   #    （Workers Scripts:Read／KV:Read／D1:Read／Vectorize:Read）
 *   node installer/scripts/resource-plan-dryrun.mjs --account <CF_ACCOUNT_ID> --token <CF_API_TOKEN>
 *
 *   # ③ 換一包 bundle（例如 staging 釘點）
 *   node installer/scripts/resource-plan-dryrun.mjs --bundle <BUNDLE_BASE_URL>
 *
 * ⚠️ 測試場只在 youlin（見 repo CLAUDE.md「範例在哪、測試在哪」）。
 */
import { planResources } from '../oauth-prototype/shared/resource-rule/rule.mjs';
import { createCloudflareResourceApi } from '../oauth-prototype/shared/resource-rule/cf-resource-api.mjs';
import { manifestRequirements } from '../oauth-prototype/worker.js';

/** prod 釘點——與 `installer/oauth-prototype/wrangler.toml` 的 `[vars] BUNDLE_BASE` 同一個值。 */
const DEFAULT_BUNDLE = 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@3b3e3dae8e8bcda6874991261f0e7cd0cd897f09';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const bundleBase = arg('bundle', DEFAULT_BUNDLE).replace(/\/+$/, '');
const accountId = arg('account');
const apiToken = arg('token');
// 資源短碼：只影響「真的要新建時叫什麼名字」，不影響沿用判斷。
const baseName = arg('base', 'arcrun-rag-preview');

const res = await fetch(`${bundleBase}/manifest.json`);
if (!res.ok) throw new Error(`讀不到 bundle manifest（HTTP ${res.status}）：${bundleBase}/manifest.json`);
const manifest = await res.json();
const requirements = manifestRequirements(manifest, baseName, true);

console.log(`bundle：${bundleBase}`);
console.log(`        release=${manifest.release}｜built=${manifest.built}｜零件 ${manifest.core.length} 顆`);
console.log(`需求：${requirements.length} 條綁定（${[...new Set(requirements.map((r) => r.worker))].join('、')}）\n`);

const KIND_ORDER = { kv_namespace: 0, d1: 1, vectorize: 2 };
function printPlan(plan) {
  const rows = [
    ...plan.adopt.map((a) => ({ kind: a.kind, binding: a.binding, value: a.value, how: `沿用（讀自 ${a.from}）` })),
    ...plan.create.flatMap((c) => [c.binding, ...c.alsoBind].map((b) => ({
      kind: c.kind, binding: b, value: `（新建：${c.createName}）`, how: `新建——沒有任何已部署的 worker 綁過它`,
    }))),
  ].sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || x.binding.localeCompare(y.binding));
  for (const r of rows) {
    console.log(`   ${`${r.kind}:${r.binding}`.padEnd(32)} → ${String(r.value).padEnd(34)} ${r.how}`);
  }
  console.log(`   小計：沿用 ${plan.adopt.length} 項、要新建 ${plan.create.length} 顆資源`);
  if (plan.liveVars.size > 0) {
    console.log('   已部署 worker 身上現有的版本標籤（#106）：');
    for (const [script, vars] of plan.liveVars) {
      const v = vars.ARCRUN_BUNDLE_VERSION;
      if (v) console.log(`     ${script}: ARCRUN_BUNDLE_VERSION=${v}`);
    }
  }
}

if (accountId && apiToken) {
  // ── ② 真帳號（唯讀）─────────────────────────────────────────────────────
  const api = createCloudflareResourceApi({ accountId, apiToken });
  const plan = await planResources(api, requirements, 'update');
  console.log(`帳號 ${accountId}（唯讀預覽，沒有建立或改動任何東西）`);
  if (plan.blockers.length > 0) {
    console.log('\n⛔ 這台會被擋下來，安裝器不會動任何資源：');
    for (const b of plan.blockers) console.log(`   - ${b}`);
    process.exit(2);
  }
  printPlan(plan);
  process.exit(0);
}

// ── ① 三種模擬情境（不需要任何憑證）────────────────────────────────────────
console.log('（沒給 --account/--token ⇒ 跑三種模擬情境；要看真帳號請見檔頭用法 ②）');

const KV_BINDINGS = [...new Set(requirements.filter((r) => r.kind === 'kv_namespace').map((r) => r.binding))];
const SCRIPTS = [...new Set(requirements.map((r) => r.worker))];
const D1_ID = 'd1id-REAL';

/** 假帳號的 fetch 替身。`titleFor` 決定「使用者帳號上那顆實際叫什麼名字」。 */
function fakeFetch({ deployed, titleFor }) {
  const kv = new Map();
  const d1 = new Map();
  const vectorize = [];
  const scripts = new Map();
  const kvIdByBinding = new Map();
  if (deployed) {
    for (const b of KV_BINDINGS) {
      const id = `kvid-REAL-${b.toLowerCase()}`;
      kv.set(titleFor(b), id);
      kvIdByBinding.set(b, id);
    }
    d1.set(titleFor('db'), D1_ID);
    for (const s of SCRIPTS) {
      const bindings = [];
      for (const r of requirements.filter((x) => x.worker === s)) {
        if (r.kind === 'kv_namespace') bindings.push({ type: 'kv_namespace', name: r.binding, namespace_id: kvIdByBinding.get(r.binding) });
        else if (r.kind === 'd1') bindings.push({ type: 'd1', name: r.binding, id: D1_ID });
        else if (r.kind === 'vectorize') {
          const idx = titleFor('index');
          if (!vectorize.includes(idx)) vectorize.push(idx);
          bindings.push({ type: 'vectorize', name: r.binding, index_name: idx });
        }
      }
      bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: '1.4.41' });
      scripts.set(s, bindings);
    }
  }
  const ok = (result) => new Response(JSON.stringify({ success: true, result, errors: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  const bad = (message, status) => new Response(JSON.stringify({ success: false, result: null, errors: [{ message }] }),
    { status, headers: { 'Content-Type': 'application/json' } });
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '');
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    const m = path.match(/^\/workers\/scripts\/([^/]+)\/settings$/);
    if (m && method === 'GET') {
      const s = decodeURIComponent(m[1]);
      return scripts.has(s) ? ok({ bindings: scripts.get(s) }) : bad('script_not_found', 404);
    }
    if (path === '/storage/kv/namespaces') return ok([...kv].map(([title, id]) => ({ id, title })));
    if (path === '/d1/database') return ok([...d1].map(([name, uuid]) => ({ uuid, name })));
    if (path === '/vectorize/v2/indexes') return ok(vectorize.map((name) => ({ name })));
    return bad(`預覽器沒有實作：${method} ${path}`, 501);
  };
}

const SCENARIOS = [
  ['fresh', '沒裝過（全新帳號，一顆 worker 都沒有）', 'init', { deployed: false, titleFor: (b) => b }],
  ['installed', '裝過了（安裝器的命名慣例）', 'update',
    { deployed: true, titleFor: (b) => `${baseName}-kv-${String(b).toLowerCase()}` }],
  ['renamed', '資源在，但名字與安裝器預期完全不同（#97 的病根）', 'update',
    { deployed: true, titleFor: (b) => `zzz-${[...String(b)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}` }],
];

const realFetch = globalThis.fetch;
for (const [name, label, mode, spec] of SCENARIOS) {
  globalThis.fetch = fakeFetch(spec);
  let plan;
  try {
    plan = await planResources(createCloudflareResourceApi({ accountId: 'preview', apiToken: 'preview' }), requirements, mode);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n── ${name}（mode=${mode}）：${label}`);
  if (plan.blockers.length > 0) {
    for (const b of plan.blockers) console.log(`   ⛔ ${b}`);
    continue;
  }
  printPlan(plan);
}
