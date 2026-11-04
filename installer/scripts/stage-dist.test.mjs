import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  planDaemonObjects, ensureLocalExclude, publishDist, r2PutArgs, distUrl, assertDistDeclared, contentTypeOf,
  planBundleObjects, bundleDir, bundleDirUrl, isBundleObject,
} from './stage-dist.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const DIST = { bucket: 'arcrun-stage-dist', accountId: 'acc', publicBase: 'https://stage.example.workers.dev/dist' };

function fixture({ withMsix = false, badSha = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdist-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'daemon'));
  const files = { 'Arcrun-1.0.0.dmg': 'mac-bytes', 'Arcrun-win-1.0.0.exe': 'win-bytes' };
  if (withMsix) files['Arcrun-1.0.0.msix'] = 'msix-bytes';
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, 'daemon', n), c);
  const manifest = { release: '1.4.0', daemon: {
    version: '1.0.0',
    mac: { file: 'daemon/Arcrun-1.0.0.dmg', sha256: badSha ? 'f'.repeat(64) : sha('mac-bytes') },
    win: { file: 'daemon/Arcrun-win-1.0.0.exe', sha256: sha('win-bytes') },
    ...(withMsix ? { msix: { file: 'daemon/Arcrun-1.0.0.msix', sha256: sha('msix-bytes') } } : {}),
  } };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

test('planDaemonObjects：由 manifest.daemon 遍歷，mac／win 必在，msix 有才算', () => {
  const { dir, manifest } = fixture({ withMsix: true });
  const objs = planDaemonObjects(manifest, dir);
  assert.deepEqual(objs.map((o) => o.platform), ['mac', 'win', 'msix']);
  assert.equal(objs[0].key, 'daemon/Arcrun-1.0.0.dmg');
  assert.equal(objs[1].contentType, 'application/vnd.microsoft.portable-executable');
  rmSync(dir, { recursive: true });
});

test('planDaemonObjects：磁碟 sha 與 manifest 宣告不符 ⇒ 丟，不上傳半套', () => {
  const { dir, manifest } = fixture({ badSha: true });
  assert.throws(() => planDaemonObjects(manifest, dir), /sha256/);
  rmSync(dir, { recursive: true });
});

test('planDaemonObjects：manifest 指到的檔不在磁碟 ⇒ 丟', () => {
  const { dir, manifest } = fixture();
  rmSync(join(dir, 'daemon', 'Arcrun-win-1.0.0.exe'));
  assert.throws(() => planDaemonObjects(manifest, dir), /沒有這個檔/);
  rmSync(dir, { recursive: true });
});

test('planDaemonObjects：路徑跳出 daemon/ ⇒ 丟', () => {
  const { dir, manifest } = fixture();
  manifest.daemon.mac.file = '../evil';
  assert.throws(() => planDaemonObjects(manifest, dir), /daemon\/ 底下/);
  rmSync(dir, { recursive: true });
});

test('ensureLocalExclude：安裝檔不會被 git add -A 收進去（核心驗收：推送不含安裝檔）', () => {
  const { dir } = fixture({ withMsix: true });
  const added = ensureLocalExclude(dir);
  assert.ok(added.length >= 3);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(staged, ['manifest.json'], '只剩 manifest.json，三個安裝檔一個都不能進 index');
  // 冪等
  assert.deepEqual(ensureLocalExclude(dir), []);
  rmSync(dir, { recursive: true });
});

test('ensureLocalExclude：不影響已追蹤的舊安裝檔（只擋新增，不刪歷史）', () => {
  const { dir } = fixture();
  execFileSync('git', ['add', '-f', 'daemon/Arcrun-1.0.0.dmg'], { cwd: dir });
  ensureLocalExclude(dir);
  writeFileSync(join(dir, 'daemon', 'Arcrun-1.0.0.dmg'), 'changed');
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  assert.match(st, /M daemon\/Arcrun-1\.0\.0\.dmg/, '已追蹤的檔照舊被 git 看見');
  rmSync(dir, { recursive: true });
});

test('publishDist：安裝檔先、manifest.json 最後；--remote；key 與 bucket 對', () => {
  const { dir, manifest } = fixture({ withMsix: true });
  const calls = [];
  const r = publishDist({ dist: DIST, manifest, bundlesDir: dir, run: (args, o) => calls.push({ args, o }) });
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).o.label, 'manifest.json');
  assert.deepEqual(calls.slice(0, 3).map((c) => c.o.label), [
    'daemon/Arcrun-1.0.0.dmg', 'daemon/Arcrun-win-1.0.0.exe', 'daemon/Arcrun-1.0.0.msix']);
  for (const c of calls) {
    assert.ok(c.args.includes('--remote'), '必須打真的 R2，不是 wrangler 的本機模擬');
    assert.ok(c.args.includes(`${DIST.bucket}/${c.o.label}`));
  }
  assert.equal(r.pointerUrl, 'https://stage.example.workers.dev/dist/manifest.json');
  assert.ok(!/git\.uncle6\.me/.test(r.pointerUrl));
  rmSync(dir, { recursive: true });
});

test('publishDist：上傳任何一個失敗 ⇒ 丟出去，指標不會被翻', () => {
  const { dir, manifest } = fixture();
  const seen = [];
  assert.throws(() => publishDist({ dist: DIST, manifest, bundlesDir: dir, run: (a, o) => {
    seen.push(o.label);
    if (o.label.endsWith('.exe')) throw new Error('boom');
  } }), /boom/);
  assert.ok(!seen.includes('manifest.json'), '安裝檔沒上完，指標不准動');
  rmSync(dir, { recursive: true });
});

test('assertDistDeclared：缺欄位、或 publicBase 指回 git.uncle6.me ⇒ 丟', () => {
  assert.throws(() => assertDistDeclared({ bucket: 'b' }), /缺欄位/);
  assert.throws(() => assertDistDeclared({ ...DIST, publicBase: 'https://git.uncle6.me/x' }), /git\.uncle6\.me/);
  assert.doesNotThrow(() => assertDistDeclared(DIST));
});

test('小工具：distUrl 去重斜線、contentType、r2PutArgs', () => {
  assert.equal(distUrl('https://a/dist/', '/daemon/x.dmg'), 'https://a/dist/daemon/x.dmg');
  assert.equal(contentTypeOf('A.DMG'), 'application/x-apple-diskimage');
  assert.equal(contentTypeOf('x.bin'), 'application/octet-stream');
  assert.deepEqual(r2PutArgs({ bucket: 'b', key: 'k', file: '/f' }), ['wrangler', 'r2', 'object', 'put', 'b/k', '--file', '/f', '--remote']);
});

// ── 零件包本體也在 R2（#266 的另一半）──────────────────────────────────────────
const BDIST = { ...DIST, bundlePrefix: 'bundle' };
const SHA7 = 'abc1234';

/** 在 fixture 的 git 工作區裡再放幾個零件包檔，並 commit（只有版控內的檔才算這個 sha 的內容）。 */
function bundleFixture() {
  const f = fixture();
  mkdirSync(join(f.dir, 'tier2', 'ui'), { recursive: true });
  mkdirSync(join(f.dir, 'arcrun-set'), { recursive: true });
  writeFileSync(join(f.dir, 'tier2', 'ui', 'index.js'), 'ui');
  writeFileSync(join(f.dir, 'arcrun-set', 'component.wasm'), 'wasm');
  writeFileSync(join(f.dir, 'manifest.json.bak-0826'), 'old');
  ensureLocalExclude(f.dir);
  execFileSync('git', ['add', '-A'], { cwd: f.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], { cwd: f.dir });
  writeFileSync(join(f.dir, 'untracked-leftover.js'), 'stale'); // 工作區殘檔，不屬於這個 sha
  return f;
}

test('bundleDir／bundleDirUrl：由登錄簿算出，釘點 sha 不合法就丟', () => {
  assert.equal(bundleDir(BDIST, SHA7), 'bundle/abc1234');
  assert.equal(bundleDirUrl(BDIST, SHA7), 'https://stage.example.workers.dev/dist/bundle/abc1234');
  assert.throws(() => bundleDir(BDIST, 'XYZ'), /不合法/);
  assert.throws(() => bundleDir(DIST, SHA7), /bundlePrefix/);
});

test('isBundleObject：daemon/ 與 .bak 殘檔不上零件包目錄', () => {
  assert.equal(isBundleObject('tier1/set/index.js'), true);
  assert.equal(isBundleObject('manifest.json'), true);
  assert.equal(isBundleObject('daemon/Arcrun-1.0.0.dmg'), false);
  assert.equal(isBundleObject('manifest.json.bak-0826'), false);
  assert.equal(isBundleObject('../x'), false);
});

test('planBundleObjects：只取版控內的檔（不含工作區殘檔、安裝檔、.bak），key 帶釘點目錄', () => {
  const { dir } = bundleFixture();
  const objs = planBundleObjects({ dist: BDIST, sha7: SHA7, bundlesDir: dir });
  assert.deepEqual(objs.map((o) => o.rel).sort(), ['arcrun-set/component.wasm', 'manifest.json', 'tier2/ui/index.js']);
  assert.equal(objs.find((o) => o.rel === 'arcrun-set/component.wasm').key, 'bundle/abc1234/arcrun-set/component.wasm');
  assert.equal(objs.find((o) => o.rel === 'arcrun-set/component.wasm').contentType, 'application/wasm');
  assert.equal(objs.find((o) => o.rel === 'tier2/ui/index.js').contentType, 'text/javascript; charset=utf-8');
  rmSync(dir, { recursive: true });
});

test('planBundleObjects：版控內沒有 manifest.json、或檔案在工作區不見了 ⇒ 丟，不上傳半套', () => {
  const { dir } = bundleFixture();
  assert.throws(() => planBundleObjects({ dist: BDIST, sha7: SHA7, bundlesDir: dir, listFiles: () => ['tier2/ui/index.js'] }), /manifest\.json/);
  assert.throws(() => planBundleObjects({ dist: BDIST, sha7: SHA7, bundlesDir: dir, listFiles: () => ['manifest.json', 'gone.js'] }), /不見了/);
  rmSync(dir, { recursive: true });
});

test('publishDist（含零件包）：順序＝零件包 → 安裝檔 → 指標；零件包目錄的 manifest 與根指標是兩個 key', () => {
  const { dir, manifest } = bundleFixture();
  const calls = [];
  const r = publishDist({ dist: BDIST, manifest, bundlesDir: dir, bundle: { sha7: SHA7 }, run: (args, o) => calls.push({ args, o }) });
  const labels = calls.map((c) => c.o.label);
  assert.equal(labels.at(-1), 'manifest.json', '指標最後才翻');
  const firstDaemon = labels.findIndex((l) => l.startsWith('daemon/'));
  const lastBundle = Math.max(...labels.map((l, i) => (l.startsWith('bundle/') ? i : -1)));
  assert.ok(lastBundle < firstDaemon, '零件包全部到位，才放安裝檔');
  assert.ok(labels.includes('bundle/abc1234/manifest.json'));
  assert.equal(labels.filter((l) => l.startsWith('bundle/')).length, 3);
  assert.equal(r.bundleBase, 'https://stage.example.workers.dev/dist/bundle/abc1234');
  assert.ok(!JSON.stringify(r).match(/git\.uncle6\.me/));
  for (const c of calls) assert.ok(c.args.includes('--remote'));
  rmSync(dir, { recursive: true });
});

test('publishDist：宣告了 bundlePrefix 卻沒給釘點 sha ⇒ 丟；零件包任一檔上傳失敗 ⇒ 安裝檔與指標都不動', () => {
  const { dir, manifest } = bundleFixture();
  assert.throws(() => publishDist({ dist: BDIST, manifest, bundlesDir: dir, run: () => {} }), /sha7/);
  const seen = [];
  assert.throws(() => publishDist({ dist: BDIST, manifest, bundlesDir: dir, bundle: { sha7: SHA7 },
    run: (a, o) => { seen.push(o.label); if (o.label.endsWith('.wasm')) throw new Error('boom'); } }), /boom/);
  assert.ok(!seen.some((l) => l.startsWith('daemon/') || l === 'manifest.json'));
  rmSync(dir, { recursive: true });
});
