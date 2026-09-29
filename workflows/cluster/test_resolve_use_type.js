#!/usr/bin/env node
// inkstone/arcrun-rag#13 c15236：本機迴歸測試——
// `rag_cluster_auto_resolve_use_type_node.js` 要在「呼叫端沒帶 use_type」時
// 退回固定字串 'ticket'／'ticket_auto'，絕不能把 `{{input.use_type}}` 這種
// 沒代入的字面模板字串當成真的 use_type 送進 read_criteria／read_group 的
// 查詢參數（c14949／c15011 那個坑的同一個機制，這次換了個位置）。
//
// 用法：node workflows/cluster/test_resolve_use_type.js
// 退出碼：0=全部通過；1=至少一條情境失敗。
const fs = require('fs');
const path = require('path');
const { simulateCodeNode } = require('./arcrun_code_node_sim');

const HERE = __dirname;
const code = fs.readFileSync(path.join(HERE, 'rag_cluster_auto_resolve_use_type_node.js'), 'utf8');

let failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail}`);
}

// 情境 1：完全沒帶 use_type（Gitea webhook 開票路徑的真實形狀）→ 退回 'ticket'／'ticket_auto'。
{
  const r = simulateCodeNode(code, {});
  check('S1 success', r.success === true, JSON.stringify(r));
  check('S1 criteria_use_type', r.data && r.data.criteria_use_type === 'ticket', JSON.stringify(r));
  check('S1 group_use_type', r.data && r.data.group_use_type === 'ticket_auto', JSON.stringify(r));
}

// 情境 2：帶了沒代入的字面模板字串（呼叫端引用的上游欄位剛好也沒被代入時
// 會長這樣）→ 一樣要被 opt() 當成沒傳，退回預設值，不能把這串字面文字
// 當成真的 use_type 送進查詢參數。
{
  const r = simulateCodeNode(code, { use_type: '{{input.use_type}}' });
  check('S2 success', r.success === true, JSON.stringify(r));
  check('S2 criteria_use_type', r.data && r.data.criteria_use_type === 'ticket', JSON.stringify(r));
  check('S2 group_use_type', r.data && r.data.group_use_type === 'ticket_auto', JSON.stringify(r));
}

// 情境 3：正常帶 use_type='wiki'（rag_ingest_card 內部呼叫的形狀）→ 兩桶都用
// 原名，不套 'ticket_auto' 那條特殊映射。
{
  const r = simulateCodeNode(code, { use_type: 'wiki' });
  check('S3 success', r.success === true, JSON.stringify(r));
  check('S3 criteria_use_type', r.data && r.data.criteria_use_type === 'wiki', JSON.stringify(r));
  check('S3 group_use_type', r.data && r.data.group_use_type === 'wiki', JSON.stringify(r));
}

// 情境 4：正常帶 use_type='ticket'（明講的，跟沒帶時的預設值恰好一樣）→
// 行為要跟情境 1 一致。
{
  const r = simulateCodeNode(code, { use_type: 'ticket' });
  check('S4 success', r.success === true, JSON.stringify(r));
  check('S4 criteria_use_type', r.data && r.data.criteria_use_type === 'ticket', JSON.stringify(r));
  check('S4 group_use_type', r.data && r.data.group_use_type === 'ticket_auto', JSON.stringify(r));
}

if (failures.length) {
  console.error('❌ test_resolve_use_type.js 失敗：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
} else {
  console.log('✅ test_resolve_use_type.js 全部通過（4 條情境）');
  process.exit(0);
}
