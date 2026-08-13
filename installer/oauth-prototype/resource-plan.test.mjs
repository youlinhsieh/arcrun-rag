/**
 * resource-plan.test.mjs — 三種情境：安裝器**選出來的 resource id** 對不對。
 *
 * 跑法：node --test installer/oauth-prototype/resource-plan.test.mjs
 *
 * ── 這份測試在證什麼（`Leo/Arcrun#97`）──────────────────────────────────────
 * leo 2026-08-12：「如果你沒有裝，就是新的；**如果你已經有，原來叫什麼名字就繼續用下去**。」
 *
 *   · fresh    沒裝過        → **正常建新的**（不能為了沿用變成永遠不建）
 *   · installed 裝過了       → 沿用原本那幾顆
 *   · renamed  資源在、名字完全不同 → **仍然沿用**（#97 的病根，專門驗）
 *
 * ── 為什麼餵的是上游那份 fixture，不是自己捏一個假帳號 ───────────────────────
 * `shared/resource-rule/tests/fixture-account.mjs` 是**上游驗 `acr` 那條路用的同一份**
 * 假帳號（而且是從 `fetch` 這一層假起：HTTP → 解析 → 判斷整條鏈都真的走）。
 * 兩條路餵同一份帳號狀態、拿同一組 id，才叫「兩條路一致」——
 * 各自捏一份假帳號只能證明「我對我自己的假設一致」。
 *
 * 上游對應的測試：`cli/tests/two-paths-agree.test.ts`（acr 那條）、
 * `cli/tests/resource-adoption.test.ts`（#97 迴歸）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestRequirements, resolveResourcesByRule } from './worker.js';
import { makeAccount, SCENARIOS, WORKER_NEEDS, KV_BINDINGS } from './shared/resource-rule/tests/fixture-account.mjs';

const BASE_NAME = 'arcrun-rag-yuga3bse';

/** 把 fixture 的 WORKER_NEEDS 攤成「安裝器手上那份 bundle manifest」的形狀。 */
function manifestFromFixture() {
  return {
    core: Object.entries(WORKER_NEEDS).map(([name, need]) => ({
      name,
      requires: { kv: need.kv, d1: need.d1.map((d) => ({ binding: d.binding })) },
    })),
  };
}

/** 用 fixture 的 fetch 替身跑一次安裝器那條路。 */
async function runInstallerPath(scenario) {
  const account = makeAccount(scenario);
  const realFetch = globalThis.fetch;
  globalThis.fetch = account.fetch;
  try {
    const mode = SCENARIOS[scenario].deployed ? 'update' : 'init';
    const reqs = manifestRequirements(manifestFromFixture(), BASE_NAME, true);
    const r = await resolveResourcesByRule('fake-token', 'fake-account', reqs, mode);
    return { account, r };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('#97 情境一 fresh：沒裝過 → 正常建新的（不能為了沿用變成永遠不建）', async () => {
  const { account, r } = await runInstallerPath('fresh');
  assert.equal(r.blocked, false, r.blockers.join('\n'));

  // 每個 binding 都有著落，而且全部是新建
  for (const b of KV_BINDINGS) {
    assert.ok(r.bindings[`kv_namespace:${b}`], `${b} 應該有資源`);
    assert.equal(r.origin[`kv_namespace:${b}`], 'created');
  }
  assert.equal(r.origin['d1:DB'], 'created');
  assert.equal(r.origin['d1:CREDENTIALS_DB'], 'created');
  assert.equal(r.origin['vectorize:VECTORIZE'], 'created');

  // 建出來的東西：9 顆 KV、**1 顆** D1（兩個 binding 共用一顆，不是各建一顆）、1 個 index
  assert.equal(account.created.kv.length, 9);
  assert.equal(account.created.d1.length, 1, '兩個 d1 binding 指的是同一顆庫，只准建一次');
  assert.equal(r.bindings['d1:DB'], r.bindings['d1:CREDENTIALS_DB']);
  assert.equal(account.created.vectorize.length, 1);

  // 新建時才用得到我們取的名字（沿用時完全不看名字）
  assert.ok(account.created.kv.every((t) => t.startsWith(`${BASE_NAME}-kv-`)), account.created.kv.join('、'));
  assert.deepEqual(account.created.d1, [`${BASE_NAME}-db`]);
});

test('#97 情境二 installed：裝過了 → 沿用原本那幾顆，一顆新的都不建', async () => {
  const { account, r } = await runInstallerPath('installed');
  assert.equal(r.blocked, false, r.blockers.join('\n'));

  for (const b of KV_BINDINGS) {
    assert.equal(r.bindings[`kv_namespace:${b}`], account.kvIdFor(b), `${b} 必須是原本那顆`);
    assert.equal(r.origin[`kv_namespace:${b}`], 'adopted');
  }
  assert.equal(r.bindings['d1:DB'], account.d1Id);
  assert.equal(r.bindings['d1:CREDENTIALS_DB'], account.d1Id);
  assert.equal(account.created.kv.length, 0, '既有的還綁著就不准新建 KV');
  assert.equal(account.created.d1.length, 0, '既有的還綁著就不准新建 D1');

  // #106：已部署 worker 身上的版本標籤讀得回來（更新完不該變成「無法讀取目前版本」）
  assert.equal(r.liveVars['arcrun-cypher-executor'].ARCRUN_BUNDLE_VERSION, '1.4.33');
});

test('#97 情境三 renamed：資源在、名字與安裝器預期完全不同 → 仍然沿用（這是病根）', async () => {
  const { account, r } = await runInstallerPath('renamed');
  assert.equal(r.blocked, false, r.blockers.join('\n'));

  for (const b of KV_BINDINGS) {
    assert.equal(r.bindings[`kv_namespace:${b}`], account.kvIdFor(b),
      `${b}：帳號上那顆叫「${SCENARIOS.renamed.titleFor(b)}」，跟安裝器會取的名字毫無關聯——` +
      '照名字找一定拿不到，必須靠「worker 現在綁著誰」認出來');
    assert.equal(r.origin[`kv_namespace:${b}`], 'adopted');
  }
  assert.equal(r.bindings['d1:DB'], account.d1Id);
  assert.equal(account.created.kv.length, 0, '#97 的災情就是這裡建了一批空的頂上去');
  assert.equal(account.created.d1.length, 0);
});

test('#97 沿用不是「永遠不建」：新版本新增的 binding（VECTORIZE）照樣會建出來', async () => {
  // 這台已經裝過了，但當初那一版沒有 VECTORIZE binding ⇒ 沒有任何 worker 綁過它
  // ⇒ 建它不會弄丟任何東西（本來就沒有東西可丟）＝規則第 2 條。
  for (const scenario of ['installed', 'renamed']) {
    const { account, r } = await runInstallerPath(scenario);
    assert.equal(r.origin['vectorize:VECTORIZE'], 'created', `${scenario}：新增的 binding 該建就要建`);
    assert.deepEqual(account.created.vectorize, ['arcrun-kbdb-embed-m3']);
    assert.equal(account.created.kv.length, 0, `${scenario}：但不准順手多建別的`);
  }
});

test('#97 兩條路一致：安裝器選出來的 id ＝ fixture 宣告的「使用者真正在用的那幾顆」', async () => {
  // fixture 把「使用者的東西」掛在資源 id 上（workflows／sessions／libraries）。
  // 只要選出來的 id 對，工作流與登入 session 就還在——那正是 #97 當初不見的兩樣。
  for (const scenario of ['installed', 'renamed']) {
    const { account, r } = await runInstallerPath(scenario);
    assert.ok(account.userData.workflows.length > 0);
    assert.ok(account.userData.sessions.length > 0);
    // 工作流住在 WEBHOOKS、登入 session 住在 SESSIONS_KV
    assert.equal(r.bindings['kv_namespace:WEBHOOKS'], account.kvIdFor('WEBHOOKS'), `${scenario}：工作流那顆`);
    assert.equal(r.bindings['kv_namespace:SESSIONS_KV'], account.kvIdFor('SESSIONS_KV'), `${scenario}：登入 session 那顆`);
  }
});
