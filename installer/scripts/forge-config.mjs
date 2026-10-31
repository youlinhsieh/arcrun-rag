/**
 * forge-config.mjs — 「票的正本住哪一家」只在一處決定（inkstone/InkStoneCo#234，母票 #232）
 *
 * ── 為什麼 ──────────────────────────────────────────────────────────────────
 * 票的正本要從 Gitea（git.uncle6.me）換到 leo21c 的 AHub。出貨線（ARM 留言核對）、
 * 用戶回報、安裝器的來源網址，以前各自寫死舊家 ⇒ 換家要改七八個地方，漏一個就是
 * 「切完才發現某條線還在寫舊的家」。現在它們都讀這一處：`installer/forge.conf`
 * （環境變數同名者優先，臨時翻、回退演練都只翻這一格）。
 *
 * ── 兩種後端 ────────────────────────────────────────────────────────────────
 *   TICKET_FORGE=gitea  Gitea 形狀的 REST（Gitea 本身，或 ahub_bridge 的本機網址）
 *   TICKET_FORGE=ahub   直接打 AHub 的具名工作流：
 *                       POST {AHUB_CYPHER_URL}/webhooks/named/{AHUB_NS}/ahub__<id>/query
 *                       信封 { method, path, query, body, token, params, base }，
 *                       回 { success, data:{ status, body } } ⇒ 還原成 Response。
 *                       這是 Arcrun `workflows/ahub/bridge/ahub_bridge.py` 做的同一件事，
 *                       只是搬進呼叫端——出貨線不必先在旁邊起一個本機行程
 *                       （橋的 README 寫明「日後工具改成原生讀 routes.json 直接打 webhook，這支就退場」）。
 *                       🔴 AHub 的路由表真身在 Arcrun `workflows/ahub/routes.json`；
 *                       本檔只抄「本 repo 用得到的幾條」。要用新端點 ⇒ 先對照那份再加。
 *
 * ── 不做的事 ────────────────────────────────────────────────────────────────
 *   · 不碰金鑰值：token 只從環境變數名拿（D36）。
 *   · 不管 git：clone／push 的 remote 不在這裡（gitea-ops#4）。
 *   · 發佈紀錄（release／附件）：TICKET_FORGE=ahub 時由 release-forge.mjs 接手（Arcrun AHub 0.4.0 有 release 路由；
 *     附件本體住 leo21c R2，AHub 只記指標，總管 InkStoneCo#234 c22852 裁定）。
 *     `RELEASE_FORGE_URL` 仍是 gitea 模式下的覆蓋點（見 releaseForgeBase）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRetry } from './fetch-retry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FORGE_CONF_PATH = join(HERE, '..', 'forge.conf');

/** 舊家：forge.conf 讀不到時的最後後備（寫在這裡等於把「現況」寫死一次，且 forge-consumers 測試認得它）。 */
export const LEGACY_FORGE_URL = 'https://git.uncle6.me';

/** 解析 KEY=VALUE（# 開頭與空行略過；值可含 =）。檔不存在回 {}。 */
export function parseConf(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function loadForgeConf(path = FORGE_CONF_PATH) {
  try {
    return existsSync(path) ? parseConf(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

const KEYS = ['TICKET_FORGE', 'TICKET_FORGE_URL', 'AHUB_CYPHER_URL', 'AHUB_NS', 'RELEASE_FORGE_URL', 'RELEASE_R2_ACCOUNT', 'RELEASE_R2_BUCKET'];

/**
 * 解出目前生效的設定：環境變數 > forge.conf > 後備。純函式（env、conf 都可注入）。
 * @returns {{kind:'gitea'|'ahub', ticketUrl:string, cypherUrl:string, ns:string, releaseUrl:string, r2Account:string, r2Bucket:string}}
 */
export function resolveForgeSettings({ env = process.env, conf = loadForgeConf() } = {}) {
  const pick = (k) => {
    const e = env[k];
    if (e != null && String(e).trim() !== '') return String(e).trim();
    return conf[k] != null ? String(conf[k]).trim() : '';
  };
  const kind = (pick('TICKET_FORGE') || 'gitea').toLowerCase();
  if (kind !== 'gitea' && kind !== 'ahub') {
    throw new Error(`TICKET_FORGE 只認 gitea 或 ahub（收到：${JSON.stringify(kind)}）——改 installer/forge.conf 或環境變數。`);
  }
  const strip = (u) => String(u || '').replace(/\/+$/, '');
  const s = {
    kind,
    ticketUrl: strip(pick('TICKET_FORGE_URL')) || LEGACY_FORGE_URL,
    cypherUrl: strip(pick('AHUB_CYPHER_URL')),
    ns: pick('AHUB_NS'),
    releaseUrl: strip(pick('RELEASE_FORGE_URL')),
    r2Account: pick('RELEASE_R2_ACCOUNT'),
    r2Bucket: pick('RELEASE_R2_BUCKET') || 'gitea-lfs',
  };
  if (kind === 'ahub' && (!s.cypherUrl || !s.ns)) {
    throw new Error('TICKET_FORGE=ahub 但缺 AHUB_CYPHER_URL 或 AHUB_NS（installer/forge.conf）。不猜、不退回 Gitea——退回舊家要明確把 TICKET_FORGE 翻回 gitea。');
  }
  return s;
}

/** 版本發佈紀錄的主機：有填 RELEASE_FORGE_URL 就用它，否則用呼叫端宣告的（ship.targets.json 的 baseUrl）。 */
export function releaseForgeBase(declared, opts) {
  const s = resolveForgeSettings(opts);
  return s.releaseUrl || String(declared || LEGACY_FORGE_URL).replace(/\/+$/, '');
}

// ── AHub 直連 ────────────────────────────────────────────────────────────────

/**
 * 本 repo 用得到的 AHub 路由（真身：Arcrun `workflows/ahub/routes.json`）。
 * [method, pattern, workflow]。字面段勝過參數段，與橋同一套比對。
 */
export const AHUB_ROUTES = [
  ['GET', '/repos/:owner/:repo/issues/:index/comments', 'ahub__comment_list'],
  ['POST', '/repos/:owner/:repo/issues/:index/comments', 'ahub__comment_create'],
  ['GET', '/repos/:owner/:repo/issues/:index', 'ahub__issue_get'],
  ['PATCH', '/repos/:owner/:repo/issues/:index', 'ahub__issue_patch'],
  ['POST', '/repos/:owner/:repo/issues', 'ahub__issue_create'],
  ['GET', '/repos/:owner/:repo/issues', 'ahub__issue_list'],
  ['POST', '/repos/:owner/:repo/issues/:index/labels', 'ahub__issue_labels_add'],
  ['GET', '/repos/:owner/:repo', 'ahub__repo_get'],
  ['GET', '/user', 'ahub__whoami'],
  // 簽核看板（Arcrun AHub 0.8.0，inkstone/Arcrun#328）：出貨閘只問它「這一版放行了沒」，不自己讀留言判格式。
  ['GET', '/repos/:owner/:repo/issues/:index/signoffs', 'ahub__signoff_status'],
  // 版本發佈紀錄（Arcrun AHub 0.4.0，arcrun-hand/234-ahub-release）。
  // 附件只記指標 {name,size,sha256,url,r2_key}，不收檔案本體——檔案先寫 R2（release-forge.mjs）。
  ['POST', '/repos/:owner/:repo/releases', 'ahub__release_create'],
  ['GET', '/repos/:owner/:repo/releases', 'ahub__release_list'],
  ['GET', '/repos/:owner/:repo/releases/tags/:tag', 'ahub__release_by_tag'],
  ['GET', '/repos/:owner/:repo/releases/:id', 'ahub__release_get'],
  ['POST', '/repos/:owner/:repo/releases/:id/assets', 'ahub__release_asset_add'],
  ['GET', '/repos/:owner/:repo/releases/:id/assets', 'ahub__release_asset_list'],
];

export function matchAhubRoute(method, path, routes = AHUB_ROUTES) {
  const segs = path.split('/').filter(Boolean);
  let best = null;
  for (const [m, pattern, workflow] of routes) {
    if (m !== method) continue;
    const ps = pattern.split('/').filter(Boolean);
    if (ps.length !== segs.length) continue;
    const params = {};
    let lit = 0;
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(':')) params[ps[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (ps[i] === segs[i]) lit++;
      else { ok = false; break; }
    }
    if (ok && (!best || lit > best.lit)) best = { workflow, params, lit };
  }
  return best;
}

/** 把工作流的外層回應拆成 {status, body}；拆不出來回 null（呼叫端當 502）。與橋的 dispatch 同一套。 */
export function unwrapWorkflowReply(js) {
  const out = js && typeof js === 'object' ? js.data : null;
  const inner = out && typeof out === 'object' && out.data && typeof out.data === 'object' ? out.data : out;
  if (inner && typeof inner === 'object' && 'status' in inner) return { status: Number(inner.status), body: inner.body };
  return null;
}

/**
 * 一支與 `fetch` 介面相容的函式：收 Gitea 形狀的網址（任何 origin，只看 /api/v1/… 之後），
 * 轉成 AHub 具名工作流呼叫，回 Response。其餘 init（headers 的 Authorization、method、body）照 Gitea 的方式給。
 * 🔴 寫入不冪等（開票、留言）⇒ 這支自己**不重送**；要重試的讀取由呼叫端包 withRetry。
 */
export function makeAhubFetch({ cypherUrl, ns, fetchImpl = fetch }) {
  const base = String(cypherUrl || '').replace(/\/+$/, '');
  if (!base || !ns) throw new Error('makeAhubFetch 缺 cypherUrl 或 ns');
  return async function ahubFetch(url, init = {}) {
    const u = new URL(String(url), 'http://ahub.invalid');
    const i = u.pathname.indexOf('/api/v1/');
    if (i < 0) return jsonResponse(404, { message: 'ahub fetch 只轉 /api/v1/…' });
    const path = u.pathname.slice(i + '/api/v1'.length);
    const method = String(init.method || 'GET').toUpperCase();
    const m = matchAhubRoute(method, path);
    if (!m) {
      return jsonResponse(404, { message: `AHub 沒有這個端點：${method} ${path}（本 repo 只抄了用得到的幾條，真身是 Arcrun workflows/ahub/routes.json）` });
    }
    const hdr = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {});
    const auth = Object.entries(hdr).find(([k]) => k.toLowerCase() === 'authorization');
    const mt = auth ? String(auth[1]).trim().match(/^(?:token|bearer)\s+(.+)$/i) : null;
    let body = null;
    if (init.body != null && init.body !== '') {
      try { body = JSON.parse(String(init.body)); } catch { return jsonResponse(400, { message: 'body 不是 JSON' }); }
    }
    const query = {};
    for (const [k, v] of u.searchParams.entries()) query[k] = v;
    const envelope = { method, path, query, body, token: mt ? mt[1].trim() : '', params: m.params, base };
    const endpoint = `${base}/webhooks/named/${encodeURIComponent(ns)}/${m.workflow}/query`;
    const r = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'arcrun-rag-forge/1' },
      body: JSON.stringify(envelope),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const text = await r.text();
    let js;
    try { js = JSON.parse(text); } catch { js = text; }
    const un = r.status === 200 ? unwrapWorkflowReply(js) : null;
    if (un) return jsonResponse(un.status, un.body);
    // 引擎回 404 ＝ 這台 AHub 沒有這條工作流（版本太舊）——不是暫時性的，回 404＋code，不讓重試白打一次
    if (r.status === 404) return jsonResponse(404, { message: `這台 AHub 沒有 ${m.workflow}（版本太舊）`, code: 'workflow_missing', workflow: m.workflow });
    return jsonResponse(502, {
      message: `AHub 工作流沒有回 {status, body}（HTTP ${r.status}）`,
      detail: (typeof js === 'string' ? js : JSON.stringify(js)).slice(0, 600),
    });
  };
}

function jsonResponse(status, body) {
  const noBody = body == null || status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * 票的後端：回出貨線讀票要用的 { kind, baseUrl, fetchImpl, label }。
 *   gitea → baseUrl 是 Gitea 形狀網址；fetchImpl 是有界重試版（撐過 c10724 的連線掉包）
 *   ahub  → baseUrl 是 `ahub://<ns>`（只用來印訊息，不是真網址）；fetchImpl 直連工作流，
 *           逾時放寬到 90 秒（AHub 單次呼叫 5～20 秒，Arcrun#304 c20124），只重試 1 次
 */
export function ticketForge({ env = process.env, conf, fetchImpl = fetch } = {}) {
  const s = resolveForgeSettings(conf ? { env, conf } : { env });
  if (s.kind === 'ahub') {
    return {
      kind: 'ahub',
      baseUrl: `ahub://${s.ns}`,
      label: `AHub ${s.ns}@${s.cypherUrl}`,
      fetchImpl: withRetry({ fetchImpl: makeAhubFetch({ cypherUrl: s.cypherUrl, ns: s.ns, fetchImpl }), retries: 1, timeoutMs: 90000 }),
    };
  }
  return { kind: 'gitea', baseUrl: s.ticketUrl, label: `Gitea ${s.ticketUrl}`, fetchImpl: withRetry({ fetchImpl }) };
}

/**
 * 讀票用的 token（只拿名字對應的環境變數，不落地、不印）。
 *   ahub  → AHUB_TOKEN ｜ TICKET_FORGE_TOKEN；沒有就 null（呼叫端 fail-closed：AHub 沒 token 一律 401）
 *   gitea → TICKET_FORGE_TOKEN ｜ 呼叫端給的後備（例：本機 gitea remote 內嵌帳密）｜ GITEA_TOKEN_CLAUDE_CODE
 * 🔴 ahub 模式**不接受** Gitea 後備 token——那是別家的金鑰，送去 AHub 只會被當成無效身分。
 */
export function ticketToken(kind, { env = process.env, fallback } = {}) {
  const t = (k) => (env[k] && String(env[k]).trim()) || '';
  if (kind === 'ahub') return t('AHUB_TOKEN') || t('TICKET_FORGE_TOKEN') || null;
  return t('TICKET_FORGE_TOKEN') || fallback || t('GITEA_TOKEN_CLAUDE_CODE') || null;
}

export { KEYS as FORGE_CONF_KEYS };
