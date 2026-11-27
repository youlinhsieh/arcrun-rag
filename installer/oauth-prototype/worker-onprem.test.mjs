/**
 * inkstone/arcrun-rag#394（母票 inkstone/InkStoneCo#325）：安裝站提供 `/onprem`——官方地端更新檔。
 * 內容是 Arcrun docker/private-cloud/build-update.mjs 的產出（build＝簽好的 .tgz、feed＝latest.json）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };
const kv = () => { const s = new Map(); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v) { s.set(k, v); }, async delete(k) { s.delete(k); } }; };
function fakeR2(objs) {
  const meta = (key) => ({ size: objs[key].length, httpEtag: '"e"', writeHttpMetadata(h) { h.set('content-type', 'application/octet-stream'); } });
  return {
    async head(key) { return objs[key] ? { ...meta(key), body: null } : null; },
    async get(key) { const o = objs[key]; return o ? { ...meta(key), body: o, text: async () => o } : null; },
  };
}
const call = (e, path, init) => worker.fetch(new Request('https://inst.test' + path, init), e, { waitUntil() {} });
const OBJS = {
  'onprem/latest.json': '{"version":"1.4.305-onprem.1","url":"https://inst.test/onprem/1.4.305-onprem.1.tgz","sha256":"ab","size":3,"notes":[]}',
  'onprem/1.4.305-onprem.1.tgz': 'TGZ',
  'manifest.json': '{"secret":"not an update"}',
};

test('/onprem/latest.json 與 /onprem/<版本>.tgz：stage 從同一顆 R2（DIST）的 onprem/ 前綴串出，指標不快取', async () => {
  const e = { INSTALLER_KV: kv(), DIST: fakeR2(OBJS), DIST_BASE: 'https://inst.test/dist' };
  const a = await call(e, '/onprem/latest.json');
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('cache-control'), 'no-cache');
  assert.match(a.headers.get('content-type'), /json/);
  assert.equal((await a.json()).version, '1.4.305-onprem.1');
  const b = await call(e, '/onprem/1.4.305-onprem.1.tgz');
  assert.equal(b.status, 200);
  assert.equal(await b.text(), 'TGZ');
  assert.equal((await call(e, '/onprem/latest.json', { method: 'HEAD' })).status, 200);
});

test('/onprem：只開放指標與更新檔；跨前綴、.. 、錯的副檔名一律 404，非 GET/HEAD 405', async () => {
  const e = { INSTALLER_KV: kv(), DIST: fakeR2(OBJS), DIST_BASE: 'https://inst.test/dist' };
  for (const p of ['/onprem', '/onprem/', '/onprem/manifest.json', '/onprem/../manifest.json', '/onprem/%2e%2e/manifest.json',
    '/onprem/1.4.305-onprem.1.zip', '/onprem/a/1.4.305.tgz', '/onprem/x.tgz', '/onprem/1.4.tgz']) {
    assert.equal((await call(e, p)).status, 404, p);
  }
  assert.equal((await call(e, '/onprem/latest.json', { method: 'POST' })).status, 405);
});

test('指標或更新檔還沒上架：誠實 404（JSON 說明），不是空內容', async () => {
  const e = { INSTALLER_KV: kv(), DIST: fakeR2({}), DIST_BASE: 'https://inst.test/dist' };
  const r = await call(e, '/onprem/latest.json');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /還沒有上架/);
  assert.equal((await call(e, '/onprem/1.4.999.tgz')).status, 404);
});

test('專用 R2（ONPREM，prod）優先於 DIST', async () => {
  const e = { INSTALLER_KV: kv(), ONPREM: fakeR2({ 'onprem/1.4.305.tgz': 'ABCDEF' }), DIST: fakeR2({ 'onprem/1.4.305.tgz': 'WRONG!' }) };
  const r = await call(e, '/onprem/1.4.305.tgz');
  assert.equal(await r.text(), 'ABCDEF');
});

test('沒綁 R2、有 ONPREM_BASE：轉讀那個網址，指標不快取、更新檔長快取；都沒有則 404 並說原因', async () => {
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return String(u).endsWith('nope.tgz') ? new Response('x', { status: 404 }) : new Response('{"v":1}', { headers: { 'content-type': 'application/json' } }); };
  try {
    const e = { INSTALLER_KV: kv(), ONPREM_BASE: 'https://origin.test/official' };
    const a = await call(e, '/onprem/latest.json');
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('cache-control'), 'no-cache');
    assert.equal((await call(e, '/onprem/1.4.305.tgz')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(seen, ['https://origin.test/official/latest.json', 'https://origin.test/official/1.4.305.tgz']);
    const none = await call({ INSTALLER_KV: kv() }, '/onprem/latest.json');
    assert.equal(none.status, 404);
    assert.match((await none.json()).error, /沒有地端更新檔/);
  } finally { restore(); }
});
