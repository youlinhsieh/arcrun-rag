/**
 * verify-mail-relay.test.mjs — 證明「郵差 worker 部署的是舊碼（沒有 D62 路由）」這件事真的會被擋下來。
 *
 * 跑法：node --test installer/scripts/verify-mail-relay.test.mjs
 * （零依賴、全程離線，fetch 用注入的替身）
 *
 * 為什麼需要（arcrun-rag#38／#69／#25）：2026-08-11 實測踩到——prod 的
 * `arcrun-landing` worker `/api/health` → 200（活著），但 `/api/send-password-reset`
 * → 404（那支路由根本不存在，部署的是 D62 之前的舊碼）。只驗 health 會誤判成綠燈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMailRelayLive } from './verify-mail-relay.mjs';

const BASE = 'https://arcrun-landing-staging.uncle6-me.workers.dev';

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${String(url).split('?')[0]}`;
    const v = routes[key];
    if (!v) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: v.status < 400, status: v.status, json: async () => v.body ?? {} };
  };
}

test('新碼（有 D62 路由）：health 綠＋代寄路由認得（結構化拒絕）⇒ 全過', async () => {
  const r = await checkMailRelayLive({
    base: BASE,
    fetchImpl: fakeFetch({
      [`GET ${BASE}/api/health`]: { status: 200, body: { ok: true } },
      [`POST ${BASE}/api/send-password-reset`]: { status: 400, body: { ok: false, error: 'email 格式不正確。' } },
    }),
  });
  assert.deepEqual(r.fails, [], r.lines.join('\n'));
});

test('🔴 舊碼（沒有 D62 路由）：health 綠，但代寄路由 404 ⇒ 一定抓到（不能只看 health）', async () => {
  const r = await checkMailRelayLive({
    base: BASE,
    fetchImpl: fakeFetch({
      [`GET ${BASE}/api/health`]: { status: 200, body: { ok: true } },
      // 沒有 POST /api/send-password-reset 這一條 ⇒ fakeFetch 預設回 404，模擬舊 worker
    }),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
  assert.ok(r.fails[0].includes('404'), r.fails[0]);
  assert.ok(r.fails[0].includes('沒有被這次出貨帶到') || r.fails[0].includes('不存在'), r.fails[0]);
});

test('🔴 worker 整顆不在了（health 也打不到）⇒ 抓到，且不會誤報成「路由問題」', async () => {
  const r = await checkMailRelayLive({
    base: BASE,
    fetchImpl: fakeFetch({}), // 什麼路由都沒有，連 health 都 404
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
  assert.ok(r.fails[0].includes('沒有回應') || r.fails[0].includes('health'), r.fails[0]);
});
