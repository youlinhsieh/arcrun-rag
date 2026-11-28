// inkstone/arcrun-rag#398：Portal 畫面包出貨線的純函式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packVersionOf, samePortal, planPortalPack, publishPortalPack, verifyLivePortal, readLivePortal } from './portal-pack-line.mjs';

const FP = 'ab12cd34'.repeat(8);
const mk = (files) => { const p = join(mkdtempSync(join(tmpdir(), 'pp398-')), 'pack.json'); const t = JSON.stringify({ schema: 1, files }); writeFileSync(p, t); return { p, t }; };
const GOOD = { '/portal/index.html': { type: 'text/html', b64: false, data: '<html/>' } };
const MARKET = { bucket: 'b', accountId: 'a', publicBase: 'https://x/dist', installerBase: 'https://x' };

test('包版號＝UTC 日期＋指紋前 7 碼；同內容隔天仍算同一份', () => {
  assert.equal(packVersionOf(FP, new Date('2026-11-28T10:00:00Z')), '2026.11.28-ab12cd3');
  assert.equal(samePortal({ ui_fingerprint: FP }, FP), true);
  assert.equal(samePortal({ ui_fingerprint: 'x' }, FP), false);
  assert.equal(samePortal(null, FP), false);
  assert.throws(() => packVersionOf('zz'), /指紋/);
});

test('plan：指標帶雜湊與 floor；缺 /portal/index.html 或 floor 不合法就拒絕', () => {
  const { p, t } = mk(GOOD);
  const plan = planPortalPack({ packPath: p, uiFingerprint: FP, version: '2026.11.28-ab12cd3', floor: '1.4.338', ticket: 'inkstone/arcrun-rag#398', previous: null });
  assert.equal(plan.pointer.sha256, createHash('sha256').update(t).digest('hex'));
  assert.equal(plan.pointer.floor_bundle_version, '1.4.338');
  assert.equal(plan.object.key, 'market/portal/packs/2026.11.28-ab12cd3.json');
  assert.throws(() => planPortalPack({ packPath: mk({ '/x.js': {} }).p, uiFingerprint: FP, version: '2026.11.28-ab12cd3', floor: '1.4.338' }), /index\.html/);
  assert.throws(() => planPortalPack({ packPath: p, uiFingerprint: FP, version: '2026.11.28-ab12cd3', floor: 'latest' }), /floor/);
  assert.throws(() => planPortalPack({ packPath: p, uiFingerprint: FP, version: 'v1', floor: '1.4.338' }), /版號/);
});

test('publish：包先、指標最後', () => {
  const { p } = mk(GOOD);
  const plan = planPortalPack({ packPath: p, uiFingerprint: FP, version: '2026.11.28-ab12cd3', floor: '1.4.338' });
  const seen = [];
  publishPortalPack({ plan, market: MARKET, run: (args) => seen.push(args[4]), writePointer: () => '/tmp/x' });
  assert.deepEqual(seen, ['b/market/portal/packs/2026.11.28-ab12cd3.json', 'b/market/portal/current.json']);
});

test('讀線上指標：404＝還沒有；verify：雜湊對才過，不對就丟', async () => {
  assert.equal(await readLivePortal({ installerBase: 'https://x', fetchImpl: async () => new Response('', { status: 404 }) }), null);
  const { p, t } = mk(GOOD);
  const plan = planPortalPack({ packPath: p, uiFingerprint: FP, version: '2026.11.28-ab12cd3', floor: '1.4.338' });
  const ok = async (u) => String(u).endsWith('current.json') ? new Response(JSON.stringify(plan.pointer)) : new Response(t);
  assert.deepEqual(await verifyLivePortal({ installerBase: 'https://x', expect: plan.pointer, fetchImpl: ok, tries: 1 }), { version: '2026.11.28-ab12cd3' });
  const bad = async (u) => String(u).endsWith('current.json') ? new Response(JSON.stringify(plan.pointer)) : new Response(t + ' ');
  await assert.rejects(verifyLivePortal({ installerBase: 'https://x', expect: plan.pointer, fetchImpl: bad, tries: 1 }), /對不上/);
});
