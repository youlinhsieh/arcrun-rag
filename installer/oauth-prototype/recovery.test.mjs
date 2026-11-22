/**
 * recovery.test.mjs — inkstone/arcrun-rag#383：任何錯誤畫面都有「發生什麼／你的東西現在怎樣／接著做的按鈕」
 * 跑法：node --test installer/oauth-prototype/recovery.test.mjs
 * 離線：fetch 與 KV 都是替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import { RECOVERY, buildRecovery, renderRecoveryCard, resumeHref } from './recovery.mjs';

const realFetch = globalThis.fetch;
const kv = () => { const s = new Map(); const puts = []; return { s, puts, async get(k, t) { const v = s.has(k) ? s.get(k) : null; return v && t === 'json' ? JSON.parse(v) : v; }, async put(k, v, o) { puts.push([k, o]); s.set(k, v); }, async delete(k) { s.delete(k); }, async list() { return { keys: [] }; } }; };
const call = (e, path, headers = {}) => worker.fetch(new Request('https://inst.test' + path, { headers, redirect: 'manual' }), e, { waitUntil() {} });
const BASE = 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@0376ecaabcdef';
const env = () => ({ INSTALLER_KV: kv(), BUNDLE_BASE: BASE });
const mail = async (email) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('arcrun-rag:grantmail:' + email));
  return 'grantmail:' + Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
};

test('目錄裡每一種錯誤都有三件事：發生什麼／現在狀態／按鈕', () => {
  for (const [k, r] of Object.entries(RECOVERY)) {
    assert.ok(r.title && r.what && r.status && r.button, k);
    const card = buildRecovery(k, { primaryHref: '/x', version: '1.4.270' });
    const h = renderRecoveryCard(card);
    assert.match(h, /<a class="btn"/, k);
    assert.ok(!/undefined|\{version\}/.test(h), k);
  }
});

test('首頁 ?error=<每一種碼>（含沒看過的碼）都畫出三件事＋按鈕', async () => {
  for (const code of [...Object.keys(RECOVERY), 'something_new']) {
    const res = await call(env(), `/?error=${code}`);
    const t = await res.text();
    assert.equal(res.status, 200, code);
    assert.match(t, /data-recovery=/, code);
    assert.match(t, /id="recovery-primary"/, code);
  }
});

test('授權過期且沒有續做紀錄：說明＋「資料沒被動到」＋重新開始', async () => {
  const t = await (await call(env(), '/?error=state')).text();
  assert.match(t, /授權等太久，過期了/);
  assert.match(t, /你的資料沒有被動到/);
  assert.match(t, /重新開始/);
});

test('授權過期但這個瀏覽器剛剛在更新：給「接著剛才的繼續」，直接重走授權不從頭填', async () => {
  const e = env();
  e.INSTALLER_KV.s.set('resume:sid1', JSON.stringify({ email: 'a@b.co', hadCode: false }));
  const t = await (await call(e, '/?error=state', { cookie: 'arcrun_sid=sid1' })).text();
  assert.match(t, /接著剛才的繼續/);
  assert.match(t, /href="\/auth\/start\?email=a%40b\.co&amp;agree=1"/);
});

test('本案：過期連結回來，但實例其實已是最新版 ⇒ 顯示「已經更新好了」＋版本＋回 Portal，不是錯誤', async () => {
  const e = env();
  e.INSTALLER_KV.s.set('resume:sid1', JSON.stringify({ email: 'a@b.co', hadCode: false }));
  e.INSTALLER_KV.s.set(await mail('a@b.co'), 'acc1');
  e.INSTALLER_KV.s.set('grant:acc1', JSON.stringify({ refresh_token: 'r' }));
  e.INSTALLER_KV.s.set('instance:acc1', JSON.stringify({ bundleBase: BASE, result: { url: 'https://arcrun-rag-ui.x.workers.dev/portal/' } }));
  globalThis.fetch = async (u) => String(u).endsWith('manifest.json') ? new Response(JSON.stringify({ release: '1.4.270', core: [] })) : new Response('x', { status: 404 });
  try {
    const t = await (await call(e, '/?error=state', { cookie: 'arcrun_sid=sid1' })).text();
    assert.match(t, /data-recovery="state_done"/);
    assert.match(t, /已經更新好了/);
    assert.match(t, /href="https:\/\/arcrun-rag-ui\.x\.workers\.dev\/portal\/"/);
    assert.match(t, /回到我的 Arcrun/);
    assert.ok(!/等太久/.test(t));
  } finally { globalThis.fetch = realFetch; }
});

test('實例不是最新版：不能說已更新好，仍給接著做', async () => {
  const e = env();
  e.INSTALLER_KV.s.set('resume:sid1', JSON.stringify({ email: 'a@b.co', hadCode: false }));
  e.INSTALLER_KV.s.set(await mail('a@b.co'), 'acc1');
  e.INSTALLER_KV.s.set('grant:acc1', JSON.stringify({ refresh_token: 'r' }));
  e.INSTALLER_KV.s.set('instance:acc1', JSON.stringify({ bundleBase: 'https://old', result: { url: 'https://p/' } }));
  const t = await (await call(e, '/?error=state', { cookie: 'arcrun_sid=sid1' })).text();
  assert.ok(!/已經更新好了/.test(t));
  assert.match(t, /接著剛才的繼續/);
});

test('新裝者（用過辨識碼）過期：回首頁並帶回 Email，不替他保管辨識碼', () => {
  assert.equal(resumeHref({ email: 'a@b.co', hadCode: true }), '/?email=a%40b.co');
  assert.equal(resumeHref(null), '/');
});

test('首頁帶 ?email= 會預填 Email 欄', async () => {
  const t = await (await call(env(), '/?email=a%40b.co')).text();
  assert.match(t, /id="email"[^>]*value="a@b\.co"/);
});

test('/auth/start 記下續做紀錄，且 state 活 60 分鐘（不是 10 分鐘）', async () => {
  const e = env();
  const g = await call(e, '/auth/start?email=a%40b.co&agree=1');
  assert.equal(g.status, 302);
  const st = e.INSTALLER_KV.puts.find(([k]) => k.startsWith('state:'));
  assert.equal(st[1].expirationTtl, 3600);
  const rs = e.INSTALLER_KV.puts.find(([k]) => k.startsWith('resume:'));
  assert.ok(rs);
  const rec = JSON.parse(e.INSTALLER_KV.s.get(rs[0]));
  assert.equal(rec.email, 'a@b.co');
  assert.equal(rec.hadCode, false);
  assert.ok(!('inviteCode' in rec) && !('code' in rec));
});

test('/install 沒有登入紀錄：導去帶續做的過期頁，不是空白錯誤', async () => {
  const g = await call(env(), '/install', { cookie: 'arcrun_sid=zzz' });
  assert.equal(g.status, 302);
  assert.match(g.headers.get('location'), /\/\?error=session$/);
  const t = await (await call(env(), '/?error=session')).text();
  assert.match(t, /登入已過期/);
  assert.match(t, /已經裝好的部分都還在/);
});

test('App 安裝連結過期：回 action 按鈕（不是只有一句話）', async () => {
  const r = await worker.fetch(new Request('https://inst.test/api/app/install', { method: 'POST', body: '{}' }), env(), { waitUntil() {} });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.ok(j.action && j.action.href && j.action.label);
  assert.match(j.message, /沒有被動到/);
});
