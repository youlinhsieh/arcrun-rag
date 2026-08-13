// @ts-check
/**
 * fixture-account.mjs — 一個假的 Cloudflare 帳號，做成 **`fetch` 替身**。
 *
 * 【為什麼是 fetch 替身，不是假的 ResourceApi 物件】
 * 本票要證的是「`acr` 那條與安裝器那條，跑出來的決定必須一致」。
 * 如果兩條路各自餵一個假的 `ResourceApi`，那就只測到了 `rule.mjs` 的判斷，
 * **完全跳過了「怎麼把 CF 回應讀成事實」**——而 Arcrun#97 的重演只需要眼睛不一樣就夠了
 * （一邊把 404 當錯誤、一邊漏認 `namespace_id`…）。
 * 從 `fetch` 這一層假起，兩條路就是真的走完整條鏈：HTTP → 解析 → 判斷。
 *
 * 零依賴、純 ESM，Node 與 Workers 都能跑。
 */

/** arcrun 各 worker 在 wrangler.toml 裡宣告的 KV binding 名（= 需求，不是資源名）。 */
export const KV_BINDINGS = [
  'WEBHOOKS', 'CREDENTIALS_KV', 'RECIPES', 'USERS_KV', 'SESSIONS_KV',
  'ANALYTICS_KV', 'EXEC_CONTEXT', 'SUBMISSIONS_KV', 'OAUTH_KV',
];

/** 這台實例上有資源綁定的四顆 worker，以及各自需要的綁定。 */
export const WORKER_NEEDS = {
  'arcrun-cypher-executor': {
    kv: ['EXEC_CONTEXT', 'WEBHOOKS', 'CREDENTIALS_KV', 'ANALYTICS_KV', 'RECIPES', 'USERS_KV', 'SESSIONS_KV'],
    d1: [{ binding: 'CREDENTIALS_DB', database_name: 'arcrun-kbdb' }],
  },
  'arcrun-registry': { kv: ['SUBMISSIONS_KV', 'ANALYTICS_KV'], d1: [] },
  'arcrun-mcp': { kv: ['OAUTH_KV'], d1: [] },
  'arcrun-kbdb': { kv: [], d1: [{ binding: 'DB', database_name: 'arcrun-kbdb' }] },
};

/**
 * 把 WORKER_NEEDS 攤成 `BindingRequirement[]`——兩條路都用**同一份需求**進去，
 * 才能證明差異（如果有）來自實作而不是輸入。
 * @returns {Array<{kind: 'kv_namespace'|'d1', binding: string, worker: string, createName: string}>}
 */
export function requirements() {
  const out = [];
  for (const [worker, need] of Object.entries(WORKER_NEEDS)) {
    for (const b of need.kv) out.push({ kind: 'kv_namespace', binding: b, worker, createName: b });
    for (const d of need.d1) {
      out.push({ kind: 'd1', binding: d.binding, worker, createName: d.database_name });
    }
  }
  return out;
}

/**
 * 三種情境。`titleFor` 決定「使用者帳號上那顆資源實際叫什麼名字」——
 * 這正是 #97 的病根所在：規則**不准**拿名字當識別。
 *
 * @typedef {'fresh' | 'installed' | 'renamed'} Scenario
 */

/** @type {Record<Scenario, {label: string, deployed: boolean, titleFor: (binding: string) => string}>} */
export const SCENARIOS = {
  fresh: {
    label: '沒裝過（全新帳號，一顆 worker 都沒有）',
    deployed: false,
    titleFor: (b) => b,
  },
  installed: {
    label: '裝過了（安裝器命名慣例 arcrun-rag-<instance>-kv-<binding>）',
    deployed: true,
    titleFor: (b) => `arcrun-rag-yuga3bse-kv-${b.toLowerCase()}`,
  },
  renamed: {
    label: '資源在，但名字與預期完全不同（使用者自己改過／別的安裝器版本取的名）',
    deployed: true,
    // 刻意取成跟 binding 名毫無關聯的字串：只要規則有一絲「照名字對號」就會在這裡露餡。
    titleFor: (b) => `kv-${[...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`,
  },
};

/**
 * 建一個假帳號 + 對應的 `fetch` 替身。
 *
 * @param {Scenario} scenario
 * @returns {{
 *   fetch: typeof globalThis.fetch,
 *   created: {kv: string[], d1: string[], vectorize: string[]},
 *   userData: {workflows: string[], sessions: string[], libraries: string[]},
 *   kvIdFor: (binding: string) => string | undefined,
 *   d1Id: string,
 *   requestLog: string[],
 * }}
 */
export function makeAccount(scenario) {
  const spec = SCENARIOS[scenario];
  /** title → id */
  const kv = new Map();
  /** name → uuid */
  const d1 = new Map();
  /** @type {string[]} */
  const vectorize = [];
  /** script → CF `/settings` 回應裡的 bindings[] 原始形狀 */
  const scripts = new Map();

  const created = { kv: [], d1: [], vectorize: [] };
  const requestLog = [];

  // 使用者的東西——驗「更新完還在不在」用。掛在資源 id 上，不是掛在名字上。
  const userData = {
    workflows: ['webhook:leo:daily-digest', 'webhook:leo:inbox-sync', 'webhook:leo:rag-ingest'],
    sessions: ['session:leo-abc123'],
    libraries: ['general', '課程', '客戶', '研究'],
  };

  const kvIdByBinding = new Map();
  const D1_ID = 'd1id-kbdb-REAL';

  if (spec.deployed) {
    // 帳號上已經有的資源（名字照該情境的慣例取，id 才是身分）
    for (const b of KV_BINDINGS) {
      const id = `kvid-${b.toLowerCase()}-REAL`;
      kv.set(spec.titleFor(b), id);
      kvIdByBinding.set(b, id);
    }
    d1.set('arcrun-rag-yuga3bse-kbdb', D1_ID);

    // 已部署的 worker 上綁著它們——**這才是規則要看的事實**
    for (const [script, need] of Object.entries(WORKER_NEEDS)) {
      const bindings = [];
      for (const b of need.kv) {
        bindings.push({ type: 'kv_namespace', name: b, namespace_id: kvIdByBinding.get(b) });
      }
      for (const d of need.d1) bindings.push({ type: 'd1', name: d.binding, id: D1_ID });
      // #106：plain_text var 也在同一份回應裡
      bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: '1.4.33' });
      scripts.set(script, bindings);
    }
  }

  /** @param {unknown} result @param {number} [status] */
  const ok = (result, status = 200) =>
    new Response(JSON.stringify({ success: true, result, errors: [] }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  /** @param {string} message @param {number} status */
  const fail = (message, status) =>
    new Response(JSON.stringify({ success: false, result: null, errors: [{ message }] }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  /** @type {typeof globalThis.fetch} */
  // @ts-expect-error — 測試替身只實作用得到的那幾條路徑
  const fakeFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    requestLog.push(`${method} ${path}${url.search}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    // 已部署 worker 的綁定
    const m = path.match(/^\/workers\/scripts\/([^/]+)\/settings$/);
    if (m && method === 'GET') {
      const script = decodeURIComponent(m[1]);
      if (!scripts.has(script)) return fail('workers.api.error.script_not_found', 404);
      return ok({ bindings: scripts.get(script) });
    }

    if (path === '/storage/kv/namespaces' && method === 'GET') {
      return ok([...kv].map(([title, id]) => ({ id, title })));
    }
    if (path === '/storage/kv/namespaces' && method === 'POST') {
      const id = `kvid-NEW-${created.kv.length + 1}`;
      kv.set(body.title, id);
      created.kv.push(body.title);
      return ok({ id, title: body.title });
    }
    if (path === '/d1/database' && method === 'GET') {
      return ok([...d1].map(([name, uuid]) => ({ uuid, name })));
    }
    if (path === '/d1/database' && method === 'POST') {
      const uuid = `d1id-NEW-${created.d1.length + 1}`;
      d1.set(body.name, uuid);
      created.d1.push(body.name);
      return ok({ uuid, name: body.name });
    }
    if (path === '/vectorize/v2/indexes' && method === 'GET') {
      return ok(vectorize.map((name) => ({ name })));
    }
    if (path === '/vectorize/v2/indexes' && method === 'POST') {
      vectorize.push(body.name);
      created.vectorize.push(body.name);
      return ok({ name: body.name });
    }

    return fail(`fixture 沒有實作這條路徑：${method} ${path}`, 501);
  };

  return {
    fetch: fakeFetch,
    created,
    userData,
    kvIdFor: (binding) => kvIdByBinding.get(binding),
    d1Id: D1_ID,
    requestLog,
  };
}
