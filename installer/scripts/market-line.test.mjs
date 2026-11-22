import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  marketVersionOf, diffMarket, hasChanges, renderDiff, planMarket, publishMarket, assertMarketDeclared,
  readLiveMarket, verifyLiveMarket, appendMarketLedger, MARKET_VERSION_RE,
} from './market-line.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const MARKET = { bucket: 'arcrun-stage-dist', accountId: 'acc', publicBase: 'https://stage.example/dist', installerBase: 'https://stage.example' };

function feed(apps) {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-'));
  mkdirSync(join(dir, 'packages'));
  const rows = apps.map(([id, version, engine_min]) => {
    const body = JSON.stringify({ id, version });
    writeFileSync(join(dir, 'packages', `${id}-${version}.json`), body);
    return { id, version, engine_min, package: { url: `packages/${id}-${version}.json`, sha256: sha(body) } };
  });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 1, apps: rows }));
  return { dir, rows };
}

test('市集版號：日期＋目錄指紋前 7 碼，同內容同後綴', () => {
  const v1 = marketVersionOf('{"a":1}', new Date('2026-11-22T10:00:00Z'));
  const v2 = marketVersionOf('{"a":1}', new Date('2026-11-23T10:00:00Z'));
  const v3 = marketVersionOf('{"a":2}', new Date('2026-11-22T10:00:00Z'));
  assert.match(v1, MARKET_VERSION_RE);
  assert.equal(v1.slice(11), v2.slice(11));
  assert.notEqual(v1.slice(11), v3.slice(11));
  assert.ok(v1.startsWith('2026.11.22-'));
});

test('diffMarket：新上架／升版／下架／不變，列得出「從幾版到幾版」', () => {
  const oldI = { apps: [{ id: 'ahub', version: '1.0.0' }, { id: 'notes', version: '1.4.0' }, { id: 'old', version: '0.1.0' }] };
  const newI = { apps: [{ id: 'ahub', version: '1.0.1', engine_min: '1.4.270' }, { id: 'notes', version: '1.4.0' }, { id: 'fresh', version: '0.1.0' }] };
  const d = diffMarket(oldI, newI);
  const by = Object.fromEntries(d.map((x) => [x.id, x]));
  assert.deepEqual([by.ahub.kind, by.ahub.from, by.ahub.to], ['updated', '1.0.0', '1.0.1']);
  assert.equal(by.notes.kind, 'unchanged');
  assert.equal(by.old.kind, 'removed');
  assert.equal(by.fresh.kind, 'added');
  assert.ok(hasChanges(d));
  assert.ok(!hasChanges(diffMarket(newI, newI)));
  const t = renderDiff(d, '2026.11.22-abcdef0');
  assert.match(t, /ahub：1\.0\.0 → 1\.0\.1（需要平台 ≥ 1\.4\.270）/);
  assert.match(t, /fresh：新上架 0\.1\.0/);
  assert.match(t, /old：下架（原 0\.1\.0）/);
  assert.match(t, /不變：notes@1\.4\.0/);
});

test('第一次上架（線上沒有指標）：全部算新上架', () => {
  const d = diffMarket(null, { apps: [{ id: 'notes', version: '1.4.0' }] });
  assert.deepEqual(d.map((x) => x.kind), ['added']);
});

test('planMarket：順序＝包 → 這一版目錄；指標不在清單裡（最後由 publishMarket 翻）', () => {
  const { dir } = feed([['ahub', '1.0.1'], ['notes', '1.4.0']]);
  const idx = readFileSync(join(dir, 'index.json'), 'utf8');
  const v = marketVersionOf(idx, new Date('2026-11-22T00:00:00Z'));
  const plan = planMarket({ feedDir: dir, marketVersion: v, diff: [{ id: 'ahub', from: '1.0.0', to: '1.0.1', kind: 'updated' }], ticket: 'inkstone/InkStoneCo#9', previous: 'x' });
  const keys = plan.objects.map((o) => o.key);
  assert.deepEqual(keys, ['market/packages/ahub-1.0.1.json', 'market/packages/notes-1.4.0.json', `market/index/${v}.json`]);
  assert.ok(!keys.includes('market/current.json'));
  assert.equal(plan.pointer.version, v);
  assert.equal(plan.pointer.index_sha256, sha(idx));
  assert.deepEqual(plan.pointer.changes, [{ id: 'ahub', from: '1.0.0', to: '1.0.1', kind: 'updated' }]);
  assert.equal(plan.objects.at(-1).cacheControl, 'public, max-age=31536000, immutable');
  rmSync(dir, { recursive: true });
});

test('planMarket：包雜湊不符丟錯；版號格式不合丟錯', () => {
  const { dir } = feed([['ahub', '1.0.1']]);
  writeFileSync(join(dir, 'packages', 'ahub-1.0.1.json'), 'tampered');
  assert.throws(() => planMarket({ feedDir: dir, marketVersion: '2026.11.22-abcdef0', diff: [] }), /sha256/);
  assert.throws(() => planMarket({ feedDir: dir, marketVersion: 'v1', diff: [] }), /版號格式/);
  rmSync(dir, { recursive: true });
});

test('publishMarket：先包、再目錄、指標最後；只動 market/ 前綴，不碰 bundle／daemon／manifest', () => {
  const { dir } = feed([['ahub', '1.0.1']]);
  const idx = readFileSync(join(dir, 'index.json'), 'utf8');
  const v = marketVersionOf(idx);
  const plan = planMarket({ feedDir: dir, marketVersion: v, diff: [] });
  const puts = [];
  const r = publishMarket({
    plan, market: MARKET,
    run: (args) => puts.push(args[4]),
    writePointer: (j) => { const p = join(dir, 'cur.json'); writeFileSync(p, JSON.stringify(j)); return p; },
  });
  assert.equal(puts.at(-1), 'arcrun-stage-dist/market/current.json');
  assert.ok(puts.every((k) => k.startsWith('arcrun-stage-dist/market/')));
  assert.ok(!puts.some((k) => /manifest\.json|daemon\/|bundle\//.test(k)));
  assert.equal(r.pointerKey, 'market/current.json');
  rmSync(dir, { recursive: true });
});

test('assertMarketDeclared：缺欄位丟錯', () => {
  assert.throws(() => assertMarketDeclared({ bucket: 'b' }), /缺欄位/);
  assert.throws(() => assertMarketDeclared(null), /缺欄位/);
  assertMarketDeclared(MARKET);
});

test('readLiveMarket：沒指標回 null；有指標回指標＋目錄', async () => {
  const f404 = async () => new Response('x', { status: 404 });
  assert.equal(await readLiveMarket({ installerBase: 'https://s', fetchImpl: f404 }), null);
  // 沒指標但舊路有目錄：拿它當比較基準
  const fLegacy = async (u) => String(u).endsWith('current.json') ? new Response('x', { status: 404 }) : new Response('{"apps":[{"id":"a","version":"1.0.0"}]}');
  const lg = await readLiveMarket({ installerBase: 'https://s', fetchImpl: fLegacy });
  assert.equal(lg.pointer, null);
  assert.equal(lg.index.apps[0].id, 'a');
  const f = async (u) => String(u).endsWith('current.json')
    ? new Response('{"version":"v"}') : new Response('{"apps":[]}');
  const l = await readLiveMarket({ installerBase: 'https://s/', fetchImpl: f });
  assert.equal(l.pointer.version, 'v');
  assert.deepEqual(l.index, { apps: [] });
});

test('verifyLiveMarket：版號與指紋對上才過；對不上丟錯', async () => {
  const idx = '{"schema":1,"apps":[]}';
  const ok = async (u) => String(u).endsWith('current.json') ? new Response('{"version":"2026.11.22-abcdef0"}') : new Response(idx);
  await verifyLiveMarket({ installerBase: 'https://s', expect: { version: '2026.11.22-abcdef0', index_sha256: sha(idx) }, fetchImpl: ok, tries: 1 });
  await assert.rejects(verifyLiveMarket({ installerBase: 'https://s', expect: { version: '2026.11.22-1111111', index_sha256: sha(idx) }, fetchImpl: ok, tries: 1, waitMs: 0 }), /對不上/);
});

test('appendMarketLedger：冪等', () => {
  const e = { version: 'v', target: 'stage' };
  const l1 = appendMarketLedger({ entries: [] }, e);
  assert.equal(appendMarketLedger(l1, e).entries.length, 1);
  assert.equal(appendMarketLedger(l1, { version: 'v', target: 'prod' }).entries.length, 2);
});

test('diffMarket：版本變小標成 downgraded，並在清單上警示（來源不是最新 main 的典型症狀）', () => {
  const d = diffMarket({ apps: [{ id: 'ahub', version: '0.60.0' }] }, { apps: [{ id: 'ahub', version: '0.56.0' }] });
  assert.equal(d[0].kind, 'downgraded');
  assert.match(renderDiff(d, 'v'), /降版/);
  assert.equal(diffMarket({ apps: [{ id: 'a', version: '1.9.0' }] }, { apps: [{ id: 'a', version: '1.10.0' }] })[0].kind, 'updated');
});
