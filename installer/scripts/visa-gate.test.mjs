/**
 * visa-gate.test.mjs — 出 prod 前的海關（inkstone/arcrun-rag#348，ADR D101 第三步驗收）。
 * 驗收：stage 不查；三張兒子只關一張的意圖出 prod 被退回並列出另兩張；兒子全關、簽證確認後放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersionSection, checkTwoPart, checkVisa, runVisaGate } from './visa-gate.mjs';
import { matchAhubRoute } from './forge-config.mjs';

const GOOD = [
  '- **這版完成：prod 出貨前查意圖完成簽證（inkstone/Arcrun#438）。** 簽核人不會再簽到沒做完的版本。',
  '',
  '- **順帶修好**',
  '  - 某某小事。',
].join('\n');

const reply = (status, body) => async (url, init) => { reply.calls.push({ url: String(url), init }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
reply.calls = [];

test('兩段：第一段抓到意圖鍵、第二段在', () => {
  const p = parseVersionSection(GOOD);
  assert.equal(p.done.intent, 'inkstone/Arcrun#438');
  assert.ok(p.also !== null);
  assert.deepEqual(checkTwoPart(GOOD), { ok: true, intent: 'inkstone/Arcrun#438', problems: [] });
});

test('舊格式（沒有「這版完成」）⇒ 不合規定，說缺第一段與第二段', () => {
  const c = checkTwoPart('- **清空後重裝也接回原本的帳號。** 以前會怎樣、現在會怎樣。（inkstone/arcrun-rag#268）');
  assert.equal(c.ok, false);
  assert.equal(c.problems.length, 2);
  assert.match(c.problems[0], /缺第一段/);
  assert.match(c.problems[1], /缺第二段/);
});

test('第一段沒有票的鍵、或缺第二段 ⇒ 退回；找不到這一版 ⇒ 退回', () => {
  assert.match(checkTwoPart('這版完成：做了一件事\n\n順帶修好\n無').problems[0], /沒有意圖票的鍵/);
  assert.match(checkTwoPart('這版完成：X（inkstone/Arcrun#1）').problems[0], /缺第二段/);
  assert.equal(checkTwoPart(null).ok, false);
});

test('expectIntent：daemon 線寫的意圖與簽證意圖不同 ⇒ 不一致', () => {
  const c = checkTwoPart(GOOD, { expectIntent: 'inkstone/Arcrun#999' });
  assert.equal(c.ok, false);
  assert.match(c.problems[0], /不一致/);
  assert.equal(checkTwoPart(GOOD, { expectIntent: 'inkstone/Arcrun#438' }).ok, true);
});

test('路由：ahub__visa_check 對得上 /ahub/visas/check', () => {
  assert.equal(matchAhubRoute('GET', '/ahub/visas/check').workflow, 'ahub__visa_check');
});

test('三張兒子只關一張 ⇒ 退回並列出另兩張；請求帶 version 與 intent', async () => {
  reply.calls = [];
  const body = { ok: false, message: '版本 1.4.228 沒有有效的意圖完成簽證（意圖 inkstone/Arcrun#438）。這個意圖底下還有票沒搞定：', missing: { reason: 'children_open', open: [{ key: 'inkstone/Arcrun#440', executor: 'arcrun-hand' }, { key: 'inkstone/Arcrun#441' }] }, visas: [] };
  const r = await checkVisa({ fetchImpl: reply(200, body), token: 't', version: '1.4.228', intent: 'inkstone/Arcrun#438' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'children_open');
  assert.match(r.message, /inkstone\/Arcrun#440/);
  assert.match(r.message, /inkstone\/Arcrun#441（未指派）/);
  const u = new URL(reply.calls[0].url);
  assert.equal(u.searchParams.get('version'), '1.4.228');
  assert.equal(u.searchParams.get('intent'), 'inkstone/Arcrun#438');
  assert.equal(reply.calls[0].init.method, 'GET');
});

test('兒子全關、簽證確認後放行', async () => {
  const r = await runVisaGate({ section: GOOD, version: '1.4.228', token: 't', fetchImpl: reply(200, { ok: true, message: '版本 1.4.228 持有效簽證' }) });
  assert.equal(r.ok, true);
  assert.equal(r.intent, 'inkstone/Arcrun#438');
});

test('簽證掛在別的意圖 ⇒ 退回並指出不一致的兩邊', async () => {
  const body = { ok: false, missing: { reason: 'no_visa' }, visas: [{ intent: 'inkstone/Arcrun#500', state: 'confirmed' }] };
  const r = await checkVisa({ fetchImpl: reply(200, body), token: 't', version: '1.4.228', intent: 'inkstone/Arcrun#438' });
  assert.equal(r.ok, false);
  assert.match(r.message, /inkstone\/Arcrun#500/);
  assert.match(r.message, /不一致/);
});

test('fail-closed：沒權杖、連不上、AHub 還沒升級、不認權杖、回怪東西，一律退回', async () => {
  assert.equal((await checkVisa({ fetchImpl: reply(200, {}), token: null, version: '1', intent: 'a/b#1' })).reason, 'no-token');
  assert.equal((await checkVisa({ fetchImpl: async () => { throw new Error('boom'); }, token: 't', version: '1', intent: 'a/b#1' })).reason, 'unreachable');
  assert.equal((await checkVisa({ fetchImpl: reply(404, '{"error":"workflow_missing"}'), token: 't', version: '1', intent: 'a/b#1' })).reason, 'workflow-missing');
  assert.equal((await checkVisa({ fetchImpl: reply(401, 'no'), token: 't', version: '1', intent: 'a/b#1' })).reason, 'unauthorized');
  assert.equal((await checkVisa({ fetchImpl: reply(200, 'not json'), token: 't', version: '1', intent: 'a/b#1' })).reason, 'unexpected');
});

test('CHANGELOG 沒有意圖鍵 ⇒ 不問 AHub 直接退回（不帶 intent 的查法不重掃底下）', async () => {
  reply.calls = [];
  const r = await runVisaGate({ section: '- 舊格式一行', version: '1.4.228', token: 't', fetchImpl: reply(200, { ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(reply.calls.length, 0);
});

test('stage 不查、prod 查：ship.targets.json 只有 prod 宣告 visaGate', () => {
  const t = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ship.targets.json'), 'utf8')).targets;
  assert.equal(t.prod.visaGate, true);
  for (const [name, v] of Object.entries(t)) if (name !== 'prod') assert.ok(!v.visaGate, `${name} 不該查簽證`);
});
