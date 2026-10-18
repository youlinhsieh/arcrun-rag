/**
 * bundle-push-scope.test.mjs — inkstone/arcrun-rag#265
 * 中止一輪、換新版號重跑 ⇒ 待推內容只含 manifest 指到的 daemon/ 檔；
 * push 逾時 ⇒ 錯誤訊息講出待推大小與 100 秒上限。
 *
 * 跑法：node --test installer/scripts/bundle-push-scope.test.mjs
 * （用真的臨時 git repo＋本機 bare origin，不碰任何真的 bundle repo）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  manifestDaemonFiles, strayDaemonPaths, pruneStrayDaemon, pendingPushBytes,
  describePushFailure, looksLikeGatewayTimeout, GATEWAY_TIMEOUT_SECONDS,
} from './bundle-push-scope.mjs';

const manifest104 = {
  daemon: {
    version: '0.18.104',
    mac: { file: 'daemon/Arcrun-0.18.104.dmg', sha256: 'a' },
    win: { file: 'daemon/Arcrun-win-0.18.104.exe', sha256: 'b' },
    msix: { file: 'daemon/Arcrun-0.18.104.msix', sha256: 'c' },
  },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bundle-push-scope-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'bundles');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  const git = (args, input) => execFileSync('git', args, { cwd: work, encoding: 'utf8', input });
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  mkdirSync(join(work, 'daemon'));
  writeFileSync(join(work, 'daemon', 'Arcrun-0.18.100.dmg'), 'old-already-shipped');
  writeFileSync(join(work, 'manifest.json'), '{}');
  git(['add', '-A']); git(['commit', '-q', '-m', 'seed']); git(['push', '-q', 'origin', 'main']);
  const put = (name, size = 1000) => writeFileSync(join(work, 'daemon', name), 'x'.repeat(size));
  return { root, work, git, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('manifestDaemonFiles：只收 manifest.daemon 指到的 daemon/ 路徑（不寫死平台）', () => {
  assert.deepEqual([...manifestDaemonFiles(manifest104)].sort(), [
    'daemon/Arcrun-0.18.104.dmg', 'daemon/Arcrun-0.18.104.msix', 'daemon/Arcrun-win-0.18.104.exe',
  ]);
  assert.equal(manifestDaemonFiles({}).size, 0);
});

test('strayDaemonPaths：非 daemon/ 的新增檔不算；daemon/ 沒被指到的才算', () => {
  const r = strayDaemonPaths(
    ['daemon/Arcrun-0.18.103.dmg', 'daemon/Arcrun-0.18.104.dmg', 'README.md', 'manifest.json'], manifest104);
  assert.deepEqual(r, ['daemon/Arcrun-0.18.103.dmg']);
});

test('✅ 已 commit 沒推的 103 三檔 ＋ 104 三檔 ⇒ 只剩 104 要推，103 移到 .unshipped（#265 原案重現）', () => {
  const s = setup();
  try {
    for (const n of ['Arcrun-0.18.103.dmg', 'Arcrun-win-0.18.103.exe', 'Arcrun-0.18.103.msix',
      'Arcrun-0.18.104.dmg', 'Arcrun-win-0.18.104.exe', 'Arcrun-0.18.104.msix']) s.put(n);
    writeFileSync(join(s.work, 'manifest.json'), JSON.stringify(manifest104));
    s.git(['add', '-A']); s.git(['commit', '-q', '-m', 'ship 0.18.104']);

    const before = s.git(['diff', '--name-only', 'origin/main..HEAD']).trim().split('\n');
    assert.equal(before.filter((p) => p.includes('0.18.103')).length, 3);

    const r = pruneStrayDaemon({ git: s.git, bundlesDir: s.work, manifest: manifest104, remoteRef: 'origin/main' });
    assert.equal(r.moved.length, 3);
    assert.equal(r.rewrote, true);

    const after = s.git(['diff', '--name-only', 'origin/main..HEAD']).trim().split('\n');
    assert.ok(after.every((p) => !p.includes('0.18.103')), `待推仍含 103：${after}`);
    assert.ok(after.includes('daemon/Arcrun-0.18.104.dmg'));
    assert.ok(after.includes('daemon/Arcrun-win-0.18.104.exe'));
    assert.ok(after.includes('daemon/Arcrun-0.18.104.msix'));
    // 不刪：搬到旁邊，人可撿回；工作區也不再有 103（否則下一次 add -A 又帶上）
    assert.ok(existsSync(join(`${s.work}.unshipped`, 'daemon', 'Arcrun-0.18.103.dmg')));
    assert.ok(!existsSync(join(s.work, 'daemon', 'Arcrun-0.18.103.dmg')));
    assert.equal(s.git(['status', '--porcelain']).trim(), '');
    // 已在遠端的舊版（100）完全不碰
    assert.ok(existsSync(join(s.work, 'daemon', 'Arcrun-0.18.100.dmg')));
    assert.equal(s.git(['ls-files', 'daemon/Arcrun-0.18.100.dmg']).trim(), 'daemon/Arcrun-0.18.100.dmg');
  } finally { s.done(); }
});

test('✅ 還沒 commit 的（untracked）103 ⇒ 同樣移出，commit 站 add -A 就帶不上', () => {
  const s = setup();
  try {
    s.put('Arcrun-0.18.103.dmg'); s.put('Arcrun-0.18.104.dmg');
    const r = pruneStrayDaemon({ git: s.git, bundlesDir: s.work, manifest: manifest104, remoteRef: 'origin/main' });
    assert.deepEqual(r.moved, ['daemon/Arcrun-0.18.103.dmg']);
    assert.equal(r.rewrote, false);
    s.git(['add', '-A']);
    const staged = s.git(['diff', '--cached', '--name-only']).trim();
    assert.equal(staged, 'daemon/Arcrun-0.18.104.dmg');
  } finally { s.done(); }
});

test('✅ 沒有多餘舊版號 ⇒ 什麼都不動（正常出貨路徑零影響）', () => {
  const s = setup();
  try {
    s.put('Arcrun-0.18.104.dmg'); s.put('Arcrun-win-0.18.104.exe'); s.put('Arcrun-0.18.104.msix');
    writeFileSync(join(s.work, 'manifest.json'), JSON.stringify(manifest104));
    s.git(['add', '-A']); s.git(['commit', '-q', '-m', 'ship 0.18.104']);
    const head = s.git(['rev-parse', 'HEAD']).trim();
    const r = pruneStrayDaemon({ git: s.git, bundlesDir: s.work, manifest: manifest104, remoteRef: 'origin/main' });
    assert.deepEqual(r, { moved: [], rewrote: false, destDir: null });
    assert.equal(s.git(['rev-parse', 'HEAD']).trim(), head);
  } finally { s.done(); }
});

test('✅ 待推全是舊版號產物 ⇒ 摘完不留空 commit', () => {
  const s = setup();
  try {
    s.put('Arcrun-0.18.103.dmg');
    s.git(['add', '-A']); s.git(['commit', '-q', '-m', 'ship 0.18.103']);
    pruneStrayDaemon({ git: s.git, bundlesDir: s.work, manifest: manifest104, remoteRef: 'origin/main' });
    assert.equal(s.git(['rev-list', '--count', 'origin/main..HEAD']).trim(), '0');
  } finally { s.done(); }
});

test('pendingPushBytes：量的是待推 object 大小，移出舊版後明顯變小', () => {
  const s = setup();
  try {
    s.put('Arcrun-0.18.103.dmg', 200_000); s.put('Arcrun-0.18.104.dmg', 50_000);
    writeFileSync(join(s.work, 'manifest.json'), JSON.stringify(manifest104));
    s.git(['add', '-A']); s.git(['commit', '-q', '-m', 'ship']);
    const big = pendingPushBytes(s.git, 'origin/main');
    assert.ok(big >= 250_000, `量到 ${big}`);
    pruneStrayDaemon({ git: s.git, bundlesDir: s.work, manifest: manifest104, remoteRef: 'origin/main' });
    const small = pendingPushBytes(s.git, 'origin/main');
    assert.ok(small < 100_000 && small >= 50_000, `移出後量到 ${small}`);
    // 沒待推 ⇒ 0
    s.git(['push', '-q', 'origin', 'main']);
    assert.equal(pendingPushBytes(s.git, 'origin/main'), 0);
  } finally { s.done(); }
});

test('✅ 524 錯誤訊息講出待推大小與 100 秒上限，不是只報 524', () => {
  const msg = describePushFailure({
    bytes: 84 * 1024 * 1024,
    original: 'Command failed: git push origin main\nerror: RPC failed; HTTP 524 curl 22 The requested URL returned error: 524',
    remote: 'git.uncle6.me/inkstone/arcrun-rag-bundles-stage',
  });
  assert.match(msg, /84\.0 MB/);
  assert.match(msg, new RegExp(`${GATEWAY_TIMEOUT_SECONDS} 秒`));
  assert.match(msg, /524/);
  assert.equal(GATEWAY_TIMEOUT_SECONDS, 100);
});

test('非逾時的 push 失敗（例如被拒）⇒ 不亂套逾時說法，但仍附待推大小', () => {
  const orig = 'error: failed to push some refs (rejected: fetch first)';
  assert.equal(looksLikeGatewayTimeout(orig), false);
  const msg = describePushFailure({ bytes: 2 * 1024 * 1024, original: orig });
  assert.match(msg, /2\.0 MB/);
  assert.doesNotMatch(msg, /100 秒/);
});
