/**
 * inkstone/arcrun-rag#379：每個 App 一個入口網址。
 * 用真的 worker.fetch、假的 KV／R2／實例，把兩條路都走一遍：
 *   (a) 已有 Arcrun：只裝 App，不碰 Cloudflare、不重裝主程式
 *   (b) 沒有 Arcrun：導去原本的 OAuth（到授權頁前停），且 state 帶著 app，授權後 sess 帶著 app
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from './worker.js';
import * as AppEntry from './app-entry.mjs';

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };
const kv = () => {
  const s = new Map();
  return {
    s,
    async get(k, t) { const v = s.has(k) ? s.get(k) : null; return v !== null && t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { s.set(k, v); },
    async delete(k) { s.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...s.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
};
const sha = (t) => createHash('sha256').update(t).digest('hex');
const PKG = JSON.stringify({ format: 'arcrun-app-package', format_version: 1, app: { id: 'notes' }, declaration: { id: 'notes', version: '1.4.0', workflows: [] } });
const INDEX = JSON.stringify({
  schema: 1,
  apps: [
    { id: 'notes', name: '筆記', icon: '📝', summary: '隨手寫一則筆記', version: '1.4.0', author: 'Arcrun 內建', package: { url: 'packages/notes-1.4.0.json', sha256: sha(PKG) } },
    { id: 'old_one', name: '舊的', icon: '📦', summary: 'x', version: '1.0.0', author: 'a', retired: true, package: { url: 'packages/old_one-1.0.0.json' } },
  ],
});
const OBJS = { 'apps/index.json': INDEX, 'apps/packages/notes-1.4.0.json': PKG };
function fakeR2(objs) {
  const meta = (key) => ({ size: objs[key].length, httpEtag: '"e"', writeHttpMetadata(h) { h.set('content-type', 'application/json'); } });
  return { async head(k) { return objs[k] ? { ...meta(k), body: null } : null; }, async get(k) { const o = objs[k]; return o ? { ...meta(k), body: o, text: async () => o } : null; } };
}
const env = (extra = {}) => ({ INSTALLER_KV: kv(), DIST: fakeR2(OBJS), DIST_BASE: 'https://inst.test/dist', ...extra });
const call = (e, path, init) => worker.fetch(new Request('https://inst.test' + path, init), e, { waitUntil() {} });
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('清單與 App 頁只從 /apps/index.json 來；目錄沒有或已下架的 id 給說明頁（404）', async () => {
  const e = env();
  const list = await (await call(e, '/app')).text();
  assert.match(list, /筆記/);
  assert.doesNotMatch(list, /舊的/);
  const page = await call(e, '/notes');
  assert.equal(page.status, 200);
  const t = await page.text();
  assert.match(t, /安裝「筆記」/);
  assert.match(t, /action="\/notes\/go"/);
  for (const id of ['nope', 'old_one', 'x%20y', 'NOTES']) {
    const r = await call(e, '/' + id);
    assert.equal(r.status, 404, id);
    if (/^[a-z_]+$/.test(id)) assert.match(await r.text(), /市集裡沒有這個 App/); // 像 App id 的給說明頁；其餘維持一般 404
  }
});

test('目錄讀不到：誠實說讀不到（503），不回「沒有這個 App」', async () => {
  const e = { INSTALLER_KV: kv(), APP_FEED_BASE: 'https://feed.test' };
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    const r = await call(e, '/app/notes');
    assert.equal(r.status, 503);
    assert.doesNotMatch(await r.text(), /市集裡沒有這個 App/);
    const root = await call(e, '/notes'); // /<id> 形狀讀不到目錄：一般 404，不假裝知道有沒有這個 App
    assert.equal(root.status, 404);
    assert.doesNotMatch(await root.text(), /市集裡沒有這個 App/);
  } finally { restore(); }
});

async function seedInstalled(e, { gone = false } = {}) {
  const email = 'a@b.co';
  const idx = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('arcrun-rag:grantmail:' + email));
  const hex = Array.from(new Uint8Array(idx), (b) => b.toString(16).padStart(2, '0')).join('');
  await e.INSTALLER_KV.put('grantmail:' + hex, 'ACC1');
  await e.INSTALLER_KV.put('grant:ACC1', JSON.stringify({ refresh_token: 'r', accountId: 'ACC1', email }));
  await e.INSTALLER_KV.put('instance:ACC1', JSON.stringify({ at: 1, bundleBase: 'x', result: { apiUrl: 'https://cy.test', url: 'https://ui.test/portal/', tenant: 'ten1', suffix: 's' } }));
  await e.INSTALLER_KV.put('kbdbtok:ACC1', 'kbdbsecret');
  return email;
}

test('(a) 已有 Arcrun：辨識碼對 → 只對實例的 /apps/import 送 App 包，完全沒打 Cloudflare、沒重裝', async () => {
  const e = env();
  const email = await seedInstalled(e);
  const seen = [];
  globalThis.fetch = async (u, init) => {
    u = String(u); seen.push(u);
    if (u.endsWith('/api/verify-code')) return Response.json({ ok: true });
    if (u.startsWith('https://api.cloudflare.com')) return Response.json({ success: true, result: { access_token: 't' } }); // instanceIsGone 的探測
    if (u === 'https://cy.test/apps/import') {
      assert.equal(init.headers['X-Arcrun-API-Key'], 'ten1');
      assert.match(init.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
      assert.equal(JSON.parse(init.body).declaration.id, 'notes');
      return Response.json({ installed: true, changed: true, missing_credentials: [] });
    }
    throw new Error('unexpected ' + u);
  };
  try {
    const go = await call(e, `/notes/go?email=${email}&code=ABC&agree=1`);
    assert.equal(go.status, 200);
    assert.match(await go.text(), /正在裝「筆記」/);
    const ck = cookieOf(go);
    assert.ok(ck.startsWith('arcrun_sid='));
    const r = await call(e, '/api/app/install', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: '{}' });
    const j = await r.json();
    assert.equal(j.state, 'done');
    assert.equal(j.url, 'https://ui.test/portal/');
    assert.ok(seen.includes('https://cy.test/apps/import'));
    // 不碰授權同意頁、沒有任何部署動作：只允許 verify-code、既有授權的換票／唯讀探測、/apps/import
    assert.ok(!seen.some((u) => /oauth2\/auth(?!\w)|consent/.test(u)), seen.join('\n'));
    assert.ok(seen.every((u) => /verify-code|cloudflare\.com|cy\.test\/apps\/import/.test(u)), seen.join('\n'));
  } finally { restore(); }
});

test('(a) 只知道 Email 不行：辨識碼不對 → 導回 App 頁、不發憑條、不打實例', async () => {
  const e = env();
  const email = await seedInstalled(e);
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.endsWith('/api/verify-code')) return Response.json({ ok: false }, { status: 403 });
    if (u.startsWith('https://api.cloudflare.com')) return Response.json({ success: true, result: {} });
    throw new Error('unexpected ' + u);
  };
  try {
    const go = await call(e, `/notes/go?email=${email}&code=BAD&agree=1`);
    assert.equal(go.status, 302);
    assert.match(go.headers.get('location'), /\/notes\?error=code$/);
    assert.ok(![...e.INSTALLER_KV.s.keys()].some((k) => k.startsWith('appins:')));
    // 沒憑條就打 API → 401
    const r = await call(e, '/api/app/install', { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  } finally { restore(); }
});

test('(a) 大 App 分段：實例回 in_progress 帶接續點，後端接著打；平台太舊給白話', async () => {
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    return calls.length < 3 ? Response.json({ installed: false, in_progress: true, resume_from: calls.length * 10, resume_hash: 'h' + calls.length })
      : Response.json({ installed: true, changed: true });
  };
  try {
    const r = await AppEntry.importIntoInstance({ apiUrl: 'https://cy.test/', authHeaders: {}, pkg: {}, name: '筆記' });
    assert.equal(r.state, 'done');
    assert.deepEqual(calls, ['https://cy.test/apps/import', 'https://cy.test/apps/import?from=10&h=h1', 'https://cy.test/apps/import?from=20&h=h2']);
    globalThis.fetch = async () => Response.json({ code: 'engine_too_old', needs: '1.4.300', have: '1.4.200' }, { status: 409 });
    const old = await AppEntry.importIntoInstance({ apiUrl: 'https://cy.test', authHeaders: {}, pkg: {}, name: '筆記' });
    assert.equal(old.state, 'engine_old');
    assert.match(old.message, /1\.4\.300/);
    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal((await AppEntry.importIntoInstance({ apiUrl: 'https://cy.test', authHeaders: {}, pkg: {}, name: 'x' })).state, 'retry');
  } finally { restore(); }
});

test('App 包的雜湊對不上目錄 → 不送出去', async () => {
  const bad = { ...OBJS, 'apps/packages/notes-1.4.0.json': PKG + ' ' };
  const e = { INSTALLER_KV: kv(), DIST: fakeR2(bad), DIST_BASE: 'https://inst.test/dist' };
  const email = await seedInstalled(e);
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.endsWith('/api/verify-code')) return Response.json({ ok: true });
    if (u.startsWith('https://api.cloudflare.com')) return Response.json({ success: true, result: {} });
    throw new Error('不該打到實例 ' + u);
  };
  try {
    const go = await call(e, `/notes/go?email=${email}&code=ABC&agree=1`);
    const r = await call(e, '/api/app/install', { method: 'POST', headers: { cookie: cookieOf(go) }, body: '{}' });
    const j = await r.json();
    assert.equal(j.state, 'error');
    assert.match(j.message, /對不上/);
  } finally { restore(); }
});

test('(b) 沒有 Arcrun：導去原本的安裝流程（帶 app）→ 走到 Cloudflare 授權頁前，state 帶著 app', async () => {
  const e = env();
  globalThis.fetch = async (u) => {
    if (String(u).endsWith('/api/verify-code')) return Response.json({ ok: true });
    throw new Error('unexpected ' + u);
  };
  try {
    const go = await call(e, '/notes/go?email=new@user.co&code=ABC&agree=1');
    assert.equal(go.status, 302);
    const loc = new URL(go.headers.get('location'));
    assert.equal(loc.pathname, '/auth/start');
    assert.equal(loc.searchParams.get('app'), 'notes');
    const start = await call(e, loc.pathname + loc.search);
    assert.equal(start.status, 302);
    const cf = new URL(start.headers.get('location'));
    assert.match(cf.hostname, /cloudflare/);          // 停在授權頁前
    const stateKey = [...e.INSTALLER_KV.s.keys()].find((k) => k.startsWith('state:'));
    assert.equal(JSON.parse(e.INSTALLER_KV.s.get(stateKey)).app, 'notes');
    // 目錄裡沒有的 app 不會被帶進 state
    const e2 = env();
    const s2 = await call(e2, '/auth/start?email=n@u.co&code=ABC&agree=1&app=evil');
    assert.equal(s2.status, 302);
    const k2 = [...e2.INSTALLER_KV.s.keys()].find((k) => k.startsWith('state:'));
    assert.equal(JSON.parse(e2.INSTALLER_KV.s.get(k2)).app, null);
  } finally { restore(); }
});

test('(b) 授權回來後：sess 帶著 app；/install 頁出現 App 進度區與接力腳本；主程式裝完才會輪到 App', async () => {
  const e = env();
  const sid = 'SID1';
  await e.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ access_token: 'a', inviteVerified: true, app: 'notes', createdAt: Date.now() }));
  const page = await call(e, '/install', { headers: { cookie: `arcrun_sid=${sid}` } });
  const t = await page.text();
  assert.match(t, /正在裝「筆記」/);
  assert.match(t, /"wait":true/);
  assert.match(t, /\/app-install\.js/);
  // 主程式還沒裝完 → 不准裝 App
  const r0 = await call(e, '/api/app/install', { method: 'POST', headers: { cookie: `arcrun_sid=${sid}` }, body: '{}' });
  assert.equal(r0.status, 401);
  // 裝完（progress done＋快照）→ 才打得過
  await e.INSTALLER_KV.put(`progress:${sid}`, JSON.stringify({ state: 'done', result: { accountId: 'ACC9' } }));
  const js = await (await call(e, '/app-install.js')).text();
  assert.match(js, /\/api\/app\/install/);
});
