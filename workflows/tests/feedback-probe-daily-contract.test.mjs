// feedback-probe-daily.yaml 的契約（inkstone/arcrun-rag#282）。跑法：node workflows/tests/feedback-probe-daily-contract.test.mjs
// 靜態契約；引擎上的實跑（成功／相近票重送／失敗叫人／叫不了人時整次失敗）見票上 youlin 演練輸出。
import { execFileSync } from 'node:child_process';
import { renderFeedbackProbe } from '../../installer/scripts/render-feedback-probe.mjs';
let pass = 0, fail = 0;
const t = (l, c, x = '') => { if (c) { console.log('PASS:', l); pass++; } else { console.log('FAIL:', l, x); fail++; } };
const S = { kind: 'ahub', cypherUrl: 'https://ahub.example', ns: 'nsX' };
const { yaml } = renderFeedbackProbe(S);
const live = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const d = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: yaml, encoding: 'utf8' }));
const nodes = Object.keys(d.config);
const edges = d.flow.map((e) => e.split(' >> '));
t('渲染後不殘留佔位', !/__[A-Z][A-Z0-9_]*__/.test(live));
t('首節點是 cron（引擎只認首節點 cron 才登記排程）', edges[0][0] === 'daily_cron' && d.config.daily_cron.component === 'cron');
t('每條邊的兩端都是已定義的節點', edges.every(([a, , b]) => nodes.includes(a) && nodes.includes(b)));
t('金鑰只寫名字，沒有真身', live.includes('{{credential.ahub_token}}') && !/token: "?(?!\{\{credential)[A-Za-z0-9_]{12,}/.test(live));
t('所有 AHub 呼叫指向渲染進去的網址／namespace', (live.match(/https:\/\/ahub\.example\/webhooks\/named\/nsX\/ahub__[a-z_]+\/query/g) || []).length === 9);
const codeNodes = nodes.filter((n) => d.config[n].component === 'code');
t('code 節點的程式裡沒有相鄰的 {{ 或 }}（引擎會把 code 字串也當模板插值）', codeNodes.every((n) => !/\{\{|\}\}/.test(d.config[n].code.replace(/\\\{\\\{|\\\}\\\}|\\\{|\\\}/g, ''))), codeNodes.filter((n) => /\{\{|\}\}/.test(d.config[n].code.replace(/\\\{\\\{|\\\}\\\}|\\\{|\\\}/g, ''))).join(','));
t('judge1 與 judge2 程式相同（只差輸入）', d.config.judge1.code === d.config.judge2.code);
t('唯一故意丟錯的是 alert_done', codeNodes.filter((n) => /throw new Error/.test(d.config[n].code)).join() === 'alert_done');
t('不依賴 code 節點回 success:false（uncle6 1.4.64 沒有 #362）', codeNodes.every((n) => !/success: false/.test(d.config[n].code)));
t('警報開「要你做的事」帶 reopen、withdraw、keep', JSON.stringify(Object.keys(d.config.alert_request.body_json.body).sort()) === '["detail","keep","kind","reopen","title","withdraw"]');
const { yaml: y2 } = renderFeedbackProbe(S, { tokenLiteral: 'drill' });
t('演練可換假 token，正式渲染不會', y2.includes('token: "drill"') && !y2.includes('{{credential.ahub_token}}') && live.includes('{{credential.ahub_token}}'));
let threw = false; try { renderFeedbackProbe(S, { cron: '* *' }); } catch { threw = true; }
t('壞的 cron 渲染器當場丟', threw);
// judge1 的重送理由要過真 AHub 的逐張交代檢查（≥10 字、各張不同、點名每張）——曾因同一句貼給每張而對真 AHub 仍 409（#282 第 38 則）
{
  const refs = ['inkstone/arcrun-rag#368', 'inkstone/arcrun-rag#369', 'inkstone/arcrun-rag#242'];
  const run = new Function('input', d.config.judge1.code);
  const out = run({ sub_ok: false, sub_err: '開票前比對到相近的票，沒有開新票。重複候選=' + refs.join(' '), sub_data: '{{send1.sub_result.data}}', trace: '' });
  const cs = out.compared || [];
  const rs = cs.map((c) => c.reason);
  t('judge1 重送：每張候選一筆、理由 ≥10 字且各不相同', out.route === 'retry' && cs.map((c) => c.ref).join() === refs.join() && rs.every((r) => r.length >= 10) && new Set(rs).size === rs.length, JSON.stringify(out));
}
// close_judge／alert_plan 用「真 AHub 的回應形狀」測（Arcrun workflows/ahub/routes/issue_patch.js reply(201, issueView)、
// action_status／signoff_status 的 {requests:[…]}），不是替身自己編的形狀。http_request 成功輸出＝{success:true,data:{body:"<回應原文字串>"}}。
{
  const real = (status, body) => JSON.stringify({ success: true, data: { success: true, status, body } });
  const judge = (raw) => new Function('input', d.config.close_judge.code)({ issue_raw: raw, http_err: '{{close_ticket.error}}' });
  t('close_judge：真 AHub 關票回 201＋state closed ⇒ ok（不叫人）', judge(real(201, { number: 372, state: 'closed', closed_at: '2026-11-21T03:30:05Z' })).route === 'ok');
  t('close_judge：200 也算 ok', judge(real(200, { state: 'closed' })).route === 'ok');
  t('close_judge：412（前置票沒關完）／409 ⇒ fail', judge(real(412, { message: 'x' })).route === 'fail' && judge(real(409, { message: 'y' })).route === 'fail');
  t('close_judge：201 但票還開著 ⇒ fail', judge(real(201, { state: 'open' })).route === 'fail');
  t('close_judge：沒有信封 ⇒ fail', judge('').route === 'fail');
  const plan = (a, s) => new Function('input', d.config.alert_plan.code)({ list_raw: a, sign_raw: s });
  const p = plan(real(200, { requests: [
    { request_id: '102', title: '每日探針失敗：昨天的', state: 'waiting' }, { request_id: '104', title: '別件事要保留', state: 'waiting' },
    { request_id: '105', title: '每日探針：已處理的', state: 'done' }] }), real(200, { requests: [{ request_id: '101', title: '別的簽核', state: 'waiting' }, { request_id: '100', title: '舊的', state: 'agreed' }] }));
  t('alert_plan：昨天的探針警報撤回、別人的要求與簽核保留、已處理的不列', p.withdraw.join() === '102' && p.keep.join() === '104,101', JSON.stringify(p));
  t('alert_plan：兩個看板都讀不到也不壞（空清單、標明沒讀到）', (() => { const q = plan('', ''); return q.success === true && !q.asks_ok && !q.signs_ok && q.keep.length === 0; })());
  t('警報不再讀整份留言（http_request 單次回應上限 64 KB）', !/comment_list/.test(live.replace(/#.*$/gm, '')) && (live.match(/ahub__action_status/g) || []).length === 2 && (live.match(/ahub__signoff_status/g) || []).length === 1);
}
// 成功輪的清掃：撤掉探針自己開過、還開著的警報（開單的人是 feedback-inbox 才撤得掉）；別人的要求不碰
{
  const real = (status, body) => JSON.stringify({ success: true, data: { success: true, status, body } });
  const sp = (raw) => new Function('input', d.config.sweep_plan.code)({ list_raw: raw });
  const a = sp(real(200, { requests: [
    { request_id: '1795231817069295', title: '每日探針：收件站收得到，但測試票關不掉（2026-11-21）', state: 'waiting', opener: 'feedback-inbox' },
    { request_id: '555', title: '別件事', state: 'waiting', opener: 'Leo' },
    { request_id: '556', title: '每日探針：別人開的同名單', state: 'waiting', opener: 'someone' },
    { request_id: '557', title: '每日探針失敗：舊的已處理', state: 'done', opener: 'feedback-inbox' }] }));
  t('sweep_plan：只撤「探針自己開、還在等」的警報', a.found === 1 && a.id1 === '1795231817069295' && a.has1 === 'yes' && a.has2 === 'no' && a.path1.endsWith('/requests/1795231817069295/withdraw'), JSON.stringify(a));
  const b = sp(real(200, { requests: [] }));
  t('sweep_plan：沒有警報就不撤', b.has1 === 'no' && b.found === 0 && b.list_ok === true);
  const e = sp('');
  t('sweep_plan：看板讀不到不壞，標明沒讀到', e.success === true && e.list_ok === false && e.has1 === 'no');
  const dn = (w) => new Function('input', d.config.done.code)({ number: 7, list_ok: true, found: 1, w1: w, w2: '{{sweep_w2.data.body}}', w3: '{{sweep_w3.data.body}}' });
  t('done：記下撤回結果（200），沒撤的節點不列', JSON.stringify(dn(real(200, { state: 'voided' })).sweep_withdraw_status) === '[200]');
  t('done：撤不掉（403）也不讓成功的探針變失敗', (() => { const r = dn(real(403, { code: 'not_opener' })); return r.success === true && r.probe === 'ok' && r.sweep_withdraw_status[0] === 403; })());
  t('成功輪的清掃接在關票成功之後、done 之前', edges.some(([x, , y]) => x === 'gate_close' && y === 'sweep_list') && edges.filter(([, , y]) => y === 'done').every(([x]) => /^sweep_/.test(x)));
}
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
