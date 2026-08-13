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
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<{ok: boolean, status: number, result?: any, error?: string}>}
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
    return { ok: true, status: res.status, result: data.result };
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
      const result = await cf('/storage/kv/namespaces?per_page=100');
      const map = new Map();
      for (const ns of result) map.set(ns.title, ns.id);
      return map;
    },

    /** @returns {Promise<Map<string, string>>} name → uuid */
    async listD1Databases() {
      /** @type {Array<{uuid: string, name: string}>} */
      const result = await cf('/d1/database?per_page=100');
      const map = new Map();
      for (const db of result) map.set(db.name, db.uuid);
      return map;
    },

    /** @returns {Promise<string[]>} */
    async listVectorizeIndexes() {
      /** @type {Array<{name: string}>} */
      const result = await cf('/vectorize/v2/indexes');
      return (result ?? []).map((i) => i.name);
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
