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

/** 安裝器替這台實例算出來的名字前綴（`arcrun-rag-<slugFromEmail(email)>`）。 */
export const BASE_NAME = 'arcrun-rag-yuga3bse';

/**
 * 四種情境。`titleFor` 決定「使用者帳號上那顆資源實際叫什麼名字」——
 * 這正是 #97 的病根所在：規則**不准**拿名字當識別。
 *
 * `resourcesExist` 與 `deployed` **刻意拆開**：兩者不一致的那一格
 * （資源在、worker 不在）就是 Arcrun#123 ——「上一次裝到一半死掉」的帳號。
 * 本檔原本只有 `deployed` 一個旗標，所以那個狀態**表達不出來，也就沒被測到**。
 *
 * @typedef {'fresh' | 'installed' | 'renamed' | 'half-finished'} Scenario
 */

/** @type {Record<Scenario, {label: string, deployed: boolean, resourcesExist?: boolean, d1Title?: string, titleFor: (binding: string) => string}>} */
export const SCENARIOS = {
  fresh: {
    label: '沒裝過（全新帳號，一顆 worker 都沒有）',
    deployed: false,
    titleFor: (b) => b,
  },
  installed: {
    label: '裝過了（安裝器命名慣例 arcrun-rag-<instance>-kv-<binding>）',
    deployed: true,
    titleFor: (b) => `${BASE_NAME}-kv-${b.toLowerCase()}`,
  },
  renamed: {
    label: '資源在，但名字與預期完全不同（使用者自己改過／別的安裝器版本取的名）',
    deployed: true,
    // 刻意取成跟 binding 名毫無關聯的字串：只要規則有一絲「照名字對號」就會在這裡露餡。
    titleFor: (b) => `kv-${[...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`,
  },
  'half-finished': {
    label: '上一次裝到一半死掉（KV/D1 已建在帳號上，一顆 worker 都還沒部署）— Arcrun#123',
    deployed: false,
    resourcesExist: true,
    titleFor: (b) => `${BASE_NAME}-kv-${b.toLowerCase()}`,
    // 這顆殘骸是**安裝器**留下的 ⇒ 名字要照安裝器真正會取的那個（`-db`），
    // 不是上面兩個情境沿用的歷史名（`-kbdb`）。名字不對，這個測試就測不到真的那條路。
    d1Title: `${BASE_NAME}-db`,
  },
};

/**
 * 安裝器那條路的需求清單：`createName` 是**安裝器自己替這台實例算出來的**，
 * 所以它有資格聲明 `createNameIsOurs`（見 rule.mjs 該欄位的推導條件）。
 *
 * 對照 `requirements()`（走 wrangler.toml，createName 是裸 binding 名 ⇒ **不得**聲明）。
 *
 * @param {boolean} [claimOwnership] 預設 true；傳 false 就是「安裝器忘了聲明」的對照組。
 */
export function installerRequirements(claimOwnership = true, d1CreateName = `${BASE_NAME}-kbdb`) {
  const out = [];
  for (const [worker, need] of Object.entries(WORKER_NEEDS)) {
    for (const b of need.kv) {
      out.push({
        kind: 'kv_namespace', binding: b, worker,
        createName: `${BASE_NAME}-kv-${b.toLowerCase()}`,
        ...(claimOwnership ? { createNameIsOurs: true } : {}),
      });
    }
    for (const d of need.d1) {
      out.push({
        kind: 'd1', binding: d.binding, worker,
        createName: d1CreateName,
        ...(claimOwnership ? { createNameIsOurs: true } : {}),
      });
    }
  }
  return out;
}

/**
 * 真實 CF 的行為：**同名建不出來**（KV 回 400「a namespace with this account ID and title
 * already exists」，D1 回 code 7502「Database with name … already exists」——兩條都在
 * `geek6688` 帳號上實打驗過）。這一層就是封測者撞到的那道牆。
 *
 * fixture 過去沒有模擬它，所以「重建一批孤兒」這個假設從來沒被戳破（Arcrun#123）。
 *
 * 🔴 這支**自己會翻頁**（`per_page` 開很大）。它要是只看第一頁，就會在
 * 「帳號上資源很多」的測試裡漏認同名 ⇒ 反而把被測的 bug 蓋住。
 *
 * @param {ReturnType<typeof makeAccount>} account
 * @returns {typeof globalThis.fetch}
 */
export function cfRejectsDuplicateNames(account) {
  const inner = account.fetch;
  const BASE = 'https://api.cloudflare.com/client/v4/accounts/x';
  /** @param {string} path @returns {Promise<any[]>} */
  const listAll = async (path) => {
    const res = await inner(`${BASE}${path}?per_page=100000&page=1`, {});
    return (await res.json()).result ?? [];
  };
  /** @param {string} message */
  const conflict = (message) =>
    new Response(JSON.stringify({ success: false, result: null, errors: [{ message }] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

  /** @type {typeof globalThis.fetch} */
  // @ts-expect-error — 測試替身
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && (path === '/storage/kv/namespaces' || path === '/d1/database')) {
      const body = JSON.parse(String(init?.body));
      if (path === '/storage/kv/namespaces') {
        const taken = (await listAll(path)).some((/** @type {{title: string}} */ n) => n.title === body.title);
        if (taken) return conflict('a namespace with this account ID and title already exists');
      } else {
        const taken = (await listAll(path)).some((/** @type {{name: string}} */ d) => d.name === body.name);
        if (taken) return conflict(`Database with name: '${body.name}' already exists`);
      }
    }
    return inner(input, init);
  };
}

/**
 * 建一個假帳號 + 對應的 `fetch` 替身。
 *
 * @param {object} [opts]
 * @param {number} [opts.decoyKv] 帳號上另外還有幾顆「別人的」KV（排在我們的前面）
 * @param {number} [opts.decoyD1] 同上，D1
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
export function makeAccount(scenario, opts = {}) {
  const spec = SCENARIOS[scenario];
  // 「這個帳號上還有很多**別人的**資源」。用途：把我們自己那幾顆擠到第二頁以後，
  // 驗清單有沒有翻頁。CF 的 KV 上限是每帳號 1,000 顆，>100 是真實會發生的規模。
  const decoyKv = opts.decoyKv ?? 0;
  const decoyD1 = opts.decoyD1 ?? 0;
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

  // 誘餌**先塞**，我們自己的才排在它們後面 ⇒ 只看第一頁就一定看不到我們的那幾顆。
  // （真 CF 的排序不歸我們管；這裡刻意排成「最壞情況」，因為要證的正是最壞情況下也看得到。）
  for (let i = 0; i < decoyKv; i++) kv.set(`someone-elses-kv-${String(i).padStart(4, '0')}`, `kvid-decoy-${i}`);
  for (let i = 0; i < decoyD1; i++) d1.set(`someone-elses-db-${String(i).padStart(4, '0')}`, `d1id-decoy-${i}`);

  // 資源存不存在，與 worker 部署了沒，是**兩件事**（#123：中斷的安裝會讓前者為真、後者為假）。
  if (spec.resourcesExist ?? spec.deployed) {
    // 帳號上已經有的資源（名字照該情境的慣例取，id 才是身分）
    for (const b of KV_BINDINGS) {
      const id = `kvid-${b.toLowerCase()}-REAL`;
      kv.set(spec.titleFor(b), id);
      kvIdByBinding.set(b, id);
    }
    d1.set(spec.d1Title ?? `${BASE_NAME}-kbdb`, D1_ID);
  }

  if (spec.deployed) {
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

  /**
   * 分頁的清單回應——**照真 Cloudflare 的形狀**，不是照我們方便的形狀。
   *
   * 【這些假資料憑什麼代表得了真的 CF 回應】
   * 2026-08-14 拿 `geek6688` 帳號實打過三支端點（唯讀，只列不建），逐字抄回來的：
   *
   * ```
   * GET /storage/kv/namespaces?per_page=5&page=1
   *   → result_info {"count":5,"page":1,"per_page":5,"total_count":9,"total_pages":2}
   * GET /storage/kv/namespaces?per_page=5&page=2
   *   → 4 筆，result_info {"count":4,"page":2,"per_page":5,"total_count":9,"total_pages":2}
   * GET /d1/database?per_page=5&page=1
   *   → result_info {"count":1,"page":1,"per_page":5,"total_count":1}      ← **沒有 total_pages**
   * GET /vectorize/v2/indexes?per_page=1&page=1
   *   → 2 筆（分頁參數被忽略），result_info: null                          ← **這支不分頁**
   * ```
   *
   * 🔴 **三支的形狀不一樣，這裡就必須不一樣**。假資料要是三支都長成 KV 那樣，
   * 就會養出「拿 `total_pages` 當終止條件」這種在 D1 上必壞的實作，而測試全綠。
   * 假資料失真＝測了個假的，比沒測更糟。
   *
   * @param {any[]} all 這個端點上「全部」的東西
   * @param {URLSearchParams} q 呼叫端帶來的分頁參數
   * @param {{totalPages: boolean}} shape 這支端點的 result_info 帶不帶 total_pages
   */
  const okPaged = (all, q, shape) => {
    const perPage = Number(q.get('per_page')) || 20;
    const page = Number(q.get('page')) || 1;
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const info = {
      count: slice.length,
      page,
      per_page: perPage,
      total_count: all.length,
      ...(shape.totalPages ? { total_pages: Math.max(1, Math.ceil(all.length / perPage)) } : {}),
    };
    return new Response(JSON.stringify({ success: true, result: slice, errors: [], result_info: info }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
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
      // 真分頁，result_info 帶 total_pages（實測形狀，見 okPaged）
      return okPaged([...kv].map(([title, id]) => ({ id, title })), url.searchParams, { totalPages: true });
    }
    if (path === '/storage/kv/namespaces' && method === 'POST') {
      const id = `kvid-NEW-${created.kv.length + 1}`;
      kv.set(body.title, id);
      created.kv.push(body.title);
      return ok({ id, title: body.title });
    }
    if (path === '/d1/database' && method === 'GET') {
      // 真分頁，但 result_info **沒有 total_pages**（實測形狀，見 okPaged）
      return okPaged([...d1].map(([name, uuid]) => ({ uuid, name })), url.searchParams, { totalPages: false });
    }
    if (path === '/d1/database' && method === 'POST') {
      const uuid = `d1id-NEW-${created.d1.length + 1}`;
      d1.set(body.name, uuid);
      created.d1.push(body.name);
      return ok({ uuid, name: body.name });
    }
    if (path === '/vectorize/v2/indexes' && method === 'GET') {
      // 這支**不分頁**：分頁參數被忽略、`result_info` 是 null（實測，見 okPaged 檔頭那段）
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
