/**
 * artifact-freshness.test.mjs — 證明「成品比源碼舊就會**停**」真的會斷，而且指名道姓。
 *
 * 跑法：node --test installer/scripts/artifact-freshness.test.mjs
 * （零依賴、全程用臨時 git repo，不碰 matrix/arcrun 或任何真的 repo）
 *
 * 這些案例直接照 Leo/Arcrun#93 那天的形狀寫：
 *   · 併了修法卻沒重編 ⇒ 源碼目錄在 source_commit 之後又有 commit ⇒ 必須擋
 *   · **沒有人碰過 `.worker-builds/`** ⇒ 舊的落後閘正是在這裡安靜放行的
 *   · 只動別顆 worker 的源碼 ⇒ 不准誤報這顆（誤報會逼人加旗標繞過，等於把閘關掉）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sourceDirsOf, checkOne, checkArtifactFreshness, formatFreshnessProblem, requireFreshArtifacts,
} from './artifact-freshness.mjs';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo, msg) {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** 造一個長得像 Arcrun 的臨時 repo：兩顆 worker 的源碼目錄 ＋ 一個 .worker-builds/。 */
function fakeArcrun() {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-freshness-'));
  git(dir, ['init', '-q', '-b', 'main']);
  for (const d of ['cypher-executor/src', 'kbdb/src', '.worker-builds']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'cypher-executor/src/index.ts'), 'export default 1;\n');
  writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 1;\n');
  writeFileSync(join(dir, '.worker-builds/manifest.json'), '{}\n');
  const sha = commit(dir, '第一版源碼＋成品');
  return { dir, sha };
}

const COMPONENTS = [
  { name: 'arcrun-cypher-executor', dir: 'cypher-executor' },
  { name: 'arcrun-kbdb', dir: 'kbdb' },
];
const manifestWith = (cypher, kbdb) => ({
  workers: [
    { name: 'arcrun-cypher-executor', source_commit: cypher },
    { name: 'arcrun-kbdb', source_commit: kbdb },
  ],
});

test('✅ 成品與源碼同步 ⇒ 放行', () => {
  const { dir, sha } = fakeArcrun();
  try {
    const r = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS });
    assert.equal(r.ok, true, JSON.stringify(r.blocking, null, 2));
    assert.deepEqual(r.results.map((x) => x.status), ['ok', 'ok']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 08-12 那天的形狀：併了修法沒重編（.worker-builds 完全沒動過）⇒ 擋，並指名是哪幾顆、差哪一顆 commit', () => {
  const { dir, sha } = fakeArcrun();
  try {
    // 併 Arcrun#85／#88：兩顆 worker 的源碼各往前一顆 commit，**成品完全沒重編**
    writeFileSync(join(dir, 'cypher-executor/src/index.ts'), 'export default 2;\n');
    const c1 = commit(dir, 'fix(cypher): Arcrun#85 的修法');
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 2;\n');
    const c2 = commit(dir, 'fix(kbdb): Arcrun#88 的修法');

    // 舊的落後閘看的是 `.worker-builds` 這個目錄——它一顆 commit 都沒有，所以會放行：
    const behindWorkerBuilds = git(dir, ['log', '--oneline', `${sha}..HEAD`, '--', '.worker-builds']);
    assert.equal(behindWorkerBuilds, '', '前提：.worker-builds 沒被碰過，舊閘因此無話可說');

    const r = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS });
    assert.equal(r.ok, false, '新的閘必須擋下來');
    assert.equal(r.blocking.length, 2);
    assert.deepEqual(r.blocking.map((x) => x.name), ['arcrun-cypher-executor', 'arcrun-kbdb']);
    assert.deepEqual(r.blocking.map((x) => x.status), ['stale', 'stale']);

    const msg = formatFreshnessProblem({ repo: dir, results: r.results, blocking: r.blocking });
    assert.match(msg, /arcrun-cypher-executor/);
    assert.match(msg, /arcrun-kbdb/);
    assert.match(msg, new RegExp(sha.slice(0, 7)), '要講「成品記的是哪顆」');
    assert.match(msg, new RegExp(c1.slice(0, 7)), '要講「差的是哪一顆 commit」');
    assert.match(msg, new RegExp(c2.slice(0, 7)));
    assert.match(msg, /不會自動幫你重編/, '紅線：不准自動重編就放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 只動別顆的源碼 ⇒ 只報那一顆，不誤報同伴（誤報會逼人加旗標繞過，等於把閘關掉）', () => {
  const { dir, sha } = fakeArcrun();
  try {
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 2;\n');
    commit(dir, 'fix(kbdb): 只改 kbdb');
    const r = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS });
    assert.equal(r.ok, false);
    assert.deepEqual(r.blocking.map((x) => x.name), ['arcrun-kbdb']);
    assert.equal(r.results.find((x) => x.name === 'arcrun-cypher-executor').status, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 源碼改了但還沒 commit ⇒ 擋；只有 selftest 那種「不推不部署」的目標才降級放行', () => {
  const { dir, sha } = fakeArcrun();
  try {
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 999;\n'); // 不 commit
    const strict = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS });
    assert.equal(strict.ok, false);
    assert.equal(strict.blocking[0].status, 'dirty');

    const lenient = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS, allowDirty: true });
    assert.equal(lenient.ok, true, 'allowDirty ＝ selftest：不推不部署，沒有人會拿到東西');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 已 commit 的落後，allowDirty 也救不了（那跟工作區乾不乾淨無關）', () => {
  const { dir, sha } = fakeArcrun();
  try {
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 2;\n');
    commit(dir, 'fix(kbdb): 已經進版控了');
    const r = checkArtifactFreshness({ repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS, allowDirty: true });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].status, 'stale');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：成品沒記 source_commit ⇒ unknown，不是安靜放行', () => {
  const { dir } = fakeArcrun();
  try {
    const r = checkArtifactFreshness({ repo: dir, manifest: { workers: [{ name: 'arcrun-kbdb' }] }, components: COMPONENTS });
    assert.equal(r.ok, false);
    assert.deepEqual(r.blocking.map((x) => x.status), ['unknown', 'unknown']);
    assert.match(r.blocking[1].reason, /沒有記 source_commit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：不知道源碼在哪個目錄 ⇒ unknown', () => {
  const { dir, sha } = fakeArcrun();
  try {
    const r = checkOne({ repo: dir, name: 'arcrun-mystery', artifact: { name: 'arcrun-mystery', source_commit: sha }, component: {} });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /不知道這顆的源碼在哪個目錄/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：成品的 commit 不是 HEAD 的祖先（來自別條線）⇒ unknown', () => {
  const { dir, sha } = fakeArcrun();
  try {
    git(dir, ['checkout', '-q', '-b', 'side', sha]);
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 3;\n');
    const sideSha = commit(dir, '別條線上的 commit');
    git(dir, ['checkout', '-q', 'main']);
    const r = checkOne({ repo: dir, name: 'arcrun-kbdb', artifact: { source_commit: sideSha }, component: { dir: 'kbdb' } });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /不是現在 HEAD/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 源碼目錄沒被 git 追蹤 ⇒ unknown，不准當成「同步」（那個「沒有差異」是假的）', () => {
  const { dir, sha } = fakeArcrun();
  try {
    const r = checkOne({
      repo: dir, name: 'arcrun-http-request',
      artifact: { source_commit: sha }, component: { dir: '.component-builds/http_request' },
    });
    assert.equal(r.status, 'unknown', '目錄不在版控裡 ⇒ git log／status 永遠是空的 ⇒ 等於這顆沒有閘');
    assert.match(r.reason, /沒有被 git 追蹤/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('成品自己記的 source_dir 優先於本 repo 的 build.dir；都沒有才是空的', () => {
  assert.deepEqual(sourceDirsOf({ source_dir: 'a' }, { dir: 'b' }), ['a']);
  assert.deepEqual(sourceDirsOf({ source_dirs: ['a', 'shared/'] }, { dir: 'b' }), ['a', 'shared']);
  assert.deepEqual(sourceDirsOf({}, { dir: 'b' }), ['b']);
  assert.deepEqual(sourceDirsOf({}, {}), []);
});

test('requireFreshArtifacts：對不上就丟例外；ARTIFACT_ALLOW_STALE=1 才放行，而且照樣把差異印出來', () => {
  const { dir, sha } = fakeArcrun();
  const prev = process.env.ARTIFACT_ALLOW_STALE;
  const warned = [];
  const realWarn = console.warn;
  try {
    writeFileSync(join(dir, 'kbdb/src/index.ts'), 'export default 2;\n');
    commit(dir, 'fix(kbdb): 沒重編');
    const args = { repo: dir, manifest: manifestWith(sha, sha), components: COMPONENTS };

    delete process.env.ARTIFACT_ALLOW_STALE;
    assert.throws(() => requireFreshArtifacts(args), /arcrun-kbdb/);

    process.env.ARTIFACT_ALLOW_STALE = '1';
    console.warn = (...a) => warned.push(a.join(' '));
    const r = requireFreshArtifacts(args);
    assert.equal(r.ok, false, '放行不等於變成綠的——結果照樣是「對不上」');
    assert.match(warned.join('\n'), /arcrun-kbdb/, '明知故犯也要看得見少了哪一步');
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.ARTIFACT_ALLOW_STALE; else process.env.ARTIFACT_ALLOW_STALE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
