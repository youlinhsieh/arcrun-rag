/**
 * 寫入授權（grant）——純函式部分（inkstone/arcrun-rag#238，leo 2026-10-06 裁決 B）。
 *
 * 背景：學員實例的 cypher 身上沒有常駐的 Cloudflare 寫入 token（安裝器從不種），
 * 而帳密的家是 Workers Secrets（Arcrun#98 c11136）⇒ 建完第一個帳號後，改密碼／忘記密碼寫不進去。
 * 做法：用戶在 portal 改密碼被擋時，被導來本安裝器重新授權 Cloudflare 一次
 *   1. portal → `GET /auth/start?grant=1&api=<cypher origin>&ui=<portal origin>`
 *   2. 走既有的 OAuth（同一個 callback，不必另註冊 redirect_uri）
 *   3. callback 驗「這個 Cloudflare 帳號確實擁有那台實例」，通過就把 token 換成一張
 *      **一次性授權碼**（5 分鐘、只能兌換一次、綁定 api origin），導回 portal
 *   4. portal 送新密碼時帶 `X-Arcrun-Secrets-Grant: <碼>`，cypher 向本安裝器
 *      `POST /api/grant/redeem` 兌換，只在那一個請求裡拿來寫 Workers Secrets
 *
 * 新密碼全程只送到用戶自己的實例，不經過本安裝器；本安裝器只經手那一把一次性的授權。
 */

/** `<script>.<subdomain>.workers.dev`（學員實例一律長這樣；自訂網域不走這條，見 parseGrantTargets）。 */
const WORKERS_DEV_RE = /^([a-z0-9][a-z0-9-]{0,62})\.([a-z0-9][a-z0-9-]{0,62})\.workers\.dev$/;
export const GRANT_CODE_RE = /^[A-Za-z0-9_-]{20,128}$/;
export const GRANT_TTL_SECONDS = 300;

/** 解析一個 origin 字串，回 { origin, script, sub }，不合格回 null。只收 https、無路徑、無埠號。 */
export function parseWorkersDevOrigin(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  const m = WORKERS_DEV_RE.exec(u.hostname);
  if (!m) return null;
  return { origin: `https://${u.hostname}`, script: m[1], sub: m[2] };
}

/**
 * 驗 /auth/start 帶來的 api／ui 兩個網址的形狀。
 * 🔴 ui 必須與 api 在**同一個 workers.dev 子網域**下——授權碼最後是導去 ui 的，
 * 子網域只有帳號擁有者能在底下建 script ⇒ 碼只會落到「那台實例的擁有者」手上。
 */
export function parseGrantTargets(apiRaw, uiRaw) {
  const api = parseWorkersDevOrigin(apiRaw);
  if (!api) return { ok: false, reason: 'bad_api' };
  const ui = parseWorkersDevOrigin(uiRaw);
  if (!ui) return { ok: false, reason: 'bad_ui' };
  if (ui.sub !== api.sub) return { ok: false, reason: 'sub_mismatch' };
  return { ok: true, api, ui };
}

/**
 * 驗「拿著這把 token 的人，確實擁有 api 那台實例」：
 * 這把 token 看得到的帳號裡，有一個的 workers.dev 子網域＝api 的子網域，且該帳號上有叫那個名字的 script。
 * @param {(path:string)=>Promise<any>} cf        已綁好 token 的 CF API 呼叫（回 result，失敗拋例外）
 * @param {{script:string, sub:string}} api
 * @returns {Promise<'ok'|'mismatch'>}  查詢本身失敗會拋出，由呼叫端當「暫時連不上」處理（不可講成 mismatch）
 */
export async function verifyAccountOwnsInstance(cf, api) {
  const accounts = (await cf('/accounts?per_page=50')) || [];
  for (const a of accounts) {
    if (!a || !a.id) continue;
    const sub = await cf(`/accounts/${a.id}/workers/subdomain`).catch((e) => {
      // 這個帳號沒開過子網域（10007）就是「不是它」；其他錯誤照拋
      if (e && (e.code === 10007 || e.status === 404)) return null;
      throw e;
    });
    if (!sub || sub.subdomain !== api.sub) continue;
    const scripts = (await cf(`/accounts/${a.id}/workers/scripts`)) || [];
    if (scripts.some((s) => s && (s.id === api.script || s.script_name === api.script || s.name === api.script))) return 'ok';
  }
  return 'mismatch';
}
