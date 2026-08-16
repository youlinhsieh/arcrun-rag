/**
 * check-geek6688-drift.test.mjs — 證明「落後 → 判定不一致 → 真的叫」這條邏輯本身是對的。
 *
 * 跑法：node --test installer/scripts/check-geek6688-drift.test.mjs
 * （零依賴、全程用假 fetch，不打任何真實網路——同 verify-mail-relay.test.mjs 的做法）
 *
 * 真正打真網路的「故意讓它不一致 → 真的叫了」實測，記在 inkstone/arcrun-rag#112
 * 的 comment 裡（2026-08-16，用真實的 geek6688 1.4.41 vs stage 1.4.47 跑出來的，
 * 不是本檔模擬的）。本檔只負責證明：純函式的判斷邏輯本身不會漂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkParity, fetchVersion } from './check-geek6688-drift.mjs';

function fakeFetch(versionByHost) {
  return async (url) => {
    const host = new URL(url).host;
    const v = versionByHost[host];
    if (v === undefined) return { ok: false, status: 404 };
    if (v === 'BAD_JSON') return { ok: true, json: async () => { throw new Error('not json'); } };
    return { ok: true, json: async () => ({ ok: true, bundle_version: v }) };
  };
}

test('🚨 落後：出貨機版本 ≠ stage 版本 ⇒ ok:false 且帶 drift 明細', async () => {
  const fetchImpl = fakeFetch({
    'stage.example': '1.4.47',
    'target.example': '1.4.41',
  });
  const result = await checkParity({
    stageBase: 'https://stage.example',
    targetBase: 'https://target.example',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.drift, { stageVersion: '1.4.47', targetVersion: '1.4.41' });
  assert.ok(result.lines.some((l) => l.includes('🚨')), '落後時要有 🚨 那一行，不是安靜記錄');
});

test('✅ 同版：出貨機版本 ＝ stage 版本 ⇒ ok:true、drift 為 null', async () => {
  const fetchImpl = fakeFetch({
    'stage.example': '1.4.47',
    'target.example': '1.4.47',
  });
  const result = await checkParity({
    stageBase: 'https://stage.example',
    targetBase: 'https://target.example',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.drift, null);
  assert.ok(result.lines.some((l) => l.includes('✅')));
});

test('讀不到 stage（fetch 失敗/非 2xx）⇒ ok:false，且不假裝比對出一個 drift', async () => {
  const fetchImpl = fakeFetch({
    'target.example': '1.4.41',
    // stage.example 沒給 ⇒ 404
  });
  const result = await checkParity({
    stageBase: 'https://stage.example',
    targetBase: 'https://target.example',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.drift, null, '一邊讀不到時不該假裝算出版本差異');
});

test('讀不到出貨機 ⇒ ok:false，drift 為 null（同上，換成另一邊壞）', async () => {
  const fetchImpl = fakeFetch({
    'stage.example': '1.4.47',
  });
  const result = await checkParity({
    stageBase: 'https://stage.example',
    targetBase: 'https://target.example',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.drift, null);
});

test('fetchVersion：/health 回應沒有 bundle_version 欄位 ⇒ 明確錯誤，不是 undefined 悄悄過關', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const r = await fetchVersion('https://x.example', fetchImpl);
  assert.equal(r.ok, false);
  assert.match(r.error, /bundle_version/);
});

test('fetchVersion：回應不是合法 JSON ⇒ 明確錯誤', async () => {
  const fetchImpl = fakeFetch({ 'x.example': 'BAD_JSON' });
  const r = await fetchVersion('https://x.example', fetchImpl);
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
});
