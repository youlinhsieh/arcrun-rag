/**
 * stage-record.mjs — 出貨線每次成功上 stage，在 AHub 記一筆「stage 現在是哪一版、含哪些票、誰出的」
 * （inkstone/arcrun-rag#301；後端 inkstone/Arcrun#365，AHub 0.15.0 的 `POST /ahub/stage`）。
 *
 * 為什麼有這支（leo 2026-11-10：「stage 只有一個，各條線會互相洗掉」）：
 *   佇列閘（stage-queue-gate.mjs，#271）保證「後上的包含先上的」；這一支是另一半——讓各條線在 AHub **看得到**
 *   stage 現在跑哪一版，一張在等 stage 驗證的票打開就知道新版本還含不含它的改動。
 *
 * 守的邊界：
 *   · 只在出貨那一下寫一次：不輪詢、不排程、不對任何票留言（AHub 讀的時候才拿這份清單比對）。
 *   · 「含不含」用 git 祖先關係算：這一顆往回最近 STAGE_WINDOW 個 commit，與其訊息裡的票號，一次寫給 AHub；
 *     AHub 不碰 git。格式與 Arcrun `scripts/stage-deploy-artifacts.py` 的 build_stage_record 一致（兩個入口寫同一種紀錄）。
 *   · 憑證只碰名字（D36）：AHUB_TOKEN 由 ship-env.mjs 的 prepareShipEnv 取進本行程的 env，這裡只讀 env、不印、不落檔。
 *   · 寫不進去不安靜、但不擋（總監裁決 2026-11-10）：警告、內容存 pending、照常出貨、報告寫明；補寫用 `--retry-pending`。
 *
 * 純函式＋git／fetch 注入，可在臨時 git repo 演練（見 stage-record.test.mjs）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STAGE_WINDOW = 300;                         // 與 Arcrun stage-deploy-artifacts.py 的 STAGE_WINDOW 同值
export const DEFAULT_TICKET_REPO = 'inkstone/Arcrun';    // commit 訊息裡沒寫 repo 的 `#N` 算這個 repo 的票
export const STAGE_MAX_LIST = 400;                       // AHub 一次最多收的 commits／tickets 筆數（stage_record 路由的上限）
export const PENDING_NAME = 'stage-record-pending.json';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

/** commit 說明裡的票號 → 去重保序的 `owner/repo#N`（沒寫 repo 的 `#N` 算 defaultRepo）。 */
export function ticketRefsIn(text, defaultRepo = DEFAULT_TICKET_REPO) {
  const seen = new Set();
  const refs = [];
  for (const m of String(text || '').matchAll(/(?<![\w/.-])((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?)#(\d+)\b/g)) {
    const ref = `${m[1] || defaultRepo}#${m[2]}`;
    if (!seen.has(ref)) { seen.add(ref); refs.push(ref); }
  }
  return refs;
}

/**
 * 組出要寫給 AHub 的內容。純 git、不碰網路。headSha 在 repo 裡解不出來就回 null。
 * @returns {object|null} { commit, commits[], tickets[], window, repo, version?, by?, session_url?, note?, discarded? }
 */
export function buildStageRecord({ repo, headSha, version = '', by = '', sessionUrl = '', note = '', discarded = null, window = STAGE_WINDOW, defaultRepo = DEFAULT_TICKET_REPO }) {
  const head = headSha ? (tryGit(repo, ['rev-parse', '--verify', '-q', `${headSha}^{commit}`]) || '').trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(head)) return null;
  const shas = (tryGit(repo, ['rev-list', `--max-count=${window}`, head]) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const log = tryGit(repo, ['log', `--max-count=${window}`, '--format=%s%n%b%x1e', head]) || '';
  const body = {
    commit: head,
    commits: shas.map((s) => s.slice(0, 10)),
    tickets: ticketRefsIn(log, defaultRepo).slice(0, STAGE_MAX_LIST),
    window: shas.length,
    repo: defaultRepo,
  };
  for (const [k, v] of [['version', version], ['by', by], ['session_url', sessionUrl], ['note', note], ['discarded', discarded]]) {
    if (v) body[k] = v;
  }
  return body;
}

/** 佇列閘的 discarded（{sha,…}）→ AHub 要的 git sha；沒丟東西回 null。 */
export function discardedSha(discarded) {
  const s = discarded && typeof discarded === 'object' ? discarded.sha : discarded;
  return typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s) ? s.toLowerCase() : null;
}

/**
 * 寫進 AHub。fetchImpl 要是 forge-config 的 AHub fetch（吃 Gitea 形狀網址、轉成具名工作流呼叫）。
 * 回 { ok, status, message }；不丟例外（網路層錯誤也包進 message），由呼叫端決定怎麼吵。
 */
export async function postStageRecord({ fetchImpl, token, payload }) {
  if (!token) return { ok: false, status: 0, message: '沒有 AHub 權杖（環境變數 AHUB_TOKEN｜TICKET_FORGE_TOKEN；出貨線 prepareShipEnv 會自取 ISEP 橋登記的那把）' };
  let res;
  try {
    res = await fetchImpl('http://ahub.invalid/api/v1/ahub/stage', {
      method: 'POST',
      headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, status: 0, message: `連不上 AHub：${e && e.message ? e.message : e}` };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 201) return { ok: true, status: 201, message: '已寫進 AHub（stage 現況與含的票清單）' };
  return { ok: false, status: res.status, message: `AHub 沒有回成功（HTTP ${res.status}）：${text.slice(0, 300)}` };
}

/**
 * 出貨站的結果怎麼報（總監裁決 2026-11-10：AHub 寫不進去**不擋 stage 出貨**）。
 * 成功＝一行說明；失敗＝警告＋待補位置，狀態仍是 done（不讓這次出貨紅燈、不叫人重出貨）。
 * 一定回 { status:'done', detail:[...] }，不丟例外。
 */
export function stageRecordOutcome(r, { by = '', sessionUrl = '' } = {}) {
  const who = `by ${by}${sessionUrl ? `｜${sessionUrl}` : ''}`;
  if (r && r.ok) return { status: 'done', detail: [r.message, who] };
  return {
    status: 'done',
    detail: [
      `⚠️ 沒寫進 AHub 的 stage 現況（各線暫時看不到這一版）：${r && r.message ? r.message : '不明原因'}`,
      r && r.pending
        ? `待補：${r.pending}　→ AHub 可寫之後跑 node installer/scripts/stage-record.mjs --retry-pending`
        : '（來源算不出含哪些票，沒有可存的待補內容）',
      who,
    ],
  };
}

/**
 * 出貨「之前」先問一次：這台 AHub 寫得進 stage 現況嗎？（唯讀：GET /ahub/stage，不寫任何東西）
 * 為什麼要預先問：stage-record 是最後一站，到那裡才發現 AHub 沒有那組工作流，stage 早就換版了——
 * 各線看不到、出貨又是紅的，最糟的半套。⇒ 在碰任何東西之前就擋，預演也看得到。
 * @returns {{ ok:boolean, code:'ready'|'no-token'|'workflow-missing'|'unauthorized'|'unreachable'|'unexpected', message:string }}
 */
export async function probeStageRecordReady({ fetchImpl, token }) {
  if (!token) return { ok: false, code: 'no-token', message: '沒有 AHub 權杖（AHUB_TOKEN｜TICKET_FORGE_TOKEN；prepareShipEnv 會自取 ISEP 橋登記的那把，這台沒取到）' };
  let res;
  try {
    res = await fetchImpl('http://ahub.invalid/api/v1/ahub/stage?limit=1', { method: 'GET', headers: { authorization: `token ${token}` } });
  } catch (e) {
    return { ok: false, code: 'unreachable', message: `連不上 AHub：${e && e.message ? e.message : e}` };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 200) return { ok: true, code: 'ready', message: 'AHub 有 stage 現況（GET /ahub/stage 回 200）' };
  if (res.status === 404 && /workflow_missing/.test(text)) {
    return { ok: false, code: 'workflow-missing', message: `這台 AHub 還沒有 stage 現況那組工作流（AHub 0.15.0，inkstone/Arcrun#365）：${text.slice(0, 160)}` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', message: `AHub 不認這把權杖（HTTP ${res.status}）` };
  return { ok: false, code: 'unexpected', message: `GET /ahub/stage 回 HTTP ${res.status}：${text.slice(0, 200)}` };
}

export function pendingPath(workdir) { return join(workdir, PENDING_NAME); }

export function savePending(workdir, payload) {
  const p = pendingPath(workdir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(payload, null, 1));
  return p;
}

export function loadPending(workdir) {
  const p = pendingPath(workdir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function clearPending(workdir) {
  try { unlinkSync(pendingPath(workdir)); } catch { /* 本來就沒有 */ }
}

/**
 * 出貨一趟的完整動作：組 → 寫 → 寫不進就存 pending。
 * @returns {{ ok:boolean, message:string, payload:object|null, pending?:string }}
 */
export async function recordStageShipment({ repo, headSha, version, by, sessionUrl, note, discarded, fetchImpl, token, workdir }) {
  const payload = buildStageRecord({ repo, headSha, version, by, sessionUrl, note, discarded: discardedSha(discarded) });
  if (!payload) {
    return { ok: false, payload: null, message: `這一版的 Arcrun 來源 ${String(headSha || '？').slice(0, 12)} 在 ${repo} 找不到，算不出含哪些票` };
  }
  const r = await postStageRecord({ fetchImpl, token, payload });
  if (r.ok) {
    clearPending(workdir);
    return { ok: true, payload, message: `${r.message}：${payload.commit.slice(0, 12)}（${payload.version || '無版號'}），${payload.tickets.length} 張票、往回 ${payload.window} 個 commit` };
  }
  const pending = savePending(workdir, payload);
  return { ok: false, payload, pending, message: r.message };
}

// ── CLI：補寫上次沒寫成的那份 ─────────────────────────────────────────────
//   node installer/scripts/stage-record.mjs --retry-pending [--workdir <dir>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--retry-pending')) {
    console.error('用法：node installer/scripts/stage-record.mjs --retry-pending [--workdir <dir>]\n（平常不必手跑：出貨線 stage-record 站會自己寫）');
    process.exit(2);
  }
  const { resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { ticketForge, ticketToken } = await import('./forge-config.mjs');
  const { prepareShipEnv } = await import('./ship-env.mjs');
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const forge = ticketForge();
  prepareShipEnv({ repoRoot, forgeKind: forge.kind });
  const i = argv.indexOf('--workdir');
  const workdir = i >= 0 ? argv[i + 1] : join(homedir(), '.arcrun-ship', 'stage-record');
  const payload = loadPending(workdir);
  if (!payload) { console.error(`${pendingPath(workdir)} 不存在——沒有待補寫的 stage 紀錄`); process.exit(2); }
  const r = await postStageRecord({ fetchImpl: forge.fetchImpl, token: ticketToken(forge.kind), payload });
  console.log((r.ok ? '✅ ' : '❌ ') + r.message);
  if (r.ok) clearPending(workdir);
  process.exit(r.ok ? 0 : 5);
}
