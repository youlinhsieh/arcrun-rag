// @ts-check
/**
 * half-finished-install.mjs — Arcrun#123 的迴歸守衛。
 *
 *   node shared/resource-rule/tests/half-finished-install.mjs
 *
 * 【要證的那句話（leo 2026-08-14 的驗收線）】
 *   「一個**上次裝到一半死掉**的帳號，用戶只做一件事——回安裝器再按一次——就要能裝成功。」
 *   ⇒ 不准叫用戶開 Cloudflare 後台、不准叫他跑指令、不准要他懂 namespace／binding。
 *
 * 【為什麼這個狀態逃過了 1.4.45 之前所有驗證】
 *   我們測的是「乾淨帳號 + 完整安裝」。而這個 bug 只在
 *   **資源已建、worker 未部署** 這一格才撞得到——`fixture-account.mjs` 原本
 *   只有 `deployed` 一個旗標，連表達這個狀態的能力都沒有。
 *
 * 零依賴、零建置：跟 demo.mjs 一樣，跑得起來本身就是
 * 「安裝器把 repo archive 拉下來就能直接用」的證據。
 */

import { planResources, applyResourcePlan, ResourcePlanBlocked, bindingKey } from '../rule.mjs';
import { createCloudflareResourceApi } from '../cf-resource-api.mjs';
import {
  makeAccount, installerRequirements, requirements, KV_BINDINGS, BASE_NAME, cfRejectsDuplicateNames,
} from './fixture-account.mjs';

let failed = 0;
/** @param {boolean} cond @param {string} what */
function check(cond, what) {
  console.log(`  ${cond ? '✅' : '❌'} ${what}`);
  if (!cond) failed++;
}
/** @param {string} title */
function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

// 「真 CF 會拒絕同名」這個替身搬去 fixture-account.mjs 了（pagination.mjs 也要用同一份，
// 而且它必須自己會翻頁——只看第一頁的版本會在「帳號上資源很多」的測試裡漏認同名）。

/** @param {ReturnType<typeof makeAccount>} account */
const apiFor = (account, fetchImpl) =>
  createCloudflareResourceApi({ accountId: 'acct-123', apiToken: 'tok-123', fetch: fetchImpl ?? account.fetch });

// ═══════════════════════════════════════════════════════════════════════════
section('① 驗收線本身：半殘帳號 + 安裝器再按一次 → 裝得起來，且一顆資源都不必新建');
// ═══════════════════════════════════════════════════════════════════════════
{
  const account = makeAccount('half-finished');
  const api = apiFor(account, cfRejectsDuplicateNames(account));
  // mode='init'：安裝器看的是自己的紀錄（`deployed:<account>:`），上次沒裝完就沒有那筆
  // ⇒ 這一輪照定義是「新裝」。半殘狀態必須在 init 這條路上就被處理掉。
  const plan = await planResources(api, installerRequirements(true, `${BASE_NAME}-db`), 'init');

  check(plan.blockers.length === 0, `不該有任何 blocker（實得 ${plan.blockers.length} 條）`);
  if (plan.blockers.length) console.log(plan.blockers.map((b) => `      · ${b}`).join('\n'));
  check(plan.create.length === 0, `一顆都不該新建（實得 ${plan.create.length} 顆要建）`);
  // 11 ＝ 9 個 KV binding + 2 個 D1 binding（CREDENTIALS_DB／DB，兩個指向同一顆庫）。
  // 這裡數的是**綁定**，不是資源顆數——底下那條 D1 斷言才在證「兩個綁定指到同一顆」。
  check(plan.adopt.length === 11, `11 個綁定全部接回來（實得 ${plan.adopt.length}）`);
  check(plan.adopt.every((a) => a.reclaimed === true), '每一顆都標記為「接回上次留下的」');

  const resolved = await applyResourcePlan(api, plan);
  check(account.created.kv.length === 0, `帳號上不該多出任何 KV（實得 ${account.created.kv.length}）`);
  check(account.created.d1.length === 0, `帳號上不該多出任何 D1（實得 ${account.created.d1.length}）`);

  // 綁到的必須是**上次留下的那幾顆本尊**，不是新的空殼
  const webhooks = resolved.get(bindingKey('kv_namespace', 'WEBHOOKS'));
  check(webhooks?.value === account.kvIdFor('WEBHOOKS'), 'WEBHOOKS 綁回上次建的那一顆本尊');
  check(webhooks?.origin === 'adopted', `origin 仍是 adopted（實得 ${webhooks?.origin}）——` +
    '安裝器現有的「沿用你原本的 N 項資源」統計不會漏數');
  const everyBindingResolved = KV_BINDINGS.every((b) => resolved.has(bindingKey('kv_namespace', b)));
  check(everyBindingResolved, '9 個 KV binding 全部都有著落（安裝可以繼續往下走）');
  check(resolved.get(bindingKey('d1', 'DB'))?.value === account.d1Id
    && resolved.get(bindingKey('d1', 'CREDENTIALS_DB'))?.value === account.d1Id,
    'kbdb 與 cypher 兩個 D1 binding 指到同一顆（維持「整台一顆 D1」的形狀）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('② 對照組：修好之前是什麼下場（沒有聲明 createNameIsOurs ⇒ 走舊行為）');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 不聲明所有權時，規則不准接管 ⇒ 停手。這也是舊版**會撞牆**的那條路：
  // 舊版會直接送 POST，然後被 CF 用「title already exists」打回來。
  const account = makeAccount('half-finished');
  const api = apiFor(account, cfRejectsDuplicateNames(account));
  const plan = await planResources(api, installerRequirements(false, `${BASE_NAME}-db`), 'init');

  check(plan.blockers.length > 0, '證明不了是自己的 → 一定要停手（fail-closed）');
  check(plan.blockers.join('\n').includes('RES-NAME-TAKEN'), '錯誤碼要在訊息裡（讓用戶回報，而不是自己去後台動手）');
  const said = plan.blockers.join('\n');
  check(!/Cloudflare 後台|dashboard|自己刪|去刪/.test(said), '訊息不准叫使用者自己去 CF 後台處理（#121／D88）');

  await assertRejects(() => applyResourcePlan(api, plan));
  check(account.created.kv.length === 0 && account.created.d1.length === 0,
    '被擋下時一顆資源都不能被建出來（plan／apply 兩段的結構保證）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('③ 紅線：不准接管「真的不是我們的」同名資源');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 使用者自己在帳號上建了一顆叫 WEBHOOKS 的 KV。走 wrangler.toml 那條路（acr）時
  // createName 就是裸 binding 名 `WEBHOOKS` ⇒ 撞名。那顆**可能真的是他自己的**
  // ⇒ 規則不准接管，也不准新建一顆頂上去。
  const account = makeAccount('fresh');
  const api = apiFor(account);
  await api.createKvNamespace('WEBHOOKS');           // ← 使用者自己的東西
  account.created.kv.length = 0;                      // 歸零，只算「規則這一趟建了什麼」
  const plan = await planResources(api, requirements(), 'init');

  check(plan.blockers.length > 0, '撞到不能證明是我們的同名資源 → 停手');
  check(!plan.create.some((c) => c.binding === 'WEBHOOKS'), 'WEBHOOKS 不准被排進「要新建」');
  await assertRejects(() => applyResourcePlan(api, plan));
  check(account.created.kv.length === 0, '一顆都沒建');
}

// ═══════════════════════════════════════════════════════════════════════════
section('④ D82 三步不可退化：既有的三種情境行為完全不變');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 全新帳號：照舊該建的全建出來
  const fresh = makeAccount('fresh');
  const freshPlan = await planResources(apiFor(fresh), installerRequirements(), 'init');
  check(freshPlan.blockers.length === 0, '全新帳號：無 blocker');
  check(freshPlan.adopt.length === 0, '全新帳號：沒有東西可沿用');
  // 11 個綁定 → 10 顆要建：兩個 D1 綁定宣告同一個 createName，被 shareSameResource 收斂成一顆。
  check(freshPlan.create.length === 10, `全新帳號：11 個綁定收斂成 10 顆要建（實得 ${freshPlan.create.length}）`);
  await applyResourcePlan(apiFor(fresh), freshPlan);
  check(fresh.created.kv.length === 9 && fresh.created.d1.length === 1,
    `全新帳號：實際建出 9 KV + 1 D1（實得 ${fresh.created.kv.length} / ${fresh.created.d1.length}）`);

  // 已裝好的實例跑更新：#97 的核心保證——沿用既有、一顆都不新建
  const installed = makeAccount('installed');
  const upPlan = await planResources(apiFor(installed), installerRequirements(), 'update');
  check(upPlan.blockers.length === 0, '已裝好：無 blocker');
  check(upPlan.create.length === 0, '已裝好：一顆都不新建（#97）');
  check(upPlan.adopt.every((a) => !a.reclaimed), '已裝好：全部來自 worker 綁定，沒有一顆走「接回殘骸」那條路');
  await applyResourcePlan(apiFor(installed), upPlan);
  check(installed.created.kv.length === 0 && installed.created.d1.length === 0, '已裝好：帳號上顆數不變');

  // 使用者把資源改過名：規則不看名字，照樣沿用 worker 綁著的那幾顆（#97 的另一面）
  const renamed = makeAccount('renamed');
  const rnPlan = await planResources(apiFor(renamed), installerRequirements(), 'update');
  check(rnPlan.blockers.length === 0, '改過名：無 blocker');
  check(rnPlan.create.length === 0, '改過名：一顆都不新建——名字對不上也不影響（規則只看綁定）');
  check(rnPlan.adopt.every((a) => !a.reclaimed), '改過名：沒有一顆是靠名字對上的');
}

/** @param {() => Promise<unknown>} fn */
async function assertRejects(fn) {
  try {
    await fn();
    check(false, 'applyResourcePlan 應該要丟 ResourcePlanBlocked，但它沒有');
  } catch (e) {
    check(e instanceof ResourcePlanBlocked, 'applyResourcePlan 丟 ResourcePlanBlocked');
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通過' : `❌ ${failed} 項失敗`}`);
process.exit(failed === 0 ? 0 : 1);
