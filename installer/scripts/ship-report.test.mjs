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
import { recordRun, renderComparisonTable, readLedger } from './ship-report.mjs';

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
