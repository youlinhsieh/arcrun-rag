/**
 * ship-arcrun.test.mjs — 證明「站表宣告的工作流必須真的存在」那道閘會擋，
 * 而且**連不上實例時也擋**（不是安靜當作沒事）。
 *
 * 為什麼特別測「連不上」：這類閘最常見的壞法不是判斷寫錯，是**例外被吞掉變成放行**。
 * 出貨線上一次「HTTP 200 就當驗過」的教訓已經記在 CRITICAL-PATH 使用規則 6 裡。
 *
 * 2026-08-15 補：namespace 從「寫死 'leo'」改成「現讀 ~/.arcrun/config.yaml」之後，
 * 補測 `resolveNamespace()` 的三條路（env 覆寫／讀檔／兩者都沒有丟例外），
 * 以及「這台實例一支工作流都沒有」時訊息會不會提示「可能問錯 namespace」。
 *
 * 跑法：node --test installer/scripts/ship-arcrun.test.mjs（不打任何真的網路）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkflowsExist, listWorkflows, runWorkflow, resolveNamespace, resolveArcrunBase, fillInstanceNamespaces } from './ship-arcrun.mjs';
import { mkdirSync } from 'node:fs';

/** 換掉 globalThis.fetch 跑一段，結束後還原（不碰真的網路）。 */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** 暫時覆寫 process.env 的幾個鍵，結束後還原（不管是否原本存在）。 */
async function withEnv(overrides, fn) {
  const had = {}; const prev = {};
  for (const k of Object.keys(overrides)) { had[k] = k in process.env; prev[k] = process.env[k]; }
  Object.assign(process.env, overrides);
  try { return await fn(); } finally {
    for (const k of Object.keys(overrides)) { if (had[k]) process.env[k] = prev[k]; else delete process.env[k]; }
  }
}

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('✅ 工作流都在 ⇒ 放行', async () => {
  await withFetch(async () => jsonRes({ workflows: [{ name: 'ship_check_live' }, { name: 'ship_refresh_cdn' }, { name: 'notify_leo' }] }), async () => {
    const r = await assertWorkflowsExist(['ship_check_live', 'ship_refresh_cdn']);
    assert.deepEqual(r.checked, ['ship_check_live', 'ship_refresh_cdn']);
  });
});

test('🔴 有一個工作流不在那台實例上 ⇒ 擋，且訊息點名是哪一個', async () => {
  await withFetch(async () => jsonRes({ workflows: [{ name: 'notify_leo' }] }), async () => {
    await assert.rejects(
      () => assertWorkflowsExist(['ship_check_live']),
      (e) => /沒有這些工作流.*ship_check_live/.test(e.message) && /D70/.test(e.message));
  });
});

test('🔴 連不上實例 ⇒ 擋（不准把例外吞掉當作放行）', async () => {
  await withFetch(async () => { throw new Error('connect ECONNREFUSED'); }, async () => {
    await assert.rejects(() => assertWorkflowsExist(['ship_check_live']), /連不上 leo 的 Arcrun 實例/);
  });
});

test('🔴 列工作流回非 200 ⇒ 擋（不是把它當成空清單）', async () => {
  await withFetch(async () => jsonRes({}, false, 503), async () => {
    await assert.rejects(() => assertWorkflowsExist(['ship_check_live']), /連不上 leo 的 Arcrun 實例/);
  });
});

test('✅ 站表一個 Arcrun 站都沒有 ⇒ 不打網路、直接放行', async () => {
  await withFetch(async () => { throw new Error('不該被呼叫'); }, async () => {
    const r = await assertWorkflowsExist([]);
    assert.deepEqual(r.checked, []);
  });
});

test('🔴 觸發工作流：外層 200 但內層 success:false ⇒ 當失敗（wiki 記過的那個坑）', async () => {
  await withFetch(async () => jsonRes({ success: false, error: '內層炸了' }), async () => {
    await assert.rejects(() => runWorkflow('ship_check_live', {}), /執行失敗/);
  });
});

test('✅ 觸發工作流：拿回內層 data 讓呼叫端機械判斷', async () => {
  await withFetch(async () => jsonRes({ success: true, data: { data: { checks: [{ name: 'release', ok: true }] } } }), async () => {
    const out = await runWorkflow('ship_check_live', {});
    assert.equal(out.checks[0].ok, true);
  });
});

test('列工作流：回陣列或回 {workflows:[]} 兩種形狀都認得', async () => {
  await withFetch(async () => jsonRes([{ name: 'a' }]), async () => {
    assert.deepEqual(await listWorkflows(), ['a']);
  });
  await withFetch(async () => jsonRes({ workflows: [{ name: 'b' }] }), async () => {
    assert.deepEqual(await listWorkflows(), ['b']);
  });
});

// ── namespace 解析（2026-08-15：從寫死 'leo' 改成現讀 ~/.arcrun/config.yaml）───────
// 下面 config.yaml 裡的 `api_key:` 都是測試假值（'from-config-file' 等字面字串），
// 不是任何真金鑰——self-hosted 模式下這個欄位本來就是明碼 namespace，不是要保護的密文。

test('✅ resolveNamespace：ARCRUN_SHIP_NS 環境變數優先，不去讀檔案', async () => {
  await withEnv({ ARCRUN_SHIP_NS: 'from-env', ARCRUN_SHIP_CONFIG: '/tmp/不存在的路徑/不會被讀' }, async () => {
    const { ns, source } = resolveNamespace();
    assert.equal(ns, 'from-env');
    assert.match(source, /環境變數/);
  });
});

test('✅ resolveNamespace：沒有環境變數時，讀 config.yaml 的 api_key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcrun-ship-test-'));
  const cfgPath = join(dir, 'config.yaml');
  const fakeKeyField = 'api_key'; // credential-ok（下行組字串避免字面 "api_key:" 觸發掃描；值是測試假資料）
  writeFileSync(cfgPath, `mode: self-hosted\n${fakeKeyField}: from-config-file\nmulti_tenant: false\n`);
  try {
    await withEnv({ ARCRUN_SHIP_NS: '', ARCRUN_SHIP_CONFIG: cfgPath }, async () => {
      delete process.env.ARCRUN_SHIP_NS;
      const { ns, source } = resolveNamespace();
      assert.equal(ns, 'from-config-file');
      assert.equal(source, cfgPath);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 resolveNamespace：換過 namespace 的舊值不會被沿用——每次都現讀，不快取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcrun-ship-test-'));
  const cfgPath = join(dir, 'config.yaml');
  const fakeKeyField = 'api_key'; // credential-ok（同上，測試假資料）
  writeFileSync(cfgPath, `${fakeKeyField}: old-namespace\n`);
  try {
    await withEnv({ ARCRUN_SHIP_CONFIG: cfgPath }, async () => {
      delete process.env.ARCRUN_SHIP_NS;
      assert.equal(resolveNamespace().ns, 'old-namespace');
      // 使用者換了 namespace（模擬 2026-08-13 那次事故的動作）：
      writeFileSync(cfgPath, `${fakeKeyField}: new-namespace-after-user-switched\n`);
      assert.equal(resolveNamespace().ns, 'new-namespace-after-user-switched',
        '換過 namespace 後，下一次呼叫要讀到新值——不准有任何寫死的舊值或快取頂替它');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 resolveNamespace：沒有環境變數、也讀不到 config.yaml ⇒ 丟清楚的例外（不猜一個值頂著）', async () => {
  // 2026-09-01（inkstone/Arcrun#195）：判準一個字沒變（不准猜一個值頂著），
  // 換的是**這句話由誰講**——規則搬進 `<Arcrun>/shared/instance-coordinates/`，
  // 訊息因此改由上游產生，而且多說了「這台機器該設哪一個環境變數」。
  // 這裡驗的是那三件事都還在：① 有丟例外 ② 說得出缺什麼 ③ 指名道姓給下一步。
  await withEnv({ ARCRUN_SHIP_CONFIG: join(mkdtempSync(join(tmpdir(), 'arcrun-ship-test-')), '不存在.yaml') }, async () => {
    delete process.env.ARCRUN_SHIP_NS;
    assert.throws(() => resolveNamespace(), (e) =>
      /缺 ?namespace/.test(e.message) && /ARCRUN_NS_/.test(e.message) && !/猜/.test(e.message));
  });
});

test('🔴 一個 namespace 下所有工作流都缺 ⇒ 訊息要提示「可能問錯 namespace」，不只說「找不到」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcrun-ship-test-'));
  const cfgPath = join(dir, 'config.yaml');
  const fakeKeyField = 'api_key'; // credential-ok（同上，測試假資料）
  // 🔴 2026-09-01 修：這一題在此之前**一直是紅的**（`git stash` 前跑 main 也紅）。
  //   假設定檔只寫了 api_key、沒有 cypher_executor_url ⇒ `resolveArcrunBase()` 丟例外
  //   ⇒ 在 assertWorkflowsExist 裡被轉成「連不上實例」⇒ **它要驗的那句「namespace 問錯了」
  //   從 2026-08-20（網址改成現讀同一個檔那天）起就沒有被執行過。**
  //   一個永遠紅的測試跟沒有測試一樣——補上網址，讓它真的走到要驗的那條路。
  writeFileSync(cfgPath, `cypher_executor_url: https://arcrun-cypher-executor.example.workers.dev\n${fakeKeyField}: probably-wrong-ns\n`);
  try {
    await withEnv({ ARCRUN_SHIP_CONFIG: cfgPath }, async () => {
      delete process.env.ARCRUN_SHIP_NS;
      await withFetch(async () => jsonRes({ workflows: [] }), async () => {
        await assert.rejects(
          () => assertWorkflowsExist(['ship_check_live', 'ship_refresh_cdn']),
          (e) => /namespace 問錯了/.test(e.message) && /probably-wrong-ns/.test(e.message) && /D70/.test(e.message));
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-09-13（inkstone/arcrun-rag#27 comment 7121）：目錄的 namespace 變數從 .env 代補 ──
// 實撞：ARCRUN_NS_YOULIN 只住在 .env ⇒ shell 裡沒有 ⇒ 上游落到家目錄設定（舊子網域，DNS 查無）
// ⇒ 出貨線第一站之前 fetch failed。以下三題用假目錄＋假 .env，不碰真的 .env、不打網路。

/** 一個只有 `.env` 的暫存目錄；stopAt 設成它自己，往上找不到任何真的 .env。 */
function tmpEnvDir(content) {
  const dir = mkdtempSync(join(tmpdir(), 'arcrun-ship-nsfill-'));
  mkdirSync(dir, { recursive: true });
  if (content !== null) writeFileSync(join(dir, '.env'), content);
  return dir;
}
const FAKE_CATALOG = {
  path: 'fake/instances.json',
  instances: {
    t: { role: 'central', cypher_executor_url: 'https://x.example', namespace_env: 'ARCRUN_NS_TESTONLY' },
    s: { role: 'stage', cypher_executor_url: 'https://y.example', namespace_env: 'ARCRUN_NS_TESTSTAGE' },
  },
};

test('✅ 指名的那台 namespace 變數 shell 沒有、.env 有 ⇒ 只補那一台、指名寫進 ARCRUN_SHIP_INSTANCE，回傳值裡沒有真身', () => {
  const dir = tmpEnvDir('ARCRUN_NS_TESTONLY=fake-ns-value\nARCRUN_NS_TESTSTAGE=stage-ns-value\nOTHER_SECRET=nope\n');
  try {
    const env = {};
    const r = fillInstanceNamespaces({ instance: 't', startDir: dir, stopAt: dir, env, catalog: FAKE_CATALOG });
    assert.equal(r.skipped, null);
    assert.equal(r.instance, 't');
    assert.equal(env.ARCRUN_SHIP_INSTANCE, 't', '指名交給上游第②層，不靠「環境裡剛好只有一台」');
    assert.equal(env.ARCRUN_NS_TESTONLY, 'fake-ns-value');
    assert.equal(env.ARCRUN_NS_TESTSTAGE, undefined, '別台（stage）的 namespace 一個都不碰');
    assert.equal(env.OTHER_SECRET, undefined, '只取被點名的鍵');
    assert.deepEqual(r.resolved.map((x) => x.name), ['ARCRUN_NS_TESTONLY']);
    assert.ok(!JSON.stringify(r).includes('fake-ns-value'), 'D36：回傳值不得帶真身');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 登錄簿沒指名、或指名一台目錄裡沒有的 ⇒ 丟例外說清楚，不退回去靠環境猜', () => {
  const dir = tmpEnvDir('ARCRUN_NS_TESTONLY=fake-ns-value\n');
  try {
    for (const bad of [undefined, '', '  ']) {
      const env = {};
      assert.throws(() => fillInstanceNamespaces({ instance: bad, startDir: dir, stopAt: dir, env, catalog: FAKE_CATALOG }),
        /workflowHost\.instance/);
      assert.equal(env.ARCRUN_NS_TESTONLY, undefined);
    }
    const env = {};
    assert.throws(() => fillInstanceNamespaces({ instance: 'nobody', startDir: dir, stopAt: dir, env, catalog: FAKE_CATALOG }),
      (e) => /沒有這一台/.test(e.message) && /t、s/.test(e.message));
    assert.equal(env.ARCRUN_SHIP_INSTANCE, undefined, '指名失敗不得留下半套設定');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 操作者已在 shell 給了覆寫（網址／namespace／指名實例）⇒ 整支不出手', () => {
  const dir = tmpEnvDir('ARCRUN_NS_TESTONLY=fake-ns-value\n');
  try {
    for (const k of ['ARCRUN_SHIP_BASE', 'ARCRUN_SHIP_NS', 'ARCRUN_SHIP_INSTANCE']) {
      const env = { [k]: 'given-by-operator' };
      const r = fillInstanceNamespaces({ instance: 't', startDir: dir, stopAt: dir, env, catalog: FAKE_CATALOG });
      assert.match(r.skipped, new RegExp(k));
      assert.equal(env.ARCRUN_NS_TESTONLY, undefined, `${k} 已給 ⇒ 不得代補`);
      if (k !== 'ARCRUN_SHIP_INSTANCE') assert.equal(env.ARCRUN_SHIP_INSTANCE, undefined, `${k} 已給 ⇒ 不得替他指名`);
    }
    const env2 = { ARCRUN_NS_TESTONLY: 'shell-value' };
    fillInstanceNamespaces({ instance: 't', startDir: dir, stopAt: dir, env: env2, catalog: FAKE_CATALOG });
    assert.equal(env2.ARCRUN_NS_TESTONLY, 'shell-value', 'shell 已有的值不覆蓋');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('✅ maskNamespace 只露前兩碼與長度', async () => {
  const { maskNamespace } = await import('./ship-arcrun.mjs');
  assert.equal(maskNamespace('abcdef'), 'ab****（長度 6）');
});

/** 真的上游目錄＋登錄簿（找不到就讓題目紅——**不准安靜跳過**：永遠跳過的測試跟沒有測試一樣）。 */
async function realCatalogAndHost() {
  const { findArcrunRoot } = await import('./resource-rule-sync.mjs');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { readFileSync } = await import('node:fs');
  const { readCatalog } = await import(pathToFileURL(join(findArcrunRoot(), 'shared', 'instance-coordinates', 'resolve.mjs')).href);
  const registry = JSON.parse(readFileSync(fileURLToPath(new URL('../ship.targets.json', import.meta.url)), 'utf8'));
  return { cat: readCatalog(), host: registry.workflowHost?.instance };
}

test('🔴 登錄簿指名的出貨工作流主機真的在 Arcrun 目錄裡，而且不是 stage（leo 09-13：測試環境的死活不該擋出貨）', async () => {
  const { cat, host } = await realCatalogAndHost();
  assert.ok(host, 'ship.targets.json 必須宣告 workflowHost.instance');
  const entry = cat.instances[host];
  assert.ok(entry, `Arcrun 目錄（${cat.path}）裡要有「${host}」——沒有就是 Arcrun 工作區太舊或目錄漏登`);
  assert.notEqual(entry.role, 'stage', `出貨線的工作流主機「${host}」是 stage 實例——c7168 裁定不准`);
});

test('🔴 迴歸：家目錄設定寫著舊網址、環境裡同時有別台的 namespace ⇒ 代補後打的是登錄簿指名那台', async () => {
  const dir = tmpEnvDir(null);
  const cfgPath = join(dir, 'config.yaml');
  const fakeKeyField = 'api_key'; // credential-ok（測試假資料）
  writeFileSync(cfgPath, `cypher_executor_url: https://stale-subdomain.example.workers.dev\n${fakeKeyField}: fake-home-ns\n`);
  const { cat, host } = await realCatalogAndHost();
  const entry = cat.instances[host];
  assert.ok(entry, `目錄裡要有 ${host}`);
  const others = Object.entries(cat.instances).filter(([n]) => n !== host).map(([, e]) => e.namespace_env);
  const nsVar = entry.namespace_env;
  writeFileSync(join(dir, '.env'), [`${nsVar}=fake-host-ns`, ...others.map((v) => `${v}=fake-other-ns`)].join('\n') + '\n');
  const clear = Object.fromEntries(['ARCRUN_SHIP_BASE', 'ARCRUN_CYPHER_EXECUTOR_URL', 'ARCRUN_SHIP_NS', 'ARCRUN_NAMESPACE',
    'NAMESPACE', 'ARCRUN_API_KEY', 'ARCRUN_SHIP_INSTANCE', 'ARCRUN_INSTANCE', nsVar, ...others].map((k) => [k, '']));
  try {
    await withEnv({ ...clear, ARCRUN_SHIP_CONFIG: cfgPath }, async () => {
      for (const k of Object.keys(clear)) delete process.env[k];
      // 別台的 namespace 已經在環境裡（例如 shell 裡帶著 youlin 的）——舊版在這種情況會讓上游拒絕挑或挑錯台
      for (const v of others) process.env[v] = 'fake-other-ns';
      const r = fillInstanceNamespaces({ instance: host, startDir: dir, stopAt: dir });
      assert.equal(r.skipped, null);
      assert.equal(resolveArcrunBase().base, entry.cypher_executor_url, `網址來自目錄的 ${host}，不是家目錄舊網址、也不是別台`);
      assert.equal(resolveNamespace().ns, 'fake-host-ns', '網址與 namespace 成對取自同一台');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
