/**
 * stage-queue-gate.mjs — 出貨線＝stage 唯一的發版佇列（inkstone/arcrun-rag#271 擴大版）。
 *
 * leo 2026-11-10：「它寫進 stage 後就被洗掉⋯stage 只有一個」「release 是排隊的，stage 就不會覆蓋？」
 *
 * 病：只比「上一版出貨紀錄」（source-regression-gate）抓不到——有人繞過出貨線直推 youlin
 * （Arcrun scripts/stage-deploy-artifacts.py，另見 inkstone/Arcrun#364），出貨紀錄裡根本沒那一筆。
 * 真相只有一個：**youlin 線上現在真的在跑哪一顆**（cypher `/health` 的 `bundle_commit`）。
 *
 * 判準（與 Arcrun#364 同一句話：stage 只收 main，後上的必須包含先上的）：
 *   ① 這次的 Arcrun 來源必須在 main 上
 *   ② 線上那一顆必須在 main 上；不在 ⇒ 預設擋，叫操作者先把那條線併 main
 *      ——真要丟掉，用 STAGE_QUEUE_DISCARD_LIVE=<那一顆的 sha 前綴> 明講丟哪一顆，
 *        管線把「丟了哪些 commit／票」寫進出貨報告，不准靜默蓋掉
 *   ③ 這次的來源必須是線上那一顆本身或其後代；不含 ⇒ 擋，列出少掉的 commit 與各屬哪張票
 *   ④ 查不到線上那一顆 ⇒ 擋（fail closed）；不憑上一版紀錄猜
 *
 * 純函式＋repo／fetch 注入，可在臨時 git repo 演練。
 */
import { execFileSync } from 'node:child_process';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };
const isAncestor = (repo, a, b) => { try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };

/** 一段 commit 說明裡出現的票號（`#123`、`inkstone/Arcrun#123`）。只抓「#數字」，去重保序。 */
export function ticketsIn(text) {
  const byNum = new Map(); // 同一個號碼只留一筆，有 owner/repo 的寫法優先
  for (const m of String(text || '').matchAll(/([\w.-]+\/[\w.-]+)?#(\d{1,6})\b/g)) {
    const cur = byNum.get(m[2]);
    if (!cur || (!cur.includes('/') && m[1])) byNum.set(m[2], `${m[1] || ''}#${m[2]}`);
  }
  return [...byNum.values()];
}

/** range（如 `a..b`）內的 commit：[{sha, subject, tickets}]，新到舊。 */
export function commitsIn(repo, range, limit = 400) {
  const raw = tryGit(repo, ['log', `--max-count=${limit}`, '--format=%h%x1f%s%x1f%b%x1e', range]);
  if (!raw) return [];
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body] = r.split('\x1f');
    return { sha, subject, tickets: ticketsIn(`${subject}\n${body || ''}`) };
  });
}

const uniqTickets = (commits) => ticketsIn(commits.flatMap((c) => c.tickets).join(' '));

function listing(commits, max = 12) {
  const rows = commits.slice(0, max).map((c) => `       ${c.sha} ${c.subject.slice(0, 80)}${c.tickets.length ? `　[${c.tickets.join(' ')}]` : ''}`);
  if (commits.length > max) rows.push(`       …另 ${commits.length - max} 筆`);
  return rows.join('\n');
}

/** 查線上 cypher 現在跑的 Arcrun 來源 commit。回 {commit} 或 {error}。 */
export async function fetchLiveCommit(cypherUrl, fetchImpl = fetch) {
  if (!cypherUrl) return { error: '登錄簿沒宣告 stage 的 cypher 網址（stageQueue.liveHealthUrl）' };
  try {
    const res = await fetchImpl(`${cypherUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return { error: `${cypherUrl}/health → HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const commit = body && typeof body.bundle_commit === 'string' ? body.bundle_commit.trim() : '';
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { error: `${cypherUrl}/health 沒有 bundle_commit（線上不是出貨線或直推出來的，沒蓋印）` };
    return { commit, version: body.bundle_version };
  } catch (e) {
    return { error: `${cypherUrl}/health 連不上：${e.message || e}` };
  }
}

/**
 * @param {object} p
 * @param {string} p.repo        Arcrun repo（或其 worktree）路徑
 * @param {string} p.currentSha  這次要出貨的來源（完整 sha）
 * @param {string} p.mainRef     例 origin/main
 * @param {string} p.liveHealthUrl youlin cypher 網址
 * @param {string} [p.discard]   STAGE_QUEUE_DISCARD_LIVE：明講要丟掉的那一顆（sha 前綴，≥7）
 * @returns {Promise<{ok:boolean,status:string,message:string,live?:string,carried?:object,discarded?:object}>}
 */
export async function checkStageQueue({ repo, currentSha, mainRef = 'origin/main', liveHealthUrl, fetchImpl = fetch, discard = '' }) {
  const cur7 = currentSha.slice(0, 7);
  const mainFull = tryGit(repo, ['rev-parse', '--verify', '-q', `${mainRef}^{commit}`]);
  if (!mainFull) {
    return { ok: false, status: 'no-main', message: `stage 佇列閘：${repo} 找不到 ${mainRef}，無法確認來源在 main 上。\n     → git -C ${repo} fetch origin main（Artifacts 用 InkStoneCo 的 artifacts-git.sh）後重跑` };
  }
  const main7 = mainFull.slice(0, 7);

  // ① 這次的來源在 main 上
  if (!isAncestor(repo, currentSha, mainFull)) {
    const extra = commitsIn(repo, `${mainFull}..${currentSha}`);
    return {
      ok: false, status: 'not-on-main',
      message:
        `stage 佇列閘：這次的 Arcrun 來源 ${cur7} 不在 ${mainRef}（${main7}）上——stage 只收 main。\n` +
        `     它比 main 多 ${extra.length} 筆沒併 main 的 commit：\n${listing(extra)}\n` +
        `     → 先把這條線併 main（總管決定），再用 main 的後代出貨；若 ${mainRef} 是舊的，先 fetch。`,
    };
  }

  // ④ 線上那一顆
  const live = await fetchLiveCommit(liveHealthUrl, fetchImpl);
  if (live.error) {
    return { ok: false, status: 'live-unknown', message: `stage 佇列閘：查不到 youlin 線上現在跑哪一顆，不准憑上一版紀錄猜（fail closed）。\n     原因：${live.error}\n     → 確認 youlin cypher 活著再重跑。` };
  }
  const liveFull = tryGit(repo, ['rev-parse', '--verify', '-q', `${live.commit}^{commit}`]);
  const discardOk = (full, short) => discard && discard.length >= 7 && (full ? full.startsWith(discard.toLowerCase()) : short.startsWith(discard.toLowerCase()));

  if (!liveFull) {
    // repo 沒有這顆：多半是別條線直推、分支沒 fetch 下來。無法判斷先後。
    if (discardOk(null, live.commit.toLowerCase())) {
      const d = { sha: live.commit, commits: [], tickets: [], note: '這顆在本 repo 找不到，無法列出丟掉哪些 commit' };
      return { ok: true, status: 'discarded', live: live.commit, discarded: d, message: `⚠️ stage 佇列閘：操作者明講丟掉線上 ${live.commit}（本 repo 找不到這顆，列不出內容）——記入出貨報告` };
    }
    return {
      ok: false, status: 'live-not-in-repo',
      message:
        `stage 佇列閘：youlin 線上現在跑 Arcrun@${live.commit}（${live.version || '?'}），但 ${repo} 找不到這顆 commit，無法確認這次 ${cur7} 有沒有包含它。\n` +
        `     → git -C ${repo} fetch origin 把那條線抓下來再重跑；若確定要丟掉它：STAGE_QUEUE_DISCARD_LIVE=${live.commit.slice(0, 7)}（會寫進出貨報告）`,
    };
  }
  const live7 = liveFull.slice(0, 7);

  // ② 線上那一顆在 main 上
  if (!isAncestor(repo, liveFull, mainFull)) {
    const onlyLive = commitsIn(repo, `${mainFull}..${liveFull}`);
    const branches = (tryGit(repo, ['branch', '-r', '--contains', liveFull]) || '').split('\n').map((s) => s.trim()).filter(Boolean).join('、') || '（找不到分支）';
    if (discardOk(liveFull)) {
      const d = { sha: liveFull, commits: onlyLive, tickets: uniqTickets(onlyLive) };
      return {
        ok: true, status: 'discarded', live: liveFull, discarded: d,
        message:
          `⚠️ stage 佇列閘：操作者明講丟掉線上那一顆 Arcrun@${live7}（不在 main；在 ${branches}），出貨會把它蓋掉。\n` +
          `     被丟掉的、main 沒有的 ${onlyLive.length} 筆（票：${d.tickets.join(' ') || '無'}）：\n${listing(onlyLive)}\n     → 已記入出貨報告`,
      };
    }
    return {
      ok: false, status: 'live-not-on-main', live: liveFull,
      message:
        `stage 佇列閘：youlin 線上現在跑的 Arcrun@${live7}（${live.version || '?'}）不在 ${mainRef} 上，出貨會把它洗掉。\n` +
        `     它在：${branches}；比 main 多 ${onlyLive.length} 筆（票：${uniqTickets(onlyLive).join(' ') || '無'}）：\n${listing(onlyLive)}\n` +
        `     → 先把那條線併 main，再用 main 的後代出貨；真要丟掉它，明講丟哪一顆：STAGE_QUEUE_DISCARD_LIVE=${live7}（會寫進出貨報告，不是靜默蓋掉）`,
    };
  }

  // ③ 這次的來源包含線上那一顆
  if (liveFull === currentSha) {
    return { ok: true, status: 'same', live: liveFull, carried: { from: liveFull, commits: [], tickets: [] }, message: `stage 佇列閘：與 youlin 線上同一顆（Arcrun@${cur7}，在 main 上）✓` };
  }
  if (isAncestor(repo, liveFull, currentSha)) {
    const carried = commitsIn(repo, `${liveFull}..${currentSha}`);
    const tickets = uniqTickets(carried);
    return {
      ok: true, status: 'descendant', live: liveFull, carried: { from: liveFull, commits: carried, tickets },
      message: `stage 佇列閘：Arcrun@${cur7} 在 main 上、且包含線上那一顆 ${live7}（多帶 ${carried.length} 筆；票：${tickets.join(' ') || '無'}）✓`,
    };
  }
  const missing = commitsIn(repo, `${currentSha}..${liveFull}`);
  return {
    ok: false, status: 'missing-live', live: liveFull,
    message:
      `stage 佇列閘：這次的 Arcrun@${cur7} 不包含 youlin 線上現在跑的 Arcrun@${live7}（${live.version || '?'}）——出了等於把別人已上 stage 的東西洗掉。\n` +
      `     少了 ${missing.length} 筆（${cur7}..${live7}），涉及票：${uniqTickets(missing).join(' ') || '無'}：\n${listing(missing)}\n` +
      `     → 把來源換成 ${live7} 的後代（先合上它）；後上的必須包含先上的。`,
  };
}
