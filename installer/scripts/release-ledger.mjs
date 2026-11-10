/**
 * release-ledger.mjs — 「每一版當初是用哪一份內容出的」進版控的帳（inkstone/arcrun-rag#302）
 *
 * ── 為什麼有這支 ───────────────────────────────────────────────────────────
 * leo 在 AHub 簽的是一個**版號**（例 1.4.145）。但 prod 原本只認 `ship/verified-stage` 這個本機 git 分支：
 * 它永遠指著「最近一次出 stage 的那顆 Arcrun commit」，而版號又是拿內容指紋算的。
 * 結果：leo 簽了 1.4.145，只要任何一條線再從 main 出一版 stage，釘子與版號就移走，
 * 1.4.145 的 prod 對不上簽核而被擋——不會出錯版，但 leo 白簽、要重簽。
 *
 * 這一本帳把「版號 → Arcrun commit → 內容指紋」記下來，**住在 git 裡**（不是出貨那台機器的本機分支）：
 *   · 每次真的出貨成功，出貨線在落帳那一趟同時把這一版記進來（release-state.json 的同一個 commit）。
 *   · 出 prod 時帶 `--ship-version <被簽的版號>`：來源 commit 取自這本帳，不取自「stage 最近一次」。
 *   · 重打之後，版號與內容指紋都要對上帳上那一筆，對不上就擋（不出錯版）。
 *
 * 守的邊界：只在出貨成功時寫、只在出 prod 時讀；不輪詢、不排程、不碰 GitHub、不碰遠端。
 * 純函式＋路徑注入，可在臨時 git repo 演練（見 release-ledger.test.mjs）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEDGER_FILE = join('installer', 'release-ledger.json');

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

/** 讀帳；不存在或壞掉＝空帳（不丟例外：第一次出貨前的正常狀態）。 */
export function readLedger(repoRoot) {
  const p = join(repoRoot, LEDGER_FILE);
  if (!existsSync(p)) return { releases: {} };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' && j.releases && typeof j.releases === 'object' ? j : { releases: {} };
  } catch { return { releases: {} }; }
}

/**
 * 把一次成功的出貨記進帳。冪等：同一版再記只補上「這個目標的出貨時間」，commit／指紋以**第一次**為準
 * （prod 重打同一份內容時，不能讓 prod 的紀錄改寫 stage 當初的）。
 * 同一個版號卻帶著不同的內容指紋＝版號被重用或帳被竄改，不寫、回 conflict 讓呼叫端吵。
 * @returns {{ ok:boolean, changed:boolean, conflict?:string, ledger:object }}
 */
export function recordShipment(repoRoot, { release, fingerprint, commit, built = '', target, at = new Date().toISOString() }) {
  const ledger = readLedger(repoRoot);
  const prev = ledger.releases[release];
  if (prev && prev.fingerprint && fingerprint && prev.fingerprint !== fingerprint) {
    return {
      ok: false, changed: false, ledger,
      conflict: `帳上 ${release} 的內容指紋是 ${prev.fingerprint.slice(0, 12)}…，這次是 ${fingerprint.slice(0, 12)}…——同一個版號出現兩份不同的內容`,
    };
  }
  const entry = prev ? { ...prev } : { commit, fingerprint, built, shipped: {} };
  entry.shipped = { ...(entry.shipped || {}) };
  const had = Boolean(entry.shipped[target]);
  if (!had) entry.shipped[target] = at;
  ledger.releases = { ...ledger.releases, [release]: entry };
  const changed = !prev || !had;
  if (changed) {
    const p = join(repoRoot, LEDGER_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(ledger, null, 1) + '\n');
  }
  return { ok: true, changed, ledger };
}

/** 從帳上找「被簽的版號」。找不到／沒在 stage 出過都擋，訊息講清楚下一步。 */
export function resolveSignedVersion({ ledger, version }) {
  const known = Object.keys(ledger.releases || {});
  const entry = ledger.releases && ledger.releases[version];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, entry: null, message: `--ship-version 要填被簽核的引擎版號（例 1.4.145），現在是 ${JSON.stringify(version || '')}` };
  }
  if (!entry) {
    return {
      ok: false, entry: null,
      message:
        `出貨紀錄裡找不到 ${version} 當初上 stage 的內容（installer/release-ledger.json 只有：${known.length ? known.join('、') : '（空）'}）。\n` +
        `     被簽的是 ${version}，但這台機器不知道它對應哪一顆 Arcrun commit，**不能猜**（猜錯就是出了沒被簽的內容）。\n` +
        `     → 先 git pull 把最新的出貨紀錄拿下來（出貨線每趟落帳都會寫這本帳）；\n` +
        `     → 仍沒有：這一版是在這本帳出現之前出的，或從沒真的上過 stage——請重出 stage 並對新版號重請簽核。`,
    };
  }
  if (!entry.shipped || !entry.shipped.stage) {
    return {
      ok: false, entry,
      message: `${version} 在出貨紀錄裡沒有「上過 stage」的留痕（只有：${Object.keys(entry.shipped || {}).join('、') || '無'}）——prod 只准出 stage 驗過的內容。`,
    };
  }
  if (!entry.commit || !entry.fingerprint) {
    return { ok: false, entry, message: `出貨紀錄裡 ${version} 缺 commit 或內容指紋，不能拿來核對，拒絕出 prod。` };
  }
  return { ok: true, entry, message: `被簽的 ${version}＝stage 當初出的 Arcrun@${entry.commit.slice(0, 12)}（內容指紋 ${entry.fingerprint.slice(0, 12)}…）` };
}

/**
 * 把來源 repo 備好在那顆 commit 上：已經在就直接用；不然開一個 detached worktree（不動別人的工作區）。
 * commit 本機沒有就先 fetch 一次；仍沒有＝當初的內容找不到，回人話。
 * @returns {{ ok:boolean, repo?:string, sha?:string, message:string }}
 */
export function ensureSourceAt({ repo, commit, worktreeDir }) {
  let full = tryGit(repo, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]);
  if (!full) {
    tryGit(repo, ['fetch', '-q', 'origin']);
    full = tryGit(repo, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]);
  }
  if (!full) {
    return {
      ok: false,
      message:
        `Arcrun repo（${repo}）裡找不到 ${commit.slice(0, 12)}——那是被簽的版本當初上 stage 的內容，fetch 之後仍沒有\n` +
        `     （多半是那條分支被 force-push 蓋掉、或 repo 換了位置）。\n` +
        `     → 請把那顆 commit 補回來（任何有它的 clone 推一個分支即可），再重跑；\n` +
        `     → 補不回來：這一版內容已經失傳，不能出 prod——請重出 stage 並對新版號重請簽核。`,
    };
  }
  if (tryGit(repo, ['rev-parse', 'HEAD']) === full) return { ok: true, repo, sha: full, message: `來源 repo 本來就在 ${full.slice(0, 12)}` };
  if (existsSync(worktreeDir)) {
    if (tryGit(worktreeDir, ['rev-parse', 'HEAD']) === full) return { ok: true, repo: worktreeDir, sha: full, message: `沿用既有 worktree ${worktreeDir}（已在 ${full.slice(0, 12)}）` };
    return { ok: false, message: `${worktreeDir} 已存在但不在 ${full.slice(0, 12)}——請移除它（git worktree remove --force）再重跑，不擅自覆蓋` };
  }
  try {
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(repo, ['worktree', 'add', '--detach', worktreeDir, full]);
  } catch (e) {
    return { ok: false, message: `開 worktree 失敗（${worktreeDir} @ ${full.slice(0, 12)}）：${String(e.stderr || e.message).trim().slice(0, 300)}` };
  }
  return { ok: true, repo: worktreeDir, sha: full, message: `已為被簽的內容開 worktree：${worktreeDir}（Arcrun@${full.slice(0, 12)}，不動原工作區）` };
}

/** 重打之後核對：版號與內容指紋要和帳上那一筆一致（不一致＝重打出來的不是被簽的那份）。 */
export function checkSignedBuild({ version, entry, builtRelease, builtFingerprint }) {
  if (builtRelease === version && builtFingerprint === entry.fingerprint) {
    return { ok: true, message: `重打結果＝被簽的 ${version}（內容指紋一致）` };
  }
  return {
    ok: false,
    message:
      `重打出來的不是被簽的那一版：\n` +
      `       被簽：${version}｜內容指紋 ${entry.fingerprint.slice(0, 12)}…（Arcrun@${entry.commit.slice(0, 12)}）\n` +
      `       重打：${builtRelease || '？'}｜內容指紋 ${String(builtFingerprint || '？').slice(0, 12)}…\n` +
      `     出貨線不會在這種情況下繼續（不出沒被簽的內容）。常見原因：打包時的依賴／環境和當初 stage 那次不同、\n` +
      `     或 installer 端的酬載（workflows／skills）和當初不是同一份。→ 對照 ${version} 當初的出貨報告；\n` +
      `     找不到原因就重出 stage 並對新版號重請簽核。`,
  };
}
