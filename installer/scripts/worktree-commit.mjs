// worktree-commit.mjs — 出貨結束時，這次出的東西就在版控裡（不靠人記得 commit）。
//
// inkstone/arcrun-rag#47：出貨完成的那一刻，repo 處於危險狀態——**已經部署出去了，
//   但版控裡沒有這次的釘子**。這個窗口有多長，取決於「有沒有人記得去 commit」；
//   而 repo 同時有三、四位 subagent 在跑，窗口期間任何人動到那兩個檔就出半套，
//   且半套不報錯（線上跑已部署的那份，版控裡是另一份，下一次出貨從錯的基準開始）。
//
// ⇒ 這支模組把「記得 commit」從人的責任變成管線的最後一站。ship.mjs 走完 --confirm
//   之後呼叫 commitShipOutputs()，它做三件事，對應本票的三條驗收：
//
//   ① 結束當下 `git status` 對「這次出的東西」是乾淨的——ship 自己寫的那幾個檔
//      （釘子 wrangler.toml／worker.js、release-state.json、ship-report.{json,md}、
//       各 gate-log.md）在同一次進版控。
//   ② 出貨過程中若有別人動到**釘子檔**（ship 寫完後被 git checkout／restore 蓋回去）
//      → 當場發現並停下，不默默 commit 半套。靠的是 stamps：pin 站寫完的那一刻
//      記下 sha256，這裡 commit 前再算一次，對不上就 throw。
//   ③ 稽核留痕（ship-report）也在同一個 commit 裡——掉了就是審計有洞。
//
// 🔴 這支**只在本機 commit，不 push**。推 main／推遠端仍受 main-push-guard.mjs 管，
//    與這裡無關（落帳到本機分支不是發佈）。ship.mjs 呼叫端已經在 --confirm 成功路徑上。
//
// 🔴 一律只 `git add <ship 自己寫的那幾個檔>`，**永遠不 `git add -A`**：別的 subagent
//    在 REPO_ROOT 別處的無關改動不是 ship 的，掃進來就是 08-07「整包蓋掉」的另一種。
//    偵測到別處也髒 → 列出來提醒，但不碰。

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// 預設的 git 執行器：成功回 stdout（trim），失敗把 stderr 帶進例外。測試可注入假的。
export function defaultRun(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\s+$/, '');
}

export function sha256OfFile(absPath, { readFile = readFileSync } = {}) {
  return createHash('sha256').update(readFile(absPath)).digest('hex');
}

// git status --porcelain -z ⇒ 這次工作區裡改動的相對路徑（含 untracked）。
// 用 -z 是因為檔名可能有空白／中文；rename 的兩段也拆開來看。
export function changedPaths(repoRoot, { run = defaultRun } = {}) {
  const out = run(['status', '--porcelain', '-z'], repoRoot);
  if (!out) return [];
  const rels = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // 每筆是 "XY <path>"；rename（R）會是 "R  old\0new"，new 段在下一個 token，
    // 但 -z 下 old 段沒有 XY 前綴，會在這個迴圈被當成沒有前綴的殘段跳過——
    // 我們只關心「現在磁碟上這個路徑髒不髒」，取有 XY 前綴那一段的路徑就夠。
    if (rec.length < 4) { rels.push(rec); continue; }
    rels.push(rec.slice(3));
  }
  return rels;
}

// 把改動分成「ship 自己的」與「別人的」。ownedRel 是相對 repoRoot 的路徑清單。
export function classifyChanges(changed, ownedRel) {
  const owned = new Set(ownedRel);
  const mine = [];
  const foreign = [];
  for (const rel of changed) {
    (owned.has(rel) ? mine : foreign).push(rel);
  }
  return { mine, foreign };
}

// 釘子防竄改：stamps = [{ rel, sha256 }]，是 pin 站寫完那一刻記下的。
// commit 前再算一次；對不上＝ship 寫完之後有別人動過這個檔 ⇒ 回報是哪個檔、期望 vs 現況。
export function detectTamper(repoRoot, stamps, { readFile = readFileSync, exists = existsSync } = {}) {
  const bad = [];
  for (const { rel, sha256 } of stamps || []) {
    const abs = join(repoRoot, rel);
    if (!exists(abs)) { bad.push({ rel, expected: sha256, actual: '(檔案不見了)' }); continue; }
    const now = sha256OfFile(abs, { readFile });
    if (now !== sha256) bad.push({ rel, expected: sha256, actual: now });
  }
  return bad;
}

function headIsDetached(repoRoot, run) {
  try {
    run(['symbolic-ref', '-q', 'HEAD'], repoRoot);
    return false;
  } catch {
    return true; // symbolic-ref -q 在 detached HEAD 時 exit 1
  }
}

/**
 * 把 ship 這次寫的檔案 commit 進 REPO_ROOT 的版控（只本機、不 push）。
 *
 * @param repoRoot   出貨 repo 根目錄（arcrun-rag）
 * @param ownedRel   ship 這一趟**可能**寫到的相對路徑清單（釘子檔／report／state／gate-log）
 * @param stamps     [{rel,sha256}] 釘子檔在 pin 站寫完那一刻的指紋，用來擋竄改
 * @param message    commit 訊息
 * @param run/fs     可注入，給測試用
 * @returns {status:'done'|'skip', detail:[], committed:[], foreign:[], ref, sha}
 */
export function commitShipOutputs({
  repoRoot, ownedRel, stamps = [], message,
  run = defaultRun, readFile = readFileSync, exists = existsSync,
  branchPrefix = 'ship-worktree',
} = {}) {
  // ① 先擋竄改——在動任何 git 之前。ship 寫完釘子後若被別人 checkout 蓋回去，這裡當場停。
  const tampered = detectTamper(repoRoot, stamps, { readFile, exists });
  if (tampered.length) {
    throw new Error(
      '出貨要落帳時發現釘子檔在 ship 寫完之後被動過（有人 checkout／restore？）——拒絕 commit 半套：\n' +
      tampered.map((t) => `       - ${t.rel}\n         ship 寫的是 ${String(t.expected).slice(0, 12)}…，現在磁碟上是 ${String(t.actual).slice(0, 12)}…`).join('\n') +
      '\n     ⇒ 這正是 #47 記載的事故：釘子只活在檔案裡、還沒進版控就被蓋掉一半。\n' +
      '       先確認線上實際跑的是哪顆釘子，把磁碟改回那份，再重跑出貨落帳。');
  }

  const changed = changedPaths(repoRoot, { run });
  const { mine, foreign } = classifyChanges(changed, ownedRel);

  if (!mine.length) {
    const detail = ['這次沒有要落帳的產物（釘子沒動、report 沒變）——版控已經是這一版'];
    if (foreign.length) detail.push(foreignNote(foreign));
    return { status: 'skip', detail, committed: [], foreign, ref: null, sha: null };
  }

  // ② 只加 ship 自己的——絕不 -A。別人的無關改動原封不動留在工作區。
  run(['add', '--', ...mine], repoRoot);
  run(['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m', message], repoRoot);
  const sha = run(['rev-parse', 'HEAD'], repoRoot);

  const detail = [`落帳 ${sha.slice(0, 7)}：${mine.length} 個檔進版控（${mine.join('、')}）`];

  // ③ detached HEAD（出貨常在 products/arcrun-rag-shipprod 這種 worktree 裡，HEAD 游離）
  //    ⇒ commit 只被 HEAD 指著，別人 checkout 一下就沒了、還不會有警告（#47 comment 的第 1 點）。
  //    釘一個分支到它身上，這顆 commit 就再也不會被 gc／checkout 弄丟。
  let ref = null;
  if (headIsDetached(repoRoot, run)) {
    // 用短 sha ＋ 時間戳命名，每次落帳各釘一根、不互相覆蓋
    ref = `${branchPrefix}-${sha.slice(0, 7)}-${Date.now()}`;
    run(['branch', '-f', ref, 'HEAD'], repoRoot);
    detail.push(`⚠️ HEAD 是游離的（不在任何分支上）⇒ 已釘分支 \`${ref}\` → ${sha.slice(0, 7)}，這顆 commit 不會再被弄丟`);
  }

  if (foreign.length) detail.push(foreignNote(foreign));
  return { status: 'done', detail, committed: mine, foreign, ref, sha };
}

function foreignNote(foreign) {
  return `⚠️ REPO_ROOT 還有 ${foreign.length} 個**別人的**改動沒進這個 commit（ship 不碰、原樣留著）：`
    + foreign.slice(0, 8).map((f) => `\n         - ${f}`).join('')
    + (foreign.length > 8 ? `\n         …（還有 ${foreign.length - 8} 個）` : '');
}
