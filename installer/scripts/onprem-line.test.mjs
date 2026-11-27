import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertOnpremDeclared, nextOnpremVersion, packageUrl, latestUrl, planOnprem, publishOnprem, verifyLiveOnprem, readLiveOnprem, appendOnpremLedger,
} from './onprem-line.mjs';

const ON = { bucket: 'b', accountId: 'a', publicBase: 'https://inst.test/onprem/', signUrl: 'https://sign.test' };
const sha = (b) => createHash('sha256').update(b).digest('hex');
function mk(version = '1.4.299-onprem.1', body = 'TGZ-BYTES') {
  const d = mkdtempSync(join(tmpdir(), 'onprem-t-'));
  const pkg = join(d, 'p.tgz'); writeFileSync(pkg, body);
  const latest = join(d, 'latest.json');
  writeFileSync(latest, JSON.stringify({ version, url: packageUrl(ON, version), sha256: sha(body), size: body.length, notes: [] }));
  return { pkg, latest, version, body };
}

test('登錄簿欄位：缺欄位、git.uncle6.me、非 https 都丟', () => {
  assertOnpremDeclared(ON);
  assert.throws(() => assertOnpremDeclared({ ...ON, bucket: '' }), /缺欄位：bucket/);
  assert.throws(() => assertOnpremDeclared({ ...ON, publicBase: 'https://git.uncle6.me/x' }), /git\.uncle6\.me/);
  assert.throws(() => assertOnpremDeclared({ ...ON, publicBase: 'http://x.test/onprem' }), /https/);
  assert.throws(() => assertOnpremDeclared({ ...ON, signUrl: undefined }), /signUrl/);
});

test('版號：同一個主程式版號依帳本遞增，換主程式版號從 1 重來；格式不對丟', () => {
  assert.equal(nextOnpremVersion('1.4.299', { entries: [] }), '1.4.299-onprem.1');
  const l = { entries: [{ version: '1.4.299-onprem.1' }, { version: '1.4.299-onprem.3' }, { version: '1.4.298-onprem.9' }] };
  assert.equal(nextOnpremVersion('1.4.299', l), '1.4.299-onprem.4');
  assert.equal(nextOnpremVersion('1.4.300', l), '1.4.300-onprem.1');
  assert.throws(() => nextOnpremVersion('1.4', l), /格式/);
});

test('網址：publicBase 結尾斜線不會變成雙斜線', () => {
  assert.equal(packageUrl(ON, '1.4.299-onprem.1'), 'https://inst.test/onprem/1.4.299-onprem.1.tgz');
  assert.equal(latestUrl(ON), 'https://inst.test/onprem/latest.json');
});

test('planOnprem：指標版號／sha256 與實檔不符就丟；放的順序是更新檔先、指標最後', () => {
  const m = mk();
  const plan = planOnprem({ pkgPath: m.pkg, latestPath: m.latest, version: m.version });
  const puts = [];
  publishOnprem({ plan, onprem: ON, run: (args) => puts.push(args[4]) });
  assert.deepEqual(puts, ['b/onprem/1.4.299-onprem.1.tgz', 'b/onprem/latest.json']);
  const bad = mk('1.4.299-onprem.2');
  writeFileSync(bad.pkg, 'TAMPERED');
  assert.throws(() => planOnprem({ pkgPath: bad.pkg, latestPath: bad.latest, version: bad.version }), /sha256/);
  assert.throws(() => planOnprem({ pkgPath: m.pkg, latestPath: m.latest, version: '1.4.299-onprem.9' }), /版號/);
  assert.throws(() => planOnprem({ pkgPath: m.pkg, latestPath: m.latest, version: '1.4.299' }), /格式/);
});

const serve = (objs) => async (u) => {
  const k = String(u).replace('https://inst.test/onprem/', '');
  return k in objs ? new Response(objs[k]) : new Response('no', { status: 404 });
};

test('verifyLiveOnprem：版號、url 可抓、位元組 sha256 三者都對才過', async () => {
  const m = mk();
  const live = { version: m.version, url: packageUrl(ON, m.version), sha256: sha(m.body) };
  const ok = await verifyLiveOnprem({ onprem: ON, expect: { version: m.version, sha256: sha(m.body) }, fetchImpl: serve({ 'latest.json': JSON.stringify(live), [`${m.version}.tgz`]: m.body }), tries: 1 });
  assert.equal(ok.version, m.version);
  await assert.rejects(verifyLiveOnprem({ onprem: ON, expect: { version: m.version, sha256: sha(m.body) }, fetchImpl: serve({ 'latest.json': JSON.stringify({ ...live, version: '1.4.299-onprem.0' }) }), tries: 1 }), /指標版號/);
  await assert.rejects(verifyLiveOnprem({ onprem: ON, expect: { version: m.version, sha256: sha(m.body) }, fetchImpl: serve({ 'latest.json': JSON.stringify(live) }), tries: 1 }), /抓不到/);
  await assert.rejects(verifyLiveOnprem({ onprem: ON, expect: { version: m.version, sha256: sha(m.body) }, fetchImpl: serve({ 'latest.json': JSON.stringify(live), [`${m.version}.tgz`]: 'EVIL' }), tries: 1 }), /sha256/);
  await assert.rejects(verifyLiveOnprem({ onprem: ON, expect: { version: m.version, sha256: sha(m.body) }, fetchImpl: serve({}), tries: 1 }), /404/);
});

test('readLiveOnprem：還沒上架（404）回 null；帳本冪等', async () => {
  assert.equal(await readLiveOnprem({ onprem: ON, fetchImpl: serve({}) }), null);
  const l = appendOnpremLedger({ entries: [] }, { version: 'v', target: 'stage' });
  assert.equal(appendOnpremLedger(l, { version: 'v', target: 'stage' }).entries.length, 1);
  assert.equal(appendOnpremLedger(l, { version: 'v', target: 'prod' }).entries.length, 2);
});
