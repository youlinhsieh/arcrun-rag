/**
 * mirror-align.test.mjs — 在新 worktree 出貨，公開鏡像也推得上去（inkstone/arcrun-rag#202 c7599）。
 *
 * 跑法：node --test installer/scripts/mirror-align.test.mjs
 *
 * 全部用本機 bare repo 當「GitHub」，不碰網路。
 *   ① 09-17 的形狀：本機鏡像是現場 git init 的不相干歷史 ⇒ 改接到遠端上面、壓成一筆，
 *      之後 push **不用 force** 就成功，遠端舊歷史一筆不少
 *   ② 已經接在遠端後面 ⇒ 什麼都不動
 *   ③ 內容與遠端相同 ⇒ 對齊到遠端，不多疊空 commit
 *   ④ 遠端還沒有 main ⇒ 照本機歷史推
 *   ⑤ remote 網址帶帳密 ⇒ 拒絕（這一步只准匿名讀）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignMirrorWithRemote } from './mirror-align.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function repoWith(dir, files, msg) {
  g(dir, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  g(dir, 'add', '-A');
  g(dir, ...ID, 'commit', '-q', '-m', msg);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mirror-align-'));
  const remote = join(root, 'github.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', remote);
  // 遠端：先前幾次出貨推上去的快照
  const old = join(root, 'old-mirror');
  execFileSync('mkdir', [old]);
  repoWith(old, { 'README.md': 'v1' }, 'release: snapshot aaa');
  writeFileSync(join(old, 'README.md'), 'v2');
  g(old, ...ID, 'commit', '-q', '-am', 'release: snapshot bbb');
  g(old, 'push', '-q', remote, 'HEAD:refs/heads/main');
  return { root, remote, remoteHead: g(old, 'rev-parse', 'HEAD') };
}

test('① 不相干的新歷史 ⇒ 改接到遠端上、push 不用 force 就過，遠端舊歷史都在', () => {
  const { root, remote, remoteHead } = setup();
  const mirror = join(root, 'fresh-worktree-mirror');
  execFileSync('mkdir', [mirror]);
  repoWith(mirror, { 'README.md': 'v3', 'new.txt': 'x' }, 'release: snapshot cdd2ccc');
  writeFileSync(join(mirror, 'README.md'), 'v4');
  g(mirror, ...ID, 'commit', '-q', '-am', 'release: snapshot bee02eb (2026-09-17)');
  // 前提：照舊直接推會被拒（09-17 那個錯）
  assert.throws(() => g(mirror, 'push', remote, 'HEAD:refs/heads/main'), /rejected|fetch first|non-fast-forward/);

  const r = alignMirrorWithRemote({ mirrorDir: mirror, remote });
  assert.equal(r.action, 'rebased');
  assert.equal(r.remoteSha, remoteHead);
  assert.equal(g(mirror, 'rev-parse', 'HEAD^'), remoteHead, '壓成一筆、父親就是遠端 main');
  assert.equal(g(mirror, 'log', '-1', '--format=%s'), 'release: snapshot bee02eb (2026-09-17)');
  assert.equal(g(mirror, 'show', 'HEAD:README.md'), 'v4', 'tree 是這一版的公開樹');

  g(mirror, 'push', '-q', remote, 'HEAD:refs/heads/main'); // 不帶 --force
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim(), '3');
});

test('② 已經接在遠端後面 ⇒ 不動', () => {
  const { root, remote, remoteHead } = setup();
  const mirror = join(root, 'clone');
  g(root, 'clone', '-q', remote, mirror);
  writeFileSync(join(mirror, 'README.md'), 'v3');
  g(mirror, ...ID, 'commit', '-q', '-am', 'release: snapshot ccc');
  const before = g(mirror, 'rev-parse', 'HEAD');
  const r = alignMirrorWithRemote({ mirrorDir: mirror, remote });
  assert.equal(r.action, 'already-based');
  assert.equal(g(mirror, 'rev-parse', 'HEAD'), before);
  assert.equal(r.remoteSha, remoteHead);
});

test('③ 內容與遠端相同 ⇒ 對齊到遠端，不疊空 commit', () => {
  const { root, remote, remoteHead } = setup();
  const mirror = join(root, 'same');
  execFileSync('mkdir', [mirror]);
  repoWith(mirror, { 'README.md': 'v2' }, 'release: snapshot zzz');
  const r = alignMirrorWithRemote({ mirrorDir: mirror, remote });
  assert.equal(r.action, 'rebased');
  assert.equal(g(mirror, 'rev-parse', 'HEAD'), remoteHead);
});

test('④ 遠端還沒有 main ⇒ 照本機歷史推', () => {
  const root = mkdtempSync(join(tmpdir(), 'mirror-align-'));
  const remote = join(root, 'empty.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const mirror = join(root, 'm');
  execFileSync('mkdir', [mirror]);
  repoWith(mirror, { 'a': '1' }, 'release: snapshot first');
  const r = alignMirrorWithRemote({ mirrorDir: mirror, remote });
  assert.equal(r.action, 'empty-remote');
});

test('⑤ 網址帶帳密 ⇒ 拒絕', () => {
  assert.throws(() => alignMirrorWithRemote({ mirrorDir: tmpdir(), remote: 'https://u:tok@github.com/x/y.git' }), /匿名/);
});
