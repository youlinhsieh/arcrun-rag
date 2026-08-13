// @ts-check
/**
 * demo.mjs — 安裝器那條路的**可獨立執行**證明。
 *
 *   node shared/resource-rule/tests/demo.mjs
 *
 * 這支只 import `shared/resource-rule/`，**沒有 node_modules、沒有建置步驟**——
 * 跑得起來本身就是「安裝器把 repo archive 拉下來就能直接用」這句話的證據。
 * （對照組：`acr` 那條要先 npm ci + TS 轉譯才跑得動。兩條路差在外殼，判斷是同一份。）
 *
 * 三種情境各跑一次，印出每個 binding 選到哪顆資源、以及這一趟建了幾顆。
 */

import { resolveInstanceResources } from '../installer-entry.mjs';
import { makeAccount, SCENARIOS, WORKER_NEEDS } from './fixture-account.mjs';

/** 用 fixture 的需求組出各 worker 的 wrangler.toml 內容。 */
function tomls() {
  return Object.entries(WORKER_NEEDS).map(([script, need]) => {
    let t = `name = "${script}"\ncompatibility_date = "2025-02-19"\n`;
    for (const b of need.kv) t += `\n[[kv_namespaces]]\nbinding = "${b}"\nid = "PLACEHOLDER"\n`;
    for (const d of need.d1) {
      t += `\n[[d1_databases]]\nbinding = "${d.binding}"\ndatabase_name = "${d.database_name}"\ndatabase_id = "PLACEHOLDER"\n`;
    }
    return t;
  });
}

const order = /** @type {const} */ (['fresh', 'installed', 'renamed']);

console.log('安裝器那條路（只 import shared/resource-rule/，零依賴、零建置）\n');

for (const scenario of order) {
  const mode = scenario === 'fresh' ? 'init' : 'update';
  const account = makeAccount(scenario);
  const r = await resolveInstanceResources({
    accountId: 'acct-demo',
    apiToken: 'tok-demo',
    wranglerTomls: tomls(),
    mode,
    fetch: account.fetch,
  });

  console.log(`── ${scenario}（mode=${mode}）：${SCENARIOS[scenario].label}`);
  if (r.blocked) {
    console.log('   ⛔ 停手，一顆資源都沒建：');
    for (const b of r.blockers) console.log(`      • ${b}`);
    console.log('');
    continue;
  }
  for (const key of Object.keys(r.bindings).sort()) {
    console.log(`   ${key.padEnd(30)} → ${r.bindings[key].padEnd(26)} ${r.origin[key]}`);
  }
  console.log(
    `   本趟新建：KV ${account.created.kv.length} 顆、D1 ${account.created.d1.length} 顆、` +
      `Vectorize ${account.created.vectorize.length} 顆` +
      `｜沿用既有版本標籤 ARCRUN_BUNDLE_VERSION=` +
      `${r.liveVars['arcrun-cypher-executor']?.ARCRUN_BUNDLE_VERSION ?? '（無，全新安裝）'}\n`,
  );
}
