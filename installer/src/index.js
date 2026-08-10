/**
 * arcrun-rag 一鍵安裝器 worker（「工地主任」）— one-click-installer-design.md C 段。
 *
 * 純 module worker、零 runtime 依賴（只 import 兩個打包期產物 JSON）。
 * 職責＝在 Builds 部好 24 個平台 worker 之後，當「狀態頁 + 冪等補完台」：
 *   GET  /                辨識碼閘 → 進度 checklist（前端輪詢 /api/status）
 *   GET  /api/state       {verified} 給前端決定顯示閘還是 checklist
 *   POST /api/verify-code 打 landing 中央 API 驗辨識碼 + 綁 email（過閘前只開放這個）
 *   GET  /api/status      實查：24 worker /health、D1 表、kbdb templates、5 workflow（誠實逐項不假綠）
 *   POST /api/finish      冪等補完：D1 migration（TEST_D1 binding）→ /init/seed → templates×3 → 推 5 workflow
 *   POST /api/console      精靈代理：console setup→login→portal bootstrap（帳密用戶輸入，安裝器不存）
 *
 * 不重寫 RAG 邏輯：workflows.json 是既有 workflows/*.local.yaml 的搬運（打包期抽 flow/config），
 *   推送手法逐字對齊 install/push-demo-workflow.sh（sed 佔位 → /cypher/search 編圖 → /webhooks/named）。
 */

import WORKFLOWS from './workflows.json';
import MIGRATIONS from './migrations.json';

// 24 個平台 worker（deploy-all.mjs 部署的那批；健康檢查用）。
const WORKER_NAMES = [
  'arcrun-array-ops', 'arcrun-auth-oauth2', 'arcrun-auth-service-account', 'arcrun-auth-static-key',
  'arcrun-cron', 'arcrun-date-ops', 'arcrun-filter', 'arcrun-foreach-control', 'arcrun-http-request',
  'arcrun-if-control', 'arcrun-merge', 'arcrun-number-ops', 'arcrun-platform-crypto', 'arcrun-set',
  'arcrun-string-ops', 'arcrun-switch', 'arcrun-try-catch', 'arcrun-validate-json', 'arcrun-wait',
  'arcrun-code', 'arcrun-cypher-executor', 'arcrun-registry', 'arcrun-kbdb', 'arcrun-mcp',
];

// KBDB templates（抄 install/ensure-templates.mjs，slots 逐字對齊 kbdb-graph-plugin）。
const KBDB_TEMPLATES = [
  { name: 'triplet', slots: ['subject', 'predicate', 'object', 'source_block_id', 'confidence', 'clusters_json', 'bridge_score', 'subject_entity_type', 'object_entity_type', 'status', 'superseded_by', 'source_uri', 'content_hash', 'source_anchor', 'predicate_embed'], description: 'knowledge graph triplet (S-P-O)' },
  { name: 'entity', slots: ['canonical', 'aliases_json', 'entity_type', 'owner', 'gloss', 'embed', 'node_id'], description: 'normalized entity (canonical + aliases)' },
  { name: 'entity_pending', slots: ['raw_name', 'candidate_entity_id', 'candidate_canonical', 'similarity'], description: 'pending entity alias for review' },
];

const VERIFY_KEY = 'install:verified';
const FINISH_KEY = 'install:finish';

// ── 小工具 ──────────────────────────────────────────────────────────────────────
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** 從 env 組出實例的 base URL（明確 var 優先，否則由 WORKER_SUBDOMAIN 推導）。 */
function bases(env) {
  const sub = env.WORKER_SUBDOMAIN || '';
  const dev = (name) => (sub ? `https://${name}.${sub}.workers.dev` : '');
  return {
    sub,
    cypher: env.CYPHER_BASE || dev('arcrun-cypher-executor'),
    kbdb: env.KBDB_BASE || dev('arcrun-kbdb'),
    httpreq: env.HTTP_REQ_URL || dev('arcrun-http-request'),
    code: env.CODE_URL || dev('arcrun-code'),
  };
}

/** 佔位代換表（對齊 push-demo-workflow.sh 的 subs）。 */
function subsMap(env, b) {
  const ns = env.NAMESPACE || 'demo';
  return {
    '__NAMESPACE__': ns,
    '__CYPHER_BASE__': b.cypher,
    '__KBDB_BASE__': b.kbdb,
    '__HTTP_REQ_URL__': b.httpreq,
    '__CODE_URL__': b.code,
    '__LLM_MODEL__': env.LLM_MODEL || 'gemma-4-31b-it',
    '__GEMINI_API_KEY__': env.GEMINI_API_KEY || '',
    '__GITEA_BASE__': env.GITEA_BASE || 'https://git.uncle6.me',
    '__GITEA_TOKEN__': env.GITEA_TOKEN || '',
    '__DOCS_PREFIX__': env.DOCS_PREFIX || 'docs/',
    '__CARDS_DIR__': env.CARDS_DIR || 'system-dev/wiki/cards',
    '__CARDS_PREFIX__': (env.CARDS_DIR || 'system-dev/wiki/cards') + '/',
    '__INDEX_PATH__': env.INDEX_PATH || 'system-dev/wiki/00-INDEX.md',
    '__LIBRARY__': env.LIBRARY || 'kb',
    '__CF_ACCOUNT_ID__': env.CF_ACCOUNT_ID || '',
    '__R2_BUCKET__': env.R2_BUCKET || '',
    '__CF_R2_TOKEN__': env.CF_R2_TOKEN || env.CF_API_TOKEN || '',
    // graph_neighbors demo bake（push-demo-workflow.sh 同款）
    '{{input.kbdb_base}}': b.kbdb,
    '{{input.template}}': 'triplet',
    '{{input.namespace}}': ns,
  };
}

/** 對任意 JSON 結構做字串佔位代換（等價 push-demo 對 raw yaml 文字 replace）。 */
function applySubs(value, subs) {
  let s = JSON.stringify(value);
  for (const [k, v] of Object.entries(subs)) s = s.split(k).join(v);
  return JSON.parse(s);
}

async function reachable(url, timeoutMs = 4000) {
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500; // 收到任何 HTTP 回應 = worker 存在（未部署會連線失敗）
  } catch { return false; }
}

async function isVerified(env) {
  try {
    const raw = await env.SESSIONS_KV?.get(VERIFY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── 路由 ────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    try {
      if (p === '/' && method === 'GET') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (p === '/api/state' && method === 'GET') return handleState(env);
      if (p === '/api/verify-code' && method === 'POST') return handleVerify(request, env);

      // 進度自檢＝唯讀誠實健康資訊（公開 workers.dev / kbdb / cypher 探測），不含機敏值。
      // design F 段：用戶打開安裝器 URL 的第一畫面就是進度，辨識碼閘移到「設定管理員」步（G 段 4 格）。
      const gate0 = await isVerified(env);
      if (p === '/api/status' && method === 'GET') return handleStatus(env, gate0);

      // dev-only：本地離線驗收 / 預覽時用來標記已驗（僅當 INSTALLER_DEV==='true'；出貨 wrangler.jsonc 不設此 var）。
      if (p === '/api/_dev/verify' && method === 'POST' && env.INSTALLER_DEV === 'true') {
        await env.SESSIONS_KV?.put(VERIFY_KEY, JSON.stringify({ email: 'dev@local', code: 'DEV', at: Date.now() }));
        return json({ ok: true, dev: true });
      }

      // 以下皆需過辨識碼閘（design：驗過才開放寫入 / 設定類動作）
      const gate = gate0;
      if (!gate) return json({ error: '需要先通過辨識碼驗證（POST /api/verify-code）', verified: false }, 403);

      if (p === '/api/finish' && method === 'POST') return handleFinish(env);
      if (p === '/api/console' && method === 'POST') return handleConsole(request, env);
      if (p === '/api/gemini-key' && method === 'POST') return handleGeminiKey(request, env);

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
};

function handleState(env) {
  return isVerified(env).then((v) => json({ verified: !!v, email: v?.email ?? null, dev: env.INSTALLER_DEV === 'true' }));
}

async function handleVerify(request, env) {
  const body = await request.json().catch(() => null);
  const code = String(body?.code ?? '').trim();
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!code || !email) return json({ error: '辨識碼與 email 皆必填' }, 400);
  if (!env.LANDING_VERIFY_URL) return json({ error: '安裝器未設定 LANDING_VERIFY_URL（中央驗碼端點）' }, 500);

  let central;
  try {
    const res = await fetch(env.LANDING_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
      body: JSON.stringify({ code, email }),
      signal: AbortSignal.timeout(10000),
    });
    central = await res.json().catch(() => ({}));
    if (!res.ok || central?.ok === false || central?.valid === false) {
      return json({ error: central?.error || `辨識碼驗證未通過（HTTP ${res.status}）`, central }, 403);
    }
  } catch (e) {
    return json({ error: `連不上中央驗碼 API：${e instanceof Error ? e.message : e}` }, 502);
  }

  const record = { email, code, at: Date.now() };
  await env.SESSIONS_KV?.put(VERIFY_KEY, JSON.stringify(record));
  return json({ ok: true, email });
}

async function handleStatus(env, gate) {
  const b = bases(env);
  // 24 worker 健康（有 subdomain 才查得動）
  const workerDetail = {};
  let reach = 0;
  if (b.sub || env.CYPHER_BASE) {
    const results = await Promise.all(WORKER_NAMES.map((n) => reachable(b.sub ? `https://${n}.${b.sub}.workers.dev/health` : '')));
    WORKER_NAMES.forEach((n, i) => { workerDetail[n] = results[i]; if (results[i]) reach++; });
  } else {
    WORKER_NAMES.forEach((n) => { workerDetail[n] = false; });
  }

  // D1 表（走安裝器自己的 TEST_D1 binding；無 binding → 全 false）
  const d1 = { entries: false, templates: false, entry_values: false, credentials: false };
  if (env.TEST_D1) {
    try {
      const rs = await env.TEST_D1.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entries','templates','entry_values','credentials')",
      ).all();
      for (const row of rs.results || []) if (row.name in d1) d1[row.name] = true;
    } catch { /* binding 未綁或查詢失敗 → 保持 false（誠實） */ }
  }

  // kbdb templates（實查 GET /templates/{name} 200 = 存在，不只是 kbdb 活著）
  const tpl = {};
  for (const t of KBDB_TEMPLATES) tpl[t.name] = false;
  if (b.kbdb) {
    await Promise.all(KBDB_TEMPLATES.map(async (t) => {
      try {
        const res = await fetch(`${b.kbdb}/templates/${t.name}`, { signal: AbortSignal.timeout(4000) });
        tpl[t.name] = res.ok;
      } catch { tpl[t.name] = false; }
    }));
  }

  // 5 workflow 是否已推（GET {cypher}/webhooks/named，X-Arcrun-API-Key=NS）
  const wantWf = WORKFLOWS.map((w) => w.name);
  const wf = { present: [], missing: [...wantWf] };
  if (b.cypher) {
    try {
      const res = await fetch(`${b.cypher}/webhooks/named`, {
        headers: { 'X-Arcrun-API-Key': env.NAMESPACE || 'demo', 'user-agent': 'curl/8.5.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const names = new Set((data?.workflows || data?.webhooks || data?.names || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean));
        wf.present = wantWf.filter((n) => names.has(n));
        wf.missing = wantWf.filter((n) => !names.has(n));
      }
    } catch { /* cypher 不可達 → 全 missing（誠實） */ }
  }

  let lastFinish = null;
  try { const raw = await env.SESSIONS_KV?.get(FINISH_KEY); lastFinish = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }

  return json({
    verified: !!gate,
    email: gate?.email ?? null,
    subdomain: b.sub || null,
    bases: { cypher: b.cypher || null, kbdb: b.kbdb || null },
    workers: { reachable: reach, total: WORKER_NAMES.length, detail: workerDetail },
    d1_tables: d1,
    kbdb_templates: tpl,
    workflows: wf,
    last_finish: lastFinish,
    checked_at: new Date().toISOString(),
  });
}

async function handleFinish(env) {
  const b = bases(env);
  const subs = subsMap(env, b);
  const report = { steps: {}, at: new Date().toISOString() };

  // 1. D1 migration（TEST_D1 binding，逐句 run；全 IF NOT EXISTS / INSERT OR IGNORE → 冪等）
  const mig = { total: MIGRATIONS.statements.length, ok: 0, errors: [] };
  if (!env.TEST_D1) {
    mig.errors.push('TEST_D1 binding 未綁定');
  } else {
    for (const stmt of MIGRATIONS.statements) {
      try { await env.TEST_D1.prepare(stmt).run(); mig.ok++; }
      catch (e) { mig.errors.push(`${stmt.slice(0, 40)}…: ${e instanceof Error ? e.message : e}`); }
    }
  }
  report.steps.d1_migration = mig;

  // 2. seed（POST {cypher}/init/seed）
  report.steps.seed = await postJson(`${b.cypher}/init/seed`, {}, {});

  // 3. kbdb templates ×3（GET 探存在 → 不在才 POST；抄 ensure-templates.mjs）
  const tpl = { created: [], existed: [], errors: [] };
  for (const t of KBDB_TEMPLATES) {
    if (!b.kbdb) { tpl.errors.push(`${t.name}: KBDB base 未知`); continue; }
    try {
      const probe = await fetch(`${b.kbdb}/templates/${t.name}`, { signal: AbortSignal.timeout(5000) });
      if (probe.ok) { tpl.existed.push(t.name); continue; }
      const res = await fetch(`${b.kbdb}/templates`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
        body: JSON.stringify(t), signal: AbortSignal.timeout(8000),
      });
      if (res.ok) tpl.created.push(t.name);
      else tpl.errors.push(`${t.name}: HTTP ${res.status}`);
    } catch (e) { tpl.errors.push(`${t.name}: ${e instanceof Error ? e.message : e}`); }
  }
  report.steps.kbdb_templates = tpl;

  // 4. 推 5 workflow（佔位代換 → /cypher/search 編圖 → /webhooks/named；手法對齊 push-demo-workflow.sh）
  const pushed = [];
  for (const wf of WORKFLOWS) pushed.push(await pushWorkflow(b, env, subs, wf));
  report.steps.workflows = pushed;

  await env.SESSIONS_KV?.put(FINISH_KEY, JSON.stringify(report));
  return json(report);
}

/** 推一條 workflow（純 HTTP，不重寫 RAG；等價 push-demo-workflow.sh 的 python 段）。 */
async function pushWorkflow(b, env, subs, wf) {
  const name = wf.name;
  if (!b.cypher) return { name, ok: false, error: 'cypher base 未知' };
  try {
    const flow = applySubs(wf.flow, subs);
    const cfg = applySubs(wf.config, subs);
    const hdr = { 'content-type': 'application/json', 'X-Arcrun-API-Key': env.NAMESPACE || 'demo', 'user-agent': 'curl/8.5.0' };

    // 4a. 編圖
    const cres = await fetch(`${b.cypher}/cypher/search`, { method: 'POST', headers: hdr, body: JSON.stringify({ triplets: flow }), signal: AbortSignal.timeout(15000) });
    const compiled = await cres.json().catch(() => ({}));
    if (!cres.ok) return { name, ok: false, error: `/cypher/search HTTP ${cres.status}` };
    if (compiled?.missing?.length) return { name, ok: false, error: `缺零件: ${compiled.missing.join(', ')}` };
    const g = compiled.cypher;

    // 4b. 把 config 合進節點（逐字對齊 push-demo python：componentId + data 合併）
    const nodes = (g.nodes || []).map((node) => {
      const c = cfg[node.id];
      if (!c) return node;
      const params = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'component'));
      const n = { ...node };
      if (typeof c.component === 'string') n.componentId = c.component;
      if (Object.keys(params).length) n.data = { ...(node.data || {}), ...params };
      return n;
    });

    // 4c. 部署 named webhook
    const dres = await fetch(`${b.cypher}/webhooks/named`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ name, graph: { id: name, name, nodes, edges: g.edges || [] }, config: cfg, description: wf.description || '' }),
      signal: AbortSignal.timeout(15000),
    });
    const dbody = await dres.json().catch(() => ({}));
    if (!dres.ok) return { name, ok: false, error: `/webhooks/named HTTP ${dres.status}` };
    return { name, ok: true, webhook_url: dbody?.webhook_url };
  } catch (e) {
    return { name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 精靈代理：console setup（首次）→ 若 409 則 login → portal admin bootstrap。帳密不落地。 */
async function handleConsole(request, env) {
  const b = bases(env);
  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  const displayName = String(body?.display_name ?? '').trim() || email;
  if (!email || password.length < 8) return json({ error: 'email 必填、密碼至少 8 碼' }, 400);
  if (!b.cypher) return json({ error: 'cypher base 未知，無法設定 console' }, 400);

  const report = { setup: null, login: null, bootstrap: null };
  let sessionToken = '';

  // 1. setup（首次）；已設定過回 409 → 走 login
  const setup = await postJson(`${b.cypher}/console/setup`, { email, password }, {});
  report.setup = { status: setup.status, ok: setup.ok, message: setup.body?.error || setup.body?.message };
  if (setup.ok && setup.body?.session_token) sessionToken = setup.body.session_token;
  else {
    const login = await postJson(`${b.cypher}/console/login`, { email, password }, {});
    report.login = { status: login.status, ok: login.ok, message: login.body?.error };
    if (login.ok && login.body?.session_token) sessionToken = login.body.session_token;
  }

  if (!sessionToken) return json({ error: 'console 未取得 session（帳密不符或 setup/login 失敗）', report }, 502);

  // 2. portal admin bootstrap（需 console owner session；已有 admin 回 409＝冪等視為已就緒）
  const boot = await postJson(`${b.cypher}/portal/admin/bootstrap`, { email, password, display_name: displayName }, { authorization: `Bearer ${sessionToken}` });
  report.bootstrap = { status: boot.status, ok: boot.ok || boot.status === 409, message: boot.body?.error || boot.body?.message };

  return json({ ok: report.bootstrap.ok, report });
}

/**
 * Gemini 金鑰啟用：把用戶貼的 key 存進實例的憑證庫（namespace 認證，X-Arcrun-API-Key）。
 * design G 段：設定管理員後、裝完才問；不在安裝過程中問。
 * 實測（youlin 2026-07）：GET /credentials 200（namespace 認證即可讀）；
 *   POST /credentials 502「缺 CF_SECRETS_API_TOKEN / CF_ACCOUNT_ID，寫入路徑未就緒」
 *   ＝憑證寫入是平台級功能，需在 cypher worker 設 secrets 才開通（PR 級，非本安裝器可解）。
 * 因此這裡誠實把後端回應轉給前端：通了顯「AI 已啟用」，卡住顯後端原話 + 白話說明。安裝器不儲存 key。
 */
async function handleGeminiKey(request, env) {
  const b = bases(env);
  const body = await request.json().catch(() => null);
  const key = String(body?.key ?? '').trim();
  if (!key) return json({ ok: false, error: '請貼上 Gemini 金鑰' }, 400);
  if (!b.cypher) return json({ ok: false, error: '找不到你的實例位址（cypher base 未設定）' }, 400);

  const r = await postJson(`${b.cypher}/credentials`, { name: 'gemini_api_key', value: key }, { 'X-Arcrun-API-Key': env.NAMESPACE || 'demo' });
  if (r.ok) return json({ ok: true, message: 'AI 已啟用' });

  // 誠實回報：把後端錯誤原話帶回，讓前端顯示白話 + 技術原因。
  const backendMsg = r.body?.error || r.body?.message || `HTTP ${r.status}`;
  const platformGap = /CF_SECRETS_API_TOKEN|寫入路徑未就緒/.test(String(backendMsg));
  return json({
    ok: false,
    status: r.status,
    platform_gap: platformGap,
    error: backendMsg,
    hint: platformGap
      ? '你的實例尚未開通「憑證保險箱」寫入功能（平台端設定），金鑰暫時無法安全保存。這需要管理員在實例補上一項設定後才能啟用。'
      : '金鑰未能存入，請確認金鑰正確後再試一次。',
  }, 200);
}

/** POST JSON helper，回 {status, ok, body}；連線失敗回 status:0。不存密碼、不回傳 token 給前端以外用途。 */
async function postJson(url, payload, extraHeaders) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

// ── 三畫面安裝器 GUI（宣紙紙紋／墨字／琥珀金，Songti 襯線標題，深色模式；對齊 portal 設計）──
//   畫面一：安裝進度（打開就看到；輪詢 /api/status，刷新安全；勾選清單＋動態數字＋完成慶祝）
//   畫面二：設定管理員（4 格：辨識碼／Email／密碼／再輸入密碼 → verify-code → console setup）
//   畫面三：啟用 AI（貼 Gemini 免費金鑰 → /api/gemini-key；卡住誠實顯示原因）
const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arcrun RAG · 一鍵安裝</title>
<script>
  // 主題預載（防閃色）：跟隨系統，選擇存 localStorage（與 portal 同設計語言、不同 key）。
  (function(){try{var s=localStorage.getItem('arcrun_installer_theme');
    if(!s){s=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}
    document.documentElement.setAttribute('data-theme',s==='dark'?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();
</script>
<style>
  *{box-sizing:border-box}
  :root{
    --paper-a:#f4eddc;--paper-b:#f1e9d6;
    --ink:#2f2a20;--ink-rgb:30,24,14;
    --amber:#8a5f1e;--amber-rgb:138,95,30;--amber-hi:#b98330;--amber-lo:#e8b45a;
    --ok:#1d7a48;--ok-rgb:29,122,72;
    --err:#b03a26;--err-rgb:176,58,38;
    --card:rgba(30,24,14,.035);--line:rgba(30,24,14,.12);--well:rgba(30,24,14,.06);
    --shadow:0 8px 40px rgba(30,24,14,.10);
  }
  :root[data-theme="dark"]{
    --paper-a:#191410;--paper-b:#1b1611;
    --ink:#ede4d3;--ink-rgb:237,228,211;
    --amber:#e8b45a;--amber-rgb:232,180,90;--amber-hi:#b98330;--amber-lo:#f2d194;
    --ok:#7fe0a8;--ok-rgb:63,190,120;
    --err:#e58575;--err-rgb:217,95,76;
    --card:rgba(255,255,255,.03);--line:rgba(255,255,255,.10);--well:rgba(0,0,0,.22);
    --shadow:0 10px 44px rgba(0,0,0,.5);
  }
  html,body{margin:0;min-height:100%;color:var(--ink);
    background:repeating-linear-gradient(0deg,var(--paper-a) 0,var(--paper-a) 3px,var(--paper-b) 3px,var(--paper-b) 4px);
    font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
    font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
  input,button{font-family:inherit}
  ::placeholder{color:rgba(var(--ink-rgb),.32)}
  a{color:var(--amber);text-underline-offset:3px}
  .serif{font-family:'Songti TC','Noto Serif TC','LiSong Pro',PMingLiU,serif}
  .wrap{max-width:600px;margin:0 auto;padding:min(9vh,72px) 20px 80px;min-height:100vh;display:flex;flex-direction:column}
  .brand{text-align:center;margin-bottom:30px;animation:rise .6s ease both}
  .brand .logo{font-family:'Songti TC','Noto Serif TC','LiSong Pro',PMingLiU,serif;font-size:40px;letter-spacing:.26em;color:var(--amber);line-height:1}
  .brand .sub{margin-top:12px;font-size:13.5px;letter-spacing:.22em;color:rgba(var(--ink-rgb),.5)}
  .view{display:none;animation:rise .5s ease both}
  .view.on{display:block}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  @keyframes pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
  @keyframes pulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes sheen{0%{background-position:-160% 0}100%{background-position:260% 0}}

  /* ── hero 進度環 ── */
  .hero{text-align:center;padding:6px 0 4px}
  .ring{width:172px;height:172px;transform:rotate(-90deg)}
  .ring .bg{fill:none;stroke:var(--well);stroke-width:9}
  .ring .fg{fill:none;stroke:url(#grad);stroke-width:9;stroke-linecap:round;
    stroke-dasharray:326.7;stroke-dashoffset:326.7;transition:stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)}
  .ringwrap{position:relative;display:inline-block}
  .ringtxt{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .ringtxt .pct{font-family:'Songti TC','Noto Serif TC',serif;font-size:46px;font-weight:600;line-height:1;color:var(--ink)}
  .ringtxt .pct b{font-size:22px;font-weight:600;color:rgba(var(--ink-rgb),.5);margin-left:1px}
  .ringtxt .lab{margin-top:6px;font-size:13px;letter-spacing:.16em;color:rgba(var(--ink-rgb),.5)}
  .ringtxt .big{font-size:66px;color:var(--ok);animation:pop .6s ease both;line-height:1}
  .saying{margin:20px auto 4px;font-size:15.5px;color:rgba(var(--ink-rgb),.66);min-height:24px;transition:opacity .3s}

  /* ── 進度群組清單 ── */
  .list{margin-top:26px;display:flex;flex-direction:column;gap:12px}
  .item{background:var(--card);border:1px solid var(--line);border-radius:15px;padding:15px 17px;
    box-shadow:0 1px 0 rgba(255,255,255,.35) inset;transition:border-color .3s,background .3s}
  .item.done{border-color:rgba(var(--ok-rgb),.4);background:rgba(var(--ok-rgb),.05)}
  .item .top{display:flex;align-items:center;gap:12px}
  .icon{width:26px;height:26px;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;position:relative}
  .icon .dot{width:11px;height:11px;border-radius:50%;background:var(--amber-lo);animation:pulse 1.3s ease-in-out infinite}
  .icon.done{background:rgba(var(--ok-rgb),.16)}
  .icon.done .dot{display:none}
  .icon.done::after{content:"";width:8px;height:14px;border:solid var(--ok);border-width:0 2.6px 2.6px 0;transform:rotate(42deg) translateY(-1px);animation:pop .4s ease both}
  .icon.wait{background:rgba(var(--amber-rgb),.12)}
  .icon.wait .ring2{position:absolute;inset:0;border:2.4px solid rgba(var(--amber-rgb),.25);border-top-color:var(--amber);border-radius:50%;animation:spin .9s linear infinite}
  .icon.wait .dot{display:none}
  .name{font-weight:600;font-size:15.5px;letter-spacing:.02em}
  .count{margin-left:auto;font-family:'Songti TC','Noto Serif TC',serif;font-size:16px;color:var(--amber);font-weight:600;white-space:nowrap}
  .count.done{color:var(--ok)}
  .say{margin:9px 0 0 38px;font-size:13px;color:rgba(var(--ink-rgb),.5);line-height:1.55}
  .bar{margin:11px 0 0 38px;height:5px;border-radius:99px;background:var(--well);overflow:hidden}
  .bar>i{display:block;height:100%;border-radius:99px;width:0;background:linear-gradient(90deg,var(--amber-hi),var(--amber-lo));transition:width .8s cubic-bezier(.4,0,.2,1)}
  .item.done .bar>i{background:linear-gradient(90deg,var(--ok),var(--ok))}

  /* ── 完成 / CTA ── */
  .done-card{margin-top:26px;text-align:center;padding:30px 22px;border-radius:18px;
    border:1px solid rgba(var(--amber-rgb),.4);background:rgba(var(--amber-rgb),.07);box-shadow:var(--shadow);animation:pop .5s ease both}
  .done-card .seal{width:76px;height:76px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle at 36% 30%,var(--amber-lo),var(--amber-hi) 70%);box-shadow:0 0 34px rgba(var(--amber-rgb),.4)}
  .done-card .seal::after{content:"";width:15px;height:27px;border:solid #241804;border-width:0 4px 4px 0;transform:rotate(42deg) translateY(-2px)}
  .done-card h2{font-family:'Songti TC','Noto Serif TC',serif;font-size:23px;margin:0 0 6px;letter-spacing:.08em}
  .done-card p{margin:0 0 20px;font-size:14.5px;color:rgba(var(--ink-rgb),.62)}

  /* ── 表單元件 ── */
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 24px;box-shadow:var(--shadow)}
  .vhead{text-align:center;margin-bottom:22px}
  .vhead .t{font-family:'Songti TC','Noto Serif TC',serif;font-size:25px;letter-spacing:.1em;margin-bottom:8px}
  .vhead .d{font-size:14px;color:rgba(var(--ink-rgb),.58);line-height:1.65}
  .steps{display:flex;justify-content:center;gap:8px;margin-bottom:24px}
  .steps i{width:7px;height:7px;border-radius:50%;background:rgba(var(--ink-rgb),.18)}
  .steps i.on{background:var(--amber);width:22px;border-radius:99px}
  label{display:block;font-size:13px;font-weight:600;margin:16px 0 7px;letter-spacing:.04em}
  label:first-of-type{margin-top:0}
  .txt{width:100%;padding:13px 15px;font-size:16px;border-radius:11px;border:1.5px solid var(--line);
    background:rgba(var(--ink-rgb),.04);color:var(--ink);transition:border-color .2s}
  .txt:focus{outline:none;border-color:rgba(var(--amber-rgb),.6);background:rgba(var(--amber-rgb),.04)}
  .txt.bad{border-color:rgba(var(--err-rgb),.6)}
  .fhint{font-size:12px;color:rgba(var(--ink-rgb),.45);margin-top:6px}
  .btn{width:100%;margin-top:24px;padding:14px;font-size:16px;font-weight:700;letter-spacing:.06em;border:none;border-radius:12px;
    background:linear-gradient(90deg,var(--amber-hi),var(--amber-lo));color:#241804;cursor:pointer;
    box-shadow:0 4px 16px rgba(var(--amber-rgb),.28);transition:transform .1s,box-shadow .2s,filter .2s}
  .btn:hover{filter:brightness(1.05);box-shadow:0 6px 22px rgba(var(--amber-rgb),.38)}
  .btn:active{transform:translateY(1px)}
  .btn:disabled{opacity:.5;cursor:default;box-shadow:none;filter:saturate(.6)}
  .btn.loading{position:relative;color:transparent}
  .btn.loading::after{content:"";position:absolute;inset:0;margin:auto;width:19px;height:19px;border-radius:50%;
    border:2.6px solid rgba(36,24,4,.3);border-top-color:#241804;animation:spin .8s linear infinite}
  .btn.ghost{background:none;color:var(--amber);border:1.5px solid rgba(var(--amber-rgb),.5);box-shadow:none;margin-top:12px}
  .msg{margin-top:16px;padding:12px 14px;border-radius:11px;font-size:14px;line-height:1.6;display:none}
  .msg.show{display:block;animation:rise .3s ease both}
  .msg.bad{background:rgba(var(--err-rgb),.1);border:1px solid rgba(var(--err-rgb),.3);color:var(--err)}
  .msg.good{background:rgba(var(--ok-rgb),.1);border:1px solid rgba(var(--ok-rgb),.3);color:var(--ok)}
  .msg .sub{display:block;margin-top:5px;font-size:12.5px;color:rgba(var(--ink-rgb),.55)}
  .applylink{display:block;text-align:center;margin-top:16px;font-size:14px}

  /* ── AI 啟用成功 ── */
  .celebrate{text-align:center;padding:14px 0}
  .celebrate .spark{font-size:56px;animation:pop .6s ease both}
  .celebrate h2{font-family:'Songti TC','Noto Serif TC',serif;font-size:24px;letter-spacing:.08em;margin:10px 0 6px}
  .celebrate p{font-size:14.5px;color:rgba(var(--ink-rgb),.62)}

  /* ── 頁尾 / 主題鈕 / 預覽導覽 ── */
  .foot{margin-top:auto;padding-top:34px;text-align:center;font-size:12px;color:rgba(var(--ink-rgb),.4);letter-spacing:.04em}
  .foot .sep{margin:0 8px;opacity:.5}
  .theme{position:fixed;top:16px;right:16px;z-index:40;padding:8px 14px;font-size:13px;border-radius:99px;cursor:pointer;
    border:1px solid var(--line);background:var(--card);color:rgba(var(--ink-rgb),.7);backdrop-filter:blur(6px)}
  .pvnav{position:fixed;top:16px;left:16px;z-index:40;display:none;gap:6px;padding:5px;border-radius:99px;
    border:1px solid rgba(var(--amber-rgb),.35);background:var(--card);backdrop-filter:blur(6px);font-size:12px}
  .pvnav.on{display:flex}
  .pvnav b{padding:5px 11px;border-radius:99px;cursor:pointer;color:rgba(var(--ink-rgb),.6);font-weight:500}
  .pvnav b.on{background:rgba(var(--amber-rgb),.16);color:var(--amber);font-weight:700}
  .pvnav .tag{padding:5px 8px;color:rgba(var(--ink-rgb),.4);font-weight:700;letter-spacing:.06em}
</style></head><body>
<button class="theme" id="themebtn" onclick="toggleTheme()">切換深色</button>
<div class="pvnav" id="pvnav"><span class="tag">預覽</span>
  <b data-go="progress">進度</b><b data-go="__done">完成</b><b data-go="admin">管理員</b><b data-go="gemini">AI</b></div>

<div class="wrap">
  <div class="brand"><div class="logo serif">Arcrun&nbsp;RAG</div><div class="sub">O N E - C L I C K &nbsp; I N S T A L L &nbsp;·&nbsp; 一鍵安裝</div></div>

  <!-- 畫面一：進度 -->
  <div class="view" id="v-progress">
    <div class="hero">
      <div class="ringwrap">
        <svg class="ring" viewBox="0 0 120 120">
          <defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="var(--amber-hi)"/><stop offset="1" stop-color="var(--amber-lo)"/></linearGradient></defs>
          <circle class="bg" cx="60" cy="60" r="52"/><circle class="fg" id="ringfg" cx="60" cy="60" r="52"/>
        </svg>
        <div class="ringtxt" id="ringtxt"><div class="pct" id="pct">0<b>%</b></div><div class="lab">就緒程度</div></div>
      </div>
      <div class="saying" id="saying">正在為你點亮知識引擎…</div>
    </div>
    <div class="list" id="list"></div>
    <div id="doneCta"></div>
  </div>

  <!-- 畫面二：設定管理員 -->
  <div class="view" id="v-admin">
    <div class="steps"><i></i><i class="on"></i><i></i></div>
    <div class="card">
      <div class="vhead"><div class="t serif">設定管理員</div>
        <div class="d">這是你知識庫的主人帳號——只有你能登入管理。<br>輸入封測辨識碼綁定，並設定登入帳密。</div></div>
      <label>封測辨識碼</label>
      <input class="txt" id="a-code" placeholder="ARCRUN-xxxx" autocomplete="off">
      <div class="fhint">在 landing 頁填 email 換取的辨識碼。</div>
      <label>管理員 Email</label>
      <input class="txt" id="a-email" type="email" placeholder="you@example.com" autocomplete="email">
      <label>密碼</label>
      <input class="txt" id="a-pw" type="password" placeholder="至少 8 碼" autocomplete="new-password">
      <label>再輸入密碼</label>
      <input class="txt" id="a-pw2" type="password" placeholder="再打一次確認" autocomplete="new-password">
      <div class="fhint" id="a-pwhint"></div>
      <button class="btn" id="a-btn" onclick="doAdmin()">建立管理員帳號</button>
      <div class="msg" id="a-msg"></div>
    </div>
  </div>

  <!-- 畫面三：啟用 AI -->
  <div class="view" id="v-gemini">
    <div class="steps"><i></i><i></i><i class="on"></i></div>
    <div class="card">
      <div id="g-form">
        <div class="vhead"><div class="t serif">啟用 AI 問答</div>
          <div class="d"><b>你的知識庫已就緒 🎉</b><br>貼上 Gemini 免費金鑰，讓 AI 讀懂你的知識庫、用自然語言回答你。</div></div>
        <label>Gemini API 金鑰</label>
        <input class="txt" id="g-key" placeholder="AIza…" autocomplete="off">
        <a class="applylink" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">還沒有金鑰？30 秒免費申請 →</a>
        <button class="btn" id="g-btn" onclick="doGemini()">啟用 AI</button>
        <div class="msg" id="g-msg"></div>
      </div>
      <div class="celebrate" id="g-done" style="display:none">
        <div class="spark">✨</div><h2 class="serif">AI 已啟用</h2>
        <p>你的知識庫現在能用自然語言問答了。<br>回到你的實例，開始上傳知識吧。</p>
      </div>
    </div>
  </div>

  <div class="foot"><span>Arcrun RAG</span><span class="sep">·</span><span id="foot-inst">安裝器</span></div>
</div>

<script>
// ── 小工具 ──
function $(id){return document.getElementById(id)}
function jget(u){return fetch(u).then(function(r){return r.json()})}
function jpost(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json().catch(function(){return{}})})}
function show(id){var vs=['v-progress','v-admin','v-gemini'];for(var i=0;i<vs.length;i++)$(vs[i]).classList.toggle('on',vs[i]==='v-'+id);
  var ps=document.querySelectorAll('#pvnav b');for(var j=0;j<ps.length;j++)ps[j].classList.toggle('on',ps[j].getAttribute('data-go')===id);
  window.scrollTo({top:0,behavior:'smooth'})}
function toggleTheme(){var d=document.documentElement.getAttribute('data-theme')==='dark';var t=d?'light':'dark';
  document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('arcrun_installer_theme',t)}catch(e){}
  $('themebtn').textContent=t==='dark'?'切換淺色':'切換深色'}

// ── 進度群組定義（映射 /api/status；每組一句安心話）──
var GROUPS=[
  {id:'workers',name:'知識引擎',say:'24 個運算節點正在上線，這是你知識庫的大腦。'},
  {id:'db',name:'資料庫',say:'你的知識全部存在自己的雲端，沒有第三方。'},
  {id:'templates',name:'知識模板',say:'三元組結構備妥，讓知識能被連結與推理。'},
  {id:'flows',name:'搜尋流程',say:'關鍵字＋語義＋圖譜三路檢索與問答流程。'},
];
var prevCounts={};
function computeGroups(s){
  var w=s.workers||{reachable:0,total:24};
  var d=s.d1_tables||{};var dt=['entries','templates','entry_values','credentials'];
  var dDone=0;for(var i=0;i<dt.length;i++)if(d[dt[i]])dDone++;
  var t=s.kbdb_templates||{};var tk=['triplet','entity','entity_pending'];
  var tDone=0;for(var k=0;k<tk.length;k++)if(t[tk[k]])tDone++;
  var wf=s.workflows||{present:[],missing:[]};
  var fTotal=(wf.present.length+wf.missing.length)||5;
  return {
    workers:{done:w.reachable||0,total:w.total||24},
    db:{done:dDone,total:dt.length},
    templates:{done:tDone,total:tk.length},
    flows:{done:wf.present.length,total:fTotal},
  };
}
function animateCount(el,from,to,total){
  from=from||0;var start=performance.now();var dur=650;
  function step(now){var p=Math.min(1,(now-start)/dur);var v=Math.round(from+(to-from)*(p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2));
    el.textContent=v+' / '+total;if(p<1)requestAnimationFrame(step)}
  requestAnimationFrame(step);
}
function renderList(g){
  var list=$('list');var html='';
  for(var i=0;i<GROUPS.length;i++){var G=GROUPS[i];var c=g[G.id];var done=c.done>=c.total&&c.total>0;
    html+='<div class="item'+(done?' done':'')+'" id="it-'+G.id+'">'
      +'<div class="top"><span class="icon '+(done?'done':'wait')+'" id="ic-'+G.id+'">'
      +(done?'':'<span class="ring2"></span><span class="dot"></span>')+'</span>'
      +'<span class="name">'+G.name+'</span>'
      +'<span class="count'+(done?' done':'')+'" id="ct-'+G.id+'">'+c.done+' / '+c.total+'</span></div>'
      +'<div class="say">'+G.say+'</div>'
      +'<div class="bar"><i id="bar-'+G.id+'"></i></div></div>';
  }
  list.innerHTML=html;updateList(g,true);
}
function updateList(g,first){
  for(var i=0;i<GROUPS.length;i++){var G=GROUPS[i];var c=g[G.id];var done=c.done>=c.total&&c.total>0;
    var it=$('it-'+G.id);if(!it)return renderList(g);
    it.classList.toggle('done',done);
    var ic=$('ic-'+G.id);ic.className='icon '+(done?'done':'wait');ic.innerHTML=done?'':'<span class="ring2"></span><span class="dot"></span>';
    var ct=$('ct-'+G.id);ct.classList.toggle('done',done);
    animateCount(ct,first?0:(prevCounts[G.id]||0),c.done,c.total);
    prevCounts[G.id]=c.done;
    $('bar-'+G.id).style.width=(c.total?Math.round(c.done/c.total*100):0)+'%';
  }
}
var SAYINGS=['正在為你點亮知識引擎…','資料庫正在成形…','快好了，正在接上搜尋流程…','就快完成了…'];
var lastPct=0,ranDone=false;
function renderProgress(s){
  var g=computeGroups(s);
  var totalItems=0,doneItems=0;for(var i=0;i<GROUPS.length;i++){totalItems+=g[GROUPS[i].id].total;doneItems+=g[GROUPS[i].id].done}
  var pct=totalItems?Math.round(doneItems/totalItems*100):0;
  if($('list').children.length===0)renderList(g);else updateList(g,false);
  // 環
  var C=326.7;$('ringfg').style.strokeDashoffset=(C*(1-pct/100)).toFixed(1);
  // 數字動畫
  var from=lastPct;var start=performance.now();
  (function(){function step(now){var p=Math.min(1,(now-start)/700);var v=Math.round(from+(pct-from)*(p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2));
    $('pct').innerHTML=v+'<b>%</b>';if(p<1)requestAnimationFrame(step)}requestAnimationFrame(step)})();
  lastPct=pct;
  // 安心話
  var sIdx=Math.min(SAYINGS.length-1,Math.floor(pct/100*SAYINGS.length));
  if(pct<100)$('saying').textContent=SAYINGS[sIdx];
  if(pct>=100){onAllDone()}
}
function onAllDone(){
  $('saying').textContent='全部就緒！你的知識庫已經活過來了。';
  $('ringtxt').innerHTML='<div class="pct big">✓</div><div class="lab">安裝完成</div>';
  if(!ranDone){ranDone=true;
    $('doneCta').innerHTML='<div class="done-card"><div class="seal"></div>'
      +'<h2 class="serif">你的知識庫已就緒</h2>'
      +'<p>24 個引擎、資料庫、搜尋流程全部上線。<br>下一步：設定你的管理員帳號。</p>'
      +'<button class="btn" onclick="show(\\'admin\\')">下一步：設定管理員 →</button></div>';
  }
}

// ── 輪詢（刷新安全：狀態全在伺服器，重載續接不歸零）──
var polling=false;
function poll(){
  jget('/api/status').then(function(s){
    if(s&&!s.error)renderProgress(s);
  }).catch(function(){}).then(function(){
    if(!ranDone&&polling)setTimeout(poll,2500);
  });
}

// ── 畫面二：設定管理員 ──
function pwCheck(){
  var pw=$('a-pw').value,pw2=$('a-pw2').value;var h=$('a-pwhint');
  if(!pw2){h.textContent='';$('a-pw2').classList.remove('bad');return}
  if(pw!==pw2){h.textContent='兩次密碼不一致';h.style.color='var(--err)';$('a-pw2').classList.add('bad')}
  else{h.textContent='密碼一致 ✓';h.style.color='var(--ok)';$('a-pw2').classList.remove('bad')}
}
function msg(id,kind,text,sub){var m=$(id);m.className='msg show '+kind;m.innerHTML=text+(sub?'<span class="sub">'+sub+'</span>':'')}
function doAdmin(){
  var code=$('a-code').value.trim(),email=$('a-email').value.trim(),pw=$('a-pw').value,pw2=$('a-pw2').value;
  var m=$('a-msg');m.className='msg';
  if(!code)return msg('a-msg','bad','請填入封測辨識碼。');
  if(!email||email.indexOf('@')<0)return msg('a-msg','bad','請填入正確的 Email。');
  if(pw.length<8)return msg('a-msg','bad','密碼至少要 8 碼。');
  if(pw!==pw2)return msg('a-msg','bad','兩次輸入的密碼不一致。');
  var btn=$('a-btn');btn.disabled=true;btn.classList.add('loading');
  jpost('/api/verify-code',{code:code,email:email}).then(function(v){
    if(!v||!v.ok){throw{step:'verify',error:(v&&v.error)||'辨識碼驗證未通過'}}
    return jpost('/api/console',{email:email,password:pw,display_name:email});
  }).then(function(c){
    btn.disabled=false;btn.classList.remove('loading');
    if(c&&c.ok){msg('a-msg','good','管理員帳號已建立，正在帶你去啟用 AI…');setTimeout(function(){show('gemini')},900)}
    else{msg('a-msg','bad','帳號設定未完成',(c&&(c.error||(c.report&&JSON.stringify(c.report))))||'請稍後再試')}
  }).catch(function(e){
    btn.disabled=false;btn.classList.remove('loading');
    if(e&&e.step==='verify')msg('a-msg','bad','辨識碼或 Email 有誤',e.error);
    else msg('a-msg','bad','設定時發生問題',(e&&(e.error||e.message))||'請稍後再試');
  });
}

// ── 畫面三：啟用 AI ──
function doGemini(){
  var key=$('g-key').value.trim();var m=$('g-msg');m.className='msg';
  if(!key)return msg('g-msg','bad','請貼上你的 Gemini 金鑰。');
  var btn=$('g-btn');btn.disabled=true;btn.classList.add('loading');
  jpost('/api/gemini-key',{key:key}).then(function(r){
    btn.disabled=false;btn.classList.remove('loading');
    if(r&&r.ok){$('g-form').style.display='none';$('g-done').style.display='block'}
    else{msg('g-msg','bad',(r&&r.hint)||'金鑰未能啟用',(r&&r.error)?('技術原因：'+r.error):'')}
  }).catch(function(){btn.disabled=false;btn.classList.remove('loading');msg('g-msg','bad','連線失敗，請稍後再試。')});
}

// ── 啟動 ──
$('a-pw').addEventListener('input',pwCheck);$('a-pw2').addEventListener('input',pwCheck);
$('themebtn').textContent=document.documentElement.getAttribute('data-theme')==='dark'?'切換淺色':'切換深色';
// 預覽完成畫面（僅 INSTALLER_DEV；不改真實 status，只把進度視覺推到 100% 讓 leo 看慶祝設計）
function previewDone(){polling=false;$('ringfg').style.strokeDashoffset='0';$('pct').innerHTML='100<b>%</b>';
  var full={workers:{done:24,total:24},db:{done:4,total:4},templates:{done:3,total:3},flows:{done:5,total:5}};
  if($('list').children.length===0)renderList(full);else updateList(full,false);
  onAllDone();show('progress')}
document.querySelectorAll('#pvnav b').forEach(function(b){var t=b.getAttribute('data-go');
  b.onclick=(t==='__done')?previewDone:function(){show(t)}});
jget('/api/state').then(function(st){
  if(st&&st.dev){$('pvnav').classList.add('on');
    // 預覽模式：先自標已驗，讓 leo 直接點「啟用 AI／設定管理員」打真後端、看真實回應與錯誤 UX。
    if(!st.verified)jpost('/api/_dev/verify',{});}
  if(st&&st.email)$('a-email').value=st.email;
}).catch(function(){});
show('progress');polling=true;poll();
</script>
</body></html>`;
