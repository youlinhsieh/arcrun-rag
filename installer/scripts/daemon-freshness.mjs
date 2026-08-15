/**
 * daemon-freshness.mjs — 「**changelog 宣告的版本，源碼是不是還算數**」就當場停下，
 * 並指名是哪幾顆 commit（同 `artifact-freshness.mjs` 的形狀，Leo/Arcrun#93 的另一半）。
 *
 * ── 為什麼有這支（2026-08-15 夜間，三顆 collector/ 的改動）───────────────────
 *
 * `daemon-sync`／`daemon-check` 這兩站比的是 **bundle vs changelog**：
 *   bundle 裡的 `manifest.daemon.version` 是不是等於 changelog 最上面那個
 *   `## vX.Y.Z（日期）` 已發佈段。兩邊一致就放行。
 *
 * 那天 e7c715f／d4d79f1／91f6171 三顆 commit 全動了 `collector/`（daemon 的原始碼），
 * changelog 最上面已發佈段卻還是 08-13 打包時戳的 `v0.18.27`——**沒有人把新版戳出來、
 * 也沒有人重打包**。而 `daemon-sync`／`daemon-check` 兩邊比對的兩個值
 * （bundle.daemon.version、changelog 頂端已發佈版號）從頭到尾都沒被要求跟「源碼現況」
 * 對過帳，於是這兩邊**同時落後於現實，永遠對得上**——出貨管線印「已是最新」，
 * 使用者按「檢查更新」拿到的還是 08-13 那顆執行檔。
 *
 * ── 本檔補的是哪一段 ─────────────────────────────────────────────────────
 *
 *     daemon-check 比的是   bundle          vs  changelog
 *     本檔比的是            changelog(頂端) vs  collector/ 原始碼現況
 *
 * 兩段合起來才是一條完整的鏈：源碼 → changelog → bundle。少了本檔那一段，
 * 「changelog 忘了寫」這件事永遠不會被任何機制看見（正是那天真正發生的事——
 * `system-dev/wiki/status.md` 08-15 那筆其實已經手動補了「下一版（未發佈）」草稿，
 * 但草稿**不算已發佈**——daemon-check 的 `RELEASED_RE` 刻意忽略草稿，這是對的，
 * 見該檔檔頭：草稿只代表「先寫、還沒打包」；本檔要抓的是「已發佈的那個版號，
 * 源碼是不是還配得上它」，跟有沒有草稿無關）。
 *
 * ── 怎麼比：changelog 那個版本標題是哪顆 commit 加上去的 ─────────────────
 *
 * changelog 沒有像 `.worker-builds/manifest.json` 那樣記 `source_commit`，
 * 但**它自己就是歷史**：`## vX.Y.Z（日期）` 這行文字本身只會被加一次
 * （`daemon-version.py --stamp` 把 `## 下一版（未發佈）` 換成這行，且不會再改），
 * 所以用 `git log -S"## vX.Y.Z（" --reverse` 找出**最早**那顆加入它的 commit，
 * 效果等同 artifact-freshness 讀 `source_commit`——都是「這個宣告對應哪顆 commit」。
 * 之後 `git log <那顆>..HEAD -- collector` 非空 ＝ 宣告之後源碼又動過 ＝ 沒重打包。
 *
 * 🔴 紅線同 Arcrun#93：**本檔不會自動幫你戳版／打包／寫 changelog**，只會停、
 *   只會講清楚少了哪一步（哪幾顆 commit、要去哪裡補）。
 *
 * 為什麼是獨立模組：同 artifact-freshness.mjs 的理由——閘要能被單獨演練，
 * 不必跑一次會 push 會部署的完整管線才知道它還通不通。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 只認「已發佈」段落，忽略「## 下一版（未發佈）」草稿——與 daemon-check 同一個判斷式。 */
const RELEASED_RE = /^## (v\d+\.\d+\.\d+)（/m;
const UNRELEASED_HEADING = '## 下一版（未發佈）';

/** daemon 的原始碼在本 repo 的哪個目錄——`ship.mjs` 的 `DAEMON_DIST_REL` 前綴即此。 */
export const DEFAULT_DAEMON_SOURCE_DIRS = ['collector'];

/** 跑一個 git 指令；失敗回傳 null（呼叫端自己決定「問不出來」算不算過）。 */
function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** changelog 現在最上面那個「已發佈」版本；沒有就回 null。 */
export function topReleasedVersion(changelogText) {
  const m = changelogText.match(RELEASED_RE);
  return m ? m[1] : null;
}

/** changelog 現在有沒有一段「下一版（未發佈）」草稿——只供訊息附帶說明，不影響判定。 */
export function hasUnreleasedDraft(changelogText) {
  return changelogText.includes(UNRELEASED_HEADING);
}

/**
 * 找出「哪顆 commit 讓 changelog 出現 `## <version>（` 這行標題」——
 * 即這一版被 `daemon-version.py --stamp` 宣告發佈的那一刻。
 * `-S<needle>` 找的是「這個字串出現次數改變」的 commit；`--reverse` 讓輸出照時間正序，
 * 取第一行就是**最早**加上它的那顆（同一個標題正常只會被加一次）。
 * 找不到回 null（例如歷史被 squash／rebase 過，或版本字串跟預期不同）。
 */
export function findVersionAnnounceCommit(repo, changelogRel, version) {
  const needle = `## ${version}（`;
  const log = git(repo, ['log', '--format=%H', '--reverse', '-S', needle, '--', changelogRel]);
  if (log === null || log === '') return null;
  return log.split('\n')[0];
}

/**
 * 比一次。回傳 `{ version, announceCommit, headCommit, dirs, behind, dirty, hasDraft, status, reason }`：
 *
 *   status='ok'      這個版本宣告之後，源碼目錄沒有任何 commit、也沒有未提交的改動
 *   status='stale'   🔴 源碼目錄在版本宣告之後**又被 commit 過** ⇒ 這版的說明是舊的
 *   status='dirty'   🔴 源碼目錄現在有**未提交**的改動 ⇒ 工作區比宣告的版本新
 *   status='unknown' 🔴 問不出來——**問不出來一律停**，同 artifact-freshness 的理由
 *
 * 不丟例外：純資料進、純資料出，測試才能把每一個分支都斷言到。
 */
export function checkDaemonFreshness({ repo, changelogRel, sourceDirs = DEFAULT_DAEMON_SOURCE_DIRS, allowDirty = false }) {
  const base = {
    version: null, announceCommit: null, headCommit: null,
    dirs: sourceDirs, behind: [], dirty: [], hasDraft: false,
  };
  const clPath = join(repo, changelogRel);
  if (!existsSync(clPath)) {
    return { ...base, status: 'unknown', reason: `找不到 changelog：${changelogRel}` };
  }
  const text = readFileSync(clPath, 'utf8');
  base.hasDraft = hasUnreleasedDraft(text);

  const version = topReleasedVersion(text);
  if (!version) {
    return { ...base, status: 'unknown', reason: 'changelog 裡沒有任何已發佈的 daemon 版本段（`## vX.Y.Z（…）`）' };
  }
  base.version = version;

  const head = git(repo, ['rev-parse', 'HEAD']);
  base.headCommit = head;

  const announce = findVersionAnnounceCommit(repo, changelogRel, version);
  if (!announce) {
    return {
      ...base, status: 'unknown',
      reason: `找不到「${version}」這段標題是哪顆 commit 加進 changelog 的（歷史可能被 squash／rebase 過，或版本字串跟預期不同）`,
    };
  }
  base.announceCommit = announce;

  let ancestor = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', announce, 'HEAD'], { cwd: repo, stdio: 'ignore' });
  } catch {
    ancestor = false;
  }
  if (!ancestor) {
    return {
      ...base, status: 'unknown',
      reason: `宣告 ${version} 的 ${announce.slice(0, 7)} 不是現在 HEAD（${(head || '').slice(0, 7)}）的祖先` +
        `⇒ 不在同一條線上，「新舊」無從比較`,
    };
  }

  const dirs = sourceDirs;
  if (!dirs.length) return { ...base, status: 'unknown', reason: '沒有指定要比對的源碼目錄' };

  // 目錄必須真的被 git 追蹤，理由與 artifact-freshness 同：沒追蹤 ⇒ 底下兩問永遠回「沒有」，
  // 那個「沒有」跟「同步」長得一模一樣，寧可報 unknown 停下來問。
  const tracked = git(repo, ['ls-files', '--', ...dirs]);
  if (tracked === null || tracked === '') {
    return {
      ...base, status: 'unknown',
      reason: `${dirs.join('、')} 沒有被 git 追蹤（不存在或被 .gitignore 掉）⇒ 比對永遠是空的，等於沒有這道閘`,
    };
  }

  const log = git(repo, ['log', '--format=%h %s', `${announce}..HEAD`, '--', ...dirs]);
  const st = git(repo, ['status', '--porcelain', '--', ...dirs]);
  if (log === null || st === null) {
    return { ...base, status: 'unknown', reason: `git 問不出這幾個目錄的狀態（${dirs.join('、')}）⇒ 不敢說它是新的` };
  }
  const behind = log.split('\n').filter(Boolean);
  const dirty = st.split('\n').filter(Boolean);

  if (behind.length) {
    return { ...base, status: 'stale', behind, dirty, reason: `${version} 宣告之後，源碼又被 commit ${behind.length} 次` };
  }
  if (dirty.length && !allowDirty) {
    return { ...base, status: 'dirty', behind, dirty, reason: `源碼有 ${dirty.length} 項未提交的改動` };
  }
  return { ...base, status: 'ok', behind, dirty, reason: `${version} 與源碼同步` };
}

/** 把結果寫成人話：哪個版本、宣告在哪顆 commit、差在哪幾顆。 */
export function formatDaemonFreshnessProblem({ repo, result }) {
  const lines = [];
  lines.push(`daemon 的說明比源碼舊——changelog 宣告的版本，源碼已經動過了（同 Leo/Arcrun#93 的形狀）\n`);
  lines.push(`     來源 repo：${repo}`);
  const label = { stale: '🔴 說明是舊的', dirty: '🔴 工作區比宣告的版本新', unknown: '🔴 無法判定' }[result.status] || result.status;
  lines.push(`     ${label}`);
  if (result.version) lines.push(`     changelog 最上面已發佈的版本：${result.version}`);
  if (result.announceCommit) lines.push(`     那一版是這顆 commit 宣告的：${result.announceCommit.slice(0, 7)}`);
  if (result.headCommit) lines.push(`     源碼現在的 HEAD             ：${result.headCommit.slice(0, 7)}`);
  if (result.dirs.length) lines.push(`     比對的源碼目錄              ：${result.dirs.join('、')}`);
  if (result.behind.length) {
    lines.push(`     宣告之後這幾顆 commit 動過它（差 ${result.behind.length} 顆）：`);
    for (const c of result.behind.slice(0, 8)) lines.push(`       ${c}`);
    if (result.behind.length > 8) lines.push(`       …還有 ${result.behind.length - 8} 顆`);
  }
  if (result.dirty.length) {
    lines.push(`     未提交的改動：`);
    for (const d of result.dirty.slice(0, 8)) lines.push(`       ${d}`);
    if (result.dirty.length > 8) lines.push(`       …還有 ${result.dirty.length - 8} 項`);
  }
  if (result.status === 'unknown') lines.push(`     原因：${result.reason}`);
  lines.push('');
  if (result.hasDraft) {
    lines.push(`     changelog 已經有「下一版（未發佈）」草稿——內容有人先寫了，`);
    lines.push(`     但還沒戳成正式版號、重打包、搬進 bundle。`);
  } else {
    lines.push(`     changelog 目前沒有「下一版（未發佈）」草稿——連草稿都還沒人寫。`);
  }
  lines.push(`     修法：先確認 changelog 有「下一版（未發佈）」段描述這幾顆改動（沒有就先補），`);
  lines.push(`           再跑 daemon-version.py --stamp 戳版號、重打 mac／win 桌面版，`);
  lines.push(`           最後讓 ship.mjs 的 daemon-sync 把新產物搬進 bundle。`);
  lines.push(`     🔴 本閘**不會自動幫你戳版／打包**——那有成本也可能失敗，要你看到少了哪一步（Arcrun#93 紅線）。`);
  lines.push(`     明知故犯：DAEMON_SOURCE_ALLOW_STALE=1（要在 commit 說明理由）。`);
  return lines.join('\n');
}

/**
 * 呼叫端入口：對不上就丟例外（訊息是人話）；對得上回傳結果供列印。
 *
 * `DAEMON_SOURCE_ALLOW_STALE=1` ＝明知故犯的逃生門（同 `ARTIFACT_ALLOW_STALE` 的慣例）：
 * 照樣把差異印出來，只是不停。
 */
export function requireFreshDaemonSource({ repo, changelogRel, sourceDirs = DEFAULT_DAEMON_SOURCE_DIRS, allowDirty = false }) {
  const result = checkDaemonFreshness({ repo, changelogRel, sourceDirs, allowDirty });
  if (result.status === 'ok') return result;
  const msg = formatDaemonFreshnessProblem({ repo, result });
  if (process.env.DAEMON_SOURCE_ALLOW_STALE === '1') {
    console.warn(`\n⚠️ DAEMON_SOURCE_ALLOW_STALE=1：以下問題**被明知故犯地放行**（請在 commit 說明理由）\n`);
    console.warn(msg);
    return result;
  }
  throw new Error(msg);
}
