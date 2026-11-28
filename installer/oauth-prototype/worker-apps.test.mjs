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

test('沒綁 R2 也沒設 APP_FEED_BASE（prod）：目錄跟著零件包釘子走——jsDelivr @sha 換成 raw.githubusercontent 同一個 sha 的 apps/', async () => {
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return String(u).endsWith('nope-1.0.0.json') ? new Response('x', { status: 404 }) : new Response('{"ok":1}', { headers: { 'content-type': 'text/plain' } }); };
  try {
    const e = { INSTALLER_KV: kv(), BUNDLE_BASE: 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@0376ecaabcdef' };
    const i = await call(e, '/apps/index.json');
    assert.equal(i.status, 200);
    assert.match(i.headers.get('content-type'), /json/);
    assert.equal(i.headers.get('cache-control'), 'no-cache');
    assert.equal((await call(e, '/apps/packages/notes-1.4.0.json')).status, 200);
    assert.deepEqual(seen, [
      'https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/0376ecaabcdef/apps/index.json',
      'https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/0376ecaabcdef/apps/packages/notes-1.4.0.json',
    ]);
    // 釘住的那一版沒有目錄（舊釘子）：誠實 404，不回空目錄
    const miss = await call(e, '/apps/packages/nope-1.0.0.json');
    assert.equal(miss.status, 404);
    assert.match((await miss.json()).error, /釘住的那一版沒有 App 市集目錄/);
    // 其他釘子（Gitea raw）直接讀 bundle 根目錄的 apps/
    seen.length = 0;
    await call({ INSTALLER_KV: kv(), BUNDLE_BASE: 'https://git.test/o/r/raw/commit/2c81ea6' }, '/apps/index.json');
    assert.deepEqual(seen, ['https://git.test/o/r/raw/commit/2c81ea6/apps/index.json']);
  } finally { restore(); }
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

// ── inkstone/arcrun-rag#381：市集上架線——/apps 讀「最後一次簽過的市集版」，與零件包釘子無關 ──
const MV = '2026.11.22-abc1234';
const MARKET_OBJS = {
  'market/current.json': JSON.stringify({ schema: 1, version: MV }),
  [`market/index/${MV}.json`]: '{"schema":1,"apps":[{"id":"ahub"}]}',
  'market/index/2026.11.20-0000000.json': '{"schema":1,"apps":["old"]}',
  'market/packages/ahub-1.0.1.json': '{"pkg":"ahub"}',
  // 舊路（主程式 bundle 帶的目錄）還在 R2 時，有市集指標就不能讀到它
  'apps/index.json': '{"schema":1,"apps":["LEGACY"]}',
};
const withMarketR2 = () => ({ INSTALLER_KV: kv(), DIST: fakeR2(MARKET_OBJS), DIST_BASE: 'https://inst.test/dist' });

test('有市集指標（R2）：/apps/index.json 讀指標指的那一版目錄，不讀舊 apps/；回應帶市集版號', async () => {
  const e = withMarketR2();
  const r = await call(e, '/apps/index.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-arcrun-market-version'), MV);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(await r.json(), { schema: 1, apps: [{ id: 'ahub' }] });
  const p = await call(e, '/apps/packages/ahub-1.0.1.json');
  assert.equal(p.status, 200);
  assert.match(p.headers.get('cache-control'), /immutable/);
  assert.equal(await p.text(), '{"pkg":"ahub"}');
  const c = await call(e, '/apps/current.json');
  assert.equal((await c.json()).version, MV);
});

test('指標翻回前一版＝回退：/apps/index.json 立刻是前一版目錄', async () => {
  const objs = { ...MARKET_OBJS, 'market/current.json': JSON.stringify({ schema: 1, version: '2026.11.20-0000000' }) };
  const e = { INSTALLER_KV: kv(), DIST: fakeR2(objs), DIST_BASE: 'https://inst.test/dist' };
  assert.deepEqual(await (await call(e, '/apps/index.json')).json(), { schema: 1, apps: ['old'] });
});

test('有指標但包不在：誠實 404，不退回舊路', async () => {
  const e = withMarketR2();
  assert.equal((await call(e, '/apps/packages/nope-1.0.0.json')).status, 404);
});

test('指標版號不合法（防路徑被塞進去）：502', async () => {
  const objs = { ...MARKET_OBJS, 'market/current.json': JSON.stringify({ version: '../manifest' }) };
  const e = { INSTALLER_KV: kv(), DIST: fakeR2(objs), DIST_BASE: 'https://inst.test/dist' };
  assert.equal((await call(e, '/apps/index.json')).status, 502);
});

test('沒有市集指標：舊路照舊（R2 的 apps/），/apps/current.json 誠實 404', async () => {
  const e = withR2();
  assert.equal((await call(e, '/apps/index.json')).status, 200);
  assert.equal((await call(e, '/apps/current.json')).status, 404);
});

test('prod：MARKET_BASE 指向官方市集，指標與目錄讀那裡；主程式釘子（BUNDLE_BASE）完全不被碰', async () => {
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    if (String(u).endsWith('/current.json')) return new Response(JSON.stringify({ version: MV }));
    return new Response('{"apps":[]}');
  };
  try {
    const e = { INSTALLER_KV: kv(), MARKET_BASE: 'https://market.test/m/', BUNDLE_BASE: 'https://cdn.jsdelivr.net/gh/x/y@0376ecaabcdef' };
    const r = await call(e, '/apps/index.json');
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ['https://market.test/m/current.json', `https://market.test/m/index/${MV}.json`]);
    assert.ok(!seen.some((u) => /jsdelivr|raw\.githubusercontent/.test(u)));
  } finally { restore(); }
});

test('MARKET_BASE 還沒有指標（404）：退回舊路（跟著釘子），不直接壞掉', async () => {
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return String(u).includes('market.test') ? new Response('x', { status: 404 }) : new Response('{"legacy":1}'); };
  try {
    const e = { INSTALLER_KV: kv(), MARKET_BASE: 'https://market.test/m', BUNDLE_BASE: 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@0376ecaabcdef' };
    const r = await call(e, '/apps/index.json');
    assert.equal(r.status, 200);
    assert.ok(seen.some((u) => u.includes('raw.githubusercontent.com')));
  } finally { restore(); }
});

test('市集來源暫時壞掉（5xx）：502，不退回舊路（免得用戶看到另一份目錄）', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    const e = { INSTALLER_KV: kv(), MARKET_BASE: 'https://market.test/m' };
    assert.equal((await call(e, '/apps/index.json')).status, 502);
  } finally { restore(); }
});

// inkstone/arcrun-rag#381：prod 市集的家＝uncle6 專用 R2（binding MARKET，私有 bucket，不開公開網域）。
const MKT = {
  'market/current.json': '{"version":"2026.11.28-abcdef0"}',
  'market/index/2026.11.28-abcdef0.json': '{"schema":1,"apps":[{"id":"notes"}]}',
  'market/packages/notes-1.5.0.json': '{"pkg":"notes"}',
};
test('prod：綁了 MARKET（R2）就讀 market/current.json 指的那版，不碰零件包釘子；/apps 網址不變', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response('x', { status: 500 }); };
  try {
    const e = { INSTALLER_KV: kv(), MARKET: fakeR2(MKT), BUNDLE_BASE: 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@0376ecaabcdef' };
    const c = await call(e, '/apps/current.json');
    assert.equal(c.status, 200);
    assert.equal((await c.json()).version, '2026.11.28-abcdef0');
    const i = await call(e, '/apps/index.json');
    assert.equal(i.status, 200);
    assert.equal(i.headers.get('x-arcrun-market-version'), '2026.11.28-abcdef0');
    assert.deepEqual(await i.json(), { schema: 1, apps: [{ id: 'notes' }] });
    assert.equal((await call(e, '/apps/packages/notes-1.5.0.json')).status, 200);
    assert.equal((await call(e, '/apps/packages/nope-1.0.0.json')).status, 404);
    assert.equal(fetched, 0, '有 MARKET 就不該打任何外網');
  } finally { restore(); }
});
test('prod：綁了 MARKET 但還沒有指標（空 bucket）＝照舊跟釘子走，/apps/current.json 誠實 404', async () => {
  const e = { INSTALLER_KV: kv(), MARKET: fakeR2({}) };
  const c = await call(e, '/apps/current.json');
  assert.equal(c.status, 404);
});
