/**
 * inkstone/arcrun-rag#334（母票 inkstone/Arcrun#399）：安裝器打 cypher 要帶合法憑證。
 * 公式（Arcrun#399 c1794480503109218）：
 *   Authorization: Bearer hex(HMAC-SHA256(key=KBDB_INTERNAL_TOKEN, msg="kbdb-proxy-v1\n"+租戶名))
 * 期望值用 node:crypto 獨立算一遍，不用被測的 WebCrypto 版對自己。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  deriveKbdbProxyKey, cypherAuthHeaders, seedSkillsTo, pushWorkflowTo, seedCredential,
} from './worker.js';

const realFetch = globalThis.fetch;
const TOKEN = 'a'.repeat(64);
const NS = 'ns-tenant-1';
const want = () => createHmac('sha256', TOKEN).update('kbdb-proxy-v1\n' + NS).digest('hex');

// 「相容期已關」的假 cypher：只有 租戶名＋對的 Bearer 才放行，其餘 401
function strictCypher(handler) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const h = new Headers(init.headers || {});
    const ok = h.get('x-arcrun-api-key') === NS && h.get('authorization') === 'Bearer ' + want();
    seen.push({ url, method: init.method || 'GET', ok });
    if (!ok) return new Response('{"error":"unauthorized"}', { status: 401 });
    return handler(url, init);
  };
  return seen;
}
const restore = () => { globalThis.fetch = realFetch; };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('#334 deriveKbdbProxyKey 與獨立算的 HMAC 一致（公式只有一套）', async () => {
  assert.equal(await deriveKbdbProxyKey(TOKEN, NS), want());
  assert.notEqual(await deriveKbdbProxyKey(TOKEN, 'other-tenant'), want(), '憑證綁租戶');
});

test('#334 cypherAuthHeaders：有金鑰帶 Bearer；沒金鑰只帶租戶名（相容期舊行為）', async () => {
  assert.deepEqual(await cypherAuthHeaders(NS, TOKEN), { 'X-Arcrun-API-Key': NS, Authorization: 'Bearer ' + want() });
  assert.deepEqual(await cypherAuthHeaders(NS, null), { 'X-Arcrun-API-Key': NS });
});

test('#334 寫 agent-skill 進 /kbdb/entries（探／POST／PATCH）對相容期已關的 cypher 都通', async () => {
  const seen = strictCypher((url, init) => {
    if (url.includes('/kbdb/entries?')) return json({ entries: [] });
    return json({ success: true, entry: { id: 'e1' } });
  });
  let sk;
  try { sk = await seedSkillsTo('https://cy.test', NS, TOKEN); } finally { restore(); }
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter((c) => !c.ok), [], '每一發都要帶憑證');
  assert.equal(sk.errors.length, 0, sk.errors.join('; '));
  assert.ok(sk.created.length >= 7);
  // 對照組：不給金鑰 ⇒ 同一台伺服器全 401（證明上面的通是 Bearer 的功勞）
  strictCypher(() => json({}));
  let bad;
  try { bad = await seedSkillsTo('https://cy.test', NS); } finally { restore(); }
  assert.ok(bad.errors.length > 0 || bad.created.length === 0, '沒帶憑證不該寫得進');
});

test('#334 推工作流（讀定義／寫入）帶憑證——金鑰取自 subs.__KBDB_TOKEN__', async () => {
  const seen = strictCypher((url) => url.includes('/definition') ? json({ error: 'nf' }, 404) : json({ success: true }));
  let r;
  try {
    r = await pushWorkflowTo('https://cy.test', NS, { '__KBDB_TOKEN__': TOKEN },
      { name: 'wf1', graph: { nodes: [{ id: 'a' }], edges: [] }, config: {}, flow: [] });
  } finally { restore(); }
  assert.ok(seen.length >= 2, '至少讀一次定義＋寫一次');
  assert.deepEqual(seen.filter((c) => !c.ok), [], '每一發都要帶憑證');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('#334 種 credential 目錄（/credentials/directory）帶憑證', async () => {
  const seen = strictCypher((url) => url.endsWith('/credentials/directory')
    ? json({ success: true, secret_ref: 'CRED_X', secret_script: 'arcrun-cypher-executor' })
    : json({ success: true, result: {} }));
  try {
    await seedCredential('cf-token', 'acct-1', 'https://cy.test', NS, 'kbdb_internal_token', 'v', 'kbdb', 'high', TOKEN);
  } catch (_) { /* 後面的 CF secrets PUT 不在本測試範圍 */ } finally { restore(); }
  const dir = seen.find((c) => c.url.endsWith('/credentials/directory'));
  assert.ok(dir && dir.ok, '目錄那一發要帶憑證');
});
