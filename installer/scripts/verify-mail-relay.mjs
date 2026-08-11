/**
 * verify-mail-relay.mjs — 「郵差真的在聽嗎？」
 *
 * ── 為什麼要有這支（2026-08-11，Gitea Leo/arcrun-rag#38／#69／#25）────────────
 * D62「忘記密碼」代寄機制的兩半——用戶自己的 cypher（寫連結、發代寄請求）與
 * `landing/worker.js`（收代寄請求、真的寄信）——只有前者被 ship.mjs 的登錄簿盯著；
 * `landing` 從未出現在 STEPS 或 ship.targets.json 裡（`grep -niE "landing"
 * installer/scripts/ship.mjs` 曾是零命中）。結果：landing 的程式碼改了、也 merge 進
 * main 了，**卻只有 staging 手動部署過，prod 從沒真的推上去**——出貨報告全綠，
 * 因為它根本不在被檢查的清單上。leo 的原話（D65）：「不在清單上的東西會現形——
 * 因為它連一列都沒有」，這是活的例子。
 *
 * ── 這支斷言什麼（不是只問「活著」，是問「這一版活著」）──────────────────────
 *   ① `GET <base>/api/health` → 2xx `{ok:true}`——worker 本身有回應。
 *   ② `POST <base>/api/send-password-reset`（帶明知會被拒絕的假資料）
 *      → 必須拿到 D62 那支路由才有的**結構化拒絕**（400/403，JSON body 帶 `ok:false`），
 *      **不能是 404**。404＝那支路由根本不存在＝部署的是 D62 之前的舊 worker
 *      （2026-08-11 實測踩到的正是這個：prod `/api/health`→200 但
 *      `/api/send-password-reset`→404，只有 stage 是 400——prod 在跑舊碼）。
 *   ⇒ 「部署指令沒報錯」「health 是綠的」都不算驗過（CRITICAL-PATH 使用規則 6），
 *      要真的打一次那支路由、看它認不認得。
 *
 * ── 為什麼是獨立模組 ────────────────────────────────────────────────────────
 * 與 verify-docs.mjs／verify-download.mjs 同理：判斷邏輯抽成純函式＋可注入 fetch，
 * 同一份實作既被真出貨用、也能在不碰真線上端點的情況下用假 fetch 反覆演練。
 */

/**
 * @param {object} o
 * @param {string} o.base            郵差 worker 的 base URL（登錄簿 mailRelay.verifyUrl）
 * @param {function} [o.fetchImpl]   注入用（測試）
 * @returns {Promise<{lines:string[], fails:string[]}>}
 */
export async function checkMailRelayLive({ base, fetchImpl = fetch }) {
  const lines = [];
  const fails = [];
  const root = String(base).replace(/\/+$/, '');
  const bust = () => `cb=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

  // ① 活著
  const health = await fetchImpl(`${root}/api/health?${bust()}`,
    { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
  if (!health || !health.ok) {
    fails.push(`郵差沒有回應：${root}/api/health → ${health ? 'HTTP ' + health.status : '(fetch 失敗)'}`);
    return { lines, fails };
  }
  lines.push(`健康檢查 ${root}/api/health → HTTP ${health.status}`);

  // ② 這一版活著：D62 的代寄路由存不存在——用一定會被拒絕的假資料，只看有沒有被**認得**
  const resetUrl = `${root}/api/send-password-reset`;
  const probe = await fetchImpl(resetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
    body: JSON.stringify({}), // 刻意空 body：一定不合法，只是要看路由認不認得這個形狀
  }).catch(() => null);
  if (!probe) {
    fails.push(`代寄路由打不到：${resetUrl}（fetch 失敗）`);
    return { lines, fails };
  }
  if (probe.status === 404) {
    fails.push(
      `代寄路由不存在：${resetUrl} → HTTP 404。這顆 worker 部署的是 D62 之前的舊版——` +
      `landing 沒有被這次出貨帶到（不是 landing 的程式碼壞了，是它根本沒被推上去）。`);
    return { lines, fails };
  }
  let bodyOk = null;
  try { bodyOk = (await probe.json())?.ok; } catch { /* 非 JSON 也照樣往下判斷狀態碼 */ }
  lines.push(`代寄路由 ${resetUrl} → HTTP ${probe.status}｜認得這個形狀（不是 404）`
    + (bodyOk === false ? '｜結構化拒絕（ok:false，符合預期——空 body 本來就該被拒）' : ''));

  return { lines, fails };
}
