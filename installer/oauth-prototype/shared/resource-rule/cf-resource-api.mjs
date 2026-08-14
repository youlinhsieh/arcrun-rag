// @ts-check
/**
 * cf-resource-api.mjs — 規則的**眼睛與手**：對 Cloudflare 帳號的那七個動作，也只有一份。
 *
 * `rule.mjs` 是純判斷，IO 由呼叫端注入（`ResourceApi`）。本檔就是那個注入物的正貨：
 * 用 CF REST API 實作 `ResourceApi`，零依賴、只用 global `fetch`
 * ⇒ Node 18+ 與 Cloudflare Workers runtime 都能直接跑。
 *
 * 【為什麼連這層也要共用】
 * 判斷一致還不夠——**看到的東西**也要一致。
 * 「已部署的 worker 綁著什麼」是從 `GET /workers/scripts/{script}/settings` 讀來的；
 * 如果兩條路各自寫一份 client，隨便一個差異（打錯端點、把 404 當錯誤、漏了 per_page、
 * 少認一種欄位名）都會讓其中一條路「看不到既有綁定」——而看不到既有綁定的下一步，
 * 依規則就是**新建**。Arcrun#97 的災情不需要規則寫錯，只要眼睛不一樣就會重演。
 *
 * 這裡**故意只有 `ResourceApi` 那七個方法**。verifyAccess / 查 subdomain / KV 讀寫
 * 這些跟「該用哪些資源」無關的帳號操作留在各自的呼叫端，不往共用層堆。
 *
 * 🔴 除了同目錄的 `./rule.mjs`，這支不准 import 任何東西——共用層的價值在於
 *    「整個目錄複製到哪個 runtime 都能直接跑」，多一個外部依賴就少一條路吃得到。
 */

import { normalizeLiveBindings, normalizeLiveVars } from './rule.mjs';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 清單端點每頁抓幾筆。100 是 CF 這幾支端點通用的安全上限（KV 官方上限就是 100）。
 * 這個數字**不影響正確性**——`cfListAll` 會一直翻到底；它只決定要打幾次 API。
 */
const LIST_PER_PAGE = 100;

/**
 * 翻頁的安全上限。100 頁 × 100 筆 ＝ 10,000 顆，遠超 CF 的帳號上限
 * （KV namespace 每帳號 1,000）⇒ 正常帳號永遠碰不到。
 * 碰到了就是 CF 那邊的行為變了，這種時候**寧可 throw 也不回一份不完整的清單**。
 */
const LIST_MAX_PAGES = 100;

/**
 * @typedef {import('./rule.mjs').ResourceApi} ResourceApi
 * @typedef {import('./rule.mjs').ScriptBindings} ScriptBindings
 * @typedef {import('./rule.mjs').RawWorkerBinding} RawWorkerBinding
 */

/**
 * @typedef {object} CfResourceApiOptions
 * @property {string} accountId
 * @property {string} apiToken
 * @property {typeof globalThis.fetch} [fetch]
 *   注入用（離線測試餵假帳號、或宿主要用自己的 fetch）。預設 global fetch。
 */

/**
 * 建一個打真實 Cloudflare 的 `ResourceApi`。
 *
 * @param {CfResourceApiOptions} options
 * @returns {ResourceApi & { cfRaw: (path: string, init?: RequestInit) => Promise<{ok: boolean, status: number, result?: any, error?: string}> }}
 */
export function createCloudflareResourceApi({ accountId, apiToken, fetch: fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createCloudflareResourceApi：這個執行環境沒有 fetch，請用 options.fetch 注入。');
  }
  const accountBase = `${CF_API_BASE}/accounts/${accountId}`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  /**
   * 把 HTTP status 交回呼叫端自己判斷（要區分「404 不存在」和「其他錯誤」時用）。
   * `resultInfo` ＝ CF 回應裡的 `result_info`（不分頁的端點是 `null`），`cfListAll` 靠它翻頁。
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<{ok: boolean, status: number, result?: any, resultInfo?: any, error?: string}>}
   */
  async function cfRaw(path, init) {
    const res = await doFetch(`${accountBase}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      return {
        ok: false,
        status: res.status,
        error:
          (data?.errors ?? []).map((/** @type {{message?: string}} */ e) => e.message).filter(Boolean).join('; ') ||
          `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, result: data.result, resultInfo: data?.result_info ?? null };
  }

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<any>}
   */
  async function cf(path, init) {
    const { ok, status, result, error } = await cfRaw(path, init);
    if (!ok) throw new Error(`CF API ${path} 失敗：${error ?? `HTTP ${status}`}`);
    return result;
  }

  /**
   * 把一支「列出帳號上有什麼」的端點**翻到底**，回傳全部項目。
   *
   * 【為什麼非翻不可——這是 Arcrun#123 的續集，不是效能優化】
   * 三支清單方法原本只打 `?per_page=100`，也就是**只看第一頁**。同一個截斷，
   * 在 #123 的修法前後，後果**不一樣**：
   *
   * | 被截掉的那顆 | 規則走到哪 | 結果 |
   * |---|---|---|
   * | #123 修好**前**：worker 綁著它，但它落在第二頁 | 2b 判「綁著的資源不見了」 | 產生 blocker，**停手**（過度保守，但安全） |
   * | #123 修好**後**：名字落在第二頁 | 2c 判「這個名字沒被佔走」 | **去建 → CF 回 title already exists ⇒ #123 的死路原樣回來** |
   *
   * ⇒ 修法把這個洞從「叫得太大聲」變成「**安靜地復發**」。所以規約是：
   * **看不完整就不准當作看完了**——翻不完、或翻出來的數量對不上 CF 自己回報的
   * `total_count`，一律 throw，讓 `planResources` 把它變成 blocker
   * （README 規則第 3 條：說不準就整趟停手，一顆都不建）。
   *
   * 【三支端點的分頁行為不一樣，這裡刻意不假設它們同款】（2026-08-14 在 geek6688 帳號實測）
   * - `/storage/kv/namespaces`：真分頁，`result_info` ＝ `{page, per_page, count, total_count, total_pages}`
   * - `/d1/database`：真分頁，但 `result_info` **沒有 `total_pages`**（實測 `{page, per_page, count, total_count}`）
   *   ⇒ **不准拿 `total_pages` 當終止條件**，那個欄位在 D1 上是 `undefined`
   * - `/vectorize/v2/indexes`：**不分頁**，`result_info` 是 `null`，帶 `page`／`per_page` 也被忽略（一次回全部）
   *
   * 所以終止條件只用「三支都有、或三支都沒有」的兩件事：`result_info` 在不在、`total_count` 對不對得上。
   * 對不分頁的那支，這支等於只打一次就回來（那兩個被忽略的參數實測無害）；
   * 而萬一 CF 哪天替它補上分頁，這支會自己跟著翻——不必等下一次災情才想起來改。
   *
   * @param {string} path 不含分頁參數的端點路徑（可自帶其他 query）
   * @param {string} what 出錯訊息裡怎麼稱呼它
   * @returns {Promise<any[]>}
   */
  async function cfListAll(path, what) {
    /** @type {any[]} */
    const items = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await cfRaw(`${path}${sep}per_page=${LIST_PER_PAGE}&page=${page}`);
      if (!res.ok) {
        throw new Error(`列 ${what} 失敗（第 ${page} 頁）：${res.error ?? `HTTP ${res.status}`}`);
      }
      const batch = Array.isArray(res.result) ? res.result : [];
      items.push(...batch);

      const info = res.resultInfo;
      // 這支端點沒有分頁（Vectorize v2）⇒ 這一趟拿到的就是全部。
      if (!info) return items;

      const total = Number(info.total_count);
      if (Number.isFinite(total)) {
        if (items.length >= total) return items;
        // CF 說還有，卻一筆都不給 ⇒ 我們看不到全部。**不准安靜地當作看完了。**
        if (batch.length === 0) {
          throw new Error(
            `列 ${what} 只讀到 ${items.length} 筆，但 Cloudflare 說共有 ${total} 筆，第 ${page} 頁卻是空的。` +
              `看不到帳號上的全部資源就沒辦法判斷該不該新建——停手。`,
          );
        }
        continue; // total_count 說還有就繼續翻（不看 total_pages：D1 根本沒這個欄位）
      }

      // 沒有 total_count 可對，只剩「這一頁沒裝滿 ⇒ 沒有下一頁」可用。
      if (batch.length < LIST_PER_PAGE) return items;
    }
    throw new Error(
      `列 ${what} 翻超過 ${LIST_MAX_PAGES} 頁還沒到底（已讀 ${items.length} 筆）。` +
        `這不正常，寧可停手，也不拿一份不完整的清單去判斷該不該新建資源。`,
    );
  }

  return {
    cfRaw,

    /**
     * 讀一顆已部署 worker 現在綁著哪些資源——**使用者那側的事實**（Arcrun#97 的唯一真相源）。
     *
     * - script 不存在（404）→ `{ deployed: false }`，這是「還沒部署」，不是錯誤。
     * - 其他任何失敗 → throw。呼叫端必須把它當「我不知道」而**不是**「它沒有」——
     *   把查不到當成不存在，就是 #97 的根因。
     *
     * @param {string} script
     * @returns {Promise<ScriptBindings>}
     */
    async getScriptBindings(script) {
      const path = `/workers/scripts/${encodeURIComponent(script)}/settings`;
      const res = await cfRaw(path);
      if (!res.ok) {
        if (res.status === 404) return { deployed: false, bindings: [], vars: {} };
        throw new Error(`讀 ${script} 綁定失敗：${res.error}`);
      }
      /** @type {RawWorkerBinding[]} */
      const raw = res.result?.bindings ?? [];
      return {
        deployed: true,
        bindings: normalizeLiveBindings(raw),
        vars: normalizeLiveVars(raw),
      };
    },

    /** @returns {Promise<Map<string, string>>} title → id */
    async listKvNamespaces() {
      /** @type {Array<{id: string, title: string}>} */
      // 翻到底才算數（只看第一頁會讓 Arcrun#123 安靜復發，理由見 cfListAll）
      const result = await cfListAll('/storage/kv/namespaces', 'KV namespace');
      const map = new Map();
      for (const ns of result) map.set(ns.title, ns.id);
      return map;
    },

    /** @returns {Promise<Map<string, string>>} name → uuid */
    async listD1Databases() {
      /** @type {Array<{uuid: string, name: string}>} */
      // 翻到底才算數。D1 的 result_info **沒有 total_pages**，所以終止條件只認 total_count。
      const result = await cfListAll('/d1/database', 'D1 資料庫');
      const map = new Map();
      for (const db of result) map.set(db.name, db.uuid);
      return map;
    },

    /** @returns {Promise<string[]>} */
    async listVectorizeIndexes() {
      /** @type {Array<{name: string}>} */
      // 這支端點**目前不分頁**（`result_info` 是 null），走 cfListAll 等同只打一次；
      // 但 CF 哪天替它補上分頁，這裡會自己跟著翻，不必等下一次災情才想起來改。
      const result = await cfListAll('/vectorize/v2/indexes', 'Vectorize index');
      return result.map((i) => i.name);
    },

    /**
     * 無條件新建一顆 KV namespace。
     *
     * 🔴 Arcrun#97：這裡**故意沒有**「找不到同名就順手建一顆」的 ensure 版本。
     * 「照名字找 → 找不到 → 新建 → 綁上去」正是把使用者實例洗成空的那條路
     * （安裝器取的名字跟 binding 名不一樣，永遠對不上 ⇒ 每次更新都新建）。
     * 要不要建一律先過 `planResources`。
     *
     * @param {string} title
     * @returns {Promise<string>}
     */
    async createKvNamespace(title) {
      const result = await cf('/storage/kv/namespaces', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      return result.id;
    },

    /**
     * 無條件新建 D1。沒有 ensure 版本，理由同 createKvNamespace（Arcrun#97）。
     * @param {string} name
     * @returns {Promise<string>}
     */
    async createD1Database(name) {
      const result = await cf('/d1/database', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return result.uuid;
    },

    /**
     * 新建 KBDB embed 用的 Vectorize index（**bge-m3 = 1024 維 / cosine**）。
     * 已存在（409 / already exists）視為成功——並行或重跑不該炸。
     * 沒有 ensure 版本：「要不要建」由 planResources 判斷，這裡只負責建（Arcrun#97）。
     *
     * @param {string} name
     * @returns {Promise<string>}
     */
    async createVectorizeIndex(name) {
      const res = await cfRaw('/vectorize/v2/indexes', {
        method: 'POST',
        body: JSON.stringify({
          name,
          config: { dimensions: 1024, metric: 'cosine' },
          description: 'arcrun KBDB embed module — bge-m3 1024d (issue #7 / #59)',
        }),
      });
      if (res.ok) return name;
      const detail = (res.error ?? '').toLowerCase();
      if (res.status === 409 || /already exists|duplicate|conflict/.test(detail)) return name;
      throw new Error(`建 Vectorize index ${name} 失敗：${res.error}`);
    },
  };
}
