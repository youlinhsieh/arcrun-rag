// @ts-check
/**
 * installer-entry.mjs — 安裝器那條路的**唯一入口**。
 *
 * 安裝器（arcrun-rag `installer/oauth-prototype/worker.js`）不必、也不准自己判斷
 * 「該建哪些資源」——它只要呼叫這一支，拿回「每個 binding 該用哪顆資源」。
 *
 * ```js
 * import { resolveInstanceResources } from './shared/resource-rule/installer-entry.mjs';
 *
 * const r = await resolveInstanceResources({
 *   accountId, apiToken,
 *   wranglerTomls: [cypherToml, registryToml, mcpToml, kbdbToml],  // 字串陣列
 *   mode: isUpdate ? 'update' : 'init',
 * });
 * if (r.blocked) {
 *   // 🔴 一顆資源都沒被建。把 r.blockers 原文顯示給使用者，**不要自己「試著繼續」**。
 *   return showAndStop(r.blockers);
 * }
 * // r.bindings: { 'kv_namespace:WEBHOOKS': 'kvid-…', 'd1:DB': 'uuid-…', … }
 * // r.liveVars: { 'arcrun-cypher-executor': { ARCRUN_BUNDLE_VERSION: '1.4.33', … } }
 * ```
 *
 * 為什麼安裝器不需要副本：安裝器本來就會下載本 repo 的 archive 當部署來源
 * （見 `.claude/rules/05-deploy-convention.md`「WASM 來源」），
 * `shared/resource-rule/` 就在那份 archive 裡，直接 import 即可——
 * **不必再編一次、不必貼一份、也就不會有第二種答案。**
 */

import { planResources, applyResourcePlan, parseWranglerRequirements, ResourcePlanBlocked } from './rule.mjs';
import { createCloudflareResourceApi } from './cf-resource-api.mjs';

/**
 * @typedef {object} ResolveOptions
 * @property {string} accountId
 * @property {string} apiToken
 * @property {string[]} wranglerTomls  各 worker 的 wrangler.toml **內容**（不是路徑）。
 * @property {'update' | 'init'} mode  這台照定義裝過了沒。
 * @property {typeof globalThis.fetch} [fetch]  注入用（測試／宿主自帶 fetch）。
 */

/**
 * @typedef {object} ResolveResult
 * @property {boolean} blocked            true = 什麼都沒建、什麼都不該部署。
 * @property {string[]} blockers          blocked 時的原因原文（要原樣轉給使用者）。
 * @property {Record<string, string>} bindings   `${kind}:${binding}` → 資源 id／index 名。
 * @property {Record<string, 'adopted'|'created'>} origin  同上 key → 這顆是沿用還是新建。
 * @property {Record<string, Record<string, string>>} liveVars  script → 現有 plain_text var（#106）。
 */

/**
 * 決定這台實例每個 binding 該用哪顆資源；照規則沿用既有、只在確定沒人綁過時才新建。
 *
 * @param {ResolveOptions} options
 * @returns {Promise<ResolveResult>}
 */
export async function resolveInstanceResources({ accountId, apiToken, wranglerTomls, mode, fetch }) {
  const api = createCloudflareResourceApi({ accountId, apiToken, fetch });

  /** @type {import('./rule.mjs').BindingRequirement[]} */
  const requirements = [];
  for (const toml of wranglerTomls) {
    const parsed = parseWranglerRequirements(toml);
    if (!parsed.script) continue;  // 沒宣告 name 的 toml 不該存在；跳過而非亂猜
    for (const b of parsed.bindings) requirements.push({ ...b, worker: parsed.script });
  }

  /** @param {string[]} blockers @returns {ResolveResult} */
  const stop = (blockers) => ({ blocked: true, blockers, bindings: {}, origin: {}, liveVars: {} });

  if (requirements.length === 0) {
    return stop(['這批 wrangler.toml 裡讀不到任何資源綁定需求——不確定要裝什麼，停手。']);
  }

  let plan;
  try {
    plan = await planResources(api, requirements, mode);
  } catch (e) {
    return stop([`資源解析失敗（${e instanceof Error ? e.message : String(e)}）。沒有建立任何資源。`]);
  }
  if (plan.blockers.length > 0) return stop(plan.blockers);

  /** @type {Map<string, import('./rule.mjs').ResolvedResource>} */
  let resolved;
  try {
    resolved = await applyResourcePlan(api, plan);
  } catch (e) {
    return stop(e instanceof ResourcePlanBlocked ? e.blockers : [e instanceof Error ? e.message : String(e)]);
  }

  /** @type {Record<string, string>} */
  const bindings = {};
  /** @type {Record<string, 'adopted'|'created'>} */
  const origin = {};
  for (const [key, r] of resolved) {
    bindings[key] = r.value;
    origin[key] = r.origin;
  }
  return { blocked: false, blockers: [], bindings, origin, liveVars: Object.fromEntries(plan.liveVars) };
}
