/**
 * version-stamp.test.mjs — 版本／commit 兩個印記的算法（Arcrun#106 另一半）。
 *
 * 跑法：node --test installer/oauth-prototype/version-stamp.test.mjs
 *
 * 守三件事（全離線、不碰任何實例）：
 *   ① 兩個印記綁在一起出：查得到 commit 就一定貼
 *   ② **查不到就不貼，不編一個**——本 repo 有前科（t144：捏造的 commit 碼被寫進實例，
 *      之後每次重裝都被判「指紋一致」跳過，版本號永遠停在一個不存在的 commit）
 *   ③ 兩條部署路徑烙的長度不同（`acr` 40 碼／安裝器 12 碼）也要比對得動
 *      ——那正是本票的目標：**痕跡要能互相比對**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStampTarget, sourceCommitOf, versionStampVars, commitsAgree } from './version-stamp.mjs';

// ── ① 誰要被烙 ───────────────────────────────────────────────────────────────

test('①烙印對象＝cypher 與 portal 前端那兩顆，其餘零件不烙', () => {
  assert.equal(isStampTarget('arcrun-cypher-executor'), true);
  assert.equal(isStampTarget('arcrun-rag-cypher'), true);
  assert.equal(isStampTarget('arcrun-rag-ui'), true);
  assert.equal(isStampTarget('arcrun-kbdb'), false);
  assert.equal(isStampTarget('arcrun-mcp'), false);
  assert.equal(isStampTarget(''), false);
  assert.equal(isStampTarget(undefined), false);
});

// ── ② 從 manifest.source 解 commit ──────────────────────────────────────────

test('②解得出 manifest.source 的 Arcrun@<sha>（實測 prod 1.4.46 就長這樣）', () => {
  assert.equal(sourceCommitOf('Arcrun@cacaa33f7d4e'), 'cacaa33f7d4e');
  assert.equal(sourceCommitOf({ source: 'Arcrun@cacaa33f7d4e' }), 'cacaa33f7d4e');
  assert.equal(sourceCommitOf('d7a98f53a1b2c3d4e5f60718293a4b5c6d7e8f90'), 'd7a98f53a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(sourceCommitOf('Arcrun@CACAA33F7D4E'), 'cacaa33f7d4e', '大小寫一律正規化成小寫');
});

test('②b 解不出合法 sha 一律回空字串（舊 bundle 沒有 source 欄就是這種）', () => {
  for (const junk of [undefined, null, '', {}, { source: '' }, 'Arcrun@main', 'Arcrun@', 'unknown', 'Arcrun@zzzzzzz', 'Arcrun@abc']) {
    assert.equal(sourceCommitOf(junk), '', `${JSON.stringify(junk)} 不該被當成 commit`);
  }
});

// ── ③ 兩個印記一起出 ────────────────────────────────────────────────────────

test('③有 release ＋ 有 source ⇒ 版號用 release、commit 一起烙', () => {
  const v = versionStampVars({ release: '1.4.46', built: '2026-08-15', pinCommit: 'c63e86a', sourceCommit: 'Arcrun@cacaa33f7d4e' });
  assert.deepEqual(v, { ARCRUN_BUNDLE_VERSION: '1.4.46', ARCRUN_BUNDLE_COMMIT: 'cacaa33f7d4e' });
});

test('③b 🔴 查不到 commit ⇒ 少一個欄位，但版號照貼（安裝不能因此失敗，也不准編一個）', () => {
  const v = versionStampVars({ release: '1.4.46', built: '2026-08-15', pinCommit: 'c63e86a' });
  assert.deepEqual(v, { ARCRUN_BUNDLE_VERSION: '1.4.46' });
  assert.equal('ARCRUN_BUNDLE_COMMIT' in v, false, '沒有就整個欄位不存在，不是空字串');
});

test('③c 舊 bundle（沒有 release 欄）⇒ 版號退回「建置日+釘點短碼」，行為與 08-02 起一致', () => {
  const v = versionStampVars({ built: '2026-08-15', pinCommit: 'c63e86a' });
  assert.equal(v.ARCRUN_BUNDLE_VERSION, '2026-08-15+c63e86a');
  assert.doesNotMatch(v.ARCRUN_BUNDLE_VERSION, /^\d+\.\d+\.\d+$/,
    '掰一個 semver 會讓 Portal 假裝「已是最新版」——寧可被判成較舊版本');
});

test('③d 釘點短碼是 bundles repo 的碼，**不會**被拿來冒充 Arcrun 原始碼 commit', () => {
  const v = versionStampVars({ release: '1.4.46', pinCommit: 'c63e86a' });
  assert.equal('ARCRUN_BUNDLE_COMMIT' in v, false,
    'pinCommit ≠ 原始碼 commit；拿它當 commit 印記就是貼一個查不到東西的假標籤');
});

// ── ④ 跨路徑比對 ────────────────────────────────────────────────────────────

test('④同一顆 commit 兩種長度（acr 烙 40 碼／安裝器烙 12 碼）要判成一樣', () => {
  assert.equal(commitsAgree('cacaa33f7d4e', 'cacaa33f7d4e9012345678901234567890abcd'), true);
  assert.equal(commitsAgree('cacaa33f7d4e9012345678901234567890abcd', 'cacaa33f7d4e'), true);
  assert.equal(commitsAgree('CACAA33F7D4E', 'cacaa33f7d4e9012345678901234567890abcd'), true);
});

test('④b 不同的 commit 判成不一樣；比不動（空／非 hex）一律回 false（fail-stale）', () => {
  assert.equal(commitsAgree('cacaa33f7d4e', 'd7a98f53a1b2'), false);
  assert.equal(commitsAgree('', 'cacaa33f7d4e'), false);
  assert.equal(commitsAgree('cacaa33f7d4e', ''), false);
  assert.equal(commitsAgree('main', 'cacaa33f7d4e'), false);
  assert.equal(commitsAgree('abc', 'abc'), false, '太短（<7）不足以識別一顆 commit');
});
