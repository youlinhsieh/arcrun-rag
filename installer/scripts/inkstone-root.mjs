/**
 * inkstone-root.mjs — 出貨線找「InkStoneCo 頂層」在哪（GitHub 接觸留痕 github-contact-log.md 的家）
 *
 * ── 為什麼（inkstone/arcrun-rag#298，2026-11-09）────────────────────────────────
 * 舊寫法 `resolve(REPO_ROOT, '..', '..')` 只在「arcrun-rag 住在 InkStoneCo/products/arcrun-rag」
 * 時成立。雲端出貨的工作樹是 `<rag>/.worktrees/<名>`，往上兩層＝`<rag>` 自己，
 * 那裡沒有 `system-dev/docs/3-specs/autonomy-dispatch/` ⇒ 兩次 GitHub push 都成功，
 * 但留痕寫入 ENOENT（1.4.141 prod 出貨實撞）：**寫入已發生、稽核留不下來**。
 *
 * 判準：哪個目錄底下真的有 `system-dev/docs/3-specs/autonomy-dispatch/`，哪個就是頂層。
 *   ① 環境變數 INKSTONE_ROOT（明講，贏）
 *   ② 從工作樹往上找（含 git worktree 的主工作目錄往上找）
 *   ③ 雲端 session 的固定落點 ~/inkstoneco/InkStoneCo、/home/user/inkstoneco/InkStoneCo
 *   ④ 都沒有 ⇒ 退回舊算法（往上兩層）；留痕那端會自己建目錄，不再 ENOENT
 */
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const MARKER = join('system-dev', 'docs', '3-specs', 'autonomy-dispatch');

export const hasMarker = (dir) => existsSync(join(dir, MARKER));

function ancestors(start) {
  const out = [];
  let cur = resolve(start);
  for (let i = 0; i < 12; i++) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/** git worktree 的「主工作目錄」（`--git-common-dir` 的上一層）；不是 git 或失敗就回 null。 */
function mainCheckout(repoRoot) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return common ? dirname(common) : null;
  } catch { return null; }
}

/**
 * @param {string} repoRoot  arcrun-rag 工作樹根
 * @param {{env?: Record<string,string|undefined>, home?: string, mainCheckoutOf?: (r:string)=>string|null, fixed?: string[]}} [o]
 * @returns {{ root: string, source: string }}
 */
export function resolveInkstoneRoot(repoRoot, { env = process.env, home = homedir(), mainCheckoutOf = mainCheckout, fixed = ['/home/user/inkstoneco/InkStoneCo'] } = {}) {
  if (env.INKSTONE_ROOT) return { root: resolve(env.INKSTONE_ROOT), source: 'env INKSTONE_ROOT' };
  const starts = [repoRoot, mainCheckoutOf(repoRoot)].filter(Boolean);
  for (const s of starts) {
    for (const d of ancestors(s)) if (hasMarker(d)) return { root: d, source: `往上找（從 ${s}）` };
  }
  for (const d of [join(home, 'inkstoneco', 'InkStoneCo'), ...fixed]) {
    if (hasMarker(d)) return { root: d, source: '雲端固定落點' };
  }
  return { root: resolve(repoRoot, '..', '..'), source: '舊算法（往上兩層；找不到任何有 autonomy-dispatch/ 的頂層）' };
}
