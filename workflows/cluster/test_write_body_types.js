#!/usr/bin/env node
// inkstone/arcrun-rag#13 c14992：總管 stage 實跑抓到「write_group 被 KBDB 拒寫
// （values must be an object of {slot: string}）」——本機 node 重播（replay）
// 完全測不到這個，因為重播只驗證分群決策本身對不對，不會真的打 KBDB API
// 驗證欄位型別。這支腳本補這一段：**不猜哪些欄位可能有問題，直接讀
// rag_cluster_auto.deployed.json 裡 write_membership／write_group 兩個
// http_request 節點實際會送給 KBDB 的 body_json.values**，對每一個
// `{{decide.data.X}}` 引用，跑一次 decide.js 拿到真實輸出，斷言型別是字串。
//
// 用法：node workflows/cluster/test_write_body_types.js
// 退出碼：0=全部通過；1=至少一個欄位型別不對（印出哪個節點、哪個 slot、
//   引用 decide 的哪個欄位、實際型別是什麼）。
//
// 🔴 已知限制（誠實列）：這支腳本只檢查「引用 decide.data.X」這種形狀的
// body_json.values（目前 write_membership／write_group 都是這個形狀）；
// 如果之後有節點用別的方式組 values（例如引用別的節點輸出、或字面常數），
// 這支腳本不會去檢查那些——常數本身型別固定不會漂移，別的節點輸出型別問題
// 留給那個節點自己的測試。也不檢查 post_hub_card／post_toc_entry／
// post_split_proposal／post_merge_proposal（它們引用 hub_editor／
// finalize_hub_card／build_*_proposal 的輸出，那幾支節點自己已經在程式碼
// 內用 String() 轉過，且不是這次退回抓到的節點）。
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const decideCode = fs.readFileSync(path.join(HERE, 'rag_cluster_auto_decide_node.js'), 'utf8');
const deployed = JSON.parse(fs.readFileSync(path.join(HERE, 'rag_cluster_auto.deployed.json'), 'utf8'));

function runDecide(input) {
  const fn = new Function('input', decideCode + '\n');
  return fn(input);
}

// 組一個「attach 情境」的 decide 呼叫（欄位覆蓋率最高：existing group、merge
// 候選、cluster_member_count > 0 等，比 new 情境更容易暴露漏轉字串的欄位）。
const seedGroup = {
  record_id: 'rec_typecheck_seed',
  values: {
    use_type: 'typecheck',
    cluster_id: 'typecheck-seed-1',
    centroid_json: JSON.stringify({ 測試: 0.7, 型別: 0.7 }),
    size: '1',
    rep_labels_json: JSON.stringify(['s/doing']),
    member_ids_json: JSON.stringify([{ id: 'seed-1', title: '型別檢查種子項目' }]),
  },
};
const decideOutput = runDecide({
  group_raw: JSON.stringify({ success: true, records: [seedGroup] }),
  criteria_raw: JSON.stringify({ success: true, records: [] }),
  cypher_base: 'https://example.workers.dev',
  use_type: 'typecheck',
  item_id: 'typecheck-item-2',
  item_title: '型別檢查測試項目',
  item_labels: ['s/doing', 'area/test'],
});

if (!decideOutput.success) {
  console.error('❌ decide.js 本身回 success:false（不該發生，seed 輸入應該正常）：', decideOutput.error);
  process.exit(1);
}

const TARGET_NODES = ['write_membership', 'write_group'];
let failures = [];

for (const node of deployed.graph.nodes) {
  if (!TARGET_NODES.includes(node.id)) continue;
  const values = node.data && node.data.body_json && node.data.body_json.values;
  if (!values) continue;
  for (const [slot, template] of Object.entries(values)) {
    const m = /^\{\{decide\.data\.([a-zA-Z0-9_]+)\}\}$/.exec(String(template));
    if (!m) continue; // 字面常數或別的引用形狀，不在這支腳本檢查範圍（見檔頭已知限制）
    const field = m[1];
    const value = decideOutput[field];
    if (typeof value !== 'string') {
      failures.push(`node=${node.id} slot=${slot} <- decide.data.${field} 型別=${typeof value}（值：${JSON.stringify(value)}）`);
    }
  }
}

if (failures.length) {
  console.error('❌ 以下欄位不是字串，KBDB 的 /kbdb/records 會回 400「values must be an object of {slot: string}」：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}

console.log('✅ write_membership／write_group 兩個節點引用的 decide.data.* 欄位全部是字串。');
process.exit(0);
