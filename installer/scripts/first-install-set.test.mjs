/**
 * first-install-set.test.mjs — 跑法：`node --test installer/scripts/first-install-set.test.mjs`
 *
 * 這幾條測試釘的是 2026-08-14 那次災情的**形狀**，不是某一顆零件的名字：
 *   ① 隱含依賴（`{{credential.X}}`）要被抓到——漏掉它就是打死整個產品的那一次
 *   ② 看不懂的東西要**丟例外**，不是安靜跳過——安靜跳過正是那份清單少一顆而沒人知道的原因
 *   ③ recipe 不是零件——把它當零件會去找一顆永遠不存在的 worker
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveFromWorkflows,
  firstInstallSet,
  loadInstallerPlaceholders,
  canonicalToWorkerName,
  CREDENTIAL_RESOLVER,
} from './first-install-set.mjs';

const PLACEHOLDERS = {
  urlPlaceholders: { __HTTP_REQ_URL__: 'arcrun-http-request', __CODE_URL__: 'arcrun-code' },
  paramPlaceholders: new Set(['__NAMESPACE__']),
};
const LIBRARY = new Set([
  'arcrun-cypher-executor', 'arcrun-kbdb', 'arcrun-rag-ui', 'arcrun-mcp',
  'arcrun-http-request', 'arcrun-code', 'arcrun-auth-static-key', 'arcrun-if-control',
]);
const opts = (extra = {}) => ({ placeholders: PLACEHOLDERS, library: LIBRARY, ...extra });

test('隱含依賴：工作流只要出現 {{credential.X}}，解憑證那顆就必須被算進去', () => {
  const wf = [{
    name: 'rag_chat',
    config: { fetch: { component: '__HTTP_REQ_URL__', headers: { Authorization: 'Bearer {{credential.kbdb_internal_token}}' } } },
  }];
  const { required } = deriveFromWorkflows(wf, opts());
  assert.ok(required.includes(CREDENTIAL_RESOLVER),
    `解憑證那顆沒被抓到 ⇒ 這正是 2026-08-14 那份清單的形狀。實得：${required.join('、')}`);
});

test('只掃節點型別會漏掉它——所以節點型別完全沒提到它時也要抓到', () => {
  const wf = [{ name: 'x', config: { a: { component: '__CODE_URL__', body: '{{credential.gemini_api_key}}' } } }];
  const { evidence } = deriveFromWorkflows(wf, opts());
  const why = evidence.find((e) => e.worker === CREDENTIAL_RESOLVER)?.why || '';
  assert.match(why, /credential/, '證據要說得出「是哪一個 credential 參照讓它進來的」');
});

test('零件的 canonical id 會變成 worker 名', () => {
  const wf = [{ name: 'x', config: { gate: { component: 'if_control' } } }];
  const { required } = deriveFromWorkflows(wf, opts());
  assert.ok(required.includes(canonicalToWorkerName('if_control')));
  assert.equal(canonicalToWorkerName('if_control'), 'arcrun-if-control');
});

test('recipe 不是零件：它不需要任何 worker', () => {
  const wf = [{ name: 'x', config: { ask: { component: 'workers_ai_chat' } } }];
  const { required } = deriveFromWorkflows(wf, opts({ recipes: new Set(['workers_ai_chat']) }));
  assert.deepEqual(required, [], `recipe 被當成零件了：${required.join('、')}`);
});

test('零件位址用了不認得的佔位符 ⇒ 丟例外（不准安靜跳過）', () => {
  const wf = [{ name: 'x', config: { a: { component: '__SOMETHING_NEW__' } } }];
  assert.throws(() => deriveFromWorkflows(wf, opts()), /當成零件位址/);
});

test('推出來的零件不在公庫裡 ⇒ 丟例外（沒有貨就不准出貨）', () => {
  const wf = [{ name: 'x', config: { a: { component: 'not_a_real_component' } } }];
  assert.throws(() => deriveFromWorkflows(wf, opts()), /公庫裡沒有/);
});

test('別的欄位出現沒宣告的佔位符 ⇒ 是警告不是中止（它與首裝清單無關，但要被看見）', () => {
  const wf = [{ name: 'x', config: { a: { component: '__CODE_URL__', path: '__CARDS_PREFIX__/y' } } }];
  const { warnings, required } = deriveFromWorkflows(wf, opts());
  assert.ok(required.includes('arcrun-code'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /__CARDS_PREFIX__/);
});

test('引擎底盤一定在首裝裡，而且每一顆都寫得出理由', () => {
  const { names, reasons } = firstInstallSet([], opts());
  for (const n of ['arcrun-cypher-executor', 'arcrun-kbdb', 'arcrun-rag-ui', 'arcrun-mcp']) {
    assert.ok(names.includes(n), `${n} 不在首裝裡`);
    assert.ok((reasons.find((r) => r.worker === n)?.why || '').length > 10, `${n} 沒有寫理由`);
  }
});

test('佔位符對應表讀的是安裝器自己的代換表，不是另抄一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  const f = join(dir, 'worker.js');
  writeFileSync(f, [
    'let workerUrl = `https://arcrun-cypher-executor.${sub}.workers.dev`;',
    'const subs = {',
    "  '__CYPHER_BASE__': workerUrl,",
    "  '__HTTP_REQ_URL__': `https://arcrun-http-request.${sub}.workers.dev`,",
    "  '__NAMESPACE__': ns,",
    '};',
  ].join('\n'));
  const { urlPlaceholders, paramPlaceholders } = loadInstallerPlaceholders(f);
  assert.equal(urlPlaceholders.__HTTP_REQ_URL__, 'arcrun-http-request');
  assert.equal(urlPlaceholders.__CYPHER_BASE__, 'arcrun-cypher-executor', '解一層變數指派');
  assert.ok(paramPlaceholders.has('__NAMESPACE__'));
});

test('安裝器換寫法、對應表整個讀不到 ⇒ 丟例外（不准猜）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  const f = join(dir, 'worker.js');
  writeFileSync(f, 'export default {};\n');
  assert.throws(() => loadInstallerPlaceholders(f), /讀不到/);
});
