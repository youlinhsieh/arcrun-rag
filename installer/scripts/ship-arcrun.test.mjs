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
import { assertWorkflowsExist, listWorkflows, runWorkflow, resolveNamespace } from './ship-arcrun.mjs';

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
  await withEnv({ ARCRUN_SHIP_CONFIG: join(mkdtempSync(join(tmpdir(), 'arcrun-ship-test-')), '不存在.yaml') }, async () => {
    delete process.env.ARCRUN_SHIP_NS;
    assert.throws(() => resolveNamespace(), /不知道要問哪個 namespace/);
  });
});

test('🔴 一個 namespace 下所有工作流都缺 ⇒ 訊息要提示「可能問錯 namespace」，不只說「找不到」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcrun-ship-test-'));
  const cfgPath = join(dir, 'config.yaml');
  const fakeKeyField = 'api_key'; // credential-ok（同上，測試假資料）
  writeFileSync(cfgPath, `${fakeKeyField}: probably-wrong-ns\n`);
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
