/**
 * front-door.mjs — 出貨驗收的「正門」：站在 AI 的位置，從 MCP 連線走一遍「寫意圖 → 做出一條會跑的工作流」
 *
 * 為什麼有它（inkstone/Arcrun#461，leo 2026-11-18）：
 *   inkstone/Arcrun#460——MCP 查零件三支工具在 leo21c／geek6688／stage 全壞了約兩個月，沒人發現。
 *   因為工人寫工作流都走捷徑（`acr parts` 寫死清單、直接打引擎），stage 驗收只看「引擎活著、工作流跑得動」，
 *   **沒有任何一項是從 AI 實際用的那扇門走一遍**。leo：「會有另一個這種事情明明斷了但每個人都抄捷徑都沒發現？
 *   這是正確的路，把意圖寫了去做出來不是嗎？」
 *
 * 正門＝只有 MCP 連線、沒有 repo、沒有 CLI 的 AI，照連線自帶說明的順序走：
 *   ① 連線自帶說明（initialize.instructions）有指路到 write_intent_workflow
 *   ② arcrun_get_skill('write_intent_workflow') 拿得到
 *   ③ arcrun_search_components 查得到 http_request（#460 斷的就是這一環）
 *   ④ arcrun_get_component 拿得到 input_schema
 *   ⑤ arcrun_list_components 非空
 *   ⑥ POST /cypher/search 意圖媒合：http_request 是 found（不是 unknown／not_found）
 *   ⑦ arcrun_validate_yaml 校驗過
 *   ⑧ arcrun_push_workflow 推得上去（抓一個網址回 JSON 的小工作流）——寫入類，只在 `write: true` 走
 *   ⑨ arcrun_run_workflow 跑得動
 *   ⑩ arcrun_list_recent_executions 看得到 verdict=success
 *   ⑪ 收掉探針（arcrun_delete_workflow）
 *
 * 判準：**任何一環斷 ⇒ 這一版不算驗過**，而且要說得出斷在哪一環、為什麼。
 * 一環斷了，依賴它的後面幾環標「前面斷了，沒跑」，不是空白、也不是假綠。
 *
 * 純函式＋fetch 注入，可離線演練（見 front-door.test.mjs，含「故意弄斷一環就擋」）。
 */

const PROBE_PREFIX = 'front_door_probe';

/** 解 MCP 回應：JSON 或 SSE（`event: message\ndata: {...}`）都收。 */
export function parseMcpBody(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  const datas = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (let i = datas.length - 1; i >= 0; i--) { try { return JSON.parse(datas[i]); } catch { /* 下一行 */ } }
  return null;
}

/** 一次 JSON-RPC 呼叫。回 { ok, result, error }；網路／認證／協定錯誤都收成 error 字串（不丟）。 */
async function rpc({ mcpUrl, token, fetchImpl, id, method, params, retry401 = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let res;
  for (let attempt = 0; ; attempt++) {
  try {
    res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  } catch (e) {
    return { ok: false, error: `連不上 MCP（${e && e.message ? e.message : e}）` };
  }
  // 剛寫的一次性 Secret 要幾秒傳播到各個 isolate：401 有界重試（真的不認，重試完仍是 401 ⇒ 照樣斷）
  if (res.status === 401 && attempt < retry401) { await res.text().catch(() => ''); await sleep(2000); continue; }
  break;
  }
  const text = await res.text().catch(() => '');
  const body = parseMcpBody(text);
  if (res.status === 401 || (body && body.error === 'unauthorized')) {
    return { ok: false, error: `MCP 不認這把金鑰（HTTP ${res.status}）：${text.slice(0, 160)}` };
  }
  if (!res.ok && !body) return { ok: false, error: `MCP 回 HTTP ${res.status}：${text.slice(0, 160)}` };
  if (!body) return { ok: false, error: `MCP 回的不是 JSON-RPC（HTTP ${res.status}）：${text.slice(0, 160)}` };
  if (body.error) return { ok: false, error: `JSON-RPC 錯誤：${JSON.stringify(body.error).slice(0, 200)}` };
  return { ok: true, result: body.result };
}

/** 呼叫一支工具，把 isError 也當成失敗，回工具吐出的文字。 */
async function callTool(ctx, name, args) {
  const r = await rpc({ ...ctx, id: ctx.nextId(), method: 'tools/call', params: { name, arguments: args } });
  if (!r.ok) return { ok: false, text: '', error: r.error };
  const content = (r.result && r.result.content) || [];
  const text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  if (r.result && r.result.isError) return { ok: false, text, error: text.slice(0, 240) || '工具回報錯誤' };
  return { ok: true, text };
}

function tryJson(text) { try { return JSON.parse(text); } catch { return null; } }

/** 探針工作流：抓一個網址回 JSON（網址＝實例自己的 /health，一定是 JSON、不依賴外網）。 */
export function probeYaml(name, url) {
  return [
    `name: ${name}`,
    'description: 出貨正門驗收用的探針（跑完即刪）',
    'flow:',
    '  - "input >> ON_SUCCESS >> fetch_json"',
    'config:',
    '  fetch_json:',
    '    component: http_request',
    `    url: "${url}"`,
    '    method: GET',
    '',
  ].join('\n');
}

export const PROBE_GRAPH = {
  id: PROBE_PREFIX, name: PROBE_PREFIX,
  nodes: [{ id: 'input', type: 'Input' }, { id: 'fetch_json', type: 'Component', component: 'http_request' }],
  edges: [{ from: 'input', to: 'fetch_json', type: 'ON_SUCCESS' }],
};

/**
 * 走一遍正門。
 * @param {object} o
 * @param {string} o.mcpUrl     MCP 端點（例 https://arcrun-mcp.<子網域>.workers.dev/mcp）
 * @param {string} o.token      MCP 的 Bearer（只讀環境變數取得，這裡不印）
 * @param {string} [o.cypherUrl]  /cypher/search 的主機（與 namespace 一起給才走第 ⑥ 環）
 * @param {string} [o.namespace]
 * @param {boolean} [o.write]   要不要走寫入類的環（push／run／delete）
 * @param {string} [o.probeUrl] 探針要抓的網址（預設 `${cypherUrl}/health`）
 * @returns {Promise<{ ok: boolean, brokenAt: string|null, rings: Array<{id,name,status,detail}> }>}
 */
export async function walkFrontDoor({
  mcpUrl, token, cypherUrl = '', namespace = '', write = false, probeUrl = '',
  fetchImpl = fetch, now = () => Date.now(), retry401 = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let seq = 0;
  const ctx = { mcpUrl, token, fetchImpl, nextId: () => ++seq, retry401, sleep };
  const rings = [];
  let broken = null; // 第一個斷的環（寫入類的環拿來標「前面斷了」）
  const probeName = `${PROBE_PREFIX}_${now().toString(36)}`;
  let pushed = false;

  const run = async (id, name, fn) => {
    let out;
    try { out = await fn(); } catch (e) { out = { ok: false, detail: `例外：${e && e.message ? e.message : e}` }; }
    rings.push({ id, name, status: out.ok ? 'ok' : 'broken', detail: out.detail });
    if (!out.ok && !broken) broken = `第${id}環 ${name}`;
    return out.ok;
  };
  const skip = (id, name) => rings.push({ id, name, status: 'skipped', detail: `前面斷了（${broken}），沒跑` });

  await run('1', '連線自帶說明指路到 write_intent_workflow', async () => {
    const r = await rpc({ ...ctx, id: ctx.nextId(), method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ship-front-door', version: '1' } } });
    if (!r.ok) return { ok: false, detail: r.error };
    const ins = String((r.result && r.result.instructions) || '');
    if (!ins.includes('write_intent_workflow')) return { ok: false, detail: '說明文字沒有提到 write_intent_workflow——AI 不知道從哪開始' };
    return { ok: true, detail: `說明 ${ins.length} 字，含 write_intent_workflow` };
  });

  await run('2', 'get_skill(write_intent_workflow) 拿得到', async () => {
    const r = await callTool(ctx, 'arcrun_get_skill', { slug: 'write_intent_workflow' });
    if (!r.ok) return { ok: false, detail: r.error };
    if (!r.text.includes('意圖')) return { ok: false, detail: `回了東西但不像那支 skill（${r.text.slice(0, 80)}）` };
    return { ok: true, detail: `${r.text.length} 字` };
  });

  await run('3', 'search_components 查得到 http_request', async () => {
    const r = await callTool(ctx, 'arcrun_search_components', { query: 'HTTP 請求' });
    if (!r.ok) return { ok: false, detail: r.error };
    if (!r.text.includes('http_request')) return { ok: false, detail: `回的清單沒有 http_request（${r.text.slice(0, 120)}）` };
    return { ok: true, detail: '清單含 http_request' };
  });

  await run('4', 'get_component(http_request) 拿得到 input_schema', async () => {
    const r = await callTool(ctx, 'arcrun_get_component', { canonical_id: 'http_request' });
    if (!r.ok) return { ok: false, detail: r.error };
    if (!r.text.includes('input_schema')) return { ok: false, detail: `回的合約沒有 input_schema（${r.text.slice(0, 120)}）` };
    return { ok: true, detail: `合約 ${r.text.length} 字，含 input_schema` };
  });

  await run('5', 'list_components 回非空清單', async () => {
    const r = await callTool(ctx, 'arcrun_list_components', {});
    if (!r.ok) return { ok: false, detail: r.error };
    const j = tryJson(r.text);
    const body = j && (j.data !== undefined ? j.data : j);
    const arr = Array.isArray(body) ? body : (body && (body.components || body.records || body.items));
    const n = Array.isArray(arr) ? arr.length : (r.text.includes('http_request') ? 1 : 0);
    if (!n) return { ok: false, detail: `清單是空的（${r.text.slice(0, 120)}）` };
    return { ok: true, detail: Array.isArray(arr) ? `${n} 顆` : '有內容' };
  });

  await run('6', '/cypher/search 意圖媒合：http_request 是 found', async () => {
    if (!cypherUrl || !namespace) return { ok: false, detail: '沒有給 cypher 網址或 namespace，這一環沒法走（登錄簿要宣告）' };
    let res;
    try {
      res = await fetchImpl(`${cypherUrl.replace(/\/$/, '')}/cypher/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-arcrun-api-key': namespace },
        body: JSON.stringify({ triplets: ['input >> ON_SUCCESS >> http_request'] }),
      });
    } catch (e) { return { ok: false, detail: `連不上（${e && e.message ? e.message : e}）` }; }
    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}：${text.slice(0, 160)}` };
    const j = tryJson(text);
    // 真實形狀（2026-11-18 對 youlin 實打）：`nodes` 是以節點名為鍵的物件 `{ http_request: { status: "found", ... } }`；
    // 也容許陣列形狀。讀不出就是讀不出（status=null ⇒ 斷），不靠「全文有 found 字樣」猜。
    const nodes = j && (j.nodes || (j.data && j.data.nodes));
    let hit = null;
    if (Array.isArray(nodes)) hit = nodes.find((n) => n && (n.name === 'http_request' || n.node === 'http_request' || n.id === 'http_request' || n.componentId === 'http_request'));
    else if (nodes && typeof nodes === 'object') hit = nodes.http_request;
    const status = hit ? hit.status : null;
    if (status !== 'found') {
      return { ok: false, detail: `http_request 的媒合狀態是 ${status || '(讀不出)'}，不是 found——AI 會被誤導去改寫成 code 節點（${text.slice(0, 120)}）` };
    }
    return { ok: true, detail: 'found' };
  });

  await run('7', 'validate_yaml 校驗過', async () => {
    const r = await callTool(ctx, 'arcrun_validate_yaml', { graph: PROBE_GRAPH });
    if (!r.ok) return { ok: false, detail: r.error };
    if (!/"valid"\s*:\s*true/.test(r.text)) return { ok: false, detail: `沒回 valid:true（${r.text.slice(0, 120)}）` };
    return { ok: true, detail: 'valid' };
  });

  if (!write) {
    rings.push({ id: '8-11', name: 'push／run／verdict／收探針', status: 'skipped',
      detail: '本目標不由出貨線寫入（write:false）——只走唯讀的環；寫入類由 stage 走' });
  } else {
    const url = probeUrl || (cypherUrl ? `${cypherUrl.replace(/\/$/, '')}/health` : '');
    // 寫入類的環：前面任何一環斷了就不寫（不在壞掉的實例上留東西）
    if (broken) {
      skip('8', 'push_workflow 推得上去'); skip('9', 'run_workflow 跑得動');
      skip('10', 'list_recent_executions 看得到 verdict=success');
    } else {
      const pushedOk = await run('8', 'push_workflow 推得上去（抓網址回 JSON 的小工作流）', async () => {
        if (!url) return { ok: false, detail: '沒有探針網址' };
        const r = await callTool(ctx, 'arcrun_push_workflow', { yaml_content: probeYaml(probeName, url) });
        if (!r.ok) return { ok: false, detail: r.error };
        pushed = true;
        return { ok: true, detail: probeName };
      });
      const ranOk = pushedOk && await run('9', 'run_workflow 跑得動', async () => {
        const r = await callTool(ctx, 'arcrun_run_workflow', { name: probeName, input: {} });
        if (!r.ok) return { ok: false, detail: r.error };
        if (/"success"\s*:\s*false/.test(r.text) || !/"success"\s*:\s*true/.test(r.text)) return { ok: false, detail: `沒回 success:true（${r.text.slice(0, 160)}）` };
        return { ok: true, detail: `success:true（${r.text.length} 字回應）` };
      });
      if (!pushedOk) skip('9', 'run_workflow 跑得動');
      if (ranOk) {
        await run('10', 'list_recent_executions 看得到 verdict=success', async () => {
          // 執行紀錄是另一條寫入路，可能晚幾秒、也可能因用量降級只記失敗：有界輪詢；
          // 有紀錄就一定要是 success；沒紀錄時以 run_workflow 回的 success:true（第 9 環）為準並如實註明。
          let last = '';
          for (let i = 0; i < 5; i++) {
            const r = await callTool(ctx, 'arcrun_list_recent_executions', { workflow_name: probeName, limit: 1 });
            if (!r.ok) return { ok: false, detail: r.error };
            last = r.text;
            if (/"verdict"\s*:\s*"success"/.test(last)) return { ok: true, detail: 'verdict=success' };
            if (/"verdict"\s*:/.test(last)) return { ok: false, detail: `有紀錄但 verdict 不是 success（${last.slice(0, 160)}）` };
            if (i < 4) await sleep(2000);
          }
          return { ok: true, detail: '執行紀錄沒有這筆（紀錄可能延遲或降級只記失敗）；以第 9 環 run_workflow 回的 success:true 為準' };
        });
      } else {
        skip('10', 'list_recent_executions 看得到 verdict=success');
      }
      // 推上去了就一定收，不管前面成敗
      if (pushed) {
        await run('11', '收掉探針 workflow', async () => {
          const r = await callTool(ctx, 'arcrun_delete_workflow', { name: probeName, confirm: true });
          return r.ok ? { ok: true, detail: probeName } : { ok: false, detail: `收不掉（${r.error}）——手動刪 ${probeName}` };
        });
      }
    }
  }

  const bad = rings.filter((r) => r.status === 'broken');
  return { ok: bad.length === 0, brokenAt: bad.length ? `第${bad[0].id}環 ${bad[0].name}` : null, rings };
}

/** 排成給人讀的行；斷的環一眼看得到。 */
export function formatRings(result) {
  const icon = { ok: '✅', broken: '❌', skipped: '⛔' };
  return result.rings.map((r) => `${icon[r.status] || '?'} 第${r.id}環 ${r.name}｜${r.detail}`);
}

const CF_API = 'https://api.cloudflare.com/client/v4';
const MINT_SECRET = 'MCP_STATIC_TOKEN';

/**
 * 讓 worker 的「最新上傳版本」就是「正在跑的部署」（inkstone/Arcrun#581）。
 *
 * 為什麼：1.4.337、1.4.339 兩次 stage 出貨，正門寫一次性 Secret 時都撞 CF 10215
 * 「<script> 最新版本沒部署」，要靠人手動 `stage-deploy-artifacts.py arcrun-mcp --confirm` 補。
 * 寫 Secret 會以「最新上傳的版本」為底；最新版本不是現行部署就被拒。⇒ 正門走之前自己先對齊，不靠人記得補。
 *
 * 讀不懂回應（形狀不對、API 失敗）＝不動作、如實回報 action:'unknown'，不擋也不猜——真有問題，後面寫 Secret 會自己報 10215。
 * 只在「最新版本 ≠ 現行 100% 部署」時才部署；已對齊就什麼都不做（冪等）。
 * @returns {Promise<{ action: 'aligned'|'deployed'|'unknown', detail: string }>}
 */
export async function ensureLatestDeployed({ accountId, cfToken, script = 'arcrun-mcp', fetchImpl = fetch }) {
  const base = `${CF_API}/accounts/${accountId}/workers/scripts/${script}`;
  const auth = { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' };
  const get = (path) => fetchImpl(`${base}/${path}`, { headers: auth }).then((r) => r.json()).catch(() => null);
  const [vers, deps] = await Promise.all([get('versions'), get('deployments')]);
  const items = vers && vers.success && vers.result && Array.isArray(vers.result.items) ? vers.result.items : null;
  const list = deps && deps.success && deps.result && Array.isArray(deps.result.deployments) ? deps.result.deployments : null;
  if (!items || !items.length || !list || !list.length) return { action: 'unknown', detail: `${script}：讀不到版本／部署清單，不動作` };
  const stamp = (v) => (v.metadata && v.metadata.created_on) || '';
  const latest = [...items].sort((a, b) => (stamp(b) > stamp(a) ? 1 : stamp(b) < stamp(a) ? -1 : (b.number || 0) - (a.number || 0)))[0];
  const live = [...list].sort((a, b) => ((b.created_on || '') > (a.created_on || '') ? 1 : -1))[0];
  const full = (live.versions || []).find((x) => x.percentage === 100);
  if (full && full.version_id === latest.id) return { action: 'aligned', detail: `${script}：最新版本已是現行部署（${String(latest.id).slice(0, 8)}）` };
  const put = await fetchImpl(`${base}/deployments`, { method: 'POST', headers: auth,
    body: JSON.stringify({ strategy: 'percentage', versions: [{ percentage: 100, version_id: latest.id }] }) })
    .then((r) => r.json()).catch(() => null);
  if (!put || !put.success) throw new Error(`${script} 的最新版本（${String(latest.id).slice(0, 8)}）不是現行部署，自動補部署也失敗（${JSON.stringify(put && put.errors || '連不上').slice(0, 160)}）`);
  return { action: 'deployed', detail: `${script}：最新版本 ${String(latest.id).slice(0, 8)} 原本沒部署（現行是 ${full ? String(full.version_id).slice(0, 8) : '非 100%'}），已補部署` };
}

/**
 * 在執行當下現寫一把一次性的 MCP 連線憑證（只靠出貨環境已有的那把 Cloudflare 鑰匙，不要任何人另外放金鑰）。
 *
 * 做法（inkstone/Arcrun#461 總管裁定 c1794996907844366）：arcrun-mcp 的認證順序第 2 條是 CF Secret `MCP_STATIC_TOKEN`
 * （partner-auth.ts）。站用 CF API 把一把隨機值寫成這個 Secret、走完正門、**用完撤掉**。
 *  · 安全：值由 crypto 隨機產生，只活在本行程記憶體——不落檔、不印、不進 argv；Secret 一撤，這把憑證就死。
 *  · 不踩別人：該 Secret 已經存在（有人在用，或上一趟沒撤乾淨）⇒ **不覆蓋、不撤**，直接報錯（覆蓋會登出真用戶；
 *    撤掉別人的會斷他的連線）。上一趟沒撤乾淨的情況：手動撤 `MCP_STATIC_TOKEN`（站的錯誤訊息會說）。
 *  · 寫入後 Secret 要幾秒傳播：用該憑證打 MCP 輪詢到不再 401（有界）才回傳。
 * @returns {Promise<{ token: string, revoke: () => Promise<void> }>}
 */
export async function mintProbeCredential({ accountId, cfToken, script = 'arcrun-mcp', mcpUrl, fetchImpl = fetch,
  randomToken = () => `fd-${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 12 }) {
  const base = `${CF_API}/accounts/${accountId}/workers/scripts/${script}/secrets`;
  const auth = { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' };
  const list = await fetchImpl(base, { headers: auth }).then((r) => r.json()).catch(() => null);
  if (!list || !list.success) {
    throw new Error(`讀不到 ${script} 的 Secret 清單（Cloudflare API：${JSON.stringify(list && list.errors || '連不上').slice(0, 160)}）——出貨用的那把鑰匙沒有這支 worker 的 Secret 權限？`);
  }
  if ((list.result || []).some((x) => x.name === MINT_SECRET)) {
    throw new Error(`${script} 上已經有 ${MINT_SECRET}（有人在用，或上一趟正門沒撤乾淨）。站不覆蓋也不撤別人的——`
      + `確認不是真用戶用的之後，手動撤：DELETE ${base}/${MINT_SECRET}`);
  }
  const token = randomToken();
  // 同一支 worker 正被別人部署時 CF 回 11024（modified concurrently）：有界重試，不是失敗
  let put = null;
  for (let i = 0; i < 4; i++) {
    put = await fetchImpl(base, { method: 'PUT', headers: auth, body: JSON.stringify({ name: MINT_SECRET, text: token, type: 'secret_text' }) })
      .then((r) => r.json()).catch(() => null);
    if (put && put.success) break;
    if (i === 0 && put && (put.errors || []).some((e) => e.code === 10215)) {   // #581：最新版本沒部署——補部署再試
      await ensureLatestDeployed({ accountId, cfToken, script, fetchImpl });
      continue;
    }
    const busy = put && (put.errors || []).some((e) => e.code === 11024);
    if (!busy) break;
    await sleep(3000);
  }
  const revoke = async () => {
    const d = await fetchImpl(`${base}/${MINT_SECRET}`, { method: 'DELETE', headers: auth }).then((r) => r.json()).catch(() => null);
    if (!d || !d.success) throw new Error(`一次性憑證沒撤掉（${script} 的 ${MINT_SECRET}）——手動撤：DELETE ${base}/${MINT_SECRET}`);
  };
  if (!put || !put.success) throw new Error(`寫一次性憑證失敗（${JSON.stringify(put && put.errors || '連不上').slice(0, 160)}）`);
  // 等傳播：用它打 initialize，不再 401 才算生效
  let ready = false; let streak = 0;
  for (let i = 0; i < tries * 2 && !ready; i++) {
    const r = await rpc({ mcpUrl, token, fetchImpl, id: 0, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ship-front-door', version: '1' } } });
    streak = r.ok ? streak + 1 : 0;
    ready = streak >= 5;                       // 連續 5 次都認，才算各 isolate 都拿到了
    if (!ready) await sleep(r.ok ? 400 : 2500);
  }
  if (!ready) { await revoke().catch(() => {}); throw new Error('一次性憑證寫進去了，但 MCP 一直不認（等了約 30 秒）——已撤掉；MCP 的認證路徑可能壞了，這本身就是正門斷在第 0 環'); }
  return { token, revoke };
}

/**
 * 站的判決（ship.mjs 呼叫）。斷了就 throw（出貨線「撞到就停」）。
 * @param {object} o
 * @param {object} o.cfg       登錄簿 `frontDoor`（沒宣告＝不是 stage，整站跳過）
 * @param {{accountId:string, token:string}} [o.cf]  出貨環境已有的 Cloudflare 鑰匙（由 ship.mjs 依登錄簿名字取，這裡不印）
 */
export async function frontDoorStation({ cfg, env = process.env, confirm = false, fetchImpl = fetch, cf, mint = mintProbeCredential }) {
  if (!cfg) return { status: 'skip', detail: ['本目標沒宣告 frontDoor（登錄簿）：不由出貨線走正門（prod 的 leo21c／geek6688 由總管用 MCP 連線各走一次，貼票）'] };
  if (!confirm) {
    return { status: 'skip', detail: ['預演不走正門（它要在 stage 實例上現寫一把一次性憑證、推一條探針工作流再收掉）；--confirm 出貨時才走，任一環斷就停'] };
  }
  if (!cf || !cf.token) throw new Error('正門拿不到出貨用的 Cloudflare 鑰匙（登錄簿 cloudflareCredentials 沒宣告 youlin 那把，或環境沒有值）');
  const namespace = env[cfg.namespaceEnv] || '';
  const aligned = await ensureLatestDeployed({ accountId: cf.accountId, cfToken: cf.token, script: cfg.mcpWorker || 'arcrun-mcp', fetchImpl });
  const cred = await mint({ accountId: cf.accountId, cfToken: cf.token, script: cfg.mcpWorker || 'arcrun-mcp', mcpUrl: cfg.mcpUrl, fetchImpl });
  let r; let revokeErr = null;
  try {
    r = await walkFrontDoor({ mcpUrl: cfg.mcpUrl, token: cred.token, cypherUrl: cfg.cypherUrl, namespace, write: cfg.write !== false, fetchImpl, retry401: 4 });
  } finally {
    try { await cred.revoke(); } catch (e) { revokeErr = e; }   // 走完一定撤，不管成敗
  }
  const lines = [...(aligned.action === 'unknown' ? [] : [`ℹ️ ${aligned.detail}`]), ...formatRings(r)];
  lines.push(revokeErr ? `❌ 一次性憑證沒撤掉：${revokeErr.message}` : '✅ 一次性憑證已撤（Secret 已刪）');
  if (revokeErr) throw new Error(`正門走完但一次性憑證沒撤乾淨：\n${lines.map((l) => `       ｜${l}`).join('\n')}`);
  if (!r.ok) throw new Error(`正門驗收未過——AI 從 MCP 走不通，**斷在${r.brokenAt}**：\n${lines.map((l) => `       ｜${l}`).join('\n')}`);
  return { status: 'done', detail: lines };
}
