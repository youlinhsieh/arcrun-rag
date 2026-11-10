/**
 * stage-queue-gate.test.mjs（inkstone/arcrun-rag#271 擴大版）
 * 跑法：node --test installer/scripts/stage-queue-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStageQueue, ticketsIn, fetchLiveCommit } from './stage-queue-gate.mjs';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
let n = 0;
function commit(dir, msg) {
  writeFileSync(join(dir, `f${n++}.txt`), String(n));
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}
/** main: m0 m1(#10) m2(#11)；分支 side 從 m1 岔出 s1(#99) */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'stage-queue-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const m0 = commit(dir, 'm0 base');
  const m1 = commit(dir, 'fix a (inkstone/Arcrun#10)');
  const m2 = commit(dir, 'fix b #11');
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);
  git(dir, ['checkout', '-q', '-b', 'side', m1]);
  const s1 = commit(dir, 'side work #99');
  git(dir, ['update-ref', 'refs/remotes/origin/side', 'side']);
  git(dir, ['checkout', '-q', 'main']);
  const m3 = commit(dir, 'fix c #12');
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);
  return { dir, m0, m1, m2, m3, s1 };
}
const live = (commit) => async () => ({ ok: true, json: async () => ({ bundle_version: '1.4.143', bundle_commit: commit.slice(0, 12) }) });
const run = (f, cur, liveCommit, extra = {}) =>
  checkStageQueue({ repo: f.dir, currentSha: cur, liveHealthUrl: 'https://x', fetchImpl: live(liveCommit), ...extra });

test('ticketsIn 抓 #號碼與 owner/repo#號碼、去重', () => {
  assert.deepEqual(ticketsIn('fix (inkstone/Arcrun#10) and #11, #11'), ['inkstone/Arcrun#10', '#11']);
});

test('同號碼兩種寫法只留一筆（優先 owner/repo#N）', () => {
  assert.deepEqual(ticketsIn('#357 and inkstone/Arcrun#357'), ['inkstone/Arcrun#357']);
});

test('🔴 來源不在 main ⇒ 擋', async () => {
  const f = fixture();
  const r = await run(f, f.s1, f.m2);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'not-on-main');
  assert.match(r.message, /不在 origin\/main/);
});

test('🔴 線上那一顆不在 main ⇒ 預設擋，叫人先併 main，列票號', async () => {
  const f = fixture();
  const r = await run(f, f.m3, f.s1);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'live-not-on-main');
  assert.match(r.message, /不在 origin\/main/);
  assert.match(r.message, /#99/);
  assert.match(r.message, /STAGE_QUEUE_DISCARD_LIVE=/);
});

test('明講丟哪一顆 ⇒ 放行，且回傳被丟的 commit／票（進出貨報告）', async () => {
  const f = fixture();
  const r = await run(f, f.m3, f.s1, { discard: f.s1.slice(0, 7) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'discarded');
  assert.deepEqual(r.discarded.tickets, ['#99']);
  assert.equal(r.discarded.commits.length, 1);
});

test('丟錯顆（前綴對不上線上那顆）⇒ 仍擋', async () => {
  const f = fixture();
  const r = await run(f, f.m3, f.s1, { discard: f.m1.slice(0, 7) });
  assert.equal(r.ok, false);
});

test('🔴 在 main 上但不含線上那一顆 ⇒ 擋，列少掉的 commit 與票', async () => {
  const f = fixture();
  const r = await run(f, f.m1, f.m2);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'missing-live');
  assert.match(r.message, /少了 1 筆/);
  assert.match(r.message, /#11/);
});

test('同一顆 ⇒ 過', async () => {
  const f = fixture();
  const r = await run(f, f.m2, f.m2);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'same');
});

test('後代 ⇒ 過，並列出相對線上多帶的票', async () => {
  const f = fixture();
  const r = await run(f, f.m3, f.m1);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'descendant');
  assert.deepEqual([...r.carried.tickets].sort(), ['#11', '#12']);
});

test('查不到線上那一顆（health 掛了）⇒ fail closed', async () => {
  const f = fixture();
  const r = await checkStageQueue({ repo: f.dir, currentSha: f.m3, liveHealthUrl: 'https://x', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'live-unknown');
});

test('線上沒蓋印（health 無 bundle_commit）⇒ 擋', async () => {
  const r = await fetchLiveCommit('https://x', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  assert.match(r.error, /沒有 bundle_commit/);
});

test('線上那顆在本 repo 找不到 ⇒ 擋並指示 fetch；丟棄可放行', async () => {
  const f = fixture();
  const r = await run(f, f.m3, 'deadbeefcafe1234');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'live-not-in-repo');
  const d = await run(f, f.m3, 'deadbeefcafe1234', { discard: 'deadbee' });
  assert.equal(d.ok, true);
});

test('找不到 origin/main ⇒ 擋（不猜）', async () => {
  const f = fixture();
  const r = await run(f, f.m3, f.m1, { mainRef: 'origin/nope' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no-main');
});
