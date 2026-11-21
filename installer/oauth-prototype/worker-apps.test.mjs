/**
 * inkstone/InkStoneCo#330（Arcrun#432）：安裝站提供 `/apps`——App 市集目錄。
 * 引擎的預設市集來源是 `<INSTALLER_ORIGIN>/apps`，內容是 app-market/build-feed.mjs 的產出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };
const kv = () => { const s = new Map(); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v) { s.set(k, v); }, async delete(k) { s.delete(k); } }; };
function fakeR2(objs) {
  const meta = (key) => ({ size: objs[key].length, httpEtag: '"e"', writeHttpMetadata(h) { h.set('content-type', 'application/json'); } });
  return {
    async head(key) { return objs[key] ? { ...meta(key), body: null } : null; },
    async get(key) { const o = objs[key]; return o ? { ...meta(key), body: o, text: async () => o } : null; },
  };
}
const call = (e, path, init) => worker.fetch(new Request('https://inst.test' + path, init), e, { waitUntil() {} });
const OBJS = {
  'apps/index.json': '{"schema":1,"apps":[]}',
  'apps/packages/notes-1.4.0.json': '{"pkg":1}',
  'manifest.json': '{"secret":"not an app"}',
};
const withR2 = () => ({ INSTALLER_KV: kv(), DIST: fakeR2(OBJS), DIST_BASE: 'https://inst.test/dist' });

test('/apps/index.json 與 /apps/packages/<id>-<版本>.json：從 R2 的 apps/ 前綴串出', async () => {
  const e = withR2();
  const a = await call(e, '/apps/index.json');
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { schema: 1, apps: [] });
  const b = await call(e, '/apps/packages/notes-1.4.0.json');
  assert.equal(b.status, 200);
  assert.equal(await b.text(), '{"pkg":1}');
  assert.equal((await call(e, '/apps/index.json', { method: 'HEAD' })).status, 200);
});

test('/apps：只開放目錄檔與 App 包；其他 key（含跨前綴、..）404，非 GET/HEAD 405', async () => {
  const e = withR2();
  for (const p of ['/apps', '/apps/', '/apps/manifest.json', '/apps/../manifest.json', '/apps/%2e%2e/manifest.json',
    '/apps/packages/', '/apps/packages/x.json', '/apps/packages/notes-1.4.0.txt', '/apps/packages/a/b-1.0.0.json', '/apps/packages/nope-1.0.0.json']) {
    assert.equal((await call(e, p)).status, 404, p);
  }
  assert.equal((await call(e, '/apps/index.json', { method: 'POST' })).status, 405);
});

test('沒綁 R2 也沒設 APP_FEED_BASE：404 並明說沒有市集目錄（不回空目錄冒充「市集沒 App」）', async () => {
  const res = await call({ INSTALLER_KV: kv() }, '/apps/index.json');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /沒有 App 市集目錄/);
});

test('沒綁 R2 但有 APP_FEED_BASE：轉去該靜態目錄；index 不快取、包長快取；來源錯誤碼原樣帶出', async () => {
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return String(u).endsWith('missing-1.0.0.json') ? new Response('x', { status: 404 }) : new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }); };
  try {
    const e = { INSTALLER_KV: kv(), APP_FEED_BASE: 'https://cdn.test/feed/' };
    const i = await call(e, '/apps/index.json');
    assert.equal(i.status, 200);
    assert.equal(i.headers.get('cache-control'), 'no-cache');
    const p = await call(e, '/apps/packages/notes-1.4.0.json');
    assert.match(p.headers.get('cache-control'), /immutable/);
    assert.equal((await call(e, '/apps/packages/missing-1.0.0.json')).status, 404);
    assert.deepEqual(seen.slice(0, 2), ['https://cdn.test/feed/index.json', 'https://cdn.test/feed/packages/notes-1.4.0.json']);
    // http 的 base 不收
    assert.equal((await call({ INSTALLER_KV: kv(), APP_FEED_BASE: 'http://cdn.test' }, '/apps/index.json')).status, 404);
  } finally { restore(); }
});
