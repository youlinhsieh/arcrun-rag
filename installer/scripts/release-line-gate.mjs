#!/usr/bin/env node
/**
 * release-line-gate.mjs — 「**送到使用者手上的每一條版本線，都要有一筆發在產品頁的版本發佈**」。
 *
 * ── 這道閘治什麼（inkstone/arcrun-rag#88，leo：「檢查為什麼會斷，建立下次無法斷的強制機制」）──
 *
 * 病況：daemon 做到 `v0.18.29`，而對外能點得到的最新 daemon 版本是 **`v0.18.25`（2026-08-09）**
 * ——`v0.18.26`／`27`／`28`／`29` 四版，公開端一筆都沒有。連續四次，沒有任何一站發現。
 *
 * 🔴 **真因是兩件事疊起來的，兩件都不是「忘了」：**
 *
 * ① **發佈這件事不是以版本線為單位的。**
 *    `ship.mjs` 的 `release-record` 站寫死 `tag = v${ctx.release}`，而 `ctx.release`
 *    是零件包版本（`1.4.x`）⇒ 一趟出貨永遠只產生一筆 release，不管它送了幾條線。
 *    daemon 那條線有三站在管**內容**（`daemon-sync`／`daemon-check`／`daemon-source-check`），
 *    **零站在管它有沒有被發佈**。
 *    實證（`github-contact-log.md`，同一個任務三行）：
 *    2026-08-16 18:53–18:55「推 prod：**daemon v0.18.28**（三平台）＋對應零件包」
 *    → 建出來的唯一一筆 release 是 **`v1.4.46`**。21 站全綠。
 *
 * ② **僅有的那一筆 daemon 發佈，發在沒有人會看的地方。**
 *    `v0.18.25` 住在 `youlinhsieh/arcrun-rag-bundles`——那個 repo 的自我描述是
 *    「Prebuilt worker bundles … served via jsDelivr」，**它是 CDN 倉庫，不是產品頁**。
 *    而它會落在那裡不是選擇，是**沿用當時那條路順手做的**：`github-contact-log.md`
 *    第 68 行留著原始指令，任務名稱是「補上文件站與建置日」（跟發佈無關），
 *    指令是 `R=youlinhsieh/arcrun-rag-bundles` … `gh release create 1.4.29 --repo "$R"`
 *    ——`$R` 早就被同一個 shell 前面推 bundle 的動作設好了，release 就跟著去了那裡。
 *    那筆 release **0 個附件**，內文寫的是 bundle repo 內的相對檔名。
 *    ⇒ **一個沒有人會去看的位置，斷不斷都不會有人察覺。** 這才是四版無聲的原因。
 *
 * ⇒ 所以這道閘的判準有**兩半**，缺一半就會綠給你看：
 *    **每一條線都有發佈**（治①）＋ **發在產品 repo、不是 CDN 倉庫**（治②）。
 *    只驗前半的話，把 release 丟回 bundles repo 一樣全綠——那正是 2026-08-09 發生的事。
 *
 * ── 三條設計判準（照 version-stamp-gate.mjs 的形狀）─────────────────────────────
 * ① **會擋，不是只提醒**：任一項不過就 exit 1；`ship.mjs` 把它排成一站，當場中止出貨。
 * ② **看事實，不看字串**：
 *    · 「有哪幾條線」讀的是**使用者端真的會讀到的那份回應**（`GET /api/latest`），
 *      不是檔名、不是命令列裡有沒有出現某個詞。
 *      （紅線點名：`stage-before-prod-guard` 第七次關鍵字誤攔，就是因為判準是字串比對。）
 *    · 「發到對的地方」比的是「**這個 repo 是不是登錄簿宣告的產物倉庫**」
 *      （`targets[t].bundles.remote`），不是猜名字裡有沒有 `bundles`。
 *    · 已發過的舊 tag 帶 `v`（10 筆，leo 說不回頭改）⇒ `tagMatches` 兩種都認，
 *      不會把發過的版本誤判成沒發。
 * ③ **閘自己要能被演練**：全部純函式＋注入（payload／release 清單／時間／log 路徑），
 *    `release-line-gate.test.mjs` 餵它該擋與不該擋的輸入各數種。
 *
 * ── 留痕（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）─────────────────────
 * 每一次執行——**擋下與放行都記**——附一行到 `installer/release-line-gate-log.md`。
 * 只記擋下的話，分母是未知的，沒辦法回答「這道閘到底有沒有在運作」。
 *
 * 用法：
 *   node installer/scripts/release-line-gate.mjs --target prod     # 不過就 exit 1
 *   node installer/scripts/release-line-gate.mjs --target stage
 *   node installer/scripts/release-line-gate.mjs --target prod --offline   # 只跑不需要網路的兩項
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINES, linesFrom, tagMatches, undeclaredVersionFields, bareVersion } from './release-lines.mjs';
import { giteaWriteCredentialsFromRemote } from './gitea-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');
export const TARGETS_REL = join('installer', 'ship.targets.json');
export const GATE_LOG_REL = join('installer', 'release-line-gate-log.md');

// ── 0. 小工具 ────────────────────────────────────────────────────────────────

/** `github.com/youlinhsieh/arcrun-rag-bundles` → `youlinhsieh/arcrun-rag-bundles`（去掉主機與 .git）。 */
export function slugOfRemote(remote) {
  if (!remote) return null;
  const s = String(remote).replace(/^[a-z+]+:\/\//i, '').replace(/\.git$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // 有主機名（含 `.`）就把它剝掉；`local-selftest` 這種沒有主機的原樣留著
  const tail = parts[0].includes('.') ? parts.slice(1) : parts;
  return tail.length >= 2 ? tail.slice(-2).join('/') : null;
}

const norm = (s) => String(s || '').trim().toLowerCase();

// ── 1. 落點：版本發佈不准發在產物倉庫（治真因②）─────────────────────────────

/**
 * 這個目標的版本發佈，是不是發在**產品 repo**（而不是放編譯產物給 CDN 取用的那個 repo）。
 *
 * 判準是事實比對，不是名字猜測：登錄簿自己宣告了 `bundles.remote`＝「產物推到哪」，
 * 兩者相同 ⇒ 這個環境的「版本發佈」與「產物上傳」是同一個地方 ⇒ 使用者要在
 * 一個裝編譯產物的倉庫裡找「這版改了什麼」，而那裡沒有人會去看。
 *
 * @returns {{ok:boolean, problems:string[], detail:string}}
 */
export function checkDestination(targetName, target) {
  const problems = [];
  const R = target && target.releaseRecord;
  const bundleSlug = slugOfRemote(target && target.bundles && target.bundles.remote);
  if (!R || !R.repoSlug) {
    // 不變式 Ⅵ 已經在登錄簿驗證階段擋過；走到這裡還缺 ⇒ 照樣不放行，不假設別人擋過了。
    problems.push(`目標 \`${targetName}\` 沒宣告 releaseRecord.repoSlug——沒有落點就談不上「發到對的地方」。`);
    return { ok: false, problems, detail: '' };
  }
  if (bundleSlug && norm(R.repoSlug) === norm(bundleSlug)) {
    problems.push(
      `目標 \`${targetName}\` 的版本發佈落在**產物倉庫**（${R.repoSlug}），那不是產品頁。\n`
      + `         ⇒ 登錄簿自己宣告 bundles.remote＝${target.bundles.remote}（＝編譯產物推去給 CDN 取用的地方），\n`
      + `           跟 releaseRecord.repoSlug 是同一個 repo。使用者要看「這版改了什麼」不會去那裡翻，\n`
      + `           **於是斷更幾版都沒有人會察覺**——2026-08-09 的 daemon v0.18.25 就是這樣消失的\n`
      + `           （github-contact-log.md 第 68 行：\`R=…-bundles\` 是前一個推 bundle 的動作留下的變數）。\n`
      + `         → 把 releaseRecord.repoSlug 改成**原始碼／產品 repo**（票→PR→commit→version 那條鏈住的地方）。`);
  }
  return {
    ok: problems.length === 0,
    problems,
    detail: `版本發佈落點 ${R.repoSlug}（產物倉庫 ${bundleSlug || '(無)'}）`,
  };
}

// ── 2. 覆蓋：交付面露出的版本號，不准有沒人負責發佈的（治「將來多一條線」）──────

/**
 * 使用者端讀得到的那份回應裡，有沒有**沒被宣告成版本線**的版本號。
 * 有 ＝ 有一條線正在無人看管的情況下送到使用者手上（今天 daemon 就是這個狀態的極端版）。
 */
export function checkCoverage(latestPayload) {
  const problems = [];
  const stray = undeclaredVersionFields(latestPayload);
  for (const f of stray) {
    problems.push(
      `使用者端的 /api/latest 露出版本號 \`${f.path} = ${f.version}\`，但它不是任何一條宣告過的版本線。\n`
      + `         ⇒ 有人拿得到這個號碼、會據以判斷「我能拿到什麼」，卻沒有任何一步保證它有對應的版本發佈。\n`
      + `         → 在 installer/scripts/release-lines.mjs 的 LINES 補上這條線（含產品名），\n`
      + `           它就會自動被 release-record 站發佈、被本閘檢查；\n`
      + `           若它其實不該對外露出，就從 /api/latest 的回應裡拿掉。`);
  }
  const declared = linesFrom(latestPayload, 'latest');
  return {
    ok: problems.length === 0,
    problems,
    detail: `交付面版本線 ${declared.length} 條：${declared.map((l) => `${l.id}=${l.version}`).join('、') || '(無)'}`,
  };
}

// ── 3. 已發佈：每一條線都要找得到對應的版本發佈 ──────────────────────────────

/**
 * @param {object[]} lines linesFrom() 的產物
 * @param {string[]} tags 產品 repo 目前所有 release 的 tag
 * @param {string} repoSlug 只用在錯誤訊息裡
 */
export function checkPublished(lines, tags, repoSlug) {
  const problems = [];
  const hit = [];
  for (const line of lines) {
    const found = tags.find((t) => tagMatches(t, line.version));
    if (found) { hit.push(`${line.id} ${line.version} → ${found}`); continue; }
    problems.push(
      `「${line.product}」這條線送出了 ${line.version}，但 ${repoSlug} 上沒有對應的版本發佈。\n`
      + `         ⇒ 使用者拿到這一版，卻查不到「這版改了什麼」——${line.label}\n`
      + `         → 這一版要嘛跟著出貨線發佈（release-record 站會照 LINES 逐條發），\n`
      + `           要嘛就不該送出去。不准「先出貨、之後再補」——那正是斷四版的走法。`);
  }
  return {
    ok: problems.length === 0,
    problems,
    detail: hit.length ? `已對上：${hit.join('、')}` : '一條都沒對上',
  };
}

// ── 4. 組裝 ─────────────────────────────────────────────────────────────────

/**
 * 純函式主體：所有外部事實都由呼叫端查好傳進來，本函式不碰網路、不碰磁碟。
 * @param {object} o
 * @param {string} o.targetName
 * @param {object} o.target             ship.targets.json 裡那個目標
 * @param {object} o.latestPayload      使用者端會讀到的那份回應（/api/latest 或等價的 manifest 投影）
 * @param {string[]|null} o.publishedTags 產品 repo 現有的 release tag；null＝離線模式，跳過第三項
 */
export function runGate({ targetName, target, latestPayload, publishedTags }) {
  const dest = checkDestination(targetName, target);
  const cov = checkCoverage(latestPayload);
  const lines = linesFrom(latestPayload, 'latest');
  const repoSlug = (target && target.releaseRecord && target.releaseRecord.repoSlug) || '(未宣告)';

  const sections = [
    { name: '版本發佈落在產品 repo，不是產物倉庫', ok: dest.ok, problems: dest.problems, detail: dest.detail },
    { name: '交付面每個版本號都有人負責發佈', ok: cov.ok, problems: cov.problems, detail: cov.detail },
  ];

  if (publishedTags === null) {
    sections.push({ name: `每條版本線都已發佈到 ${repoSlug}`, ok: true, problems: [], detail: '⏭ 離線模式，本項未檢查', skipped: true });
  } else {
    const pub = checkPublished(lines, publishedTags, repoSlug);
    sections.push({ name: `每條版本線都已發佈到 ${repoSlug}`, ok: pub.ok, problems: pub.problems, detail: pub.detail });
  }

  return { ok: sections.every((s) => s.ok), sections, lines };
}

// ── 5. 留痕（InkStoneCo#48：閘要留下自己擋了什麼的紀錄）──────────────────────

export const GATE_LOG_HEADER = [
  '# release-line-gate 執行紀錄',
  '',
  '> 每一次執行都記一行——**擋下與放行都記**。只記擋下的話分母是未知的，',
  '> 回答不了「這道閘到底有沒有在運作」（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）。',
  '',
  '| 時間 | 目標 | 版本線 | 結果 | 擋下什麼 |',
  '|---|---|---|---|---|',
  '',
].join('\n');

/**
 * 本地時間戳（`2026-08-18 12:33:25`）——與 `github-contact-log.md` 同一種寫法。
 * 不用 `toISOString()`：那是 UTC，跟同一份稽核鏈上其他紀錄差 8 小時，對帳時會誤導。
 */
export function localStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 附一行到執行紀錄。純粹靠參數決定內容（時間、路徑都可注入）⇒ 測得動。
 * @returns {string} 實際寫進去的那一行
 */
export function appendGateLog(logPath, { ts, targetName, result }) {
  const lines = result.lines.map((l) => `${l.id} ${l.version}`).join('；') || '(無)';
  const blocked = result.sections
    .filter((s) => !s.ok)
    .map((s) => s.name)
    .join('；') || '—';
  const row = `| ${ts} | ${targetName} | ${lines} | ${result.ok ? '✅ 放行' : '⛔ 擋下'} | ${blocked} |`;
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) appendFileSync(logPath, GATE_LOG_HEADER, 'utf8');
  appendFileSync(logPath, row + '\n', 'utf8');
  return row;
}

// ── 6. 取事實（CLI 用；測試不走這裡）─────────────────────────────────────────

/** 讀登錄簿。 */
export function loadTargets(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, TARGETS_REL), 'utf8'));
}

/**
 * 拿「使用者端真的會讀到的那份回應」。
 * 優先打 live 的 `/api/latest`（那是**真的**交付面）；打不到就退回本機 bundle manifest
 * 投影出同樣兩個欄位——退回時要講清楚，不准悄悄換來源。
 */
export async function fetchLatestPayload(target, { fetchImpl = fetch } = {}) {
  const base = target && target.verify && target.verify.installerBase;
  if (base) {
    try {
      const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/latest`, { headers: { 'user-agent': 'release-line-gate' } });
      if (r.ok) return { payload: await r.json(), source: `${base}/api/latest（live 交付面）` };
    } catch { /* 落到下面的 fallback */ }
  }
  const dir = expandHome(target && target.bundles && target.bundles.dir);
  const mPath = dir && join(dir, 'manifest.json');
  if (mPath && existsSync(mPath)) {
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    return {
      payload: { release: m.release, daemon: m.daemon ? { version: m.daemon.version } : undefined },
      source: `${mPath}（本機 bundle manifest；live 交付面打不到，已降級）`,
    };
  }
  throw new Error('拿不到交付面內容：live /api/latest 打不到，本機也沒有 bundle manifest。不猜，直接停。');
}

function expandHome(p) {
  return p && p.startsWith('~/') ? join(process.env.HOME || '', p.slice(2)) : p;
}

/** 抓產品 repo 目前所有 release 的 tag。GitHub 走匿名唯讀（D20：讀一律放行）。 */
export async function fetchPublishedTags(target, { root = REPO_ROOT, fetchImpl = fetch } = {}) {
  const R = target.releaseRecord;
  if (R.host === 'github') {
    const r = await fetchImpl(`https://api.github.com/repos/${R.repoSlug}/releases?per_page=100`,
      { headers: { 'user-agent': 'release-line-gate', accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`列 ${R.repoSlug} 的 release 失敗：HTTP ${r.status}`);
    return (await r.json()).map((x) => x.tag_name);
  }
  if (R.host === 'gitea') {
    const cred = giteaWriteCredentialsFromRemote(root);
    const headers = { accept: 'application/json' };
    if (cred) headers.authorization = `token ${cred.token}`;
    const base = (R.baseUrl || 'https://git.uncle6.me').replace(/\/$/, '');
    const r = await fetchImpl(`${base}/api/v1/repos/${R.repoSlug}/releases?limit=100`, { headers });
    if (!r.ok) throw new Error(`列 ${R.repoSlug} 的 release 失敗：HTTP ${r.status}`);
    return (await r.json()).map((x) => x.tag_name);
  }
  throw new Error(`不認得的 releaseRecord.host：${R.host}`);
}

// ── 7. CLI ──────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const targetName = (argv[argv.indexOf('--target') + 1] || '').trim();
  const offline = argv.includes('--offline');
  const cfg = loadTargets();
  const target = cfg.targets[targetName];
  if (!target) {
    console.error(`❌ 不認得的目標：${targetName || '(沒給 --target)'}｜可用：${Object.keys(cfg.targets).join('／')}`);
    process.exit(2);
  }
  // selftest 不推、不部署、沒有任何人會拿到東西 ⇒ 沒有「使用者讀得到的版本線」可談。
  if (!target.releaseRecord) {
    console.log(`⏭ 目標 ${targetName} 沒有 releaseRecord（不面對任何人），本閘不適用。`);
    process.exit(0);
  }

  const { payload, source } = await fetchLatestPayload(target);
  const publishedTags = offline ? null : await fetchPublishedTags(target);
  const result = runGate({ targetName, target, latestPayload: payload, publishedTags });

  console.log(`交付面來源：${source}`);
  for (const s of result.sections) {
    console.log(`${s.skipped ? '⏭' : s.ok ? '✔' : '✘'} ${s.name}`);
    if (s.detail) console.log(`   ${s.detail}`);
    for (const p of s.problems) console.log(`   - ${p}`);
  }
  const row = appendGateLog(join(REPO_ROOT, GATE_LOG_REL), {
    ts: localStamp(),
    targetName,
    result,
  });
  console.log(`\n留痕：${GATE_LOG_REL}\n${row}`);
  process.exit(result.ok ? 0 : 1);
}
