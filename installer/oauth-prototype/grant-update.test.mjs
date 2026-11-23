/**
 * #163「更新 ≠ 再裝一次」的離線測試
 *
 * 跑法：node --test grant-update.test.mjs
 * （零依賴、不觸網——CF token 端點與 API 全用假 fetch）
 *
 * 這支要證明的四件事，一一對應票上的驗收條件：
 *   ① 已裝過的帳號要更新 ⇒ 不需要重新授權（grant 換得到 token，全程不碰授權頁）
 *   ② 更新不重建資源（資源步驟被預先標成 done，走既有的沿用路徑）
 *   ③ **第一次安裝仍然要人明確授權**（這一格不准被優化掉——所以有一個測試專門盯它）
 *   ④ 授權可撤銷，撤銷後下一次會重新要求
 *
 * 另外盯一條**會靜默壞掉**的不變量：
 *   ⑤ refresh_token 交接之後，session 手上不可以還留著一把
 *      （rotation 制單次有效——兩個擁有者會互相作廢，
 *        症狀是「更新時好時壞且無法重現」。`decisions-summary.md:2225` 已記載這個坑。）
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, {
  adoptGrant,
  grantAccessToken,
  dropGrant,
  saveInstanceSnapshot,
  sweepUpdates,
  runUpdate,
  GrantUnavailable,
  UPDATE_REUSE_STEPS,
  emailIndexKey,
  liveGrantForEmail,
  ensureUpdateToken,
  timingSafeEqual,
  readPrepared,
  writePrepared,
  activatePreparedVersion, switchWithSecretGuard, prepareChainGuard,
  runUpdateChainBatch, kickUpdateChain, readUpdateChain,
} from './worker.js';

// --- 測試替身 -------------------------------------------------------------

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      if (type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return v;
    },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix, limit } = {}) {
      const keys = [];
      for (const name of store.keys()) {
        if (!prefix || name.startsWith(prefix)) {
          keys.push({ name });
          if (limit && keys.length >= limit) break;
        }
      }
      return { keys };
    },
  };
}

const realFetch = globalThis.fetch;
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
    const r = await handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() { return r.json; },
      async text() { return r.text !== undefined ? r.text : JSON.stringify(r.json); },
    };
  };
  return calls;
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

/** CF token 端點：每次換都吐一把**新的** refresh_token（模擬 rotation 制）。 */
function tokenEndpoint({ rotation = 0 } = {}) {
  let n = rotation;
  return (url) => {
    if (url.includes('/oauth2/token')) {
      n += 1;
      return { status: 200, json: { access_token: 'at-' + n, refresh_token: 'rt-' + n, expires_in: 57600, scope: 'x' } };
    }
    return { status: 404, json: {} };
  };
}

/** token 端點＋「UI worker 設定」查詢（實例在不在）。 */
function instanceEndpoint(settingsStatus) {
  const tok = tokenEndpoint();
  return (url, init) => {
    if (url.includes('/workers/scripts/arcrun-rag-ui/settings')) return { status: settingsStatus, json: {} };
    return tok(url, init);
  };
}

// --- ① + ⑤ 交接，不是複製 ---------------------------------------------------

test('#163 安裝成功後把長期授權收下——而且 session 不再持有 refresh_token（rotation 只准一個擁有者）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-1';
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({
    access_token: 'at-0', refresh_token: 'rt-0', inviteEmail: 'a@test.example', scope: 's',
  }));

  const rec = await adoptGrant(env, sid, 'acct-1', 'a@test.example');
  assert.equal(rec.refresh_token, 'rt-0');

  const grant = await env.INSTALLER_KV.get('grant:acct-1', 'json');
  assert.equal(grant.refresh_token, 'rt-0', 'grant 要拿到那把 refresh_token');
  assert.equal(grant.email, 'a@test.example');

  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  assert.equal(sess.refresh_token, undefined,
    '🔴 交接後 session 不可以還留著 refresh_token——留著就會把 grant 那把輪替掉');
  assert.equal(sess.access_token, 'at-0', 'access_token 留著（成功頁還要用）');
});

test('#163 沒有 refresh_token 的 session 不會被硬造出一個 grant', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('sess:sid-2', JSON.stringify({ access_token: 'at', inviteEmail: 'b@test.example' }));
  assert.equal(await adoptGrant(env, 'sid-2', 'acct-2', 'b@test.example'), null);
  assert.equal(await env.INSTALLER_KV.get('grant:acct-2'), null);
});

// --- ① 更新時換得到 token，全程不碰授權頁 ------------------------------------

test('#163 grant 換 token：不打授權頁，且把輪替後的新 refresh_token 存回去', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('grant:acct-3', JSON.stringify({ refresh_token: 'rt-0', accountId: 'acct-3' }));

  const calls = installFetch(tokenEndpoint());
  try {
    const tok = await grantAccessToken(env, 'acct-3');
    assert.equal(tok.access_token, 'at-1');
  } finally { restoreFetch(); }

  // 全程只打 token 端點，一次都沒有導向 dash 的授權屏
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/oauth2\/token$/);
  assert.ok(!calls.some((c) => /oauth2\/auth/.test(c.url)), '更新不可以碰授權頁');

  const grant = await env.INSTALLER_KV.get('grant:acct-3', 'json');
  assert.equal(grant.refresh_token, 'rt-1', 'rotation：一定要存回新的，否則下次就用不了');
});

test('#163 同一個帳號的輪替是序列化的——鎖住時第二個呼叫拿到 busy，不會兩邊互相作廢', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('grant:acct-4', JSON.stringify({ refresh_token: 'rt-0', accountId: 'acct-4' }));
  await env.INSTALLER_KV.put('grantlock:acct-4', String(Date.now()));   // 假裝另一輪正在換

  await assert.rejects(
    () => grantAccessToken(env, 'acct-4'),
    (e) => e instanceof GrantUnavailable && e.reason === 'busy',
  );
});

// --- ④ 撤銷 ---------------------------------------------------------------

test('#163 使用者在 CF 後台撤銷 ⇒ invalid_grant ⇒ 本地 grant 自己刪掉（下次會重新要求授權）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('grant:acct-5', JSON.stringify({ refresh_token: 'rt-dead', accountId: 'acct-5' }));

  installFetch((url) => url.includes('/oauth2/token')
    ? { status: 400, json: { error: 'invalid_grant', error_description: 'token revoked' } }
    : { status: 404, json: {} });
  try {
    await assert.rejects(
      () => grantAccessToken(env, 'acct-5'),
      (e) => e instanceof GrantUnavailable && e.reason === 'revoked',
    );
  } finally { restoreFetch(); }

  assert.equal(await env.INSTALLER_KV.get('grant:acct-5'), null,
    '撤銷後那把必須從 KV 消失——不然下次還會拿它去試');
});

test('#163 CF 暫時掛掉（不是撤銷）⇒ **不准**刪掉授權，留給下一輪重試', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('grant:acct-6', JSON.stringify({ refresh_token: 'rt-ok', accountId: 'acct-6' }));

  installFetch((url) => url.includes('/oauth2/token')
    ? { status: 503, json: { error: 'server_error' } }
    : { status: 404, json: {} });
  try {
    await assert.rejects(() => grantAccessToken(env, 'acct-6'), (e) => e instanceof GrantUnavailable);
  } finally { restoreFetch(); }

  assert.ok(await env.INSTALLER_KV.get('grant:acct-6'),
    '🔴 暫時性失敗把使用者的授權刪掉＝每次 CF 抖一下就要人重新授權一次');
});

// --- ③ 第一次安裝仍然要人授權（這一格不准被優化掉）---------------------------

test('#163 紅線：即使已經有 grant，安裝頁的 /auth/start 仍然導去 Cloudflare 授權頁', async () => {
  const env = { INSTALLER_KV: makeKV(), LANDING_BASE: 'https://landing.test' };
  await env.INSTALLER_KV.put('grant:acct-7', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-7' }));

  const res = await worker.fetch(
    new Request('https://install.test/auth/start?email=a%40test.example&code=&agree=1'),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /dash\.cloudflare\.com\/oauth2\/auth/,
    '🔴 人走安裝頁時一定要看到授權屏——grant 是給「不需要人在場的更新」用的，不是給安裝抄捷徑用的');
});

// --- ② 更新不重建資源 -------------------------------------------------------

test('#163 更新沿用的是資源類步驟——schema／deploy/workflows/verify 不在沿用清單裡', () => {
  assert.deepEqual(UPDATE_REUSE_STEPS, ['account', 'cache', 'database']);
  // inkstone/arcrun-rag#381：schema 是跟著程式版本走的資料層升級，更新一定要做（否則新增 migration 的版本更新後資料層落後一代）。
  for (const s of ['schema', 'deploy', 'workflows', 'verify']) {
    assert.ok(!UPDATE_REUSE_STEPS.includes(s), `${s} 是更新真正要做的事，不能被跳過`);
  }
});

test('#163 沒有實例快照就不更新（fail-closed）——不猜資源，退回完整安裝', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('grant:acct-8', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-8' }));

  const calls = installFetch(tokenEndpoint());
  try {
    const r = await runUpdate(env, 'acct-8');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_snapshot');
  } finally { restoreFetch(); }
  assert.equal(calls.length, 0, '沒快照就該直接停手，一次 CF 都不該打');
});

test('#163 實例快照不存 kbdbToken（金鑰有自己的家，不多存一份會漂的）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await saveInstanceSnapshot(env, 'acct-9', {
    result: { accountId: 'acct-9', kbdbToken: 'SECRET-should-not-be-here', subdomain: 'sub', email: 'e@test.example' },
  });
  const snap = await env.INSTALLER_KV.get('instance:acct-9', 'json');
  assert.equal(snap.result.kbdbToken, undefined);
  assert.equal(snap.result.subdomain, 'sub');
  assert.ok(!JSON.stringify(snap).includes('SECRET-should-not-be-here'));
});

// --- 掃描：只動落後的那些 ---------------------------------------------------

test('#163 掃描時跳過「已經是這一版」的帳號——不做無謂的重推', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@aaaaaaa' };
  // 這台已經是現行釘子 ⇒ 應該被跳過
  await env.INSTALLER_KV.put('grant:acct-cur', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-cur' }));
  await env.INSTALLER_KV.put('instance:acct-cur', JSON.stringify({
    result: { accountId: 'acct-cur' }, bundleBase: 'https://cdn.test/gh/x@aaaaaaa',
  }));

  const calls = installFetch(tokenEndpoint());
  try {
    const results = await sweepUpdates(env, 5);
    assert.equal(results.length, 0, '同一版的帳號不該被碰');
  } finally { restoreFetch(); }
  assert.equal(calls.length, 0, '跳過的帳號連 token 都不該去換');
});

// --- 出貨管線要用的那支端點 -------------------------------------------------

test('#163 /admin/update-sweep：沒有 admin key ⇒ 404（不洩漏這支存在）', async () => {
  const env = { INSTALLER_KV: makeKV(), ADMIN_LOG_KEY: 'k1' };
  const res = await worker.fetch(new Request('https://i.test/admin/update-sweep', { method: 'POST' }), env, { waitUntil() {} });
  assert.equal(res.status, 404);
});

test('#163 /admin/update-sweep：帶對 key ⇒ 回機器可讀的結果（出貨管線據此說得出卡在哪）', async () => {
  const env = { INSTALLER_KV: makeKV(), ADMIN_LOG_KEY: 'k1', BUNDLE_BASE: 'https://cdn.test/gh/x@newpin' };
  // 一台落後的（沒有快照 ⇒ 會回 no_snapshot，正是「說得出卡在哪一站」要的東西）
  await env.INSTALLER_KV.put('grant:acct-a', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-a' }));
  await env.INSTALLER_KV.put('instance:acct-a', JSON.stringify({ result: {}, bundleBase: 'https://cdn.test/gh/x@oldpin' }));

  installFetch(tokenEndpoint());
  let body;
  try {
    const res = await worker.fetch(
      new Request('https://i.test/admin/update-sweep?key=k1', { method: 'POST' }), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    body = await res.json();
  } finally { restoreFetch(); }

  assert.equal(body.checked, 1);
  assert.equal(body.bundleBase, 'https://cdn.test/gh/x@newpin');
  assert.equal(body.results[0].accountId, 'acct-a');
  assert.ok(body.results[0].reason, '失敗一定要帶 reason 短碼，不能只說「失敗了」');
});

test('#163 掃描會挑出「釘子換了」的帳號，並受預算限制', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@bbbbbbb' };
  for (const id of ['acct-old1', 'acct-old2', 'acct-old3']) {
    await env.INSTALLER_KV.put('grant:' + id, JSON.stringify({ refresh_token: 'rt', accountId: id }));
    await env.INSTALLER_KV.put('instance:' + id, JSON.stringify({
      result: { accountId: id }, bundleBase: 'https://cdn.test/gh/x@aaaaaaa',   // 舊釘子
    }));
  }

  installFetch((url) => url.includes('/oauth2/token')
    ? { status: 400, json: { error: 'invalid_grant' } }        // 讓它早退，本測只驗「挑了誰、挑幾個」
    : { status: 404, json: {} });
  try {
    const results = await sweepUpdates(env, 2);
    assert.equal(results.length, 2, '預算 2 ⇒ 這一輪最多處理 2 個，其餘留給後續輪次');
    for (const r of results) assert.equal(r.ok, false);
  } finally { restoreFetch(); }
});


// ---------------------------------------------------------------------------
// #163 第二輪：安裝頁必須在**進 OAuth 之前**就認得出已裝好的人
//
// 打回的實測（總管，在 leo 已登入的 Chrome）：已裝過的帳號第二次仍看到
// dash.cloudflare.com/oauth/consent-form。真因＝重用發生在 callback 之後
// （那時才有帳號 id），而畫面早就被送去 CF 了。⇒ 攔截點錯了，不是參數錯了。
// ---------------------------------------------------------------------------

test('#163 已裝好的 email 走 /auth/start ⇒ **不再導去 Cloudflare**，直接看到「你已經裝好了」', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-idx';
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({
    access_token: 'at', refresh_token: 'rt', inviteEmail: 'known@test.example',
  }));
  await adoptGrant(env, sid, 'acct-known', 'known@test.example');

  installFetch(instanceEndpoint(200));
  let res, body;
  try {
    res = await worker.fetch(
      new Request('https://i.test/auth/start?email=known%40test.example&code=&agree=1'), env, { waitUntil() {} });
    body = await res.text();
  } finally { restoreFetch(); }

  assert.equal(res.status, 200, '應該直接給頁面，不是 302 去 CF');
  assert.ok(!/dash\.cloudflare\.com/.test(body), '🔴 這一頁不可以把人送去 Cloudflare');
  assert.match(body, /你已經裝好了/);
  // arcrun-rag#289：重新安裝連結必須帶 agree=1，否則回首頁出現「請先同意授權條款」形成迴圈
  assert.match(body, /href="\/auth\/start\?email=known%40test\.example&amp;agree=1&amp;reinstall=1"/);
  // 兩顆按鈕分開排（不再用 margin-left 黏在一起）
  assert.ok(!/margin-left:8px/.test(body));
});

test('#289 授權還在但實例已被刪光 ⇒ 不再說「已經裝好」，直接進 Cloudflare 授權，並清掉過期快照', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('sess:sg', JSON.stringify({
    access_token: 'at', refresh_token: 'rt', inviteEmail: 'wiped@test.example' }));
  await adoptGrant(env, 'sg', 'acct-wiped', 'wiped@test.example');
  await env.INSTALLER_KV.put('instance:acct-wiped', JSON.stringify({ result: {} }));

  installFetch(instanceEndpoint(404));
  let res;
  try {
    res = await worker.fetch(
      new Request('https://i.test/auth/start?email=wiped%40test.example&agree=1'), env, { waitUntil() {} });
  } finally { restoreFetch(); }

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /dash\.cloudflare\.com\/oauth2\/auth/);
  assert.equal(await env.INSTALLER_KV.get('instance:acct-wiped'), null, '過期快照要清掉');
});

// arcrun-rag#289 第 4 則（leo 2026-11-21「為什麼跑完跑到這個畫面？」）：實例在但沒有管理員時，
// Portal 叫人回安裝頁、安裝頁又說「已裝好」＝兩頁繞圈。沒有管理員就不算已裝好。
function instanceWithAuth(configured) {
  const base = instanceEndpoint(200);
  return (url, init) => url.endsWith('/console/auth-status')
    ? { status: 200, json: { configured } }
    : base(url, init);
}
for (const [label, configured, wantCf] of [
  ['沒有管理員 ⇒ 不說「已經裝好」，直接進 Cloudflare 授權（裝完會跳建帳號視窗）', false, true],
  ['已有管理員 ⇒ 照舊「你已經裝好了」', true, false],
]) {
  test(`#289 實例在、${label}`, async () => {
    const env = { INSTALLER_KV: makeKV() };
    await env.INSTALLER_KV.put('sess:sa', JSON.stringify({
      access_token: 'at', refresh_token: 'rt', inviteEmail: 'noadmin@test.example' }));
    await adoptGrant(env, 'sa', 'acct-na', 'noadmin@test.example');
    await env.INSTALLER_KV.put('instance:acct-na', JSON.stringify({ result: { apiUrl: 'https://arcrun-cypher-executor.x.workers.dev' } }));
    installFetch(instanceWithAuth(configured));
    let res;
    try {
      res = await worker.fetch(
        new Request('https://i.test/auth/start?email=noadmin%40test.example&agree=1'), env, { waitUntil() {} });
    } finally { restoreFetch(); }
    if (wantCf) {
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /dash\.cloudflare\.com\/oauth2\/auth/);
      assert.ok(await env.INSTALLER_KV.get('instance:acct-na'), '實例還在，快照不該被清（更新要沿用資源）');
    } else {
      assert.equal(res.status, 200);
      assert.match(await res.text(), /你已經裝好了/);
    }
  });
}

// arcrun-rag#289 第 6 則（leo 2026-11-21）：「沒有管理員帳號就沒有略過按鈕，如果你關掉頁面下次回來還是這裡」。
// 同一個瀏覽器（帶著安裝時的 cookie）裝完、還沒建管理員 ⇒ 回首頁或再按一次安裝，都直接回建帳號那一步，不再授權 CF。
async function doneSessionEnv(sid) {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ access_token: 'at', refresh_token: 'rt', inviteEmail: 'back@test.example', inviteVerified: true }));
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify({ state: 'done', result: { apiUrl: 'https://arcrun-cypher-executor.y.workers.dev', accountId: 'acct-back' } }));
  await adoptGrant(env, sid, 'acct-back', 'back@test.example');
  return env;
}
for (const [label, path, configured, cookie, want] of [
  ['回首頁、沒有管理員 ⇒ 直接回建帳號', '/', false, true, 'install'],
  ['再按一次安裝、沒有管理員 ⇒ 直接回建帳號，不進 CF 授權', '/auth/start?email=back%40test.example&agree=1', false, true, 'install'],
  ['回首頁、已有管理員 ⇒ 照常首頁', '/', true, true, 'home'],
  ['沒帶 cookie（別的瀏覽器只知道 email）⇒ 照舊走 CF 授權', '/auth/start?email=back%40test.example&agree=1', false, false, 'cf'],
]) {
  test(`#289 回訪：${label}`, async () => {
    const env = await doneSessionEnv('sb');
    await env.INSTALLER_KV.put('instance:acct-back', JSON.stringify({ result: { apiUrl: 'https://arcrun-cypher-executor.y.workers.dev' } }));
    installFetch(instanceWithAuth(configured));
    let res;
    try {
      const headers = cookie ? { cookie: 'arcrun_sid=sb' } : {};
      res = await worker.fetch(new Request('https://i.test' + path, { headers }), env, { waitUntil() {} });
    } finally { restoreFetch(); }
    if (want === 'install') {
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://i.test/install');
    } else if (want === 'cf') {
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /dash\.cloudflare\.com\/oauth2\/auth/);
    } else {
      assert.equal(res.status, 200);
    }
  });
}

test('#289 回訪建帳號：session 的短期 token 過期、長期委任已移交 ⇒ 改用移交後的委任，帳號照樣建得起來', async () => {
  const env = await doneSessionEnv('sc');
  // adoptGrant 已把 refresh_token 從 session 拿走；再讓短期 token 過期
  const sess = JSON.parse(await env.INSTALLER_KV.get('sess:sc'));
  assert.equal(sess.refresh_token, undefined);
  await env.INSTALLER_KV.put('sess:sc', JSON.stringify({ ...sess, expires_at: Date.now() - 1000 }));
  const tok = tokenEndpoint();
  const calls = installFetch((url, init) => {
    if (url.endsWith('/console/setup')) return { status: 200, json: { session_token: 'st' } };
    if (url.endsWith('/portal/admin/bootstrap')) return { status: 200, json: { ok: true } };
    return tok(url, init);
  });
  let res, body;
  try {
    res = await worker.fetch(new Request('https://i.test/api/setup-account', {
      method: 'POST', headers: { cookie: 'arcrun_sid=sc', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.example', password: 'password123' }) }), env, { waitUntil() {} });
    body = await res.json();
  } finally { restoreFetch(); }
  assert.notEqual(res.status, 401, '不該叫人回首頁重新授權：' + JSON.stringify(body));
  assert.ok(calls.some((c) => c.url.endsWith('/console/setup')), '要真的打到實例的 setup');
});

for (const [label, live] of [['現在沒有管理員', false], ['現在已有管理員', true]]) {
  test(`#289 完成頁照「現在」決定能不能略過：${label}`, async () => {
    const env = await doneSessionEnv('sd');
    const prog = JSON.parse(await env.INSTALLER_KV.get('prog:sd'));
    prog.result.health = { auth_store: { console: { configured: !live } } };   // 快照跟現況相反
    await env.INSTALLER_KV.put('prog:sd', JSON.stringify(prog));
    installFetch(instanceWithAuth(live));
    let body;
    try {
      const res = await worker.fetch(new Request('https://i.test/api/install/status', { headers: { cookie: 'arcrun_sid=sd' } }), env, { waitUntil() {} });
      body = await res.json();
    } finally { restoreFetch(); }
    assert.equal(body.result.health.auth_store.console.configured, live);
    assert.equal(JSON.parse(await env.INSTALLER_KV.get('prog:sd')).result.health.auth_store.console.configured, !live, '只改回應，不落庫');
  });
}

test('#163 沒裝過的 email 仍然導去 Cloudflare 授權屏（第一次的人閘不准動）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(
    new Request('https://i.test/auth/start?email=stranger%40test.example&code=&agree=1'), env, { waitUntil() {} });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /dash\.cloudflare\.com\/oauth2\/auth/);
});

test('#163 已裝好的人明講要重裝（reinstall=1）⇒ 照樣走完整授權，不被攔', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('sess:s2', JSON.stringify({
    access_token: 'at', refresh_token: 'rt', inviteEmail: 'known2@test.example' }));
  await adoptGrant(env, 's2', 'acct-k2', 'known2@test.example');

  const res = await worker.fetch(
    new Request('https://i.test/auth/start?email=known2%40test.example&code=&agree=1&reinstall=1'), env, { waitUntil() {} });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /dash\.cloudflare\.com/);
});

test('#163 授權被撤銷後，索引變孤兒 ⇒ 安裝頁重新要求授權（撤銷真的會生效）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('sess:s3', JSON.stringify({
    access_token: 'at', refresh_token: 'rt', inviteEmail: 'gone@test.example' }));
  await adoptGrant(env, 's3', 'acct-gone', 'gone@test.example');
  assert.equal(await liveGrantForEmail(env, 'gone@test.example'), 'acct-gone');

  await dropGrant(env, 'acct-gone', 'user_revoked');

  assert.equal(await liveGrantForEmail(env, 'gone@test.example'), null);
  const res = await worker.fetch(
    new Request('https://i.test/auth/start?email=gone%40test.example&code=&agree=1'), env, { waitUntil() {} });
  assert.equal(res.status, 302, '撤銷後必須退回完整安裝流程');
  assert.match(res.headers.get('location'), /dash\.cloudflare\.com/);
  assert.equal(await env.INSTALLER_KV.get(await emailIndexKey('gone@test.example')), null,
    '孤兒索引要被回收，不留指向空氣的指標');
});

test('#163 索引存的是雜湊，KV 裡不該出現明文信箱', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await env.INSTALLER_KV.put('sess:s4', JSON.stringify({
    access_token: 'at', refresh_token: 'rt', inviteEmail: 'secret.person@test.example' }));
  await adoptGrant(env, 's4', 'acct-h', 'secret.person@test.example');
  const idxKeys = [...env.INSTALLER_KV.store.keys()].filter((k) => k.startsWith('grantmail:'));
  assert.equal(idxKeys.length, 1);
  assert.ok(!idxKeys[0].includes('secret.person'), '索引鍵不可以含明文信箱');
});

// ---------------------------------------------------------------------------
// #163 第三輪：Portal 按鈕打的那支端點（完全不繞 Cloudflare）
// ---------------------------------------------------------------------------

test('#163 Portal 更新端點：沒帶權杖 ⇒ 拒絕，而且錯誤訊息是人話（沒有狀態碼/token 這種詞）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://i.test/api/instance/update', {
    method: 'POST', body: JSON.stringify({ accountId: 'acct-x' }) }), env, { waitUntil() {} });
  assert.equal(res.status, 401);
  const b = await res.json();
  assert.equal(b.ok, false);
  for (const banned of ['token', 'Token', '401', 'unauthorized 錯誤', 'Bearer']) {
    assert.ok(!b.message.includes(banned), `使用者看的訊息不該出現「${banned}」`);
  }
});

test('#163 Portal 更新端點：拿別人的帳號 id ＋ 錯權杖 ⇒ 拒絕', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await ensureUpdateToken(env, 'acct-victim');
  const res = await worker.fetch(new Request('https://i.test/api/instance/update', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
    body: JSON.stringify({ accountId: 'acct-victim' }) }), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test('#163 Portal 更新端點：權杖對 ⇒ 真的去跑更新（這裡沒有快照，回人看得懂的說明）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const tok = await ensureUpdateToken(env, 'acct-ok');
  const res = await worker.fetch(new Request('https://i.test/api/instance/update', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tok },
    body: JSON.stringify({ accountId: 'acct-ok' }) }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.ok, false);
  assert.ok(b.message && b.message.length > 0);
  assert.ok(!/dash\.cloudflare\.com/.test(JSON.stringify(b)), '這條路不該把人導去 Cloudflare');
});

test('#163 Portal 更新端點：連按有冷卻期（一顆按鈕不該能被按成災）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const tok = await ensureUpdateToken(env, 'acct-cool');
  const mk = () => new Request('https://i.test/api/instance/update', {
    method: 'POST', headers: { authorization: 'Bearer ' + tok },
    body: JSON.stringify({ accountId: 'acct-cool' }) });
  await worker.fetch(mk(), env, { waitUntil() {} });
  const second = await worker.fetch(mk(), env, { waitUntil() {} });
  const b = await second.json();
  assert.equal(b.state, 'busy');
});

test('#163 更新權杖：同一個帳號永遠拿到同一把（換新的會與實例身上那把不同步）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const a = await ensureUpdateToken(env, 'acct-same');
  const b = await ensureUpdateToken(env, 'acct-same');
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('#163 定時比較：長度不同、內容不同都回 false，相同回 true', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('#163 存量授權會被補上索引——這張票對「早就裝好的人」才算真的修好', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/x@same' };
  // 模擬「索引這條路還不存在時」就已經存好的授權：只有 grant，沒有 grantmail
  await env.INSTALLER_KV.put('grant:acct-legacy', JSON.stringify({
    refresh_token: 'rt', accountId: 'acct-legacy', email: 'legacy@test.example' }));
  await env.INSTALLER_KV.put('instance:acct-legacy', JSON.stringify({
    result: {}, bundleBase: 'https://cdn.test/x@same' }));

  assert.equal(await liveGrantForEmail(env, 'legacy@test.example'), null, '補之前查不到');
  await sweepUpdates(env, 5);
  assert.equal(await liveGrantForEmail(env, 'legacy@test.example'), 'acct-legacy', '補之後查得到');

  const res = await worker.fetch(
    new Request('https://i.test/auth/start?email=legacy%40test.example&code=&agree=1'), env, { waitUntil() {} });
  assert.equal(res.status, 200, '補完索引後，老用戶也不該再被送去 Cloudflare');
});


// ---------------------------------------------------------------------------
// #163（Arcrun#184 第二條）：背景準備新版、按下才切換
// ---------------------------------------------------------------------------

test('#163 切換＝對 Cloudflare 打一個很小的 deployments 呼叫（100% 指到那個版本），不重傳程式', async () => {
  const calls = installFetch(() => ({ status: 200, json: { success: true, result: {} } }));
  try {
    await activatePreparedVersion('tok', 'acct-x', 'arcrun-cypher-executor', 'ver-123');
  } finally { restoreFetch(); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/accounts\/acct-x\/workers\/scripts\/arcrun-cypher-executor\/deployments$/);
  const b = JSON.parse(calls[0].body);
  assert.deepEqual(b, { strategy: 'percentage', versions: [{ percentage: 100, version_id: 'ver-123' }] });
});

test('#163 掃描預設只「準備」不「啟用」：已準備完整的帳號背景不再動它（等人按）', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@newpin' };
  await env.INSTALLER_KV.put('grant:acct-p', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-p' }));
  await env.INSTALLER_KV.put('instance:acct-p', JSON.stringify({ result: { accountId: 'acct-p' }, bundleBase: 'https://cdn.test/gh/x@oldpin' }));
  await writePrepared(env, 'acct-p', { bundleBase: 'https://cdn.test/gh/x@newpin', complete: true, preparedAt: 1, versions: { w: { id: 'v', sha: 's' } } });

  const calls = installFetch(tokenEndpoint());
  try {
    const results = await sweepUpdates(env, 5);
    assert.equal(results.length, 0, '準備好了就不再做事');
  } finally { restoreFetch(); }
  assert.equal(calls.length, 0, '連 token 都不該去換');
});

test('#163 準備版對不上現行釘子就不算數（readPrepared 給的是紀錄，是否可用由 bundleBase 比對決定）', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@pin2' };
  await writePrepared(env, 'acct-q', { bundleBase: 'https://cdn.test/gh/x@pin1', complete: true, versions: {} });
  await env.INSTALLER_KV.put('grant:acct-q', JSON.stringify({ refresh_token: 'rt', accountId: 'acct-q' }));
  await env.INSTALLER_KV.put('instance:acct-q', JSON.stringify({ result: {}, bundleBase: 'https://cdn.test/gh/x@pin0' }));
  installFetch((url) => url.includes('/oauth2/token') ? { status: 400, json: { error: 'invalid_grant' } } : { status: 404, json: {} });
  try {
    const results = await sweepUpdates(env, 5);
    assert.equal(results.length, 1, '舊釘子的準備版不算，要重新準備（這裡早退在換 token）');
  } finally { restoreFetch(); }
});

test('#163 /api/instance/update-status：沒權杖 401；有權杖回「準備好了嗎」', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@p' };
  const bad = await worker.fetch(new Request('https://i.test/api/instance/update-status', {
    method: 'POST', headers: { authorization: 'Bearer nope' }, body: JSON.stringify({ accountId: 'a1' }) }), env, { waitUntil() {} });
  assert.equal(bad.status, 401);

  await env.INSTALLER_KV.put('updtok:a1', 'good');
  await env.INSTALLER_KV.put('instance:a1', JSON.stringify({ result: {}, bundleBase: 'https://cdn.test/gh/x@old' }));
  await writePrepared(env, 'a1', { bundleBase: 'https://cdn.test/gh/x@p', complete: true, preparedAt: 42, versions: { w1: {}, w2: {} } });
  const ok = await worker.fetch(new Request('https://i.test/api/instance/update-status', {
    method: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ accountId: 'a1' }) }), env, { waitUntil() {} });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.prepared, true);
  assert.equal(j.preparedWorkers, 2);
  assert.equal(j.upToDate, false);
  assert.ok(!JSON.stringify(j).includes('good'), '不回權杖');
});

test('#163 更新不帶上一輪的接力游標：快照裡的 deployedNames 若原樣帶進來，deploy 迴圈會把全部當「已裝過」而一顆都不推', () => {
  // 實測抓到的真 bug（stage 1.4.261→1.4.262：更新回報完成，但 cypher 一顆都沒換）。
  // runInstall 的 deploy 迴圈對「deployedNames 裡有的」直接 continue；快照存的是上一輪的全部名單。
  // 這裡守住 runUpdate 在把快照填回 progress 之後，一定把這幾個游標欄位清掉。
  const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function runUpdate(');
  assert.ok(i > 0);
  const body = src.slice(i, i + 4000);
  assert.match(body, /for \(const k of \['deployedNames'/);
  assert.match(body, /delete progress\.result\[k\]/);
});

test('#163 舊版（1.0.89～1.0.90）備的版本沒有 v 印記 ⇒ 當作沒備過，cron 才會用有保留 secret 的新做法重備', async () => {
  const env = { INSTALLER_KV: makeKV(), BUNDLE_BASE: 'https://cdn.test/gh/x@pin1' };
  // 模擬舊碼寫的紀錄（沒有 v）
  await env.INSTALLER_KV.put('prepared:acct-old', JSON.stringify({ bundleBase: 'https://cdn.test/gh/x@pin1', complete: true, preparedAt: 1, versions: { w: { id: 'v' } } }));
  assert.equal(await readPrepared(env, 'acct-old'), null);
  await writePrepared(env, 'acct-new', { bundleBase: 'https://cdn.test/gh/x@pin1', complete: true, versions: {} });
  assert.equal((await readPrepared(env, 'acct-new')).v, 2);
});

// 金鑰護欄（stage 2026-11-21 實撞：切換把使用者的 Portal 帳號與憑證清掉）
const secretsGuardFetch = ({ liveSecrets, preparedSecrets, afterSecrets }) => {
  let switched = 0; const deployPosts = [];
  const verSecrets = { 'ver-live': liveSecrets, 'ver-new': preparedSecrets };
  const fn = (url, init) => {
    const method = (init && init.method || 'GET').toUpperCase();
    if (method === 'GET' && /\/deployments$/.test(url)) {
      const top = switched === 0 ? 'ver-live' : (deployPosts[deployPosts.length - 1].versions[0].version_id);
      return { status: 200, json: { success: true, result: { deployments: [{ versions: [{ version_id: top }] }] } } };
    }
    const m = url.match(/\/versions\/([^/]+)$/);
    if (method === 'GET' && m) {
      const id = m[1];
      const names = (id === 'ver-new' && switched > 0 && afterSecrets) ? afterSecrets : verSecrets[id];
      return { status: 200, json: { success: true, result: { resources: { bindings: [{ type: 'plain_text', name: 'X', text: '1' }, ...names.map((n) => ({ type: 'secret_text', name: n }))] } } } };
    }
    if (method === 'POST' && /\/deployments$/.test(url)) { deployPosts.push(JSON.parse(init.body)); switched++; return { status: 200, json: { success: true, result: {} } }; }
    return { status: 404, json: { success: false } };
  };
  return { fn, deployPosts };
};

test('金鑰護欄：備好的新版少了金鑰 ⇒ 不切換、不打任何 deployments（改走直接部署）', async () => {
  const { fn, deployPosts } = secretsGuardFetch({ liveSecrets: ['ARCRUN_AUTH_STORE', 'CRED_A'], preparedSecrets: [] });
  installFetch(fn);
  let r; try { r = await switchWithSecretGuard('tok', 'acct', 'arcrun-cypher-executor', 'ver-new'); } finally { restoreFetch(); }
  assert.equal(r.switched, false);
  assert.match(r.reason, /少了 2 把金鑰（ARCRUN_AUTH_STORE、CRED_A）/);
  assert.equal(deployPosts.length, 0, '沒確認安全就一次都不准切');
});

test('金鑰護欄：名單涵蓋 ⇒ 切換並讀回確認', async () => {
  const { fn, deployPosts } = secretsGuardFetch({ liveSecrets: ['A'], preparedSecrets: ['A', 'B'] });
  installFetch(fn);
  let r; try { r = await switchWithSecretGuard('tok', 'acct', 'w', 'ver-new'); } finally { restoreFetch(); }
  assert.equal(r.switched, true); assert.equal(deployPosts.length, 1);
});

test('金鑰護欄：切過去之後才發現少了（備好時看起來有、實際啟用後沒了）⇒ 立刻切回原本那一版', async () => {
  const { fn, deployPosts } = secretsGuardFetch({ liveSecrets: ['A'], preparedSecrets: ['A'], afterSecrets: [] });
  installFetch(fn);
  let r; try { r = await switchWithSecretGuard('tok', 'acct', 'w', 'ver-new'); } finally { restoreFetch(); }
  assert.equal(r.switched, false); assert.match(r.reason, /已自動切回/);
  assert.equal(deployPosts.length, 2);
  assert.equal(deployPosts[1].versions[0].version_id, 'ver-live', '第二次要切回原本那一版');
});

test('金鑰護欄：讀不到金鑰名單 ⇒ 當作不能確認，不切', async () => {
  installFetch(() => ({ status: 500, json: { success: false, errors: [{ message: 'boom' }] } }));
  let r; try { r = await switchWithSecretGuard('tok', 'acct', 'w', 'ver-new'); } finally { restoreFetch(); }
  assert.equal(r.switched, false);
});

// 準備鏈護欄（#377）：最新版已被污染（不是現役、沒帶金鑰）時，不再疊一版
const chainFetch = ({ liveId, latestId, secrets }) => (url, init) => {
  const method = (init && init.method || 'GET').toUpperCase();
  if (method !== 'GET') return { status: 500, json: { success: false } };
  if (/\/deployments$/.test(url)) return { status: 200, json: { success: true, result: { deployments: [{ versions: [{ version_id: liveId }] }] } } };
  if (/\/versions$/.test(url)) return { status: 200, json: { success: true, result: { items: [{ id: liveId, number: 108 }, { id: latestId, number: 112 }] } } };
  const m = url.match(/\/versions\/([^/]+)$/);
  if (m) return { status: 200, json: { success: true, result: { resources: { bindings: (secrets[m[1]] || []).map((n) => ({ type: 'secret_text', name: n })) } } } };
  return { status: 404, json: { success: false } };
};

test('準備鏈護欄：最新版＝現役版 ⇒ 可以準備', async () => {
  installFetch(chainFetch({ liveId: 'v-live', latestId: 'v-live', secrets: { 'v-live': ['A'] } }));
  let r; try { r = await prepareChainGuard('tok', 'acct', 'w'); } finally { restoreFetch(); }
  assert.equal(r.ok, true);
});

test('準備鏈護欄：最新版是沒帶金鑰的準備版（已污染）⇒ 略過，不疊版', async () => {
  installFetch(chainFetch({ liveId: 'v-live', latestId: 'v-bad', secrets: { 'v-live': ['A', 'B'], 'v-bad': [] } }));
  let r; try { r = await prepareChainGuard('tok', 'acct', 'w'); } finally { restoreFetch(); }
  assert.equal(r.ok, false); assert.match(r.reason, /少了 2 把金鑰（A、B）/);
});

test('準備鏈護欄：最新版不是現役、但金鑰名單涵蓋現役 ⇒ 鏈沒斷，可以準備', async () => {
  installFetch(chainFetch({ liveId: 'v-live', latestId: 'v-prep', secrets: { 'v-live': ['A'], 'v-prep': ['A', 'B'] } }));
  let r; try { r = await prepareChainGuard('tok', 'acct', 'w'); } finally { restoreFetch(); }
  assert.equal(r.ok, true);
});

test('準備鏈護欄：讀不到名單 ⇒ 不能確認，略過', async () => {
  installFetch(() => ({ status: 500, json: { success: false, errors: [{ message: 'boom' }] } }));
  let r; try { r = await prepareChainGuard('tok', 'acct', 'w'); } finally { restoreFetch(); }
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// inkstone/arcrun-rag#384：更新分批時，安裝器自己串下一批（不靠畫面、不靠 cron）
// ---------------------------------------------------------------------------

test('#384 一批做完還有下一批 ⇒ 自己交棒給下一棒，直到做完；紀錄收乾淨', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await ensureUpdateToken(env, 'acct-chain');
  const answers = [{ ok: false, state: 'paused_continue' }, { ok: false, state: 'paused_continue' }, { ok: true, state: 'done', deployed: 3 }];
  const sent = [];
  const run = async () => answers.shift();
  // 假的「對自己打」：把下一棒直接交給 runUpdateChainBatch（等於真的 worker 收到 202 後在背景跑）
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    sent.push(b.chain);
    assert.match(init.headers.authorization, /^Bearer .{64}$/);
    await runUpdateChainBatch(env, 'acct-chain', b.chain, { run, fetchImpl, origin: 'https://i.test' });
    return { status: 202 };
  };
  await env.INSTALLER_KV.put('updchain:acct-chain', JSON.stringify({ n: 0, at: Date.now(), startedAt: Date.now() }));
  const r = await kickUpdateChain(env, 'acct-chain', 1, 'https://i.test', fetchImpl);
  assert.equal(r, true);
  assert.deepEqual(sent, [1, 2, 3], '第 1 批（按下時）之後交出第 1、2、3 棒；第 3 棒做完就不再交');
  assert.equal(answers.length, 0);
  assert.equal(await readUpdateChain(env, 'acct-chain'), null, '做完要清掉接力紀錄');
});

test('#384 序號對不上的接力請求不會跑（重複／偽造的接力不能讓更新多開）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const tok = await ensureUpdateToken(env, 'acct-forge');
  const mk = (chain) => new Request('https://i.test/api/instance/update', {
    method: 'POST', headers: { authorization: 'Bearer ' + tok },
    body: JSON.stringify({ accountId: 'acct-forge', chain }) });
  const r1 = await worker.fetch(mk(1), env, { waitUntil() {} });
  assert.equal((await r1.json()).reason, 'chain_stale', '沒有接力紀錄 ⇒ 不跑');
  await env.INSTALLER_KV.put('updchain:acct-forge', JSON.stringify({ n: 5, at: Date.now() }));
  const r2 = await worker.fetch(mk(1), env, { waitUntil() {} });
  assert.equal((await r2.json()).reason, 'chain_stale', '序號不是「上一棒+1」 ⇒ 不跑');
});

test('#384 背景正在接力時再按，不會再開一串，也不叫人再按', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const tok = await ensureUpdateToken(env, 'acct-live');
  await env.INSTALLER_KV.put('updchain:acct-live', JSON.stringify({ n: 2, at: Date.now() }));
  const res = await worker.fetch(new Request('https://i.test/api/instance/update', {
    method: 'POST', headers: { authorization: 'Bearer ' + tok },
    body: JSON.stringify({ accountId: 'acct-live' }) }), env, { waitUntil() {} });
  const b = await res.json();
  assert.equal(b.state, 'busy');
  assert.equal(b.reason, 'background');
  assert.ok(!/請再按|再按一次/.test(b.message), '文案不能叫人再按');
  assert.match(b.message, /背景/);
});

test('#384 接力有上限：超過棒數就停手並留紀錄，不會變成永遠走不完', async () => {
  const env = { INSTALLER_KV: makeKV() };
  await ensureUpdateToken(env, 'acct-cap');
  const r = await runUpdateChainBatch(env, 'acct-cap', 30, {
    run: async () => ({ ok: false, state: 'paused_continue' }), origin: 'https://i.test',
    fetchImpl: async () => { throw new Error('不該再交棒'); } });
  assert.equal(r.reason, 'chain_limit');
  assert.equal(await readUpdateChain(env, 'acct-cap'), null);
});

test('#384 第一批放進 waitUntil：回應先回 202（沒等到做完），工作仍在背景做完並交棒', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const tok = await ensureUpdateToken(env, 'acct-first');
  const pending = [];
  // 只確認結構：第一批 promise 必須交給 ctx.waitUntil（client 斷線不能取消它）
  const res = await worker.fetch(new Request('https://i.test/api/instance/update', {
    method: 'POST', headers: { authorization: 'Bearer ' + tok },
    body: JSON.stringify({ accountId: 'acct-first' }) }), env, { waitUntil(p) { pending.push(p); } });
  assert.ok(pending.length >= 1, '第一批沒有交給 waitUntil ＝ client 斷線就取消');
  await Promise.all(pending);
  assert.ok(res.status < 600);
});
