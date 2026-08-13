/**
 * daemon-dist.test.mjs — 證明「打包在 worktree A、出貨在 worktree B」不會再被誤判成
 * 「沒有新版可搬」（daemon-dist.mjs 檔頭有完整背景）。
 *
 * 跑法：node --test installer/scripts/daemon-dist.test.mjs
 * （零依賴、全程用臨時目錄，不碰任何真的 repo／worktree）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaemonDist } from './daemon-dist.mjs';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'daemon-dist-test-'));
}

function seedDist(root, distRel, files) {
  const dir = join(root, distRel);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), 'x');
}

test('✅ 自己的 worktree 就有齊全產物 ⇒ 用自己的，不必掃別的 worktree', () => {
  const self = makeDir();
  const other = makeDir();
  try {
    const distRel = join('collector', 'cmd', 'arcrun-app', 'dist');
    seedDist(self, distRel, ['Arcrun-v0.18.27.dmg', 'Arcrun-win-v0.18.27.exe']);

    const r = resolveDaemonDist({
      repoRoot: self, distRel,
      requiredFiles: ['Arcrun-v0.18.27.dmg', 'Arcrun-win-v0.18.27.exe'],
      worktrees: [self, other],
    });
    assert.equal(r.worktree, self);
    assert.equal(r.dir, join(self, distRel));
  } finally {
    rmSync(self, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('🔴→✅ 打包發生在別的 worktree（自己這裡沒有）⇒ 掃到別的 worktree 找到，並老實回報是哪一個', () => {
  const self = makeDir();
  const buildWorktree = makeDir();
  try {
    const distRel = join('collector', 'cmd', 'arcrun-app', 'dist');
    // self（出貨線執行的這個 worktree）完全沒有 dist——模擬 08-13 實撞：
    // v0.18.27 建置在 arcrun-rag-wt60ship，出貨線在另一個 checkout 執行。
    seedDist(buildWorktree, distRel, ['Arcrun-v0.18.27.dmg', 'Arcrun-win-v0.18.27.exe']);

    const r = resolveDaemonDist({
      repoRoot: self, distRel,
      requiredFiles: ['Arcrun-v0.18.27.dmg', 'Arcrun-win-v0.18.27.exe'],
      worktrees: [self, buildWorktree],
    });
    assert.equal(r.worktree, buildWorktree, '必須找到打包真正發生的那個 worktree');
    assert.equal(r.dir, join(buildWorktree, distRel));
    assert.deepEqual(r.tried, [join(self, distRel), join(buildWorktree, distRel)]);
  } finally {
    rmSync(self, { recursive: true, force: true });
    rmSync(buildWorktree, { recursive: true, force: true });
  }
});

test('❌ 每個 worktree 都缺檔（例如只打了 mac 沒打 win）⇒ 回報 dir=null，且 tried 列出全部試過的路徑', () => {
  const self = makeDir();
  const other = makeDir();
  try {
    const distRel = join('collector', 'cmd', 'arcrun-app', 'dist');
    seedDist(other, distRel, ['Arcrun-v0.18.27.dmg']); // 缺 win exe

    const r = resolveDaemonDist({
      repoRoot: self, distRel,
      requiredFiles: ['Arcrun-v0.18.27.dmg', 'Arcrun-win-v0.18.27.exe'],
      worktrees: [self, other],
    });
    assert.equal(r.dir, null);
    assert.equal(r.worktree, null);
    assert.equal(r.tried.length, 2);
  } finally {
    rmSync(self, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('listWorktrees：用真的 git repo 驗證 porcelain 輸出真的解析得出路徑（含自己）', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = makeDir();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'c1'], { cwd: repo });
    const { listWorktrees } = await import('./daemon-dist.mjs');
    const list = listWorktrees(repo);
    assert.ok(list.length >= 1);
    // git 回報的路徑在部分平台會是 realpath（例如 macOS /private/var vs /var）；
    // 只斷言「至少有一個 worktree 的路徑以 repo 的最後一段目錄名結尾」，不做全等比較。
    const base = repo.split('/').pop();
    assert.ok(list.some((p) => p.endsWith(base)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
