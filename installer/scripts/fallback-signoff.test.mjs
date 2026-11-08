/**
 * fallback-signoff.test.mjs — AHub 讀不到時的備援簽核接線（inkstone/InkStoneCo#262，驗收 4）
 * 驗證器是 ISEP 的另一支；這裡用「假驗證器」（真的外部行程）測放行與擋。
 * 跑法：node --test installer/scripts/fallback-signoff.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findVerifier, verifyFallbackSignoff } from './fallback-signoff.mjs';
import { checkTicketArmed } from './ticket-arm-guard.mjs';

const down = async () => { throw new Error('fetch failed (ECONNRESET)'); };
const http503 = async () => ({ ok: false, status: 503, json: async () => ({ message: 'daily brake' }) });
const base = { version: '1.4.99', repo: 'InkStoneCo', issue: 262, token: 't', baseUrl: 'https://x.test', conf: { TICKET_FORGE: 'gitea' } };

function fakeVerifier(script) {
  const d = mkdtempSync(join(tmpdir(), 'fbv-'));
  const p = join(d, 'fallback-signoff-verify');
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}
// 只簽 InkStoneCo#262 的 1.4.99，其餘一律擋
const OK_ONLY = 'if [ "$1" = "InkStoneCo#262" ] && [ "$2" = "1.4.99" ]; then echo "SIGNED: passkey fp=abc"; exit 0; fi; echo "目標不符" >&2; exit 3';

test('AHub 連線失敗 + 備援簽章成立 → 放行並註明走備援', async () => {
  const v = fakeVerifier(OK_ONLY);
  const r = await checkTicketArmed({ ...base, fetchImpl: down, env: { ISEP_FALLBACK_SIGNOFF: v } });
  assert.equal(r.armed, true);
  assert.equal(r.fallback, true);
  assert.match(r.mission, /備援簽核.*SIGNED: passkey/);
});

test('AHub 回 503（剎車）+ 備援成立 → 放行', async () => {
  const v = fakeVerifier(OK_ONLY);
  const r = await checkTicketArmed({ ...base, fetchImpl: http503, env: { ISEP_FALLBACK_SIGNOFF: v } });
  assert.equal(r.fallback, true);
});

test('AHub 讀不到 + 沒有簽章（驗證器擋）→ 擋，訊息含原因', async () => {
  const v = fakeVerifier('echo "no assertion" >&2; exit 2');
  await assert.rejects(checkTicketArmed({ ...base, fetchImpl: down, env: { ISEP_FALLBACK_SIGNOFF: v } }), /備援簽核.*exit 2.*no assertion/s);
});

test('備援驗證器簽的是別的版本 → 擋', async () => {
  const v = fakeVerifier(OK_ONLY);
  await assert.rejects(checkTicketArmed({ ...base, version: '1.4.100', fetchImpl: down, env: { ISEP_FALLBACK_SIGNOFF: v } }), /備援簽核/);
});

test('驗證器 exit 0 但沒有 SIGNED 行 → 擋（fail-closed）', async () => {
  const v = fakeVerifier('echo ok; exit 0');
  await assert.rejects(checkTicketArmed({ ...base, fetchImpl: down, env: { ISEP_FALLBACK_SIGNOFF: v } }), /沒有 SIGNED 行/);
});

test('找不到驗證器 → 備援關閉並明說，不放行', async () => {
  await assert.rejects(
    checkTicketArmed({ ...base, fetchImpl: down, env: {}, fallbackVerify: (o) => verifyFallbackSignoff({ ...o, find: () => null }) }),
    /備援關閉/);
});

test('AHub 正常回答「還沒簽」→ 不走備援（即使備援會放行）', async () => {
  const v = fakeVerifier(OK_ONLY);
  const ahubSays = async () => ({ ok: true, status: 200, json: async () => ({ version: { approved: false }, configured: true }) });
  await assert.rejects(checkTicketArmed({ ...base, fetchImpl: ahubSays, env: { ISEP_FALLBACK_SIGNOFF: v } }), /還沒有簽核人放行/);
});

test('AHub 正常且已簽 → 照舊放行，不呼叫備援', async () => {
  let called = false;
  const ahubOk = async () => ({ ok: true, status: 200, json: async () => ({ version: { approved: true, by: 'Leo', comment_id: 7, at: 'x' } }) });
  const r = await checkTicketArmed({ ...base, fetchImpl: ahubOk, fallbackVerify: async () => { called = true; return { ok: true, signed: 'SIGNED: x' }; } });
  assert.equal(r.armed, true);
  assert.equal(r.fallback, undefined);
  assert.equal(called, false);
});

test('舊路讀留言失敗也算讀不到 → 走備援', async () => {
  const v = fakeVerifier(OK_ONLY);
  const f = async (url) => (/signoffs/.test(url) ? { ok: false, status: 404, json: async () => ({}) } : { ok: false, status: 502, json: async () => ({}) });
  const r = await checkTicketArmed({ ...base, fetchImpl: f, env: { ISEP_FALLBACK_SIGNOFF: v } });
  assert.equal(r.fallback, true);
});

test('findVerifier：依序 env 指定 → ISEP_ROOT → 並列 ISEP；都沒有回 null', () => {
  const ex = (set) => (p) => set.includes(p);
  assert.equal(findVerifier({ env: { ISEP_FALLBACK_SIGNOFF: '/a/v' }, exists: ex(['/a/v']) }), '/a/v');
  assert.equal(findVerifier({ env: { ISEP_ROOT: '/r' }, exists: ex(['/r/scripts/fallback-signoff-verify']) }), '/r/scripts/fallback-signoff-verify');
  assert.equal(findVerifier({ env: {}, exists: () => false }), null);
});
