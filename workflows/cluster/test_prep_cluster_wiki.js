#!/usr/bin/env node
// inkstone/arcrun-rag#13 c15011：本機迴歸測試——`rag-ingest-card.local.yaml`
// 的 `prep_cluster_wiki` 節點在拒收未代入樣板字串時，必須讓 Arcrun `code`
// 零件的信封真的變成 `{success:false,...}`（觸發 ON_FAIL），不能只是節點自己
// `return {success:false}`（那只是 `.data` 底下的普通資料，外層信封仍是
// success:true，圖執行器照樣走 ON_SUCCESS——這正是總管在 stage 撞到「B 不帶
// page_name 卻寫進 item_id "#"」的真因，見 arcrun_code_node_sim.js 檔頭）。
//
// 用法：node workflows/cluster/test_prep_cluster_wiki.js
// 退出碼：0=全部通過；1=至少一條情境失敗。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { simulateCodeNode } = require('./arcrun_code_node_sim');

const HERE = __dirname;
const YAML_PATH = path.join(HERE, '..', 'rag-ingest-card.local.yaml');

// 用 python3+pyyaml 抽出 config.prep_cluster_wiki.code（跟本 repo既有
// compile-workflows.mjs 用 python3+pyyaml 讀 workflow YAML 是同一套工具鏈，
// 不另外引入 node 端的 YAML parser 依賴）。
const extractScript = `
import sys, yaml
with open(${JSON.stringify(YAML_PATH)}, encoding='utf-8') as f:
    doc = yaml.safe_load(f)
print(doc['config']['prep_cluster_wiki']['code'], end='')
`;
let prepClusterWikiCode;
try {
  prepClusterWikiCode = execFileSync('python3', ['-c', extractScript], { encoding: 'utf-8' });
} catch (e) {
  console.error('❌ 用 python3+pyyaml 抽取 prep_cluster_wiki.code 失敗（本機需要 python3 與 pyyaml，跟 compile-workflows.mjs 的既有前置一致）：', e.message);
  process.exit(1);
}
if (!prepClusterWikiCode || !prepClusterWikiCode.trim()) {
  console.error('❌ 抽出來的 prep_cluster_wiki.code 是空的——rag-ingest-card.local.yaml 的結構可能變了，這支腳本需要更新');
  process.exit(1);
}

let failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail}`);
}

// ── 情境 1：有效 page_name → 信封 success:true，item_id/item_title 正確 ──
{
  const env = simulateCodeNode(prepClusterWikiCode, {
    page_name: 'c14949-wiki-verify-A',
    blocks: [{ content: '這是一段卡片內文，用來測 snippet 截斷。' }],
  });
  check('1-valid-page-name-succeeds',
    env.success === true && env.data && env.data.item_id === 'kb://c14949-wiki-verify-A',
    `envelope=${JSON.stringify(env)}`);
}

// ── 情境 2：page_name 完全沒帶（undefined）→ 信封頂層必須是 success:false ──
{
  const env = simulateCodeNode(prepClusterWikiCode, {
    page_name: undefined,
    blocks: [{ content: '不該被送進分群的內文' }],
  });
  check('2-missing-page-name-fails-at-envelope-level',
    env.success === false && typeof env.error === 'string',
    `envelope=${JSON.stringify(env)}（page_name 完全沒帶時，信封頂層必須是 success:false 才會觸發 ON_FAIL）`);
}

// ── 情境 3：page_name 是未代入的字面模板字串（呼叫端模板引擎沒代入成功時的
//    真實形狀，stage 上撞到的就是這個）→ 信封頂層必須是 success:false ──
{
  const env = simulateCodeNode(prepClusterWikiCode, {
    page_name: '{{input.page_name}}',
    blocks: [{ content: '不該被送進分群的內文' }],
  });
  check('3-unresolved-template-literal-fails-at-envelope-level',
    env.success === false && typeof env.error === 'string',
    `envelope=${JSON.stringify(env)}（page_name 是字面上的 {{input.page_name}} 時，信封頂層必須是 success:false）`);
}

// ── 情境 4：page_name 是 parse_card 自己退回的 'unknown'（見
//    rag-ingest-card.local.yaml 的 parse_card 節點：
//    `String(input.page_name || 'unknown')`）→ 信封頂層必須是 success:false ──
{
  const env = simulateCodeNode(prepClusterWikiCode, {
    page_name: 'unknown',
    blocks: [{ content: '不該被送進分群的內文' }],
  });
  check('4-parse-card-fallback-unknown-fails-at-envelope-level',
    env.success === false && typeof env.error === 'string',
    `envelope=${JSON.stringify(env)}（page_name 是 parse_card 自己的 fallback 'unknown' 時，信封頂層必須是 success:false）`);
}

if (failures.length) {
  console.error('❌ 以下情境沒過：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✅ 4 個 prep_cluster_wiki 情境全部通過（有效 page_name 成功 / 缺失、未代入樣板、parse_card fallback 三種無效情況都在信封頂層 success:false，會真的觸發 ON_FAIL）。');
process.exit(0);
