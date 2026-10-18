/**
 * inkstone/arcrun-rag#266：stage 的安裝檔與「最新版」指標住 R2（binding DIST）。
 * 與 worker.test.mjs 分檔：那支有 4000+ 行，這裡只鎖 R2 這一條路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const realFetch = globalThis.fetch;
function banNetwork() {
  globalThis.fetch = async (input) => { throw new Error('不該有任何對外 fetch：' + (typeof input === 'string' ? input : input.url)); };
}
const restore = () => { globalThis.fetch = realFetch; };

const kv = () => { const s = new Map(); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v) { s.set(k, v); }, async delete(k) { s.delete(k); } }; };

function fakeR2(objs) {
  const meta = (key) => ({
    size: objs[key].length, httpEtag: '"e"',
    writeHttpMetadata(h) { h.set('content-type', key.endsWith('.json') ? 'application/json' : 'application/x-apple-diskimage'); },
  });
  return {
    async head(key) { return objs[key] ? { ...meta(key), body: null } : null; },
    async get(key, opts) {
      const o = objs[key]; if (!o) return null;
      if (opts && opts.range) {
        const r = /bytes=(\d+)-(\d+)/.exec(opts.range.get('range'));
        const off = Number(r[1]); const end = Number(r[2]);
        return { ...meta(key), range: { offset: off, length: end - off + 1 }, body: o.slice(off, end + 1), text: async () => o.slice(off, end + 1) };
      }
      return { ...meta(key), body: o, text: async () => o };
    },
  };
}

const MANIFEST = JSON.stringify({ daemon: { version: '9.9.9', notes: 'n',
  mac: { file: 'daemon/Arcrun-9.9.9.dmg' }, win: { file: 'daemon/Arcrun-win-9.9.9.exe' } } });
const env = (objs) => ({
  INSTALLER_KV: kv(),
  // 故意指到 git.uncle6.me：走 R2 的環境絕不能再讀它（fetch 已全面禁止，真去讀會當場炸）
  BUNDLE_BASE: 'https://git.uncle6.me/inkstone/arcrun-rag-bundles-staging/raw/commit/deadbee',
  DIST_BASE: 'https://inst.test/dist',
  DIST: fakeR2(objs || { 'manifest.json': MANIFEST, 'daemon/Arcrun-9.9.9.dmg': 'MAC-BYTES-0123456789', 'daemon/Arcrun-win-9.9.9.exe': 'WIN' }),
});
const call = (e, path, init) => worker.fetch(new Request('https://inst.test' + path, init), e, { waitUntil() {} });

test('/dist/daemon/<檔>：從 R2 串出，200＋長度，且可 Range', async () => {
  const e = env();
  const res = await call(e, '/dist/daemon/Arcrun-9.9.9.dmg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '20');
  assert.equal(await res.text(), 'MAC-BYTES-0123456789');
  const rg = await call(e, '/dist/daemon/Arcrun-9.9.9.dmg', { headers: { range: 'bytes=0-2' } });
  assert.equal(rg.status, 206);
  assert.equal(rg.headers.get('content-range'), 'bytes 0-2/20');
  assert.equal(await rg.text(), 'MAC');
});

test('/dist：只開放 manifest.json 與 daemon/ 單層檔；其餘 404、非 GET/HEAD 405、HEAD 200', async () => {
  const e = env();
  for (const p of ['/dist/', '/dist/secret.txt', '/dist/daemon/', '/dist/daemon/a/b.dmg', '/dist/daemon/..%2fmanifest.json', '/dist/daemon/nope.dmg']) {
    assert.equal((await call(e, p)).status, 404, p);
  }
  assert.equal((await call(e, '/dist/manifest.json', { method: 'POST' })).status, 405);
  assert.equal((await call(e, '/dist/manifest.json', { method: 'HEAD' })).status, 200);
});

test('沒綁 DIST 的環境（prod／uncle6 staging）：/dist/ 不是特例路徑，行為不變', async () => {
  const res = await call({ INSTALLER_KV: kv() }, '/dist/manifest.json');
  assert.equal(res.status, 404);
  assert.notEqual(res.headers.get('content-type'), 'application/json');
});

test('/api/latest：daemon 版本與下載網址來自 R2 指標，完全不打網路（含 git.uncle6.me）', async () => {
  banNetwork();
  try {
    const j = await (await call(env(), '/api/latest')).json();
    assert.equal(j.daemon.version, '9.9.9');
    assert.equal(j.daemon.downloads.mac, 'https://inst.test/dist/daemon/Arcrun-9.9.9.dmg');
    assert.equal(j.daemon.downloads.win, 'https://inst.test/dist/daemon/Arcrun-win-9.9.9.exe');
    for (const u of Object.values(j.daemon.downloads)) assert.ok(!/git\.uncle6\.me/.test(u));
  } finally { restore(); }
});

test('/download/mac：直接從 R2 串出、帶檔名、不繞網路、不長快取', async () => {
  banNetwork();
  try {
    const res = await call(env(), '/download/mac');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /Arcrun-9\.9\.9\.dmg/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, must-revalidate');
    assert.equal(await res.text(), 'MAC-BYTES-0123456789');
  } finally { restore(); }
});

test('R2 指標不存在 ⇒ /download 給人話 503；指標在但檔不在 ⇒ 502', async () => {
  banNetwork();
  try {
    assert.equal((await call(env({}), '/download/win')).status, 503);
    assert.equal((await call(env({ 'manifest.json': MANIFEST }), '/download/win')).status, 502);
  } finally { restore(); }
});
