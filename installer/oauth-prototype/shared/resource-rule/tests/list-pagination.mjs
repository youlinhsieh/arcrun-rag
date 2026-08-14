// @ts-check
/**
 * list-pagination.mjs — 「帳號上的資源多到一頁裝不下」時的迴歸守衛。
 *
 *   node shared/resource-rule/tests/list-pagination.mjs
 *
 * 【要證的那句話】
 *   「規則看到的帳號清單，就是帳號上**真正的全部**」——不論那個帳號有多少顆資源。
 *
 * 【為什麼這是 Arcrun#123 的續集，而不是一個獨立的小 bug】
 *   三支清單方法原本只打 `?per_page=100`（只看第一頁）。同一個截斷，
 *   在 #123 的修法前後**後果不一樣**：
 *
 *     · 修法**前**：被截掉的是「worker 綁著的那顆」→ 2b 判「綁著的資源不見了」
 *                   → 產生 blocker → **停手**。過度保守，但安全。
 *     · 修法**後**：被截掉的是「同名殘骸」→ 2c 判「這個名字沒被佔走」
 *                   → **去建 → CF 回 title already exists → #123 的死路原樣回來**。
 *
 *   ⇒ #123 的修法把這個洞從「叫得太大聲」變成「**安靜地復發**」。
 *     所以它必須跟 #123 同一批修掉，否則那張票只是把災情延後到「資源比較多的帳號」。
 *
 * 【假資料憑什麼代表得了真的 CF】
 *   `fixture-account.mjs` 的 `okPaged` 是照 2026-08-14 在 `geek6688` 帳號**實打**的回應
 *   逐字抄回來的形狀（唯讀，只列不建）——關鍵是三支端點**形狀不一樣**：
 *     KV 的 `result_info` 有 `total_pages`／D1 **沒有**／Vectorize 根本 `null`（不分頁）。
 *   假資料要是三支都照 KV 抄，就會養出「拿 `total_pages` 當終止條件」這種在 D1 上必壞的
 *   實作，而測試全綠。**假資料失真＝測了個假的。**
 *
 * 零依賴、零建置，跟 demo.mjs 一樣直接 node 跑。
 */

import { planResources, applyResourcePlan, ResourcePlanBlocked } from '../rule.mjs';
import { createCloudflareResourceApi } from '../cf-resource-api.mjs';
import {
  makeAccount, installerRequirements, KV_BINDINGS, BASE_NAME, cfRejectsDuplicateNames,
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

const apiFor = (account, fetchImpl) =>
  createCloudflareResourceApi({ accountId: 'acct-123', apiToken: 'tok-123', fetch: fetchImpl ?? account.fetch });

/** 帳號上「別人的」資源顆數。250 ＞ 100 ⇒ 我們自己那幾顆一定落在第三頁。 */
const DECOY = 250;

// ═══════════════════════════════════════════════════════════════════════════
section('① 清單本身：第二頁以後的東西真的被看見了');
// ═══════════════════════════════════════════════════════════════════════════
{
  const account = makeAccount('installed', { decoyKv: DECOY, decoyD1: DECOY });
  const api = apiFor(account);

  const kv = await api.listKvNamespaces();
  check(kv.size === DECOY + KV_BINDINGS.length,
    `KV 要讀滿 ${DECOY + KV_BINDINGS.length} 顆（實得 ${kv.size}）——只看第一頁的話這裡是 100`);
  // 我們自己那幾顆排在誘餌後面 ⇒ 它們在第三頁。看得到＝真的翻過去了。
  const lastOne = `${BASE_NAME}-kv-${KV_BINDINGS[KV_BINDINGS.length - 1].toLowerCase()}`;
  check(kv.has(lastOne), `最後一頁那顆（${lastOne}）也在清單裡`);

  const d1 = await api.listD1Databases();
  check(d1.size === DECOY + 1, `D1 要讀滿 ${DECOY + 1} 顆（實得 ${d1.size}）`);
  check(d1.has(`${BASE_NAME}-kbdb`), '第三頁的那顆 D1 也在清單裡');

  // 真的打了三頁，不是靠某個 per_page 開很大蒙混過去
  const kvPages = account.requestLog.filter((l) => l.startsWith('GET /storage/kv/namespaces'));
  check(kvPages.length === 3, `KV 清單分三次抓（實得 ${kvPages.length} 次）：\n      ${kvPages.join('\n      ')}`);
  check(kvPages.some((l) => l.includes('page=3')), '確實有打到 page=3');
  const d1Pages = account.requestLog.filter((l) => l.startsWith('GET /d1/database'));
  check(d1Pages.length === 3, `D1 清單分三次抓（實得 ${d1Pages.length} 次）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('② 修法「前」那一面：已裝好的實例，不准因為看不完整就誣告「你的資源不見了」');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 使用者好好地裝著，只是帳號上東西多。2b 要拿清單確認「綁著的那顆還在」——
  // 清單被截斷 ⇒ 規則會說「這顆在你的 Cloudflare 帳號上找不到了」⇒ 好好的更新被硬擋。
  const account = makeAccount('installed', { decoyKv: DECOY, decoyD1: DECOY });
  const plan = await planResources(apiFor(account), installerRequirements(), 'update');

  check(plan.blockers.length === 0, `不該有任何 blocker（實得 ${plan.blockers.length} 條）`);
  if (plan.blockers.length) console.log(plan.blockers.map((b) => `      · ${b}`).join('\n'));
  check(!plan.blockers.join('\n').includes('找不到了'), '不准出現「這顆在你的帳號上找不到了」這種誣告');
  check(plan.create.length === 0, `一顆都不該新建（實得 ${plan.create.length}）`);
  check(plan.adopt.length === 11, `11 個綁定全部沿用（實得 ${plan.adopt.length}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('③ 修法「後」那一面（安靜復發的那條）：半殘帳號 ＋ 資源很多 ⇒ 仍要接回，不准去建');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 這一格就是本檔存在的理由：
  //   殘骸在第三頁 → 清單被截斷 → 2c 判「名字沒被佔走」→ 送 POST → CF 拒絕 → #123 復發。
  //   而且是**安靜地**復發：規則自己覺得一切正常。
  const account = makeAccount('half-finished', { decoyKv: DECOY, decoyD1: DECOY });
  const api = apiFor(account, cfRejectsDuplicateNames(account));
  const plan = await planResources(api, installerRequirements(true, `${BASE_NAME}-db`), 'init');

  check(plan.blockers.length === 0, `不該有任何 blocker（實得 ${plan.blockers.length} 條）`);
  if (plan.blockers.length) console.log(plan.blockers.map((b) => `      · ${b}`).join('\n'));
  check(plan.create.length === 0, `一顆都不該新建（實得 ${plan.create.length} 顆要建）`);
  check(plan.adopt.length === 11, `11 個綁定全部接回來（實得 ${plan.adopt.length}）`);
  check(plan.adopt.every((a) => a.reclaimed === true), '每一顆都標記為「接回上次留下的」');

  // 走完 apply：CF 那道「同名建不出來」的牆還在，這一趟不准撞上去。
  await applyResourcePlan(api, plan);
  check(account.created.kv.length === 0 && account.created.d1.length === 0,
    `帳號上不該多出任何資源（實得 KV ${account.created.kv.length}／D1 ${account.created.d1.length}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('④ 三支端點形狀不同，一支都不能壞');
// ═══════════════════════════════════════════════════════════════════════════
{
  const account = makeAccount('fresh');
  const api = apiFor(account);

  // Vectorize：`result_info` 是 null（不分頁）。翻頁邏輯不能因此漏東西、也不能掛掉。
  await api.createVectorizeIndex('idx-a');
  await api.createVectorizeIndex('idx-b');
  await api.createVectorizeIndex('idx-c');
  const idx = await api.listVectorizeIndexes();
  check(idx.length === 3 && idx.includes('idx-c'), `不分頁的端點照樣讀得到全部（實得 ${idx.length} 個）`);

  // D1：`result_info` **沒有 total_pages**。拿 total_pages 當終止條件的實作會在這裡爆。
  const many = makeAccount('installed', { decoyD1: DECOY });
  const d1 = await apiFor(many).listD1Databases();
  check(d1.size === DECOY + 1, `D1 沒有 total_pages 也要翻得完（實得 ${d1.size}）`);

  // 空帳號：第一頁就是空的，不能誤判成「還有下一頁」而空轉
  const empty = makeAccount('fresh');
  const none = await apiFor(empty).listKvNamespaces();
  check(none.size === 0, `空帳號回 0 顆且不空轉（實得 ${none.size}）`);
  check(empty.requestLog.filter((l) => l.startsWith('GET /storage/kv/namespaces')).length === 1,
    '空帳號只打一次清單');
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑤ 看不完整時要**大聲停手**，不准安靜地當作看完了');
// ═══════════════════════════════════════════════════════════════════════════
{
  // CF 說共有 300 筆，卻從第二頁起一筆都不給。這種時候「回一份不完整的清單」
  // 就是災難的入口（規則會拿它去判斷該不該新建）⇒ 必須 throw ⇒ 變成 blocker ⇒ 整趟停手。
  const liar = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/storage/kv/namespaces')) {
      return new Response(JSON.stringify({ success: true, result: [], errors: [], result_info: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const page = Number(url.searchParams.get('page'));
    const result = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, title: `t-${i}` })) : [];
    return new Response(JSON.stringify({
      success: true, result, errors: [],
      result_info: { count: result.length, page, per_page: 100, total_count: 300, total_pages: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const api = createCloudflareResourceApi({ accountId: 'a', apiToken: 't', fetch: /** @type {any} */ (liar) });

  let threw = null;
  try {
    await api.listKvNamespaces();
  } catch (e) {
    threw = e;
  }
  check(threw !== null, '讀不完整 → 要 throw，不准回一份殘缺清單');
  check(String(threw?.message ?? '').includes('300'), `訊息要說清楚少了什麼（實得：${threw?.message}）`);

  // 而且這個 throw 要在規則那一層變成 blocker（fail-closed），不是讓整個安裝器炸掉
  const plan = await planResources(api, installerRequirements(), 'init');
  check(plan.blockers.length > 0, '規則要把它變成 blocker');
  // 讀不到清單的那一種（KV）**一顆都不准排新建**——「不知道」不等於「它沒有」。
  // （D1 那邊清單讀得到，照規則排新建是對的；反正整份計畫被 blocker 擋著，一顆都不會真的被建。）
  check(!plan.create.some((c) => c.kind === 'kv_namespace'), '讀不到清單的那一種資源不准排新建');
  try {
    await applyResourcePlan(api, plan);
    check(false, 'applyResourcePlan 應該要丟 ResourcePlanBlocked，但它沒有');
  } catch (e) {
    check(e instanceof ResourcePlanBlocked, 'applyResourcePlan 丟 ResourcePlanBlocked');
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通過' : `❌ ${failed} 項失敗`}`);
process.exit(failed === 0 ? 0 : 1);
