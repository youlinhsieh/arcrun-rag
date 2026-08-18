/**
 * daemon-freshness.mjs — 「**changelog 宣告的那一版，成品是不是照現在這份源碼打的**」
 * 對不上就當場停下，並指名是**哪幾個檔案**變了。
 *
 * ── 為什麼有這道閘（2026-08-15 夜間，三顆 collector/ 的改動）───────────────────
 *
 * `daemon-sync`／`daemon-check` 這兩站比的是 **bundle vs changelog**。那天
 * e7c715f／d4d79f1／91f6171 三顆 commit 全動了 `collector/`（daemon 的原始碼），
 * changelog 最上面已發佈段卻還是 08-13 打包時戳的 `v0.18.27`——**沒有人把新版戳出來、
 * 也沒有人重打包**。而那兩站比的兩個值從頭到尾沒被要求跟「源碼現況」對過帳，於是
 * **同時落後於現實、永遠對得上**——出貨管線印「已是最新」，使用者按「檢查更新」
 * 拿到的還是 08-13 那顆執行檔。
 *
 *     daemon-check 比的是   bundle          vs  changelog
 *     本檔比的是            changelog(頂端) vs  collector/ 源碼現況
 *
 * ── 🔴 2026-08-18 重寫（inkstone/arcrun-rag#88）：從「查歷史」改成「量事實」──────
 *
 * 舊版的判法是 **git 歷史當代理**：
 *   `git log -S"## vX.Y.Z（"` 找出宣告那一版的 commit，再看
 *   `git log <那顆>..HEAD -- collector` 有沒有東西。
 * 那個代理有兩個方向的錯，而且**兩邊都真的咬過人**：
 *
 *   ① **它會擋自己**（本輪的病灶）。D95 第一輪把 `CHANGELOG.md` 搬進 `collector/`
 *      （為的是讓 `collector/` 自足、有資格獨立成 repo）。從那一刻起，
 *      **「宣告新版本」這個動作本身就是在改 `collector/`** ⇒ 一顆只改宣告、
 *      一行程式都沒動的 commit（dcd0132 就是）也被算成「宣告之後源碼又動過」。
 *      🔴 兩件事都對，疊起來變成死結：衝突在**範圍重疊**，不在任何一方做錯。
 *   ② **它會放過該擋的、也會擋不該擋的**。`collector/` 底下有些檔案根本不會進到
 *      執行檔（打包腳本旁的 .mjs 工具、README…），動它們也被判「要重打包」；
 *      反過來，只要沒有 commit（例如 rebase／squash 過），它就什麼都看不到。
 *
 * ⇒ 改成問**同一件事實**：這支腳本每次戳版都會把「當下的原始碼指紋」記進帳本
 *   （`collector/cmd/arcrun-app/.version-source.json`，2026-08-06 起就存在）。
 *   **版本 X 的指紋 == 現在算出來的指紋 ⇒ X 的成品確實是照這份源碼打的。**
 *   「宣告」那一步改到的檔案，在戳版當下就已經算進指紋了 ⇒ **結構上不可能擋自己**；
 *   而「改了 code 卻沒重打包」照樣指紋不同 ⇒ **原本要擋的一個都沒放過**。
 *
 * ── 這道閘搬家了：問題留在出貨線，答案住在源碼那邊 ──────────────────────────
 *
 * 指紋怎麼算是 **daemon 自己的知識**（哪些檔案算數、帳本長什麼樣、演算法第幾版）。
 * 出貨線在這裡**重寫一份**就是兩套並存必然漂移的老病。
 * ⇒ 本檔不再自己算，改成呼叫 `collector/cmd/arcrun-app/daemon-version.py --source-state`
 *   （**唯讀**，不戳版、不寫檔），拿它量到的值來判。
 *   遷移計畫（`inkstone/InkStoneCo#40#issuecomment-3059` 第九節）寫的
 *   「daemon-freshness 該**搬家**不是加固」，指的就是這件事。
 *
 * 🔴 紅線（Arcrun#93 明文，沿用）：**本檔不會自動幫你戳版／打包／寫 changelog**，
 *   只會停、只會講清楚少了哪一步。
 * 🔴 紅線（inkstone/InkStoneCo#48）：**擋下與放行都留痕**到
 *   `installer/daemon-freshness-gate-log.md`——36 支閘只有 2 支會記錄自己擋了什麼。
 *
 * 為什麼是獨立模組：同 `artifact-freshness.mjs`／`daemon-in-bundle-gate.mjs` 的理由——
 * 閘要能被單獨演練，不必跑一次會 push 會部署的完整管線才知道它還通不通。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** 事實的產地：daemon 那條線唯一的版本產生器，也是指紋帳本的唯一寫入者。 */
export const SOURCE_STATE_SCRIPT_REL = join('collector', 'cmd', 'arcrun-app', 'daemon-version.py');

/** 留痕的地方（同 daemon-in-bundle-gate 的形狀，兩支閘各一份，不共用一個檔）。 */
export const GATE_LOG_REL = join('installer', 'daemon-freshness-gate-log.md');

const GATE_LOG_HEADER = [
  '# daemon 源碼新鮮度閘：每次判決的流水帳',
  '',
  '> 這道閘問的是：**changelog 最上面那一版的成品，是不是照現在這份源碼打的？**',
  '> 事實由 `collector/cmd/arcrun-app/daemon-version.py --source-state` 量（唯讀）。',
  '> 判法與由來見 `installer/scripts/daemon-freshness.mjs` 檔頭。',
  '> 🔴 **擋下與放行都要記**（inkstone/InkStoneCo#48）——只記擋下的閘，等於沒人知道它平常在做什麼。',
  '',
  '| 時間 | 目標 | 版本 | 打包時的指紋 | 現在的指紋 | 判決 | 差在哪 |',
  '|---|---|---|---|---|---|---|',
  '',
].join('\n');

/**
 * 向源碼那邊要一份「現在的事實」。**唯讀**：這條路不會戳版、不會寫任何檔案。
 *
 * @returns {{ ok: true, state: object } | { ok: false, error: string }}
 *   `ok:false` 一律由呼叫端判成 `unknown` 而**停**——問不出來不等於沒事。
 */
export function readSourceState({ repo, scriptRel = SOURCE_STATE_SCRIPT_REL, python = 'python3' }) {
  const script = join(repo, scriptRel);
  if (!existsSync(script)) {
    return { ok: false, error: `找不到版本產生器：${scriptRel}（事實只有它量得出來）` };
  }
  let out;
  try {
    out = execFileSync(python, [script, '--source-state'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const tail = ((e.stderr || '') + (e.stdout || '') + (e.message || '')).toString().trim().split('\n').slice(-3).join(' / ');
    return { ok: false, error: `${scriptRel} --source-state 跑不起來：${tail}` };
  }
  try {
    return { ok: true, state: JSON.parse(out) };
  } catch {
    return { ok: false, error: `${scriptRel} --source-state 吐的不是 JSON：${out.slice(0, 200)}` };
  }
}

/** 兩個路徑指的是不是同一個檔（存在就走 realpath，不存在就比字面）。 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return norm(a) === norm(b);
}

/**
 * 判一次。**純函式**：state 進、判決出，不碰磁碟也不碰 git ⇒ 每個分支都測得到。
 *
 *   status='ok'      這一版的成品，就是照現在這份源碼打的
 *   status='stale'   🔴 指紋對不上 ⇒ 打包之後源碼又動過（或反過來，沒重打包）
 *   status='unknown' 🔴 問不出來——**問不出來一律停**，同 artifact-freshness 的理由
 *
 * `changelogRel` 是出貨線這一邊認定的 daemon changelog（`daemon-notes.mjs` 的
 * `DAEMON_CHANGELOG_REL`）。**兩邊對「這份檔案住哪」有分歧本身就是一種病**
 * （D95 第二輪那次：出貨線問錯檔案，整站安靜 skip）⇒ 不一致就判 unknown。
 */
export function judgeSourceState({ repo, state, changelogRel = null }) {
  const base = {
    version: state?.version ?? null,
    recorded: state?.recorded_fingerprint ?? null,
    current: state?.current_fingerprint ?? null,
    fileCount: state?.file_count ?? 0,
    changed: state?.changed ?? [],
    added: state?.added ?? [],
    removed: state?.removed ?? [],
    perFileComparable: !!state?.comparable_per_file,
    hasDraft: !!state?.has_unreleased,
    artifacts: state?.artifacts ?? [],
    checks: [],
  };
  const unknown = (reason) => ({ ...base, status: 'unknown', reason });

  if (!state) return unknown('拿不到源碼那邊的事實（--source-state 沒有結果）');

  if (changelogRel && !samePath(state.changelog, join(repo, changelogRel))) {
    return unknown(
      `出貨線與源碼樹對「daemon 的版本說明檔住哪」有分歧：\n` +
      `       出貨線認定：${join(repo, changelogRel)}\n` +
      `       源碼樹認定：${state.changelog}\n` +
      `       ⇒ 兩邊問的不是同一份檔案，任何比對結果都不算數（D95 第二輪就是這個形狀）`);
  }
  if (!state.version) {
    return unknown('changelog 裡沒有任何已發佈的 daemon 版本段（`## X.Y.Z（…）`）');
  }
  if (!state.current_fingerprint) {
    return unknown('算不出現在這份源碼的指紋（collector/ 不在 git 裡？）⇒ 不敢說它是新的');
  }
  if (state.ledger_algo !== state.algo) {
    return unknown(
      `指紋帳本是用第 ${state.ledger_algo ?? '(無)'} 版演算法記的，現在是第 ${state.algo} 版\n` +
      `       ⇒ 兩個數字是用不同單位量出來的，比對沒有意義。\n` +
      `       下一次戳版打包就會用新演算法重記；在那之前這一版**無法查證**。`);
  }
  if (!state.recorded_fingerprint) {
    return unknown(
      `指紋帳本裡沒有 ${state.version} 這一版的紀錄\n` +
      `       ⇒ 這個版號沒有經過 daemon-version.py --stamp 打包路徑，\n` +
      `         也就無從證明「成品是照哪份源碼打的」。`);
  }

  base.checks.push({
    ok: true, name: '兩邊問的是同一份 changelog',
    fact: state.changelog,
  });
  base.checks.push({
    ok: state.recorded_fingerprint === state.current_fingerprint,
    name: `${state.version} 打包當下的原始碼指紋 vs 現在的`,
    fact: `帳本 ${state.recorded_fingerprint}｜現在 ${state.current_fingerprint}（涵蓋 ${state.file_count} 個檔）`,
  });

  if (state.recorded_fingerprint === state.current_fingerprint) {
    return { ...base, status: 'ok', reason: `${state.version} 的成品就是照現在這份源碼打的` };
  }
  const n = base.changed.length + base.added.length + base.removed.length;
  return {
    ...base, status: 'stale',
    reason: base.perFileComparable
      ? `${state.version} 打包之後，${n} 個檔案變動過`
      : `${state.version} 打包當下的指紋與現在不同（逐檔帳本停在 ${state.files_ledger_version || '(無)'}，講不出是哪幾個檔）`,
  };
}

/** 把結果寫成人話：哪個版本、指紋差多少、差在哪幾個檔。 */
export function formatDaemonFreshnessProblem({ repo, result }) {
  const lines = [];
  lines.push(`daemon 的成品配不上現在這份源碼——changelog 宣告的那一版，不是照這棵樹打的\n`);
  lines.push(`     來源 repo：${repo}`);
  const label = { stale: '🔴 成品是舊的', unknown: '🔴 無法判定' }[result.status] || result.status;
  lines.push(`     ${label}`);
  if (result.version) lines.push(`     changelog 最上面已發佈的版本：${result.version}`);
  if (result.recorded) lines.push(`     那一版打包當下的原始碼指紋　：${result.recorded}`);
  if (result.current) lines.push(`     現在這棵樹算出來的指紋　　　：${result.current}（涵蓋 ${result.fileCount} 個檔）`);
  const bucket = (title, arr) => {
    if (!arr.length) return;
    lines.push(`     ${title}（${arr.length}）：`);
    for (const f of arr.slice(0, 10)) lines.push(`       ${f}`);
    if (arr.length > 10) lines.push(`       …還有 ${arr.length - 10} 個`);
  };
  bucket('打包之後**內容改過**的檔案', result.changed);
  bucket('打包之後**新增**的檔案', result.added);
  bucket('打包之後**刪掉**的檔案', result.removed);
  if (result.status === 'stale' && !result.perFileComparable) {
    lines.push(`     （逐檔帳本對不上這一版 ⇒ 只講得出「不一樣」，講不出是哪幾個檔。`);
    lines.push(`       下一次戳版打包會把逐檔帳本重寫成當下的樣子，之後就講得出來。）`);
  }
  if (result.status === 'unknown') lines.push(`     原因：${result.reason}`);
  lines.push('');
  if (result.hasDraft) {
    lines.push(`     changelog 已經有「下一版（未發佈）」草稿——內容有人先寫了，`);
    lines.push(`     但還沒戳成正式版號、重打包、搬進 bundle。`);
  } else {
    lines.push(`     changelog 目前沒有「下一版（未發佈）」草稿——連草稿都還沒人寫。`);
  }
  lines.push(`     修法：先在 ${'collector/CHANGELOG.md'} 最上面補一段「下一版（未發佈）」描述這些改動，`);
  lines.push(`           再跑 collector/cmd/arcrun-app/build-mac.sh 與 build-win.sh（兩支都會 --stamp 戳版號），`);
  lines.push(`           最後讓 ship.mjs 的 daemon-sync 把新產物搬進 bundle。`);
  lines.push(`     🔴 本閘**不會自動幫你戳版／打包**——那有成本也可能失敗，要你看到少了哪一步（Arcrun#93 紅線）。`);
  lines.push(`     明知故犯：DAEMON_SOURCE_ALLOW_STALE=1（要在 commit 說明理由）。`);
  return lines.join('\n');
}

/** 本機時間戳（同 release-line-gate 的形狀，不用 UTC，留痕是給人看的）。 */
export function localStamp(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
}

/** 追一行流水帳。**擋下與放行都記**（InkStoneCo#48）。回傳寫進去的那一行。 */
export function appendGateLog(logPath, { ts, targetName, result, allowed = false }) {
  const n = result.changed.length + result.added.length + result.removed.length;
  const diff = result.status === 'ok'
    ? '—'
    : (result.perFileComparable && n ? `${n} 個檔（改 ${result.changed.length}／增 ${result.added.length}／刪 ${result.removed.length}）` : result.reason.split('\n')[0]);
  const verdict = result.status === 'ok' ? '✅ 放行' : (allowed ? '⚠️ 明知故犯放行' : '⛔ 擋下');
  const row = `| ${ts} | ${targetName || '(未指名)'} | ${result.version || '(問不出來)'} | `
    + `${result.recorded || '(無紀錄)'} | ${result.current || '(算不出)'} | ${verdict} | ${diff.replace(/\|/g, '/')} |`;
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) appendFileSync(logPath, GATE_LOG_HEADER, 'utf8');
  appendFileSync(logPath, row + '\n', 'utf8');
  return row;
}

/**
 * 量事實 → 判 → **不管過不過都留痕** → 不過就丟例外（訊息是人話）。
 *
 * 逃生門兩個，都會照樣把差異印出來、也照樣留痕（標成「明知故犯放行」）：
 *   · `DAEMON_SOURCE_ALLOW_STALE=1` —— 明知故犯（同 `ARTIFACT_ALLOW_STALE` 的慣例）
 *   · `allowDirty:true` —— 登錄簿的 `allowDirtySource`，目前只有 `selftest` 宣告。
 *     🔴 語意變了要講清楚：舊版靠 git 分得出「已提交」與「未提交」，所以這個旗標
 *     只放行後者。改用指紋之後**沒有這個分野**（指紋直接量工作區內容），
 *     所以它現在等同「selftest 這個不推不部署的目標，指紋對不上也讓它跑完」。
 *     selftest 不會有任何人拿到東西，而閘照樣把差異印出來 ⇒ 演練價值不變。
 */
export function requireFreshDaemonSource({
  repo, changelogRel = null, targetName = null, allowDirty = false,
  logPath = null, now = new Date(),
}) {
  const read = readSourceState({ repo });
  const result = read.ok
    ? judgeSourceState({ repo, state: read.state, changelogRel })
    : judgeSourceState({ repo, state: null, changelogRel });
  if (!read.ok) result.reason = read.error;

  const env = process.env.DAEMON_SOURCE_ALLOW_STALE === '1';
  const allowed = result.status !== 'ok' && (env || allowDirty);
  appendGateLog(logPath || join(repo, GATE_LOG_REL), {
    ts: localStamp(now), targetName, result, allowed,
  });
  if (result.status === 'ok') return result;

  const msg = formatDaemonFreshnessProblem({ repo, result });
  if (allowed) {
    console.warn(`\n⚠️ ${env ? 'DAEMON_SOURCE_ALLOW_STALE=1' : '登錄簿 allowDirtySource'}：以下問題**被明知故犯地放行**（請在 commit 說明理由）\n`);
    console.warn(msg);
    return result;
  }
  throw new Error(msg);
}
