/**
 * bundle-sync.mjs — 出貨前先把本機 bundle repo 的 clone 追到遠端（inkstone/arcrun-rag#363 第 2 處）
 *
 * 病（1.4.247 實撞）：prod 的本機 clone（~/.arcrun-ship/bundles-prod）落後 GitHub 36 筆，
 * 出貨線的 commit 長在舊底上，到 push 站才被 non-fast-forward 擋下——停在中段、要人手動收拾。
 *
 * 做法：preflight 先 fetch，再依祖先關係分三種，**一律只 fast-forward，不 reset、不 force**：
 *   · 已是最新／只有本機領先 → 不動
 *   · 只有落後               → `merge --ff-only`（丟不掉任何東西）
 *   · 兩邊都有自己的 commit   → 擋下並講清楚（自動處理會是改寫歷史，那是人的決定）
 * fetch 本身失敗（離線、代理）不擋：回 fetched:false 由呼叫端警告；推不推得動另有 push 權探測。
 *
 * git 注入（run）可在臨時 repo 演練（見 bundle-sync.test.mjs）。
 */
import { execFileSync } from 'node:child_process';

const defaultRun = (dir, args, timeout = 180_000) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();

/**
 * @param {{dir:string, branch:string, run?:(dir:string,args:string[])=>string}} o
 * @returns {{status:'current'|'ahead'|'fast-forwarded'|'fetch-failed', behind:number, ahead:number, message:string}}
 * @throws 兩邊分叉、或 ff 失敗
 */
export function syncBundleClone({ dir, branch, run = defaultRun }) {
  try {
    run(dir, ['fetch', '-q', 'origin', branch]);
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).trim().split('\n')[0].slice(0, 200);
    return { status: 'fetch-failed', behind: 0, ahead: 0, message: `⚠️ 抓不到遠端 ${branch}（${why}）——沒法先追上遠端，push 站若被 non-fast-forward 擋下就是這個原因` };
  }
  const remote = `origin/${branch}`;
  const [aheadS, behindS] = run(dir, ['rev-list', '--left-right', '--count', `HEAD...${remote}`]).split(/\s+/);
  const ahead = Number(aheadS); const behind = Number(behindS);
  if (behind === 0) {
    return { status: ahead ? 'ahead' : 'current', behind, ahead, message: ahead ? `bundle clone 領先遠端 ${ahead} 筆（尚未推出，正常）` : 'bundle clone 與遠端同步' };
  }
  if (ahead > 0) {
    throw new Error(
      `bundle clone（${dir}）和遠端 ${remote} 分叉了：本機有 ${ahead} 筆沒推出的 commit，遠端有 ${behind} 筆本機沒有。\n` +
      `     出貨線不自動處理（要 rebase 或 reset 都是改寫歷史，由人決定）。\n` +
      `     → 看本機那 ${ahead} 筆：git -C ${dir} log ${remote}..HEAD；不要的就丟掉那個 clone 重 clone，要的就 rebase 後再出貨。`);
  }
  try {
    run(dir, ['merge', '--ff-only', '-q', remote]);
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).trim().slice(0, 300);
    throw new Error(`bundle clone 落後遠端 ${behind} 筆，但 fast-forward 失敗：${why}\n     → 通常是工作區有未提交的改動壓在要更新的檔上；先處理那些改動再出貨。`);
  }
  return { status: 'fast-forwarded', behind, ahead: 0, message: `bundle clone 落後遠端 ${behind} 筆 → 已 fast-forward 到 ${remote}` };
}
