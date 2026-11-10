/**
 * stage-record.test.mjs — 出貨線寫 AHub stage 現況（inkstone/arcrun-rag#301）。
 * 在臨時 git repo 與假 fetch 上演練：格式、票號去重、丟掉的線上那顆、寫失敗不安靜（存 pending）、只寫一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ticketRefsIn, buildStageRecord, discardedSha, postStageRecord, recordStageShipment, pendingPath, loadPending, STAGE_WINDOW,
} from './stage-record.mjs';
import { matchAhubRoute } from './forge-config.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function tmpRepo(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-record-'));
  g(dir, 'init', '-q', '-b', 'main');
  for (const m of messages) g(dir, 'commit', '-q', '--allow-empty', '-m', m);
  return dir;
}

const okFetch = (calls) => async (url, init) => { calls.push({ url, init }); return new Response('{"recorded":true}', { status: 201 }); };

test('票號：沒寫 repo 的 #N 算 Arcrun、寫了 repo 的照寫、去重保序、不誤抓 URL 與 sha 片段', () => {
  const refs = ticketRefsIn('feat: 做 X（inkstone/Arcrun#365）\n\nrefs #364 與 inkstone/arcrun-rag#271，再提 #364\nhttps://x.y/z#12 a1b2c3#9');
  assert.deepEqual(refs, ['inkstone/Arcrun#365', 'inkstone/Arcrun#364', 'inkstone/arcrun-rag#271']);
});

test('buildStageRecord：commit 是 40 碼、commits 取前 10 碼、票來自訊息、window＝實際筆數', () => {
  const repo = tmpRepo(['init', 'feat: a (inkstone/Arcrun#364)', 'feat: b #365']);
  const head = g(repo, 'rev-parse', 'HEAD');
  const p = buildStageRecord({ repo, headSha: head, version: '1.4.146', by: 'arcrun-rag-hand', sessionUrl: 'https://claude.ai/code/session_x' });
  assert.equal(p.commit, head);
  assert.equal(p.commits.length, 3);
  assert.equal(p.commits[0], head.slice(0, 10));
  assert.deepEqual(p.tickets, ['inkstone/Arcrun#365', 'inkstone/Arcrun#364']);
  assert.equal(p.window, 3);
  assert.equal(p.version, '1.4.146');
  assert.equal(p.by, 'arcrun-rag-hand');
  assert.equal(p.repo, 'inkstone/Arcrun');
  assert.ok(!('note' in p) && !('discarded' in p), '沒給的選填欄位不送');
});

test('buildStageRecord：只往回 window 個 commit（超過的票不算含）', () => {
  const repo = tmpRepo(['old (inkstone/Arcrun#1)', 'mid', 'new']);
  const p = buildStageRecord({ repo, headSha: 'HEAD', window: 2 });
  assert.equal(p.window, 2);
  assert.deepEqual(p.tickets, []);
  assert.equal(STAGE_WINDOW, 300);
});

test('buildStageRecord：來源 commit 在 repo 找不到 ⇒ null（不憑空組一份）', () => {
  const repo = tmpRepo(['init']);
  assert.equal(buildStageRecord({ repo, headSha: 'deadbeef'.repeat(5) }), null);
  assert.equal(buildStageRecord({ repo, headSha: '' }), null);
});

test('discardedSha：佇列閘的物件／字串都認，不像 sha 的不送', () => {
  assert.equal(discardedSha({ sha: 'ABCDEF1234567' }), 'abcdef1234567');
  assert.equal(discardedSha('abcdef1'), 'abcdef1');
  assert.equal(discardedSha({ sha: 'xyz' }), null);
  assert.equal(discardedSha(null), null);
});

test('路由：POST /ahub/stage 對得到 ahub__stage_record；GET 的兩條也在', () => {
  assert.equal(matchAhubRoute('POST', '/ahub/stage').workflow, 'ahub__stage_record');
  assert.equal(matchAhubRoute('GET', '/ahub/stage').workflow, 'ahub__stage_get');
  assert.equal(matchAhubRoute('GET', '/repos/inkstone/Arcrun/issues/364/stage').workflow, 'ahub__issue_stage');
});

test('postStageRecord：沒權杖 ⇒ 不打網路、說缺什麼；201 ⇒ ok；非 201 ⇒ 不 ok 且帶狀態碼；斷線不丟例外', async () => {
  const calls = [];
  assert.equal((await postStageRecord({ fetchImpl: okFetch(calls), token: '', payload: {} })).ok, false);
  assert.equal(calls.length, 0);
  const ok = await postStageRecord({ fetchImpl: okFetch(calls), token: 'T', payload: { commit: 'a'.repeat(40) } });
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'token T');
  assert.ok(calls[0].url.endsWith('/api/v1/ahub/stage'));
  const r401 = await postStageRecord({ fetchImpl: async () => new Response('{"message":"nope"}', { status: 401 }), token: 'T', payload: {} });
  assert.equal(r401.ok, false); assert.equal(r401.status, 401);
  const dead = await postStageRecord({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, token: 'T', payload: {} });
  assert.equal(dead.ok, false); assert.match(dead.message, /ECONNRESET/);
});

test('recordStageShipment：成功＝只打一次、不留 pending；失敗＝存 pending（內容完整）且回 ok=false', async () => {
  const repo = tmpRepo(['init', 'feat (inkstone/Arcrun#365)']);
  const head = g(repo, 'rev-parse', 'HEAD');
  const workdir = mkdtempSync(join(tmpdir(), 'stage-record-wd-'));

  const calls = [];
  const good = await recordStageShipment({ repo, headSha: head, version: '1.4.146', by: 'b', fetchImpl: okFetch(calls), token: 'T', workdir });
  assert.equal(good.ok, true);
  assert.equal(calls.length, 1, '只在出貨那一下寫一次');
  assert.equal(JSON.parse(calls[0].init.body).tickets[0], 'inkstone/Arcrun#365');
  assert.equal(existsSync(pendingPath(workdir)), false);

  const bad = await recordStageShipment({ repo, headSha: head, version: '1.4.146', by: 'b', fetchImpl: async () => new Response('boom', { status: 503 }), token: 'T', workdir });
  assert.equal(bad.ok, false);
  assert.equal(bad.pending, pendingPath(workdir));
  assert.equal(loadPending(workdir).commit, head);

  // 補寫成功後 pending 清掉
  const again = await recordStageShipment({ repo, headSha: head, version: '1.4.146', by: 'b', fetchImpl: okFetch([]), token: 'T', workdir });
  assert.equal(again.ok, true);
  assert.equal(existsSync(pendingPath(workdir)), false);
});

test('recordStageShipment：來源找不到 ⇒ ok=false、不打網路、不寫空的 pending', async () => {
  const repo = tmpRepo(['init']);
  const workdir = mkdtempSync(join(tmpdir(), 'stage-record-wd-'));
  const calls = [];
  const r = await recordStageShipment({ repo, headSha: 'f'.repeat(40), fetchImpl: okFetch(calls), token: 'T', workdir });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(pendingPath(workdir)), false);
  assert.match(readFileSync(new URL('./stage-record.mjs', import.meta.url), 'utf8'), /不輪詢、不排程、不對任何票留言/);
});

test('probeStageRecordReady：200 ready／404 workflow_missing 點名缺 0.15.0／401 不認權杖／斷線／沒權杖不打網路', async () => {
  const { probeStageRecordReady } = await import('./stage-record.mjs');
  const calls = [];
  const mk = (status, body) => async (u, i) => { calls.push({ u, i }); return new Response(body, { status }); };
  assert.equal((await probeStageRecordReady({ fetchImpl: mk(200, '{}'), token: 'T' })).code, 'ready');
  assert.equal(calls[0].i.method, 'GET', '預先問只讀，不寫');
  const miss = await probeStageRecordReady({ fetchImpl: mk(404, '{"code":"workflow_missing","workflow":"ahub__stage_get"}'), token: 'T' });
  assert.equal(miss.ok, false); assert.equal(miss.code, 'workflow-missing'); assert.match(miss.message, /0\.15\.0/);
  assert.equal((await probeStageRecordReady({ fetchImpl: mk(401, '{}'), token: 'T' })).code, 'unauthorized');
  assert.equal((await probeStageRecordReady({ fetchImpl: mk(500, 'x'), token: 'T' })).code, 'unexpected');
  assert.equal((await probeStageRecordReady({ fetchImpl: async () => { throw new Error('boom'); }, token: 'T' })).code, 'unreachable');
  const n = calls.length;
  assert.equal((await probeStageRecordReady({ fetchImpl: mk(200, '{}'), token: '' })).code, 'no-token');
  assert.equal(calls.length, n, '沒權杖不打網路');
});

test('stageRecordOutcome：寫不進去（含 404 workflow_missing、來源算不出）＝警告＋待補，狀態仍是 done，不擋出貨（總監裁決 2026-11-10）', async () => {
  const { stageRecordOutcome } = await import('./stage-record.mjs');
  const repo = tmpRepo(['init', 'feat (inkstone/Arcrun#365)']);
  const head = g(repo, 'rev-parse', 'HEAD');
  const workdir = mkdtempSync(join(tmpdir(), 'stage-record-wd-'));

  // AHub 太舊：404 workflow_missing
  const r404 = await recordStageShipment({ repo, headSha: head, version: '1.4.146', by: 'b', token: 'T', workdir,
    fetchImpl: async () => new Response('{"code":"workflow_missing"}', { status: 404 }) });
  const o404 = stageRecordOutcome(r404, { by: 'b' });
  assert.equal(o404.status, 'done');
  assert.match(o404.detail[0], /⚠️.*沒寫進 AHub/);
  assert.match(o404.detail[1], /待補：.*--retry-pending/);
  assert.equal(loadPending(workdir).commit, head, '內容已存成待補');

  // 沒權杖
  const rNoTok = await recordStageShipment({ repo, headSha: head, by: 'b', token: '', workdir, fetchImpl: okFetch([]) });
  assert.equal(stageRecordOutcome(rNoTok).status, 'done');

  // 來源算不出：沒有待補內容也不擋
  const rNoSrc = await recordStageShipment({ repo, headSha: 'f'.repeat(40), token: 'T', workdir: mkdtempSync(join(tmpdir(), 'x-')), fetchImpl: okFetch([]) });
  const oNoSrc = stageRecordOutcome(rNoSrc);
  assert.equal(oNoSrc.status, 'done');
  assert.match(oNoSrc.detail[1], /沒有可存的待補內容/);

  // 成功
  const ok = stageRecordOutcome({ ok: true, message: '已寫進' }, { by: 'b', sessionUrl: 'https://claude.ai/code/s' });
  assert.deepEqual(ok, { status: 'done', detail: ['已寫進', 'by b｜https://claude.ai/code/s'] });
  // 防呆：連 undefined 都不丟例外
  assert.equal(stageRecordOutcome(undefined).status, 'done');
});

test('ship.mjs：preflight 探不到 AHub 只警告、不 throw；寫入站不再 throw（防有人把擋改回來）', () => {
  const src = readFileSync(new URL('./ship.mjs', import.meta.url), 'utf8');
  const pre = src.slice(src.indexOf('(b1.6) stage 現況'), src.indexOf('(b2) 釘子分支'));
  assert.ok(pre.length > 200 && !/throw new Error/.test(pre), 'b1.6 不准 throw');
  assert.match(pre, /不擋出貨/);
  const st = src.slice(src.indexOf("id: 'stage-record'"));
  const body = st.slice(0, st.indexOf('}},'));
  assert.ok(!/throw new Error/.test(body), 'stage-record 站不准 throw');
  assert.match(body, /stageRecordOutcome/);
});
