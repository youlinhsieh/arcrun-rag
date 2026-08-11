/**
 * source-pin.test.mjs — 證明「prod 只能出貨 stage 驗證過的那顆 commit」真的會斷
 * （取代 promoteFrom，D65 二次補述，arcrun-rag#73 缺③）。
 *
 * 跑法：node --test installer/scripts/source-pin.test.mjs
 * （零依賴、全程用臨時 git repo，不碰 matrix/arcrun 或任何真的 repo）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchTip, setBranchTip, checkSourcePin } from './source-pin.mjs';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'source-pin-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'c1']);
  return dir;
}

function commitOnTop(dir, msg) {
  writeFileSync(join(dir, `${Date.now()}-${Math.random()}.txt`), msg);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('🔴 分支還沒存在（還沒有任何目標驗證過任何東西）⇒ 拒絕，訊息講清楚要先做什麼', () => {
  const repo = tempRepo();
  try {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const r = checkSourcePin({ repo, branch: 'ship/verified-stage', currentSha: head });
    assert.equal(r.ok, false);
    assert.equal(r.tip, null);
    assert.match(r.message, /找不到釘子分支/);
    assert.match(r.message, /先跑.*--confirm/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('🔴 製造一次不一致：分支釘在舊 commit，本次來源已經往前移動 ⇒ 拒絕，不是印警告', () => {
  const repo = tempRepo();
  try {
    const oldSha = git(repo, ['rev-parse', 'HEAD']);
    setBranchTip(repo, 'ship/verified-stage', oldSha); // 模擬 stage 之前驗證過 oldSha
    const newSha = commitOnTop(repo, 'stage 之後又推進了一個沒驗證過的 commit');

    const r = checkSourcePin({ repo, branch: 'ship/verified-stage', currentSha: newSha });
    assert.equal(r.ok, false, 'HEAD 已經往前移動，但釘子還沒動——這必須被擋下');
    assert.equal(r.tip, oldSha);
    assert.match(r.message, /拒絕出貨/);
    assert.match(r.message, new RegExp(oldSha.slice(0, 7)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('✅ 釘子分支剛好指到這次要用的 commit ⇒ 放行', () => {
  const repo = tempRepo();
  try {
    const sha = commitOnTop(repo, 'stage 驗證過的內容');
    setBranchTip(repo, 'ship/verified-stage', sha);

    const r = checkSourcePin({ repo, branch: 'ship/verified-stage', currentSha: sha });
    assert.equal(r.ok, true);
    assert.equal(r.tip, sha);
    assert.match(r.message, /與來源相符/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('setBranchTip／branchTip 是一對——寫了讀得回來，且只在本機動（沒有 remote 可推）', () => {
  const repo = tempRepo();
  try {
    assert.equal(branchTip(repo, 'ship/verified-stage'), null, '一開始沒這個分支');
    const sha = git(repo, ['rev-parse', 'HEAD']);
    setBranchTip(repo, 'ship/verified-stage', sha);
    assert.equal(branchTip(repo, 'ship/verified-stage'), sha);

    // 分支可以移動（覆蓋，不是只能建一次）——模擬 stage 重跑 --confirm 驗過新內容。
    const sha2 = commitOnTop(repo, 'new content');
    setBranchTip(repo, 'ship/verified-stage', sha2);
    assert.equal(branchTip(repo, 'ship/verified-stage'), sha2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
