/**
 * ship-report.test.mjs — 證明左右對照表真的會讓「清單不對等」現形（D65 二次補述）。
 *
 * 跑法：node --test installer/scripts/ship-report.test.mjs
 * （零依賴、全程用臨時目錄，不碰任何真的 repo/ledger）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRun, renderComparisonTable, readLedger, assertSourceParity } from './ship-report.mjs';

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-test-'));
  return dir;
}

test('🔴 prod 少跑一項（docs-changelog 被 promoteFrom 跳過）⇒ 表上是空格，不是安撫用語', () => {
  const repo = tempRepo();
  try {
    const stageResults = [
      { id: 'preflight', title: '對齊目標', status: 'done' },
      { id: 'docs-changelog', title: '確認這版已經寫進說明文件', status: 'done' },
      { id: 'readme', title: 'README 由零件清單算出來', status: 'done' },
    ];
    // prod 這次的清單「少了」docs-changelog——模擬修好之前的病。
    const prodResults = [
      { id: 'preflight', title: '對齊目標', status: 'done' },
      { id: 'readme', title: 'README 由零件清單算出來', status: 'done' },
    ];
    recordRun(repo, { release: '1.4.33', target: 'stage', results: stageResults, sourceCommit: 'Arcrun@aaa' });
    recordRun(repo, { release: '1.4.33', target: 'prod', results: prodResults, sourceCommit: 'Arcrun@aaa' });

    const table = renderComparisonTable(repo, '1.4.33');
    assert.ok(table.includes('共 3 站'), table); // 聯集＝3（docs-changelog 有出現在聯集裡，不會被吃掉）
    const changelogLine = table.split('\n').find((l) => l.includes('確認這版已經寫進說明文件'));
    assert.ok(changelogLine, '這一項必須出現在表上——不對稱的東西不准整列消失\n' + table);
    assert.ok(changelogLine.includes('（未出）'), `prod 那一欄應該顯形成「未出」，實際：${changelogLine}`);
    assert.ok(!changelogLine.includes('⏭'), '不准用安撫用語代替空格');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('✅ 修好之後：兩邊清單一致 ⇒ 兩欄都是 ✅，沒有空格', () => {
  const repo = tempRepo();
  try {
    const results = [
      { id: 'preflight', title: '對齊目標', status: 'done' },
      { id: 'docs-changelog', title: '確認這版已經寫進說明文件', status: 'done' },
    ];
    recordRun(repo, { release: '1.4.34', target: 'stage', results, sourceCommit: 'Arcrun@bbb' });
    recordRun(repo, { release: '1.4.34', target: 'prod', results, sourceCommit: 'Arcrun@bbb' });
    const table = renderComparisonTable(repo, '1.4.34');
    assert.ok(!table.includes('（未出）'), table);
    const lines = table.split('\n').filter((l) => l.startsWith('| 1 ') || l.startsWith('| 2 '));
    for (const l of lines) assert.ok(l.includes('✅'), l);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('🆕 這次多了一站（README 進清單）⇒ 報告標「共 N 站（上次 M 站　＋README）」', () => {
  const repo = tempRepo();
  try {
    const prevResults = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.32', target: 'stage', results: prevResults, sourceCommit: 'Arcrun@x' });
    recordRun(repo, { release: '1.4.32', target: 'prod', results: prevResults, sourceCommit: 'Arcrun@x' });

    const newResults = [
      { id: 'preflight', title: '對齊目標', status: 'done' },
      { id: 'public-docs', title: 'README', status: 'done' },
    ];
    recordRun(repo, { release: '1.4.33', target: 'stage', results: newResults, sourceCommit: 'Arcrun@y' });
    recordRun(repo, { release: '1.4.33', target: 'prod', results: newResults, sourceCommit: 'Arcrun@y' });

    const table = renderComparisonTable(repo, '1.4.33');
    assert.ok(table.includes('共 2 站'), table);
    assert.ok(table.includes('上次（1.4.32）1 站'), table);
    assert.ok(table.includes('＋public-docs'), table);
    assert.ok(table.includes('🆕 本次新增'), table);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('🗑 上次有這次沒有的一站 ⇒ 報告用「−」點名，並在表尾追加警示', () => {
  const repo = tempRepo();
  try {
    const prevResults = [
      { id: 'preflight', title: '對齊目標', status: 'done' },
      { id: 'docs-changelog', title: '確認這版已經寫進說明文件', status: 'done' },
    ];
    recordRun(repo, { release: '1.4.32', target: 'stage', results: prevResults, sourceCommit: 'Arcrun@x' });
    recordRun(repo, { release: '1.4.32', target: 'prod', results: prevResults, sourceCommit: 'Arcrun@x' });

    const newResults = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.33', target: 'stage', results: newResults, sourceCommit: 'Arcrun@y' });
    recordRun(repo, { release: '1.4.33', target: 'prod', results: newResults, sourceCommit: 'Arcrun@y' });

    const table = renderComparisonTable(repo, '1.4.33');
    assert.ok(table.includes('−docs-changelog'), table);
    assert.ok(table.includes('如果不是刻意拿掉，這就是漏了'), table);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('第一次出貨（沒有上一輪可比）⇒ 誠實說「沒有上一次可比對」，不假裝有基準', () => {
  const repo = tempRepo();
  try {
    recordRun(repo, {
      release: '1.0.0', target: 'stage',
      results: [{ id: 'preflight', title: 'x', status: 'done' }],
      sourceCommit: 'Arcrun@z',
    });
    const table = renderComparisonTable(repo, '1.0.0');
    assert.ok(table.includes('沒有上一次可比對'), table);
    assert.ok(table.includes('來源（prod）＝（未出）'), 'prod 這次根本沒跑，來源要老實印「未出」\n' + table);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('同一個 release 重跑同一個 target ⇒ 覆蓋，不是疊加成兩筆', () => {
  const repo = tempRepo();
  try {
    recordRun(repo, { release: '1.4.35', target: 'stage', results: [{ id: 'a', title: 'A', status: 'failed' }] });
    recordRun(repo, { release: '1.4.35', target: 'stage', results: [{ id: 'a', title: 'A', status: 'done' }] });
    const ledger = readLedger(repo);
    assert.equal(ledger['1.4.35'].stage.results.length, 1);
    assert.equal(ledger['1.4.35'].stage.results[0].status, 'done');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('recordRun 缺 release 或 target ⇒ 丟例外，不靜默寫出一筆壞資料', () => {
  const repo = tempRepo();
  try {
    assert.throws(() => recordRun(repo, { target: 'stage', results: [] }));
    assert.throws(() => recordRun(repo, { release: '1.0.0', results: [] }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 缺②（arcrun-rag#73 二次補述）：來源 commit 比對從「看得到」升級成「不一致就斷」──
// promoteFrom 拆掉之後，prod 不再靠複製 stage 的 manifest.source 天然保證一致，
// 這裡要證明：「製造一次不一致」真的會斷，不是印出兩個不同的值就算了。

test('🔴 製造一次不一致：stage 與 prod 同一個 release，來源 commit 不一樣 ⇒ 丟例外，不寫入', () => {
  const repo = tempRepo();
  try {
    const results = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.40', target: 'stage', results, sourceCommit: 'Arcrun@aaa1111' });

    assert.throws(
      () => recordRun(repo, { release: '1.4.40', target: 'prod', results, sourceCommit: 'Arcrun@bbb2222' }),
      /來源 commit 對不上|兩個理貨員拿的不是同一張訂單/,
    );

    // 沒寫入——ledger 裡 prod 這次的紀錄不該存在（斷了就是斷了，不留半筆壞資料）。
    const ledger = readLedger(repo);
    assert.equal(ledger['1.4.40'].prod, undefined, '拒絕寫入時不該留下任何 prod 的紀錄');
    assert.equal(ledger['1.4.40'].stage.sourceCommit, 'Arcrun@aaa1111', 'stage 原本的紀錄不受影響');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('✅ stage 與 prod 同一個 release、來源 commit 一致 ⇒ 正常寫入，不誤傷', () => {
  const repo = tempRepo();
  try {
    const results = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.41', target: 'stage', results, sourceCommit: 'Arcrun@ccc3333' });
    recordRun(repo, { release: '1.4.41', target: 'prod', results, sourceCommit: 'Arcrun@ccc3333' });
    const ledger = readLedger(repo);
    assert.equal(ledger['1.4.41'].prod.sourceCommit, 'Arcrun@ccc3333');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('✅ 只有一邊出過這一版（另一邊還沒出）⇒ 不算不一致，正常寫入', () => {
  const repo = tempRepo();
  try {
    const results = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.42', target: 'stage', results, sourceCommit: 'Arcrun@ddd4444' });
    assert.doesNotThrow(() =>
      assertSourceParity(readLedger(repo), { release: '1.4.42', target: 'prod', sourceCommit: null }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('✅ 同一個 target 重跑同一個 release（覆蓋自己）⇒ 不算跟自己不一致', () => {
  const repo = tempRepo();
  try {
    const results = [{ id: 'preflight', title: '對齊目標', status: 'done' }];
    recordRun(repo, { release: '1.4.43', target: 'stage', results, sourceCommit: 'Arcrun@eee5555' });
    // 同一個 target、同一個 release 重跑（例如失敗重試後成功）——即使來源 commit
    // 沒變，也不該被自己的舊紀錄擋下來。
    assert.doesNotThrow(() =>
      recordRun(repo, { release: '1.4.43', target: 'stage', results, sourceCommit: 'Arcrun@eee5555' }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 「站數沒變但內容變空了」（2026-08-11 複驗抓到，arcrun-rag#77）───────────
// 實錄：1.4.37 stage 有 9 站 skip、1.4.36 只有 4 站 ⇒ 這次少做 5 站，
// 而表頭寫「共 19 站（上次 19 站　無增減）」——完全看不出來。
// `⬜` 同時代表「沒事可做」與「沒做到」⇒ 差別被藏起來。
test('🔴 站數一樣但做的事變少 ⇒ 表上要現形（不是把空白變不見）', () => {
  const repo = tempRepo();
  try {
    const mk = (statuses) => Object.entries(statuses).map(([id, status]) =>
      ({ id, title: id, status, note: status === 'skip' ? `${id} 沒事可做` : null }));
    recordRun(repo, { release: '1.5.0', target: 'stage', sourceCommit: 'Arcrun@aaa',
      results: mk({ build: 'done', commit: 'done', push: 'done', deploy: 'done' }) });
    recordRun(repo, { release: '1.5.1', target: 'stage', sourceCommit: 'Arcrun@bbb',
      results: mk({ build: 'done', commit: 'skip', push: 'skip', deploy: 'skip' }) });

    const table = renderComparisonTable(repo, '1.5.1');
    // 站數確實沒變——這正是原本看不出問題的原因
    assert.match(table, /共 4 站/);
    assert.match(table, /無增減/);
    // 但「真的做事」要把差別講出來
    assert.match(table, /真的做事的站：stage 1／4 站（上次 4 站）/);
    assert.match(table, /少做 3 站/);
    // 每一筆跳過都要附原因
    assert.match(table, /commit：commit 沒事可做/);
    assert.match(table, /deploy：deploy 沒事可做/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('✅ 做的事沒變少 ⇒ 不要亂叫（誤報會讓人學會忽略這行）', () => {
  const repo = tempRepo();
  try {
    const r = [{ id: 'build', title: 'build', status: 'done' }, { id: 'push', title: 'push', status: 'done' }];
    recordRun(repo, { release: '1.5.0', target: 'stage', results: r, sourceCommit: 'Arcrun@aaa' });
    recordRun(repo, { release: '1.5.1', target: 'stage', results: r, sourceCommit: 'Arcrun@bbb' });
    const table = renderComparisonTable(repo, '1.5.1');
    assert.match(table, /真的做事的站：stage 2／2 站（與上次相同）/);
    assert.ok(!table.includes('少做'), '沒變少就不該印警告');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('🔴 表格那一格仍是裸 ⬜，原因印在表外（b998df4 定的：不准用安撫用語代替空格）', () => {
  const repo = tempRepo();
  try {
    recordRun(repo, { release: '1.5.2', target: 'stage', sourceCommit: 'Arcrun@ccc',
      results: [{ id: 'push', title: '推上 bundle repo', status: 'skip', note: '已與遠端同步，沒有要推的' }] });
    const table = renderComparisonTable(repo, '1.5.2');
    const row = table.split('\n').find((l) => l.startsWith('| 1 |'));
    assert.match(row, /⬜/, '格子要維持裸 ⬜');
    assert.ok(!row.includes('已與遠端同步'), '原因不准塞進格子裡（那會讓它看起來像做完了）');
    assert.match(table, /push：已與遠端同步，沒有要推的/, '原因要印在表外');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
