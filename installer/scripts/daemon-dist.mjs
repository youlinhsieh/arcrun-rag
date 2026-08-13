/**
 * daemon-dist.mjs — 找出 daemon（Mac／Win 桌面 App）打包產物實際落在哪個 worktree。
 *
 * ── 為什麼要有這支（2026-08-13，arcrun-rag#60 出貨補完）───────────────────────
 * `collector/cmd/arcrun-app/dist/` 是 gitignored 的本機建置產物——這是對的，二進位
 * 檔不該進 git。但副作用是：每個 `git worktree` 各自有一份**互不共用**的 dist/。
 * `ship.mjs` 的 `daemon-sync` 站原本只看「自己所在的那個 worktree」的 dist/
 * （`REPO_ROOT` 由腳本自己的路徑推得），這在「打包與出貨永遠在同一個 worktree」的
 * 前提下沒問題——但本 repo 的常規做法是**每個修法開一個獨立 worktree**（紅線也要求
 * 「用你自己的 worktree」），一旦打包發生在 worktree A、出貨在 worktree B 執行，
 * B 永遠找不到 A 打好的檔案，`daemon-sync` 會誤判成「沒有新版可搬」而安靜跳過。
 *
 * 實錄：daemon v0.18.27（#60 兩個修法 f71e5a2／578ac2b）建置在
 * `arcrun-rag-wt60ship`，出貨線在另一個 checkout 執行 ⇒ 印「bundle 已是 changelog
 * 最新已發佈版：v0.18.26」——changelog 已經宣告 v0.18.27，使用者卻拿不到它。
 *
 * ── 解法 ─────────────────────────────────────────────────────────────────
 * 用 git 本來就有的中繼資料（`git worktree list`）列出這個 repo 的所有 worktree，
 * 依序找「wanted 的必要檔案是否齊全」，找到第一個齊全的就用——不是新發明一個共用
 * 目錄（那又是「兩套機制並存必然漂移」的同一種病），而是讓既有機制認得住既有現實。
 *
 * 找到的來源**一定要在回傳值與呼叫端的輸出裡講清楚**（`worktree` 欄位、呼叫端印
 * 出來）——不能悄悄跨 worktree 拿檔案卻不留痕，那樣出了問題沒人查得出東西從哪來。
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** 列出這個 repo 所有 git worktree 的絕對路徑（含自己），依 `git worktree list` 回報的順序。 */
export function listWorktrees(repoRoot) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const paths = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}

/**
 * 找出 `distRel`（例如 `collector/cmd/arcrun-app/dist`）底下 `requiredFiles` 全部
 * 到齊的第一個 worktree。永遠先查 `repoRoot` 自己，沒有才掃其他 worktree
 * （`git worktree list` 回報的順序，通常就是建立時間序）。
 *
 * @param {object} opts
 * @param {string} opts.repoRoot 目前執行 ship.mjs 的這個 worktree 根目錄
 * @param {string} opts.distRel dist 目錄相對路徑（跨 repoRoot／其他 worktree 通用）
 * @param {string[]} opts.requiredFiles 必要檔名（不含目錄），例如 `Arcrun-v0.18.27.dmg`
 * @param {string[]|null} [opts.worktrees] 測試用注入點；不給就真的呼叫 `git worktree list`
 * @returns {{ dir: string|null, worktree: string|null, tried: string[] }}
 *   `dir`＝找到的 dist 目錄絕對路徑（沒找到是 null）；
 *   `worktree`＝該目錄所屬的 worktree 根目錄；
 *   `tried`＝依序試過的所有 dist 目錄（找不到時用來組錯誤訊息）。
 */
export function resolveDaemonDist({ repoRoot, distRel, requiredFiles, worktrees = null }) {
  const list = worktrees || [repoRoot, ...listWorktrees(repoRoot).filter((w) => w !== repoRoot)];
  const tried = [];
  for (const wt of list) {
    const dir = join(wt, distRel);
    tried.push(dir);
    if (!existsSync(dir)) continue;
    const missing = requiredFiles.filter((f) => !existsSync(join(dir, f)));
    if (missing.length === 0) return { dir, worktree: wt, tried };
  }
  return { dir: null, worktree: null, tried };
}
