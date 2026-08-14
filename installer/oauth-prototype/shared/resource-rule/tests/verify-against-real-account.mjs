// @ts-check
/**
 * verify-against-real-account.mjs — 在**真的 Cloudflare 帳號**上驗 Arcrun#123。
 *
 *   CF_API_TOKEN=<token> CF_ACCOUNT_ID=<id> node shared/resource-rule/tests/verify-against-real-account.mjs
 *
 * 【為什麼需要這一支】
 * `half-finished-install.mjs` 是離線的（fetch 替身）——它證明**判斷**對，
 * 但證明不了「真的 Cloudflare 會不會照我們以為的方式回應」。#123 的整個病根
 * 就是**我們以為 CF 會讓我們重建，實際上它拒絕**。那種錯，只有真帳號驗得出來。
 *
 * 【它會對你的帳號做什麼】
 *   · 讀：列 KV／D1／Vectorize、讀幾顆 worker 的綁定
 *   · 寫：**只建一顆**名字帶 `-zz123tst-` 的一次性 KV，用完**一定刪掉**（finally 保證）
 *   · 🔴 **不碰你任何既有資源**：不部署 worker、不改綁定、不刪別的東西
 *     （測試用的 worker script 名是刻意不存在的，所以規則看到的是「沒有人綁著它」）
 *
 * 安全開關：
 *   DRY_RUN=true   只盤點與說明會做什麼，不建也不刪
 *   KEEP=true      測完不刪那顆測試 KV（除錯用；正常不要開）
 */

import { planResources, applyResourcePlan } from '../rule.mjs';
import { createCloudflareResourceApi } from '../cf-resource-api.mjs';

const TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DRY = process.env.DRY_RUN === 'true';
const KEEP = process.env.KEEP === 'true';

if (!TOKEN || !ACCOUNT) {
  console.error('缺 CF_API_TOKEN 或 CF_ACCOUNT_ID。');
  console.error('  CF_API_TOKEN=<token> CF_ACCOUNT_ID=<id> node shared/resource-rule/tests/verify-against-real-account.mjs');
  process.exit(1);
}

/** 一次性測試用的實例短碼——刻意帶 zz 前綴，不可能跟真的實例撞。 */
const BASE = 'arcrun-rag-zz123tst';
const TEST_KV_TITLE = `${BASE}-kv-oauth_kv`;
/** 刻意用**不存在**的 worker 名：規則會讀到 404 ⇒「沒有人綁著它」⇒ 走 #123 那條路。 */
const GHOST_WORKER = 'arcrun-mcp-zz123tst-does-not-exist';

const api = createCloudflareResourceApi({ accountId: ACCOUNT, apiToken: TOKEN });

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✅' : '❌'} ${what}`); if (!ok) failed++; };

console.log('Arcrun#123 真帳號驗證');
console.log(`帳號：${ACCOUNT}`);
console.log(`會建一顆：${TEST_KV_TITLE}（測完刪除）${DRY ? '  ← DRY_RUN，不會真的建' : ''}\n`);

// ── 0. 先盤點，讓人看得到「我沒動你的東西」 ────────────────────────────
const before = await api.listKvNamespaces();
console.log(`帳號上現有 KV：${before.size} 顆`);
if (before.has(TEST_KV_TITLE)) {
  console.log(`⚠️ 帳號上已經有 ${TEST_KV_TITLE}（上次沒清乾淨？）——直接沿用它做這次測試。`);
}

if (DRY) {
  console.log('\nDRY_RUN：到此為止，什麼都沒建也沒刪。');
  process.exit(0);
}

/** @type {string | undefined} */
let testKvId = before.get(TEST_KV_TITLE);
const weCreatedIt = testKvId === undefined;

try {
  // ── 1. 製造「上次裝到一半死掉」：資源在、worker 不在 ──────────────────
  if (weCreatedIt) {
    testKvId = await api.createKvNamespace(TEST_KV_TITLE);
    console.log(`\n① 已建立測試殘骸 ${TEST_KV_TITLE} → ${testKvId}`);
  } else {
    console.log(`\n① 沿用既有的 ${TEST_KV_TITLE} → ${testKvId}`);
  }

  const reqs = (claim) => [{
    kind: /** @type {const} */ ('kv_namespace'),
    binding: 'OAUTH_KV',
    worker: GHOST_WORKER,
    createName: TEST_KV_TITLE,
    ...(claim ? { createNameIsOurs: true } : {}),
  }];

  // ── 2. 修好之後：應該接回那一顆，一顆都不建 ──────────────────────────
  console.log('\n② 修復後（安裝器聲明 createNameIsOurs）');
  const plan = await planResources(api, reqs(true), 'init');
  check(plan.blockers.length === 0, `不該有 blocker（實得 ${plan.blockers.length}）`);
  plan.blockers.forEach((b) => console.log('      ·', b.slice(0, 150)));
  check(plan.create.length === 0, `不該有東西要新建（實得 ${plan.create.length}）`);
  check(plan.adopt.length === 1 && plan.adopt[0].reclaimed === true, '應該標記為「接回上次留下的」');

  const kvCountBeforeApply = (await api.listKvNamespaces()).size;
  const resolved = await applyResourcePlan(api, plan);
  const kvCountAfterApply = (await api.listKvNamespaces()).size;
  check(kvCountAfterApply === kvCountBeforeApply, `apply 之後帳號上顆數不變（${kvCountBeforeApply} → ${kvCountAfterApply}）`);
  check(resolved.get('kv_namespace:OAUTH_KV')?.value === testKvId, '綁到的是那顆殘骸本尊，不是新建的空殼');

  // ── 3. 沒聲明來歷：必須 fail-closed（#97 的反向災情） ─────────────────
  console.log('\n③ 沒聲明 createNameIsOurs（不能證明是我們的）');
  const blocked = await planResources(api, reqs(false), 'init');
  check(blocked.blockers.length > 0, '必須停手，不准接管');
  check(/RES-NAME-TAKEN/.test(blocked.blockers.join('\n')), '訊息要帶可回報的錯誤碼');
  check(!/後台|dashboard/.test(blocked.blockers.join('\n')), '訊息不准叫使用者自己去 CF 後台（#121／D88）');
} finally {
  // ── 4. 清乾淨（不管上面成功失敗都要跑） ──────────────────────────────
  if (testKvId && weCreatedIt && !KEEP) {
    const res = await api.cfRaw(`/storage/kv/namespaces/${testKvId}`, { method: 'DELETE' });
    console.log(`\n④ 清理：刪除 ${TEST_KV_TITLE} → ${res.ok ? '✅ 已刪除' : '⚠️ 刪除失敗，請手動刪：' + res.error}`);
  } else if (KEEP) {
    console.log(`\n④ KEEP=true，保留 ${TEST_KV_TITLE}（記得自己刪）`);
  }
}

console.log(`\n${failed === 0 ? '✅ 真帳號驗證全部通過' : `❌ ${failed} 項失敗`}`);
process.exit(failed === 0 ? 0 : 1);
