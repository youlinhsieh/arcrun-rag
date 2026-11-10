/**
 * source-regression-gate.test.mjs（inkstone/arcrun-rag#271）
 * 跑法：node --test installer/scripts/source-regression-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSourceNotOlder, parseSource } from './source-regression-gate.mjs';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function repoWith(n) {
  const dir = mkdtempSync(join(tmpdir(), 'src-regress-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const shas = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `c${i}`]);
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  }
  return { dir, shas };
}

test('parseSource 取出 sha、格式不對回 null', () => {
  assert.equal(parseSource('Arcrun@331ce352c43b'), '331ce352c43b');
  assert.equal(parseSource(''), null);
  assert.equal(parseSource(undefined), null);
});

test('🔴 來源比上一版舊（祖先）⇒ 擋，訊息列出少掉的 commit 數與上一版來源', () => {
  const { dir, shas } = repoWith(4);
  const r = checkSourceNotOlder({ repo: dir, previousSource: `Arcrun@${shas[3].slice(0, 12)}`, currentSha: shas[0] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rollback');
  assert.equal(r.missing, 3);
  assert.match(r.message, /少了 3 筆/);
  assert.match(r.message, new RegExp(shas[3].slice(0, 7)));
});

test('分岔（不是祖先也不是後代）⇒ 擋', () => {
  const { dir, shas } = repoWith(2);
  git(dir, ['checkout', '-q', '-b', 'side', shas[0]]);
  writeFileSync(join(dir, 'x.txt'), 'x');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'side']);
  const side = git(dir, ['rev-parse', 'HEAD']);
  const r = checkSourceNotOlder({ repo: dir, previousSource: `Arcrun@${shas[1].slice(0, 12)}`, currentSha: side });
  assert.equal(r.ok, false);
  assert.equal(r.missing, 1);
});

test('同一顆 ⇒ 過', () => {
  const { dir, shas } = repoWith(2);
  const r = checkSourceNotOlder({ repo: dir, previousSource: `Arcrun@${shas[1].slice(0, 12)}`, currentSha: shas[1] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'same');
});

test('後代 ⇒ 過，並講多幾筆', () => {
  const { dir, shas } = repoWith(4);
  const r = checkSourceNotOlder({ repo: dir, previousSource: `Arcrun@${shas[1].slice(0, 12)}`, currentSha: shas[3] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'descendant');
  assert.match(r.message, /多 2 筆/);
});

test('沒有上一版紀錄（第一版）⇒ 過', () => {
  const { dir, shas } = repoWith(1);
  assert.equal(checkSourceNotOlder({ repo: dir, previousSource: null, currentSha: shas[0] }).status, 'first');
});

test('上一版那顆在 repo 找不到 ⇒ 放行但明講無法比對', () => {
  const { dir, shas } = repoWith(1);
  const r = checkSourceNotOlder({ repo: dir, previousSource: 'Arcrun@deadbeefcafe', currentSha: shas[0] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'unknown');
  assert.match(r.message, /無法比對/);
});
