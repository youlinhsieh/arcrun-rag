import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitFromManifestSource, sameCommit, readInstanceHealth, compareHealth,
  ensureInstanceOnRelease, extractSubdomain, checkSubdomain, findAcr, acrEnv, defaultRunAcr,
} from './instance-update.mjs';

const EXPECT = { version: '1.4.147', commit: '4759c3e91185' };
const ok = (version, commit, extra = {}) => ({ ok: true, version, commit, status: 'ok', dataLayerOk: true, ...extra });
const CYPHER = 'https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev';
const noSleep = async () => {};

test('manifest.source 解出 commit 前綴', () => {
  assert.equal(commitFromManifestSource('Arcrun@4759c3e91185'), '4759c3e91185');
  assert.equal(commitFromManifestSource('unknown'), '');
});

test('sameCommit：長短前綴互認，太短或不同不認', () => {
  assert.ok(sameCommit('4759c3e91185', '4759c3e91185aaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(!sameCommit('4759c3e', 'ce73ff9739db'));
  assert.ok(!sameCommit('', '4759c3e'));
  assert.ok(!sameCommit('abc', 'abc'));
});

test('readInstanceHealth：degraded 的 503 也讀得到版號；連不上回 error 不丟例外', async () => {
  const f = async () => ({ status: 503, json: async () => ({ status: 'degraded', bundle_version: '1.4.146', bundle_commit: 'abc1234', data_layer: { reason: 'kbdb_health_unreadable' } }) });
  const h = await readInstanceHealth('https://x.example/', f);
  assert.equal(h.ok, true);
  assert.equal(h.version, '1.4.146');
  assert.match(h.detail, /kbdb_health_unreadable/);
  const bad = await readInstanceHealth('https://x.example', async () => { throw new Error('boom'); });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
});

test('compareHealth：版號對不上、commit 對不上、讀不到、期望值不明都不算通過', () => {
  assert.ok(compareHealth(ok('1.4.147', '4759c3e91185'), EXPECT).match);
  assert.ok(!compareHealth(ok('1.4.146', '4759c3e91185'), EXPECT).match);
  assert.ok(!compareHealth(ok('1.4.147', 'ce73ff9739db'), EXPECT).match);
  assert.ok(!compareHealth({ ok: false, error: 'x' }, EXPECT).match);
  assert.ok(!compareHealth(ok('1.4.147', '4759c3e91185'), { version: '1.4.147', commit: '' }).match, '不知道要比什麼 ⇒ 不當作通過');
  assert.ok(!compareHealth(ok('1.4.147', '4759c3e91185'), { version: '', commit: '4759c3e91185' }).match);
});

test('已經是這一版：不跑 acr update（冪等）', async () => {
  let ran = 0;
  const r = await ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, readHealth: async () => ok('1.4.147', '4759c3e91185'), runUpdate: async () => { ran++; return { code: 0, output: '' }; }, sleep: noSleep });
  assert.equal(ran, 0);
  assert.equal(r.updated, false);
});

test('🔴 實例沒換版：acr update 說成功，但 /health 一直是舊的 ⇒ 丟例外（出貨線紅燈）', async () => {
  let reads = 0;
  await assert.rejects(
    ensureInstanceOnRelease({
      expect: EXPECT, cypherUrl: CYPHER, tries: 3,
      readHealth: async () => { reads++; return ok('1.4.145', 'ce73ff9739db'); },
      runUpdate: async () => ({ code: 0, output: '✓ 部署完成' }), sleep: noSleep,
    }),
    (e) => /讀回仍不合格/.test(e.message) && /1\.4\.145/.test(e.message) && /1\.4\.147/.test(e.message));
  assert.equal(reads, 1 + 3, '更新前 1 次＋更新後有界重試 3 次，不無限等');
});

test('🔴 acr update 失敗（exit≠0）⇒ 丟例外，帶輸出尾巴', async () => {
  await assert.rejects(
    ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, readHealth: async () => ok('1.4.145', 'ce73ff9739db'), runUpdate: async () => ({ code: 1, output: 'a\nb\n部署部分失敗' }), sleep: noSleep }),
    /acr update 失敗（exit 1）[\s\S]*部署部分失敗/);
});

test('更新後第 N 次讀到新版且資料層 ok ⇒ 通過，並帶更新前後兩行讀回', async () => {
  const seq = [ok('1.4.145', 'ce73ff9739db'), ok('1.4.145', 'ce73ff9739db'), ok('1.4.147', '4759c3e91185')];
  let i = 0;
  const r = await ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, readHealth: async () => seq[Math.min(i++, seq.length - 1)], runUpdate: async () => ({ code: 0, output: '' }), sleep: noSleep });
  assert.equal(r.updated, true);
  assert.match(r.detail.join('\n'), /第 2\/6 次/);
  assert.match(r.detail.join('\n'), /更新前：1\.4\.145/);
});

test('🔴 版號與 commit 都對、但 data_layer 不是 ok（degraded）⇒ 紅燈，這版算出貨失敗', async () => {
  const degraded = ok('1.4.147', '4759c3e91185', { status: 'degraded', dataLayerOk: false, detail: 'data_layer.reason=kbdb_health_unreadable' });
  assert.ok(!compareHealth(degraded, EXPECT).match);
  await assert.rejects(
    ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, tries: 2, readHealth: async () => (degraded), runUpdate: async () => ({ code: 0, output: '' }), sleep: noSleep }),
    (e) => /data_layer 不是 ok/.test(e.message) && /kbdb_health_unreadable/.test(e.message));
});

test('🔴 已經是這一版但 data_layer 壞：不能當「已經通過」跳過，要往下更新並再讀回', async () => {
  let ran = 0;
  await assert.rejects(
    ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, tries: 1, readHealth: async () => ok('1.4.147', '4759c3e91185', { status: 'degraded', dataLayerOk: false }), runUpdate: async () => { ran++; return { code: 0, output: '' }; }, sleep: noSleep }),
    /data_layer/);
  assert.equal(ran, 1);
});

test('readInstanceHealth：data_layer.ok===true 才算 dataLayerOk；缺欄位（舊實例）＝未知＝不算', async () => {
  const mk = (body) => async () => ({ status: 200, json: async () => body });
  assert.equal((await readInstanceHealth('https://x', mk({ bundle_version: '1', data_layer: { ok: true } }))).dataLayerOk, true);
  assert.equal((await readInstanceHealth('https://x', mk({ bundle_version: '1', data_layer: { ok: false, reason: 'r' } }))).dataLayerOk, false);
  assert.equal((await readInstanceHealth('https://x', mk({ bundle_version: '1' }))).dataLayerOk, false);
});

test('extractSubdomain／checkSubdomain：與 acr 同一條規則；空網址、非 cypher 網址都抽不出', () => {
  assert.equal(extractSubdomain(CYPHER), 'arcrun-yuga3bse');
  assert.equal(extractSubdomain(''), '');
  assert.equal(extractSubdomain(undefined), '');
  assert.equal(extractSubdomain('https://example.com'), '');
  assert.equal(extractSubdomain('https://arcrun-cypher-executor..workers.dev'), '');
  assert.equal(checkSubdomain(CYPHER).ok, true);
  assert.equal(checkSubdomain('').ok, false);
});

test('🔴 子網域是空的：實例要更新時不准跑 acr update（runUpdate 一次都不能被呼叫），直接紅燈', async () => {
  for (const bad of [undefined, '', 'https://arcrun-cypher-executor..workers.dev', 'https://example.com']) {
    let ran = 0;
    await assert.rejects(
      ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: bad, readHealth: async () => ok('1.4.145', 'ce73ff9739db'), runUpdate: async () => { ran++; return { code: 0, output: '' }; }, sleep: noSleep }),
      (e) => /不跑 acr update/.test(e.message) && /子網域/.test(e.message));
    assert.equal(ran, 0, `cypherUrl=${bad} 時不該呼叫 acr`);
  }
});

test('子網域檢查看的是真的會傳給 acr 的環境變數：acrEnv 組出空網址 ⇒ 擋', () => {
  const env = acrEnv({ cfEnv: {}, namespace: 'ns', cypherUrl: undefined, releaseApi: 'https://i', base: {} });
  assert.equal(checkSubdomain(env.ARCRUN_CYPHER_EXECUTOR_URL).ok, false);
});

test('輸出進錯誤訊息前會經 redact', async () => {
  await assert.rejects(
    ensureInstanceOnRelease({ expect: EXPECT, cypherUrl: CYPHER, readHealth: async () => ok('1.4.145', 'ce73ff9739db'), runUpdate: async () => ({ code: 2, output: 'token=SECRETVALUE' }), sleep: noSleep, redact: (s) => s.replace('SECRETVALUE', '***') }),
    (e) => /token=\*\*\*/.test(e.message) && !/SECRETVALUE/.test(e.message));
});

test('findAcr：有 dist 用 dist；沒有但有 node_modules 回 buildable；都沒有回 error', () => {
  const have = new Set(['/a/cli/dist/index.js']);
  assert.equal(findAcr(['/b/cli', '/a/cli'], (p) => have.has(p)).entry, '/a/cli/dist/index.js');
  const bd = findAcr(['/c/cli'], (p) => ['/c/cli/package.json', '/c/cli/node_modules'].includes(p));
  assert.equal(bd.buildable, '/c/cli');
  assert.ok(findAcr(['/d/cli'], () => false).error);
});

test('acrEnv：self-hosted＋名字齊全；沒有 mcpUrl 就不設', () => {
  const e = acrEnv({ cfEnv: { CLOUDFLARE_ACCOUNT_ID: 'A', CLOUDFLARE_API_TOKEN: 'T' }, namespace: 'ns', cypherUrl: 'https://c', releaseApi: 'https://i/api/latest', base: {} });
  assert.equal(e.ARCRUN_MODE, 'self-hosted');
  assert.equal(e.ARCRUN_NAMESPACE, 'ns');
  assert.equal(e.ARCRUN_RELEASE_API, 'https://i/api/latest');
  assert.ok(!('ARCRUN_MCP_URL' in e));
});

test('defaultRunAcr：用注入的 spawn，回 code／output', () => {
  const r = defaultRunAcr({ entry: '/x/index.js', env: {}, spawn: (cmd, args) => ({ status: 3, stdout: 'o', stderr: 'e', signal: null, _args: args }) });
  assert.deepEqual([r.code, r.output], [3, 'oe']);
});

test('原始碼檢查：ship.mjs 有 instance-update 站，擺在 stage-record 之前，且站內不印金鑰值', () => {
  const src = readFileSync(join(import.meta.dirname, 'ship.mjs'), 'utf8');
  const iu = src.indexOf("id: 'instance-update'");
  const sr = src.indexOf("id: 'stage-record'");
  assert.ok(iu > 0 && sr > iu, 'instance-update 要在 stage-record 前面');
  const body = src.slice(iu, sr);
  assert.ok(!/console\.log\([^)]*cred\.env/.test(body));
  assert.ok(/T\.instanceUpdate/.test(body), '只認登錄簿宣告：prod 沒宣告就跳過');
});

test('原始碼檢查：ship.mjs 把 acr 真正會收到的 ARCRUN_CYPHER_EXECUTOR_URL 傳進 ensureInstanceOnRelease', () => {
  const src = readFileSync(join(import.meta.dirname, 'ship.mjs'), 'utf8');
  assert.ok(/cypherUrl:\s*env\.ARCRUN_CYPHER_EXECUTOR_URL/.test(src));
});
