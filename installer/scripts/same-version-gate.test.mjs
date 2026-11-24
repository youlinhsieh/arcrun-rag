/**
 * same-version-gate.test.mjs — inkstone/arcrun-rag#363 第 3 處：同一個版號不能換成另一包，要在動手前就擋。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSameVersion, readAhubStage, stageFromResponse, readRemoteReservations, checkRemoteReservation } from './same-version-gate.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FP_A = 'a'.repeat(64); const FP_B = 'b'.repeat(64);
const C1 = '1'.repeat(40); const C2 = '2'.repeat(40);
const ledger = (o = {}) => ({ releases: { '1.4.249': { commit: C1, fingerprint: FP_A, shipped: { stage: 't' } }, ...o } });

test('出貨紀錄：同版號、指紋不同 ⇒ 擋（不等最後落帳）', () => {
  const r = checkSameVersion({ ledger: ledger(), release: '1.4.249', fingerprint: FP_B, commit: C2 });
  assert.equal(r.ok, false); assert.match(r.message, /已經出過另一包/); assert.match(r.message, /不能換成另一包/);
});

test('同版號、指紋相同（prod 重打同一份／同內容換 commit）⇒ 放行', () => {
  assert.equal(checkSameVersion({ ledger: ledger(), release: '1.4.249', fingerprint: FP_A, commit: C1 }).ok, true);
  assert.equal(checkSameVersion({ ledger: ledger(), release: '1.4.249', fingerprint: FP_A, commit: C2, ahubStage: { known: true, version: '1.4.249', commit: C1 } }).ok, true);
});

test('新版號 ⇒ 放行', () => {
  const r = checkSameVersion({ ledger: ledger(), release: '1.4.250', fingerprint: FP_B, commit: C2, ahubStage: { known: true, version: '1.4.249', commit: C1 } });
  assert.equal(r.ok, true); assert.match(r.message, /新版號/);
});

test('AHub stage 已是這個版號、commit 不同、出貨紀錄對它沒記載 ⇒ 擋（別條線出的那一包這份 checkout 不認得）', () => {
  const r = checkSameVersion({ ledger: { releases: {} }, release: '1.4.249', fingerprint: FP_B, commit: C2, ahubStage: { known: true, version: '1.4.249', commit: C1 } });
  assert.equal(r.ok, false); assert.match(r.message, /AHub 的 stage 現況已經是 1\.4\.249/); assert.match(r.message, /git pull/);
  // 帶 v 前綴也要認得
  assert.equal(checkSameVersion({ ledger: { releases: {} }, release: '1.4.249', fingerprint: FP_B, commit: C2, ahubStage: { known: true, version: 'v1.4.249', commit: C1 } }).ok, false);
});

test('AHub 同版號同 commit（stage 重出同一份）⇒ 放行；AHub 讀不到 ⇒ 不擋、訊息明說沒查到', () => {
  assert.equal(checkSameVersion({ ledger: { releases: {} }, release: '1.4.249', fingerprint: FP_A, commit: C1, ahubStage: { known: true, version: '1.4.249', commit: C1 } }).ok, true);
  const r = checkSameVersion({ ledger: { releases: {} }, release: '1.4.249', fingerprint: FP_A, commit: C1, ahubStage: { known: false, reason: 'HTTP 404' } });
  assert.equal(r.ok, true); assert.match(r.message, /沒查到（HTTP 404）/);
  // 出貨紀錄那一關在 AHub 讀不到時照樣有效
  assert.equal(checkSameVersion({ ledger: ledger(), release: '1.4.249', fingerprint: FP_B, commit: C2, ahubStage: { known: false, reason: 'x' } }).ok, false);
});

test('stageFromResponse：認得幾種回應形狀；看不懂就是 null', () => {
  const want = { version: '1.4.249', commit: C1 };
  assert.deepEqual(stageFromResponse({ stage: { ...want, by: 'x' } }), want);
  assert.deepEqual(stageFromResponse({ items: [{ ...want }] }), want);
  assert.deepEqual(stageFromResponse([{ ...want }]), want);
  assert.equal(stageFromResponse({ ok: true }), null);
  assert.equal(stageFromResponse(null), null);
});

test('readAhubStage：200 讀出版號；404／壞 JSON／沒權杖／網路錯 ⇒ known:false 不丟例外，且只打 GET', async () => {
  const calls = [];
  const f = (status, body) => async (url, init) => { calls.push({ url, init }); return new Response(body, { status }); };
  const ok = await readAhubStage({ fetchImpl: f(200, JSON.stringify({ stage: { version: '1.4.249', commit: C1 } })), token: 't' });
  assert.deepEqual(ok, { known: true, version: '1.4.249', commit: C1 });
  assert.equal(calls[0].init.method, 'GET'); assert.match(calls[0].url, /\/ahub\/stage/);
  assert.equal((await readAhubStage({ fetchImpl: f(404, 'x'), token: 't' })).known, false);
  assert.equal((await readAhubStage({ fetchImpl: f(200, '<html>'), token: 't' })).known, false);
  assert.equal((await readAhubStage({ fetchImpl: f(200, '{}'), token: '' })).known, false);
  assert.equal((await readAhubStage({ fetchImpl: async () => { throw new Error('boom'); }, token: 't' })).known, false);
});

test('接線：ship.mjs 的 version 站在 verifyManifest 之前呼叫；且早於 stage-record 站（拿掉就紅）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ship.mjs'), 'utf8');
  const iCheck = src.indexOf('checkSameVersion({ ledger: readLedger(REPO_ROOT)');
  const iVerify = src.indexOf('const problems = verifyManifest(ctx.bundlesDir');
  const iStageRec = src.indexOf("{ id: 'stage-record'");
  assert.ok(iCheck > 0, 'ship.mjs 沒呼叫 checkSameVersion');
  assert.ok(iCheck < iVerify && iVerify < iStageRec, '順序要是 同版號查核 → manifest 機械閘 → … → stage-record 站');
  assert.match(src, /if \(!sv\.ok\) throw new Error\(sv\.message\)/);
});

// ── inkstone/arcrun-rag#331 ────────────────────────────────────────────────────────────
const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

test('#331 形狀一（11-18）：同版號、指紋相同、來源 commit 不同——同一條線往前走放行；分岔／倒退／查不到祖先 ⇒ 擋', () => {
  const repo = mkdtempSync(join(tmpdir(), 'svg-src-'));
  G(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), '1'); G(repo, 'add', '.'); G(repo, 'commit', '-q', '-m', 'c1'); const c1 = G(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a'), '2'); G(repo, 'commit', '-qam', 'c2'); const c2 = G(repo, 'rev-parse', 'HEAD');
  G(repo, 'checkout', '-q', '-b', 'other', c1);
  writeFileSync(join(repo, 'b'), 'x'); G(repo, 'add', '.'); G(repo, 'commit', '-q', '-m', 'o1'); const o1 = G(repo, 'rev-parse', 'HEAD');
  const isAncestor = (older, newer) => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: repo, stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; }
  };
  const led = { releases: { '1.4.246': { commit: c1, fingerprint: FP_A } } };
  const run = (commit) => checkSameVersion({ ledger: led, release: '1.4.246', fingerprint: FP_A, commit, isAncestor });
  assert.equal(run(c2).ok, true, '同一條線往前（c1 是 c2 的祖先）放行');
  assert.equal(run(c1).ok, true, '同顆 commit 放行');
  const fork = checkSameVersion({ ledger: { releases: { '1.4.246': { commit: c2, fingerprint: FP_A } } }, release: '1.4.246', fingerprint: FP_A, commit: o1, isAncestor }); assert.equal(fork.ok, false, '分岔（兩條線）擋'); assert.match(fork.message, /兩條線分岔/); assert.match(fork.message, /#331/);
  const unknown = run('f'.repeat(40)); assert.equal(unknown.ok, false, '查不到這顆 commit 擋'); assert.match(unknown.message, /查不到前者/);
  // 倒退：紀錄記 c2，這次來源是 c1
  assert.equal(checkSameVersion({ ledger: { releases: { '1.4.246': { commit: c2, fingerprint: FP_A } } }, release: '1.4.246', fingerprint: FP_A, commit: c1, isAncestor }).ok, false);
  // 沒給 isAncestor ＝ 舊行為（相容）
  assert.equal(checkSameVersion({ ledger: { releases: { '1.4.246': { commit: c2, fingerprint: FP_A } } }, release: '1.4.246', fingerprint: FP_A, commit: o1 }).ok, true);
});

test('#331 形狀二（11-23）：兩條線前後腳，後出的在遠端 bundle repo 看到同版號、不同指紋 ⇒ 擋；同指紋重出 ⇒ 放行', () => {
  const remote = mkdtempSync(join(tmpdir(), 'svg-remote-'));
  G(remote, 'init', '-q', '--bare', '-b', 'main');
  const clone = (n) => { const d = mkdtempSync(join(tmpdir(), `svg-${n}-`)); G(d, 'clone', '-q', remote, d); return d; };
  const ship = (d, release, fp, src) => {
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ release, fingerprint: fp, source: src }));
    G(d, 'add', '.'); G(d, 'commit', '-q', '-m', `ship ${release}：${src}`); G(d, 'push', '-q', 'origin', 'HEAD:main');
  };
  const lineA = clone('A'); const lineB = clone('B'); // 兩條線在同一個 main 上各自 clone（還沒人出貨）
  ship(lineA, '1.4.292', FP_A, 'Arcrun@aaaaaaa');      // A 先出、還沒落帳進 arcrun-rag main
  G(lineB, 'fetch', '-q', 'origin');                   // B 推之前抓遠端
  const remoteRead = (d, release) => readRemoteReservations({ git: (a) => G(d, ...a), remoteRef: 'origin/main', release });
  const blocked = checkRemoteReservation({ release: '1.4.292', fingerprint: FP_B, remote: remoteRead(lineB, '1.4.292') });
  assert.equal(blocked.ok, false); assert.match(blocked.message, /已經有一個 `ship 1\.4\.292`/); assert.match(blocked.message, /下一個號碼/);
  assert.equal(checkRemoteReservation({ release: '1.4.292', fingerprint: FP_A, remote: remoteRead(lineB, '1.4.292') }).ok, true, '同內容重出放行');
  assert.equal(checkRemoteReservation({ release: '1.4.293', fingerprint: FP_B, remote: remoteRead(lineB, '1.4.293') }).ok, true, '新版號放行');
  // 版號裡的點不是萬用字元：1.4.292 不會被 1x4y292 之類誤認（此處只驗不丟例外且不誤擋別的版號）
  assert.equal(remoteRead(lineB, '1.4.29').entries.length, 0);
  // 遠端讀不到 ⇒ 不擋、明說沒查到
  const nb = checkRemoteReservation({ release: '1.4.292', fingerprint: FP_B, remote: readRemoteReservations({ git: (a) => G(lineB, ...a), remoteRef: 'origin/nope', release: '1.4.292' }) });
  assert.equal(nb.ok, true); assert.match(nb.message, /沒查到/);
});
