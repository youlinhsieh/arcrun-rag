/**
 * source-regression-gate.mjs — 「新一版的 Arcrun 來源不准比上一版舊」
 * （inkstone/arcrun-rag#271，來歷 #265 c21011）。
 *
 * 病：stage 1.4.106 用 Arcrun@9ab17d2 出貨，而 1.4.104／1.4.105 是 Arcrun@331ce35——
 * 9ab17d2 是 331ce35 的祖先，少了 26 筆已上 stage 的修正，22 站全過沒有一站擋。
 * 原因：來源靠人帶 ARCRUN_SOURCE_WORKTREE，帶錯了沒有東西比對「上一版是哪顆」。
 * 現有「成品比源碼舊」(artifact-freshness) 與釘子分支 (source-pin) 擋的都是別的方向。
 *
 * 判準：上一版（同目標 bundle repo 的 manifest.source）必須是這次來源的祖先或本身。
 * 純函式＋repo 路徑注入，可在臨時 git repo 演練。
 */
import { execFileSync } from 'node:child_process';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** "Arcrun@331ce352c43b" → "331ce352c43b"；格式不對回 null */
export function parseSource(source) {
  const m = /@([0-9a-f]{7,40})\s*$/i.exec(String(source || '').trim());
  return m ? m[1] : null;
}

/**
 * @returns {{ok:boolean, status:'first'|'same'|'descendant'|'rollback'|'unknown', missing?:number, message:string}}
 *  unknown＝上一版那顆在這個 repo 找不到（歷史被改寫／clone 不全）：無法比對，放行但明講。
 */
export function checkSourceNotOlder({ repo, previousSource, currentSha }) {
  const prev = parseSource(previousSource);
  const cur7 = currentSha.slice(0, 7);
  if (!prev) {
    return { ok: true, status: 'first', message: `上一版來源：（無紀錄，視為第一版）→ 不比對` };
  }
  let prevFull;
  try {
    prevFull = git(repo, ['rev-parse', '--verify', '-q', `${prev}^{commit}`]);
  } catch {
    return {
      ok: true, status: 'unknown',
      message: `⚠️ 上一版來源 Arcrun@${prev} 在 ${repo} 找不到這顆 commit，無法比對先後（歷史被改寫或 clone 不全？）——放行，請人工確認沒退版`,
    };
  }
  if (prevFull === currentSha) {
    return { ok: true, status: 'same', message: `來源未退版：與上一版同一顆（Arcrun@${cur7}）✓` };
  }
  let isAncestor = true;
  try { git(repo, ['merge-base', '--is-ancestor', prevFull, currentSha]); } catch { isAncestor = false; }
  if (isAncestor) {
    const ahead = git(repo, ['rev-list', '--count', `${prevFull}..${currentSha}`]);
    return { ok: true, status: 'descendant', message: `來源未退版：Arcrun@${cur7} 是上一版 ${prevFull.slice(0, 7)} 的後代（多 ${ahead} 筆）✓` };
  }
  const missing = Number(git(repo, ['rev-list', '--count', `${currentSha}..${prevFull}`]));
  return {
    ok: false, status: 'rollback', missing,
    message:
      `Arcrun 來源退版，拒絕出貨：這次 Arcrun@${cur7} 不是上一版來源 Arcrun@${prevFull.slice(0, 7)} 本身或其後代，\n` +
      `     少了 ${missing} 筆上一版已經包含的 commit（${cur7}..${prevFull.slice(0, 7)}）——出了等於把已修好的東西退回去。\n` +
      `     → 檢查 ARCRUN_SOURCE_WORKTREE／Arcrun repo 的 HEAD 是否帶錯；查缺哪些：git -C ${repo} log --oneline ${cur7}..${prevFull.slice(0, 7)}\n` +
      `     → 若真的要刻意回退，先在票上說明，並由總管處理（本閘不提供旁路）。`,
  };
}
