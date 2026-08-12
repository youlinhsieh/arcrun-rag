/**
 * ship-delivery.test.mjs — 證明「送達收斂」那一站**兩邊都會執行、而且真的會判失敗**
 *
 * 為什麼這支特別重要（`Leo/arcrun-rag#79`）：這一站的每一個壞法都不是「判斷寫錯」，
 * 是**判斷從來沒被執行過**——它只有 prod 會跑，而 prod 一年跑不了幾次。
 * 所以這裡測的第一件事不是「判對了嗎」，是「**stage 會不會又安靜跳過**」。
 *
 * 跑法：node --test installer/scripts/ship-delivery.test.mjs（不打任何真的網路）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliveryInvariantProblems, deliveryPlan, expectationsFor, confirmDelivery,
  notConvergedError, withCacheBust, DELIVERY_CONTRACT, DRILL_ENV,
} from './ship-delivery.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TARGETS = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));

const stageLike = {
  installer: { cwd: 'x' },
  delivery: {
    movingPointer: 'https://git.example/raw/branch/main/manifest.json',
    refreshUrl: 'https://git.example/raw/branch/main/manifest.json',
    refreshKind: '強制重讀', waitMs: 3000, maxTries: 4,
  },
};
const prodLike = {
  publish: true, installer: { cwd: 'x' },
  delivery: {
    movingPointer: 'https://cdn.example/gh/o/r@main/manifest.json',
    refreshUrl: 'https://purge.example/gh/o/r@main/manifest.json',
    refreshKind: '作廢端點', waitMs: 20000, maxTries: 4,
  },
};

/** 假的 runWorkflow：照工作流 v2 的判準回話（比對期望值），並記下每次收到的 payload。 */
function fakeWorkflow({ release, daemon, calls, contract = DELIVERY_CONTRACT, failFirst = 0 }) {
  return async (name, input) => {
    calls.push({ name, input });
    const n = calls.length;
    const actualRelease = n <= failFirst ? '(舊版)' : release;
    const actualDaemon = n <= failFirst ? '(舊版)' : daemon;
    return {
      contract,
      attempt: input.attempt,
      refresh_ok: true, fetch_ok: true,
      actual_release: actualRelease, actual_daemon: actualDaemon,
      expect_release: input.expect_release, expect_daemon: input.expect_daemon,
      converged: actualRelease === input.expect_release && actualDaemon === input.expect_daemon,
    };
  };
}

// ── 不變式 Ⅷ：這一站不准再只有單邊執行 ──────────────────────────────────────

test('🔴 有安裝器卻沒宣告 delivery ⇒ 登錄簿不完整（#79 的病：stage 安靜跳過）', () => {
  const problems = deliveryInvariantProblems({ stage: { installer: { cwd: 'x' } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /沒宣告 delivery/);
  assert.match(problems[0], /只有 prod 會跑|只能在 prod 第一次發現/);
});

test('✅ 沒有安裝器的目標（selftest）沒有 delivery 是合法的——它不面對任何人', () => {
  assert.deepEqual(deliveryInvariantProblems({ selftest: { installer: null, delivery: null } }), []);
});

test('🔴 delivery 缺欄位／refreshKind 亂寫 ⇒ 擋（沒有預設值可以猜）', () => {
  const missing = deliveryInvariantProblems({ s: { installer: {}, delivery: { movingPointer: 'u' } } });
  assert.equal(missing.filter((p) => /缺 `refreshUrl`|缺 `refreshKind`/.test(p)).length, 2);

  const bogus = deliveryInvariantProblems({
    s: { installer: {}, delivery: { movingPointer: 'u', refreshUrl: 'u', refreshKind: '看情況' } },
  });
  assert.equal(bogus.length, 1);
  assert.match(bogus[0], /不是二選一/);
});

test('🔴 真的那份登錄簿：stage 與 prod 都宣告了 delivery，而且 stage 不再靠 fullChain 跳過', () => {
  assert.deepEqual(deliveryInvariantProblems(TARGETS.targets), []);
  const { stage, prod, selftest } = TARGETS.targets;
  assert.ok(stage.delivery && stage.delivery.movingPointer, 'stage 必須宣告 delivery（#79 第一個驗收條件）');
  assert.ok(prod.delivery && prod.delivery.movingPointer);
  assert.equal(stage.delivery.refreshKind, '強制重讀');   // Gitea raw 沒有作廢端點
  assert.equal(prod.delivery.refreshKind, '作廢端點');    // jsDelivr 有
  assert.equal(selftest.delivery, null);
  // `fullChain` 是「這一站只有 prod 會執行」的開關本身——它不准再存在（死旗標＝錯誤信號）
  assert.equal(prod.verify.fullChain, undefined);
  assert.equal(JSON.stringify(TARGETS).includes('fullChain": true'), false);
});

// ── 計畫怎麼算出來 ──────────────────────────────────────────────────────────

test('✅ stage 的計畫：等 3 秒就好（沒有邊緣快取要散，不必陪 prod 等 20 秒）', () => {
  const plan = deliveryPlan(stageLike, 'stage');
  assert.equal(plan.waitMs, 3000);
  assert.equal(plan.maxTries, 4);
  assert.equal(plan.drill, false);
});

test('✅ 沒有 delivery 也沒有安裝器 ⇒ 回 null（呼叫端據此跳過，且只有這一種跳法）', () => {
  assert.equal(deliveryPlan({ installer: null, delivery: null }, 'selftest'), null);
});

test('🔴 有安裝器卻沒 delivery ⇒ 連計畫都算不出來（防禦性重複不變式 Ⅷ）', () => {
  assert.throws(() => deliveryPlan({ installer: {} }, 'stage'), /沒宣告 delivery/);
});

test('🔴 反向演練開關不准用在會發佈給用戶的目標', () => {
  assert.throws(() => deliveryPlan(prodLike, 'prod', { drill: true }), new RegExp(`${DRILL_ENV}[\\s\\S]*不准用在會發佈給用戶`));
});

test('✅ 演練模式只可能讓它更嚴格：期望值變成內容指紋算不出來的字串', () => {
  const normal = expectationsFor({ release: '1.4.38', daemonVersion: 'v0.18.26' });
  assert.deepEqual(normal, { release: '1.4.38', daemon: 'v0.18.26', drill: false });
  const drill = expectationsFor({ release: '1.4.38', daemonVersion: 'v0.18.26', drill: true });
  assert.notEqual(drill.release, '1.4.38');
  assert.match(drill.release, /不可能達成/);
  assert.match(drill.daemon, /不可能達成/);
});

test('快取破壞參數：原本就有 query 的網址用 & 接上去', () => {
  assert.equal(withCacheBust('https://a/b', '1_x'), 'https://a/b?cb=1_x');
  assert.equal(withCacheBust('https://a/b?ref=main', '1_x'), 'https://a/b?ref=main&cb=1_x');
});

// ── 真的去問：重試、提早停、判失敗 ──────────────────────────────────────────

test('✅ 第一次就收斂 ⇒ 只觸發一次工作流（提早停，不無條件燒完 4 圈——#79 的根因）', async () => {
  const calls = [];
  const r = await confirmDelivery({
    plan: deliveryPlan(stageLike, 'stage'), release: '1.4.38', daemonVersion: 'v0.18.26',
    runWorkflow: fakeWorkflow({ release: '1.4.38', daemon: 'v0.18.26', calls }), nonce: () => 'N',
  });
  assert.equal(r.converged, true);
  assert.equal(r.convergedAt, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ship_refresh_cdn');
});

test('✅ 前兩次還是舊版、第三次收斂 ⇒ 試三次就停', async () => {
  const calls = [];
  const r = await confirmDelivery({
    plan: deliveryPlan(stageLike, 'stage'), release: '1.4.38', daemonVersion: 'v0.18.26',
    runWorkflow: fakeWorkflow({ release: '1.4.38', daemon: 'v0.18.26', calls, failFirst: 2 }), nonce: () => 'N',
  });
  assert.equal(r.convergedAt, 3);
  assert.equal(calls.length, 3);
  assert.equal(r.attempts[0].converged, false);
});

test('🔴 一直沒收斂 ⇒ 判失敗，訊息直說「用戶此刻拿不到新版」（語氣不准軟化）', async () => {
  const calls = [];
  const plan = deliveryPlan(stageLike, 'stage');
  const r = await confirmDelivery({
    plan, release: '1.4.38', daemonVersion: 'v0.18.26',
    runWorkflow: fakeWorkflow({ release: '(舊版)', daemon: '(舊版)', calls }), nonce: () => 'N',
  });
  assert.equal(r.converged, false);
  assert.equal(calls.length, 4);                       // 試滿 maxTries
  const e = notConvergedError(plan, r);
  assert.match(e.message, /用戶此刻拿不到新版/);
  assert.match(e.message, /不准宣稱出貨完成/);
});

test('🔴 反向演練：期望值不可能達成 ⇒ 就算 CDN 上真的是這一版，也必須判失敗', async () => {
  const calls = [];
  const r = await confirmDelivery({
    plan: deliveryPlan(stageLike, 'stage', { drill: true }), release: '1.4.38', daemonVersion: 'v0.18.26',
    runWorkflow: fakeWorkflow({ release: '1.4.38', daemon: 'v0.18.26', calls }), nonce: () => 'N',
  });
  assert.equal(r.converged, false);
  assert.match(calls[0].input.expect_release, /不可能達成/);
});

test('🔴 實例上還是舊版工作流（沒有 contract）⇒ 直接說去重新部署，不丟看起來像網路問題的錯', async () => {
  const calls = [];
  await assert.rejects(
    () => confirmDelivery({
      plan: deliveryPlan(stageLike, 'stage'), release: '1.4.38', daemonVersion: 'v0.18.26',
      runWorkflow: fakeWorkflow({ release: '1.4.38', daemon: 'v0.18.26', calls, contract: undefined }), nonce: () => 'N',
    }),
    (e) => /不是這支腳本要的版本/.test(e.message) && /workflows\/ship_refresh_cdn\.json/.test(e.message));
});

test('送出去的 payload：有作廢端點的不亂加參數，沒有的才帶快取破壞；重讀網址一定帶', async () => {
  const stageCalls = [];
  await confirmDelivery({
    plan: deliveryPlan(stageLike, 'stage'), release: 'r', daemonVersion: 'd',
    runWorkflow: fakeWorkflow({ release: 'r', daemon: 'd', calls: stageCalls }), nonce: () => 'N',
  });
  assert.equal(stageCalls[0].input.refresh_url, 'https://git.example/raw/branch/main/manifest.json?cb=1_N');
  assert.equal(stageCalls[0].input.manifest_url, 'https://git.example/raw/branch/main/manifest.json?cb=1_N');
  assert.equal(stageCalls[0].input.wait_ms, 3000);
  assert.equal(stageCalls[0].input.refresh_kind, '強制重讀');

  const prodCalls = [];
  await confirmDelivery({
    plan: deliveryPlan(prodLike, 'prod'), release: 'r', daemonVersion: 'd',
    runWorkflow: fakeWorkflow({ release: 'r', daemon: 'd', calls: prodCalls }), nonce: () => 'N',
  });
  assert.equal(prodCalls[0].input.refresh_url, 'https://purge.example/gh/o/r@main/manifest.json');
  assert.match(prodCalls[0].input.manifest_url, /\?cb=1_N$/);
});

// ── 工作流本體：腳本改了、工作流沒跟上，要在這裡就抓到 ──────────────────────

test('🔴 workflows/ship_refresh_cdn.json 必須是 v2：讀 refresh_url、輸出帶 contract、不再有 purge_urls', () => {
  const wf = JSON.parse(readFileSync(join(REPO_ROOT, 'workflows', 'ship_refresh_cdn.json'), 'utf8'));
  const raw = JSON.stringify(wf.graph);
  assert.ok(raw.includes('{{input.refresh_url}}'), '踢指標那個節點要吃 refresh_url');
  assert.ok(raw.includes('{{input.manifest_url}}'));
  assert.equal(raw.includes('purge_urls'), false, '三個固定槽已經拿掉（stage 沒有作廢端點，填不滿）');
  assert.ok(raw.includes(`contract: '${DELIVERY_CONTRACT}'`), '輸出要帶 contract，呼叫端才認得出舊版工作流');
  // #79 的根因是節點太多撞 subrequest 上限——節點數只准往下走，不准往上
  assert.ok(wf.graph.nodes.length <= 5, `節點數 ${wf.graph.nodes.length} 太多（#79：每個節點都燒子請求）`);
  assert.equal(wf.graph.nodes.filter((n) => n.componentId === 'http_request').length, 2);
});
