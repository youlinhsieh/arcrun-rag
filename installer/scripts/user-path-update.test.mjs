import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInstallPage, pressUpdate, readBack, userPathUpdateStation, listWorkerSecretNames, compareSecretSnapshots } from './user-path-update.mjs';

const cfg = { installerOrigin: 'https://i.test', cypherUrl: 'https://c.test', emailEnv: 'UPU_EMAIL', usernameEnv: 'UPU_USER', passwordEnv: 'UPU_PASS' };
process.env.UPU_EMAIL = 'a@test.example'; process.env.UPU_USER = 'admin@test'; process.env.UPU_PASS = 'pw';
const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, async json() { return typeof body === 'string' ? JSON.parse(body) : body; }, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } });

test('安裝頁把已授權帳號送去 Cloudflare ⇒ 紅燈（講出「每次更新都要重新授權」）', async () => {
  await assert.rejects(() => checkInstallPage({ cfg, fetchImpl: async () => resp(302, '', { location: 'https://dash.cloudflare.com/oauth2/auth?x' }) }), /Cloudflare 授權頁/);
});
test('安裝頁顯示「你已經裝好了」⇒ 過', async () => {
  const r = await checkInstallPage({ cfg, fetchImpl: async () => resp(200, '<h1>你已經裝好了，不用再裝一次</h1>') });
  assert.match(r.detail[0], /沒有被送去 Cloudflare/);
});
test('按更新：回 fallback_to_installer ⇒ 紅燈、說出是舊實例要重新授權', async () => {
  const f = async (u) => u.endsWith('/portal/login') ? resp(200, { session_token: 't' }) : resp(501, { ok: false, fallback_to_installer: true });
  await assert.rejects(() => pressUpdate({ cfg, fetchImpl: f }), /重新授權一次/);
});
test('按更新：切換了準備好的版本 ⇒ 報出切換數與毫秒', async () => {
  let n = 0; const now = () => (n += 1500);
  const f = async (u) => u.endsWith('/portal/login') ? resp(200, { session_token: 't' }) : resp(200, { ok: true, state: 'done', switched: 3, deployed: 25 });
  const r = await pressUpdate({ cfg, fetchImpl: f, now });
  assert.equal(r.switched, 3); assert.equal(r.ms, 1500); assert.match(r.detail[0], /只切換了 3 個服務/);
});
test('讀回 /health 版號不符 ⇒ 有界重試後紅燈', async () => {
  let calls = 0;
  await assert.rejects(() => readBack({ cfg, expect: { version: '1.4.262', commit: '' }, tries: 3, gapMs: 0, sleep: async () => {}, fetchImpl: async () => { calls++; return resp(200, { bundle_version: '1.4.261', bundle_commit: 'abc1234' }); } }), /還不是這一版/);
  assert.equal(calls, 3);
});
test('整站：三段都過', async () => {
  const f = async (u, init = {}) => {
    if (u.includes('/auth/start')) return resp(200, '你已經裝好了');
    if (u.endsWith('/portal/login')) return resp(200, { session_token: 't' });
    if (u.endsWith('/portal/admin/update')) return resp(200, { ok: true, state: 'done', switched: 2 });
    return resp(200, { bundle_version: '1.4.262', bundle_commit: 'abcdef1234' });
  };
  const r = await userPathUpdateStation({ cfg, expect: { version: '1.4.262', commit: 'abcdef1' }, fetchImpl: f });
  assert.equal(r.status, 'done'); assert.equal(r.switched, 2);
});
test('實例還沒到目標版 ⇒ 按之前等 cron 備好（有界）；已是目標版 ⇒ 不等', async () => {
  const mk = (ver) => async (u) => u.endsWith('/health') ? resp(200, { bundle_version: ver, bundle_commit: 'abcdef1234' })
    : u.endsWith('/portal/login') ? resp(200, { session_token: 't' })
    : u.endsWith('/portal/admin/update') ? resp(200, { ok: true, state: 'done', switched: 2 })
    : resp(200, '<h1>你已經裝好了，不用再裝一次</h1>');
  let slept = 0;
  const c = { ...cfg, prepareWaitMs: 1000 };
  // 第一次 /health 讀到舊版 ⇒ 等；之後讀回要對上目標，所以用會變版本的 fetch
  let health = 0;
  const f = async (u, o) => u.endsWith('/health') ? resp(200, { bundle_version: health++ === 0 ? '1.4.261' : '1.4.262', bundle_commit: 'abcdef1234' }) : mk('1.4.262')(u, o);
  const r = await userPathUpdateStation({ cfg: c, expect: { version: '1.4.262', commit: 'abcdef1' }, fetchImpl: f, sleep: async (ms) => { slept += ms; } });
  assert.equal(slept, 1000); assert.ok(r.detail.some((d) => /等了 1 秒/.test(d)));
  slept = 0;
  await userPathUpdateStation({ cfg: c, expect: { version: '1.4.262', commit: 'abcdef1' }, fetchImpl: mk('1.4.262'), sleep: async (ms) => { slept += ms; } });
  assert.equal(slept, 0);
});

test('Secret 名單：切換後少一把 ⇒ 比對失敗並點名；多一把不算錯', () => {
  assert.equal(compareSecretSnapshots({ w: ['A', 'B'] }, { w: ['A', 'B', 'C'] }).ok, true);
  const bad = compareSecretSnapshots({ w: ['A', 'B'], x: null }, { w: ['A'], x: null });
  assert.equal(bad.ok, false); assert.deepEqual(bad.lost, ['w：B']);
  assert.equal(compareSecretSnapshots({ w: ['A'] }, { w: null }).ok, false);
});
test('Secret 名單：讀 API 只取名字；404＝不存在；其他錯誤丟出', async () => {
  const f = async (u) => u.includes('/gone/') ? resp(404, {}) : u.includes('/bad/') ? resp(500, {}) : resp(200, { success: true, result: [{ name: 'B', type: 'secret_text' }, { name: 'A' }] });
  assert.deepEqual(await listWorkerSecretNames({ accountId: 'x', token: 't', workers: ['ok', 'gone'], fetchImpl: f }), { ok: ['A', 'B'], gone: null });
  await assert.rejects(() => listWorkerSecretNames({ accountId: 'x', token: 't', workers: ['bad'], fetchImpl: f }), /不能確認金鑰還在/);
});
test('整站：切換後 Secret 少一把 ⇒ 站紅燈；沒少 ⇒ 印出名單', async () => {
  const f = async (u) => u.includes('/auth/start') ? resp(200, '你已經裝好了') : u.endsWith('/portal/login') ? resp(200, { session_token: 't' })
    : u.endsWith('/portal/admin/update') ? resp(200, { ok: true, state: 'done', switched: 2 }) : resp(200, { bundle_version: '1.4.262', bundle_commit: 'abcdef1234' });
  const mk = (...snaps) => { let i = 0; return async () => snaps[i++]; };
  const args = { cfg, expect: { version: '1.4.262', commit: 'abcdef1' }, fetchImpl: f, sleep: async () => {} };
  await assert.rejects(() => userPathUpdateStation({ ...args, secretSnapshot: mk({ w: ['A', 'B'] }, { w: ['A'] }) }), /Secret 少了 1 把[\s\S]*w：B/);
  const r = await userPathUpdateStation({ ...args, secretSnapshot: mk({ w: ['A', 'B'] }, { w: ['A', 'B'] }) });
  assert.ok(r.detail.some((d) => /前 2 把／後 2 把｜A、B/.test(d)));
});
