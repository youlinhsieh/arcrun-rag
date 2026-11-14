/**
 * 安裝遙測離線測試（inkstone/arcrun-rag#342）。跑法：node --test install-telemetry.test.mjs
 * 用 node:sqlite 當假 D1（真的 SQLite，所以 SQL 本身有被驗到）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  installIdOf, buildEvent, recordInstallEvent, backfillFromKv, _resetSchemaCacheForTest, TELEMETRY_TIMEOUT_MS,
} from './install-telemetry.mjs';
import worker from './worker.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, a),
    run: () => db.prepare(sql).run(...args),
    all: () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    _db: db,
    prepare: (sql) => mk(sql),
    async batch(stmts) { db.exec('BEGIN'); try { for (const s of stmts) s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
    rows: (sql) => db.prepare(sql).all(),
  };
}

const ACC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const EMAIL = 'someone@example.com';
const okProgress = (extra = {}) => ({
  state: 'done', startedAt: 1000, finishedAt: 5000,
  result: { accountId: ACC, email: EMAIL, subdomain: 'someone-sub', release: '1.4.196', mode: 'install', ...extra },
});

test('install_id 是不可逆雜湊：同帳號穩定、不含原文、空帳號給空字串', async () => {
  const a = await installIdOf(ACC);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await installIdOf(ACC));
  assert.notEqual(a, await installIdOf(ACC.replace('a', 'b')));
  assert.ok(!a.includes(ACC.slice(0, 8)));
  assert.equal(await installIdOf(null), '');
});

test('成功的安裝：寫進兩張表，版本／種類／耗時對', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1();
  const r = await recordInstallEvent({ INSTALLS_DB: db, DEPLOY_ENV: 'youlin-stage' }, 'sid-1', okProgress());
  assert.equal(r, 'recorded');
  const ev = db.rows('SELECT * FROM install_events');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'install'); assert.equal(ev[0].outcome, 'ok');
  assert.equal(ev[0].version, '1.4.196'); assert.equal(ev[0].duration_ms, 4000);
  assert.equal(ev[0].channel, 'youlin-stage'); assert.equal(ev[0].source, 'live');
  const inst = db.rows('SELECT * FROM installs');
  assert.equal(inst.length, 1);
  assert.equal(inst[0].version, '1.4.196'); assert.ok(inst[0].last_ok_at);
});

test('更新：同一台版本推進、事件多一列、台數仍是 1；重送同一事件不重複', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1(); const env = { INSTALLS_DB: db };
  await recordInstallEvent(env, 's1', okProgress({ release: '1.4.195' }));
  await recordInstallEvent(env, 's2', { ...okProgress({ release: '1.4.196', mode: 'update' }), finishedAt: 9000 });
  await recordInstallEvent(env, 's2', { ...okProgress({ release: '1.4.196', mode: 'update' }), finishedAt: 9000 });
  assert.equal(db.rows('SELECT * FROM installs').length, 1);
  assert.equal(db.rows('SELECT * FROM installs')[0].version, '1.4.196');
  assert.equal(db.rows('SELECT * FROM install_events').length, 2);
  assert.equal(db.rows("SELECT * FROM install_events WHERE kind='update'").length, 1);
});

test('亂序到達：較舊的成功事件不會把版本倒退', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1(); const env = { INSTALLS_DB: db };
  await recordInstallEvent(env, 'new', { ...okProgress({ release: '1.4.196' }), finishedAt: 9000 });
  await recordInstallEvent(env, 'old', { ...okProgress({ release: '1.4.190' }), finishedAt: 3000 });
  const inst = db.rows('SELECT * FROM installs')[0];
  assert.equal(inst.version, '1.4.196'); assert.equal(inst.first_seen_at, 3000);
});

test('失敗：記下失敗步驟，不覆蓋「最後成功版本」；沒有帳號時不進 installs', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1(); const env = { INSTALLS_DB: db };
  await recordInstallEvent(env, 'ok', okProgress());
  await recordInstallEvent(env, 'bad', { state: 'failed', finishedAt: 7000, startedAt: 6000,
    error: { step: 'deploy', message: '不該進紀錄的人話', detail: 'token=abc' },
    result: { accountId: ACC, release: '1.4.197', mode: 'update' } });
  await recordInstallEvent(env, 'early', { state: 'failed', finishedAt: 8000, error: { step: 'account' }, result: { email: EMAIL } });
  const inst = db.rows('SELECT * FROM installs');
  assert.equal(inst.length, 1);
  assert.equal(inst[0].version, '1.4.196'); // 失敗的 1.4.197 沒蓋掉
  const fails = db.rows("SELECT * FROM install_events WHERE outcome='fail' ORDER BY at");
  assert.deepEqual(fails.map((f) => f.failed_step), ['deploy', 'account']);
  assert.equal(fails[1].install_id, '');
});

test('匿名紅線：整個 D1 找不到 email、accountId、subdomain、token、錯誤原文', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1(); const env = { INSTALLS_DB: db };
  await recordInstallEvent(env, 'ok', okProgress());
  await recordInstallEvent(env, 'bad', { state: 'failed', finishedAt: 7000,
    error: { step: 'deploy', message: '安裝失敗 someone@example.com', detail: `token=cfut_SECRET ${ACC}` },
    result: { accountId: ACC, email: EMAIL, subdomain: 'someone-sub' } });
  const dump = JSON.stringify([db.rows('SELECT * FROM install_events'), db.rows('SELECT * FROM installs')]);
  for (const needle of [EMAIL, 'someone', ACC, 'cfut_SECRET', '安裝失敗', 'someone-sub']) {
    assert.ok(!dump.includes(needle), `不該出現：${needle}`);
  }
});

test('不拖慢、不弄壞：沒綁 D1 略過；D1 炸掉回 failed 不丟例外；卡住的 D1 在逾時內放棄', async () => {
  _resetSchemaCacheForTest();
  assert.equal(await recordInstallEvent({}, 's', okProgress()), 'skipped');
  const boom = { prepare: () => { throw new Error('d1 down'); }, batch: async () => { throw new Error('d1 down'); } };
  assert.equal(await recordInstallEvent({ INSTALLS_DB: boom }, 's', okProgress()), 'failed');
  _resetSchemaCacheForTest();
  const hang = { prepare: () => ({ bind() { return this; } }), batch: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await recordInstallEvent({ INSTALLS_DB: hang }, 's', okProgress()), 'failed');
  assert.ok(Date.now() - t0 < TELEMETRY_TIMEOUT_MS + 500);
});

test('回補：deployed 與 log 匿名化進來；重跑冪等；失敗步驟保留', async () => {
  _resetSchemaCacheForTest();
  const db = fakeD1();
  const store = new Map([
    [`deployed:${ACC}:sub1`, JSON.stringify({ bundleBase: 'https://cdn/x@abc' })],
    [`deployed:${ACC}:sub2`, JSON.stringify({ bundleBase: 'https://cdn/x@abc' })], // 同帳號第二筆只算一台
    ['deployed:ffffffffffffffffffffffffffffffff:s', JSON.stringify({ bundleBase: 'https://cdn/x@old' })],
    ['log:1700000000000-aaaaaa', JSON.stringify({ at: 1700000000000, state: 'done', accountId: ACC, email: EMAIL, bundleBase: 'https://cdn/x@abc', durationMs: 5000 })],
    ['log:1700000100000-bbbbbb', JSON.stringify({ at: 1700000100000, state: 'failed', failedStep: 'deploy', errorMessage: 'x', accountId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', email: 'z@z.com' })],
  ]);
  const kv = {
    async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
    async get(k, t) { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  };
  const releaseOf = async (b) => ({ 'https://cdn/x@abc': '1.4.195', 'https://cdn/x@old': '1.4.100' }[b] || null);
  const deps = { kv, db, releaseOf, channel: 'prod', now: 1800000000000 };
  const c1 = await backfillFromKv(deps);
  assert.deepEqual(c1, { deployed: 2, logs: 2 });
  await backfillFromKv(deps);
  assert.equal(db.rows('SELECT * FROM install_events').length, 4);
  const inst = db.rows('SELECT * FROM installs ORDER BY version');
  assert.equal(inst.length, 3); // 2 台 deployed + 失敗者(有帳號)
  assert.equal(db.rows("SELECT * FROM installs WHERE version='1.4.195'")[0].first_seen_at, 1700000000000); // 取真實 log 時間
  assert.equal(db.rows("SELECT failed_step FROM install_events WHERE outcome='fail'")[0].failed_step, 'deploy');
  const dump = JSON.stringify(db.rows('SELECT * FROM install_events')) + JSON.stringify(inst);
  assert.ok(!dump.includes(EMAIL) && !dump.includes(ACC) && !dump.includes('z@z.com'));
});

test('worker：POST /admin/installs-backfill 沒 key 或沒綁 D1 一律 404', async () => {
  const kv = { async get() { return null; }, async put() {}, async delete() {}, async list() { return { keys: [] }; } };
  const mk = (extra) => ({ INSTALLER_KV: kv, ...extra });
  const call = (env, q) => worker.fetch(new Request('https://i.example/admin/installs-backfill' + q, { method: 'POST' }), env, { waitUntil() {} });
  assert.equal((await call(mk({ ADMIN_LOG_KEY: 'k', INSTALLS_DB: fakeD1() }), '')).status, 404);
  assert.equal((await call(mk({ ADMIN_LOG_KEY: 'k', INSTALLS_DB: fakeD1() }), '?key=wrong')).status, 404);
  assert.equal((await call(mk({ ADMIN_LOG_KEY: 'k' }), '?key=k')).status, 404);
  const ok = await call(mk({ ADMIN_LOG_KEY: 'k', INSTALLS_DB: fakeD1() }), '?key=k');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, deployed: 0, logs: 0 });
});
