import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFrontDoor, frontDoorStation, mintProbeCredential, parseMcpBody, formatRings } from './front-door.mjs';

const noSleepEarly = () => Promise.resolve();
// ── 假的 MCP＋cypher：每一環都能個別弄斷 ─────────────────────────────────────
const SKILL = '# Skill: Write Intent Workflow（寫意圖工作流）…意圖…';
function fakeWorld(broken = {}) {
  const calls = [];
  const state = { pushed: new Set(), deleted: [] };
  const toolText = (text, isError = false) => ({ result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(url).endsWith('/cypher/search')) {
      calls.push('cypher/search');
      if (broken.search) return new Response(JSON.stringify({ nodes: { input: { status: 'found' }, http_request: { status: 'unknown' } } }), { status: 200 });
      return new Response(JSON.stringify({ nodes: { input: { status: 'found' }, http_request: { status: 'found', componentId: 'http_request', source: 'builtin' } } }), { status: 200 });
    }
    if (broken.unauthorized) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    let out;
    if (body.method === 'initialize') {
      out = { result: { instructions: broken.instructions ? '你好' : '先讀 arcrun_get_skill(write_intent_workflow)' } };
    } else {
      const { name, arguments: a } = body.params;
      calls.push(name);
      if (name === 'arcrun_get_skill') out = toolText(SKILL);
      else if (name === 'arcrun_search_components') out = broken.components ? toolText('Error: COMPONENT_REGISTRY service binding is not configured.', true) : toolText(JSON.stringify({ data: [{ canonical_id: 'http_request' }] }));
      else if (name === 'arcrun_get_component') out = broken.components ? toolText('Error: COMPONENT_REGISTRY service binding is not configured.', true) : toolText(JSON.stringify({ data: { canonical_id: 'http_request', input_schema: {} } }));
      else if (name === 'arcrun_list_components') out = broken.list ? toolText('Error querying components: {"success":false,"error":"not found"}', true) : toolText(JSON.stringify({ data: [{ name: 'http_request' }, { name: 'code' }] }));
      else if (name === 'arcrun_validate_yaml') out = toolText(JSON.stringify({ data: { valid: true, nodeCount: 2, edgeCount: 1 } }));
      else if (name === 'arcrun_push_workflow') { if (broken.push) out = toolText('validation_failed', true); else { state.pushed.add(a.name || /name: (\S+)/.exec(a.yaml_content)[1]); out = toolText('{"ok":true}'); } }
      else if (name === 'arcrun_run_workflow') out = broken.run ? toolText(JSON.stringify({ success: false, error: 'boom' })) : toolText(JSON.stringify({ success: true, data: { ok: true } }));
      else if (name === 'arcrun_list_recent_executions') out = toolText(JSON.stringify({ data: { executions: [{ verdict: broken.verdict ? 'failure' : 'success' }] } }));
      else if (name === 'arcrun_delete_workflow') { state.deleted.push(a.name); out = toolText('{"deleted":true}'); }
      else out = toolText('unknown tool', true);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...out }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls, state };
}
const base = { mcpUrl: 'https://mcp.example/mcp', token: 't', cypherUrl: 'https://cy.example', namespace: 'ns', write: true };

test('全通：十一環全綠，探針推了也收了', async () => {
  const w = fakeWorld();
  const r = await walkFrontDoor({ ...base, fetchImpl: w.fetchImpl });
  assert.equal(r.ok, true, formatRings(r).join('\n'));
  assert.equal(r.brokenAt, null);
  assert.deepEqual(r.rings.map((x) => x.status), Array(11).fill('ok'));
  assert.equal(w.state.pushed.size, 1);
  assert.deepEqual([...w.state.pushed], w.state.deleted);
});

test('故意拿掉零件目錄（#460 的樣子）：擋下，並說斷在第 3 環；寫入類的環不跑', async () => {
  const w = fakeWorld({ components: true });
  const r = await walkFrontDoor({ ...base, fetchImpl: w.fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.brokenAt, /第3環 search_components/);
  assert.match(r.rings.find((x) => x.id === '3').detail, /COMPONENT_REGISTRY/);
  assert.equal(r.rings.find((x) => x.id === '4').status, 'broken'); // 第 4 環 get_component 也斷
  assert.equal(w.state.pushed.size, 0, '前面斷了就不在實例上寫東西');
  assert.ok(r.rings.filter((x) => x.status === 'skipped').length >= 3);
});

test('list_components 回 not found：擋在第 5 環', async () => {
  const r = await walkFrontDoor({ ...base, fetchImpl: fakeWorld({ list: true }).fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.brokenAt, /第5環/);
});

test('連線自帶說明不指路：擋在第 1 環', async () => {
  const r = await walkFrontDoor({ ...base, fetchImpl: fakeWorld({ instructions: true }).fetchImpl });
  assert.match(r.brokenAt, /第1環/);
});

test('意圖媒合回 unknown（不是 found）：擋在第 6 環', async () => {
  const r = await walkFrontDoor({ ...base, fetchImpl: fakeWorld({ search: true }).fetchImpl });
  assert.match(r.brokenAt, /第6環/);
  assert.match(r.rings.find((x) => x.id === '6').detail, /unknown/);
});

test('推不上去／跑失敗／verdict 不是 success：各自擋在第 8／9／10 環，探針推了就一定收', async () => {
  let w = fakeWorld({ push: true });
  let r = await walkFrontDoor({ ...base, fetchImpl: w.fetchImpl });
  assert.match(r.brokenAt, /第8環/);
  w = fakeWorld({ run: true });
  r = await walkFrontDoor({ ...base, fetchImpl: w.fetchImpl });
  assert.match(r.brokenAt, /第9環/);
  assert.equal(w.state.deleted.length, 1, '跑失敗也要收探針');
  w = fakeWorld({ verdict: true });
  r = await walkFrontDoor({ ...base, fetchImpl: w.fetchImpl });
  assert.match(r.brokenAt, /第10環/);
  assert.equal(w.state.deleted.length, 1);
});

test('執行紀錄沒有這筆（延遲／降級只記失敗）：以 run 的 success:true 為準，不誤報紅燈', async () => {
  const w = fakeWorld();
  const inner = w.fetchImpl;
  const fx = async (u, i) => {
    const b = i && i.body ? JSON.parse(i.body) : {};
    if (b.params && b.params.name === 'arcrun_list_recent_executions') {
      return Response.json({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: '{"data":{"count":0,"executions":[]}}' }] } });
    }
    return inner(u, i);
  };
  const r = await walkFrontDoor({ ...base, fetchImpl: fx, sleep: noSleepEarly });
  assert.equal(r.ok, true, formatRings(r).join('\n'));
  assert.match(r.rings.find((x) => x.id === '10').detail, /沒有這筆/);
});

test('金鑰不被認（401）：每一環都斷，不是假綠', async () => {
  const r = await walkFrontDoor({ ...base, fetchImpl: fakeWorld({ unauthorized: true }).fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.rings[0].detail, /不認這把金鑰/);
});

test('write:false 不寫實例：只走唯讀的環', async () => {
  const w = fakeWorld();
  const r = await walkFrontDoor({ ...base, write: false, fetchImpl: w.fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(!w.calls.includes('arcrun_push_workflow'));
});

test('parseMcpBody：JSON 與 SSE 都收', () => {
  assert.deepEqual(parseMcpBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseMcpBody('event: message\ndata: {"a":2}\n\n'), { a: 2 });
  assert.equal(parseMcpBody('nope'), null);
});

// ── 站的判決＋一次性憑證 ─────────────────────────────────────────────────────
const cfg = { mcpUrl: 'https://mcp.example/mcp', mcpWorker: 'arcrun-mcp', cypherUrl: 'https://cy.example', namespaceEnv: 'FD_NS', write: true };
const cf = { accountId: 'acc', token: 'cf-tok' };

// 假的 Cloudflare Secret API：記錄 PUT／DELETE；MCP 的 fake world 另算
function fakeWorldWithSecrets({ existing = false, deleteFails = false, ...broken } = {}) {
  const w = fakeWorld(broken);
  const secrets = { MCP_STATIC_TOKEN: existing ? 'someone-else' : undefined };
  const log = [];
  const inner = w.fetchImpl;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('api.cloudflare.com')) {
      const method = init.method || 'GET';
      log.push(method);
      if (method === 'GET') return Response.json({ success: true, result: Object.entries(secrets).filter(([, v]) => v !== undefined).map(([name]) => ({ name })) });
      if (method === 'PUT') { secrets.MCP_STATIC_TOKEN = JSON.parse(init.body).text; return Response.json({ success: true, result: {} }); }
      if (method === 'DELETE') { if (deleteFails) return Response.json({ success: false, errors: [{ message: 'no' }] }); secrets.MCP_STATIC_TOKEN = undefined; return Response.json({ success: true, result: null }); }
    }
    return inner(url, init);
  };
  return { ...w, fetchImpl, secrets, log };
}
const noSleep = () => Promise.resolve();
const mintFor = (fetchImpl) => (o) => mintProbeCredential({ ...o, fetchImpl, sleep: noSleep });

test('站：沒宣告 frontDoor（prod）→ 跳過並說明', async () => {
  assert.equal((await frontDoorStation({ cfg: undefined, env: {}, confirm: true })).status, 'skip');
});

test('站：預演（無 --confirm）不走、不碰實例', async () => {
  const w = fakeWorldWithSecrets();
  const r = await frontDoorStation({ cfg, env: {}, confirm: false, cf, fetchImpl: w.fetchImpl });
  assert.equal(r.status, 'skip');
  assert.deepEqual(w.log, []);
});

test('站：--confirm 沒有出貨用的 Cloudflare 鑰匙 → 擋（不是跳過）', async () => {
  await assert.rejects(frontDoorStation({ cfg, env: {}, confirm: true, cf: undefined }), /Cloudflare 鑰匙/);
});

test('站：全通——現寫憑證、走十一環、用完撤掉（Secret 不留）', async () => {
  const w = fakeWorldWithSecrets();
  const r = await frontDoorStation({ cfg, env: { FD_NS: 'ns' }, confirm: true, cf, fetchImpl: w.fetchImpl, mint: mintFor(w.fetchImpl) });
  assert.equal(r.status, 'done');
  assert.equal(r.detail.length, 12); // 十一環＋一行「已撤」
  assert.equal(w.secrets.MCP_STATIC_TOKEN, undefined, 'Secret 已刪');
  assert.ok(w.log.includes('PUT') && w.log.includes('DELETE'));
  assert.ok(!JSON.stringify(r).includes('fd-'), '一次性憑證的值不進輸出');
});

test('站：某一環斷（拿掉零件目錄）→ throw 點名第 3 環，而且憑證照樣撤掉', async () => {
  const w = fakeWorldWithSecrets({ components: true });
  await assert.rejects(
    frontDoorStation({ cfg, env: { FD_NS: 'ns' }, confirm: true, cf, fetchImpl: w.fetchImpl, mint: mintFor(w.fetchImpl) }),
    /斷在第3環 search_components/);
  assert.equal(w.secrets.MCP_STATIC_TOKEN, undefined, '失敗也要撤');
});

test('一次性憑證：該 Secret 已存在 → 不覆蓋、不撤別人的，直接報錯', async () => {
  const w = fakeWorldWithSecrets({ existing: true });
  await assert.rejects(frontDoorStation({ cfg, env: {}, confirm: true, cf, fetchImpl: w.fetchImpl, mint: mintFor(w.fetchImpl) }), /已經有 MCP_STATIC_TOKEN/);
  assert.equal(w.secrets.MCP_STATIC_TOKEN, 'someone-else');
  assert.ok(!w.log.includes('PUT') && !w.log.includes('DELETE'));
});

test('一次性憑證：撤不掉 → 紅燈並教手動撤（不安靜）', async () => {
  const w = fakeWorldWithSecrets({ deleteFails: true });
  await assert.rejects(frontDoorStation({ cfg, env: { FD_NS: 'ns' }, confirm: true, cf, fetchImpl: w.fetchImpl, mint: mintFor(w.fetchImpl) }), /沒撤乾淨/);
});

test('原始碼檢查：ship.mjs 有 front-door 站，擺在 instance-update 之後、stage-record 之前；金鑰值不印', () => {
  const src = readFileSync(join(import.meta.dirname, 'ship.mjs'), 'utf8');
  const iu = src.indexOf("id: 'instance-update'");
  const fd = src.indexOf("id: 'front-door'");
  const sr = src.indexOf("id: 'stage-record'");
  assert.ok(iu > 0 && fd > iu && sr > fd, 'instance-update → front-door → stage-record');
  const lib = readFileSync(join(import.meta.dirname, 'front-door.mjs'), 'utf8');
  assert.ok(!/console\.log\([^)]*token/.test(lib));
});

test('站表順序與 ship.mjs 步驟表一致（上一版只比集合，順序錯了出貨拒絕開跑）', async () => {
  const { loadStations } = await import('./ship-stations.mjs');
  const root = join(import.meta.dirname, '..', '..');
  const ids = loadStations(root)['站'].map((x) => x.id);
  const src = readFileSync(join(import.meta.dirname, 'ship.mjs'), 'utf8');
  const stepIds = [...src.matchAll(/^\{ id: '([a-z0-9-]+)', title:/gm)].map((m) => m[1]);
  assert.deepEqual(ids, stepIds);
});
