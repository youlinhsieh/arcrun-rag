/**
 * inkstone/arcrun-rag#398：安裝站提供 `/portal/current.json` 與 `/portal/packs/<版>.json`（Portal 畫面包），
 * 家＝市集的 `market/portal/`；只開這兩類 key。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const kv = () => { const s = new Map(); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v) { s.set(k, v); }, async delete(k) { s.delete(k); } }; };
function fakeR2(objs) {
  return { async get(key) { const o = objs[key]; return o ? { body: o, text: async () => o } : null; }, async head(key) { return objs[key] ? { size: 1 } : null; } };
}
const call = (e, path, init) => worker.fetch(new Request('https://inst.test' + path, init), e, { waitUntil() {} });
const OBJS = {
  'market/portal/current.json': '{"version":"2026.11.28-abc1234","sha256":"x","floor_bundle_version":"1.4.338"}',
  'market/portal/packs/2026.11.28-abc1234.json': '{"schema":1,"files":{}}',
  'market/current.json': '{"version":"2026.11.22-1234567"}',
  'manifest.json': '{"secret":1}',
};
const env = () => ({ INSTALLER_KV: kv(), DIST: fakeR2(OBJS) });

test('指標與包都從 market/portal/ 讀出，指標不快取、包長快取', async () => {
  const e = env();
  const a = await call(e, '/portal/current.json');
  assert.equal(a.status, 200);
  assert.equal((await a.json()).version, '2026.11.28-abc1234');
  assert.equal(a.headers.get('cache-control'), 'no-cache');
  const b = await call(e, '/portal/packs/2026.11.28-abc1234.json');
  assert.equal(b.status, 200);
  assert.match(b.headers.get('cache-control'), /immutable/);
});

test('只開兩類 key；其他（含 ..、別的前綴）404，非 GET/HEAD 405', async () => {
  const e = env();
  for (const p of ['/portal/packs/', '/portal/packs/x.json', '/portal/packs/%2e%2e/manifest.json', '/portal/packs/2026.11.28-abc1234.txt']) {
    assert.equal((await call(e, p)).status, 404, p);
  }
  assert.equal((await call(e, '/portal/current.json', { method: 'POST' })).status, 405);
});

test('還沒上過畫面包：指標誠實 404（用戶端照用內嵌畫面）', async () => {
  const e = { INSTALLER_KV: kv(), DIST: fakeR2({}) };
  const r = await call(e, '/portal/current.json');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /還沒有 Portal 畫面包/);
});
