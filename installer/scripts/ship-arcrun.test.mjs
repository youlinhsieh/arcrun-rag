/**
 * ship-arcrun.test.mjs — 證明「站表宣告的工作流必須真的存在」那道閘會擋，
 * 而且**連不上實例時也擋**（不是安靜當作沒事）。
 *
 * 為什麼特別測「連不上」：這類閘最常見的壞法不是判斷寫錯，是**例外被吞掉變成放行**。
 * 出貨線上一次「HTTP 200 就當驗過」的教訓已經記在 CRITICAL-PATH 使用規則 6 裡。
 *
 * 跑法：node --test installer/scripts/ship-arcrun.test.mjs（不打任何真的網路）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowsExist, listWorkflows, runWorkflow } from './ship-arcrun.mjs';

/** 換掉 globalThis.fetch 跑一段，結束後還原（不碰真的網路）。 */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
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
