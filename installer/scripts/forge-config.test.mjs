/**
 * forge-config.test.mjs — 票的正本住哪一家，只在一處決定（inkstone/InkStoneCo#234）
 *
 * 跑法：node --test installer/scripts/forge-config.test.mjs
 *
 * 釘死的事：
 *   ① 設定優先序：環境變數 > installer/forge.conf > 後備；不認得的值當場丟，不猜
 *   ② 翻到 ahub：出貨線的 ARM 核對打的是 AHub 具名工作流（信封形狀對、token 從 header 搬進信封、
 *      狀態碼從 {status, body} 還原），而且 leo 簽的規矩（作者精確等於 Leo、版本要對）在新家一樣擋得住
 *   ③ 翻回 gitea：同一組呼叫打回 Gitea 形狀（回退演練）
 *   ④ ahub 模式絕不把 Gitea 的金鑰送去 AHub
 *   ⑤ 發佈紀錄的主機有一個覆蓋點（RELEASE_FORGE_URL），沒填就照登錄簿宣告的
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConf, loadForgeConf, resolveForgeSettings, releaseForgeBase, matchAhubRoute, AHUB_ROUTES,
  unwrapWorkflowReply, makeAhubFetch, ticketForge, ticketToken, LEGACY_FORGE_URL, FORGE_CONF_PATH,
} from './forge-config.mjs';
import { checkTicketArmed } from './ticket-arm-guard.mjs';

const AHUB_CONF = { TICKET_FORGE: 'ahub', AHUB_CYPHER_URL: 'https://cy.example.dev/', AHUB_NS: 'ns1', TICKET_FORGE_URL: 'https://old.example' };

// ── ① 設定 ──────────────────────────────────────────────────────────────────

test('parseConf：註解、空行略過；值可含 =；空檔回 {}', () => {
  assert.deepEqual(parseConf('# 註解\n\nA=1\n B = x=y \nbad line\n'), { A: '1', B: 'x=y' });
  assert.deepEqual(parseConf(''), {});
  assert.deepEqual(parseConf(undefined), {});
});

test('真的 installer/forge.conf：讀得到、五個鍵都在、設定合法（翻哪一邊不是本測試的事）', () => {
  const conf = loadForgeConf(FORGE_CONF_PATH);
  for (const k of ['TICKET_FORGE', 'TICKET_FORGE_URL', 'AHUB_CYPHER_URL', 'AHUB_NS', 'RELEASE_FORGE_URL']) {
    assert.ok(k in conf, `forge.conf 缺 ${k}`);
  }
  const s = resolveForgeSettings({ env: {}, conf });
  assert.ok(['gitea', 'ahub'].includes(s.kind));
});

test('優先序：環境變數 > forge.conf > 後備；網址尾斜線去掉', () => {
  const conf = { TICKET_FORGE: 'gitea', TICKET_FORGE_URL: 'https://a.example/' };
  assert.equal(resolveForgeSettings({ env: {}, conf }).ticketUrl, 'https://a.example');
  assert.equal(resolveForgeSettings({ env: { TICKET_FORGE_URL: 'http://127.0.0.1:8787/' }, conf }).ticketUrl, 'http://127.0.0.1:8787');
  assert.equal(resolveForgeSettings({ env: {}, conf: {} }).ticketUrl, LEGACY_FORGE_URL, '連 conf 都沒有 ⇒ 最後後備是舊家');
  assert.equal(resolveForgeSettings({ env: { TICKET_FORGE: '' }, conf: { TICKET_FORGE: 'ahub', AHUB_CYPHER_URL: 'https://c', AHUB_NS: 'n' } }).kind, 'ahub', '空字串環境變數不算數');
});

test('不認得的 TICKET_FORGE、或 ahub 缺 cypher／ns ⇒ 當場丟，不退回 Gitea', () => {
  assert.throws(() => resolveForgeSettings({ env: { TICKET_FORGE: 'github' }, conf: {} }), /gitea 或 ahub/);
  assert.throws(() => resolveForgeSettings({ env: { TICKET_FORGE: 'ahub' }, conf: {} }), /AHUB_CYPHER_URL|AHUB_NS/);
  assert.throws(() => resolveForgeSettings({ env: { TICKET_FORGE: 'ahub', AHUB_CYPHER_URL: 'https://c' }, conf: {} }), /AHUB_NS/);
});

test('releaseForgeBase：沒填 RELEASE_FORGE_URL ⇒ 照宣告；填了 ⇒ 覆蓋', () => {
  assert.equal(releaseForgeBase('https://decl.example/', { env: {}, conf: {} }), 'https://decl.example');
  assert.equal(releaseForgeBase(undefined, { env: {}, conf: {} }), LEGACY_FORGE_URL);
  assert.equal(releaseForgeBase('https://decl.example', { env: { RELEASE_FORGE_URL: 'https://new.example/' }, conf: {} }), 'https://new.example');
});

// ── ② AHub 直連 ─────────────────────────────────────────────────────────────

test('matchAhubRoute：字面段勝過參數段；方法不同不混；沒有的端點回 null', () => {
  assert.equal(matchAhubRoute('GET', '/repos/inkstone/InkStoneCo/issues/234/comments').workflow, 'ahub__comment_list');
  assert.equal(matchAhubRoute('POST', '/repos/inkstone/InkStoneCo/issues/234/comments').workflow, 'ahub__comment_create');
  assert.deepEqual(matchAhubRoute('GET', '/repos/inkstone/InkStoneCo/issues/234').params, { owner: 'inkstone', repo: 'InkStoneCo', index: '234' });
  assert.equal(matchAhubRoute('GET', '/repos/inkstone/InkStoneCo/releases/tags/v1').workflow, 'ahub__release_by_tag', 'tag 路由（字面 tags）勝過 :id');
  assert.equal(matchAhubRoute('GET', '/repos/inkstone/InkStoneCo/releases/7').workflow, 'ahub__release_get');
  assert.equal(matchAhubRoute('DELETE', '/repos/inkstone/InkStoneCo/releases/7'), null, 'AHub 沒有刪 release 的口');
  assert.equal(matchAhubRoute('GET', '/repos/inkstone/InkStoneCo/git/commits/abc'), null, 'AHub 沒有 git／commit 端點');
  assert.equal(matchAhubRoute('DELETE', '/repos/inkstone/x/issues/1'), null);
  // 抄來的路由都是 [method, pattern, workflow] 且 workflow 以 ahub__ 起頭
  for (const [m, p, w] of AHUB_ROUTES) { assert.match(m, /^[A-Z]+$/); assert.ok(p.startsWith('/')); assert.ok(w.startsWith('ahub__')); }
});

test('unwrapWorkflowReply：{data:{status,body}} 與 {data:{data:{status,body}}} 兩種外殼都拆得開；拆不開回 null', () => {
  assert.deepEqual(unwrapWorkflowReply({ success: true, data: { success: true, status: 201, body: { a: 1 } } }), { status: 201, body: { a: 1 } });
  assert.deepEqual(unwrapWorkflowReply({ success: true, data: { data: { status: 404, body: { message: 'x' } } } }), { status: 404, body: { message: 'x' } });
  assert.equal(unwrapWorkflowReply({ success: false, error: 'boom' }), null);
  assert.equal(unwrapWorkflowReply('<html>'), null);
});

/** 假的 Arcrun：記下每個請求，回你指定的 {status, body}。 */
function fakeArcrun(reply) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, init, envelope: JSON.parse(init.body) });
    const r = typeof reply === 'function' ? reply(seen[seen.length - 1]) : reply;
    return { status: r.http ?? 200, text: async () => (typeof r.raw === 'string' ? r.raw : JSON.stringify(r.json)) };
  };
  f.seen = seen;
  return f;
}

test('makeAhubFetch：GET 留言 ⇒ POST 到具名工作流，信封五件齊（method/path/query/token/params），狀態碼還原', async () => {
  const under = fakeArcrun({ json: { success: true, data: { success: true, status: 200, body: [{ id: 1 }] } } });
  const f = makeAhubFetch({ cypherUrl: 'https://cy.example/', ns: 'ns 1', fetchImpl: under });
  const r = await f('ahub://ns1/api/v1/repos/inkstone/InkStoneCo/issues/234/comments?limit=50&page=2', { headers: { authorization: 'token SECRET', accept: 'application/json' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), [{ id: 1 }]);
  const [{ url, init, envelope }] = under.seen;
  assert.equal(url, 'https://cy.example/webhooks/named/ns%201/ahub__comment_list/query');
  assert.equal(init.method, 'POST');
  assert.deepEqual(envelope, {
    method: 'GET', path: '/repos/inkstone/InkStoneCo/issues/234/comments', query: { limit: '50', page: '2' },
    body: null, token: 'SECRET', params: { owner: 'inkstone', repo: 'InkStoneCo', index: '234' }, base: 'https://cy.example',
  });
});

test('makeAhubFetch：Authorization 的 token／Bearer 兩種寫法都認；沒帶就是空字串（AHub 回 401，不是這裡擋）', async () => {
  const under = fakeArcrun({ json: { success: true, data: { success: true, status: 401, body: { message: 'token is required' } } } });
  const f = makeAhubFetch({ cypherUrl: 'https://cy', ns: 'n', fetchImpl: under });
  await f('https://x/api/v1/user', { headers: { Authorization: 'Bearer abc' } });
  await f('https://x/api/v1/user', {});
  assert.equal(under.seen[0].envelope.token, 'abc');
  assert.equal(under.seen[1].envelope.token, '');
  const r = await f('https://x/api/v1/user', {});
  assert.equal(r.status, 401, '工作流回的 {status} 要原樣還原成 HTTP 狀態碼');
});

test('makeAhubFetch：POST 的 JSON body 進信封的 body；body 不是 JSON ⇒ 400 不打網路', async () => {
  const under = fakeArcrun({ json: { success: true, data: { status: 201, body: { number: 7 } } } });
  const f = makeAhubFetch({ cypherUrl: 'https://cy', ns: 'n', fetchImpl: under });
  const ok = await f('https://x/api/v1/repos/inkstone/r/issues', { method: 'post', body: JSON.stringify({ title: 't' }), headers: { authorization: 'token T' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(under.seen[0].envelope.body, { title: 't' });
  assert.equal(under.seen[0].envelope.method, 'POST');
  const bad = await f('https://x/api/v1/repos/inkstone/r/issues', { method: 'POST', body: '{不是json' });
  assert.equal(bad.status, 400);
  assert.equal(under.seen.length, 1);
});

test('makeAhubFetch：沒有的端點 ⇒ 404 並指向真身；不是 /api/v1 ⇒ 404；工作流壞掉（沒回 {status}）⇒ 502 且帶原因', async () => {
  const under = fakeArcrun({ json: { success: false, error: 'workflow exploded' } });
  const f = makeAhubFetch({ cypherUrl: 'https://cy', ns: 'n', fetchImpl: under });
  const none = await f('https://x/api/v1/repos/inkstone/r/git/commits/abc', {});
  assert.equal(none.status, 404);
  assert.match((await none.json()).message, /routes\.json/);
  assert.equal((await f('https://x/other', {})).status, 404);
  assert.equal(under.seen.length, 0, '前兩種不該打網路');
  const broken = await f('https://x/api/v1/user', {});
  assert.equal(broken.status, 502);
  assert.match((await broken.json()).detail, /workflow exploded/);
  const html = makeAhubFetch({ cypherUrl: 'https://cy', ns: 'n', fetchImpl: fakeArcrun({ http: 524, raw: '<html>timeout</html>' }) });
  assert.equal((await html('https://x/api/v1/user', {})).status, 502);
});

// ── ②′ 翻到 ahub，出貨線的 ARM 核對 ─────────────────────────────────────────

/** AHub 上的一張票：留言由 comments 給；用 comment_list 工作流的回應形狀。 */
// 舊 AHub（< 0.8.0）：沒有簽核看板那條工作流 ⇒ 引擎回 404，出貨閘走舊的讀留言
function ahubWithComments(comments) {
  return fakeArcrun((req) => {
    if (req.url.includes('/ahub__signoff_status/')) return { http: 404, json: { error: '找不到 workflow "ahub__signoff_status"' } };
    if (req.envelope.params.index === '999') return { json: { success: true, data: { status: 404, body: { message: 'issue not found' } } } };
    if (!req.envelope.token) return { json: { success: true, data: { status: 401, body: { message: 'token is required' } } } };
    const { limit = '30', page = '1' } = req.envelope.query;
    const l = Number(limit), p = Number(page);
    return { json: { success: true, data: { success: true, status: 200, body: comments.slice((p - 1) * l, p * l) } } };
  });
}
const leo = (body, id = 1) => ({ id, user: { login: 'Leo' }, body, created_at: '2026-10-23T10:00:00Z' });
const ai = (body, id = 2) => ({ id, user: { login: 'claude-code' }, body, created_at: '2026-10-23T10:01:00Z' });

test('翻到 ahub（注入底層 fetch）：放行／AI 簽不算／簽錯版擋／沒簽擋——規矩跟 Gitea 時一模一樣', async () => {
  const mk = (comments) => {
    const under = ahubWithComments(comments);
    const forge = ticketForge({ env: { AHUB_TOKEN: 'T' }, conf: AHUB_CONF, fetchImpl: under });
    return { under, run: (version) => checkTicketArmed({ version, repo: 'InkStoneCo', issue: 234, token: 'T', baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl }) };
  };
  const ok = mk([leo('ARM: 1.4.115')]);
  const armed = await ok.run('1.4.115');
  assert.equal(armed.armed, true);
  assert.match(armed.mission, /ahub:\/\/ns1\/inkstone\/InkStoneCo\/issues\/234#issuecomment-1/);
  assert.equal(ok.under.seen[0].url, 'https://cy.example.dev/webhooks/named/ns1/ahub__signoff_status/query', '先問簽核看板');
  assert.equal(ok.under.seen[1].url, 'https://cy.example.dev/webhooks/named/ns1/ahub__comment_list/query', '舊 AHub 沒有 ⇒ 讀留言');

  await assert.rejects(mk([ai('ARM: 1.4.115')]).run('1.4.115'), /沒有任何一則來自 Leo/);
  await assert.rejects(mk([leo('ARM: 1.4.114')]).run('1.4.115'), /版本對不上/);
  await assert.rejects(mk([leo('我覺得可以了')]).run('1.4.115'), /沒有任何一則來自 Leo/);
});

test('翻到 ahub：沒 token ⇒ 401 變成清楚的失敗（fail-closed），訊息點名 AHUB_TOKEN；票不存在 ⇒ 404 也斷', async () => {
  const under = ahubWithComments([leo('ARM: 1.4.115')]);
  const forge = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: under });
  const run = (issue, token) => checkTicketArmed({ version: '1.4.115', repo: 'InkStoneCo', issue, token, baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl });
  await assert.rejects(run(234, null), /HTTP 401/);
  await assert.rejects(run(999, 'T'), /HTTP 404/);
});

test('翻到 ahub：分頁——ARM 在第二頁也讀得到（AHub 的 limit／page 與 Gitea 同義）', async () => {
  const filler = Array.from({ length: 50 }, (_, i) => ai('閒聊 ' + i, 100 + i));
  const under = ahubWithComments([...filler, leo('ARM: 1.4.115', 500)]);
  const forge = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: under });
  const r = await checkTicketArmed({ version: '1.4.115', repo: 'InkStoneCo', issue: 234, token: 'T', baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl });
  assert.equal(r.armed, true);
  assert.equal(under.seen.length, 3, '看板一次（舊 AHub 沒有）＋留言兩頁');
});

test('makeAhubFetch：引擎說沒有這條工作流（404）⇒ 404＋code=workflow_missing（舊 AHub；不當暫時性錯誤重試）', async () => {
  const under = fakeArcrun({ http: 404, json: { error: '找不到 workflow' } });
  const f = makeAhubFetch({ cypherUrl: 'https://cy.example', ns: 'ns1', fetchImpl: under });
  const r = await f('ahub://ns1/api/v1/repos/inkstone/InkStoneCo/issues/1/signoffs?version=1.0.0', { headers: { authorization: 'token T' } });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { message: '這台 AHub 沒有 ahub__signoff_status（版本太舊）', code: 'workflow_missing', workflow: 'ahub__signoff_status' });
});

// ── ②b AHub 0.8.0：出貨閘只問簽核看板（inkstone/Arcrun#328）─────────────────

function ahubWithBoard(board, comments = []) {
  return fakeArcrun((req) => {
    if (!req.envelope.token) return { json: { success: true, data: { status: 401, body: { message: 'token is required' } } } };
    if (req.url.includes('/ahub__signoff_status/')) return { json: { success: true, data: { success: true, status: 200, body: board(req.envelope.query.version) } } };
    return { json: { success: true, data: { success: true, status: 200, body: comments } } };
  });
}
const boardOf = (approved, extra = {}) => (ver) => ({ issue: 'inkstone/InkStoneCo#234', approvers: ['alice'], configured: true, requests: [],
  version: approved ? { version: ver, approved: true, by: 'alice', at: '2026-10-29T10:00:00Z', comment_id: '77' } : { version: ver, approved: false, by: null, at: null, comment_id: null }, ...extra });

test('AHub 0.8.0：看板說放行 ⇒ 過，署名是租戶設的簽核人（不是寫死的 Leo）；版本照實際要出的去問', async () => {
  const under = ahubWithBoard(boardOf(true));
  const forge = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: under });
  const r = await checkTicketArmed({ version: 'v1.4.200', repo: 'InkStoneCo', issue: 234, token: 'T', baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl });
  assert.equal(r.armed, true);
  assert.match(r.mission, /alice 在 AHub 簽核/);
  assert.equal(under.seen.length, 1, '只問看板，不讀留言');
  assert.equal(under.seen[0].envelope.query.version, '1.4.200');
});

test('AHub 0.8.0：看板說沒放行 ⇒ 擋；留言裡就算有 Leo 的 ARM 也不算（判讀只在 AHub）；訊息只叫人照簽核 guide', async () => {
  const under = ahubWithBoard(boardOf(false), [leo('ARM: 1.4.200')]);
  const forge = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: under });
  const err = await checkTicketArmed({ version: '1.4.200', repo: 'InkStoneCo', issue: 234, token: 'T', baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /簽核 guide/);
  assert.doesNotMatch(err.message, /【簽核請求】|github-arm/, '不再自己教格式');
  const none = ahubWithBoard(boardOf(false, { configured: false, approvers: [] }));
  const f2 = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: none });
  await assert.rejects(checkTicketArmed({ version: '1.4.200', repo: 'InkStoneCo', issue: 234, token: 'T', baseUrl: f2.baseUrl, fetchImpl: f2.fetchImpl }), /還沒設簽核人/);
});

test('AHub 0.8.0：沒 token ⇒ 看板回 401 直接斷（不退回讀留言）', async () => {
  const under = ahubWithBoard(boardOf(true));
  const forge = ticketForge({ env: {}, conf: AHUB_CONF, fetchImpl: under });
  await assert.rejects(checkTicketArmed({ version: '1.4.200', repo: 'InkStoneCo', issue: 234, token: null, baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl }), /簽核看板失敗：HTTP 401/);
  assert.equal(under.seen.length, 1);
});

// ── ③ 回退：翻回 gitea ──────────────────────────────────────────────────────

test('翻回 gitea（回退演練）：同一組呼叫打的是 Gitea 形狀 /api/v1/repos/…，帶 token header', async () => {
  const calls = [];
  const gitea = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => [leo('ARM: 1.4.115')] }; };
  const forge = ticketForge({ env: { TICKET_FORGE: 'gitea', TICKET_FORGE_URL: 'https://git.example/' }, conf: AHUB_CONF, fetchImpl: gitea });
  assert.equal(forge.kind, 'gitea');
  assert.equal(forge.baseUrl, 'https://git.example');
  const r = await checkTicketArmed({ version: '1.4.115', repo: 'InkStoneCo', issue: 234, token: 'GT', baseUrl: forge.baseUrl, fetchImpl: forge.fetchImpl });
  assert.equal(r.armed, true);
  const c = calls.find((x) => /\/comments\?/.test(x.url));
  assert.match(c.url, /^https:\/\/git\.example\/api\/v1\/repos\/inkstone\/InkStoneCo\/issues\/234\/comments\?/);
  assert.equal(c.init.headers.authorization, 'token GT');
});

// ── ④ token ─────────────────────────────────────────────────────────────────

test('ticketToken：ahub 只認 AHUB_TOKEN／TICKET_FORGE_TOKEN，絕不把 Gitea 的金鑰（fallback／GITEA_TOKEN_CLAUDE_CODE）送去 AHub', () => {
  assert.equal(ticketToken('ahub', { env: { AHUB_TOKEN: 'a', TICKET_FORGE_TOKEN: 't' }, fallback: 'gitea-remote' }), 'a');
  assert.equal(ticketToken('ahub', { env: { TICKET_FORGE_TOKEN: 't' } }), 't');
  assert.equal(ticketToken('ahub', { env: { GITEA_TOKEN_CLAUDE_CODE: 'g' }, fallback: 'gitea-remote' }), null);
});

test('ticketToken：gitea 的順序 = TICKET_FORGE_TOKEN > 呼叫端後備（remote 內嵌）> GITEA_TOKEN_CLAUDE_CODE > null', () => {
  assert.equal(ticketToken('gitea', { env: { TICKET_FORGE_TOKEN: 't', GITEA_TOKEN_CLAUDE_CODE: 'g' }, fallback: 'r' }), 't');
  assert.equal(ticketToken('gitea', { env: { GITEA_TOKEN_CLAUDE_CODE: 'g' }, fallback: 'r' }), 'r');
  assert.equal(ticketToken('gitea', { env: { GITEA_TOKEN_CLAUDE_CODE: 'g' } }), 'g');
  assert.equal(ticketToken('gitea', { env: {} }), null);
});
