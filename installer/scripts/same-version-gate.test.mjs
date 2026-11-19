/**
 * same-version-gate.test.mjs — inkstone/arcrun-rag#363 第 3 處：同一個版號不能換成另一包，要在動手前就擋。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSameVersion, readAhubStage, stageFromResponse } from './same-version-gate.mjs';

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
