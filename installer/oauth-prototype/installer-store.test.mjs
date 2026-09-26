/**
 * InstallerStore／kvOverDurableObject／attachKvShim 離線測試（inkstone/arcrun-rag#217）
 *
 * 跑法：node --test installer-store.test.mjs
 *
 * 背景：安裝器自己（官方帳號）原本綁一顆 INSTALLER_KV 存 session／OAuth state／
 * 安裝進度／部署紀錄，改成 Durable Object 之後，`worker.js` 裡所有
 * `env.INSTALLER_KV.get/put/delete/list` 呼叫維持原樣不動——這支測試證明
 * `kvOverDurableObject()` 包出來的物件，對這四個方法的行為跟 Workers KV
 * 一致（含 `'json'` 型別、`expirationTtl` 過期、`list({prefix, limit})`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstallerStore, kvOverDurableObject, attachKvShim } from './worker.js';

/** 假的 DO `state.storage`——純記憶體 Map，介面對齊 DO storage API。 */
function makeFakeDoStorage() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : undefined; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list({ prefix = '', limit } = {}) {
      const out = new Map();
      const keys = [...map.keys()].sort();
      for (const k of keys) {
        if (!k.startsWith(prefix)) continue;
        out.set(k, map.get(k));
        if (limit && out.size >= limit) break;
      }
      return out;
    },
  };
}

/** 假的 DurableObjectNamespace：同一個 idFromName 永遠拿到同一個 InstallerStore 實例。 */
function makeFakeDoNamespace() {
  const instances = new Map();
  return {
    idFromName(name) { return `id:${name}`; },
    get(id) {
      if (!instances.has(id)) {
        instances.set(id, new InstallerStore({ storage: makeFakeDoStorage() }));
      }
      const store = instances.get(id);
      return { fetch: (url, init) => store.fetch(new Request(url, init)) };
    },
  };
}

test('kvOverDurableObject：put／get 原樣往返（字串，不指定 type）', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
  await kv.put('a', 'hello');
  assert.equal(await kv.get('a'), 'hello');
});

test('kvOverDurableObject：get(key, "json") 對齊 KV 的 JSON 解析', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
  await kv.put('sess:x', JSON.stringify({ access_token: 't1' }));
  const v = await kv.get('sess:x', 'json');
  assert.deepEqual(v, { access_token: 't1' });
});

test('kvOverDurableObject：沒存過的 key 回 null（不是 undefined、不丟例外）', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
  assert.equal(await kv.get('nope'), null);
  assert.equal(await kv.get('nope', 'json'), null);
});

test('kvOverDurableObject：delete 之後讀不到', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
  await kv.put('k', 'v');
  await kv.delete('k');
  assert.equal(await kv.get('k'), null);
});

test('kvOverDurableObject：list 依 prefix／limit 過濾，形狀對齊 KV（{keys:[{name}]}）', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
  await kv.put('prog:a', '1');
  await kv.put('prog:b', '2');
  await kv.put('sess:c', '3');
  const { keys } = await kv.list({ prefix: 'prog:' });
  assert.deepEqual(keys.map((k) => k.name).sort(), ['prog:a', 'prog:b']);
  const limited = await kv.list({ prefix: 'prog:', limit: 1 });
  assert.equal(limited.keys.length, 1);
});

test('🔴 kvOverDurableObject：expirationTtl 到期後 get 回 null、list 也濾掉（惰性過期）', async () => {
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main');
    await kv.put('cronlock:x', String(now), { expirationTtl: 300 }); // 5 分鐘
    assert.equal(await kv.get('cronlock:x'), String(now)); // 還沒過期

    now += 301_000; // 過了 301 秒 ⇒ 過期
    assert.equal(await kv.get('cronlock:x'), null);

    await kv.put('prog:y', '{}', { expirationTtl: 60 });
    now += 61_000;
    const { keys } = await kv.list({ prefix: 'prog:' });
    assert.deepEqual(keys, []); // 過期的 key 不該出現在 list 裡
  } finally {
    Date.now = realNow;
  }
});

test('attachKvShim：INSTALLER_STORE 存在且 INSTALLER_KV 還沒設過 ⇒ 接上 DO', async () => {
  const env = { INSTALLER_STORE: makeFakeDoNamespace() };
  attachKvShim(env);
  assert.ok(env.INSTALLER_KV);
  await env.INSTALLER_KV.put('k', 'v');
  assert.equal(await env.INSTALLER_KV.get('k'), 'v');
});

test('attachKvShim：env.INSTALLER_KV 已經被設過（測試塞的假物件）⇒ 不動它', async () => {
  const fake = { get: async () => 'sentinel', put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) };
  const env = { INSTALLER_STORE: makeFakeDoNamespace(), INSTALLER_KV: fake };
  attachKvShim(env);
  assert.equal(env.INSTALLER_KV, fake); // 沒被換掉
  assert.equal(await env.INSTALLER_KV.get('anything'), 'sentinel');
});

test('attachKvShim：PEER_INSTALLER_STORE 同理接上 PEER_INSTALLER_KV，且與 INSTALLER_KV 各自獨立', async () => {
  const env = { INSTALLER_STORE: makeFakeDoNamespace(), PEER_INSTALLER_STORE: makeFakeDoNamespace() };
  attachKvShim(env);
  await env.INSTALLER_KV.put('k', 'mine');
  await env.PEER_INSTALLER_KV.put('k', 'peer');
  assert.equal(await env.INSTALLER_KV.get('k'), 'mine');
  assert.equal(await env.PEER_INSTALLER_KV.get('k'), 'peer');
});

test('attachKvShim：沒有任何 DO binding ⇒ env.INSTALLER_KV 維持 undefined（沿用既有「缺少 binding」錯誤頁邏輯）', async () => {
  const env = {};
  attachKvShim(env);
  assert.equal(env.INSTALLER_KV, undefined);
});

// ---------------------------------------------------------------------------
// 過渡期 legacy KV read-through（inkstone/arcrun-rag#217 comment 11162）
// ---------------------------------------------------------------------------
// prod 的舊 INSTALLER_KV 有現役用戶的 `deployed:<acc>:<sub>` 紀錄，換成 DO 那一刻
// DO 是空的——這裡證明「DO 沒有才問舊 KV，問到就搬回 DO」這條路真的通，
// 而且 hasDeployRecordForToken() 賴以維生的 `list({prefix, limit:1})` 存在性檢查
// 也看得到只存在於舊 KV 的 key。

/** 假的、行為對齊真 Workers KV 的 legacy 命名空間（get/put/delete/list）。 */
function makeFakeLegacyKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit } = {}) {
      const keys = [];
      for (const name of store.keys()) {
        if (!name.startsWith(prefix)) continue;
        keys.push({ name });
        if (limit && keys.length >= limit) break;
      }
      return { keys };
    },
  };
}

test('kvOverDurableObject＋legacyKv：DO 沒有時 fallback 讀舊 KV，並把值搬回 DO', async () => {
  const legacy = makeFakeLegacyKv({ 'sess:x': JSON.stringify({ access_token: 'old-token' }) });
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);

  const v1 = await kv.get('sess:x', 'json');
  assert.deepEqual(v1, { access_token: 'old-token' }); // 第一次：從舊 KV 撈到

  // 搬家後 DO 自己就有了——清空舊 KV，再讀一次應該還是拿得到（證明真的寫回 DO 了）。
  legacy.store.delete('sess:x');
  const v2 = await kv.get('sess:x', 'json');
  assert.deepEqual(v2, { access_token: 'old-token' });
});

test('kvOverDurableObject＋legacyKv：兩邊都沒有 ⇒ 回 null，不丟例外', async () => {
  const legacy = makeFakeLegacyKv();
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);
  assert.equal(await kv.get('nope', 'json'), null);
});

test('🔴 kvOverDurableObject＋legacyKv：list 存在性檢查看得到只存在於舊 KV 的 key（hasDeployRecordForToken 賴以維生的那條路）', async () => {
  const legacy = makeFakeLegacyKv({ 'deployed:acc1:sub1': JSON.stringify({ workers: {} }) });
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);

  // DO 完全是空的（沒人 get 過這把 key，所以還沒搬家），但 list 存在性檢查要看得到它，
  // 這正是 hasDeployRecordForToken() 的用法：list({prefix:`deployed:${accountId}:`, limit:1})。
  const { keys } = await kv.list({ prefix: 'deployed:acc1:', limit: 1 });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, 'deployed:acc1:sub1');
});

test('kvOverDurableObject＋legacyKv：list 合併 DO 與舊 KV 的 key，不重複、尊重 limit', async () => {
  const legacy = makeFakeLegacyKv({ 'prog:legacy1': '1', 'prog:legacy2': '2' });
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);
  await kv.put('prog:fresh', '3'); // 已經搬過去 DO 的一把

  const all = await kv.list({ prefix: 'prog:' });
  assert.deepEqual(all.keys.map((k) => k.name).sort(), ['prog:fresh', 'prog:legacy1', 'prog:legacy2']);

  const limited = await kv.list({ prefix: 'prog:', limit: 2 });
  assert.equal(limited.keys.length, 2);
});

test('kvOverDurableObject＋legacyKv：DO 已經有值就不再問舊 KV（read-through 只做一次）', async () => {
  const legacy = makeFakeLegacyKv({ k: 'legacy-value' });
  let legacyGetCalls = 0;
  const realGet = legacy.get.bind(legacy);
  legacy.get = async (key) => { legacyGetCalls += 1; return realGet(key); };

  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);
  await kv.get('k'); // 觸發一次 fallback + 搬家
  await kv.get('k'); // 這次 DO 已經有了，不該再碰 legacy
  assert.equal(legacyGetCalls, 1);
});

test('kvOverDurableObject＋legacyKv：delete 兩邊都砍，避免舊 KV 讓資料復活', async () => {
  const legacy = makeFakeLegacyKv({ k: 'v' });
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', legacy);
  await kv.delete('k');
  assert.equal(legacy.store.has('k'), false);
  assert.equal(await kv.get('k'), null);
});

test('kvOverDurableObject：沒有 legacyKv（youlin-stage 那種全新環境）⇒ 行為跟原本純 DO 版一模一樣', async () => {
  const kv = kvOverDurableObject(makeFakeDoNamespace(), 'main', null);
  assert.equal(await kv.get('nope'), null);
  await kv.put('a', 'b');
  assert.equal(await kv.get('a'), 'b');
  const { keys } = await kv.list({ prefix: '' });
  assert.deepEqual(keys.map((k) => k.name), ['a']);
});

test('attachKvShim：env.INSTALLER_KV_LEGACY 有給 ⇒ 接成 kv 的 legacy 來源', async () => {
  const legacy = makeFakeLegacyKv({ 'deployed:acc:sub': '{}' });
  const env = { INSTALLER_STORE: makeFakeDoNamespace(), INSTALLER_KV_LEGACY: legacy };
  attachKvShim(env);
  const { keys } = await env.INSTALLER_KV.list({ prefix: 'deployed:acc:' });
  assert.equal(keys.length, 1);
});
