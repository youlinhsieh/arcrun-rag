// worktree-commit.test.mjs — inkstone/arcrun-rag#47
//
// 用**真的 git 暫存 repo** 驗證：出貨落帳這一站真的把 git status 弄乾淨、真的擋竄改、
// 真的不掃別人的檔、真的在 detached HEAD 也不弄丟 commit。不是 mock git——因為本票的
// 事故（另一個 subagent 的 git checkout 蓋掉一半）正是 git 行為本身，mock 掉就驗不到。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitShipOutputs, detectTamper, classifyChanges, sha256OfFile, changedPaths } from './worktree-commit.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wtc-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  // 種一個初始 commit，讓 HEAD 有得指
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
  return dir;
}

const OWNED = [
  'installer/oauth-prototype/wrangler.toml',
  'installer/oauth-prototype/worker.js',
  'installer/ship-report.json',
  'installer/ship-report.md',
];

// 模擬 ship 走一趟：先在版控裡有這些檔（上一版），再讓 ship「寫新內容 + stamp 釘子」
function seedOwnedFiles(dir) {
  git(dir, 'add', '-A');
  execFileSync('mkdir', ['-p', join(dir, 'installer/oauth-prototype')]);
  for (const rel of OWNED) writeFileSync(join(dir, rel), `old:${rel}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'v1 baseline');
}

function shipWrites(dir, pin) {
  // pin 站寫兩份手抄本
  writeFileSync(join(dir, 'installer/oauth-prototype/wrangler.toml'), `BUNDLE_BASE=${pin}\n`);
  writeFileSync(join(dir, 'installer/oauth-prototype/worker.js'), `const DEFAULT_BUNDLE_BASE='${pin}'\n`);
  // report 站寫稽核留痕
  writeFileSync(join(dir, 'installer/ship-report.json'), `{"release":"1.4.99","pin":"${pin}"}\n`);
  writeFileSync(join(dir, 'installer/ship-report.md'), `# ship ${pin}\n`);
  // stamp 只蓋釘子檔（＝pin 站寫完那一刻的指紋）
  return ['installer/oauth-prototype/wrangler.toml', 'installer/oauth-prototype/worker.js']
    .map((rel) => ({ rel, sha256: sha256OfFile(join(dir, rel)) }));
}

test('乾淨路徑：ship 寫的都進版控，結束 git status 對這些檔是乾淨的', () => {
  const dir = newRepo();
  try {
    seedOwnedFiles(dir);
    const stamps = shipWrites(dir, 'abc1234');
    const r = commitShipOutputs({ repoRoot: dir, ownedRel: OWNED, stamps, message: 'chore(ship): 1.4.99 落帳' });
    assert.equal(r.status, 'done');
    assert.deepEqual(new Set(r.committed), new Set(OWNED));
    // 結束當下 git status 乾淨
    assert.equal(git(dir, 'status', '--porcelain'), '');
    // commit 訊息在 HEAD 上
    assert.match(git(dir, 'log', '-1', '--pretty=%s'), /1\.4\.99 落帳/);
    // 版控裡就是新釘子
    assert.match(git(dir, 'show', 'HEAD:installer/oauth-prototype/wrangler.toml'), /abc1234/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('竄改偵測：ship 寫完釘子後被別人 git checkout 蓋回舊值 → 當場停，不 commit 半套', () => {
  const dir = newRepo();
  try {
    seedOwnedFiles(dir);
    const stamps = shipWrites(dir, 'newpin7'); // ship 寫了新釘子並 stamp
    // 另一個 subagent 把 worker.js 還原（正是 #47 事故）
    git(dir, 'checkout', '--', 'installer/oauth-prototype/worker.js');
    assert.throws(
      () => commitShipOutputs({ repoRoot: dir, ownedRel: OWNED, stamps, message: 'x' }),
      /被動過|checkout|半套/,
    );
    // 沒有新 commit 產生（HEAD 還在 baseline）
    assert.match(git(dir, 'log', '-1', '--pretty=%s'), /baseline/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('不掃別人的檔：REPO_ROOT 別處髒 → 只 add ship 自己的，別人的原樣留著', () => {
  const dir = newRepo();
  try {
    seedOwnedFiles(dir);
    const stamps = shipWrites(dir, 'pin0007');
    // 另一個 subagent 在別處有未提交的無關改動
    writeFileSync(join(dir, 'someone-else.txt'), 'WIP by another subagent\n');
    const r = commitShipOutputs({ repoRoot: dir, ownedRel: OWNED, stamps, message: 'chore(ship): 落帳' });
    assert.equal(r.status, 'done');
    assert.ok(r.foreign.includes('someone-else.txt'));
    // 別人的檔沒被 commit，仍在工作區
    assert.equal(git(dir, 'status', '--porcelain', '--', 'someone-else.txt').trim(), '?? someone-else.txt');
    // ship 自己的都乾淨了
    for (const rel of OWNED) assert.equal(git(dir, 'status', '--porcelain', '--', rel).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('冪等：沒有要落帳的東西（釘子沒動）→ skip，不生空 commit', () => {
  const dir = newRepo();
  try {
    seedOwnedFiles(dir);
    const before = git(dir, 'rev-parse', 'HEAD');
    const r = commitShipOutputs({ repoRoot: dir, ownedRel: OWNED, stamps: [], message: 'x' });
    assert.equal(r.status, 'skip');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before); // HEAD 沒動
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detached HEAD（出貨 worktree 的形狀）：commit 後釘一根分支，commit 不會被弄丟', () => {
  const dir = newRepo();
  try {
    seedOwnedFiles(dir);
    // 進入 detached HEAD（products/arcrun-rag-shipprod 的狀態）
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    const stamps = shipWrites(dir, 'detach9');
    const r = commitShipOutputs({ repoRoot: dir, ownedRel: OWNED, stamps, message: 'chore(ship): detached 落帳' });
    assert.equal(r.status, 'done');
    assert.ok(r.ref, '應該釘了一根分支');
    // 那根分支真的指到這顆新 commit
    assert.equal(git(dir, 'rev-parse', r.ref), r.sha);
    // 就算現在 checkout 回 main，commit 也還在（被 ref 錨住，不會 gc）
    git(dir, 'checkout', '-q', 'main');
    assert.equal(git(dir, 'rev-parse', r.ref), r.sha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 純函式單元測試 ────────────────────────────────────────────────────────
test('classifyChanges：把改動分成 ship 的與別人的', () => {
  const { mine, foreign } = classifyChanges(
    ['installer/ship-report.md', 'random.txt', 'installer/oauth-prototype/worker.js'],
    OWNED);
  assert.deepEqual(mine, ['installer/ship-report.md', 'installer/oauth-prototype/worker.js']);
  assert.deepEqual(foreign, ['random.txt']);
});

test('detectTamper：sha 對得上不報，動過就報，檔案不見也報', () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, 'a'), 'hello\n');
    const good = sha256OfFile(join(dir, 'a'));
    assert.deepEqual(detectTamper(dir, [{ rel: 'a', sha256: good }]), []);
    writeFileSync(join(dir, 'a'), 'tampered\n');
    assert.equal(detectTamper(dir, [{ rel: 'a', sha256: good }]).length, 1);
    assert.equal(detectTamper(dir, [{ rel: 'gone', sha256: good }])[0].actual, '(檔案不見了)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('實戰 owned 清單：ship 真的會傳的那張表——沒動的 gate-log 不礙事，動的都進版控', () => {
  const dir = newRepo();
  try {
    // ship.mjs 檔尾傳的完整 ownedRel（含 version.mjs、四個 gate-log、release-state、report、釘子）
    const FULL = [
      'installer/release-state.json',
      'installer/oauth-prototype/version.mjs',
      'installer/ship-report.json', 'installer/ship-report.md',
      'installer/daemon-in-bundle-gate-log.md', 'installer/main-push-gate-log.md',
      'installer/release-line-gate-log.md', 'installer/daemon-freshness-gate-log.md',
      'installer/oauth-prototype/wrangler.toml', 'installer/oauth-prototype/worker.js',
    ];
    execFileSync('mkdir', ['-p', join(dir, 'installer/oauth-prototype')]);
    for (const rel of FULL) writeFileSync(join(dir, rel), `old:${rel}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'v1');
    // 這一趟 ship 只動了其中一部分：釘子、release-state、version.mjs、report、一個 gate-log
    const touched = [
      'installer/oauth-prototype/wrangler.toml', 'installer/oauth-prototype/worker.js',
      'installer/release-state.json', 'installer/oauth-prototype/version.mjs',
      'installer/ship-report.json', 'installer/ship-report.md',
      'installer/daemon-in-bundle-gate-log.md',
    ];
    for (const rel of touched) writeFileSync(join(dir, rel), `new:${rel}\n`);
    const stamps = ['installer/oauth-prototype/wrangler.toml', 'installer/oauth-prototype/worker.js']
      .map((rel) => ({ rel, sha256: sha256OfFile(join(dir, rel)) }));

    const r = commitShipOutputs({ repoRoot: dir, ownedRel: FULL, stamps, message: 'chore(ship): 落帳' });
    assert.equal(r.status, 'done');
    assert.deepEqual(new Set(r.committed), new Set(touched)); // 只 commit 真的動了的
    assert.equal(r.foreign.length, 0);
    assert.equal(git(dir, 'status', '--porcelain'), ''); // 全乾淨
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changedPaths：檔名有空白也讀得對（-z）', () => {
  const dir = newRepo();
  try {
    writeFileSync(join(dir, 'a b c.txt'), 'x\n');
    assert.ok(changedPaths(dir).includes('a b c.txt'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
