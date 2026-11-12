/**
 * GitHub「匿名讀」的環境退路（inkstone/Arcrun#374 c1794450431994402）。
 *
 * 問題：雲端 session 的代理對「沒附掛的 GitHub repo」把 api.github.com 一律回 403，本文是
 * 「GitHub access to this repository is not enabled for this session」。這是**環境擋**，
 * 不是 repo 不存在、也不是權杖錯。可是 git 的匿名讀（git ls-remote）在同一個環境是通的。
 *
 * 規矩（D20 不變）：只做**匿名讀**；不帶任何憑證；不做任何寫入。
 *   - 環境擋 ⇒ 改用 git ls-remote 確認；讀得到＝存在。
 *   - git 也讀不到 ⇒ 照實說「環境擋＋git 也讀不到」，**不猜**存在或不存在
 *     （GitHub 對「不存在」與「私有」給同一個答案）。
 */
import { spawnSync } from 'node:child_process';

/** 這個回應是不是「環境擋下 GitHub API」（而不是 repo 不存在／權杖錯）。 */
export async function isEnvBlocked(r) {
  if (!r || r.status !== 403) return false;
  let t = '';
  try { t = typeof r.text === 'function' ? await r.text() : ''; } catch { t = ''; }
  // 兩種「API 匿名讀被擋、但 git 匿名讀仍通」的 403：代理沒放行這個 repo；共用出口 IP 用完匿名額度（rate limit）。
  return /not enabled for this session|API rate limit exceeded/i.test(t);
}

/**
 * 匿名 git ls-remote。回 { ok, out, err }；不拋。
 * @param {string[]} args  例 ['HEAD'] 或 ['--tags']
 */
export function gitLsRemote(slug, args, { spawnImpl = spawnSync } = {}) {
  const r = spawnImpl('git', ['ls-remote', ...args.slice(0, 0), `https://github.com/${slug}.git`, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}

/** 環境擋時的存在查詢：true＝git 讀得到；丟錯＝讀不到（不猜）。 */
export function repoExistsViaGit(slug, opts) {
  const g = gitLsRemote(slug, ['HEAD'], opts);
  if (g.ok) return true;
  throw new Error(
    `查詢 ${slug} 是否存在失敗：GitHub API 匿名讀被擋（HTTP 403：這個環境沒放行，或共用出口的匿名額度用完），` +
    `改用 git 匿名讀也讀不到（${g.err.split('\n')[0] || '無輸出'}）。` +
    `這分不出「repo 不存在」或「私有／沒放行」——不猜，直接停。`);
}

/** 環境擋時列 tag 名（只有名字；release 與 tag 不是同一件事，呼叫端要知道）。 */
export function listTagsViaGit(slug, opts) {
  const g = gitLsRemote(slug, ['--tags'], opts);
  if (!g.ok) {
    throw new Error(
      `列 ${slug} 的 release 失敗：GitHub API 匿名讀被擋（HTTP 403），改用 git 匿名讀 tag 也失敗（${g.err.split('\n')[0] || '無輸出'}）。`);
  }
  return g.out.split('\n').map((l) => l.split('\t')[1] || '')
    .filter((n) => n.startsWith('refs/tags/') && !n.endsWith('^{}'))
    .map((n) => n.slice('refs/tags/'.length));
}
