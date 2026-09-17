/**
 * mirror-align.mjs — 推 GitHub 公開鏡像之前，讓本機鏡像**接在遠端 main 後面**。
 *
 * 🔴 由來（inkstone/arcrun-rag#202 c7599，2026-09-17 prod 出貨第 21 站）：
 *   `git push … HEAD:main` 被拒：`[rejected] (fetch first)`。
 *   實查（匿名 clone）：GitHub `youlinhsieh/arcrun-rag` main 有 121 個 commit，
 *   最後一筆 `f487e55 release: snapshot 0bc7b08 (2026-09-14)`——**全是先前出貨推上去的快照**，
 *   沒有任何外來改動。而出貨用的 worktree（`products/arcrun-rag-ship0917`）裡的
 *   `.github-public/` 只有 4 個 commit、最早一筆是 09-17 07:39——
 *   `scripts/publish-github.sh` 找不到 `.github-public/.git` 就 `git init` 一個**全新歷史**。
 *
 *   ⇒ 病不是「GitHub 上有人改了東西」，是**在新的 worktree 出貨，鏡像的歷史從零開始**，
 *     跟遠端完全不相干，push 當然被拒。換一個 worktree 出貨就會再撞一次。
 *
 * ⇒ 修法：push 之前匿名讀一次遠端 main（D20：讀＝匿名、不帶憑證、不需要保險），
 *   本機 HEAD 不包含它的話，把本機的快照**改接到遠端 main 上面、壓成一筆**
 *   （`reset --soft` ＋ commit——tree 就是這一版的公開樹，歷史是遠端的歷史）。
 *   公開鏡像的模型本來就是「每次發版一個 release commit」（publish-github.sh 檔頭，D22），
 *   所以壓成一筆不是妥協，是那個模型本身。
 *
 * 🔴 **不 force push、不自己 merge**：接上去之後推出去一定是 fast-forward；
 *   做完還會用 `merge-base --is-ancestor` 驗證一次，不成立就丟，不送出去。
 */
import { spawnSync } from 'node:child_process';

/** 匿名 git：清掉 credential helper、不准跳互動提示——讀不到就是讀不到，不偷偷實名。 */
function anonGit(args, cwd) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' },
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function git(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 失敗（exit ${r.status}）：${(r.stderr || '').trim().split('\n').slice(-3).join(' ／ ')}`);
  }
  return { status: r.status, out: (r.stdout || '').trim() };
}

/**
 * @param {object} o
 * @param {string} o.mirrorDir   本機鏡像（.github-public/）
 * @param {string} o.remote      遠端網址（**不帶帳密**；帶了就拒絕——這一步是匿名讀）
 * @param {string} [o.branch]    預設 main
 * @returns {{ action: 'empty-remote'|'already-based'|'rebased', remoteSha: string|null, headSha: string, note: string }}
 */
export function alignMirrorWithRemote({ mirrorDir, remote, branch = 'main' }) {
  if (/\/\/[^/@\s]+@/.test(String(remote))) {
    throw new Error('alignMirrorWithRemote 只做匿名讀：remote 網址不准帶帳密（D20：讀＝匿名）。');
  }
  const ls = anonGit(['ls-remote', remote, `refs/heads/${branch}`], mirrorDir);
  if (ls.status !== 0) {
    throw new Error(`匿名讀不到 ${remote} 的 ${branch}（exit ${ls.status}）：${ls.err.split('\n').slice(-2).join(' ／ ')}\n` +
      `     不知道遠端長什麼樣就不推——推下去不是被拒，就是蓋掉別人的東西。`);
  }
  const remoteSha = (ls.out.split(/\s+/)[0] || '').trim() || null;
  const headBefore = git(['rev-parse', 'HEAD'], mirrorDir).out;
  if (!remoteSha) {
    return { action: 'empty-remote', remoteSha: null, headSha: headBefore, note: `遠端還沒有 ${branch}，照本機歷史推` };
  }

  const f = anonGit(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`], mirrorDir);
  if (f.status !== 0) {
    throw new Error(`匿名 fetch ${remote} ${branch} 失敗（exit ${f.status}）：${f.err.split('\n').slice(-2).join(' ／ ')}`);
  }
  const fetched = git(['rev-parse', 'FETCH_HEAD'], mirrorDir).out;
  if (fetched !== remoteSha) {
    throw new Error(`fetch 到的 ${fetched.slice(0, 7)} 跟 ls-remote 的 ${remoteSha.slice(0, 7)} 不同——遠端正在變動，不推。`);
  }

  if (git(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], mirrorDir, { allowFail: true }).status === 0) {
    return { action: 'already-based', remoteSha, headSha: headBefore, note: `本機鏡像已接在遠端 ${remoteSha.slice(0, 7)} 後面` };
  }

  // 本機的快照改接到遠端 main 上面：tree 用本機這一版，歷史用遠端的。
  const localCount = git(['rev-list', '--count', 'HEAD'], mirrorDir).out;
  const message = git(['log', '-1', '--format=%B'], mirrorDir).out || 'release: snapshot';
  const author = git(['log', '-1', '--format=%an%x00%ae'], mirrorDir).out.split('\0');
  git(['reset', '--soft', remoteSha], mirrorDir);
  const same = git(['diff', '--cached', '--quiet'], mirrorDir, { allowFail: true }).status === 0;
  if (!same) {
    git(['-c', `user.name=${author[0] || 'Arcrun Release'}`, '-c', `user.email=${author[1] || 'release@arcrun.dev'}`,
      'commit', '-q', '-m', message], mirrorDir);
  }
  const headSha = git(['rev-parse', 'HEAD'], mirrorDir).out;
  if (git(['merge-base', '--is-ancestor', remoteSha, headSha], mirrorDir, { allowFail: true }).status !== 0) {
    throw new Error(`改接之後 ${headSha.slice(0, 7)} 仍不包含遠端 ${remoteSha.slice(0, 7)}——不推。`);
  }
  return {
    action: 'rebased', remoteSha, headSha,
    note: same
      ? `本機鏡像（${localCount} 個 commit、歷史與遠端不相干）內容與遠端 ${remoteSha.slice(0, 7)} 相同 ⇒ 直接對齊，不多疊 commit`
      : `本機鏡像（${localCount} 個 commit、歷史與遠端不相干）改接到遠端 ${remoteSha.slice(0, 7)} 後面，壓成一筆 ${headSha.slice(0, 7)}`,
  };
}
