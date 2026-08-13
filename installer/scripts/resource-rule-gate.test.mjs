/**
 * resource-rule-gate.test.mjs — **閘自己要能被演練**。
 *
 * 跑法：node --test installer/scripts/resource-rule-gate.test.mjs
 *
 * 一道沒被演練過的閘等於沒有閘（2026-08-09 verify-download 誤報那次的教訓，
 * 也是 `installer/oauth-prototype/copy-contract.test.mjs` 的下場——那份文案閘寫著
 * 「deploy-web.sh 在部署前跑本檔」，而 `deploy-web.sh` 早就不存在了，
 * 全 repo grep 只剩它自己一行 ⇒ **它從來沒擋過任何東西**）。
 *
 * 所以這裡三種輸入都真的餵一遍：
 *   ① 乾淨的樹（就是本 repo）→ 要全過
 *   ② 有人又抄了一份（用**當初真的被刪掉那段程式碼**當 offender fixture）→ 要擋
 *   ③ 鏡射被改過一個位元組／沒接上／掃到 0 個檔 → 都要擋
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REPO_ROOT, SCAN_DIR, MIRROR_REL, WORKER_REL,
  createsCloudflareResource, splitFunctionBodies, findHttpCalls,
  filesToScan, checkSingleImplementation, checkWiredUp, runGate,
} from './resource-rule-gate.mjs';
import { checkAgainstManifest } from './resource-rule-sync.mjs';

/**
 * 🔴 offender fixture ＝ `installer/oauth-prototype/worker.js` 在 2026-08-12 之前
 *    真的長這樣的那段程式碼（`Leo/Arcrun#97` 的病根本體，一字不改）。
 *    這道閘存在的唯一理由就是「下次有人再貼一次這種東西要被擋下來」，
 *    所以拿它本人當測資，而不是另外編一個像 offender 的假東西。
 */
const THE_DELETED_IMPLEMENTATION = `
/** 建 KV namespace（冪等）：先找既有同名取用，沒有才建。回 { id, reused }。 */
async function ensureKvNamespace(token, accountId, title) {
  for (let page = 1; page <= 20; page++) {
    const list = await cfFetch(
      token,
      \`/accounts/\${accountId}/storage/kv/namespaces?per_page=100&page=\${page}\`
    );
    if (!Array.isArray(list) || list.length === 0) break;
    const hit = list.find((n) => n.title === title);
    if (hit) return { id: hit.id, reused: true };
    if (list.length < 100) break;
  }
  const kv = await cfFetch(token, \`/accounts/\${accountId}/storage/kv/namespaces\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return { id: kv.id, reused: false };
}
`;

/** 端點藏在變數裡、POST 在另一行——deploy-all.mjs 當初就是這型（呼叫層看不到，函式層才看得到）。 */
const OFFENDER_VIA_VARIABLE = `
export async function ensureIndex(ctx) {
  const base = \`https://api.cloudflare.com/client/v4/accounts/\${ctx.id}/vectorize/v2/indexes\`;
  const res = await fetch(base, { method: 'POST', body: JSON.stringify({ name: 'x' }) });
  return res.ok;
}
`;

/** 只**回應**那些路徑的假 server（測試替身）——它沒有送出任何請求，不該被判 offender。 */
const INNOCENT_FAKE_SERVER = `
function fakeAccount(url, method) {
  if (url.includes('/storage/kv/namespaces') && method === 'POST') return { id: 'kv-1' };
  if (url.includes('/d1/database') && method === 'POST') return { uuid: 'db-1' };
  return null;
}
`;

/** 子資源（metadata-index）不是「建資源」——不該被判 offender。 */
const INNOCENT_SUBRESOURCE = `
async function addMetadataIndex(token, accountId, indexName) {
  await cfFetch(token, \`/accounts/\${accountId}/vectorize/v2/indexes/\${indexName}/metadata-index/create\`, {
    method: 'POST',
    body: JSON.stringify({ propertyName: 'library', indexType: 'string' }),
  });
}
`;

/** 讀清單不是建資源。 */
const INNOCENT_LIST = `
async function listAll(token, accountId) {
  return await cfFetch(token, \`/accounts/\${accountId}/storage/kv/namespaces?per_page=100\`);
}
`;

function scanSource(src) {
  const hits = [];
  for (const call of findHttpCalls(src)) {
    const k = createsCloudflareResource(call.text, false);
    if (k) hits.push(k);
  }
  for (const blk of splitFunctionBodies(src)) {
    const k = createsCloudflareResource(blk.body);
    if (k) hits.push(k);
  }
  return hits;
}

// ── ① 判準本身：會不會抓、會不會誤殺 ────────────────────────────────────────

test('閘會抓：當初被刪掉的那段 ensureKvNamespace（#97 病根本體）', () => {
  assert.deepEqual([...new Set(scanSource(THE_DELETED_IMPLEMENTATION))], ['KV namespace']);
});

test('閘會抓：端點藏在變數、POST 在另一行（deploy-all.mjs 那型）', () => {
  assert.deepEqual([...new Set(scanSource(OFFENDER_VIA_VARIABLE))], ['Vectorize index']);
});

test('閘不誤殺：只回應那些路徑的假 server（沒有送出任何請求）', () => {
  assert.deepEqual(scanSource(INNOCENT_FAKE_SERVER), []);
});

test('閘不誤殺：子資源 metadata-index/create（那不是在建 index）', () => {
  assert.deepEqual(scanSource(INNOCENT_SUBRESOURCE), []);
});

test('閘不誤殺：讀清單（GET）', () => {
  assert.deepEqual(scanSource(INNOCENT_LIST), []);
});

test('判準看行為不看名字：函式改叫 harmlessHelper 照樣被抓；只是叫 ensureXxx 但沒在建資源不會被抓', () => {
  const renamed = THE_DELETED_IMPLEMENTATION.replace(/ensureKvNamespace/g, 'harmlessHelper');
  assert.ok(scanSource(renamed).length > 0, '改名字騙不過去——判準是「有沒有對資源集合端點發 POST」');
  const nameOnly = 'async function ensureKvNamespace(x) { return x; }';
  assert.deepEqual(scanSource(nameOnly), [], '名字像 offender 但沒在做那件事，不該被擋');
});

// ── ② 整棵樹：乾淨的要過、被抄一份的要擋 ──────────────────────────────────

test('乾淨的樹（本 repo）：三項檢查全過，且真的掃到檔案（防「檢查 0 個卻通過」）', () => {
  const single = checkSingleImplementation();
  assert.ok(single.scanned.length > 0, `一個檔案都沒掃到就不算檢查過（${SCAN_DIR}）`);
  assert.equal(single.ok, true, single.problems.join('\n'));
  assert.equal(checkWiredUp().ok, true, checkWiredUp().problems.join('\n'));
  assert.equal(checkAgainstManifest(join(REPO_ROOT, MIRROR_REL)).ok, true);
});

test('掃描範圍指到空目錄 → runGate 判不過（不准用「掃了 0 個檔」換全綠）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'rrgate-empty-'));
  try {
    mkdirSync(join(empty, 'installer'), { recursive: true });
    const r = checkSingleImplementation(empty, 'installer', MIRROR_REL);
    assert.equal(r.scanned.length, 0);
    // checkSingleImplementation 自己會說「沒問題」——**把 0 個檔判成失敗是 runGate 的責任**，
    // 這條測試釘住那個責任歸屬（上游 single-implementation.test.ts 的 assert.ok(files.length > 0) 同款）。
    assert.equal(r.ok, true);
    const { sections } = runGate(empty);
    const s = sections.find((x) => x.name.includes('只有一份實作'));
    assert.equal(s.ok, false, 'runGate 必須把「掃到 0 個檔」判成不過');
    assert.match(s.problems.join('\n'), /一個檔案都沒掃到/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/** 複製一份最小的樹（鏡射＋worker.js＋一個腳本），用來演練「被改壞」的情況。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'rrgate-'));
  mkdirSync(join(root, 'installer', 'oauth-prototype'), { recursive: true });
  cpSync(join(REPO_ROOT, MIRROR_REL), join(root, MIRROR_REL), { recursive: true });
  cpSync(join(REPO_ROOT, WORKER_REL), join(root, WORKER_REL));
  return root;
}

test('有人又抄了一份 → 擋（把刪掉的那段貼回任何一個檔都會被抓到）', () => {
  const root = makeTree();
  try {
    assert.equal(checkSingleImplementation(root).ok, true, '先確認這棵樹本來是乾淨的');
    writeFileSync(join(root, 'installer', 'oauth-prototype', 'helpers.mjs'), THE_DELETED_IMPLEMENTATION);
    const r = checkSingleImplementation(root);
    assert.equal(r.ok, false);
    assert.equal(r.offenders.length, 1);
    assert.match(r.offenders[0].file, /helpers\.mjs$/);
    assert.equal(r.offenders[0].kind, 'KV namespace');
    assert.match(r.problems.join('\n'), /Arcrun#97/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('鏡射被改一個位元組 → 擋（規則要改就改上游，不准在這裡手改）', () => {
  const root = makeTree();
  try {
    assert.equal(checkAgainstManifest(join(root, MIRROR_REL)).ok, true);
    const rule = join(root, MIRROR_REL, 'rule.mjs');
    writeFileSync(rule, readFileSync(rule, 'utf8') + '\n// 我順手改一下\n');
    const r = checkAgainstManifest(join(root, MIRROR_REL));
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /鏡射被改過：rule\.mjs/);
    assert.match(r.problems.join('\n'), /不准手改/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('鏡射被多塞一個檔 → 擋（自己往共用層加東西＝第二份實作的入口）', () => {
  const root = makeTree();
  try {
    writeFileSync(join(root, MIRROR_REL, 'my-extra-rule.mjs'), 'export const x = 1;\n');
    const r = checkAgainstManifest(join(root, MIRROR_REL));
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /鏡射多了檔案：my-extra-rule\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('鏡射還在、但沒人 import 它 → 擋（放著沒用的閘等於沒有閘）', () => {
  const root = makeTree();
  try {
    assert.equal(checkWiredUp(root).ok, true);
    const worker = join(root, WORKER_REL);
    const src = readFileSync(worker, 'utf8')
      .replace(/import \{[^}]*\} from '\.\/shared\/resource-rule\/[^']*';/g, '');
    writeFileSync(worker, src);
    const r = checkWiredUp(root);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /沒有 import 共用規則/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker.js 有 import 但根本沒呼叫規則 → 擋', () => {
  const root = makeTree();
  try {
    const worker = join(root, WORKER_REL);
    const src = readFileSync(worker, 'utf8')
      .replace(/\bplanResources\s*\(/g, 'notTheRule(')
      .replace(/\bapplyResourcePlan\s*\(/g, 'notTheRule(');
    writeFileSync(worker, src);
    const r = checkWiredUp(root);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /沒有呼叫共用規則/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('掃描清單真的涵蓋安裝器本體與出貨腳本（範圍縮水＝閘悄悄失效）', () => {
  const files = filesToScan();
  assert.ok(files.includes(WORKER_REL), '安裝器本體要在掃描範圍內');
  assert.ok(files.some((f) => f.startsWith(join('installer', 'scripts'))), '出貨腳本也要在範圍內');
  assert.ok(files.every((f) => !f.startsWith(MIRROR_REL)), '鏡射本身不該被當成 offender');
});
