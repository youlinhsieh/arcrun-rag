/**
 * no-local-build-gate.test.mjs — 跑法：`node --test installer/scripts/no-local-build-gate.test.mjs`
 *
 * 這道閘的價值全在「它抓得到什麼」，所以測的是**四種違規形態**：
 *   ① 位元組被改過（手改／自己編出來的都長這樣）
 *   ② bundle 有一顆 Arcrun 根本沒編過（＝它一定是在別處產生的）
 *   ③ wasm part 被換過（主檔對、附件不對）
 *   ④ 出貨腳本自己 import 打包器
 * 外加一條**不該擋**的：照抄官方成品要通過（否則這道閘會變成不能出貨）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync as readSrc } from 'node:fs';
import { checkProvenance, checkNoBundlerInShipScripts, requireNoLocalBuild } from './no-local-build-gate.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 造一個「照抄官方成品」的乾淨現場。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nlb-'));
  const bundles = join(root, 'bundles');
  const js = '// worker\nexport default {};\n';
  const wasm = 'WASM-BYTES';
  mkdirSync(join(bundles, 'arcrun-set'), { recursive: true });
  writeFileSync(join(bundles, 'arcrun-set', 'worker.mjs'), js);
  writeFileSync(join(bundles, 'arcrun-set', 'component.wasm'), wasm);

  const manifest = {
    core: [{
      name: 'arcrun-set', main_file: 'arcrun-set/worker.mjs',
      modules: [{ name: 'component.wasm', file: 'arcrun-set/component.wasm' }],
    }],
    library: [{
      name: 'arcrun-set', main_file: 'arcrun-set/worker.mjs',
      modules: [{ name: 'component.wasm', file: 'arcrun-set/component.wasm' }],
    }],
  };
  const artifactManifest = {
    repo_head: 'deadbeef',
    workers: [{
      name: 'arcrun-set', content_sha256: sha(js), source_commit: 'cafebabe',
      modules: [{ name: 'component.wasm', sha256: sha(wasm) }],
    }],
  };
  return { root, bundles, manifest, artifactManifest, js, wasm };
}

test('照抄官方成品 ⇒ 通過（這道閘不能讓正常出貨過不了）', () => {
  const f = fixture();
  const r = checkProvenance({ bundlesDir: f.bundles, manifest: f.manifest, artifactManifest: f.artifactManifest, arcrunRepo: '/x' });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.checked, 1);
});

test('位元組被改過 ⇒ 擋，且說得出兩邊指紋', () => {
  const f = fixture();
  writeFileSync(join(f.bundles, 'arcrun-set', 'worker.mjs'), f.js + '// 有人動了手腳\n');
  const r = checkProvenance({ bundlesDir: f.bundles, manifest: f.manifest, artifactManifest: f.artifactManifest, arcrunRepo: '/x' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /位元組與 Arcrun 官方成品不同/);
  assert.match(r.problems[0].why, /cafebabe/, '要指得出官方成品是哪顆 commit 編的');
});

test('bundle 有一顆 Arcrun 沒編過 ⇒ 擋（那顆一定是在別處產生的）', () => {
  const f = fixture();
  f.artifactManifest.workers = [];
  const r = checkProvenance({ bundlesDir: f.bundles, manifest: f.manifest, artifactManifest: f.artifactManifest, arcrunRepo: '/x' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /沒有這一顆/);
});

test('wasm part 被換過 ⇒ 擋（主檔對不代表附件對）', () => {
  const f = fixture();
  writeFileSync(join(f.bundles, 'arcrun-set', 'component.wasm'), 'OTHER-WASM');
  const r = checkProvenance({ bundlesDir: f.bundles, manifest: f.manifest, artifactManifest: f.artifactManifest, arcrunRepo: '/x' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /wasm part/);
});

test('出貨腳本 import 打包器 ⇒ 擋；只是在註解裡講病史 ⇒ 不擋', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-'));
  writeFileSync(join(dir, 'clean.mjs'), [
    '// 這裡以前跑過 esbuild，2026-08-11 拿掉了（註解要留著，不該被當成違規）',
    "import { readFileSync } from 'node:fs';",
  ].join('\n'));
  assert.equal(checkNoBundlerInShipScripts(dir).ok, true);

  writeFileSync(join(dir, 'dirty.mjs'), "import esbuild from 'esbuild';\n");
  const bad = checkNoBundlerInShipScripts(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.hits[0].text, /esbuild/);
});

test('豁免註記 ⇒ 放行（真有例外時不必繞過整道閘）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-'));
  writeFileSync(join(dir, 'x.mjs'), "import esbuild from 'esbuild'; // build-elsewhere-ok\n");
  assert.equal(checkNoBundlerInShipScripts(dir).ok, true);
});

test('入口 requireNoLocalBuild：訊息要說得出 D91 是什麼', () => {
  const f = fixture();
  writeFileSync(join(f.bundles, 'arcrun-set', 'worker.mjs'), 'tampered');
  const emptyScripts = mkdtempSync(join(tmpdir(), 'scripts-'));
  assert.throws(
    () => requireNoLocalBuild({
      bundlesDir: f.bundles, manifest: f.manifest, artifactManifest: f.artifactManifest,
      arcrunRepo: '/x', scriptsDir: emptyScripts,
    }),
    /說不出來源|D91/);
});

test('出貨線在「取貨後」與「入庫前」各驗一次——少一次就不再貼著真的送出去的那份', () => {
  const src = readSrc(new URL('./ship.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/requireNoLocalBuild\(/g)].length;
  assert.ok(calls >= 2,
    `ship.mjs 只呼叫了 ${calls} 次 requireNoLocalBuild。` +
    '兩個位置缺一不可：no-local-build 站（取貨後就發現，預演也看得到）＋ commit 站' +
    '（入庫前，那才是使用者真的會拿到的那一份；中間隔著四個會寫 bundle 工作區的站）。');
});

test('出貨線裡不該再有叫 build 的站——名字要說得出它真正在做什麼', () => {
  const src = readSrc(new URL('./ship.mjs', import.meta.url), 'utf8');
  const ids = [...src.matchAll(/^\{ id: '([a-z-]+)', title:/gm)].map((m) => m[1]);
  assert.ok(!ids.includes('build'),
    '有一站叫 build，但出貨線不 build（D91）。名字說一件事、實際做另一件，' +
    '正是 08-14 災情的形狀：下一個人會照那個名字做決策。');
  assert.ok(ids.includes('fetch-artifacts'), '取貨那一站不見了？');
});
