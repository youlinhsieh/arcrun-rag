#!/usr/bin/env node
// inkstone/arcrun-rag#13：`rag_cluster_auto_decide_node.js` 的本機迴歸測試。
// 每一輪修好一個真 bug 就在這裡補一條情境，避免下一輪改壞了沒人發現
// （本檔的存在本身就是對「每次都用 node -e 手打一次性測試、測完就丟」這個
// 習慣的修正——c14992／c15007／c15011 三輪都是先手打驗證過，事後才回頭
// 整理成這支可重複執行的檔案）。
//
// 🔴 c15011：所有「應該失敗」的情境一律用 `simulateCodeNode`（見
// arcrun_code_node_sim.js）模擬真實 Arcrun `code` 零件的信封包裝，對著
// **信封的頂層 `.success`** 斷言——不要直接呼叫 decide 拿返回值看它自己的
// `.success` 欄位。這兩件事在「函式 `return {success:false}`」的情況下不
// 一樣：c14992／c15011 兩輪都先寫成 `return`，本機測試直接看返回值都顯示
// 通過，但 stage 上會撞到「graph-executor 看到的頂層仍是 success:true，
// 照樣走 ON_SUCCESS」——這正是本檔案要攔住的那個假陽性。
//
// 用法：node workflows/cluster/test_decide_regression.js
// 退出碼：0=全部通過；1=至少一條情境失敗（印出哪一條、預期什麼、實際什麼）。
const fs = require('fs');
const path = require('path');
const { simulateCodeNode } = require('./arcrun_code_node_sim');

const HERE = __dirname;
const decideCode = fs.readFileSync(path.join(HERE, 'rag_cluster_auto_decide_node.js'), 'utf8');

// 「應該成功」的情境：直接呼叫拿返回值即可（跟舊版一致，成功路徑不涉及
// throw／envelope 落差問題）。
function runDecide(input) {
  const fn = new Function('input', decideCode + '\n');
  return fn(input);
}
// 「應該失敗」的情境：一律走信封模擬，斷言頂層 success:false。
function runDecideEnvelope(input) {
  return simulateCodeNode(decideCode, input);
}

const EMPTY_CRITERIA = JSON.stringify({ success: true, records: [] });
let failures = [];

function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail}`);
}

// ── 情境 1：空群 + 新項目 → new + POST ──────────────────────────────────
{
  const r = runDecide({
    group_raw: JSON.stringify({ success: true, records: [] }),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: 'unittest1',
    item_id: 'itemA',
    item_title: '貓咪的飲食習慣與健康管理',
    item_labels: [],
  });
  check('1-empty-group-new', r.success && r.action === 'new' && r.group_write_method === 'POST',
    `success=${r.success} action=${r.action} method=${r.group_write_method}`);
  check('1-new-cluster-member-count-is-1', r.cluster_member_count === '1',
    `cluster_member_count=${r.cluster_member_count}（新群應該從 1 開始）`);

  // ── 情境 2：接著 attach 到情境 1 產生的群 → attach + PATCH，record_id 正確代入 ──
  const groupRec = {
    record_id: 'rec_existing123',
    values: {
      use_type: 'unittest1', cluster_id: r.cluster_id, centroid_json: r.final_centroid_json,
      size: '1', rep_labels_json: '[]', member_ids_json: r.group_member_ids_json,
    },
  };
  const r2 = runDecide({
    group_raw: JSON.stringify({ success: true, records: [groupRec] }),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: 'unittest1',
    item_id: 'itemB',
    item_title: '貓咪的飲食習慣與健康管理進階版',
    item_labels: [],
  });
  check('2-attach-patch', r2.success && r2.action === 'attach' && r2.group_write_method === 'PATCH' &&
    r2.group_write_url === 'https://example.workers.dev/kbdb/records/rec_existing123',
    `success=${r2.success} action=${r2.action} method=${r2.group_write_method} url=${r2.group_write_url}`);
  check('2-attach-member-count-is-2', r2.cluster_member_count === '2',
    `cluster_member_count=${r2.cluster_member_count}（attach 到 size=1 的群，應該變 2）`);
}

// ── 情境 3：跨 use_type 隔離——別的 use_type 的群不會被當成候選 ───────────
{
  const otherTypeGroup = { success: true, records: [{ record_id: 'rec_other', values: { use_type: 'othertype', cluster_id: 'x', centroid_json: '{}', size: '5', rep_labels_json: '[]', member_ids_json: '[]' } }] };
  const r = runDecide({
    group_raw: JSON.stringify(otherTypeGroup),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: 'unittest1',
    item_id: 'itemC',
    item_title: '完全不相關的內容關於狗',
    item_labels: [],
  });
  check('3-cross-use-type-isolated', r.success && r.action === 'new' && r.existing_cluster_count === 0,
    `success=${r.success} action=${r.action} existing_cluster_count=${r.existing_cluster_count}`);
}

// ── 情境 4：舊 ticket 路徑（repo/number/title/labels 形狀 + 未代入的可選欄位）迴歸 ──
{
  const r = runDecide({
    group_raw: JSON.stringify({ success: true, records: [] }),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: '{{input.use_type}}', item_id: '{{input.item_id}}',
    item_title: '{{input.item_title}}', item_labels: '{{input.item_labels}}',
    repo: 'inkstone/e2e-sandbox', number: 42, title: '身為工人，我要驗收，我才安心', labels: [],
  });
  check('4-ticket-path-regression', r.success && r.use_type === 'ticket_auto' && r.item_id === 'inkstone/e2e-sandbox#42' && r.action === 'new',
    `success=${r.success} use_type=${r.use_type} item_id=${r.item_id} action=${r.action}`);
}

// ── 情境 5（c15007）：附近有一個「最像但沒過門檻」的既有群時，新開的群成員數
//    必須從 1 開始，不能繼承那個既有群的 size ──────────────────────────────
//
// 🔴 這條情境第一版寫錯過（誠實記錄，別再犯）：一開始把候選群的 size 設成
// 20（想模擬「一個大群」），但 decide.js 的候選比較迴圈本來就會跳過
// `size >= sizeCap`（預設 8）的群（`existingClusters.forEach` 裡
// `if ((c.size||0) >= sizeCap) return;`）——size=20 的群根本不會進入候選
// 比較，`bestCluster` 全程是 null，用舊版（有 bug 的）公式算出來也剛好是 1，
// 看起來「通過」但其實完全沒測到真正的 bug（用重新引入 c15007 那個 bug 的
// 版本跑過一次才發現：這條情境不管有沒有修都回 1，是假陽性）。改成
// size=3（低於 sizeCap，真的會進入候選比較、真的會被設成 bestCluster），
// 才驗證過能分辨新舊版：舊版（bug）在這個情境下算出 4，新版（修好）正確算出 1。
{
  const nearbyRejectedGroup = {
    record_id: 'rec_nearby_rejected',
    values: {
      use_type: 'c15007test', cluster_id: 'c15007test-nearby-rejected',
      centroid_json: JSON.stringify({ 狗: 0.5, 貓: 0.5, 寵物: 0.5, 飼養: 0.5 }),
      size: '3', rep_labels_json: '[]', member_ids_json: '[]',
    },
  };
  const r = runDecide({
    group_raw: JSON.stringify({ success: true, records: [nearbyRejectedGroup] }),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: 'c15007test',
    item_id: 'newitem-1',
    item_title: '企業請款單自動審核流程優化',
    item_labels: [],
  });
  check('5-new-cluster-does-not-inherit-rejected-candidate-size',
    r.success && r.action === 'new' && r.existing_cluster_count === 1 && r.cluster_member_count === '1',
    `success=${r.success} action=${r.action} existing_cluster_count=${r.existing_cluster_count} cluster_member_count=${r.cluster_member_count}` +
    `（附近有 size=3、低於 sizeCap 因此真的會被列入候選但沒過門檻的群時，新群 size 應該是 1，不是 4——這是 c15007 抓到的 main 上既有 bug；existing_cluster_count 必須是 1 才能確認候選真的被比較過，不是被 sizeCap 跳過）`);
}

// ── 情境 6（c15011）：item_id／repo／number 全部沒傳或沒代入時，decide 必須
//    真的 throw（頂層信封 success:false），不能只是內部 return {success:false}
//    ──────────────────────────────────────────────────────────────────────
{
  const env = runDecideEnvelope({
    group_raw: JSON.stringify({ success: true, records: [] }),
    criteria_raw: EMPTY_CRITERIA,
    cypher_base: 'https://example.workers.dev',
    use_type: 'wiki',
    item_id: undefined, item_title: '某張沒帶 page_name 的卡的標題', item_labels: [],
    // 沒傳 repo/number（wiki 用途本來就沒有這兩個欄位）
  });
  check('6-empty-item-id-throws-at-envelope-level',
    env.success === false && typeof env.error === 'string' && /item_id/.test(env.error),
    `envelope=${JSON.stringify(env)}（item_id 與 repo/number 都沒給，組出來會是 "#"，這裡必須在信封頂層就是 success:false，不能只是 decide 內部 return 的 success:false——那樣 graph-executor 的 isFailure() 看不到，照樣走 ON_SUCCESS，這正是 c15011 在 stage 撞到的真因）`);
}

if (failures.length) {
  console.error('❌ 以下情境沒過：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✅ 6 個迴歸情境全部通過（空群新開 / attach+PATCH / 跨 use_type 隔離 / 舊 ticket 路徑 / 新群不繼承無關大群的 size / item_id 無法識別時真的 throw，不只是 return）。');
process.exit(0);
