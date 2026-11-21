import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInbox, describeMissing, probeInbox, probeStatus, seedToken, INBOX_BASE } from './feedback-inbox.mjs';

const mk = (wfs, creds) => async (url) => {
  const body = url.endsWith('/credentials') ? { credentials: creds } : { workflows: wfs };
  return { ok: true, status: 200, json: async () => body };
};

test('清空後的收件端：兩樣都缺要講出來', async () => {
  const r = await checkInbox({ fetchImpl: mk([], []) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['工作流 feedback_report', '金鑰 ahub_token']);
  assert.match(describeMissing(r.missing), /簽核/);
});
test('只有工作流沒有金鑰：只缺金鑰', async () => {
  const r = await checkInbox({ fetchImpl: mk([{ name: 'feedback_report' }], []) });
  assert.deepEqual(r.missing, ['金鑰 ahub_token']);
});
test('齊全', async () => {
  const r = await checkInbox({ fetchImpl: mk([{ name: 'feedback_report' }], [{ name: 'ahub_token' }]) });
  assert.equal(r.ok, true);
});

test('收件端預設在 uncle6，不是 youlin（#282）', () => {
  assert.match(INBOX_BASE, /uncle6-me\.workers\.dev$/);
  assert.doesNotMatch(INBOX_BASE, /arcrun-yuga3bse/);
});
test('探針：開出票就 ok，並打小幫手走的那個網址', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ success: true, data: { number: 7, url: 'u' } }) }; };
  const r = await probeInbox({ fetchImpl: f, now: new Date('2026-11-21T01:00:00Z') });
  assert.deepEqual(r, { ok: true, number: 7, url: 'u' });
  assert.match(seen.url, /\/webhooks\/named\/inbox-feedback\/feedback_report\/trigger$/);
  assert.equal(seen.body.event_key, 'probe:2026-11-21');
});
test('探針：缺金鑰（500）要失敗並帶原因', async () => {
  const f = async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: '缺少 credential: ahub_token' }) });
  const r = await probeInbox({ fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.error, /ahub_token/);
});
test('探針：連不上（含 404）也是失敗，不准無聲', async () => {
  assert.equal((await probeInbox({ fetchImpl: async () => { throw new Error('boom'); } })).ok, false);
  assert.equal((await probeInbox({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) })).ok, false);
});
test('探針：被相近票比對擋下（409 重複候選）→ 帶逐張交代重送一次，開得出票就 ok', async () => {
  const bodies = [];
  const f = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: false, status: 409, json: async () => ({ success: false, error: '開票前比對到相近的票，沒有開新票。重複候選=inkstone/arcrun-rag#242 inkstone/arcrun-rag#243 inkstone/arcrun-rag#295' }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { number: 9, url: 'u9' } }) };
  };
  const r = await probeInbox({ fetchImpl: f });
  assert.deepEqual(r, { ok: true, number: 9, url: 'u9' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].compared, undefined);
  assert.deepEqual(bodies[1].compared.map((c) => c.ref), ['inkstone/arcrun-rag#242', 'inkstone/arcrun-rag#243', 'inkstone/arcrun-rag#295']);
  assert.equal(new Set(bodies[1].compared.map((c) => c.reason)).size, 1);
});
test('探針：重送仍被擋就失敗，只送兩次；非「重複候選」的失敗不重送', async () => {
  let n = 0;
  const dup = async () => { n++; return { ok: false, status: 409, json: async () => ({ success: false, error: '重複候選=inkstone/arcrun-rag#1' }) }; };
  assert.equal((await probeInbox({ fetchImpl: dup })).ok, false);
  assert.equal(n, 2);
  let m = 0;
  const miss = async () => { m++; return { ok: false, status: 500, json: async () => ({ success: false, error: '缺少 credential: ahub_token' }) }; };
  assert.equal((await probeInbox({ fetchImpl: miss })).ok, false);
  assert.equal(m, 1);
});

test('探針：引擎把輸出包兩層 data 也認得票號', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { success: true, data: { success: true, number: 777, url: 'u' } }, trace: [{ number: 1 }] }) });
  assert.deepEqual(await probeInbox({ fetchImpl: f }), { ok: true, number: 777, url: 'u' });
});
const regOk = { ok: true, status: 200, json: async () => ({ data: { status: 201, body: {} } }) };
test('種金鑰：原文先寫進收件端、再向 AHub 只送雜湊；回傳不含值', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return url.includes('ahub__token_register') ? regOk : { ok: true, status: 200, json: async () => ({}) }; };
  const r = await seedToken({ ahubUrl: 'https://a.example', ahubNs: 'n', cfToken: 'cf', fetchImpl: f, randomHex: () => 'ab'.repeat(24) });
  const plain = 'ahub_' + 'ab'.repeat(24);
  assert.equal(JSON.stringify(r).includes(plain), false);
  assert.match(calls[0].url, /\/credentials$/);
  assert.equal(JSON.parse(calls[0].init.body).value, plain);   // 收件端拿原文
  assert.equal(calls[0].init.headers['X-CF-Secrets-Token'], 'cf');
  assert.match(calls[1].url, /ahub__token_register/);
  assert.equal(calls[1].init.body.includes(plain), false);      // AHub 只看到雜湊
});
test('種金鑰：收件端寫不進去就不登記任何雜湊（不留孤兒）', async () => {
  const urls = [];
  const f = async (url) => { urls.push(url); return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }; };
  await assert.rejects(seedToken({ ahubUrl: 'https://a', ahubNs: 'n', cfToken: 'cf', fetchImpl: f }), /寫入收件端金鑰中心失敗/);
  assert.equal(urls.some((u) => u.includes('ahub__token_register')), false);
});
test('種金鑰：引擎回 502「寫入路徑未就緒」＝照實失敗，不改走直寫 Workers Secret、不登記雜湊', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    if (url.endsWith('/credentials')) return { ok: false, status: 502, text: async () => '{"error":"此 worker 缺 CF_SECRETS_API_TOKEN … 寫入路徑未就緒"}' };
    return regOk;
  };
  await assert.rejects(seedToken({ ahubUrl: 'https://a', ahubNs: 'n', cfToken: 'cf', fetchImpl: f }), /升級 uncle6/);
  assert.equal(urls.some((u) => u.includes('api.cloudflare.com')), false);          // 沒有繞過金鑰中心
  assert.equal(urls.some((u) => u.endsWith('/credentials/directory')), false);
  assert.equal(urls.some((u) => u.includes('ahub__token_register')), false);       // 沒留孤兒雜湊
});
test('probe-status：失敗／太久沒跑／沒部署都要非 ok；timestamp 是秒', async () => {
  const mkx = (status, ex) => async () => ({ ok: status === 200, status, json: async () => ({ data: { executions: ex } }) });
  const now = new Date('2026-11-21T02:00:00Z');
  const t = (iso) => String(Math.floor(new Date(iso).getTime() / 1000));
  assert.equal((await probeStatus({ fetchImpl: mkx(404, []), now })).ok, false);
  assert.equal((await probeStatus({ fetchImpl: mkx(200, []), now })).ok, false);
  assert.equal((await probeStatus({ fetchImpl: mkx(200, [{ timestamp: t('2026-11-21T01:10:00Z'), verdict: 'failed', message: 'x' }]), now })).ok, false);
  assert.match((await probeStatus({ fetchImpl: mkx(200, [{ timestamp: t('2026-11-19T01:10:00Z'), verdict: 'success' }]), now })).reason, /沒跑/);
  assert.equal((await probeStatus({ fetchImpl: mkx(200, [{ timestamp: t('2026-11-21T01:10:00Z'), verdict: 'success' }]), now })).ok, true);
});
