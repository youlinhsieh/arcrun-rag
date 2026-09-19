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
import { checkCopy, extractHints, APPROVED_EXITS, OFFSITE_EXIT, PHANTOM_INSTRUCTION,
  // inkstone/Arcrun#196 comment 6144：警告收件人閘（出貨 preflight 跑的是同一份）
  checkWarningAudience, WARNING_AUDIENCE_ALLOWLIST } from './copy-rules.mjs';
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
  ensureWorkersSubdomain,
  subdomainCandidates,
  installWarnings,
  // inkstone/Arcrun#190：等網址生效（判準＝body 是不是 JSON）＋失敗訊息保留 CF 原文
  waitForWorkerLive,
  briefBody,
  // inkstone/Arcrun#191：「已經有了」不是失敗，且判斷不准讀譯文
  ensureVectorizeMetadataIndexes,
  isAlreadyExistsError,
  cfRawMessage,
  translateCfError,
  CF_ERR_NAME_TAKEN,
  // InkStoneCo#132：D1 每日額度撞頂
  cfFetch,
  // inkstone/Arcrun#196：目錄那一半改走實例端點
  seedCredential,
  // inkstone/Arcrun#196 comment 6144：警告的收件人（用戶／我們）分流
  userFacingWarnings,
  internalOnlyWarnings,
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

test('P0-2 MIGRATION_SQL：真 kbdb schema 對真 SQLite 連跑兩次＝冪等（斷點續傳）', async () => {
  // #164：原本這裡斷言「整批 MIGRATION_SQL 連跑兩次不炸」，而真實契約不是那樣。
  //   ① 0007 那三句加欄位（src_id／rel_id／dst_id）在 SQLite **沒有 IF NOT EXISTS 可寫**，
  //      重跑必然丟 duplicate column——就是 2026-08-26 leo 更新時當場撞到的那個錯
  //      （worker.js「--- d. migration」那段註解記著整個經過）。
  //   ② 產品的冪等保證因此長在**套用端**：worker.js 預設整批送，只有撞到 duplicate
  //      column 才退回逐句、逐句容錯。
  //   ⇒ 所以這裡照那條路重跑：逐句套第二次，**只准出現 duplicate column**；
  //      其他任何錯都算迴歸（例如有人新增一句沒帶 IF NOT EXISTS 的建表句）。
  const MIGRATIONS = JSON.parse(await readFile(new URL('./migrations.json', import.meta.url), 'utf8'));
  assert.equal(MIGRATIONS.statements.join(';\n') + ';', MIGRATION_SQL, 'MIGRATION_SQL 應就是 migrations.json 那幾句');

  const db = new DatabaseSync(':memory:');
  const countRows = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c; // kbdb-sql-ok（離線測試對 :memory: SQLite 驗 migration 本身）
  db.exec(MIGRATION_SQL); // kbdb-sql-ok
  const before = { entries: countRows('entries'), templates: countRows('templates') };

  // 重跑（模擬斷點續傳／已跑過 acr update 的實例再裝一次）
  const tolerated = [];
  for (const [i, stmt] of MIGRATIONS.statements.entries()) {
    try {
      db.exec(stmt); // kbdb-sql-ok
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /duplicate column/i, `第 ${i} 句重跑炸了，而 worker.js 只容錯 duplicate column：${msg}`);
      tolerated.push(i);
    }
  }
  assert.equal(tolerated.length, 3, `只該有 0007 那三句加欄位需要容錯，實際 ${tolerated.length} 句`);

  // 冪等的另一半：seed 不得長重複資料（全部 INSERT OR IGNORE）
  assert.equal(countRows('entries'), before.entries, '重跑不得多長 entries');
  assert.equal(countRows('templates'), before.templates, '重跑不得多長 templates');

  // KBDB 只有 entries／templates 兩張核心表——0006 併掉 credentials、0007 把
  // entry_values 收進 entries 的樹模型（migrations.json 第 21／40 句就是那兩句清除）。
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name); // kbdb-sql-ok
  assert.deepEqual(tables, ['entries', 'templates'], `KBDB 只該有兩張核心表，實際 ${tables.join(',')}`);

  // 真 entries 是 kbdb 形（有 entry_type/page_name），不是舊示範形（title/body）
  const cols = db.prepare("SELECT name FROM pragma_table_info('entries')").all().map((r) => r.name); // kbdb-sql-ok
  assert.ok(cols.includes('entry_type') && cols.includes('page_name'), `entries 應為 kbdb 形，got ${cols.join(',')}`);
  assert.ok(!cols.includes('title'), '舊示範欄位 title 不得殘留');
  // 0007 的三元組欄位真的加上去了（那三句就是上面被容錯的那三句）
  for (const c of ['src_id', 'rel_id', 'dst_id']) assert.ok(cols.includes(c), `entries 應含三元組欄位 ${c}`);
  db.close();
});

// ===========================================================================
// P0-3：逾時偵測（背景 waitUntil 被砍 → 狀態頁不空轉）
// ===========================================================================

// 對齊 worker.js 的 `const STALL_MS`（現行 300000＝5 分鐘）。
// #164：這裡曾停在 120000，而產品早已調成 300000 ⇒ 測試佈的「停滯 121 秒」在產品眼裡
// 還算正常 ⇒ 這條紅一整段時間。下面那句 assert 就是不讓它再默默漂掉。
const STALL_MS = 300000;
test('P0-3 STALL_MS 沒漂：測試常數與 worker.js 的定義一致', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const m = src.match(/const STALL_MS\s*=\s*(\d+)/);
  assert.ok(m, 'worker.js 應仍有 STALL_MS 常數');
  assert.equal(Number(m[1]), STALL_MS, `worker.js 的 STALL_MS 是 ${m && m[1]}，測試這邊卻寫 ${STALL_MS}——先對齊再說`);
});

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
// Arcrun#106 另一半：安裝器這條路也要烙 commit（2026-08-16）
// ---------------------------------------------------------------------------
// leo 08-16 實撞：三台實例報同一個版號（1.4.46），而 youlin／geek6688 更新後
// **commit 欄位整個消失**——`acr` 那條烙的印記被安裝器洗掉了。
// ⇒ 版號是貼紙，commit 才是「真的部了哪份碼」；只剩貼紙＝沒有任何方法查它們是不是同一份碼。
// 這幾條守的是「安裝器這條路真的把兩個印記都送上去了」，不是「程式碼裡有那一行」。
// ===========================================================================

import { probeInstanceStale } from './worker.js';

/** 真實 prod bundle 的 manifest.source 格式（實測 1.4.46 ＝ `Arcrun@cacaa33f7d4e`）。 */
const REAL_SOURCE = 'Arcrun@cacaa33f7d4e';

test('#106 安裝器正面：cypher 同時拿到版號與 commit（兩個印記一起烙）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources,
      { ...baseInject, bundleRelease: '1.4.46', bundleBuilt: '2026-08-15', bundleSource: REAL_SOURCE });
    const vars = varsOf(captured());
    assert.equal(vars.ARCRUN_BUNDLE_VERSION, '1.4.46');
    assert.equal(vars.ARCRUN_BUNDLE_COMMIT, 'cacaa33f7d4e',
      '只貼版號＝把「查得出標籤有沒有漂掉」這個能力洗掉（本 issue 的病灶）');
  } finally {
    restoreFetch();
  }
});

test('#106 安裝器正面：portal 前端那顆同樣兩個都拿到（兩顆規則一致，機械閘才守得住）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', { ...baseEntry, name: 'arcrun-rag-ui' }, baseResources,
      { ...baseInject, bundleRelease: '1.4.46', bundleSource: REAL_SOURCE });
    const vars = varsOf(captured());
    assert.equal(vars.ARCRUN_BUNDLE_VERSION, '1.4.46');
    assert.equal(vars.ARCRUN_BUNDLE_COMMIT, 'cacaa33f7d4e');
  } finally {
    restoreFetch();
  }
});

test('#106 反面：manifest 沒有 source（舊 bundle）⇒ 少一個欄位，但安裝照樣走完、版號照貼', async () => {
  // 🔴 這條是紅線：安裝器這條路每個新使用者都會跑到。
  //    「查不到 commit」絕不可以變成「裝不起來」，也絕不可以變成「編一個假的」
  //    （前科：t144 一次安裝用了捏造的 commit 碼，之後每次重裝都被判跳過，永遠治不好）。
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    const r = await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources,
      { ...baseInject, bundleRelease: '1.4.46', bundleBuilt: '2026-08-15' }); // 沒給 bundleSource
    const vars = varsOf(captured());
    assert.equal(vars.ARCRUN_BUNDLE_VERSION, '1.4.46', '版號照貼');
    assert.equal(vars.ARCRUN_BUNDLE_COMMIT, undefined, '沒有就整個欄位不存在');
    assert.equal(r.url, 'https://arcrun-rag-cypher.acme.workers.dev', '安裝流程照樣走完（少一個標籤 ≠ 裝不起來）');
  } finally {
    restoreFetch();
  }
});

test('#106 反面：source 是解不出 sha 的垃圾 ⇒ 一樣不貼（不把垃圾當 commit 烙上去）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', baseEntry, baseResources,
      { ...baseInject, bundleRelease: '1.4.46', bundleSource: 'Arcrun@main' });
    assert.equal(varsOf(captured()).ARCRUN_BUNDLE_COMMIT, undefined);
  } finally {
    restoreFetch();
  }
});

test('#106 其餘零件不烙印記（範圍沒有擴散）', async () => {
  const env = { BUNDLE_BASE: BASE };
  const { captured } = installBundleFetch();
  try {
    await deployBundledWorker(env, 'tok', 'acct-123', { ...baseEntry, name: 'arcrun-kbdb' }, baseResources,
      { ...baseInject, bundleRelease: '1.4.46', bundleSource: REAL_SOURCE });
    const vars = varsOf(captured());
    assert.equal(vars.ARCRUN_BUNDLE_VERSION, undefined);
    assert.equal(vars.ARCRUN_BUNDLE_COMMIT, undefined);
  } finally {
    restoreFetch();
  }
});

// ── 存量怎麼補回來：印記不完整的實例要被判成「舊的」──────────────────────
// 既有三台身上都沒有 commit 欄位。若只比版號，它們**永遠**不會因為「按更新」而重推
// ⇒ 印記永遠補不進去（同 PORTAL_MAIL_RELAY_BASE 那次的形狀，見 probeInstanceStale 註解）。

test('#106 存量：版號一樣但實例沒有 bundle_commit ⇒ 判定重推（印記才補得回去）', async () => {
  const calls = installFetch(async (url) => {
    if (url.endsWith('/health')) return { json: { ok: true, bundle_version: '1.4.46', mail_relay_configured: true } };
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.46' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.46', wantCommit: 'cacaa33f7d4e',
    });
    assert.equal(p.stale, true);
    assert.match(p.reason, /沒有 bundle_commit/);
    assert.ok(calls.length >= 1);
  } finally {
    restoreFetch();
  }
});

test('#106 存量：版號一樣但 commit 不同 ⇒ 重推（「同一個版號」不代表同一份碼）', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.46', bundle_commit: 'd7a98f53a1b2', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.46' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.46', wantCommit: 'cacaa33f7d4e',
    });
    assert.equal(p.stale, true);
    assert.match(p.reason, /不是同一份碼/);
  } finally {
    restoreFetch();
  }
});

test('#106 收斂：commit 對上（acr 烙 40 碼 vs 安裝器 12 碼）⇒ 不再重推，不會變成無窮迴圈', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.46', bundle_commit: 'cacaa33f7d4e0011223344556677889900aabb', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.46' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.46', wantCommit: 'cacaa33f7d4e',
    });
    assert.equal(p.stale, false, '長度不同但同一顆 commit，不該每次都全量重推');
  } finally {
    restoreFetch();
  }
});

test('#106 🔴 舊 bundle（我們自己也貼不出 commit）⇒ 不得因此判 stale（否則永遠重推、永遠治不好）', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/health')) return { json: { ok: true, bundle_version: '1.4.46', mail_relay_configured: true } };
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.46' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.46', wantCommit: '', // manifest 沒有 source
    });
    assert.equal(p.stale, false, '自己都貼不出來卻要求對方有＝t146 那型無窮迴圈');
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

/**
 * 完成頁的**現行契約**是 t79（leo 2026-07-28 原話：「建立你的帳號、下載同步小幫手、
 * 接下來可以做什麼**都是在 portal 做**，安裝到顯示連結就完畢了」）：
 * **完成頁只給網址**（＋這次安裝本身的結果：裝在哪個帳號、版本、技術細節）。
 *
 * #164：原本這兩條測試斷言的是「帳號表單／setup-account 接線／config 下載鈕」都**要在**，
 * 那是 t79 之前的畫面。t76（下載小幫手卡）、t151/t152（MCP 密碼卡）、t75③（config 下載卡）
 * 三次都被 leo 親手拔掉，worker.js 的 renderDone 裡逐條記著日期與原話，而測試沒跟著改
 * ⇒ 它們從那天起就一直紅著。
 *
 * ⇒ 改成守**現在這條線**：該在的要在，被拔掉的三類卡**不准回來**（worker.js 的註解說這是
 *   「同類第 3 次」——正是需要一道機械閘的地方）。
 */
test('t79 完成頁腳本：只給網址（網址卡＋複製鈕＋這次安裝的結果）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const src = await res.text();
  for (const needle of [
    "id=\"inst-url\"",          // 專屬網址本體
    "id=\"copy-btn\"",          // 複製鈕
    '這是你的專屬網址',          // 網址卡文案
    '裝在你的 Cloudflare 帳號：', // #45：裝到哪個帳號要看得見
    '技術細節（給工程師看的）',   // 收合區
  ]) {
    assert.ok(src.includes(needle), `完成頁腳本應含「${needle}」`);
  }
});

test('t79 🔴 紅線：完成頁不准再長出「之後才要做的事」那類卡（帳號表單／小幫手 config／MCP 密碼）', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const res = await worker.fetch(new Request('https://inst.test/install.js'), env, { waitUntil() {} });
  const src = await res.text();
  // 只挑「真的是程式碼才會出現」的識別字：worker.js 在 template literal 裡留了大量說明註解，
  // 光看中文標題會被註解本身命中（例如「建立你的帳號」就寫在 t79 那段引述 leo 的原話裡）。
  for (const forbidden of [
    '/api/setup-account',   // 帳號表單的後端接線（帳號在 portal 建）
    'acct-pass',            // 密碼欄 id
    'cfg-nickname',         // config 下載卡的暱稱欄 id
    'cfg.instance_name',    // config 組裝
    'watch_folders',        // config 內容鍵（現在由桌面 App 自己寫）
    'mcpOwnerSecret',       // t152 拔掉的 MCP 密碼卡
  ]) {
    assert.ok(!src.includes(forbidden),
      `完成頁不該再出現「${forbidden}」——t79：那些都在 portal／桌面 App 做，安裝到顯示連結就完畢`);
  }
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
// #164：這一組測試的前提是「顆數比一輪的預算多 ⇒ 這輪會停下接力」。
// 原本寫死 coreCount:5、標題寫「3 顆/輪」，而 worker.js 的 DEPLOY_BUDGET_PER_RUN
// 早已從 3 調成 6 ⇒ 5 顆一輪就全裝完、根本不會 pause，於是往下走到 workflows 步驟
// （fixture 沒 mock，落 404）才死成 error ⇒ 這兩條長期紅著。
// ⇒ 改成**從 worker.js 讀那個數字**，往後產品再調預算，測試自己跟上、不會再漂。
const DEPLOY_BUDGET_PER_RUN = Number(
  (await readFile(new URL('./worker.js', import.meta.url), 'utf8'))
    .match(/const DEPLOY_BUDGET_PER_RUN\s*=\s*(\d+)/)[1]
);
assert.ok(DEPLOY_BUDGET_PER_RUN >= 1, 'worker.js 應有 DEPLOY_BUDGET_PER_RUN 常數');

function installStallFixFetch({ coreCount = DEPLOY_BUDGET_PER_RUN + 2 } = {}) {
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

/**
 * 「這通呼叫是不是在部署一顆 worker」。
 * #164：原本只看 `includes('/workers/scripts/')`，**同一批裡的 `.../secrets` 也是 PUT**
 * ⇒ deploy 收尾後的金鑰同步那 4 通會被算成「又部署了 4 顆」。改成只認「路徑到 script 名為止」。
 */
const isScriptDeployPut = (c) => c.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(c.url);

/** manifest 的第 1..n 顆合成 worker 名（順序＝部署順序）。 */
const t26Names = (n) => Array.from({ length: n }, (_, i) => `arcrun-t26-worker-${i + 1}`);
const T26_CORE = DEPLOY_BUDGET_PER_RUN + 2; // 保證跨兩輪：第一輪吃滿預算，第二輪收尾 2 顆

test(`t26 分批接力：deploy 預算耗盡（${DEPLOY_BUDGET_PER_RUN} 顆/輪）→ paused_continue（不是失敗），deployedNames 記正確游標`, async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-budget';
  await seedInstallSession(env, sid, 'budget@test.example');
  const { calls } = installStallFixFetch({ coreCount: T26_CORE });
  try {
    await startInstallAndDrain(env, sid, {});
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.state, 'paused_continue',
    `${T26_CORE} 顆、預算 ${DEPLOY_BUDGET_PER_RUN} 顆/輪，這輪應停下接力，不是判失敗`);
  assert.deepEqual(progress.result.deployedNames, t26Names(DEPLOY_BUDGET_PER_RUN),
    `應剛好裝了 ${DEPLOY_BUDGET_PER_RUN} 顆，順序照 manifest`);
  const deployPuts = calls.filter(isScriptDeployPut);
  assert.equal(deployPuts.length, DEPLOY_BUDGET_PER_RUN,
    `這一輪只該部署 ${DEPLOY_BUDGET_PER_RUN} 顆，不是全部 ${T26_CORE} 顆`);
});

test(`t26 分批接力：接力續跑跳過已部署清單、從第 ${DEPLOY_BUDGET_PER_RUN + 1} 顆接著裝，且不重打帳號/KV/D1/schema`, async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-resume';
  await seedInstallSession(env, sid, 'resume@test.example');

  installStallFixFetch({ coreCount: T26_CORE });
  try {
    await startInstallAndDrain(env, sid, {}); // 第一輪：吃滿預算後 paused_continue
  } finally {
    restoreFetch();
  }
  let progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.state, 'paused_continue');
  assert.equal(progress.result.deployedNames.length, DEPLOY_BUDGET_PER_RUN);

  const { calls: calls2 } = installStallFixFetch({ coreCount: T26_CORE });
  try {
    // 前端偵測到 paused_continue 會自動再 POST 一次（restart 不帶／false），對齊 install.js 的 continueInstall()
    await startInstallAndDrain(env, sid, { restart: false });
  } finally {
    restoreFetch();
  }
  progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.deepEqual(progress.result.deployedNames, t26Names(T26_CORE),
    `${T26_CORE} 顆全部裝完、順序正確、無重複`);
  assert.equal(progress.steps.find((s) => s.id === 'deploy').state, 'done');

  // 接力這輪不該重打帳號/D1（已 done 的前置步驟）——省下的額度留給 deploy 迴圈
  assert.equal(calls2.filter((c) => c.url.endsWith('/accounts')).length, 0, '接力續跑不該重打 /accounts');
  assert.equal(
    calls2.filter((c) => c.url.includes('/d1/database') && !c.url.includes('/query')).length,
    0,
    '接力續跑不該重建/重查 D1'
  );
  // 只該新部署第一輪沒裝到的那幾顆（已裝過的不重複打 PUT）
  const putUrls = calls2
    .filter(isScriptDeployPut)
    .map((c) => c.url);
  const tail = t26Names(T26_CORE).slice(DEPLOY_BUDGET_PER_RUN); // 第一輪沒裝到的那幾顆
  assert.equal(putUrls.length, tail.length, `接力這輪只該新部署 ${tail.length} 顆`);
  // `worker-1` 是 `worker-10` 的前綴 ⇒ 用「數字後面不能再接數字」界定，預算調大也不會誤判
  assert.ok(putUrls.every((u) => tail.some((n) => new RegExp(n + '(?![0-9])').test(u))),
    `不該重複部署前 ${DEPLOY_BUDGET_PER_RUN} 顆`);
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

test('t26 實例身分：email 存進安裝結果，供 portal／桌面 App 那端取用（不是完成頁自己組 config）', async () => {
  // #164：這條原本斷言完成頁有「暱稱欄＋config 下載」——t75③ 已隨 t79 把那張卡整個拔掉
  //   （config.json 現在由桌面 App 自己寫，見 collector 的 direct config 測試）。
  //   真正還活著、而且下游真的在用的那一半是**後端把 email 存進 progress.result**
  //   ——上一條測試（t26 runInstall：progress.result.email）守的就是它。
  //   這裡守的是另一半：這個值**必須來自安裝器已驗證的 session**，不是前端傳進來的。
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-identity';
  await seedInstallSession(env, sid, 'Real.User@example.com');
  installStallFixFetch({ coreCount: 1 });
  try {
    // 前端刻意謊報一個 email：後端不該採信
    await startInstallAndDrain(env, sid, { email: 'attacker@evil.example' });
  } finally {
    restoreFetch();
  }
  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(progress.result.email, 'Real.User@example.com',
    'email 必須取自已驗證的 session，不得被前端送來的值蓋過');
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

/** 從安裝器實際會種的那份 skills.json 取「這支 skill 的現行全文」，給假物件當庫裡的既有內容。 */
const SKILLS_FIXTURE = JSON.parse(await readFile(new URL('./skills.json', import.meta.url), 'utf8'));
const skillBySlug = (url) => {
  const m = decodeURIComponent(url).match(/page_name=skill-([^&]+)/);
  return m ? SKILLS_FIXTURE.find((s) => s.slug === m[1]) : null;
};

test('skills：已種過（內容一致）→ 全部 existed、零寫入（冪等，重裝不長重複資料）', async () => {
  // #164：這條原本讓探測回 `{ id: 'e_1' }`——**沒有 content**。
  //   而 seedSkillsTo 現在會比對內容（「內容一致＝不用動；不一致＝上個世代，PATCH 成現行版本」）
  //   ⇒ 空 content ≠ skill 全文 ⇒ 每支都走 PATCH ⇒ 假物件回 500 ⇒ existed 是 0、errors 是 7。
  //   假物件沒跟上那個功能，不是產品壞掉。這裡把「已種過」佈成真的已種過：內容就是現行全文。
  const calls = installFetch((url) => {
    if (url.includes('/kbdb/entries?')) {
      const s = skillBySlug(url);
      return { json: { success: true, entries: s ? [{ id: `e_${s.slug}`, content: s.content }] : [] } };
    }
    return { status: 500, json: { error: '內容一致就不該有任何寫入' } };
  });
  let sk;
  try {
    sk = await seedSkillsTo('https://cypher.test', 'ns-1');
  } finally {
    restoreFetch();
  }
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '已存在不得再 POST');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, '內容一致不得 PATCH');
  assert.equal(sk.created.length, 0);
  assert.equal(sk.updated.length, 0);
  assert.ok(sk.existed.length >= 7, `每支都該判成 existed（實際 ${sk.existed.length}）`);
  assert.equal(sk.errors.length, 0);
});

test('skills：庫裡是上個世代的內容 → PATCH 成現行版本（updated，不是再 POST 一份）', async () => {
  // #164 補上：上一條佈的是「內容一致」那半，這條佈「內容不一致」那半——
  // 兩條合起來才涵蓋 seedSkillsTo 的完整分支，假物件下次再漂就會被抓到。
  const calls = installFetch((url, init) => {
    if (url.includes('/kbdb/entries?')) {
      const s = skillBySlug(url);
      return { json: { success: true, entries: s ? [{ id: `e_${s.slug}`, content: '上個世代的舊全文' }] : [] } };
    }
    if ((init.method || 'GET').toUpperCase() === 'PATCH') return { json: { success: true } };
    return { status: 500, json: { error: '已存在就不該 POST 新的一份' } };
  });
  let sk;
  try {
    sk = await seedSkillsTo('https://cypher.test', 'ns-1');
  } finally {
    restoreFetch();
  }
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '既有 entry 該被更新，不是再長一份');
  assert.ok(sk.updated.length >= 7, `每支都該被 PATCH 成現行版本（實際 ${sk.updated.length}）`);
  assert.equal(sk.existed.length, 0);
  assert.equal(sk.errors.length, 0);
  // PATCH 打的是那一筆的 id，body 帶現行全文
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.match(patches[0].url, /\/kbdb\/entries\/e_/);
  assert.ok(JSON.parse(patches[0].body).content.length > 100, 'PATCH 應帶 md 全文');
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

// ===========================================================================
// Arcrun#157：「沒變就別重裝」被一個布林廢掉——把「舊」分級
// ---------------------------------------------------------------------------
// leo 2026-08-26：「為什麼每次都重裝 23 個，應該裝過不會再動？」
//
// 病根不是「有一顆卡住」，是 probeInstanceStale 只回一格布林，而呼叫端拿它當總開關：
//   ARCRUN_BUNDLE_VERSION 是**部署時貼的 var，不是內容的函數** ⇒ 每次發版必變
//   ⇒ stale 每次發版必為真 ⇒ 逐顆 sha256 跳過**永遠不會生效**（人只在發版時按更新）。
// 實測 1.4.54 → 1.4.55：23 顆裡只有 arcrun-kbdb 的 sha 變了，其餘 22 顆全被白推一次。
//
// 🔴 這幾條同時守住紅線：**instanceStale 沒有被關掉**。
//    cypher 是印記載體 ⇒ 版號一落後它一定被重推 ⇒ t146（cypher 永遠裝不到、
//    triplet seed 永遠種不進去）不會復活。守法＝下面「印記載體一定重推」那兩條。
// ===========================================================================

import { canSkipWorker } from './worker.js';

const SEEN = 'aaaa1111'; // 帳本記著的 sha＝manifest 這次的 sha（內容沒變）

test('#157 每次發版都會走到的那一格：版號落後 ⇒ scope=stamp（不是全部重推）', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.54', bundle_commit: 'd60cd1258f43', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.54' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.55', wantCommit: 'd60cd1258f43',
    });
    assert.equal(p.stale, true, '確實是舊的（這一格語意不變）');
    assert.equal(p.scope, 'stamp', '只有標籤落後＝重推印記載體就補得回來，不該連累另外 20 顆');
  } finally {
    restoreFetch();
  }
});

test('#157 leo 08-26 實撞：cypher 1.4.55 / ui 1.4.54 ⇒ scope=stamp', async () => {
  // youlin 實測。成因是 `acr update` 只部 23 顆不含 ui（本票缺口②）⇒ 兩個印記走岔。
  // ui 的 bytes 其實是對的（ui_fingerprint 2d331d41… ＝ bundle 內嵌常數），落後的只有標籤。
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.55', bundle_commit: 'd60cd1258f43', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) {
      return { json: { ok: true, ui_fingerprint: '2d331d41223782ff', bundle_version: '1.4.54' } };
    }
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.55', wantCommit: 'd60cd1258f43',
    });
    assert.equal(p.stale, true);
    assert.equal(p.scope, 'stamp');
    assert.match(p.reason, /ui bundle_version=1\.4\.54/);
  } finally {
    restoreFetch();
  }
});

test('#157 🔴 紅線：commit 對不上 ⇒ scope=all（帳本整份不可信，不准只補印記）', async () => {
  // 跑的不是我們以為的那份碼 ⇒ prevSha 對每一顆都失去可信度。
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.55', bundle_commit: 'd7a98f53a1b2', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.55' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.55', wantCommit: 'd60cd1258f43',
    });
    assert.equal(p.scope, 'all', '版號一樣但不是同一份碼＝連帳本都不能信');
  } finally {
    restoreFetch();
  }
});

test('#157 🔴 紅線：探測不通 ⇒ scope=all（fail-stale 沒有被放寬）', async () => {
  installFetch(async () => ({ throw: '連不上' }));
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version', wantVer: '1.4.55',
    });
    assert.equal(p.scope, 'all');
  } finally {
    restoreFetch();
  }
});

test('#157 對得上 ⇒ scope=none', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/health')) {
      return { json: { ok: true, bundle_version: '1.4.55', bundle_commit: 'd60cd1258f43', mail_relay_configured: true } };
    }
    if (url.endsWith('/__version')) return { json: { ok: true, ui_fingerprint: 'fp', bundle_version: '1.4.55' } };
    throw new Error('未預期的 URL：' + url);
  });
  try {
    const p = await probeInstanceStale({
      healthUrl: 'https://c.test/health', uiVersionUrl: 'https://u.test/__version',
      wantVer: '1.4.55', wantCommit: 'd60cd1258f43',
    });
    assert.equal(p.stale, false);
    assert.equal(p.scope, 'none');
  } finally {
    restoreFetch();
  }
});

// ── canSkipWorker：這一顆這次到底推不推 ────────────────────────────────────

test('#157 正身：scope=stamp 時，內容沒變的一般零件**真的被略過**', () => {
  // 這就是 leo 問的「裝過不會再動」。以前這裡是 false（全部重推）。
  assert.equal(canSkipWorker({ name: 'arcrun-string-ops', entrySha: SEEN, prevSha: SEEN, scope: 'stamp' }), true);
  assert.equal(canSkipWorker({ name: 'arcrun-http-request', entrySha: SEEN, prevSha: SEEN, scope: 'stamp' }), true);
});

test('#157 🔴 紅線：scope=stamp 時，印記載體**一定重推**（t146 的保險沒被關掉）', () => {
  // cypher 不重推 ⇒ 版號永遠補不上、triplet seed 永遠種不進去（t146 那次事故）。
  assert.equal(canSkipWorker({ name: 'arcrun-cypher-executor', entrySha: SEEN, prevSha: SEEN, scope: 'stamp' }), false);
  assert.equal(canSkipWorker({ name: 'arcrun-rag-ui', entrySha: SEEN, prevSha: SEEN, scope: 'stamp' }), false);
});

test('#157 🔴 紅線：scope=all 時，一顆都不准略過', () => {
  assert.equal(canSkipWorker({ name: 'arcrun-string-ops', entrySha: SEEN, prevSha: SEEN, scope: 'all' }), false);
  assert.equal(canSkipWorker({ name: 'arcrun-cypher-executor', entrySha: SEEN, prevSha: SEEN, scope: 'all' }), false);
});

test('#157 內容真的變了 ⇒ 一律重推（不管 scope）', () => {
  for (const scope of ['none', 'stamp', 'all']) {
    assert.equal(canSkipWorker({ name: 'arcrun-kbdb', entrySha: 'bbbb2222', prevSha: SEEN, scope }), false,
      `scope=${scope} 時 sha 變了還略過＝把新版擋在門外`);
  }
});

test('#157 帳本沒記過這顆／manifest 沒給 sha ⇒ 沒有「沒變」的證據，只能推', () => {
  assert.equal(canSkipWorker({ name: 'arcrun-set', entrySha: SEEN, prevSha: '', scope: 'none' }), false);
  assert.equal(canSkipWorker({ name: 'arcrun-set', entrySha: '', prevSha: SEEN, scope: 'none' }), false);
});

test('#157 收斂：scope=none 且內容沒變 ⇒ 略過（同一版再跑一次不該全推）', () => {
  assert.equal(canSkipWorker({ name: 'arcrun-cypher-executor', entrySha: SEEN, prevSha: SEEN, scope: 'none' }), true);
  assert.equal(canSkipWorker({ name: 'arcrun-string-ops', entrySha: SEEN, prevSha: SEEN, scope: 'none' }), true);
});

test('#157 實測數字：1.4.54→1.4.55 只有 1 顆內容變 ⇒ 從 23 顆降到 3 顆', () => {
  // 真實 manifest 差異（本票留證）：只有 arcrun-kbdb 的 sha256 變了，其餘 22 顆一致。
  const names = [
    'arcrun-array-ops', 'arcrun-auth-oauth2', 'arcrun-auth-service-account', 'arcrun-auth-static-key',
    'arcrun-code', 'arcrun-cron', 'arcrun-cypher-executor', 'arcrun-date-ops', 'arcrun-filter',
    'arcrun-foreach-control', 'arcrun-http-request', 'arcrun-if-control', 'arcrun-kbdb', 'arcrun-mcp',
    'arcrun-merge', 'arcrun-number-ops', 'arcrun-rag-ui', 'arcrun-set', 'arcrun-string-ops',
    'arcrun-switch', 'arcrun-try-catch', 'arcrun-validate-json', 'arcrun-wait',
  ];
  assert.equal(names.length, 23);
  const pushed = names.filter((name) => !canSkipWorker({
    name,
    entrySha: name === 'arcrun-kbdb' ? 'CHANGED' : SEEN, // 只有這顆內容變了
    prevSha: SEEN,
    scope: 'stamp',                                       // 版號 1.4.54 → 1.4.55
  }));
  assert.deepEqual(pushed.sort(), ['arcrun-cypher-executor', 'arcrun-kbdb', 'arcrun-rag-ui'],
    '該推的只有「內容變了的那顆」＋「兩顆印記載體」');
  assert.equal(pushed.length, 3, 'leo 問的「為什麼每次都重裝 23 個」＝這裡從 23 變 3');
});

// ═══════════════════════════════════════════════════════════════════════════
// inkstone/Arcrun#190 — 乾淨帳號按下安裝就要一路裝完
//
// 症狀（2026-08-31 真實用戶，leo 拍照）：從沒開通過 workers.dev 的帳號卡在第 5 步，
// 畫面叫他去 Cloudflare 後台自己設一個子網域再回來按重新安裝。
//
// 🔴 leo 當場定調：**「叫用戶自己去開通是完全不准的」**——
//    安裝流程裡不存在「請你去某處做某事，再回來按重新安裝」這種出口。
//
// 這一組測試守三件事：① 沒有就我們自己開 ② 錯誤訊息說的是真話 ③ 不准再長出那種出口。
// ═══════════════════════════════════════════════════════════════════════════

/** CF 的失敗回應（帶 error code）。CF 用 error code 表達「可不可以註冊」，成功也常常是 error。 */
const cfErr = (status, code, message) => ({
  status,
  json: { success: false, result: null, errors: [{ code, message: message || 'err' }] },
});

const SUB_GET = /\/accounts\/[^/]+\/workers\/subdomain$/;
const SUB_CHECK = /\/accounts\/[^/]+\/workers\/subdomains\/([^/]+)$/;

test('inkstone/Arcrun#190 名字怎麼來的：同一個 email 永遠算出同一個名字，且不含個資', () => {
  const a = subdomainCandidates('k3m9p2qd');
  const b = subdomainCandidates('k3m9p2qd');
  assert.equal(a[0], 'arcrun-k3m9p2qd', '第一順位＝arcrun- ＋ 這次安裝其他資源用的同一組短碼');
  assert.equal(a[0], b[0], '同一個 email 重裝要收斂到同一個名字（不然每次重裝都留一個垃圾子網域）');
  assert.ok(a.length >= 2, '撞名要有備選');
  assert.equal(new Set(a).size, a.length, '備選不可重複');
  for (const n of a) {
    assert.ok(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n), `${n} 必須合法（wrangler 同一條規則）`);
    assert.ok(n.length <= 63, `${n} 不可超過 63 字`);
  }
});

test('inkstone/Arcrun#190 帳號本來就有子網域 → 直接用，一次都不准去動用戶的帳號設定', async () => {
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfOk({ subdomain: 'existing-one' });
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  try {
    const r = await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
    assert.equal(r.subdomain, 'existing-one');
    assert.equal(r.created, false, '沿用既有的，不是我們開的');
  } finally { restoreFetch(); }
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0,
    '🔴 已經有子網域的帳號，絕對不可以打 PUT（那會動到用戶帳號上改不回來的設定）');
});

test('inkstone/Arcrun#190 乾淨帳號（GET 回 10007）→ 我們自己開通，而且是**開之前**先告訴用戶名字', async () => {
  const announced = [];
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'workers.dev subdomain not found');
    if (SUB_CHECK.test(url)) return cfErr(404, 10032, 'subdomain available');
    if (SUB_GET.test(url) && method === 'PUT') return cfOk({ subdomain: 'arcrun-k3m9p2qd' });
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let r;
  try {
    r = await ensureWorkersSubdomain('tok', 'acct-1', {
      suffix: 'k3m9p2qd',
      announce: async (name) => {
        // 這一刻 PUT 還沒被打出去——這就是紅線「開之前讓用戶知道」的機械證明
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 0,
          '🔴 announce 必須發生在 PUT 之前，否則用戶是**事後**才知道名字，而那時已經改不回來了');
        announced.push(name);
      },
    });
  } finally { restoreFetch(); }
  assert.equal(r.subdomain, 'arcrun-k3m9p2qd');
  assert.equal(r.created, true);
  assert.deepEqual(announced, ['arcrun-k3m9p2qd'], '要告知，而且告知的就是真的被註冊的那個名字');

  const put = calls.find((c) => c.method === 'PUT' && SUB_GET.test(c.url));
  assert.ok(put, '🔴 這就是這張票缺的那個動作：PUT /accounts/{id}/workers/subdomain');
  assert.deepEqual(JSON.parse(put.body), { subdomain: 'arcrun-k3m9p2qd' });
});

test('inkstone/Arcrun#190 第一順位名字被占用（10031）→ 自動換備選，不打擾用戶', async () => {
  const tried = [];
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'not found');
    const m = url.match(SUB_CHECK);
    if (m) {
      tried.push(m[1]);
      // 🔴 403（不是 409）——2026-09-01 對真的 Cloudflare 量到的：被占用的名字回
      //    `HTTP 403 code 10031`，跟「我們沒權限」撞同一個 status。
      //    這份替身本來寫 409（猜的），於是把「先看 status 再看 code」那個會讓
      //    安裝當場中止的順序問題整個藏了起來——離線測試全綠，真用戶第一個名字撞名就掛。
      return m[1] === 'arcrun-k3m9p2qd'
        ? cfErr(403, 10031, "Subdomain 'arcrun-k3m9p2qd' is unavailable. Please try a different one.")
        : cfErr(404, 10032, 'subdomain available');
    }
    if (SUB_GET.test(url) && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let r;
  try {
    r = await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd', rand: (i) => 'r' + i });
  } finally { restoreFetch(); }
  assert.equal(r.created, true);
  assert.notEqual(r.subdomain, 'arcrun-k3m9p2qd', '被占用的那個不能用');
  assert.ok(r.subdomain.startsWith('arcrun-k3m9p2qd-'), '備選只在身分段後面加隨機碼，不換身分');
  assert.deepEqual(tried.slice(0, 2), ['arcrun-k3m9p2qd', 'arcrun-k3m9p2qd-r1']);
  // 被占用的那個名字絕不能被 PUT 出去
  const puts = calls.filter((c) => c.method === 'PUT' && SUB_GET.test(c.url));
  assert.equal(puts.length, 1, '只該註冊一次');
  assert.equal(JSON.parse(puts[0].body).subdomain, r.subdomain);
});

for (const [status, code, why] of [[403, 10000, '權限不足'], [401, 10000, '授權過期']]) {
  test(`inkstone/Arcrun#190 GET 回 ${status}（${why}）→ 說真話，不准講成「你還沒開通」，也不准亂 PUT`, async () => {
    const calls = installFetch((url, init) => {
      const method = (init.method || 'GET').toUpperCase();
      if (SUB_GET.test(url) && method === 'GET') return cfErr(status, code, 'Authentication error');
      return { status: 404, json: { error: `unhandled ${method} ${url}` } };
    });
    let err = null;
    try {
      await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
    } catch (e) { err = e; } finally { restoreFetch(); }

    assert.ok(err, '不可以吞掉');
    // 這就是病根：舊寫法 `.catch(() => null)` 讓 401/403 跟「沒設過」長得一模一樣
    assert.ok(!/還沒開通|還沒有.*專屬網址/.test(err.message),
      `🔴 ${status} 是**我們這邊**的問題，不准改口講成用戶沒設定：實際訊息「${err.message}」`);
    assert.equal(err.status, status, '事後要追得到 HTTP status（舊寫法連 status 都沒留）');
    assert.ok(/授權/.test(err.message), `應該講授權的事，實際「${err.message}」`);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0,
      '讀不到不代表沒有——沒權限讀的時候亂 PUT 可能覆蓋掉用戶已經有的子網域');
  });
}

test('inkstone/Arcrun#190 備選名字全被占用 → 錯誤訊息只講「我們這邊怎麼了」，不准叫用戶去任何地方', async () => {
  installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'not found');
    if (SUB_CHECK.test(url)) return cfErr(403, 10031, 'Subdomain is unavailable. Please try a different one.'); // 實測 status＝403
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let err = null;
  try {
    await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
  } catch (e) { err = e; } finally { restoreFetch(); }

  assert.ok(err);
  const say = `${err.message}\n${err.hint || ''}`;
  // 🔴 leo 2026-08-31：「叫用戶自己去開通是完全不准的」，連帶 accountId 的直達連結也不行
  assert.ok(!/dash\.cloudflare\.com|後台|onboarding|自己(去|設)/.test(say),
    `🔴 不准出現「你去 Cloudflare 後台做某事」的出口：實際「${say}」`);
  assert.ok(/我們/.test(say), '要講清楚這是我們這邊的問題');
  assert.ok(/重新安裝/.test(say), '出路要是我們自己的按鈕，不是別人家的頁面');
  assert.ok(/subdomain registration exhausted/.test(err.detail || ''), '事後追得到（含每一步的 status/code）');
});

// --- 實打 Cloudflare 量到的契約（2026-09-01，youlin stage 帳號 1129efd7…）-------------
//
// 🔴 這一段的每一組 status/code 都是**真的打過 Cloudflare** 拿回來的，不是猜的。
//    本票驗收條件寫「實打才算數」，而先前這份替身全是推測值 ⇒ 測試全綠但產品會掛。
//    量測指令與原始回應留在 installer/oauth-prototype/cf-subdomain-contract.md。

test('inkstone/Arcrun#190 實測契約：名字被占用是 403+10031（與「沒權限」同 status）→ 必須換備選，不准中止安裝', async () => {
  const tried = [];
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'workers.dev subdomain not found');
    const m = url.match(SUB_CHECK);
    if (m) {
      tried.push(m[1]);
      // 真 CF 的回法：被占用 → 403 code 10031（實測 uncle6-me／test／demo 全是這組）
      return m[1] === 'arcrun-k3m9p2qd'
        ? cfErr(403, 10031, "Subdomain 'arcrun-k3m9p2qd' is unavailable. Please try a different one.")
        : cfErr(404, 10032, 'subdomain available');
    }
    if (SUB_GET.test(url) && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let r = null; let err = null;
  try {
    r = await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd', rand: (i) => 'r' + i });
  } catch (e) { err = e; } finally { restoreFetch(); }

  // 🔴 這就是「先看 status 再看 code」會炸掉的那一格：第一順位撞名 ⇒ 安裝整個中止，
  //    而且對用戶說的是「我們的授權範圍不夠」——一句假話。
  assert.equal(err, null, `撞名不可以中止安裝，實際丟了：${err && err.message}`);
  assert.ok(r.created, '要真的幫他開起來');
  assert.equal(r.subdomain, 'arcrun-k3m9p2qd-r1', '跳過撞名的，用下一個備選');
  assert.deepEqual(tried.slice(0, 2), ['arcrun-k3m9p2qd', 'arcrun-k3m9p2qd-r1']);
  const puts = calls.filter((c) => c.method === 'PUT' && SUB_GET.test(c.url));
  assert.equal(puts.length, 1, '只該註冊一次');
  assert.equal(JSON.parse(puts[0].body).subdomain, 'arcrun-k3m9p2qd-r1');
});

test('inkstone/Arcrun#190 實測契約：預檢回 403 但不是 10031／10032 → 那才是真的授權問題，照樣往上拋', async () => {
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'not found');
    if (SUB_CHECK.test(url)) return cfErr(403, 10000, 'Authentication error');
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let err = null;
  try {
    await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
  } catch (e) { err = e; } finally { restoreFetch(); }

  assert.ok(err, '真的沒權限就不可以吞掉');
  assert.equal(err.status, 403);
  assert.ok(/授權/.test(err.message), `應該講授權的事，實際「${err && err.message}」`);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0,
    '🔴 授權有問題時不准硬 PUT——那可能覆蓋掉用戶已經有的子網域');
});

test('inkstone/Arcrun#190 實測契約：PUT 回 409+10036（帳號中途已經有了）→ 重讀來用，不准報失敗', async () => {
  // 真 CF 實測：對已經有子網域的帳號 PUT → HTTP 409 code 10036
  //   {"code":10036,"message":"Account already has an associated subdomain."}
  // 情境：GET 那一刻還沒有（或讀到舊快取），PUT 之前用戶自己在後台開了／另一個分頁先裝好了。
  // 這時候帳號其實是好的，報「開通失敗」等於對用戶說假話。
  let getCount = 0;
  installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') {
      getCount++;
      return getCount === 1
        ? cfErr(404, 10007, 'workers.dev subdomain not found')
        : cfOk({ subdomain: 'somebody-beat-us' }); // 重讀：其實已經有了
    }
    if (SUB_CHECK.test(url)) return cfErr(404, 10032, 'subdomain available');
    if (SUB_GET.test(url) && method === 'PUT') return cfErr(409, 10036, 'Account already has an associated subdomain.');
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  let r = null; let err = null;
  try {
    r = await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
  } catch (e) { err = e; } finally { restoreFetch(); }

  assert.equal(err, null, `帳號其實已經好了，不可以報失敗：${err && err.message}`);
  assert.equal(r.subdomain, 'somebody-beat-us', '要用帳號上真的那一個，不是我們想取的名字');
  assert.equal(r.created, false, '不是我們開的就不要說是我們開的（完成頁那句話會照著寫）');
  assert.match(r.trail.join('\n'), /10036/, '事後追得到到底發生什麼事');
});

test('inkstone/Arcrun#190 處理過程留痕：每一步的 HTTP status 與 CF code 都要在 trail 裡', async () => {
  installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (SUB_GET.test(url) && method === 'GET') return cfErr(404, 10007, 'not found');
    if (SUB_CHECK.test(url)) return cfErr(404, 10032, 'available');
    if (SUB_GET.test(url) && method === 'PUT') return cfOk({});
    return { status: 404, json: {} };
  });
  let r;
  try {
    r = await ensureWorkersSubdomain('tok', 'acct-1', { suffix: 'k3m9p2qd' });
  } finally { restoreFetch(); }
  const trail = r.trail.join('\n');
  // 舊寫法全程只留一句 'GET /workers/subdomain returned no subdomain'——連 status 都沒有
  assert.match(trail, /HTTP 404 code=10007/, 'GET 那一步的 status 與 code 要留著');
  assert.match(trail, /開通成功/, 'PUT 的結果要留著');
});

// --- 靜默降級可見化（inkstone/Arcrun#190 目的三；全面清查是子票 Arcrun#191）--------------

test('inkstone/Arcrun#190 靜默降級：被吞掉卻影響用戶拿到什麼的警告，一定要變成看得見的東西', () => {
  assert.deepEqual(installWarnings({}), [], '沒事就不要嚇用戶');

  const w = installWarnings({
    vectorizeWarning: 'index quota exceeded',
    vectorizeMetadataWarning: 'metadata index failed',
    routeWarnings: ['arcrun-kbdb：權限不足（HTTP 403）'],
    healthWarning: 'health 500',
  });
  assert.equal(w.length, 4, '四種靜默降級都要被看見');
  for (const item of w) {
    assert.ok(item.title && item.body, '每一條都要有給人看的標題與說明');
    // 用戶語言：不准把 CF 的原文當成給用戶看的話（原文放 detail）
    assert.ok(!/vectorize|index|HTTP/i.test(item.title), `標題要是人話：「${item.title}」`);
  }
  assert.match(w[0].title, /語意搜尋/, '「語意搜尋永遠零命中」是用戶真的少拿到的東西，要講出來');
  assert.match(w[0].detail, /quota/, '技術原文留在 detail 給回報用');
});

// --- 端到端：乾淨帳號實走（離線模擬）-------------------------------------

/** installStallFixFetch 的乾淨帳號版：這個帳號從沒註冊過 workers.dev 子網域。 */
function cleanAccountInstallFetch() {
  const core = [{
    name: 'arcrun-clean-1',
    main_file: 'core/worker-1.js',
    main_module: 'index.js',
    modules: [],
    compat_date: '2026-01-01',
    compat_flags: [],
    requires: { kv: ['EXEC_CONTEXT'], d1: [{ binding: 'DB' }] },
  }];
  const manifest = { core };
  const state = { deployed: {}, kvByTitle: {}, d1ByName: {}, vectorize: [] };
  let registered = null; // 這個帳號的子網域，一開始沒有
  const calls = installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.endsWith('/manifest.json')) return { json: manifest };
    if (core.some((c) => url.endsWith('/' + c.main_file))) {
      return { text: 'export default { fetch(){ return new Response("ok") } }' };
    }
    if (url.endsWith('/accounts')) return cfOk([{ id: 'acct-1', name: 'Clean Acct' }]);
    const rr = resourceRuleRoute(url, method, init, state);
    if (rr) return rr;
    if (url.includes('/d1/database/') && url.includes('/query')) return cfOk({});
    // 🔴 這裡就是真實用戶那台帳號的樣子：還沒有 workers.dev 子網域
    if (SUB_GET.test(url) && method === 'GET') {
      return registered ? cfOk({ subdomain: registered }) : cfErr(404, 10007, 'not found');
    }
    if (SUB_CHECK.test(url)) return cfErr(404, 10032, 'available');
    if (SUB_GET.test(url) && method === 'PUT') {
      registered = JSON.parse(init.body).subdomain;
      return cfOk({ subdomain: registered });
    }
    if (url.includes('/workers/scripts/') && url.endsWith('/subdomain') && method === 'POST') return cfOk({});
    if (url.includes('/workers/scripts/') && method === 'PUT') return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
  return { calls, state, subdomainOf: () => registered };
}

test('inkstone/Arcrun#190 端到端（離線）：乾淨帳號走到底不再卡在 deploy，子網域由我們開出來', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-clean';
  await seedInstallSession(env, sid, 'clean@test.example');
  const { subdomainOf } = cleanAccountInstallFetch();
  try {
    await startInstallAndDrain(env, sid, {});
  } finally { restoreFetch(); }

  const progress = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  const deploy = progress.steps.find((s) => s.id === 'deploy');
  // 修好之前：deploy 這一步會是 error，訊息是「你的 Cloudflare 帳號還沒開通 workers.dev 專屬網址」
  assert.notEqual(deploy.state, 'error',
    `deploy 不該再擋下乾淨帳號（實際錯誤：${JSON.stringify(progress.error)}）`);
  assert.equal(progress.result.subdomain, subdomainOf(), '實例的網址要用我們剛註冊好的那個子網域');
  assert.equal(progress.result.subdomainCreated, subdomainOf(), '要記錄「這個是我們幫他開的」');
  assert.match(progress.subdomainNotice || '', /永久/, '要告訴用戶這個名字改不回來');
  assert.match(progress.subdomainNotice || '', new RegExp(subdomainOf()), '告知裡要有真正的名字');
  assert.ok(progress.result.subdomainTrail, '處理過程要留痕');
});

// --- 機械閘：不准再長出「你自己去 Cloudflare 弄」這種出口 -------------------

test('inkstone/Arcrun#190 機械閘：安裝器不准再出現「請你去 Cloudflare 後台做某事」的出口', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  // 只看**會送到用戶眼前**的程式碼行：整行註解（`//`、`/*`、`*`）是病史紀錄，
  // 那些行故意留著舊文案的原文，是為了讓後人知道這裡曾經錯過什麼。
  // 註解裡寫著禁語不是違規，把它印給用戶才是。
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  // 這條鐵律的射程比 subdomain 那一句大（全面清查是 Arcrun#191），
  // 但**至少**不准再有人把用戶推去 Cloudflare 後台自己設定。
  const banned = [
    /請到\s*Cloudflare\s*後台/,
    /dash\.cloudflare\.com\/[^'"`]*\/workers\/onboarding/,
    /到\s*Cloudflare\s*後台[^'"`]*設定/,
  ];
  for (const re of banned) {
    const m = code.match(re);
    assert.equal(m, null,
      `🔴 leo 2026-08-31：「叫用戶自己去開通是完全不准的」。命中：${m && m[0]}`);
  }
  // 反向自檢：這個閘要真的抓得到東西，否則它只是綠燈裝飾
  assert.ok(banned[0].test('throw new Error("請到 Cloudflare 後台 Workers 頁面設定")'),
    '閘本身要抓得到那句舊文案（不然它綠得沒有意義）');
});

// --- 前端：這一頁的 JS 真的解析得過（不是只看後端）-------------------------

test('inkstone/Arcrun#190 前端守門：INSTALL_SCRIPT 送到瀏覽器的那份要解析得過', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const m = src.match(/const INSTALL_SCRIPT = `([\s\S]*?)\n`;/);
  assert.ok(m, '找得到 INSTALL_SCRIPT');
  // 🔴 worker.js 的前端碼住在 template literal 裡 ⇒ `node --check worker.js` **驗不到**
  //    瀏覽器實際拿到的那份：檔案裡寫 \n 會在送出前變成真的換行，
  //    落在前端的字串常值中間就是 SyntaxError，而後端語法檢查完全看不見。
  //    這一格就是把那個盲區補起來。
  const emitted = m[1]
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
  new Function(emitted); // 解析不過會丟 SyntaxError
  assert.match(emitted, /warnings/, '完成頁要畫得出「你少拿到什麼」');
  assert.match(emitted, /subdomainNotice/, '進度頁要畫得出專屬網址告知');
});

/**
 * 真的把前端那份 JS 跑起來，用假 DOM 接住它畫出來的 HTML。
 *
 * 🔴 為什麼要做到這一步（而不是只 `new Function()` 檢查解析得過）：
 *    「安裝成功卻少了東西」這件事的判準是**用戶看不看得見**。
 *    後端把警告放進 JSON 只是必要條件——真正要驗的是它有沒有走到畫面上。
 *    只驗後端＝又一次把「寫進變數裡」當成「做到了」。
 */
async function loadInstallScript() {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const m = src.match(/const INSTALL_SCRIPT = `([\s\S]*?)\n`;/);
  const emitted = m[1]
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', addEventListener() {}, disabled: false });
  for (const id of ['steps', 'title', 'subtitle', 'result', 'error']) els[id] = mkEl();
  const document = { getElementById: (id) => els[id] || null };
  const window = { location: { search: '' } };
  let statusBody = {};
  const fetchStub = async () => ({ status: 200, json: async () => statusBody, body: null });
  const setTimeoutStub = () => 0; // 不排下一輪，讓 poll 跑完就停
  const factory = new Function(
    'document', 'window', 'fetch', 'setTimeout', 'navigator',
    emitted + '\nreturn { renderDone, renderError, poll };'
  );
  const api = factory(document, window, fetchStub, setTimeoutStub, { clipboard: { writeText: async () => {} } });
  return { els, setStatus: (b) => { statusBody = b; }, ...api };
}

test('inkstone/Arcrun#190 前端實跑：有東西沒裝起來時，完成頁必須把它畫出來（不准只寫在變數裡）', async () => {
  const { els, renderDone } = await loadInstallScript();
  renderDone({
    result: { url: 'https://x.acme.workers.dev/portal/', accountName: 'Acme' },
    warnings: installWarnings({
      vectorizeWarning: 'index quota exceeded',
      routeWarnings: ['arcrun-kbdb：權限不足（HTTP 403）'],
    }),
  });
  // 🔴 這是 leo 2026-08-31 判準的機械化：「用戶拿到『安裝成功』卻其實少了東西，
  //    這件事不准只寫在變數裡」⇒ 它必須出現在標題／內文，不是躲在摺疊的技術細節裡。
  assert.match(els.subtitle.textContent, /沒有裝起來/,
    `副標必須講出少了東西，實際「${els.subtitle.textContent}」`);
  assert.match(els.result.innerHTML, /語意搜尋/, '缺什麼要寫在畫面上');
  assert.match(els.result.innerHTML, /沒有對外開通/, '被空 catch 吞掉的那條也要畫出來');
  assert.match(els.result.innerHTML, /var\(--warn\)/, '要用警示樣式，不能混在正常內容裡');
  // 網址仍是主角（t79：完成頁只給網址），警告排在它後面
  assert.ok(els.result.innerHTML.indexOf('url-box') < els.result.innerHTML.indexOf('沒有裝起來'),
    '網址要排在警告前面（t79：完成頁的主角是網址）');
});

test('inkstone/Arcrun#190 前端實跑：全部正常時不要嚇用戶（沒有警告就不畫警告）', async () => {
  const { els, renderDone } = await loadInstallScript();
  renderDone({ result: { url: 'https://x.acme.workers.dev/portal/' }, warnings: installWarnings({}) });
  assert.equal(els.subtitle.textContent, '你的知識庫已經準備好了。');
  assert.ok(!/沒有裝起來/.test(els.result.innerHTML), '沒事就不要出現警示卡');
});

test('inkstone/Arcrun#190 前端實跑：開子網域**之前**，進度頁就要把名字畫給用戶看', async () => {
  const { els, setStatus, poll } = await loadInstallScript();
  // 後端在 PUT 打出去之前就把這段落庫了（announce 回呼），所以輪詢這一刻它已經在了
  setStatus({
    state: 'running',
    steps: [{ id: 'deploy', label: '部署你的專屬服務', state: 'running' }],
    subdomainNotice: '你的 Cloudflare 帳號還沒有 workers.dev 專屬網址，'
      + '我們正在幫你開通：arcrun-k3m9p2qd.workers.dev\n這個名字會永久留在你的 Cloudflare 帳號上',
  });
  await poll();
  assert.match(els.error.innerHTML, /arcrun-k3m9p2qd\.workers\.dev/,
    '🔴 名字要在畫面上（紅線：開之前讓用戶知道）');
  assert.match(els.error.innerHTML, /永久/, '改不回來這件事要講');
  assert.match(els.error.innerHTML, /專屬網址/, '要有標題讓人知道這張卡在講什麼');
  // 而且不准出現「你自己去弄」
  assert.ok(!/後台|dash\.cloudflare\.com/.test(els.error.innerHTML),
    '這張卡是告知，不是待辦清單');
});

// ---------------------------------------------------------------------------
// Arcrun#191 — 「叫用戶自己去開通是完全不准的」這條鐵律的**全面**閘
// ---------------------------------------------------------------------------
//
// 母票 #190 留下的閘是三條關鍵字黑名單（只擋 subdomain 那一句）。這裡把它換成
// **結構閘**，理由是 leo 自己講過的那條：
//
//   「自然語言的變體是無限的，blacklist 永遠追不完。封路哲學之所以有效，
//     是因為它封的是**動作**——動作有限且可枚舉，文字不是。」
//
// 套到文案上，可枚舉的那一半是**出路**，不是壞句子：
// 一句錯誤訊息的合法出路只有三種——① 按這一頁上的鈕 ② 回我們的首頁 ③ 交回我們處理
// （「稍等再試」算 ②的變體：用戶不必做任何事）。壞句子的寫法無限，好出路只有三種。
// ⇒ 所以閘的判準是「**每一句 hint 有沒有給出這三種之一**」，而不是「有沒有出現某個禁詞」。

// 規則的唯一實作在 copy-rules.mjs——出貨 preflight（copy-contract.test.mjs）跑的是同一份。
// 這裡只驗行為，不再抄一份規則（同一個能力兩份實作必然漂移，見 resource-rule-gate 的檔頭）。

test('#191 每一句錯誤文案都要給得出出路，而且不准把用戶推去 Cloudflare 後台', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const { hints, violations } = checkCopy(src);
  // 防「檢查了 0 句卻通過」——抽不到文案時要當場紅，不是安靜放行
  assert.ok(hints.length >= 20, `要真的抽到文案才算數（只抽到 ${hints.length} 句）`);
  assert.deepEqual(violations, [],
    '🔴 leo 2026-08-31「叫用戶自己去開通是完全不准的」。以下文案把我們的問題丟回給用戶：\n'
    + violations.map((v) => `  [規則 ${v.rule}]「${v.hint}」→ ${v.why}`).join('\n'));
});

test('#191 這道閘自己要抓得到東西（不然它只是綠燈裝飾）', () => {
  // 反證 A：母票修掉的那句真的會被規則 A 抓到
  assert.ok(OFFSITE_EXIT.test('請到 Cloudflare 後台 Workers 頁面設定一個子網域（免費），再回來按「重新安裝」。'),
    '規則 A 要抓得到 #190 那句舊文案');
  // 反證 A2：本票修掉的那句（推去官網）也要抓得到
  assert.ok(OFFSITE_EXIT.test('請先到 Cloudflare 官網完成帳號設定，再回來重新安裝。'),
    '規則 A 要抓得到「推去 Cloudflare 官網」那句');
  // 反證 B：死路要被抓到
  assert.ok(!APPROVED_EXITS.some((re) => re.test('你的帳號設定有問題。')),
    '規則 B 要判定「只講壞消息、不給出路」是死路');
  // 反證 C：本票修掉的 403 舊文案——規則 A、B 都放它過，只有規則 C 抓得到
  const OLD_403 = '請回到首頁重新授權，並在 Cloudflare 頁面上確認所有權限都有勾選。';
  assert.ok(!OFFSITE_EXIT.test(OLD_403), '（前提）它沒有站外詞，所以規則 A 抓不到');
  assert.ok(APPROVED_EXITS.some((re) => re.test(OLD_403)), '（前提）它有出路，所以規則 B 抓不到');
  assert.ok(PHANTOM_INSTRUCTION.test(OLD_403), '規則 C 必須抓到這句幽靈指示');
  // 規則 C 不准誤殺：講「這是我們的授權範圍不夠」是在認錯，不是在派工給用戶
  assert.ok(!PHANTOM_INSTRUCTION.test('這是我們的授權範圍不夠，不是你的設定問題。'),
    '把責任攬回自己身上的講法不該被擋');
  // 也不准誤殺「勾選帳號」——帳號是他真的勾得到的東西
  assert.ok(!PHANTOM_INSTRUCTION.test('在 Cloudflare 的授權畫面勾選你要安裝的那個帳號'),
    '勾帳號是他做得到的事，不是幽靈指示');
  // 反面：合法的三種出路都要放行，否則閘會懲罰正確文案
  for (const ok of [
    '請按「重新安裝」再試一次。',
    '請回到首頁重新連結你的 Cloudflare 帳號。',
    '請把技術細節回報給我們，我們來處理。',
  ]) {
    assert.ok(APPROVED_EXITS.some((re) => re.test(ok)), `合法出路不該被擋：「${ok}」`);
    assert.ok(!OFFSITE_EXIT.test(ok), `合法出路不該被誤判成站外：「${ok}」`);
  }
  // 「授權畫面」不是站外——它是我們 OAuth 流程的一站（#45 leo 核准的講法）
  assert.ok(!OFFSITE_EXIT.test('在 Cloudflare 的授權畫面只勾選你要安裝的那個帳號'),
    '授權屏是我們流程的一部分，不准被誤殺');
});

test('#191 靜默降級：清查後每一個「寫了卻沒人畫」的警告都要看得見', () => {
  // 🔴 這四個欄位在清查前**全檔各只有一個寫入點、零個讀取點**，
  //    連「技術細節」那坨 JSON 都沒收錄 ⇒ 寫下來就沒有任何人會再看到。
  // ⚠️ 2026-09-02 起其中「金鑰保管處」那一條改成只給我們自己看
  //    （inkstone/Arcrun#196 comment 6144）——它**仍然在 installWarnings 的回傳裡**，
  //    只是 audience='internal'。本 test 驗的是「四條都還在、都有話講」，
  //    「哪些畫給用戶」由下面那支 #196 的 test 顧。
  const w = installWarnings({
    seedError: 'connect timeout',
    secretSyncError: 'PUT /secrets → 404',
    credentialSeedError: 'd1 insert failed',
    skillsSeedError: 'HTTP 500',
  });
  assert.equal(w.length, 4, '四條全新挖出來的靜默降級都要被畫出來');
  for (const item of w) {
    assert.ok(item.title && item.body, '每一條都要有給人看的標題與說明');
    assert.ok(!/HTTP|seed|secret|credential|skills/i.test(item.title),
      `標題要是人話，技術原文留在 detail：「${item.title}」`);
  }
  // 種子失敗的後果是「總圖永遠空白」——那是用戶真的少拿到的東西，要講出來
  assert.match(w[0].body, /關係圖|圖譜|連起來/, '要講出用戶少拿到什麼，不是只說某支 API 失敗');
  assert.match(w[0].detail, /timeout/, '技術原文留在 detail 給回報用');

  // seedTemplates 存著 'HTTP 4xx' 也算失敗（它不是例外，是回應碼被當成結果存下來）
  assert.equal(installWarnings({ seedTemplates: 'HTTP 401' }).length, 1,
    'seedTemplates 存著 HTTP 錯誤碼＝沒種成功，一樣要看得見');
  assert.equal(installWarnings({ seedTemplates: ['triplet'] }).length, 0,
    '種成功時不要嚇用戶');
});

test('#208 seed 逾時但已核實 triplet 底稿還在 ⇒ 不示警（誤報嚇用戶去重裝）', () => {
  // leo 2026-09-19：leo21c 1.4.67→1.4.68，9 個範本（含 triplet）都在，
  // /init/seed 只是超過 30 秒逾時，結算卻跳「關係圖會空白」——那是把「沒等到回應」
  // 誤報成「沒種進去」。修法：seed 失敗時直接探 triplet template 在不在，只有真的缺才示警。
  assert.equal(installWarnings({ seedError: 'timeout', seedTripletPresent: true }).length, 0,
    'seed 逾時但底稿已在＝誤報，不准畫這條黃框');
  assert.equal(installWarnings({ seedTemplates: 'HTTP 500', seedTripletPresent: true }).length, 0,
    'seed 回錯但底稿已在＝誤報，一樣不畫');

  // 真的缺（探測回報不在）⇒ 仍要示警，且要講得出用戶該怎麼辦（驗收條款②）
  const miss = installWarnings({ seedError: 'timeout', seedTripletPresent: false });
  assert.equal(miss.length, 1, 'triplet 底稿真的不在時仍要示警');
  assert.match(miss[0].body, /再跑一次|重新|回報/, '真的缺時要講得出用戶該怎麼辦');

  // 沒有核實資訊（舊行為 / seedTripletPresent 未設）⇒ 維持示警，不因新欄位缺席而漏報
  assert.equal(installWarnings({ seedError: 'timeout' }).length, 1,
    '沒有核實資訊時維持舊行為（寧可示警不漏報）');

  // 量測數字（seedMs）若有，收進技術細節給回報用（驗收條款③）
  const withMs = installWarnings({ seedError: 'timeout', seedMs: 41234 });
  assert.match(withMs[0].detail, /seedMs=41234/, 'seed 耗時要進 detail 供回報');
});

test('#191 前端實跑：清查挖出來的四條警告，也要真的畫到完成頁上', async () => {
  const { els, renderDone } = await loadInstallScript();
  const all = installWarnings({
    seedError: 'connect timeout',
    secretSyncError: 'PUT /secrets → 404',
    credentialSeedError: 'd1 insert failed',
    skillsSeedError: 'HTTP 500',
  });
  renderDone({
    result: { url: 'https://x.acme.workers.dev/portal/', accountName: 'Acme' },
    // 端點怎麼分袋，這裡就怎麼分（handleInstallStatus 同一組函式）
    warnings: userFacingWarnings(all),
    internalNotes: internalOnlyWarnings(all),
  });
  // 🔴 這四條在本票清查前是**寫了就沒人看**的變數（全檔各只有一個寫入點、零個讀取點）。
  //    這個 test 是它們「真的被畫出來」的證據，不是「函式回了東西」而已。
  // ⚠️ 2026-09-02 起「金鑰保管處」那一條不對用戶顯示（#196 comment 6144）⇒ 剩三條。
  assert.match(els.subtitle.textContent, /3 件事沒有裝起來/,
    `副標要數對，實際「${els.subtitle.textContent}」`);
  for (const [what, re] of [
    ['知識圖譜種子', /關係圖|圖譜/],
    ['內部金鑰同步', /內部金鑰/],
    ['AI 操作手冊', /操作手冊/],
  ]) {
    assert.match(els.result.innerHTML, re, `${what} 這條要出現在畫面上`);
  }
  // 技術原文要進得了摺疊區，回報問題時附得上
  assert.match(els.result.innerHTML, /connect timeout/, '技術細節要附在摺疊區裡');
  // 而且不准把「你自己去弄」寫進去
  assert.ok(!/後台|dash\.cloudflare\.com/.test(els.result.innerHTML),
    '警告卡是告知，不是丟給用戶的待辦清單');
});

// ═══════════════════════════════════════════════════════════════════════════
// inkstone/Arcrun#196 comment 6144 — 用戶無法行動的壞消息，不准跳到他臉上
//
// leo 2026-09-02 自己走完 stage 安裝，完成頁跳出這張卡：
//     有 1 件事沒有裝起來
//     金鑰沒有存進金鑰保管處
//     功能還是可以用，但金鑰是用比較舊的方式帶著跑的，不如原本設計的安全。
//     技術細節：目錄端點回 HTTP 404：404 Not Found
//   「成功了，但跳出這個警訊。你可以默默修復，但不要跳出這段會嚇到使用者」
//
// 🔴 判準是**用戶有沒有出路**，不是「看起來嚇不嚇人」：
//   這一條不是他的帳號、不是他的設定，按「重新安裝」也不會好——它講的是
//   我們的出貨還沒到位（實例上還沒有 /credentials/directory）。
// 🔴 但**不准變成靜默失敗**：同一趟的診斷面要一字不差地看得到它。
// ═══════════════════════════════════════════════════════════════════════════

test('#196/6144 用戶面：只有「金鑰沒進保管處」時，完成頁一張卡都不畫、也不說「有 N 件事沒有裝起來」', async () => {
  const { els, renderDone } = await loadInstallScript();
  // leo 那一趟的實際欄位（stage 還沒有那支端點 ⇒ 目錄那一半拿到 404）
  const result = {
    url: 'https://x.acme.workers.dev/portal/',
    accountName: 'Acme',
    secretsSynced: true,
    credentialSeedError: '目錄端點回 HTTP 404：404 Not Found',
  };
  const all = installWarnings(result);
  assert.equal(userFacingWarnings(all).length, 0, '用戶面一條都不該有');

  renderDone({ result, warnings: userFacingWarnings(all), internalNotes: internalOnlyWarnings(all) });

  assert.equal(els.subtitle.textContent, '你的知識庫已經準備好了。',
    `副標不准因為這一條而改口，實際「${els.subtitle.textContent}」`);
  assert.ok(!/沒有裝起來/.test(els.result.innerHTML), '不准出現「有 N 件事沒有裝起來」');
  assert.ok(!/var\(--warn\)/.test(els.result.innerHTML), '不准有警示卡的樣式');
  // leo 眼睛看到的那一句，一個字都不准留在畫面上
  assert.ok(!/不如原本設計的安全/.test(els.result.innerHTML),
    '🔴 這就是 leo 說「會嚇到使用者」的那一句');
});

test('#196/6144 診斷面：同一趟的安裝結果仍查得到 credentialSeedError，技術細節那一段仍看得到', async () => {
  // ── ① 端點層：分兩袋送，原始欄位一字未動 ────────────────────────────
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-cred-404';
  await seedSession(env, sid);
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify({
    state: 'done',
    startedAt: Date.now() - 60000,
    finishedAt: Date.now() - 1000,
    steps: [{ id: 'deploy', state: 'done' }],
    result: {
      url: 'https://x.acme.workers.dev/portal/',
      secretsSynced: true,
      credentialSeedError: '目錄端點回 HTTP 404：404 Not Found',
    },
  }));
  const res = await worker.fetch(reqStatus(sid), env, { waitUntil() {} });
  const body = await res.json();

  assert.deepEqual(body.warnings, [], '用戶面那一袋要是空的');
  assert.equal(body.internalNotes.length, 1, '我們自己那一袋要收到它');
  assert.match(body.internalNotes[0].detail, /404/,
    '技術細節要原樣帶過來（回報問題時靠它）');
  assert.equal(body.result.credentialSeedError, '目錄端點回 HTTP 404：404 Not Found',
    '🔴 安裝結果裡的原始欄位一個字都不准動——它是我們追這件事的依據');

  // ── ② 畫面層：「技術細節（給工程師看的）」那一段印得出來 ──────────────
  const { els, renderDone } = await loadInstallScript();
  renderDone({ result: body.result, warnings: body.warnings, internalNotes: body.internalNotes });
  assert.match(els.result.innerHTML, /沒有顯示給用戶的內部狀況/,
    '不畫成卡 ≠ 沒有人看得到——技術細節那一段一定要收錄它');
  assert.match(els.result.innerHTML, /404/, '技術原文要在那一段裡');
});

test('#196/6144 只搬這一條：其他警告一條都不准跟著藏', () => {
  // 把全部欄位一次餵滿，看誰被歸到「不給用戶看」那一袋
  const all = installWarnings({
    vectorizeWarning: 'index quota exceeded',
    vectorizeMetadataWarning: 'metadata index failed',
    routeWarnings: ['arcrun-kbdb：權限不足（HTTP 403）'],
    healthWarning: 'health 500',
    seedError: 'connect timeout',
    secretSyncError: 'PUT /secrets → 404',
    credentialSeedError: '目錄端點回 HTTP 404',
    skillsSeedError: 'HTTP 500',
  });
  assert.deepEqual(
    internalOnlyWarnings(all).map((w) => w.title),
    ['金鑰沒有存進金鑰保管處'],
    '🔴 leo 只裁了這一條。多藏一條＝把警告機制一條一條掏空（#190／#191 治的就是這個病）',
  );
  assert.equal(userFacingWarnings(all).length, all.length - 1,
    '其餘每一條都要照常畫給用戶');
  // 沒標 audience 的東西一律當「給用戶看」——預設不准是藏起來
  assert.deepEqual(userFacingWarnings([{ title: '沒標的' }]).map((w) => w.title), ['沒標的'],
    '預設是 user：要藏必須明講，不能靠忘了標');
});

test('#196/6144 有出路的警告照常顯示：真的少了服務時，畫面照樣講出來', async () => {
  const { els, renderDone } = await loadInstallScript();
  // 「有 N 個服務沒有對外開通」＝用戶按重新安裝有機會好 ⇒ 有出路 ⇒ 照畫。
  // 同一趟也帶著那條不給用戶看的，證明它不會把別人一起拖下水。
  const result = {
    url: 'https://x.acme.workers.dev/portal/',
    routeWarnings: ['arcrun-kbdb：權限不足（HTTP 403）'],
    credentialSeedError: '目錄端點回 HTTP 404',
  };
  const all = installWarnings(result);
  renderDone({ result, warnings: userFacingWarnings(all), internalNotes: internalOnlyWarnings(all) });
  assert.match(els.subtitle.textContent, /有 1 件事沒有裝起來/,
    `數字只能數用戶面那一袋，實際「${els.subtitle.textContent}」`);
  assert.match(els.result.innerHTML, /沒有對外開通/, '有出路的警告要照常顯示');
  assert.ok(!/不如原本設計的安全/.test(els.result.innerHTML), '不給用戶看的那一條不准搭順風車');
});

test('#196/6144 出貨閘：警告收件人清單被動過，出貨當場紅', async () => {
  // 規則的唯一實作在 copy-rules.mjs——出貨 preflight（copy-contract.test.mjs）跑的是同一份。
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');

  const now = checkWarningAudience(src);
  assert.ok(now.cards.length >= 6, `抽得到警告卡才算數，實際 ${now.cards.length} 張`);
  assert.deepEqual(now.violations, [], '現況要乾淨');
  assert.deepEqual(WARNING_AUDIENCE_ALLOWLIST.map((x) => x.title), ['金鑰沒有存進金鑰保管處']);

  // ① 把它掀回用戶面 ⇒ 紅（leo 拍板不給用戶看的東西又跳出來）
  const unhidden = src.replace(/(title: '金鑰沒有存進金鑰保管處',[\s\S]{0,400}?)\n      audience: 'internal',/,
    '$1');
  assert.notEqual(unhidden, src, '突變要真的改到東西，否則這個 test 在自我欺騙');
  assert.ok(checkWarningAudience(unhidden).violations.length > 0,
    '把 internal 拿掉 ⇒ 閘要當場紅');

  // ② 多藏一條沒審核過的 ⇒ 紅（警告機制被一條一條掏空）
  const overHidden = src.replace("      detail: String(r.skillsSeedError),",
    "      detail: String(r.skillsSeedError),\n      audience: 'internal',");
  assert.notEqual(overHidden, src, '突變要真的改到東西');
  assert.ok(checkWarningAudience(overHidden).violations.some((v) => /未審核/.test(v.rule)),
    '沒進清單就藏 ⇒ 閘要當場紅');
});

// ═══════════════════════════════════════════════════════════════════════════
// inkstone/arcrun-rag#179 — 說「裝好了」的時候，每一顆真的要在帳號上
//
// 症狀（2026-09-01 實撞，出處 inkstone/Arcrun#190 comment 5901）：
//   KV 紀錄 deployed:1129efd7…  的 workers{} → 23 個名字
//   帳號實際 GET /workers/scripts             → 16 顆
//   差的七顆：arcrun-mcp / set / string-ops / switch / try-catch / validate-json / wait
//   再打一次 /api/install/start {"force":true} → 「23 個服務都沒有變動，直接沿用」
//
// 🔴 根因：兩層跳過都只看「帳本裡的 sha」與「實例健康探測」，
//    **沒有任何一句在問「這顆現在在不在這個帳號上」**
//    ⇒ 紀錄一旦說謊就自我延續（跳過 → 用 manifest 重寫帳本 → 下次更確信）。
//    而 arcrun-mcp 就在缺的七顆裡 ⇒ 用戶拿到「畫面說裝好了、但 MCP 不存在」的實例。
// ═══════════════════════════════════════════════════════════════════════════

import { missingFromAccount, listAccountWorkerNames } from './worker.js';

// 2026-09-01 youlin 的真實狀態（本票的靶）。
const CORE_23 = [
  'arcrun-array-ops', 'arcrun-auth-oauth2', 'arcrun-auth-service-account', 'arcrun-auth-static-key',
  'arcrun-code', 'arcrun-cron', 'arcrun-cypher-executor', 'arcrun-date-ops', 'arcrun-filter',
  'arcrun-foreach-control', 'arcrun-http-request', 'arcrun-if-control', 'arcrun-kbdb', 'arcrun-mcp',
  'arcrun-merge', 'arcrun-number-ops', 'arcrun-rag-ui', 'arcrun-set', 'arcrun-string-ops',
  'arcrun-switch', 'arcrun-try-catch', 'arcrun-validate-json', 'arcrun-wait',
];
const ON_ACCOUNT_16 = [
  'arcrun-array-ops', 'arcrun-auth-oauth2', 'arcrun-auth-service-account', 'arcrun-auth-static-key',
  'arcrun-code', 'arcrun-cron', 'arcrun-cypher-executor', 'arcrun-date-ops', 'arcrun-filter',
  'arcrun-foreach-control', 'arcrun-http-request', 'arcrun-if-control', 'arcrun-kbdb',
  'arcrun-merge', 'arcrun-number-ops', 'arcrun-rag-ui',
];
const MISSING_7 = [
  'arcrun-mcp', 'arcrun-set', 'arcrun-string-ops', 'arcrun-switch',
  'arcrun-try-catch', 'arcrun-validate-json', 'arcrun-wait',
];

test('#179 靶的算術：23 顆 manifest vs 帳號上 16 顆 ⇒ 缺的正是那七顆', () => {
  assert.equal(CORE_23.length, 23);
  assert.equal(ON_ACCOUNT_16.length, 16);
  assert.deepEqual(
    missingFromAccount(CORE_23, new Set(ON_ACCOUNT_16)).sort(),
    [...MISSING_7].sort(),
  );
});

test('#179 🔴 紅線：帳號上沒有這顆 ⇒ 不管帳本怎麼寫都不准跳過', () => {
  // 缺的七顆每一顆都是「sha 沒變、又不是印記載體」——舊判準必定放它們過。
  for (const name of MISSING_7) {
    assert.equal(
      canSkipWorker({ name, entrySha: SEEN, prevSha: SEEN, scope: 'none', presentOnAccount: false }),
      false,
      `${name} 不在帳號上還被略過＝用戶拿到一台少了它的實例`,
    );
    // scope=stamp（每次發版都會走到的那一格）同樣不准放過
    assert.equal(
      canSkipWorker({ name, entrySha: SEEN, prevSha: SEEN, scope: 'stamp', presentOnAccount: false }),
      false,
    );
  }
});

test('#179 🔴 紅線：`arcrun-mcp` 不在帳號上就一定要被推（這是本票急的理由）', () => {
  assert.equal(
    canSkipWorker({ name: 'arcrun-mcp', entrySha: SEEN, prevSha: SEEN, scope: 'none', presentOnAccount: false }),
    false,
    'MCP 缺了而畫面說裝好了＝用戶沒有任何錯誤訊息可查',
  );
});

test('#179 迴歸靶：修好前後在同一個靶上，這一輪各會推幾顆', () => {
  const present = new Set(ON_ACCOUNT_16);
  // 修好前＝完全不看帳號現實（presentOnAccount 傳 undefined ⇒ 退回舊判準）
  const before = CORE_23.filter((name) => !canSkipWorker({
    name, entrySha: SEEN, prevSha: SEEN, scope: 'none',
  }));
  assert.deepEqual(before, [], '這就是實撞的那句「23 個服務都沒有變動，直接沿用」');
  // 修好後＝帳號現實一票否決
  const after = CORE_23.filter((name) => !canSkipWorker({
    name, entrySha: SEEN, prevSha: SEEN, scope: 'none', presentOnAccount: present.has(name),
  }));
  assert.deepEqual(after.sort(), [...MISSING_7].sort(), '缺的七顆會被真的裝回去，其餘 16 顆照舊不動');
  assert.equal(after.length, 7);
});

test('#179 收斂：帳號上有、內容也沒變 ⇒ 照舊略過（不准變成每次全推 23 顆）', () => {
  for (const name of ON_ACCOUNT_16) {
    if (name === 'arcrun-cypher-executor' || name === 'arcrun-rag-ui') continue; // 印記載體另有規則
    assert.equal(
      canSkipWorker({ name, entrySha: SEEN, prevSha: SEEN, scope: 'none', presentOnAccount: true }),
      true,
      `${name} 明明在帳號上又沒變，被重推＝#157 那個「為什麼每次都重裝 23 個」回來了`,
    );
  }
});

test('#179 🔴 「列不到」不可以講成「不存在」：null ⇒ 退回舊判準，不報假缺件', () => {
  // missingFromAccount 拿不到清單時回空陣列——不准編一份「缺了什麼」出來
  assert.deepEqual(missingFromAccount(CORE_23, null), []);
  assert.deepEqual(missingFromAccount(CORE_23, undefined), []);
  // canSkipWorker 拿到 null／undefined 時行為與修改前一致（沒有帳號現實這個證據）
  assert.equal(canSkipWorker({ name: 'arcrun-set', entrySha: SEEN, prevSha: SEEN, scope: 'none', presentOnAccount: null }), true);
  assert.equal(canSkipWorker({ name: 'arcrun-set', entrySha: SEEN, prevSha: SEEN, scope: 'none' }), true);
});

test('#179 帳號現實不會覆蓋原有的三個判準（有它也不准放寬）', () => {
  // 在帳號上，但內容變了 ⇒ 還是要推
  assert.equal(canSkipWorker({ name: 'arcrun-kbdb', entrySha: 'CHANGED', prevSha: SEEN, scope: 'none', presentOnAccount: true }), false);
  // 在帳號上，但帳本整份不可信 ⇒ 還是要推
  assert.equal(canSkipWorker({ name: 'arcrun-set', entrySha: SEEN, prevSha: SEEN, scope: 'all', presentOnAccount: true }), false);
  // 在帳號上，但它是印記載體且版號落後 ⇒ 還是要推
  assert.equal(canSkipWorker({ name: 'arcrun-cypher-executor', entrySha: SEEN, prevSha: SEEN, scope: 'stamp', presentOnAccount: true }), false);
});

test('#179 listAccountWorkerNames：一次列表就夠，且讀的是 result[].id', async () => {
  const calls = installFetch(async (url) => {
    if (url.includes('/workers/scripts')) {
      return { json: { success: true, result: ON_ACCOUNT_16.map((id) => ({ id, created_on: 'x' })) } };
    }
    return { status: 404, json: { success: false, errors: [] } };
  });
  try {
    const got = await listAccountWorkerNames('tok', 'acct1');
    assert.equal(got.size, 16);
    assert.ok(got.has('arcrun-kbdb'));
    assert.ok(!got.has('arcrun-mcp'));
    const listCalls = calls.filter((c) => c.url.includes('/workers/scripts'));
    assert.equal(listCalls.length, 1, '一個帳號一輪只准問一次（省 subrequests，本票驗收條件之一）');
    assert.ok(listCalls[0].url.endsWith('/accounts/acct1/workers/scripts'));
    assert.equal(listCalls[0].method, 'GET');
  } finally {
    restoreFetch();
  }
});

test('#179 listAccountWorkerNames 失敗要往外拋，不准自己吞成空集合', async () => {
  installFetch(async () => ({ status: 403, json: { success: false, errors: [{ code: 10000, message: 'no perm' }] } }));
  try {
    await assert.rejects(() => listAccountWorkerNames('tok', 'acct1'));
  } finally {
    restoreFetch();
  }
  // 吞成 Set() 的話，上面每一顆都會變成「不在帳號上」⇒ 一次列表失敗就全推 23 顆，
  // 而且會對用戶報一份假的「缺件」清單。
});

// ═══════════════════════════════════════════════════════════════════════════
// inkstone/Arcrun#191 — 「已經有了」不是失敗；而且**判斷不准讀譯文**
// ═══════════════════════════════════════════════════════════════════════════
//
// 病史（2026-09-01，第一次有人用真瀏覽器打開安裝完成頁，stage 安裝器 1.0.3）：
//   畫面：「你的知識庫可以用了，但有 2 件事沒有裝起來」
//         ⚠️ 語意搜尋的篩選欄位沒有建齊   ← 🔴 這條是假的
//   後端原始資料：owner_id / entry_type / source / library 四個欄位
//   全部回「這個名稱已經被使用過了」＝**四個都已經建好了**。
//
// 根因（兩行的距離）：
//   translateCfError            把 `already exists` 翻成「這個名稱已經被使用過了」
//   ensureVectorizeMetadataIndexes  才拿英文去比對  ⇒ **永遠比不中**
//   ⇒ 判斷寫在翻譯的下游，而翻譯把它要比對的字擦掉了。
//
// 這組測試守的就是這件事：**CF 說「已經有了」⇒ 不算失敗**，
// 而且守的是「判斷讀的是結構化欄位」，不是「這次剛好比中了」。

const META_CREATE = /\/vectorize\/v2\/indexes\/([^/]+)\/metadata_index\/create$/;
const META_PROPS = ['owner_id', 'entry_type', 'source', 'library'];

test('#191 陷阱本身：translateCfError 會把 already exists 擦掉 ⇒ 任何讀 message 的判斷都必死', () => {
  const translated = translateCfError(409, CF_ERR_NAME_TAKEN, 'metadata index already exists');
  assert.equal(translated, '這個名稱已經被使用過了');
  assert.ok(!/already exists/i.test(translated),
    '🔴 這一行就是本票的機械證明：譯文裡**沒有**英文原字。'
    + '所以 /already exists/.test(e.message) 從寫下的那一刻起就沒有命中過一次。');
});

test('#191 CF 回「已經有了」（code 10014）⇒ 一件失敗都不准回報', async () => {
  const seen = [];
  installFetch((url, init) => {
    const m = url.match(META_CREATE);
    if (m && (init.method || 'GET').toUpperCase() === 'POST') {
      seen.push(JSON.parse(init.body).propertyName);
      return cfErr(409, CF_ERR_NAME_TAKEN, 'metadata index already exists');
    }
    return { status: 404, json: { success: false, errors: [{ code: 0, message: `unhandled ${url}` }] } };
  });
  let failures;
  try {
    failures = await ensureVectorizeMetadataIndexes('tok', 'acct-1', 'idx-1');
  } finally { restoreFetch(); }

  assert.deepEqual(seen, META_PROPS, '四個欄位都要試著建（冪等，沿用的實例也要補）');
  assert.deepEqual(failures, [],
    '🔴 這就是這張票：四個都已經存在 ⇒ failures 必須是空的。'
    + '不是空的 ⇒ 完成頁會對每一個用戶說一句假話。');
});

test('#191 CF 只給文字、沒給 code ⇒ 讀原文一樣要認得出「已經有了」', async () => {
  installFetch((url, init) => {
    if (META_CREATE.test(url) && (init.method || 'GET').toUpperCase() === 'POST') {
      // errors[].code 缺席（CF 各端點不一致，實測 subdomain 那組就三種 status 三種 code）
      return { status: 400, json: { success: false, result: null, errors: [{ message: 'property already exists' }] } };
    }
    return { status: 404, json: { success: false, errors: [] } };
  });
  let failures;
  try {
    failures = await ensureVectorizeMetadataIndexes('tok', 'acct-1', 'idx-1');
  } finally { restoreFetch(); }
  assert.deepEqual(failures, [],
    '沒有 code 時退路是讀 CF 原文（cfMessage），不是讀被翻譯過的 message');
});

test('#191 真的失敗（沒權限）⇒ 照樣要回報，不准被順手吞掉', async () => {
  installFetch((url) => {
    if (META_CREATE.test(url)) return cfErr(403, 10000, 'insufficient permissions');
    return { status: 404, json: { success: false, errors: [] } };
  });
  let failures;
  try {
    failures = await ensureVectorizeMetadataIndexes('tok', 'acct-1', 'idx-1');
  } finally { restoreFetch(); }

  assert.equal(failures.length, 4, '四個都真的建不起來 ⇒ 四筆都要留痕（這條警告是真的）');
  for (const prop of META_PROPS) {
    assert.ok(failures.some((f) => f.startsWith(prop + ': ')), `${prop} 要點名`);
  }
  assert.ok(failures.every((f) => /授權|權限/.test(f)),
    '留痕的字給人看 ⇒ 要譯文。「判斷讀原文、顯示讀譯文」兩件事不可以混為一談');
});

test('#191 一半已存在、一半真的壞掉 ⇒ 只回報真的那一半', async () => {
  installFetch((url, init) => {
    if (META_CREATE.test(url) && (init.method || 'GET').toUpperCase() === 'POST') {
      const prop = JSON.parse(init.body).propertyName;
      if (prop === 'owner_id' || prop === 'entry_type') {
        return cfErr(409, CF_ERR_NAME_TAKEN, 'metadata index already exists');
      }
      return cfErr(500, 10001, 'internal error');
    }
    return { status: 404, json: { success: false, errors: [] } };
  });
  let failures;
  try {
    failures = await ensureVectorizeMetadataIndexes('tok', 'acct-1', 'idx-1');
  } finally { restoreFetch(); }
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.startsWith('source: ') || f.startsWith('library: ')),
    '已存在的那兩個不可以出現在失敗清單裡');
});

test('#191 端到端：四個都已存在 ⇒ 完成頁一個字都不准提「篩選欄位沒有建齊」', async () => {
  installFetch((url, init) => {
    if (META_CREATE.test(url) && (init.method || 'GET').toUpperCase() === 'POST') {
      return cfErr(409, CF_ERR_NAME_TAKEN, 'metadata index already exists');
    }
    return { status: 404, json: { success: false, errors: [] } };
  });
  let failures;
  try {
    failures = await ensureVectorizeMetadataIndexes('tok', 'acct-1', 'idx-1');
  } finally { restoreFetch(); }

  // runInstall 的寫法：只有非空才寫進 progress.result（worker.js 的 `if (metaFailures.length)`）
  const result = failures.length ? { vectorizeMetadataWarning: failures.join('\n') } : {};
  const titles = installWarnings(result).map((w) => w.title);
  assert.deepEqual(titles, [],
    '🔴 leo 2026-09-01 實看到的那一行就是從這裡長出來的：'
    + '「語意搜尋的篩選欄位沒有建齊」——東西是好的，警告是假的。');
});

test('#191 cfRawMessage 的規約：有原文用原文，沒有原文才退回 message', () => {
  // cfFetch 丟出來的：message 已被翻譯，cfMessage 是 CF 原話
  assert.equal(
    cfRawMessage({ message: '這個名稱已經被使用過了', cfMessage: 'already exists' }),
    'already exists',
    '有 cfMessage 就必須用它——這是整張票的修法');
  // 不是 cfFetch 丟的（沒經過 translateCfError）⇒ message 本來就是原文，退回它是安全的
  assert.equal(cfRawMessage(new Error('duplicate column name: src_id')), 'duplicate column name: src_id');
  assert.equal(cfRawMessage(null), '');
});

test('#191 第二處同款：duplicate column 的容錯也要讀原文（守 #159 那個病不復發）', () => {
  // D1 的錯今天落在 translateCfError 最後那條 `Cloudflare 回報：${msg}`，
  // 原文剛好被原封不動接在後面 ⇒ 讀 message 也比得中。**那是運氣，不是設計。**
  const lucky = translateCfError(400, undefined, 'duplicate column name: src_id: SQLITE_ERROR');
  assert.ok(/duplicate column/i.test(lucky), '今天讀譯文還比得中（所以這一處今天沒壞）');

  // 但只要哪天這個錯帶上 code、或走到 401/403/429 那三條翻譯分支，原文就被擦掉：
  const unlucky = translateCfError(403, undefined, 'duplicate column name: src_id: SQLITE_ERROR');
  assert.ok(!/duplicate column/i.test(unlucky),
    '同一個錯換一條翻譯分支，判斷依據就沒了 ⇒ 已套過 migration 的實例再裝一次就整步失敗');

  // 改讀原文之後，兩種情況都比得中——不再靠運氣。
  const e = Object.assign(new Error(unlucky), { cfMessage: 'duplicate column name: src_id: SQLITE_ERROR' });
  assert.ok(/duplicate column/i.test(cfRawMessage(e)), '讀原文 ⇒ 不受翻譯分支影響');
});

test('InkStoneCo#132 D1 每日額度撞頂：說人話，且不給「今天重按」這條假出路', async () => {
  // 原文取自 2026-09-13 youlin 實例 /health 的 probe_error（真的撞到的那一句）
  const READ = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
  const WRITE = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
  for (const raw of [READ, WRITE]) {
    installFetch(() => ({ status: 400, json: { success: false, errors: [{ code: 7500, message: raw }] } }));
    let err;
    try {
      await cfFetch('tok', '/accounts/acct-1/d1/database/db-1/query', { method: 'POST', body: '{}' });
    } catch (e) { err = e; } finally { restoreFetch(); }
    assert.ok(err, 'CF 回錯必須丟出來');
    assert.equal(err.message, '你的 Cloudflare 免費帳號今天的資料庫額度已經用完了');
    assert.ok(!/exceeded/i.test(err.message), '畫面上那一句不再是英文原文');
    assert.match(err.hint, /台北時間早上 8 點/, '要講出什麼時候可以再試');
    assert.match(err.hint, /今天再按也會停在同一步/, '要明講今天重按沒用——舊提示叫人重按就是假出路');
    assert.equal(cfRawMessage(err), raw, '原文照樣留給程式判斷（#191 規約不破）');
  }
  // 別的錯不被誤認成額度撞頂
  assert.equal(translateCfError(400, undefined, 'duplicate column name: src_id'), 'Cloudflare 回報：duplicate column name: src_id');
});

test('#191 isAlreadyExistsError 不准把「不是這回事」的錯誤當成已存在', () => {
  assert.equal(isAlreadyExistsError(null), false);
  assert.equal(isAlreadyExistsError(new Error('boom')), false);
  assert.equal(isAlreadyExistsError({ code: 10000, cfMessage: 'insufficient permissions' }), false);
  assert.equal(isAlreadyExistsError({ code: CF_ERR_NAME_TAKEN }), true);
  assert.equal(isAlreadyExistsError({ cfMessage: 'index already exists' }), true);
  assert.equal(isAlreadyExistsError({ message: '這個名稱已經被使用過了' }), false,
    '🔴 只有譯文、沒有原文也沒有 code ⇒ 判不出來是**對的**。'
    + '要治的是「別把原文擦掉」，不是回頭去比對中文字串——'
    + '那只會把同一個病換一種語言再犯一次。');
});


// ─── inkstone/Arcrun#190：剛開好的專屬網址還沒生效就開工 ────────────────────
//
// 這是這張票**第二次**撞到的同一個 bug（2026-08-14 是 404+error code 1042，
// 2026-09-02 是 530）。修法兩週前寫在 edff76c，從沒併進 main。
// 判準刻意用「body 是不是 JSON」而不是比對狀態碼——兩次的碼不同、形狀相同。

/** 造一個假的 fetch：依序回傳 responses 裡的東西。 */
function fakeFetchSeq(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throw) throw new Error(r.throw);
    return { status: r.status, text: async () => r.body };
  };
}

test('#190 CF 邊緣回 HTML（主機名還沒生效）⇒ 不算 routed，要繼續等', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetchSeq([
    { status: 530, body: '<html><body>error code: 1042</body></html>' },
    { status: 530, body: '<html><body>error code: 1042</body></html>' },
    { status: 200, body: JSON.stringify({ ok: true, status: 'ok' }) },
  ]);
  try {
    const r = await waitForWorkerLive('https://x.example.workers.dev', {
      until: 'routed', sleep: async () => {}, maxAttempts: 5,
    });
    assert.equal(r.routed, true, '第三次拿到 JSON ⇒ routed');
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3, '前兩次的 HTML 不算通，要真的重試');
  } finally { globalThis.fetch = orig; }
});

test('#190 一直只拿到 CF 的 HTML ⇒ routed 為 false，且訊息保留 CF 原文（1042／530 看得到）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetchSeq([{ status: 530, body: '<html><body>error code: 1042</body></html>' }]);
  try {
    const r = await waitForWorkerLive('https://x.example.workers.dev', {
      until: 'routed', sleep: async () => {}, maxAttempts: 3,
    });
    assert.equal(r.routed, false);
    assert.equal(r.attempts, 3, '用完次數才放棄');
    assert.match(r.error, /1042/, '🔴 CF 的原碼必須留在訊息裡——少了它，「機器還不存在」看起來像「程式沒這條路由」');
    assert.match(r.error, /還在生效中/, '文案要說「還在生效中」，不是「失敗」');
  } finally { globalThis.fetch = orig; }
});

test('#190 判準是「body 是不是 JSON」，不是比對狀態碼清單', async () => {
  const orig = globalThis.fetch;
  // 200 但回 HTML（CF 邊緣也可能 200）⇒ 照樣不算 routed
  globalThis.fetch = fakeFetchSeq([{ status: 200, body: '<html>just a cf page</html>' }]);
  try {
    const r = await waitForWorkerLive('https://x.example.workers.dev', {
      until: 'routed', sleep: async () => {}, maxAttempts: 2,
    });
    assert.equal(r.routed, false,
      '🔴 200 也可能是 CF 邊緣在講話——若判準是狀態碼，這個案例會被誤判成「通了」');
  } finally { globalThis.fetch = orig; }
});

test('#190 until:routed 拿到 JSON 但健檢沒過 ⇒ 立刻回（不再等，那是別的毛病）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetchSeq([{ status: 200, body: JSON.stringify({ ok: false, status: 'degraded' }) }]);
  try {
    const r = await waitForWorkerLive('https://x.example.workers.dev', {
      until: 'routed', sleep: async () => {}, maxAttempts: 10,
    });
    assert.equal(r.routed, true);
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 1, '路由通了就別再等——健檢不過再等也不會好（t158）');
  } finally { globalThis.fetch = orig; }
});

test('#190 等待期間每一輪都回心跳（否則 5 分鐘的 STALL_MS 會把它判死）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetchSeq([{ status: 530, body: '<html>error code: 1042</html>' }]);
  let attempts = 0; let beats = 0;
  try {
    await waitForWorkerLive('https://x.example.workers.dev', {
      until: 'routed', sleep: async () => {}, maxAttempts: 3,
      onAttempt: async () => { attempts += 1; },
      onHeartbeat: async () => { beats += 1; },
    });
    assert.equal(attempts, 3, '每一輪都要通知呼叫端（畫面才不會靜止）');
    assert.ok(beats >= 3, `等待中要回心跳，實際 ${beats} 次`);
  } finally { globalThis.fetch = orig; }
});

test('#190 briefBody：HTTP 失敗的 body 要被壓成一行留在訊息裡', async () => {
  const res = { text: async () => '<html>\n  <body>  error   code: 1042 </body>\n</html>' };
  const out = await briefBody(res);
  assert.match(out, /error code: 1042/, 'HTML 標籤剝掉、空白壓成一格，原文留著');
  assert.ok(!out.includes('<'), '不要把標籤原樣倒給人看');
});

// ===========================================================================
// #190 ⑤⑥（comment 6056 的清單 ／ comment 6069 的裁決）
//   ⑤ 等待不准在單一輪裡硬等三分鐘：subrequests 是**每輪 invocation 各自計費**，
//      免費層只有 50 個，而 leo 的帳號是付費 1000 ⇒ 我們自己怎麼測都測不出來。
//   ⑥ 「網址還在生效中」不准說成「工作流裝失敗」。
//   （④ 依裁決維持既有做法：seed／skills 失敗畫成完成頁警告卡，不讓安裝變 error。）
// ===========================================================================

/** CF 邊緣在「主機名還沒生效」時回的東西：HTML（不是 JSON）。 */
const CF_1016_HTML_E2E = '<html><head><title>530</title></head><body><h1>Error 1016</h1>'
  + '<p>Origin DNS error</p><p>error code: 1016</p></body></html>';

test('#190 ⑤ 一輪只等一小段，等不到就接力——不准吃 waitForWorkerLive 的預設 26 次', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const perRun = Number((src.match(/const WORKFLOW_WAIT_ATTEMPTS_PER_RUN\s*=\s*(\d+)/) || [])[1]);
  const maxRounds = Number((src.match(/const WORKFLOW_WAIT_MAX_ROUNDS\s*=\s*(\d+)/) || [])[1]);
  assert.ok(perRun >= 1 && perRun <= 8,
    '一輪的探測次數要小（每次都是一個 subrequest；免費層一輪只有 50 個，deploy 迴圈已吃掉約 24）');
  assert.ok(maxRounds >= 2, '要能接力多輪，總等待才拉得到 1-2 分鐘以上');
  assert.ok(/until: 'routed'[\s\S]{0,500}maxAttempts: WORKFLOW_WAIT_ATTEMPTS_PER_RUN/.test(src),
    '🔴 e2 的等待必須帶每輪上限——不帶就吃預設 26 次＝單輪硬等三分鐘（1.0.6 的缺陷）');
  assert.ok(/!live\.routed && waitRound < WORKFLOW_WAIT_MAX_ROUNDS[\s\S]{0,300}paused_continue/.test(src),
    '這一輪等不到要標 paused_continue 讓下一輪接力（新 invocation＝新的 subrequest 額度）');
  assert.ok(/progress\.result\.workflowsWaitRounds \|\| 0\) \+ 1/.test(src),
    '輪數要從 progress.result 讀出來 +1——存區域變數的話每輪都從 1 開始＝上限永遠碰不到');
  assert.ok(/onHeartbeat: async \(\) => \{[\s\S]{0,200}progress\.updatedAt = Date\.now\(\)/.test(src),
    '等待中要回心跳，否則 P0-3 stall 偵測會把「正常在等」誤判成「卡死」');
});

test('#190 ⑥ 等不到時說「你的專屬網址還在生效中」，不准說成「工作流裝失敗」', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  assert.ok(/live\.routed[\s\S]{0,300}你的專屬網址還在生效中，所以 AI 工作流還沒裝進去/.test(src),
    '判準要走 live.routed 這個結構化事實，文案分兩種');
  assert.ok(/這不是安裝失敗/.test(src), 'hint 要明說這不是失敗，否則用戶以為壞了');
  assert.ok(!/^\s*throw new InstallError\(`有 \$\{bad\.length\} 條 AI 工作流沒裝成`/m.test(src),
    '🔴 舊那句不准再是唯一出口（1.0.6 的 worker.js:3015 就還是它）');
});

/** 全套 CF API mock ＋ 一台「主機名還沒生效」的實例（打它一律 CF 邊緣 530/1016）。 */
function installFetchWithEdge530() {
  const core = [{
    name: 'arcrun-cypher-executor', main_file: 'core/cy.js', main_module: 'index.js',
    modules: [], compat_date: '2026-01-01', compat_flags: [],
    requires: { kv: ['EXEC_CONTEXT'], d1: [{ binding: 'DB' }] },
  }];
  const state = { deployed: {}, kvByTitle: {}, d1ByName: {}, vectorize: [] };
  return installFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.includes('.acme.workers.dev')) {
      return new Response(CF_1016_HTML_E2E, { status: 530, headers: { 'content-type': 'text/html' } });
    }
    if (url.endsWith('/manifest.json')) return { json: { core } };
    if (url.endsWith('/core/cy.js')) return { text: 'export default { fetch(){ return new Response("ok") } }' };
    if (url.endsWith('/accounts')) return cfOk([{ id: 'acc-a', name: 'A 公司' }]);
    const rr = resourceRuleRoute(url, method, init, state);
    if (rr) return rr;
    if (url.includes('/d1/database/') && url.includes('/query')) return cfOk({});
    if (url.endsWith('/workers/subdomain')) return cfOk({ subdomain: 'acme' });
    if (url.includes('/workers/scripts/') && url.endsWith('/subdomain') && method === 'POST') return cfOk({});
    if (url.includes('/workers/scripts/')) return cfOk({});
    if (url.includes('api.cloudflare.com')) return cfOk({});
    return { status: 404, json: { error: `unhandled ${method} ${url}` } };
  });
}

test('#190 端到端：實例一路回 530 → 這一輪標 paused_continue 去接力，**不是**紅框', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-190b-edge530';
  await seedAccountSession(env, sid);
  installFetchWithEdge530();
  try { await startInstallAndDrain(env, sid, {}); } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.notEqual(p.state, 'error', '「網址還沒生效」不是失敗');
  assert.equal(p.state, 'paused_continue', '要交回既有的分批接力，讓下一輪（新 invocation）繼續等');
  assert.equal(p.result.workflowsWaitRounds, 1, '第一輪等完就交棒，不在單輪硬等三分鐘');
  assert.match(String(p.result.notRoutedYet), /1016/, '留痕要看得到 CF 的原碼');
  assert.match(String(p.steps.find((x) => x.id === 'workflows').note), /生效中/,
    '畫面上要說「還在生效中」，不是靜止也不是報錯');
});

test('#190 端到端：等滿上限仍沒生效 → 才變 error，且說的是「你的專屬網址還在生效中」', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-190b-giveup';
  await seedAccountSession(env, sid);
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const maxRounds = Number(src.match(/const WORKFLOW_WAIT_MAX_ROUNDS\s*=\s*(\d+)/)[1]);
  installFetchWithEdge530();
  try {
    await startInstallAndDrain(env, sid, {});
    // 把輪數推到「再一輪就到上限」，免得真的等滿 15 輪（同一條路徑，只是省時間）
    const mid = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
    mid.result.workflowsWaitRounds = maxRounds - 1;
    await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(mid));
    await startInstallAndDrain(env, sid, {});
  } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(p.state, 'error', '等滿上限還是不通就要誠實停下來（不能變成永遠走不完的進度條）');
  assert.match(p.error.message, /專屬網址還在生效中/, '這是「還沒好」不是「壞了」');
  assert.ok(!/條 AI 工作流沒裝成/.test(p.error.message), '不准講成工作流裝失敗（#190 紅線）');
  assert.match(p.error.hint, /重新安裝/, '要告訴用戶怎麼辦');
  assert.match(p.error.detail, /1016/, '技術細節要留 CF 原碼');
});

test('#190 逃生口不准被自己堵死：等滿上限後按「重新安裝」，這一次要重新等', async () => {
  const env = { INSTALLER_KV: makeKV() };
  const sid = 'sid-190b-retry';
  await seedAccountSession(env, sid);
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const maxRounds = Number(src.match(/const WORKFLOW_WAIT_MAX_ROUNDS\s*=\s*(\d+)/)[1]);
  installFetchWithEdge530();
  try {
    await startInstallAndDrain(env, sid, {});
    const mid = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
    mid.result.workflowsWaitRounds = maxRounds - 1;
    await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(mid));
    await startInstallAndDrain(env, sid, {});           // 碰上限 ⇒ error
    const failed = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
    assert.equal(failed.state, 'error', '前置條件：先進到「等不到」的錯誤狀態');
    await startInstallAndDrain(env, sid, { restart: true });   // 用戶照 hint 按重新安裝
  } finally { restoreFetch(); }
  const p = await env.INSTALLER_KV.get(`prog:${sid}`, 'json');
  assert.equal(p.result.workflowsWaitRounds, 1,
    '重新安裝要從第 1 輪重新等——沿用舊計數的話會立刻再報同一個錯，等於把自己給的逃生口堵死');
  assert.equal(p.state, 'paused_continue', '重新等 ⇒ 又回到接力，不是馬上紅框');
});

test('#190 ④ 依裁決維持：單支 skill 種失敗**不准**讓整個安裝變 error（完成頁警告卡才是出口）', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  // skills 失敗只落 progress.result，讓完成頁去畫；不得在 workflows 步驟丟錯
  assert.ok(/progress\.result\.skillsSeedError = /.test(src), 'skills 失敗要記進 result（給完成頁畫警告卡）');
  assert.ok(!/skillsSeedError[\s\S]{0,200}throw new InstallError/.test(src),
    '🔴 一支 skill 沒種進去不該讓用戶以為整個安裝失敗（comment 6069 裁決）');
});

// ============================================================================
// inkstone/Arcrun#196 — 金鑰目錄那一半：從「打一張不存在的表」改成「呼叫實例端點」
//
// 病因（comment 5973 查出來的那一格）：安裝器自己套的 migration
// `0006_drop_credentials_table.sql` 把 `credentials` 表 DROP 掉了（D38，拆得對），
// 而 `seedCredential()` 之後又去 `INSERT INTO credentials …`
// ⇒ 乾淨帳號上**保證**噴 `no such table: credentials`
// ⇒ 每一台的完成頁都出現「金鑰沒有存進金鑰保管處」，而值那一半其實是成功的。
//
// 這幾格守的是：目錄走端點、值那一半一字不動、命名規則只有一份真相源。
// ============================================================================

/** 假一台實例 ＋ CF API：回傳 calls 陣列供斷言「打了哪些、幾次」。 */
function installFetchForSeedCredential({
  directoryStatus = 200,
  directoryBody = {
    success: true,
    name: 'kbdb_internal_token',
    service: 'kbdb',
    sensitivity: 'high',
    secret_ref: 'CRED_KBDB_INTERNAL_TOKEN_D4C58CE6',
    secret_script: 'arcrun-cypher-executor',
  },
} = {}) {
  return installFetch((url) => {
    if (url.includes('/credentials/directory')) {
      return { status: directoryStatus, json: directoryBody };
    }
    if (/\/workers\/scripts\/[^/]+\/secrets$/.test(url)) return cfOk({});
    return { status: 404, json: { success: false, errors: [{ message: `unexpected ${url}` }] } };
  });
}

test('#196 目錄那一步走實例端點：body 只帶名字，且**一次都沒碰 D1**', async () => {
  const calls = installFetchForSeedCredential();
  let ref;
  try {
    ref = await seedCredential(
      'cf-token', 'acct-1', 'https://arcrun-cypher-executor.demo.workers.dev',
      'ns-demo', 'kbdb_internal_token', 'LIVE-SECRET-VALUE-9f3a', 'kbdb', 'high');
  } finally { restoreFetch(); }

  const dir = calls.find((c) => c.url.includes('/credentials/directory'));
  assert.ok(dir, '要打實例的 /credentials/directory');
  assert.equal(dir.method, 'POST');
  assert.equal(dir.url, 'https://arcrun-cypher-executor.demo.workers.dev/credentials/directory');

  const sent = JSON.parse(dir.body);
  assert.deepEqual(sent, { name: 'kbdb_internal_token', service: 'kbdb', sensitivity: 'high' },
    '端點只寫目錄；帶值的欄位它會 400（不是安靜忽略）⇒ 這裡永遠只准送這三個');
  for (const forbidden of ['value', 'secret', 'token', 'text', 'plaintext']) {
    assert.ok(!(forbidden in sent), `🔴 D36 只准有一條金鑰傳遞路徑，不得把 ${forbidden} 送進目錄端點`);
  }
  assert.ok(!JSON.stringify(sent).includes('LIVE-SECRET-VALUE-9f3a'),
    '🔴 金鑰真身不准出現在目錄那一發裡');

  // 🔴 這一格是本票的正題：舊寫法就是在這裡打 D1，而那張表已經被 DROP 了
  assert.equal(calls.filter((c) => c.url.includes('/d1/database/')).length, 0,
    '🔴 安裝器不准再碰 D1 的 credentials 表（migration 0006 已 DROP 它）');

  assert.equal(ref, 'CRED_KBDB_INTERNAL_TOKEN_D4C58CE6', '回傳的 ref 要是端點給的那一個');
});

test('#196 值那一半照舊、但 secret 名稱與掛載對象一律用端點回的（命名規則只有一份真相源）', async () => {
  const calls = installFetchForSeedCredential({
    directoryBody: {
      success: true, name: 'kbdb_internal_token', service: 'kbdb', sensitivity: 'high',
      // 故意跟安裝器以前自己算的規則不同 ⇒ 證明它照端點走、不是照自己那份複本
      secret_ref: 'CRED_KBDB_INTERNAL_TOKEN_FEEDBEEF',
      secret_script: 'arcrun-cypher-executor',
    },
  });
  try {
    await seedCredential('cf-token', 'acct-1', 'https://x.demo.workers.dev',
      'ns-demo', 'kbdb_internal_token', 'LIVE-SECRET-VALUE-9f3a', 'kbdb', 'high');
  } finally { restoreFetch(); }

  const put = calls.find((c) => /\/workers\/scripts\/[^/]+\/secrets$/.test(c.url));
  assert.ok(put, '值那一半仍由安裝器 PUT 進 CF Workers Secret（D36 第1步不准動）');
  assert.equal(put.method, 'PUT');
  assert.match(put.url, /\/workers\/scripts\/arcrun-cypher-executor\/secrets$/,
    '掛在端點指定的那顆 script 上');
  const body = JSON.parse(put.body);
  assert.equal(body.name, 'CRED_KBDB_INTERNAL_TOKEN_FEEDBEEF',
    '🔴 secret 名稱要照端點回的 ref——安裝器自己算一份就會漂，漂了 WASM 就永遠取不到值');
  assert.equal(body.text, 'LIVE-SECRET-VALUE-9f3a');
  assert.equal(body.type, 'secret_text');

  // 順序不可顛倒：ref 要先拿到才寫得出 secret
  const iDir = calls.findIndex((c) => c.url.includes('/credentials/directory'));
  const iPut = calls.findIndex((c) => /\/workers\/scripts\/[^/]+\/secrets$/.test(c.url));
  assert.ok(iDir >= 0 && iDir < iPut, '① 目錄拿 ref → ② 才寫 secret');
});

test('#196 端點失敗要照實說（不准當成功往下走）', async () => {
  installFetchForSeedCredential({ directoryStatus: 502, directoryBody: { error: 'kbdb 寫不進去' } });
  try {
    await assert.rejects(
      () => seedCredential('cf-token', 'acct-1', 'https://x.demo.workers.dev',
        'ns-demo', 'kbdb_internal_token', 'v', 'kbdb', 'high'),
      /502/, '訊息要保留端點原始狀態碼（#191：判斷不准讀譯文）');
  } finally { restoreFetch(); }
});

test('#196 端點回了缺 secret_ref 的內容 ⇒ 也要當失敗（否則會拿 undefined 當 secret 名字）', async () => {
  const calls = installFetchForSeedCredential({ directoryBody: { success: true, name: 'x' } });
  try {
    await assert.rejects(
      () => seedCredential('cf-token', 'acct-1', 'https://x.demo.workers.dev',
        'ns-demo', 'kbdb_internal_token', 'v', 'kbdb', 'high'),
      /secret_ref/);
    assert.equal(calls.filter((c) => /\/secrets$/.test(c.url)).length, 0,
      '🔴 ref 沒拿到就不准寫 secret——寫成 `CRED_undefined` 是那種「綠燈但取不到」的安靜失敗');
  } finally { restoreFetch(); }
});

test('#196 機械閘：安裝器的可執行碼不准再出現任何 credentials 表的 SQL', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  // 只看會真的跑到的碼；整行註解是病史（上面那段就故意留著舊 SQL 的原文當說明）
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  const banned = [
    /INSERT\s+INTO\s+credentials/i,
    /UPDATE\s+credentials\s+SET/i,
    /DELETE\s+FROM\s+credentials/i,
    /FROM\s+credentials\b/i,
    /CREATE\s+TABLE[^;]*\bcredentials\b/i,   // leo 裁決：金鑰目錄用 KBDB 虛擬表，不准建表回來
  ];
  for (const re of banned) {
    const m = code.match(re);
    assert.equal(m, null,
      `🔴 credentials 表在 migration 0006 就被 DROP 了；打它保證 no such table。命中：${m && m[0]}`);
  }
  // 反向自檢：把舊寫法塞回來，這道閘要當場紅（不然它只是綠燈裝飾）
  const oldLine = "sql: 'INSERT INTO credentials (api_key, name, service, sensitivity, secret_ref, created_at, last_used_at)'";
  assert.ok(banned[0].test(oldLine), '閘要抓得到 2026-09-02 之前那句原生 SQL');
  assert.ok(banned[3].test("sql: 'SELECT secret_ref FROM credentials WHERE api_key = ?'"),
    '閘也要抓得到「只是讀一下」那種變體');
});

test('#196 機械閘：seedCredential 拿到的是實例網址，不是 dbId', async () => {
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  const call = src.match(/await seedCredential\([^)]*\)/);
  assert.ok(call, '找得到 seedCredential 的呼叫點');
  assert.ok(!/\bdbId\b/.test(call[0]),
    `🔴 dbId 是舊路（打 D1）的殘骸，它還在就代表這條線沒真的換家。現況：${call[0]}`);
  assert.match(call[0], /workerUrl/, '要把 cypher 的網址傳進去（端點住在那顆 worker 上）');
});
