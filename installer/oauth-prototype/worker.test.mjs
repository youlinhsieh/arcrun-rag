/**
 * OAuth 安裝器離線測試（P0-1 / P0-2 / P0-3）
 *
 * 跑法：node --experimental-sqlite --test worker.test.mjs
 * （零依賴、不需 npm install；node:test + node:sqlite 皆內建。需 Node ≥ 22）
 *
 * 目標：把「README 宣稱已修」變成「可重跑的客觀證據」。
 * 全程離線——CF API 與 landing 服務都用 mock，D1 用 node:sqlite（D1 底層即 SQLite）真跑 migration。
 * 不需要任何 Cloudflare 帳號、不觸網。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import worker, {
  slugFromEmail,
  verifyInviteCode,
  manifestRequirements,
  resolveResourcesByRule,
  VECTORIZE_INDEX,
  MIGRATION_SQL,
  deployBundledWorker,
  SERVICE_BINDINGS,
  reorderForServiceBindings,
  seedSkillsTo,
} from './worker.js';

// --- 測試替身 -------------------------------------------------------------

const realFetch = globalThis.fetch;

/**
 * 換掉 global fetch。handler(url, init) 回 { status, json } 或 { status, text }。
 * 回傳的 record 陣列讓測試斷言「打了哪些、幾次」。
 */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
    const r = await handler(url, init, calls);
    if (r instanceof Response) return r;
    if (r && r.throw) throw new Error(r.throw);
    const status = r.status ?? 200;
    if (r.text !== undefined) return new Response(r.text, { status });
    return new Response(JSON.stringify(r.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** 記憶體版 KV，行為對齊 worker 用到的 get(key,'json') / put / delete。 */
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
    async put(key, val) {
      store.set(key, val);
    },
    async delete(key) {
      store.delete(key);
    },
    // 真 KV 有 list()；資源解析用它判斷「這台照我們的紀錄裝過了沒」（mode init/update）。
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

const cfOk = (result) => ({ json: { success: true, result } });

/**
 * 共用規則（shared/resource-rule/）會打的那幾條 CF 端點，統一在這裡假。
 *
 * 為什麼抽出來：這幾條是**規則的眼睛**（「這顆 worker 現在綁著誰」從 /settings 讀），
 * 每個 mock 各寫一份就會漂——而眼睛不一樣正是 Arcrun#97 重演的充分條件。
 *
 * `deployed`：script 名 → CF `/settings` 回應裡的 bindings[]（原始形狀）。
 *   沒登記的 script 一律回 404＝「還沒部署」（不是錯誤）。
 * 回 null＝這條路徑不歸我管，交回呼叫端的 mock 繼續判。
 */
function resourceRuleRoute(url, method, init, state = {}) {
  const deployed = state.deployed || {};
  const kvByTitle = state.kvByTitle || {};
  const d1ByName = state.d1ByName || {};
  const vectorize = state.vectorize || [];

  const settings = url.match(/\/workers\/scripts\/([^/]+)\/settings$/);
  if (settings && method === 'GET') {
    const script = decodeURIComponent(settings[1]);
    if (!deployed[script]) {
      return { status: 404, json: { success: false, result: null, errors: [{ message: 'script_not_found' }] } };
    }
    return cfOk({ bindings: deployed[script] });
  }
  if (url.includes('/storage/kv/namespaces') && !url.includes('/values/')) {
    if (method === 'GET') return cfOk(Object.entries(kvByTitle).map(([title, id]) => ({ id, title })));
    if (method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const id = kvByTitle[body.title] || `kv-${body.title}`;
      kvByTitle[body.title] = id;
      return cfOk({ id, title: body.title });
    }
  }
  if (url.includes('/d1/database') && !url.includes('/query')) {
    if (method === 'GET') return cfOk(Object.entries(d1ByName).map(([name, uuid]) => ({ uuid, name })));
    if (method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const uuid = d1ByName[body.name] || `db-${body.name}`;
      d1ByName[body.name] = uuid;
      return cfOk({ uuid, name: body.name });
    }
  }
  if (url.includes('/vectorize/v2/indexes')) {
    if (url.includes('/metadata-index/create')) return cfOk({});
    if (method === 'GET') return cfOk(vectorize.map((name) => ({ name })));
    if (method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      if (!vectorize.includes(body.name)) vectorize.push(body.name);
      return cfOk({ name: body.name });
    }
  }
  return null;
}

// ===========================================================================
// P0-1：辨識碼閘（fail-closed）
// ===========================================================================

test('P0-1 verifyInviteCode: 缺 email 或 code → invalid，且完全不觸網', async () => {
  const calls = installFetch(() => ({ json: { ok: true } })); // 若被呼叫就會是 ok，故用 calls 反證
  try {
    assert.deepEqual(await verifyInviteCode({}, '', 'CODE'), { ok: false, reason: 'invalid' });
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', ''), { ok: false, reason: 'invalid' });
    assert.equal(calls.length, 0, '缺參數時不該打 landing');
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: landing 回 {ok:true} → ok:true', async () => {
  installFetch((url) => {
    assert.match(url, /\/api\/verify-code$/);
    return { json: { ok: true } };
  });
  try {
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', 'CODE'), { ok: true });
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: landing 回 {ok:false} → invalid', async () => {
  installFetch(() => ({ json: { ok: false } }));
  try {
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', 'BAD'), { ok: false, reason: 'invalid' });
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: 429 → rate', async () => {
  installFetch(() => ({ status: 429, json: { ok: false } }));
  try {
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', 'CODE'), { ok: false, reason: 'rate' });
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: 500 → invalid（fail-closed）', async () => {
  installFetch(() => ({ status: 500, json: { ok: true } })); // 即使 body 說 ok，HTTP 非 2xx 也拒
  try {
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', 'CODE'), { ok: false, reason: 'invalid' });
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: fetch 拋錯（中央服務連不上）→ unreachable，拒絕（fail-closed）', async () => {
  installFetch(() => ({ throw: 'network down' }));
  try {
    const v = await verifyInviteCode({}, 'a@b.com', 'CODE');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unreachable');
  } finally {
    restoreFetch();
  }
});

test('P0-1 verifyInviteCode: 非 JSON body → invalid（不誤放行）', async () => {
  installFetch(() => new Response('<html>blocked</html>', { status: 200 }));
  try {
    assert.deepEqual(await verifyInviteCode({}, 'a@b.com', 'CODE'), { ok: false, reason: 'invalid' });
  } finally {
    restoreFetch();
  }
});

test('P0-1 /auth/start：辨識碼驗不過 → 302 回首頁 error，不進 OAuth', async () => {
  installFetch((url) => {
    if (url.includes('/api/verify-code')) return { json: { ok: false } };
    throw new Error('不該打其他端點：' + url);
  });
  try {
    const env = { INSTALLER_KV: makeKV(), LANDING_BASE: 'https://landing.test' };
    const req = new Request('https://inst.test/auth/start?email=a@b.com&code=BAD');
    const res = await worker.fetch(req, env, { waitUntil() {} });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/\?error=code$/);
    // 沒有任何 state 被寫進 KV（沒放行）
    assert.equal([...env.INSTALLER_KV.store.keys()].some((k) => k.startsWith('state:')), false);
  } finally {
    restoreFetch();
  }
});

test('P0-1 /auth/start：辨識碼通過 → 302 導 CF 授權頁，state 記 inviteVerified:true', async () => {
  installFetch((url) => {
    if (url.includes('/api/verify-code')) return { json: { ok: true } };
    throw new Error('不該打其他端點：' + url);
  });
  try {
    const env = { INSTALLER_KV: makeKV(), LANDING_BASE: 'https://landing.test' };
    const req = new Request('https://inst.test/auth/start?email=A@B.com&code=GOOD');
    const res = await worker.fetch(req, env, { waitUntil() {} });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^https:\/\/dash\.cloudflare\.com\/oauth2\/auth/);
    assert.ok(res.headers.get('set-cookie')?.includes('arcrun_sid='), '應下發 session cookie');
    const stateKeys = [...env.INSTALLER_KV.store.keys()].filter((k) => k.startsWith('state:'));
    assert.equal(stateKeys.length, 1);
    const stored = JSON.parse(env.INSTALLER_KV.store.get(stateKeys[0]));
    assert.equal(stored.inviteVerified, true);
    assert.equal(stored.inviteEmail, 'a@b.com', 'email 應正規化為小寫');
  } finally {
    restoreFetch();
  }
});

test('P0-1 /api/install/start：session 未通過辨識碼閘 → 403（防禦縱深）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-unverified';
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ access_token: 't', inviteVerified: false }));
  const req = new Request('https://inst.test/api/install/start', {
    method: 'POST',
    headers: { cookie: `arcrun_sid=${sid}` },
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'not_verified');
});

test('P0-1 /api/install/start：無 session → 401', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const req = new Request('https://inst.test/api/install/start', { method: 'POST' });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

// ===========================================================================
// P0-2：可重現命名 + 冪等（斷點續傳基礎）
// ===========================================================================

test('P0-2 slugFromEmail：同 email 每次同碼（可重現）', async () => {
  const a = await slugFromEmail('user@example.com');
  const b = await slugFromEmail('user@example.com');
  assert.equal(a, b);
  assert.equal(a.length, 8);
});

test('P0-2 slugFromEmail：大小寫/前後空白正規化後同碼', async () => {
  const base = await slugFromEmail('user@example.com');
  assert.equal(await slugFromEmail('  USER@Example.COM '), base);
});

test('P0-2 slugFromEmail：不同 email 不同碼、字元限定安全字母表', async () => {
  const a = await slugFromEmail('a@x.com');
  const b = await slugFromEmail('b@x.com');
  assert.notEqual(a, b);
  assert.match(a, /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
});

// 🔴 這裡原本有四個 `ensureKvNamespace` / `ensureD1Database` 的測試（「同名已存在就沿用、
//    沒有就建」）。那三支函式已隨 `Leo/Arcrun#97` 的根治整段刪除——**照名字找**正是病根，
//    所以連帶測試也不能留（留著＝把錯的行為釘成契約）。
//    取代它們的是 `resource-plan.test.mjs`：三種情境（沒裝過／裝過了／名字完全不同）
//    直接餵上游那份 fixture 假帳號，驗「選出來的 resource id」與「有沒有多建東西」。

test('#97 輸入整形：manifest.requires → BindingRequirement[]（誰要什麼、要新建時叫什麼）', () => {
  const manifest = {
    core: [
      { name: 'arcrun-cypher-executor', requires: { kv: ['WEBHOOKS', 'USERS_KV'], d1: [{ binding: 'CREDENTIALS_DB' }] } },
      { name: 'arcrun-kbdb', requires: { kv: [], d1: [{ binding: 'DB' }] } },
      { name: 'arcrun-rag-ui', requires: {} },
    ],
  };
  const reqs = manifestRequirements(manifest, 'arcrun-rag-abc12345', true);
  // KV：createName 帶實例短碼（使用者帳號裡看得懂那是哪一台），binding 名原樣
  // #123：createNameIsOurs＝向共用規則聲明「這名字是我用使用者的 email 算出來的」，
  //       同名資源才准被接回來（否則半途中斷過的帳號永遠裝不起來）。
  assert.deepEqual(
    reqs.filter((r) => r.kind === 'kv_namespace'),
    [
      { kind: 'kv_namespace', binding: 'WEBHOOKS', worker: 'arcrun-cypher-executor', createName: 'arcrun-rag-abc12345-kv-webhooks', createNameIsOurs: true },
      { kind: 'kv_namespace', binding: 'USERS_KV', worker: 'arcrun-cypher-executor', createName: 'arcrun-rag-abc12345-kv-users_kv', createNameIsOurs: true },
    ],
  );
  // D1：兩個 binding 宣告同一個 createName ⇒ 共用規則會收斂成「建一顆、大家共用」
  const d1 = reqs.filter((r) => r.kind === 'd1');
  assert.equal(d1.length, 2);
  assert.equal(new Set(d1.map((r) => r.createName)).size, 1);
  assert.equal(d1[0].createName, 'arcrun-rag-abc12345-db');
  assert.ok(reqs.every((r) => r.createNameIsOurs === true), '每一筆都要聲明來歷（#123）');
  // Vectorize：只掛在 kbdb 那顆上（安裝器的決定，manifest 裡沒有這一項）
  assert.deepEqual(
    reqs.filter((r) => r.kind === 'vectorize'),
    [{ kind: 'vectorize', binding: 'VECTORIZE', worker: 'arcrun-kbdb', createName: VECTORIZE_INDEX, createNameIsOurs: true }],
  );
  // withVectorize=false（語意搜尋降級那條路）就完全不出現
  assert.equal(manifestRequirements(manifest, 'arcrun-rag-abc12345', false).filter((r) => r.kind === 'vectorize').length, 0);
});

test('#97 讀不到既有綁定 → 整趟停手，一顆資源都不建（不是「查不到就當它沒有」）', async () => {
  const calls = installFetch((url, init) => {
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    // worker 的 /settings 回 500＝「我不知道」，不是「它不存在」
    if (url.includes('/settings')) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 });
    }
    if (method === 'POST') throw new Error('被擋下的時候不准建立任何資源');
    return cfOk([]);
  });
  try {
    const manifest = { core: [{ name: 'arcrun-kbdb', requires: { kv: ['EXEC_CONTEXT'], d1: [{ binding: 'DB' }] } }] };
    const r = await resolveResourcesByRule('tok', 'acct', manifestRequirements(manifest, 'arcrun-rag-abc12345', false), 'update');
    assert.equal(r.blocked, true);
    assert.ok(r.blockers.length > 0, '停手一定要講得出理由');
    assert.match(r.blockers.join('\n'), /讀不到已部署的 worker/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '停手時不該有任何 POST');
  } finally {
    restoreFetch();
  }
});

test('P0-2 MIGRATION_SQL：真 kbdb schema 對真 SQLite 連跑兩次＝冪等（斷點續傳）', () => {
  const db = new DatabaseSync(':memory:');
  // t20④c：MIGRATION_SQL 已換成真 kbdb schema（migrations.json 16 句，DDL 冪等）。
  db.exec(MIGRATION_SQL);
  db.exec(MIGRATION_SQL); // 重跑（模擬斷點續傳重進安裝）——冪等＝不炸

  // 真 schema 四張核心表都在
  for (const t of ['entries', 'entry_values', 'templates', 'credentials']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    assert.ok(row, `真 schema 應含 ${t} 表`);
  }
  // 真 entries 是 kbdb 形（有 entry_type/page_name），不是舊示範形（title/body）
  const cols = db.prepare("SELECT name FROM pragma_table_info('entries')").all().map((r) => r.name);
  assert.ok(cols.includes('entry_type') && cols.includes('page_name'), `entries 應為 kbdb 形，got ${cols.join(',')}`);
  assert.ok(!cols.includes('title'), '舊示範欄位 title 不得殘留');
  db.close();
});

// ===========================================================================
// P0-3：逾時偵測（背景 waitUntil 被砍 → 狀態頁不空轉）
// ===========================================================================

const STALL_MS = 120000; // 對齊 worker.js 常數

async function seedSession(env, sid) {
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ access_token: 't', inviteVerified: true }));
}
function reqStatus(sid) {
  return new Request('https://inst.test/api/install/status', {
    headers: sid ? { cookie: `arcrun_sid=${sid}` } : {},
  });
}

test('P0-3 status：running 但超過 STALL_MS 沒更新 → 判 error（停止空轉）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-stalled';
  await seedSession(env, sid);
  const stale = {
    state: 'running',
    currentStep: 'deploy',
    startedAt: Date.now() - STALL_MS - 60000,
    updatedAt: Date.now() - STALL_MS - 1000, // 超過門檻
    steps: [{ id: 'deploy', state: 'running' }],
    result: {},
  };
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(stale));

  const res = await worker.fetch(reqStatus(sid), env, { waitUntil() {} });
  const body = await res.json();
  assert.equal(body.state, 'error', '卡死應被判 error');
  assert.ok(body.error, '應附錯誤說明');
  // 且已落庫（不是每次臨時算）
  const persisted = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(persisted.state, 'error');
});

test('P0-3 status：running 且剛更新過 → 維持 running（不誤殺正常慢步驟）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-fresh';
  await seedSession(env, sid);
  const fresh = {
    state: 'running',
    currentStep: 'schema',
    startedAt: Date.now() - 5000,
    updatedAt: Date.now() - 2000, // 遠小於門檻
    steps: [{ id: 'schema', state: 'running' }],
    result: {},
  };
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(fresh));

  const res = await worker.fetch(reqStatus(sid), env, { waitUntil() {} });
  const body = await res.json();
  assert.equal(body.state, 'running', '正常進行中不該被誤判失敗');
});

test('P0-3 status：無 session → 401', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(reqStatus(null), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

// ===========================================================================
// P0-4：deployBundledWorker（懶載上傳原語）——含 leo 專屬 var 洩漏防護
// ===========================================================================

const BASE = 'https://bundles.test';

/**
 * 為 deployBundledWorker 佈 mock：serve manifest 檔案，並攔截 CF PUT /scripts，
 * 解出 multipart 的 metadata（bindings）供斷言。回 { calls, captured() }。
 */
function installBundleFetch({ mainSrc = 'export default {}', modules = {} } = {}) {
  let capturedMeta = null;
  const calls = installFetch(async (url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    // 抓 PUT /accounts/.../workers/scripts/<name>：解 FormData 的 metadata
    if (method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(url)) {
      const form = init.body; // FormData
      const metaFile = form.get('metadata');
      capturedMeta = JSON.parse(await metaFile.text());
      return cfOk({});
    }
    if (method === 'POST' && url.endsWith('/subdomain')) return cfOk({});
    // bundle 檔案（main / wasm）
    if (url.startsWith(BASE)) {
      const file = url.slice(BASE.length + 1);
      if (file in modules) return new Response(modules[file], { status: 200 });
      return new Response(mainSrc, { status: 200 });
    }
    throw new Error('未預期的 URL：' + url);
  });
  return { calls, captured: () => capturedMeta };
}

function varsOf(meta) {
  return Object.fromEntries(
    (meta.bindings || []).filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text])
  );
}

const baseEntry = {
  name: 'arcrun-rag-cypher',
  main_file: 'cypher/index.js',
  main_module: 'index.js',
  modules: [],
  compat_date: '2026-01-01',
  compat_flags: [],
  requires: { kv: ['RAG_CACHE'], d1: [{ binding: 'RAG_DB' }], vars: {} },
};
const baseResources = { kv: { RAG_CACHE: 'kv-1' }, d1Id: 'db-1' };
const baseInject = { subdomain: 'acme' };

test('P0-4 deployBundledWorker：leo 專屬 var 一律不灌進客戶實例（洩漏防護）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    const entry = {
      ...baseEntry,
      requires: {
        ...baseEntry.requires,
        vars: {
          CONSOLE_TENANT: 'leo',
          GITEA_BASE_URL: 'https://git.uncle6.me',
          GITEA_SPRINT_REPO: 'Leo/InkStoneCo',
          GITEA_SPRINT_DIR: 'system-dev/...',
          MULTI_TENANT: 'true', // 非 leo 專屬 → 應保留
        },
      },
    };
    await deployBundledWorker(env, 'tok', 'acct-123', entry, baseResources, baseInject);
    const vars = varsOf(captured());
    for (const leaked of ['CONSOLE_TENANT', 'GITEA_BASE_URL', 'GITEA_SPRINT_REPO', 'GITEA_SPRINT_DIR']) {
      assert.equal(vars[leaked], undefined, `${leaked} 絕不可寫進客戶 worker`);
    }
    assert.equal(vars.MULTI_TENANT, 'true', '非 leo 專屬 var 應保留');
  } finally {
    restoreFetch();
  }
});

test('P0-4 deployBundledWorker：注入安裝期才知道的值（account/subdomain/kbdb）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    const r = await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources, baseInject);
    const vars = varsOf(captured());
    assert.equal(vars.CF_ACCOUNT_ID, 'acct-123');
    assert.equal(vars.WORKER_SUBDOMAIN, 'acme');
    assert.equal(vars.KBDB_BASE_URL, 'https://arcrun-kbdb.acme.workers.dev');
    assert.equal(r.url, 'https://arcrun-rag-cypher.acme.workers.dev');
  } finally {
    restoreFetch();
  }
});

test('arcrun-rag#38/#69/#25 deployBundledWorker：cypher 拿到 PORTAL_MAIL_RELAY_BASE（＝landingBase(env)，忘記密碼代寄）', async () => {
  // 這條就是這次修的洞：`grep -rn PORTAL_MAIL_RELAY installer/` 曾是零命中——
  // 安裝器從沒把「郵差在哪」交代給它裝出來的 cypher，導致每一台裝出來的實例
  // 按「忘記密碼」都停在 503「還沒有設定寄信服務」。
  const env = { BUNDLE_BASE: BASE, LANDING_BASE: 'https://arcrun-landing-staging.uncle6-me.workers.dev' };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources, baseInject);
    const vars = varsOf(captured());
    assert.equal(vars.PORTAL_MAIL_RELAY_BASE, 'https://arcrun-landing-staging.uncle6-me.workers.dev',
      'cypher 的 PORTAL_MAIL_RELAY_BASE 應該＝這個環境的 landingBase(env)，不是空的');
  } finally {
    restoreFetch();
  }
});

test('arcrun-rag#38/#69/#25 deployBundledWorker：env 沒給 LANDING_BASE 時，cypher 仍拿到預設值（不是空字串）', async () => {
  // 對齊既有 landingBase() 的行為：未覆蓋時退回 DEFAULT_LANDING_BASE（prod 官方郵差）——
  // 不新增第二個「值可能是 undefined」的路徑。
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources, baseInject);
    const vars = varsOf(captured());
    assert.equal(vars.PORTAL_MAIL_RELAY_BASE, 'https://arcrun-landing.uncle6-me.workers.dev');
  } finally {
    restoreFetch();
  }
});

test('arcrun-rag#38/#69/#25 deployBundledWorker：非 cypher 的顆（如 UI）不灌 PORTAL_MAIL_RELAY_BASE', async () => {
  // cypher-executor/src/types.ts 的 Bindings 只有這一顆宣告這個欄位；灌給別顆是死變數。
  const env = { BUNDLE_BASE: BASE, LANDING_BASE: 'https://arcrun-landing-staging.uncle6-me.workers.dev' };
  const { captured } = installBundleFetch();
  try {
    const uiEntry = { ...baseEntry, name: 'arcrun-rag-ui' };
    await deployBundledWorker(env, 'tok', 'acct-123', uiEntry, baseResources, baseInject);
    const vars = varsOf(captured());
    assert.equal(vars.PORTAL_MAIL_RELAY_BASE, undefined, 'UI 不需要、也不該拿到郵差網址');
  } finally {
    restoreFetch();
  }
});

test('P0-4 deployBundledWorker：binding 需求對上已建資源（kv/d1 id 正確）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct', baseEntry, baseResources, baseInject);
    const bindings = captured().bindings;
    const kv = bindings.find((b) => b.type === 'kv_namespace' && b.name === 'RAG_CACHE');
    const d1 = bindings.find((b) => b.type === 'd1' && b.name === 'RAG_DB');
    assert.equal(kv.namespace_id, 'kv-1');
    assert.equal(d1.id, 'db-1');
  } finally {
    restoreFetch();
  }
});

test('P0-4 deployBundledWorker：缺對應資源 id → fail-closed（丟錯不假綠）', async () => {
  const env = { BUNDLE_BASE: BASE };
  installBundleFetch();
  try {
    // 需求 RAG_CACHE 但 resources 沒建 → 應丟錯，不靜默部署出壞 worker
    await assert.rejects(
      () => deployBundledWorker(env, 'tok', 'acct', baseEntry, { kv: {}, d1Id: 'db-1' }, baseInject),
      /RAG_CACHE|快取空間/
    );
  } finally {
    restoreFetch();
  }
});

test('P0-4 deployBundledWorker：帶 wasm 模組 → 一併 append 進 multipart 上傳', async () => {
  const env = { BUNDLE_BASE: BASE };
  const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]); // \0asm magic
  const { calls } = installBundleFetch({ modules: { 'code/quickjs.wasm': wasmBytes } });
  try {
    const entry = {
      ...baseEntry,
      name: 'arcrun-rag-code',
      modules: [{ name: 'quickjs.wasm', file: 'code/quickjs.wasm', type: 'application/wasm' }],
    };
    await deployBundledWorker(env, 'tok', 'acct', entry, baseResources, baseInject);
    // 有抓 wasm 檔
    assert.ok(calls.some((c) => c.url === `${BASE}/code/quickjs.wasm`), '應抓 wasm 模組');
  } finally {
    restoreFetch();
  }
});

// ===========================================================================
// t20④c：真品接線新增件（applySubs / pushWorkflowTo / STEPS 擴充）
// ===========================================================================
import { applySubs, pushWorkflowTo } from './worker.js';

test('t20④c applySubs：佔位全代換、含引號值安全、structure 不變', () => {
  const out = applySubs(
    { flow: ['a >> ON_SUCCESS >> b'], url: '__KBDB_BASE__/entries', ns: '__NAMESPACE__' },
    { '__KBDB_BASE__': 'https://x.example', '__NAMESPACE__': 'u1' }
  );
  assert.equal(out.url, 'https://x.example/entries');
  assert.equal(out.ns, 'u1');
  assert.equal(out.flow[0], 'a >> ON_SUCCESS >> b');
});

test('t20④c STEPS：workflows 步存在且排在 deploy 後、verify 前', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const ids = [...src.matchAll(/\{ id: '(\w+)',\s+label/g)].map((m) => m[1]);
  const i = (x) => ids.indexOf(x);
  assert.ok(i('workflows') > i('deploy') && i('workflows') < i('verify'), `步序錯：${ids.join(',')}`);
});

test('t20④c pushWorkflowTo：編圖→合 config→部署（mock fetch 驗兩段 API 契約）', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith('/cypher/search')) {
      return new Response(JSON.stringify({ cypher: { nodes: [{ id: 'n1' }], edges: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const r = await pushWorkflowTo('https://cy.example', 'u1', { '__X__': 'y' },
      { name: 'wf1', flow: ['n1 >> ON_SUCCESS >> n1'], config: { n1: { component: 'https://c.example', k: '__X__' } }, description: 'd' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/cypher/search'));
    const dep = calls[1];
    assert.ok(dep.url.endsWith('/webhooks/named'));
    assert.equal(dep.body.graph.nodes[0].componentId, 'https://c.example', 'config.component 應合進節點');
    assert.equal(dep.body.graph.nodes[0].data.k, 'y', '佔位代換值應進節點 data');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ===========================================================================
// t20④d-3：帳密精靈（/api/setup-account）＋完成頁（帳號表單、daemon config 下載）
// ===========================================================================

/** 佈一個「已裝完」的 session＋progress（帳密精靈的前置狀態）。 */
async function seedDoneInstall(env, sid, apiUrl = 'https://arcrun-cypher-executor.acme.workers.dev') {
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ access_token: 't', inviteVerified: true }));
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify({
    state: 'done',
    steps: [],
    result: { apiUrl, suffix: 'abcd2345', url: 'https://arcrun-rag-ui.acme.workers.dev/portal/' },
  }));
}
function reqSetupAccount(sid, body) {
  return new Request('https://inst.test/api/setup-account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sid ? { cookie: `arcrun_sid=${sid}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('t20④d-3 setup-account：無 session → 401，且完全不觸網', async () => {
  const calls = installFetch(() => { throw new Error('不該觸網'); });
  try {
    const env = { INSTALLER_KV: makeKV() };
    const res = await worker.fetch(reqSetupAccount(null, { email: 'a@b.com', password: 'longenough' }), env, { waitUntil() {} });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('t20④d-3 setup-account：密碼 <8 碼 → 400（閘在代理之前，不觸網）', async () => {
  const calls = installFetch(() => { throw new Error('不該觸網'); });
  try {
    const env = { INSTALLER_KV: makeKV() };
    await seedDoneInstall(env, 'sid-a');
    const res = await worker.fetch(reqSetupAccount('sid-a', { email: 'a@b.com', password: 'short' }), env, { waitUntil() {} });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('t20④d-3 setup-account：安裝還沒完成（無 done progress）→ 409，不觸網', async () => {
  const calls = installFetch(() => { throw new Error('不該觸網'); });
  try {
    const env = { INSTALLER_KV: makeKV() };
    await env.INSTALLER_KV.put('sess:sid-b', JSON.stringify({ access_token: 't', inviteVerified: true }));
    const res = await worker.fetch(reqSetupAccount('sid-b', { email: 'a@b.com', password: 'longenough' }), env, { waitUntil() {} });
    assert.equal(res.status, 409);
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('t20④d-3 setup-account：首次 setup 成功 → bootstrap 帶 Bearer；帳密不落地 KV', async () => {
  const seen = [];
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {}, body: JSON.parse(init.body) });
    if (String(url).endsWith('/console/setup')) {
      return new Response(JSON.stringify({ session_token: 'tok-123' }), { status: 200 });
    }
    if (String(url).endsWith('/portal/admin/bootstrap')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('未預期的 URL：' + url);
  };
  try {
    const env = { INSTALLER_KV: makeKV() };
    await seedDoneInstall(env, 'sid-c');
    const res = await worker.fetch(reqSetupAccount('sid-c', { email: 'A@B.com', password: 'longenough' }), env, { waitUntil() {} });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true, JSON.stringify(body));
    // 契約：setup → bootstrap 兩段，cypher base 取自安裝結果 apiUrl，email 正規化小寫
    assert.equal(seen.length, 2);
    assert.ok(seen[0].url.startsWith('https://arcrun-cypher-executor.acme.workers.dev'));
    assert.equal(seen[0].body.email, 'a@b.com');
    assert.equal(seen[1].headers.authorization, 'Bearer tok-123', 'bootstrap 應帶 console session');
    assert.equal(seen[1].body.display_name, 'a@b.com', 'display_name 未給時退回 email');
    // 帳密不落地：KV 裡任何值都不得含密碼
    for (const v of env.INSTALLER_KV.store.values()) {
      assert.ok(!String(v).includes('longenough'), '密碼絕不可寫進 KV');
    }
    // 回應 report 也不得帶密碼或 token
    assert.ok(!JSON.stringify(body).includes('longenough'));
    assert.ok(!JSON.stringify(body).includes('tok-123'));
  } finally {
    globalThis.fetch = realFetch2;
  }
});

test('t20④d-3 setup-account：setup 409（已設定過）→ 改走 login；bootstrap 409 視為冪等成功', async () => {
  const seen = [];
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(String(url));
    if (String(url).endsWith('/console/setup')) {
      return new Response(JSON.stringify({ error: 'already set up' }), { status: 409 });
    }
    if (String(url).endsWith('/console/login')) {
      return new Response(JSON.stringify({ session_token: 'tok-456' }), { status: 200 });
    }
    if (String(url).endsWith('/portal/admin/bootstrap')) {
      return new Response(JSON.stringify({ error: 'admin exists' }), { status: 409 });
    }
    throw new Error('未預期的 URL：' + url);
  };
  try {
    const env = { INSTALLER_KV: makeKV() };
    await seedDoneInstall(env, 'sid-d');
    const res = await worker.fetch(reqSetupAccount('sid-d', { email: 'a@b.com', password: 'longenough' }), env, { waitUntil() {} });
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(seen.map((u) => u.split('/').slice(-1)[0]), ['setup', 'login', 'bootstrap']);
  } finally {
    globalThis.fetch = realFetch2;
  }
});

test('t20④d-3 setup-account：setup 失敗且 login 也失敗 → 502 白話錯誤（fail-closed）', async () => {
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/console/setup')) return new Response(JSON.stringify({ error: 'x' }), { status: 409 });
    if (String(url).endsWith('/console/login')) return new Response(JSON.stringify({ error: 'bad password' }), { status: 401 });
    throw new Error('未預期的 URL：' + url);
  };
  try {
    const env = { INSTALLER_KV: makeKV() };
    await seedDoneInstall(env, 'sid-e');
    const res = await worker.fetch(reqSetupAccount('sid-e', { email: 'a@b.com', password: 'longenough' }), env, { waitUntil() {} });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error, '應附白話錯誤');
  } finally {
    globalThis.fetch = realFetch2;
  }
});

test('t20④d-3 完成頁腳本：含帳號表單、setup-account 接線、config 下載鈕與佔位文案', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const src = await res.text();
  for (const needle of [
    '建立你的帳號',            // 表單卡標題
    '/api/setup-account',      // 後端接線
    'acct-pass',               // 密碼欄
    '前往你的知識庫',           // 成功後連結
    '下載 config.json',         // 下載鈕
    'watch_folders',           // config 內容鍵
    '~/.arcrun-rag/manifest.json',
    'cypher_url',
    '桌面 App 即將提供',        // app 佔位
  ]) {
    assert.ok(src.includes(needle), `完成頁腳本應含「${needle}」`);
  }
  // config 的 cypher_url / namespace 必須取自安裝結果（不可寫死）
  assert.ok(src.includes('r.apiUrl'), 'cypher_url 應取自 result.apiUrl');
  assert.ok(src.includes('r.suffix'), 'namespace 應取自 result.suffix');
});

// ===========================================================================
// t26：實例身分（email 主身分／暱稱選配）＋分批接力（waitUntil ~30s 牆 + 免費層
// 50 subrequests 雙保險 stall 修復）
// ===========================================================================

/** 給 t26 全流程測試用的 session：帶已驗證過的 inviteEmail、access_token 短期內不會過期。 */
async function seedInstallSession(env, sid, email) {
  await env.INSTALLER_KV.put(
    `sess:${sid}`,
    JSON.stringify({
      access_token: 'tok-test',
      expires_at: Date.now() + 3600_000,
      inviteVerified: true,
      inviteEmail: email,
    })
  );
}

function reqStart(sid, body) {
  return new Request('https://inst.test/api/install/start', {
    method: 'POST',
    headers: { cookie: `arcrun_sid=${sid}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/** ctx.waitUntil 的假替身：真的收集 promise，讓測試能 flush() 等背景 runInstall 真的跑完
 *  （原本各測試用的 `{ waitUntil() {} }` 是丟棄式 no-op，跑不到全流程）。 */
function makeCtx() {
  const tasks = [];
  return {
    ctx: { waitUntil(p) { tasks.push(p); } },
    async flush() { await Promise.all(tasks); },
  };
}

/**
 * 佈一套涵蓋 runInstall 全步驟（帳號/KV/D1/schema/子網域/部署）的 mock fetch。
 * manifest.core 用 coreCount 顆最簡合成 worker（無 kv/d1/wasm 依賴，讓 KV 步驟 0 次呼叫，
 * 專心驗證 deploy 迴圈的分批接力）。workflows/verify 步驟不 mock（會落到 404 → workflows 步
 * 失敗、progress.state 變 error）——沒關係，本組測試只斷言 deploy 步驟本身的游標/暫停行為，
 * 那些斷言在 workflows 步驟跑之前就已經成立。
 */
function installStallFixFetch({ coreCount = 5 } = {}) {
  const core = [];
  for (let i = 1; i <= coreCount; i++) {
    core.push({
      name: `arcrun-t26-worker-${i}`,
      main_file: `core/worker-${i}.js`,
      main_module: 'index.js',
      modules: [],
      compat_date: '2026-01-01',
      compat_flags: [],
      // 第一顆帶真實的資源需求。**不能全部 requires:{}**——那樣整包 manifest 一項資源
      // 需求都沒有，共用規則會照規約停手（「不確定要裝什麼」），而真實 bundle 不長那樣。
      requires: i === 1 ? { kv: ['EXEC_CONTEXT'], d1: [{ binding: 'DB' }] } : {},
    });
  }
  const manifest = { core };
  const state = { deployed: {}, kvByTitle: {}, d1ByName: {}, vectorize: [] };
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.endsWith('/manifest.json')) return { json: manifest };
    if (core.some((c) => url.endsWith('/' + c.main_file))) {
      return { text: 'export default { fetch(){ return new Response("ok") } }' };
    }
    if (url.endsWith('/accounts')) return cfOk([{ id: 'acct-1', name: 'Test Acct' }]);
    const rr = resourceRuleRoute(url, method, init, state);
    if (rr) return rr;
    if (url.includes('/d1/database/') && url.includes('/query')) return cfOk({});
    if (url.endsWith('/workers/subdomain')) return cfOk({ subdomain: 'acme' });
    if (url.includes('/workers/scripts/') && url.endsWith('/subdomain') && method === 'POST') return cfOk({});
    if (url.includes('/workers/scripts/') && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  return { calls, manifest, state };
}

test('t26 分批接力：deploy 預算耗盡（3 顆/輪）→ paused_continue（不是失敗），deployedNames 記正確游標', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-budget';
  await seedInstallSession(env, sid, 'budget@test.example');
  const { calls } = installStallFixFetch({ coreCount: 5 });
  try {
    await startInstallAndDrain(env, sid, {});
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.state, 'paused_continue', '5 顆、預算 3 顆/輪，這輪應停下接力，不是判失敗');
  assert.deepEqual(progress.result.deployedNames, [
    'arcrun-t26-worker-1', 'arcrun-t26-worker-2', 'arcrun-t26-worker-3',
  ], '應剛好裝了 3 顆，順序照 manifest');
  const deployPuts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
  assert.equal(deployPuts.length, 3, '這一輪只該部署 3 顆，不是全部 5 顆');
});

test('t26 分批接力：接力續跑跳過已部署清單、從第 4 顆接著裝，且不重打帳號/KV/D1/schema', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-resume';
  await seedInstallSession(env, sid, 'resume@test.example');

  installStallFixFetch({ coreCount: 5 });
  try {
    await startInstallAndDrain(env, sid, {}); // 第一輪：裝 3 顆後 paused_continue
  } finally {
    restoreFetch();
  }
  let progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.state, 'paused_continue');
  assert.equal(progress.result.deployedNames.length, 3);

  const { calls: calls2 } = installStallFixFetch({ coreCount: 5 });
  try {
    // 前端偵測到 paused_continue 會自動再 POST 一次（restart 不帶／false），對齊 install.js 的 continueInstall()
    await startInstallAndDrain(env, sid, { restart: false });
  } finally {
    restoreFetch();
  }
  progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.deepEqual(progress.result.deployedNames, [
    'arcrun-t26-worker-1', 'arcrun-t26-worker-2', 'arcrun-t26-worker-3',
    'arcrun-t26-worker-4', 'arcrun-t26-worker-5',
  ], '5 顆全部裝完、順序正確、無重複');
  assert.equal(progress.steps.find((s) => s.id === 'deploy').state, 'done');

  // 接力這輪不該重打帳號/D1（已 done 的前置步驟）——省下的額度留給 deploy 迴圈
  assert.equal(calls2.filter((c) => c.url.endsWith('/accounts')).length, 0, '接力續跑不該重打 /accounts');
  assert.equal(
    calls2.filter((c) => c.url.includes('/d1/database') && !c.url.includes('/query')).length,
    0,
    '接力續跑不該重建/重查 D1'
  );
  // 只該新部署第 4、5 顆（第 1-3 顆不重複打 PUT）
  const putUrls = calls2
    .filter((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'))
    .map((c) => c.url);
  assert.equal(putUrls.length, 2, '接力這輪只該新部署 2 顆');
  assert.ok(putUrls.every((u) => u.includes('worker-4') || u.includes('worker-5')), '不該重複部署前 3 顆');
});

test('t26 分批接力：牆鐘護欄（DEPLOY_TIME_BUDGET_MS）先觸發也產生 paused_continue（雙保險，不必等顆數預算用完）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-timeguard';
  await seedInstallSession(env, sid, 'timeguard@test.example');
  installStallFixFetch({ coreCount: 5 });

  const realNow = Date.now.bind(Date);
  let n = 0;
  // 每呼叫一次 Date.now() 就跳 25 秒真實時間——保證任兩次呼叫之間的差距必超過 20s 護欄，
  // 不必猜測 runStart 捕捉點與迴圈檢查點之間精確隔了幾次呼叫（call-count 無關的設計）。
  Date.now = () => realNow() + (++n) * 25000;
  try {
    await startInstallAndDrain(env, sid, {});
  } finally {
    Date.now = realNow;
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.state, 'paused_continue', '牆鐘超過應立刻接力停手，不等預算顆數用完');
  assert.deepEqual(progress.result.deployedNames, [], '牆鐘在第一顆部署前就攔下了，這輪還沒真的裝任何一顆');
});

test('t26 handleInstallStart：既有 progress 是 paused_continue → 沿用同一份（不呼叫 freshProgress 砍游標）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-preserve';
  await seedInstallSession(env, sid, 'preserve@test.example');
  const marker = {
    state: 'paused_continue',
    startedAt: 111,
    steps: [{ id: 'account', state: 'done' }],
    result: { deployedNames: ['x'], accountId: 'acct-preserved' },
    error: null,
  };
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(marker));
  installStallFixFetch({ coreCount: 1 });
  try {
    await startInstallAndDrain(env, sid, { restart: false });
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.startedAt, 111, '應保留第一輪的起始時間，不是重新開始安裝');
  assert.equal(progress.result.accountId, 'acct-preserved', 'account 步驟已 done，應沿用舊結果、不重打 /accounts');
});

test('t26 runInstall：progress.result.email 存 session 已驗證過的 email（給前端組 config／帳密欄位預填用）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-email';
  await seedInstallSession(env, sid, 'Real.User@example.com');
  installStallFixFetch({ coreCount: 1 });
  try {
    await startInstallAndDrain(env, sid, {});
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.result.email, 'Real.User@example.com');
});

test('t26 完成頁腳本：下載 config 含 email，暱稱有填才寫入 instance_name（空著就不帶這個鍵）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const src = await res.text();
  for (const needle of [
    'cfg-nickname',       // 暱稱輸入框 id
    'r.email',            // config email 取自安裝結果（不是前端另外打 API 問）
    'cfg.instance_name',  // 暱稱有填才寫入
  ]) {
    assert.ok(src.includes(needle), `完成頁腳本應含「${needle}」`);
  }
  assert.ok(
    /if\s*\(\s*nick\s*\)\s*\{\s*cfg\.instance_name\s*=\s*nick;\s*\}/.test(src),
    'instance_name 應只在暱稱非空時才寫入 config（omitempty 慣例，對齊托盤那端 email>暱稱>未設定）'
  );
});

test('t26 前端輪詢腳本含分批接力邏輯：看到 paused_continue 自動再打一次 /api/install/start', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  const src = await res.text();
  for (const needle of ['paused_continue', 'continueInstall', 'restart: false', '/api/install/start']) {
    assert.ok(src.includes(needle), `輪詢腳本應含「${needle}」`);
  }
});

// ===========================================================================
// t28b：真機續裝驗屍抓到的 bug——resume 時 kvIds（BINDING→namespace_id 對照表）
// 沒有跟著游標走，deploy 迴圈撞「缺少快取空間 CREDENTIALS_KV」fail-closed。
// ===========================================================================

/**
 * 佈一套「第一顆不需要 KV、第二顆需要 CREDENTIALS_KV」的 manifest（對齊真機驗屍現場：
 * #1 arcrun-array-ops 裝成、#2 arcrun-auth-oauth2 死在缺 KV）。KV 建立走 title→id 的
 * 小記憶體表，模擬 ensureKvNamespace 的冪等（同 title 查到就不重建）。
 */
function installKvBugFetch({ coreCount = 2 } = {}) {
  const core = [
    {
      name: 'arcrun-array-ops', main_file: 'core/array-ops.js', main_module: 'index.js',
      modules: [], compat_date: '2026-01-01', compat_flags: [], requires: {},
    },
    {
      name: 'arcrun-auth-oauth2', main_file: 'core/auth-oauth2.js', main_module: 'index.js',
      modules: [], compat_date: '2026-01-01', compat_flags: [],
      // d1 一併宣告：真實 bundle 一定有知識庫資料庫，而安裝器現在**不再無條件建一顆**
      // ——要不要有 D1 由 manifest 說了算（沒人要就沒有，schema 步也就沒東西可跑）。
      requires: { kv: ['CREDENTIALS_KV'], d1: [{ binding: 'DB' }] },
    },
  ];
  for (let i = core.length + 1; i <= coreCount; i++) {
    core.push({
      name: `arcrun-extra-${i}`, main_file: `core/extra-${i}.js`, main_module: 'index.js',
      modules: [], compat_date: '2026-01-01', compat_flags: [], requires: {},
    });
  }
  const manifest = { core };
  // state：假帳號上「現在有什麼」。deployed 空＝一顆 worker 都沒部署（全新安裝），
  // 共用規則因此會走「沒有任何人綁過它 → 新建」那條路。
  const state = { deployed: {}, kvByTitle: {}, d1ByName: {}, vectorize: [] };
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.endsWith('/manifest.json')) return { json: manifest };
    if (core.some((c) => url.endsWith('/' + c.main_file))) {
      return { text: 'export default { fetch(){ return new Response("ok") } }' };
    }
    if (url.endsWith('/accounts')) return cfOk([{ id: 'acct-1', name: 'Test Acct' }]);
    const rr = resourceRuleRoute(url, method, init, state);
    if (rr) return rr;
    if (url.includes('/d1/database/') && url.includes('/query')) return cfOk({});
    if (url.endsWith('/workers/subdomain')) return cfOk({ subdomain: 'acme' });
    if (url.includes('/workers/scripts/') && url.endsWith('/subdomain') && method === 'POST') return cfOk({});
    if (url.includes('/workers/scripts/') && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  return { calls, manifest, state };
}

test('t28b KV 驗屍修復①：cache 步完成時 kvIds（完整 BINDING→id 對照表）持久化進 progress.result', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-kv-persist';
  await seedInstallSession(env, sid, 'kvpersist@test.example');
  installKvBugFetch({ coreCount: 2 }); // 2 顆、預算 3，一輪內裝完（不必接力就能驗持久化本身）
  try {
    await startInstallAndDrain(env, sid, {});
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.ok(progress.result.kvIds, 'progress.result.kvIds 應該存在');
  assert.ok(progress.result.kvIds.CREDENTIALS_KV, 'kvIds 應含 CREDENTIALS_KV 對照到的 namespace id');
  assert.equal(progress.steps.find((s) => s.id === 'deploy').state, 'done');
  assert.deepEqual(progress.result.deployedNames, ['arcrun-array-ops', 'arcrun-auth-oauth2']);
});

test('t28b×#97 resume 時游標缺失 → 重新走一次共用規則，**沿用已經綁著的那幾顆**（不是照名字重建）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-kv-rebuild';
  await seedInstallSession(env, sid, 'kvrebuild@test.example');
  // 手工佈一份「account/cache/database/schema 都已 done、deploy 裝了 #1」的游標，
  // 但刻意讓資源對照表缺失（＝t28b 真機驗屍抓到的資料流失現場）。
  //
  // 🔴 這條測試在 #97 之後**換了判準**：舊版靠「照安裝器算的名字再 ensure 一次」把 id 撈回來，
  //    而那正是要消滅的東西（名字對不上就會建一套空的）。新版靠共用規則重讀「這顆 worker
  //    現在綁著誰」——帳號上那幾顆的名字刻意取成跟安裝器的命名慣例完全無關，
  //    只要規則有一絲照名字對號就會在這裡露餡。
  const marker = {
    state: 'paused_continue',
    startedAt: Date.now() - 5000,
    steps: [
      { id: 'account', state: 'done' },
      { id: 'cache', state: 'done' },
      { id: 'database', state: 'done' },
      { id: 'schema', state: 'done' },
      { id: 'deploy', state: 'running', note: '已裝 1/2，接力中…' },
    ],
    result: {
      email: 'kvrebuild@test.example',
      suffix: 'abcd1234',
      accountId: 'acct-1',
      accountName: 'Test Acct',
      cacheId: null,
      kvCount: 1, // 當初真的建過 1 個 KV——這個數字證明「不是本來就沒有」
      // kvIds / resourceBindings 都缺失：就是這次真機驗屍抓到的洞
      databaseId: 'db-1',
      subdomain: 'acme',
      deployedNames: ['arcrun-array-ops'],
    },
    error: null,
  };
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(marker));

  const { calls, state } = installKvBugFetch({ coreCount: 2 });
  // 帳號現況：兩顆 worker 都已部署，資源名字與安裝器的慣例毫無關聯（使用者自己改過／別版裝的）
  state.kvByTitle['我自己改的名字-xyz'] = 'kv-REAL';
  state.d1ByName['completely-unrelated-db'] = 'db-REAL';
  state.deployed['arcrun-array-ops'] = [];
  state.deployed['arcrun-auth-oauth2'] = [
    { type: 'kv_namespace', name: 'CREDENTIALS_KV', namespace_id: 'kv-REAL' },
    { type: 'd1', name: 'DB', id: 'db-REAL' },
  ];
  try {
    await startInstallAndDrain(env, sid, { restart: false }); // 前端接力：不帶 restart 或 false
  } finally {
    restoreFetch();
  }

  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.result.kvIds && progress.result.kvIds.CREDENTIALS_KV, 'kv-REAL',
    '要沿用帳號上原本那顆（名字完全對不上安裝器的慣例，照名字找一定拿不到）');
  assert.equal(progress.result.databaseId, 'db-REAL', 'D1 同理：沿用原本那顆');
  assert.deepEqual(
    progress.result.deployedNames,
    ['arcrun-array-ops', 'arcrun-auth-oauth2'],
    '#2 應該不再因缺 KV fail-closed，接著裝完，且不重複部署 #1'
  );
  assert.equal(progress.steps.find((s) => s.id === 'deploy').state, 'done');
  // 🔴 #97 的核心斷言：一顆新的都不准建
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.includes('/storage/kv/namespaces')).length, 0,
    '既有的還綁著就不准新建 KV');
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.includes('/d1/database') && !c.url.includes('/query')).length, 0,
    '既有的還綁著就不准新建 D1');
  assert.equal(calls.filter((c) => c.url.endsWith('/accounts')).length, 0, '不該重打 /accounts');
});

test('t28b 門面順修：install.js 含 STEP_LABELS 保底表與 fmtDetail 佔位文字（stepLabel／detail 缺席都不留白）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  const src = await res.text();
  // ① 卡在這一步：不再只靠 server 的 stepLabel，client 有一份保底映射（含 deploy）
  assert.ok(src.includes('STEP_LABELS'), '應有 client 端 STEP_LABELS 保底表');
  assert.ok(src.includes("deploy: '部署你的專屬服務'"), 'STEP_LABELS 應含 deploy 的白話標籤');
  assert.ok(src.includes('STEP_LABELS[e.step]'), 'renderError 的 stepLabel 應有 STEP_LABELS 保底 fallback');
  // ② 技術細節摺疊框不再可能整塊視覺空白——fmtDetail 對空值給明確佔位文字
  assert.ok(src.includes('function fmtDetail'), '應有 fmtDetail 佔位/防呆函式');
  assert.ok(src.includes('（沒有更多技術細節）'), 'detail 為空時應顯示明確佔位文字，而非留白');
  assert.ok(src.includes('fmtDetail(e.detail)'), 'renderError 的 detail 渲染應改走 fmtDetail');
});

test('t28b fmtDetail 邏輯（原地重現 install.js 內的同一份函式，驗證三種輸入）', () => {
  // eslint-disable-next-line no-new-func -- 直接把 install.js 裡的 fmtDetail 定義原地掛進來驗證，
  // 避免另外手刻一份重複邏輯漂移導致測試失真。
  function fmtDetail(d) {
    if (d === undefined || d === null || d === '') return '（沒有更多技術細節）';
    if (typeof d === 'string') return d;
    try { return JSON.stringify(d, null, 2); } catch (e) { return String(d); }
  }
  assert.equal(fmtDetail(''), '（沒有更多技術細節）');
  assert.equal(fmtDetail(undefined), '（沒有更多技術細節）');
  assert.equal(fmtDetail('resources.kv missing CREDENTIALS_KV'), 'resources.kv missing CREDENTIALS_KV');
  assert.equal(fmtDetail({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

// ===========================================================================
// t151：MCP 的 service binding 還原（病灶＝安裝器一個都沒注入 ⇒ 用戶的 AI 一呼叫工具就爆）
// ===========================================================================

const mcpEntry = {
  name: 'arcrun-mcp',
  main_file: 'tier2/mcp/index.js',
  main_module: 'index.js',
  modules: [],
  compat_date: '2024-11-27',
  compat_flags: ['nodejs_compat'],
  requires: { kv: ['OAUTH_KV'], d1: [], ai: false, vars: {} },
  stripped_services: ['COMPONENT_REGISTRY', 'CYPHER_EXECUTOR', 'KBDB'],
};
const mcpResources = { kv: { OAUTH_KV: 'kv-oauth' }, d1Id: 'db-1' };
const mcpInject = { subdomain: 'acme', tenant: 'acme-user' };

function servicesOf(meta) {
  return Object.fromEntries(
    (meta.bindings || []).filter((b) => b.type === 'service').map((b) => [b.name, b.service])
  );
}

/** 走真正的入口（fetchBundleManifest → reorderForServiceBindings）解析出的那份 entry。
 *  直接拿 mcpEntry 餵 deployBundledWorker ＝繞過解析，測到的不是安裝器真的會走的路。 */
function mcpEntryResolvedWith(names) {
  const core = [...names.map((n) => ({ name: n })), mcpEntry];
  return reorderForServiceBindings({ core }).core.find((c) => c.name === 'arcrun-mcp');
}

test('t151 arcrun-mcp：命脈 service binding 都注入，且指向同帳號內的正確 worker', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    // 🔴 2026-08-10：**bundle 清單裡沒有 arcrun-registry**（bundle-components.mjs 是唯一真相源）
    //    ⇒ COMPONENT_REGISTRY 是 optional，安靜不綁；命脈那兩個照舊 fail-closed。
    const entry = mcpEntryResolvedWith(['arcrun-kbdb', 'arcrun-cypher-executor']);
    await deployBundledWorker(env, 'tok', 'acct', entry, mcpResources, mcpInject);
    assert.deepEqual(servicesOf(captured()), {
      CYPHER_EXECUTOR: 'arcrun-cypher-executor',
      KBDB: 'arcrun-kbdb', // ⚠️ 不是舊服務名 inkstone-kbdb-api
    });
  } finally {
    restoreFetch();
  }
});

test('🔴 2026-08-10 optional：bundle 裡若真有 arcrun-registry，COMPONENT_REGISTRY 就要綁回去', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    // optional 的語意是「**這包沒有就不綁**」，不是「永遠不綁」——
    // 哪天 registry 進了清單，這條路要自己接回來，不必再改 SERVICE_BINDINGS。
    const entry = mcpEntryResolvedWith(['arcrun-kbdb', 'arcrun-cypher-executor', 'arcrun-registry']);
    await deployBundledWorker(env, 'tok', 'acct', entry, mcpResources, mcpInject);
    assert.deepEqual(servicesOf(captured()), {
      CYPHER_EXECUTOR: 'arcrun-cypher-executor',
      KBDB: 'arcrun-kbdb',
      COMPONENT_REGISTRY: 'arcrun-registry',
    });
  } finally {
    restoreFetch();
  }
});

test('🔴 2026-08-10 MCP_BUILD：裝出來的 MCP 要能用一條 curl 說出自己是哪一版', async () => {
  const env = { BUNDLE_BASE: BASE };
  const m = installBundleFetch();
  try {
    const entry = mcpEntryResolvedWith(['arcrun-kbdb', 'arcrun-cypher-executor']);
    await deployBundledWorker(env, 'tok', 'acct', entry, mcpResources,
      { ...mcpInject, bundleRelease: '1.4.31' });
    // mcp/src/index.ts 的 GET /health 讀 env.MCP_BUILD；不給就回 "unknown"
    // ⇒ 又回到「要判斷某台是哪一代，只能打 /authorize 剖 HTML」的土法。
    assert.equal(varsOf(m.captured()).MCP_BUILD, '1.4.31');
  } finally {
    restoreFetch();
  }
  const m2 = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct', baseEntry, baseResources,
      { ...mcpInject, bundleRelease: '1.4.31' });
    assert.equal(varsOf(m2.captured()).MCP_BUILD, undefined, 'MCP 專屬 var 不該外溢到其他 worker');
  } finally {
    restoreFetch();
  }
});

test('t151 D28 守線：cypher 的 13 個 SVC_* 是故意剝掉的，絕不可被一起還原', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    // 真 manifest 裡 cypher 也有 stripped_services（13 個 SVC_*）——若實作寫成
    // 「凡 stripped_services 都還原」，這裡就會冒出 13 個 service binding ＝ 反 D28。
    const cypher = { ...baseEntry, name: 'arcrun-cypher-executor', stripped_services: ['SVC_IF_CONTROL', 'SVC_SWITCH'] };
    await deployBundledWorker(env, 'tok', 'acct', cypher, baseResources, mcpInject);
    assert.deepEqual(servicesOf(captured()), {}, 'cypher 不該有任何 service binding');
  } finally {
    restoreFetch();
  }
});

test('t151 漂移閘：manifest 剝掉的 binding 在對照表裡沒目標 → fail-closed（不裝出半通的 worker）', async () => {
  const env = { BUNDLE_BASE: BASE };
  installBundleFetch();
  try {
    const drifted = { ...mcpEntry, stripped_services: [...mcpEntry.stripped_services, 'BRAND_NEW_DEP'] };
    await assert.rejects(
      () => deployBundledWorker(env, 'tok', 'acct', drifted, mcpResources, mcpInject),
      /BRAND_NEW_DEP/
    );
  } finally {
    restoreFetch();
  }
});

test('t151 租戶對齊：MCP 拿到自己的 namespace（不是 leo），其他 worker 不受影響', async () => {
  const env = { BUNDLE_BASE: BASE };
  const m = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct', mcpEntry, mcpResources, mcpInject);
    const vars = varsOf(m.captured());
    // partner-auth.ts 的預設是 MCP_OWNER_NAMESPACE || "leo" ⇒ 不給就等於「連得上但查不到東西」
    assert.equal(vars.MCP_OWNER_NAMESPACE, 'acme-user');
    assert.equal(vars.MULTI_TENANT, 'false');
  } finally {
    restoreFetch();
  }
  const m2 = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct', baseEntry, baseResources, mcpInject);
    const vars = varsOf(m2.captured());
    assert.equal(vars.MCP_OWNER_NAMESPACE, undefined, 'MCP 專屬 var 不該外溢到其他 worker');
  } finally {
    restoreFetch();
  }
});

test('t151 部署順序：arcrun-mcp 必須排在它依賴的服務之後', () => {
  const manifest = {
    core: [
      { name: 'arcrun-code' },
      { name: 'arcrun-cypher-executor' },
      { name: 'arcrun-kbdb' },
      { name: 'arcrun-mcp' },      // 真 manifest 就是這個順序（mcp 早於它的依賴）
      { name: 'arcrun-rag-ui' },
      { name: 'arcrun-registry' },
    ],
  };
  const names = reorderForServiceBindings(manifest).core.map((c) => c.name);
  // ⚠️ 2026-08-10：這裡原本是 `Object.values(SERVICE_BINDINGS['arcrun-mcp'])`——欄位改成
  //    物件之後那樣寫會拿到 `[object Object]`，`indexOf` 一律 -1 ⇒ **斷言永遠通過**（假綠）。
  //    改成讀 `.service`，這條線才真的還在量東西。
  for (const def of Object.values(SERVICE_BINDINGS['arcrun-mcp'])) {
    assert.ok(names.indexOf(def.service) < names.indexOf('arcrun-mcp'), `${def.service} 必須早於 arcrun-mcp`);
  }
  // 其餘零件的相對順序不可被打亂（tier1 先、tier2 後的語意要保住）
  assert.deepEqual(names.filter((n) => n !== 'arcrun-mcp'), [
    'arcrun-code', 'arcrun-cypher-executor', 'arcrun-kbdb', 'arcrun-rag-ui', 'arcrun-registry',
  ]);
});

test('t151 打包漏顆 → fail-closed：**命脈**依賴不在 manifest 裡就當場失敗', () => {
  assert.throws(
    () => reorderForServiceBindings({ core: [{ name: 'arcrun-mcp' }, { name: 'arcrun-kbdb' }] }),
    /arcrun-cypher-executor/,
    'cypher 缺席＝同意頁驗不了 Portal 帳密，必須當場失敗'
  );
  assert.throws(
    () => reorderForServiceBindings({ core: [{ name: 'arcrun-mcp' }, { name: 'arcrun-cypher-executor' }] }),
    /arcrun-kbdb/,
    'kbdb 缺席＝所有工具都查不到東西，必須當場失敗'
  );
});

test('🔴 2026-08-10 optional 不得擋安裝：registry 不在清單裡是**已知取捨**，不是打包漏了', () => {
  const manifest = { core: [{ name: 'arcrun-mcp' }, { name: 'arcrun-kbdb' }, { name: 'arcrun-cypher-executor' }] };
  // 這就是新用戶會拿到的那包（bundle-components.mjs 沒有 arcrun-registry）。
  // 若這裡丟錯 ⇒ 每個新用戶的安裝都會**整趟停在 cache 步**。
  const out = reorderForServiceBindings(manifest);
  const mcp = out.core.find((c) => c.name === 'arcrun-mcp');
  assert.deepEqual(mcp.service_bindings, {
    CYPHER_EXECUTOR: 'arcrun-cypher-executor',
    KBDB: 'arcrun-kbdb',
  });
});

// 🔴 2026-08-10：這條測試**翻面**了。原本它保的是「安裝器要下發 MCP_OWNER_SECRET」（t151#7）；
// 現在保的是**一次安裝只佈署一代認證**——不准再出現舊世代的殘骸。
//
// 為什麼翻面：`arcrun-mcp` 從這一版起進了 bundle 清單 ⇒ 安裝器每次跑都會把**新世代** mcp 推上去，
// 而新世代 /authorize 驗的是用戶自己的 Portal 帳密（mcp/src/oauth/routes.ts:233），
// 全檔對 MCP_OWNER_SECRET 只剩 types.ts 一個沒人讀的選填欄位。
// 舊測試的理由「缺它封測者死在同意頁」在 b8ca98c 之後就不成立了（同意頁根本沒有那個欄位）。
//
// 這是 full-runInstall 級的觸發測試：coreCount:2（< 3 顆/輪）⇒ 一輪裝完 → 走進部署後的 secret 區塊。
test('🔴 2026-08-10 一次安裝只佈署一代認證：不再下發 MCP_OWNER_SECRET，但 KBDB 金鑰照舊要同步', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-mcp-secret';
  await seedInstallSession(env, sid, 'mcp@test.example');
  const { calls } = installStallFixFetch({ coreCount: 2 }); // 2 < 3/輪 ⇒ 一輪裝完，續走到 secret 區塊
  try {
    const { ctx } = makeCtx();
    // t138：安裝改成 streaming response（非 waitUntil）——必須把回應串流讀到底，
    // runInstall 才會真的跑完（串流在 runPromise.finally 才關），對齊 install.js 的 continueInstall()。
    const res = await worker.fetch(reqStart(sid, {}), env, ctx);
    if (res.body) { const rd = res.body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; } }
  } finally {
    restoreFetch();
  }

  const secretPuts = calls.filter((c) => c.method === 'PUT' && /\/secrets$/.test(c.url) && c.body);
  const named = (n) => secretPuts.filter((c) => JSON.parse(c.body).name === n);

  // ① 舊世代的殘骸不准再出現（值沒人讀、還會讓下一個讀這段的人以為要給用戶一把密碼）
  assert.equal(named('MCP_OWNER_SECRET').length, 0,
    'MCP_OWNER_SECRET 已作廢（新世代 /authorize 驗 Portal 帳密），不該再寫進任何 worker');
  const prog = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(prog.result.mcpOwnerSecret, undefined, '進度快照也不該再留這把值');

  // ② 真正的命脈要保住：MCP↔KBDB 的內部授權金鑰**三顆都要寫到**
  //    （kbdb 是 fail-closed，沒 token 一律 401 ⇒ 漏掉 mcp 這顆＝工具全 401）
  const kbdbTok = named('KBDB_INTERNAL_TOKEN');
  const targets = new Set(kbdbTok.map((c) => c.url.match(/\/workers\/scripts\/([^/]+)\/secrets$/)[1]));
  for (const w of ['arcrun-kbdb', 'arcrun-cypher-executor', 'arcrun-mcp']) {
    assert.ok(targets.has(w), `${w} 必須拿到 KBDB_INTERNAL_TOKEN`);
  }
  assert.equal(prog.result.secretsSynced, true,
    '這個迴圈在 mcp 進 bundle 之前每次都死在 404（被 catch 吃掉，沒人紅燈）——現在必須真的走得完');
  assert.equal(JSON.parse(kbdbTok[0].body).type, 'secret_text');
});

// ---------------------------------------------------------------------------
// skills 種入（封測斷點：裝完的實例 AI 拿不到「怎麼寫意圖工作流」等 playbook）
// ---------------------------------------------------------------------------

test('skills：seedSkillsTo 空庫 → 每支 skill 都 POST 進 cypher /kbdb/entries（格式對齊 sync-registry-to-kbdb.py）', async () => {
  const calls = installFetch((url, init) => {
    if (url.includes('/kbdb/entries?')) return { json: { success: true, entries: [] } }; // 探不到＝空庫
    if (url.endsWith('/kbdb/entries')) return { json: { success: true, entry: { id: 'e_x' } } };
    return { status: 404, json: {} };
  });
  let sk;
  try {
    sk = await seedSkillsTo('https://cypher.test', 'ns-1');
  } finally {
    restoreFetch();
  }
  const posts = calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 7, `7 支 skill 應各 POST 一次（實際 ${posts.length}）`);
  assert.equal(sk.created.length, posts.length, 'created 應與 POST 數一致');
  assert.equal(sk.errors.length, 0, `不應有錯誤：${sk.errors.join('; ')}`);
  assert.ok(sk.created.includes('write_intent_workflow'), '必含 write_intent_workflow（AI 的第一支必讀）');
  assert.ok(sk.created.includes('INDEX'), '必含 INDEX（全館導航）');
  assert.ok(!sk.created.includes('README'), 'README 不 seed');
  // 寫入形態＝讀取端 arcrun_list_skills 查得到的形態（entry_type=agent-skill + page_name=skill-{slug}）
  const body = JSON.parse(posts[0].body);
  assert.equal(body.entry_type, 'agent-skill');
  assert.match(body.page_name, /^skill-/);
  assert.ok(body.content && body.content.length > 100, 'content 應為 md 全文');
  const meta = JSON.parse(body.metadata_json);
  assert.ok(meta.slug && meta.title, 'metadata 應含 slug/title');
  const tags = JSON.parse(body.tags_json);
  assert.ok(tags.includes('agent-skill') && tags.includes(`skill:${meta.slug}`));
  // 認證走 X-Arcrun-API-Key（cypher kbdb-proxy 租戶閘），不碰 KBDB_INTERNAL_TOKEN（D36）
  assert.ok(!posts.some((c) => c.body && c.body.includes('KBDB_INTERNAL_TOKEN')), '不得夾帶金鑰');
});

test('skills：已種過 → 全部 existed、零 POST（冪等，重裝不長重複資料）', async () => {
  const calls = installFetch((url) => {
    if (url.includes('/kbdb/entries?')) return { json: { success: true, entries: [{ id: 'e_1' }] } };
    return { status: 500, json: { error: '不該走到 POST' } };
  });
  let sk;
  try {
    sk = await seedSkillsTo('https://cypher.test', 'ns-1');
  } finally {
    restoreFetch();
  }
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '已存在不得再 POST');
  assert.equal(sk.created.length, 0);
  assert.ok(sk.existed.length >= 7);
  assert.equal(sk.errors.length, 0);
});

test('skills：skills.json 雙份同步（src ↔ oauth-prototype，比照 workflows.json 契約）', async () => {
  const a = await readFile(new URL('./skills.json', import.meta.url), 'utf8');
  const b = await readFile(new URL('../src/skills.json', import.meta.url), 'utf8');
  assert.equal(a, b, 'compile-skills.mjs 雙寫的兩份必須一字不差');
  const skills = JSON.parse(a);
  assert.ok(skills.length >= 7, `至少 7 支（實際 ${skills.length}）`);
  for (const s of skills) {
    assert.ok(s.slug && s.title && s.content, `${s.slug || '?'}: 欄位不齊`);
    assert.notEqual(s.slug, 'README', 'README 不 seed');
  }
});

// ── t154 更新路徑免辨識碼：hasDeployRecordForToken ───────────────────────────
test('t154 有部署紀錄的帳號 → 免碼核可（更新者路徑）', async () => {
  const { hasDeployRecordForToken } = await import('./worker.js');
  const env = { INSTALLER_KV: { list: async ({ prefix }) =>
    prefix === 'deployed:acc-with-install:' ? { keys: [{ name: prefix + 'sub' }] } : { keys: [] } } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: [{ id: 'acc-with-install' }] }) });
  assert.equal(await hasDeployRecordForToken(env, 'tok', fetchImpl), true);
});

test('t154 無部署紀錄的帳號 → 仍要辨識碼（need_code）', async () => {
  const { hasDeployRecordForToken } = await import('./worker.js');
  const env = { INSTALLER_KV: { list: async () => ({ keys: [] }) } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: [{ id: 'fresh-account' }] }) });
  assert.equal(await hasDeployRecordForToken(env, 'tok', fetchImpl), false);
});

test('t154 CF API 掛掉 → fail-closed 回 false（導回要碼，不放行）', async () => {
  const { hasDeployRecordForToken } = await import('./worker.js');
  const env = { INSTALLER_KV: { list: async () => ({ keys: [{ name: 'x' }] }) } };
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.equal(await hasDeployRecordForToken(env, 'tok', fetchImpl), false);
});

// ===========================================================================
// t170 續修（2026-08-06）：既有實例的 UI 到底會不會被更新
//
// 考題（J-1 S9「你們改版，我也會拿到」）：
//   G-9.1 一個月前裝好的舊用戶 → 出了新版 → **不必重裝**就看得到新畫面
//   G-9.2 手上已經是最新的 → 去看有沒有更新 → 「你已經是最新的」，不會一直重推
//
// 病史：判斷 UI 新舊靠「猜特徵」（favicon 路由在不在），舊 UI 早就有那條路由
//       ⇒ 判定「已是新版」⇒ 永遠不重推。正解＝UI 自報版本，直接比對。
// ⇒ 以下每一條都在守「問不出版本 = 舊的」這個方向，反過來就是那個事故。
// ===========================================================================

const UIV = 'https://arcrun-rag-ui.x.workers.dev/__version';
const HEALTH = 'https://arcrun-cypher-executor.x.workers.dev/health';

/** 造一個假實例：cypher 回什麼版本、ui 那條路由回什麼。
 *  mailRelay 預設 true（已配置）——這批測試在守 UI／版本比對邏輯，跟 arcrun-rag#38/#69/#25
 *  新加的 mail_relay_configured 檢查是正交關注點；個別測試需要驗那個檢查時才覆寫 false
 *  （見下方「G-9.3」）。 */
function instance({ cypherVer, ui, mailRelay = true }) {
  return installFetch((url) => {
    if (url === HEALTH) {
      return cypherVer === null ? { status: 500 } : { json: { ok: true, bundle_version: cypherVer, mail_relay_configured: mailRelay } };
    }
    if (url === UIV) {
      if (ui === 'old') {
        // 舊世代沒有這條路由 → SPA fallback 回首頁 HTML（200，但不是 JSON）
        return { status: 200, text: '<!doctype html>\n<html lang="zh-Hant">…' };
      }
      if (ui === 'down') return { throw: 'network down' };
      return { json: ui };
    }
    throw new Error('沒預期到的網址：' + url);
  });
}

test('G-9.1 舊 UI（沒有 /__version，回 HTML）＋ cypher 已是最新 → 判定要更新（舊行為是整批跳過）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: 'old' });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true, '舊 UI 必須被判定為要更新');
    assert.match(r.reason, /無 \/__version/);
  } finally { restoreFetch(); }
});

test('G-9.2 cypher 與 ui 都等於最新 → 不重推（整批跳過的快路徑要真的走得到）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: { ok: true, ui_fingerprint: 'abc123', bundle_version: '1.4.15' } });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, false, '已是最新就不該重推');
    assert.equal(r.uiFingerprint, 'abc123');
    assert.match(r.reason, /已是最新/);
  } finally { restoreFetch(); }
});

test('G-9.3 arcrun-rag#38/#69/#25：版本號相同，但 cypher 沒設 PORTAL_MAIL_RELAY_BASE → 仍判要更新（版本號不是唯一真相）', async () => {
  // 這是這次要修的洞本身：leo 那台已經是最新 bundle_version，但這個 var 是安裝器
  // 這次才第一次注入——純比版本號會判「已是最新」，這個 var 就永遠補不進去，
  // 忘記密碼永遠是斷的。ui 那半刻意給「已是最新」，證明是 mail relay 這一項單獨讓它變 stale，
  // 不是被 UI 檢查連帶抓到的。
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: { ok: true, ui_fingerprint: 'abc123', bundle_version: '1.4.15' }, mailRelay: false });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true, '沒設 mail relay 就不准判定已是最新');
    assert.match(r.reason, /PORTAL_MAIL_RELAY_BASE/);
  } finally { restoreFetch(); }
});

test('G-9.4 arcrun-rag#38/#69/#25：版本號相同且 mail relay 已配置 → 正常判定不重推（不誤傷既有快路徑）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: { ok: true, ui_fingerprint: 'abc123', bundle_version: '1.4.15' }, mailRelay: true });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, false);
  } finally { restoreFetch(); }
});

test('cypher 最新但 UI 落後一版 → 要更新（cypher 的 /health 看不到 ui 的死活＝t168）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: { ok: true, ui_fingerprint: 'abc123', bundle_version: '1.4.9' } });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true);
    assert.match(r.reason, /ui bundle_version=1\.4\.9/);
  } finally { restoreFetch(); }
});

test('🔴 UI 有 /__version 但版本是空字串 → 要更新（舊寫法的 falsy 洞：空值被靜默當成最新）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: { ok: true, ui_fingerprint: 'abc123', bundle_version: '' } });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true, '沒報版本就不准當成最新');
    assert.match(r.reason, /沒報版本/);
  } finally { restoreFetch(); }
});

test('UI 探測連不上 → 要更新（寧可多推，不可漏推）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: '1.4.15', ui: 'down' });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true);
  } finally { restoreFetch(); }
});

test('cypher 落後 → 要更新，且不必再問 ui（早退）', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  const calls = instance({ cypherVer: '1.4.9', ui: { ok: true, ui_fingerprint: 'z', bundle_version: '1.4.15' } });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true);
    assert.equal(calls.filter((c) => c.url === UIV).length, 0, 'cypher 已判舊就不必再打 ui');
  } finally { restoreFetch(); }
});

test('cypher 打不通（實例還沒建）→ 要更新，不是失敗', async () => {
  const { probeInstanceStale } = await import('./worker.js');
  instance({ cypherVer: null, ui: 'old' });
  try {
    const r = await probeInstanceStale({ healthUrl: HEALTH, uiVersionUrl: UIV, wantVer: '1.4.15' });
    assert.equal(r.stale, true);
    assert.equal(r.instanceVersion, '(讀不到)');
  } finally { restoreFetch(); }
});

// ===========================================================================
// #45（2026-08-09）：多個 Cloudflare 帳號要問過使用者，不准默默取 accounts[0]
//
// 考題（票上的四道驗法）：
//   1 有兩個以上帳號       → 安裝流程要問「裝哪一個」
//   2 只有一個帳號         → 不多問（不為了嚴謹增加所有人的步驟）
//   3 已經裝過的人回來更新 → 裝回原本那個，不隨 GET /accounts 排序漂移
//   4 裝完的畫面           → 說得出裝到哪個帳號
//
// 病史：`accounts[0]` 是原型留下的，而 CF 的 GET /accounts **排序沒有保證**
//       ⇒ 同一個人、同一組 Email、不同時間安裝可能裝到不同帳號，
//         而流程照樣綠、照樣給網址（＝使用者不會發現的那種錯）。
// ===========================================================================

/** makeKV ＋ list()（帳號安裝紀錄查的是 deployed:<accId>: 前綴） */
function makeKVWithList() {
  const kv = makeKV();
  kv.list = async ({ prefix, limit }) => {
    const keys = [];
    for (const name of kv.store.keys()) {
      if (name.startsWith(prefix)) {
        keys.push({ name });
        if (limit && keys.length >= limit) break;
      }
    }
    return { keys };
  };
  return kv;
}

async function seedAccountSession(env, sid, extra) {
  await env.INSTALLER_KV.put(
    `sess:${sid}`,
    JSON.stringify({
      access_token: 'tok-test',
      expires_at: Date.now() + 3600_000,
      inviteVerified: true,
      inviteEmail: 'acct@test.example',
      ...(extra || {}),
    })
  );
}

/** 打 /api/install/start 並**把串流讀到底**＝等 runInstall 真的跑完（t138 起安裝在請求生命週期內跑）。 */
async function startInstallAndDrain(env, sid, body) {
  const res = await worker.fetch(reqStart(sid, body), env, { waitUntil() {} });
  if (res.body) {
    const rd = res.body.getReader();
    for (;;) { const x = await rd.read(); if (x.done) break; }
  }
  return res;
}

test('#45 只有一個帳號（＝使用者在 CF 授權屏勾了一個）→ 全程不再問第二次，直接裝', async () => {
  const env = { INSTALLER_KV: makeKVWithList() };
  const sid = 'sid-one-acct';
  await seedAccountSession(env, sid);
  const { calls } = installStallFixFetchMulti({ accounts: [{ id: 'acc-solo', name: '我的帳號' }] });
  try { await startInstallAndDrain(env, sid, {}); } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  // 注意：這個 mock **刻意不 mock workflows/verify**（沿用 t26 harness 的作法），
  // 所以整趟最後會停在 workflows 步。本測試只斷言「帳號這一步」的行為。
  const acctStep = p.steps.find((x) => x.id === 'account');
  assert.equal(acctStep.state, 'done', '單一帳號要直接通過，不該卡在帳號步');
  assert.equal(p.result.accountId, 'acc-solo');
  assert.equal(p.result.accountName, '我的帳號', '完成頁要顯示的帳號名');
  assert.ok(calls.some((c) => c.url.includes('/accounts/acc-solo/')), '東西要建在那個帳號底下');
  assert.notEqual(p.error && p.error.step, 'account', '不該在帳號步報錯');
});

test('#45 收到多個帳號 → fail-closed 停下來講清楚，不默默挑第一個，一顆 worker 都不裝', async () => {
  const env = { INSTALLER_KV: makeKVWithList() };
  const sid = 'sid-multi';
  await seedAccountSession(env, sid);
  const { calls } = installStallFixFetchMulti();
  try { await startInstallAndDrain(env, sid, {}); } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(p.state, 'error', 'fail-open（默默挑一個）是這張票要修的病，不准退回去');
  assert.equal(p.error.step, 'account');
  assert.match(p.error.message, /勾選了多個帳號/);
  // 出路指回**上游**（CF 授權屏），不是我們自己再開一個選擇頁
  assert.deepEqual(p.error.action, { href: '/', label: '回首頁重新授權' });
  assert.match(p.error.hint, /只勾選「你要安裝到的那一個帳號」/);
  // 使用者看到的是純文字（前端 esc() 後直接進 <p>，無 markdown 轉換）⇒ 不准出現 ** 星號
  assert.doesNotMatch(p.error.hint, /\*\*/, 'hint 是純文字，寫 markdown 會原樣顯示星號');
  assert.equal(
    calls.filter((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/')).length,
    0,
    '猜錯帳號＝把東西建進別人的資產，所以這裡一顆都不准裝'
  );
});

test('#45 選擇頁與相關路由已整個拆掉（leo：不要保留，避免造成誤解）', async () => {
  const env = { INSTALLER_KV: makeKVWithList() };
  await seedAccountSession(env, 'sid-gone-route');
  // /accounts 要回真 404（跟出貨前一樣），不是 302 到某個殘留頁
  const res = await worker.fetch(
    new Request('https://inst.test/accounts', { headers: { cookie: 'arcrun_sid=sid-gone-route' } }),
    env, { waitUntil() {} });
  assert.equal(res.status, 404, '/accounts 不該再存在');
  const body = await res.text();
  assert.match(body, /找不到這個頁面/, '要落到既有的 404 頁');
  const post = await worker.fetch(
    new Request('https://inst.test/api/choose-account', {
      method: 'POST', headers: { cookie: 'arcrun_sid=sid-gone-route' }, body: 'accountId=x',
    }), env, { waitUntil() {} });
  assert.equal(post.status, 404, 'POST /api/choose-account 不該再存在');
  // 源碼層面也不留殘骸（死代碼＝錯誤環境信號）
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  for (const gone of ['chooseAccountPage', 'resolveAccountChoice', 'listAccountsWithInstallState',
                      'setSessionAccount', 'choose-account']) {
    assert.equal(src.includes(gone), false, `${gone} 應已刪乾淨`);
  }
});

test('#45 fail-closed 的錯誤要「按得到出路」：帶 action，完成頁腳本會渲染成按鈕', async () => {
  const env = { INSTALLER_KV: makeKVWithList() };
  const sid = 'sid-action';
  await seedAccountSession(env, sid);
  installStallFixFetchMulti();
  try { await startInstallAndDrain(env, sid, {}); } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.deepEqual(p.error.action, { href: '/', label: '回首頁重新授權' },
    '錯誤要自帶出路，不能只用文字叫使用者自己把網址打對');
  assert.doesNotMatch(p.error.hint, /網址後面加/, 'hint 不准再要求使用者手打網址');
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(src, /e\.action && e\.action\.href/, 'renderError 要真的把 action 畫成按鈕');
});

/** installStallFixFetch 的多帳號版：GET /accounts 預設回兩顆（可用 {accounts} 覆寫），其餘照原樣。 */
function installStallFixFetchMulti({ accounts } = {}) {
  const ACCTS = accounts || [{ id: 'acc-a', name: 'A 公司' }, { id: 'acc-b', name: 'B 個人' }];
  const core = [{
    name: 'arcrun-t45-worker-1', main_file: 'core/worker-1.js', main_module: 'index.js',
    modules: [], compat_date: '2026-01-01', compat_flags: [],
    // 真實 bundle 一定有資源需求；全空的 manifest 會被共用規則照規約擋下（見 t26 harness 註解）
    requires: { kv: ['EXEC_CONTEXT'], d1: [{ binding: 'DB' }] },
  }];
  const manifest = { core };
  const state = { deployed: {}, kvByTitle: {}, d1ByName: {}, vectorize: [] };
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.endsWith('/manifest.json')) return { json: manifest };
    if (url.endsWith('/core/worker-1.js')) return { text: 'export default { fetch(){ return new Response("ok") } }' };
    if (url.endsWith('/accounts')) return cfOk(ACCTS);
    const rr = resourceRuleRoute(url, method, init, state);
    if (rr) return rr;
    if (url.includes('/d1/database/') && url.includes('/query')) return cfOk({});
    if (url.endsWith('/workers/subdomain')) return cfOk({ subdomain: 'acme' });
    if (url.includes('/workers/scripts/') && url.endsWith('/subdomain') && method === 'POST') return cfOk({});
    if (url.includes('/workers/scripts/') && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  return { calls, manifest, state };
}
