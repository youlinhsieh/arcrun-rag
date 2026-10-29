/**
 * unmerged-fix-gate.mjs — 切版之前，點名「已交回、卻沒進這一版來源」的修正分支
 *
 * ── 為什麼有這支（inkstone/InkStoneCo#139 c1793004568975163，leo 2026-10-26）─────
 * 實例：inkstone/Arcrun#310（claude.ai 連 MCP 被無故要求重新授權，leo 標緊急、客戶已受影響）。
 * `fix/310-mcp-401-reason`、`fix/310-health-build` 10-17 寫好、10-18 複驗成立，交回「地端併入下個候選」。
 * 之後 1.4.110～1.4.118 共數個版本都沒帶上它——**沒有任何東西在切版當下問過一句
 * 「有沒有交回了、卻沒進這一版的分支」**。每個切版的人都沒看到它。
 * leo：「已經說了這是個大問題，已經造成客戶困擾，緊急要求修復，結果沒推 prod，真的是很大的問題」；
 *      「有必要，因為這種事情發生太多次了」。
 *
 * ── 判什麼 ───────────────────────────────────────────────────────────────────
 * 來源 repo（Arcrun）遠端上，名字帶得出票號的分支（fix/310-x、arcrun-hand/310-solo、hand/139-x、claude/143-x…），凡是
 *   ① 內容還沒進這一版來源（不是 HEAD 的祖先，且 `git cherry` 也看不出已被等價 commit 帶進去）→ 候選
 *   ② 該票有留言**提到這條分支（名字或頂端 sha）並寫了「交回」** → 已交回、標示修好
 *   ③ 該票是緊急／客戶受影響（標籤，或本文／留言含「緊急」「客戶…受影響／困擾」）→ 緊急
 * 結果三級：
 *   ⛔ 擋　　已交回 ＋ 票還開著 ＋（緊急，或交回後放著超過 3 天沒進版）→ 不處理就切不了版
 *           （只靠緊急標籤不夠：#310 是 leo 在對話裡喊緊急、沒人去掛標籤才漏的 ⇒ 加上「放太久」這條不靠人記得的條件）
 *   ⚠️ 點名　已交回、不緊急、交回不到 3 天（正在送往下個候選）→ 每次切版都列出來，不擋
 *   ·  知會　還沒交回／票已關／查無此票的分支 → 只列名字
 *
 * ── 怎麼放行（兩條，都留痕）──────────────────────────────────────────────────
 *   · 這次不帶：`--skip-unmerged-fix <分支>=<理由>`（可重複）。理由必填，會寫進出貨報告與流水帳。
 *   · 標掉舊的：`installer/unmerged-fix-ignore.json`　{ "<分支>": { "tip": "<頂端 sha 前 7 碼>", "reason": "…" } }
 *     綁定頂端 sha：分支之後又有新 commit，標記自動失效，會再被點名一次。
 *
 * ── 邊界（不是漏做）─────────────────────────────────────────────────────────
 *   · 只在切版當下查一次，不輪詢、不排程。
 *   · 只讀：`git ls-remote`／`git fetch <單一分支>`／讀票。不寫票、不動分支。
 *   · 讀票失敗 ＝ 判不出緊急與否 ⇒ fail-closed 擋下（要放行就明講理由，同上）；沒有候選分支就根本不讀票。
 *   · 名字裡完全帶不出票號的分支，這道閘看不到。命名帶票號是前提，不是它能補的。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ticketForge, ticketToken } from './forge-config.mjs';
import { fetchAllComments } from './ticket-arm-guard.mjs';

export const IGNORE_REL = join('installer', 'unmerged-fix-ignore.json');
export const GATE_LOG_REL = join('installer', 'unmerged-fix-gate-log.md');
/** 修正分支的命名：fix/310-xxx、hotfix/310、urgent/310-xxx → 票號 310 */
/**
 * 名字裡帶得出票號的分支都算（不只 fix/）：路徑任一段長得像 `310-…`、`ms81-286-…`、`issue-30-…`、`workerd-274`。
 * 工人實際用的有 fix/310-x、arcrun-hand/310-solo、hand/139-x、claude/143-x、feat/222-x…
 * （Arcrun#310 最後就是以 `arcrun-hand/310-solo` 進來的）。`archive/`、`integrate/`、`salvage/` 是收納用的命名空間，不算。
 */
export const TICKET_SEG_RE = /^(?:[a-z]+\d*-)?(\d{1,5})(?:-|$)/i;
const SKIP_NS_RE = /^(?:archive|integrate|integration|salvage|release|backup)\//i;
export function ticketFromBranch(name) {
  if (SKIP_NS_RE.test(name)) return null;
  for (const seg of String(name).split('/')) {
    const m = seg.match(TICKET_SEG_RE);
    if (m) return Number(m[1]);
  }
  return null;
}
const URGENT_LABEL_RE = /緊急|urgent|critical|^p0\b|^p\/high$|客戶|customer/i;
const URGENT_TEXT_RE = /緊急|客戶(?:已)?(?:受影響|困擾)|urgent|critical/i;
const HANDBACK_RE = /交回|棒子|handback|交件/i;
const MAX_TICKETS = 150;
/** 已交回、票還開著，分支卻放著沒進版超過這麼多天 → 擋（不靠人記得掛緊急標籤）。 */
export const DEFAULT_MAX_AGE_DAYS = 3;
const READ_CONCURRENCY = 6;

const GATE_LOG_HEADER =
  '# 切版前「已交回卻沒進版」修正分支的流水帳\n\n'
  + '> 每趟出貨（擋下與放行都記）追一行。由 `installer/scripts/unmerged-fix-gate.mjs` 寫，不要手改。\n'
  + '> 為什麼有這道閘：inkstone/InkStoneCo#139（Arcrun#310 緊急修正停在分支 9 天、數個版本沒帶）。\n\n'
  + '| 時間 | 目標 | 結果 | 分支 | 說明 |\n|---|---|---|---|---|\n';

/** 預設 runner：同步跑 git，失敗丟例外。測試換成假的。 */
export function gitRunner(cwd) {
  return (args, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (allowFail) return null;
      throw new Error(`git ${args.join(' ')} 失敗：${String(e.stderr || e.message).trim().split('\n')[0]}`);
    }
  };
}

/** 該問哪個遠端：origin 優先；沒有 origin（例：雲端 clone 的遠端叫 art）就用唯一的／第一個。 */
export function pickRemote(run) {
  const list = (run(['remote'], { allowFail: true }) || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error('來源 repo 沒有任何 git 遠端，沒辦法查有哪些分支。');
  return list.includes('origin') ? 'origin' : list[0];
}

/** 解析 `git ls-remote --heads` 輸出 → [{name, sha, issue}] 只留名字帶得出票號的分支。純函式。 */
export function parseFixHeads(lsRemoteOut) {
  const out = [];
  for (const line of String(lsRemoteOut || '').split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);
    if (!m) continue;
    const issue = ticketFromBranch(m[2]);
    if (issue && m[2] !== 'main' && m[2] !== 'master') out.push({ name: m[2], sha: m[1], issue });
  }
  return out;
}

/** 解析 `--skip-unmerged-fix 分支=理由`（argv 內可重複）。理由必填，缺了丟例外。純函式。 */
export function parseSkipArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--skip-unmerged-fix') continue;
    const raw = argv[i + 1] || '';
    const eq = raw.indexOf('=');
    const branch = eq > 0 ? raw.slice(0, eq).trim() : '';
    const reason = eq > 0 ? raw.slice(eq + 1).trim() : '';
    if (!branch || !reason) {
      throw new Error(`--skip-unmerged-fix 要寫成 \`<分支>=<這次不帶的理由>\`（收到：${JSON.stringify(raw)}）。理由必填——放行要留痕，不留理由等於沒有閘。`);
    }
    out.set(branch, reason);
  }
  return out;
}

/** 讀「標掉舊分支」名單。壞檔 → 丟例外（不安靜當成空）。 */
export function loadIgnore(repoRoot, rel = IGNORE_REL) {
  const p = join(repoRoot, rel);
  if (!existsSync(p)) return {};
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${rel} 不是合法 JSON：${e.message}`); }
  const out = {};
  for (const [k, v] of Object.entries(j)) {
    if (k.startsWith('_')) continue;
    if (!v || typeof v.tip !== 'string' || !v.tip.trim() || typeof v.reason !== 'string' || !v.reason.trim()) {
      throw new Error(`${rel} 的 ${k} 要有 tip（頂端 sha 前 7 碼）與 reason（為什麼不用帶）兩欄。`);
    }
    out[k] = { tip: v.tip.trim().toLowerCase(), reason: v.reason.trim() };
  }
  return out;
}

/** 這條分支的內容已進 HEAD 嗎？祖先、`git cherry` 全是 `-`（等價 commit 已在）、或它改到的檔案內容與 HEAD 完全相同（squash）。 */
export function isBranchContentIn(run, headSha, branchSha) {
  if (run(['merge-base', '--is-ancestor', branchSha, headSha], { allowFail: true }) !== null) return true;
  const cherry = run(['cherry', headSha, branchSha], { allowFail: true });
  if (cherry == null) return false; // 判不出 → 當作還沒進（寧可多點名）
  const lines = cherry.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => l.startsWith('-'))) return true;
  // squash／重新整理過的合併：sha 與 patch-id 都對不上，但「這條分支改到的那些檔案，HEAD 上的內容和分支頂端一模一樣」
  // ＝ 它要帶的東西已經在 HEAD 了。只比分支自己動過的檔（相對於與 HEAD 的共同祖先），不比全樹。
  const base = run(['merge-base', headSha, branchSha], { allowFail: true });
  if (!base) return false;
  const files = (run(['diff', '--name-only', base, branchSha], { allowFail: true }) || '').split('\n').filter(Boolean);
  if (files.length === 0) return true; // 分支相對共同祖先沒有任何檔案差異
  if (files.length > 1500) return false; // 太大不比（寧可多點名）
  return run(['diff', '--quiet', headSha, branchSha, '--', ...files], { allowFail: true }) !== null;
}

/** 純函式：由票面判「已交回？緊急？還開著？」。 */
export function judgeTicket({ issue, comments }, branch, now = Date.now()) {
  const tip7 = branch.sha.slice(0, 7);
  const mentions = (c) => {
    const b = String(c.body || '');
    return b.includes(branch.name) || b.includes(tip7);
  };
  const handbacks = (comments || []).filter((c) => mentions(c) && HANDBACK_RE.test(String(c.body || '')));
  const handbackComment = handbacks[0]; // 最早的一則：算「從什麼時候起放著」
  const t0 = handbackComment && handbackComment.created_at ? Date.parse(handbackComment.created_at) : NaN;
  const ageDays = Number.isFinite(t0) ? Math.max(0, (now - t0) / 86400000) : null;
  const labels = ((issue && issue.labels) || []).map((l) => (typeof l === 'string' ? l : l.name));
  const urgentLabel = labels.find((n) => URGENT_LABEL_RE.test(n));
  const textHit = [issue && issue.body, ...(comments || []).map((c) => c.body)]
    .map((t) => String(t || '').match(URGENT_TEXT_RE)).find(Boolean);
  const handedBack = !!handbackComment || labels.includes('s/review');
  return {
    handedBack,
    handbackBy: handbackComment ? `c${handbackComment.id}` : (labels.includes('s/review') ? '標籤 s/review' : null),
    urgent: !!(urgentLabel || textHit),
    urgentWhy: urgentLabel ? `標籤「${urgentLabel}」` : (textHit ? `票面出現「${textHit[0]}」` : null),
    open: !issue || issue.state !== 'closed',
    ageDays,
  };
}

/**
 * 核心：回 { blocking, warn, info, waived, ignored, merged }；呼叫端決定要不要丟。
 * @param {object} o
 * @param {(args:string[],opt?:object)=>string|null} o.run  跑在來源 repo 的 git
 * @param {string} o.ticketRepo  票所在 repo 名（inkstone 底下）
 * @param {Map<string,string>} o.skips  --skip-unmerged-fix
 * @param {object} o.ignore  loadIgnore() 的結果
 * @param {Function} [o.readTicket]  ({issue}) → {issue, comments}；預設走 forge 設定（AHub／Gitea）
 */
export async function assessUnmergedFixes({ run, ticketRepo, skips = new Map(), ignore = {}, readTicket, remote, headSha, now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  remote = remote || pickRemote(run);
  const head = headSha || run(['rev-parse', 'HEAD']);
  const heads = parseFixHeads(run(['ls-remote', '--heads', remote]));
  const res = { head, listed: heads.length, blocking: [], warn: [], info: [], waived: [], ignored: [], merged: [] };
  // ⓪ 淺 clone 判不出祖先關係（merge-base 找不到共同祖先 ⇒ 所有分支都會被當成「沒進版」，整份報告是假的）。
  //    補齊歷史（只增加物件，不動工作區與任何分支）；補不齊就 fail-closed，不拿假結果當事實。
  if (run(['rev-parse', '--is-shallow-repository'], { allowFail: true }) === 'true') {
    run(['fetch', '--quiet', '--unshallow', remote], { allowFail: true });
    if (run(['rev-parse', '--is-shallow-repository'], { allowFail: true }) === 'true') {
      throw new Error(`來源 repo 是淺 clone，補齊歷史（git fetch --unshallow ${remote}）也失敗——判不出哪些分支已進版，fail-closed。`);
    }
    res.unshallowed = true;
  }
  // ① 物件不在本機的分支，一次批次抓（唯讀；只寫 FETCH_HEAD，不建任何 ref）。抓不到 → 判不出內容有沒有進，當作還沒進。
  const absent = heads.filter((b) => run(['cat-file', '-e', `${b.sha}^{commit}`], { allowFail: true }) === null);
  for (let i = 0; i < absent.length; i += 25) {
    run(['fetch', '--quiet', remote, ...absent.slice(i, i + 25).map((b) => `refs/heads/${b.name}`)], { allowFail: true });
  }
  // ② 便宜的先判：是不是 HEAD 的祖先、有沒有被標掉
  let rest = [];
  for (const b of heads) {
    if (run(['merge-base', '--is-ancestor', b.sha, head], { allowFail: true }) !== null) { res.merged.push(b); continue; }
    const ig = ignore[b.name];
    if (ig && b.sha.startsWith(ig.tip)) { res.ignored.push({ ...b, reason: ig.reason }); continue; }
    rest.push(b);
  }
  // ③ 票面：有 listOpen（一次列出開著的票）就只對「票還開著」的分支做貴的事（git cherry、讀留言）；
  //    票已關或不存在的分支只知會一行——它們佔了遠端分支的絕大多數（Arcrun 約 114 條帶票號分支，開著的票只有一小撮）。
  let openMap = null;
  if (typeof readTicket.listOpen === 'function') {
    openMap = await readTicket.listOpen(); // 失敗就丟：列不出票 ＝ 判不出，fail-closed
    const keep = [];
    for (const b of rest) {
      if (openMap.has(b.issue)) keep.push(b);
      else res.info.push({ ...b, ticket: `${ticketRepo}#${b.issue}`, why: '票已關或不存在（開著的票裡找不到；沒進版的分支多半已作廢或改走別條）' });
    }
    rest = keep;
  }
  // ④ 內容等價（cherry-pick／rebase 過）也算進版了
  const todo = [];
  const need = [];
  for (const b of rest) {
    if (isBranchContentIn(run, head, b.sha)) { res.merged.push(b); continue; }
    todo.push(b);
    if (!need.includes(b.issue)) need.push(b.issue);
  }
  if (need.length > MAX_TICKETS) {
    throw new Error(`未進版且票還開著的分支牽涉 ${need.length} 張票（上限 ${MAX_TICKETS}）——先清分支，這道閘不在這種量下逐張讀票。`);
  }
  const tickets = new Map();
  const readErr = new Map();
  // 票的後端一次呼叫要幾秒到幾十秒（AHub），逐張讀會讓切版卡很久 ⇒ 有界並行（唯讀，安全）。
  const queue = [...need];
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        tickets.set(n, openMap
          ? { issue: openMap.get(n), comments: await readTicket.comments({ issue: n }) }
          : await readTicket({ issue: n }));
      } catch (e) { readErr.set(n, { message: e.message, missing: !!e.missing }); }
    }
  }));
  for (const b of todo) {
    const skip = skips.get(b.name);
    const base = { ...b, ticket: `${ticketRepo}#${b.issue}` };
    if (readErr.has(b.issue) && readErr.get(b.issue).missing) {
      // 帶著有效 token 還是 404 ＝ 這個票號在票的後端根本不存在（多半是別的 repo 的票號，分支名撞號）。
      // 讀得到「不存在」是明確的事實，不是讀不到；不擋，但要點名讓人看見命名對不上。
      res.info.push({ ...base, why: `查無此票（${ticketRepo}#${b.issue} 不存在，分支名的票號可能屬別的 repo）——沒辦法判斷是否交回` });
      continue;
    }
    if (readErr.has(b.issue)) {
      const item = { ...base, why: `讀不到票（${readErr.get(b.issue).message}）——判不出緊急與否，fail-closed` };
      (skip ? res.waived.push({ ...item, reason: skip }) : res.blocking.push(item));
      continue;
    }
    const t = tickets.get(b.issue);
    // 票已關 ＝ 這件事已經有人收尾（併了、作廢或改走別條）：不擋、不吵，只在報告裡留一行。
    // 也因此預設讀票時，已關的票不必再抓留言（見 defaultTicketReader），省下大半時間。
    if (t.issue && t.issue.state === 'closed') { res.info.push({ ...base, why: '票已關（沒進版的分支多半已作廢或改走別條；沒讀留言）' }); continue; }
    const j = judgeTicket(t, b, now);
    if (!j.handedBack) { res.info.push({ ...base, why: '票上沒有交回紀錄（還在做，或交回時沒寫分支名）' }); continue; }
    // 擋的條件不能只靠人記得掛「緊急」標籤（Arcrun#310 就是 leo 在對話裡喊緊急、沒人去標而漏掉）：
    // 已交回＋票還開著，且 ① 有緊急記號（p/high、「緊急」…）或 ② 交回後放著沒進版超過 maxAgeDays 天 → 擋。
    // 交回不到 maxAgeDays 天的視為正在送往下個候選，只點名。
    const stale = j.ageDays != null && j.ageDays >= maxAgeDays;
    const reasons = [];
    if (j.urgent) reasons.push(j.urgentWhy);
    if (stale) reasons.push(`交回後放著 ${Math.floor(j.ageDays)} 天沒進版（門檻 ${maxAgeDays} 天）`);
    const age = j.ageDays != null ? `（${Math.floor(j.ageDays)} 天前）` : '';
    const item = { ...base, why: `${j.handbackBy} 已交回${age}${reasons.length ? `；${reasons.join('；')}` : ''}${j.open ? '' : '；票已關'}`, urgent: j.urgent, open: j.open };
    if (j.open && (j.urgent || stale)) {
      if (skip) res.waived.push({ ...item, reason: skip }); else res.blocking.push(item);
    } else {
      res.warn.push(item);
    }
  }
  return res;
}

/** 人話。 */
export function formatReport(r) {
  const L = [];
  const row = (x) => `${x.name}（${x.sha.slice(0, 7)}，${x.ticket}）— ${x.why}`;
  if (r.unshallowed) L.push('（來源 repo 原本是淺 clone，已補齊歷史才能判祖先關係）');
  L.push(`來源 HEAD ${r.head.slice(0, 7)}；遠端名字帶票號的分支 ${r.listed} 條：已進版 ${r.merged.length}、標掉 ${r.ignored.length}、`
    + `這次不帶 ${r.waived.length}、點名 ${r.warn.length}、知會 ${r.info.length}、擋 ${r.blocking.length}`);
  for (const x of r.blocking) L.push(`⛔ ${row(x)}`);
  for (const x of r.waived) L.push(`↪ 這次不帶：${row(x)}　理由：${x.reason}`);
  for (const x of r.warn) L.push(`⚠️ ${row(x)}`);
  for (const x of r.info) L.push(`· ${row(x)}`);
  for (const x of r.ignored) L.push(`· 已標掉：${x.name}（${x.sha.slice(0, 7)}）— ${x.reason}`);
  return L;
}

export function blockingMessage(r) {
  return `有 ${r.blocking.length} 條「已交回、卻沒進這一版來源」（緊急，或交回後放太久）的分支，不處理就切不了版：\n`
    + r.blocking.map((x) => `       ⛔ ${x.name}（${x.sha.slice(0, 7)}，${x.ticket}）— ${x.why}`).join('\n')
    + '\n     → ① 併進來源再切（正路）；\n'
    + '       ② 這次真的不帶：加 `--skip-unmerged-fix <分支>=<理由>`（理由會留在出貨報告與 installer/unmerged-fix-gate-log.md）；\n'
    + '       ③ 已放棄／被取代：寫進 installer/unmerged-fix-ignore.json（綁頂端 sha，分支再動會自動失效）。';
}

function appendLog(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, GATE_LOG_HEADER, 'utf8');
  appendFileSync(path, rows.map((r) => `| ${r.join(' | ').replace(/\n/g, ' ')} |`).join('\n') + '\n', 'utf8');
}

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** 預設讀票：走 forge.conf 決定的後端（AHub／Gitea），只讀。 */
export function defaultTicketReader({ ticketRepo, env = process.env }) {
  const forge = ticketForge({ env });
  const token = ticketToken(forge.kind, { env });
  const base = `${forge.baseUrl}/api/v1/repos/inkstone/${ticketRepo}`;
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `token ${token}`;
  const comments = ({ issue }) => fetchAllComments({ owner: 'inkstone', repo: ticketRepo, issue, token, baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl });
  const read = async ({ issue }) => {
    const r = await forge.fetchImpl(`${base}/issues/${issue}`, { headers });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}${r.status === 401 || r.status === 404 ? '（缺 token 或票不存在）' : ''}`);
      err.missing = r.status === 404 && !!token; // 有 token 的 404 才算「確實不存在」
      throw err;
    }
    const iss = await r.json();
    if (iss && iss.state === 'closed') return { issue: iss, comments: [] };
    return { issue: iss, comments: await comments({ issue }) };
  };
  /** 一次列出開著的票（分頁，三頁一批並行）→ Map<票號, issue>。 */
  read.listOpen = async () => {
    const out = new Map();
    const PAGE = 50;
    for (let start = 1; start <= 30; start += 3) {
      const pages = await Promise.all([0, 1, 2].map(async (k) => {
        const r = await forge.fetchImpl(`${base}/issues?state=open&type=issues&limit=${PAGE}&page=${start + k}`, { headers });
        if (!r.ok) throw new Error(`列開著的票失敗：HTTP ${r.status}${r.status === 401 ? '（缺 token）' : ''}`);
        const j = await r.json();
        if (!Array.isArray(j)) throw new Error('列開著的票：回應不是陣列');
        return j;
      }));
      let short = false;
      for (const pg of pages) { for (const i of pg) out.set(i.number, i); if (pg.length < PAGE) short = true; }
      if (short) return out;
    }
    throw new Error('開著的票超過 1500 張還沒列完——fail-closed。');
  };
  read.comments = comments;
  return read;
}

/**
 * 出貨線用的入口：判 → 留痕 → 有擋就丟例外。回傳 detail 行。
 * @param {object} o  { repo(來源 repo 路徑), repoRoot(arcrun-rag 根，放名單與流水帳), ticketRepo, argv, targetName, remote, run, readTicket, now, logPath }
 */
export async function requireNoUnmergedFixes({
  repo, repoRoot, ticketRepo, argv = [], targetName = null, remote, maxAgeDays,
  run = gitRunner(repo), readTicket, now = new Date(), logPath = join(repoRoot, GATE_LOG_REL), headSha,
}) {
  const skips = parseSkipArgs(argv);
  const ignore = loadIgnore(repoRoot);
  const r = await assessUnmergedFixes({
    run, ticketRepo, skips, ignore, remote, headSha, now: now.getTime(), maxAgeDays: maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    readTicket: readTicket || defaultTicketReader({ ticketRepo }),
  });
  const ts = stamp(now);
  const rows = [
    ...r.blocking.map((x) => [ts, targetName || '(未指名)', '⛔ 擋下', x.name, x.why]),
    ...r.waived.map((x) => [ts, targetName || '(未指名)', '⚠️ 這次不帶', x.name, `${x.why}；理由：${x.reason}`]),
    ...r.warn.map((x) => [ts, targetName || '(未指名)', '點名', x.name, x.why]),
  ];
  if (rows.length) appendLog(logPath, rows);
  const lines = formatReport(r);
  if (r.blocking.length) {
    const e = new Error(blockingMessage(r) + '\n\n' + lines.join('\n'));
    e.report = r;
    throw e;
  }
  return { report: r, lines };
}

