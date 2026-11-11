// feedback-report.ahub.yaml 的契約（inkstone/InkStoneCo#234，票的正本搬到 AHub）
//
// 跑法：node workflows/tests/feedback-report-ahub-contract.test.mjs
//
// 這份是 Gitea 版（feedback-report.yaml）的 AHub 孿生。它要守的不是「又一個開票流程」，是三件會靜默壞掉的事：
//   ① 兩份 prep 除了 FORGE-SPECIFIC 區段**逐字相同**——標題只做機械處理、外部輸入一律 user + s/triage、
//      輸入長度上限、不呼叫通知端點，這些在 feedback-report-contract.test.mjs 已經測過一遍，
//      這裡不複製第二套，而是證明「AHub 版跑的是同一份」。分叉了這條就紅。
//   ② 開票節點送出的信封，與 forge-config.mjs 的 makeAhubFetch（已對 youlin 上真的 AHub 演練過）送出的**一模一樣**。
//      YAML 是靜態文字，打錯一個欄位名（params 寫成 param）工作流照樣推得上去、照樣回 200，
//      只有票不會出現——所以拿已驗過的那份形狀當對照，不靠肉眼。
//   ③ 成敗只看內層 status：AHub 的具名工作流外層 HTTP 永遠是 200，內層 401／404／422／502 都不能被當成開票成功。
//
// 🔴 第 2 段的 renderValue 是把引擎 graph-executor.ts:695/:711 謄寫過來的（同 feedback-report-contract.test.mjs 檔頭的警告）。

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { codeOf } from './_yaml-code.mjs';
import { renderFeedbackReport, AHUB_FILE, GITEA_FILE } from '../../installer/scripts/render-feedback-report.mjs';
import { makeAhubFetch } from '../../installer/scripts/forge-config.mjs';

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  if (cond) { console.log('PASS:', label); pass++; }
  else { console.log('FAIL:', label, extra); fail++; }
};

const SETTINGS = { kind: 'ahub', cypherUrl: 'https://ahub-host.example.dev', ns: 'nsTEST' };
const template = fs.readFileSync(AHUB_FILE, 'utf8');
const gitea = fs.readFileSync(GITEA_FILE, 'utf8');
const { yaml: y } = renderFeedbackReport(SETTINGS);
const liveOf = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const live = liveOf(y);

// ── 1) 模板與渲染 ───────────────────────────────────────────────────────────
t('模板本身（生效行）不寫任何網址：沒有 leo21c、沒有 git.uncle6.me（#235 地板：網址在渲染時才進去）',
  !/leo21c|git\.uncle6\.me/.test(liveOf(template)), (liveOf(template).match(/leo21c|git\.uncle6\.me/g) || []).join(','));
t('模板有兩個佔位，且生效行只有這兩種', (liveOf(template).match(/__[A-Z][A-Z0-9_]*__/g) || []).every((x) => x === '__AHUB_CYPHER_URL__' || x === '__AHUB_NS__'));
t('渲染後（生效行）不殘留任何 __X__ 佔位', !/__[A-Z][A-Z0-9_]*__/.test(live));
t('渲染後的開票網址指向設定的 AHub 具名工作流',
  live.includes("https://ahub-host.example.dev/webhooks/named/nsTEST/ahub__issue_create/query"));
{
  let threw = null;
  try { renderFeedbackReport({ kind: 'ahub', cypherUrl: 'https://x', ns: '' }); } catch (e) { threw = e; }
  t('設定缺 ns ⇒ 渲染器當場丟（不輸出一份會開不了票的 YAML）', !!threw, String(threw));
  const g = renderFeedbackReport({ kind: 'gitea' });
  t('TICKET_FORGE=gitea ⇒ 渲染出 Gitea 版原檔（回退）', g.forge === 'gitea' && g.yaml === gitea);
}

// ── 2) 檔案契約（與 Gitea 版同一套紅線）─────────────────────────────────────
t('三個 code 節點都用零件名 component: code', (live.match(/^    component: code$/gm) || []).length === 3);
t('唯一的對外節點是 component: http_request', (live.match(/^    component: http_request$/gm) || []).length === 1);
t('不引用任何私庫 recipe', !/component:\s*"?(gitea_create_issue|notify_leo_relay)"?/.test(live));
t('不殘留 __CODE_URL__', !live.includes('__CODE_URL__'));
t('http_request 用 body_json:（物件），第一層沒有裸 body:', (live.match(/^    body_json:$/gm) || []).length === 1 && (live.match(/^    body:/gm) || []).length === 0);
t('金鑰只寫名字 {{credential.ahub_token}}，沒有真身，也沒有 Gitea 的 gitea_token',
  live.includes('{{credential.ahub_token}}') && !live.includes('gitea_token') && !/token [A-Za-z0-9]{20,}/.test(live));
t('沒有 Authorization header（AHub 從信封的 token 欄讀身分，不讀 HTTP header）', !/Authorization:/.test(live));
t('不呼叫任何通知端點', !/notify_url|notify_ok|notify_leo/.test(live));

// ── 3) prep 共用段逐字相同 ──────────────────────────────────────────────────
const stripForge = (code) => code.replace(/^[ \t]*\/\/ FORGE-SPECIFIC-BEGIN[\s\S]*?\/\/ FORGE-SPECIFIC-END[ \t]*\n/m, '');
const prepG = codeOf(gitea, 'prep');
const prepA = codeOf(y, 'prep');
t('兩份 prep 都標了 FORGE-SPECIFIC 區段', /FORGE-SPECIFIC-BEGIN/.test(prepG) && /FORGE-SPECIFIC-END/.test(prepG) && /FORGE-SPECIFIC-BEGIN/.test(prepA) && /FORGE-SPECIFIC-END/.test(prepA));
t('🔴 兩份 prep 除了 FORGE-SPECIFIC 區段**逐字相同**（分叉＝兩條路各自漂移）',
  stripForge(prepG) === stripForge(prepA),
  (() => { const a = stripForge(prepG).split('\n'), b = stripForge(prepA).split('\n'); const i = a.findIndex((l, k) => l !== b[k]); return `第 ${i + 1} 行：${a[i]} ≠ ${b[i]}`; })());
t('兩份的 flow 邊完全相同（圖的形狀沒分叉）',
  JSON.stringify(y.match(/^  - ".+"$/gm)) === JSON.stringify(gitea.match(/^  - ".+"$/gm)));
t('兩份 finalize 節點逐字相同', (() => {
  const f = (s) => s.slice(s.indexOf('\n  finalize:')).trim();
  return f(y) === f(gitea);
})());

// ── 4) prep（AHub 版）跑出來的東西 ──────────────────────────────────────────
const prep = new Function('input', prepA);
const o = prep({ text: '搜尋找不到\n第二行', version: '1.4.115', instance: 'ns', os: 'mac', reporter: '王小明（ming@example.com）' });
t('prep 回 success', o && o.success === true);
t('api_url ＝ 渲染進去的 AHub issue_create 具名工作流', o.api_url === 'https://ahub-host.example.dev/webhooks/named/nsTEST/ahub__issue_create/query', o.api_url);
t('path／params 對得上 repo（預設 inkstone/arcrun-rag）',
  o.path === '/repos/inkstone/arcrun-rag/issues' && o.params.owner === 'inkstone' && o.params.repo === 'arcrun-rag', JSON.stringify([o.path, o.params]));
t('標籤用名字：user＋s/triage（外部輸入一律進分診，不准直接 s/todo）', JSON.stringify(o.labels) === '["user","s/triage"]', JSON.stringify(o.labels));
{
  const o2 = prep({ text: 'x', repo: 'inkstone/other-repo' });
  t('呼叫端指定別的 repo 也走得通', o2.path === '/repos/inkstone/other-repo/issues' && o2.params.repo === 'other-repo');
  const o3 = prep({ text: 'x', repo: '../../etc/passwd' });
  t('壞的 repo 字串一律退回 inkstone/arcrun-rag（不讓呼叫端把票開去任意路徑）', o3.path === '/repos/inkstone/arcrun-rag/issues', o3.path);
}

// ── 5) 開票節點的信封 ＝ 已驗過的 makeAhubFetch 信封 ────────────────────────
//    引擎謄寫（見檔頭）：整串是單一 {{x}} 回原型別，否則逐段替換；物件結構上逐值遞迴。
const getPath = (obj, path) => path.split('.').reduce((c, k) => (c === null || c === undefined || typeof c !== 'object' ? undefined : c[k]), obj);
const renderString = (s, ctx) => {
  const single = s.match(/^\s*\{\{([\w.]+)\}\}\s*$/);
  if (single) { const v = getPath(ctx, single[1]); return v === undefined ? s : v; }
  return s.replace(/\{\{([\w.]+)\}\}/g, (m, k) => { const v = getPath(ctx, k); return v === undefined ? m : (typeof v === 'object' ? JSON.stringify(v) : String(v)); });
};
const renderValue = (v, ctx) => (typeof v === 'string' ? renderString(v, ctx)
  : Array.isArray(v) ? v.map((x) => renderValue(x, ctx))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderValue(x, ctx)])) : v);

const parsed = JSON.parse(execFileSync('python3', ['-I', '-c',
  'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: y, encoding: 'utf8' }));
const node = parsed.config.create_issue;
t('create_issue 是 POST http_request，網址取自 prep', node.component === 'http_request' && node.method === 'POST' && node.url === '{{prep.data.api_url}}');
t('body_json 的欄位恰好是信封七件：method/path/query/body/token/params/base',
  JSON.stringify(Object.keys(node.body_json).sort()) === JSON.stringify(['base', 'body', 'method', 'params', 'path', 'query', 'token']), Object.keys(node.body_json).join(','));
t('信封的 body 恰好是 title/body/labels＋event_key/compared 五欄（#309：事件鍵與逐張交代）',
  JSON.stringify(Object.keys(node.body_json.body).sort()) === '["body","compared","event_key","labels","title"]');

const sentFull = renderValue(node.body_json, { prep: { data: o } });
// #309：event_key／compared 是 AHub 0.18.0 才有的兩欄，makeAhubFetch（出貨線用）不送；比對信封形狀時先拿掉。
const sent = { ...sentFull, body: { title: sentFull.body.title, body: sentFull.body.body, labels: sentFull.body.labels } };
const seen = [];
const recorder = async (url, init) => { seen.push(JSON.parse(init.body)); return { status: 200, text: async () => JSON.stringify({ success: true, data: { status: 201, body: {} } }) }; };
await makeAhubFetch({ cypherUrl: SETTINGS.cypherUrl, ns: SETTINGS.ns, fetchImpl: recorder })(
  'https://x/api/v1/repos/inkstone/arcrun-rag/issues',
  { method: 'POST', headers: { authorization: 'token {{credential.ahub_token}}' }, body: JSON.stringify({ title: o.title, body: o.body, labels: o.labels }) });
t('🔴 YAML 渲染出的信封 ＝ makeAhubFetch 對同一個呼叫送出的信封（逐欄相同，含 token 佔位）',
  JSON.stringify(sent) === JSON.stringify(seen[0]), `\nYAML: ${JSON.stringify(sent).slice(0, 300)}\nfetch: ${JSON.stringify(seen[0]).slice(0, 300)}`);
t('信封裡 labels 保持字串陣列原型別、body 的換行原樣保留', Array.isArray(sent.body.labels) && sent.body.labels[1] === 's/triage' && sent.body.body.includes('\n'));
t('#309：沒帶事件鍵時 prep 自己算一個（不能是空字串：空值插值會留下字面 {{…}}，AHub 回 422）',
  /^auto:[a-z0-9]+-\d+$/.test(o.event_key) && sentFull.body.event_key === o.event_key, String(o.event_key));
t('#309：沒帶逐張交代 ⇒ compared 是空陣列（原型別保留）', Array.isArray(sentFull.body.compared) && sentFull.body.compared.length === 0);
t('token 欄是金鑰佔位（執行前由金鑰中心回填），不是真身', sent.token === '{{credential.ahub_token}}');

// ── 6) after_issue：成敗只看內層 status ─────────────────────────────────────
t('after_issue 讀 create_issue.data.body', (y.match(/^      issue_raw: "(.+)"$/m) || [])[1] === '{{create_issue.data.body}}');
const after = new Function('input', codeOf(y, 'after_issue'));
const wrap = (status, body) => JSON.stringify({ success: true, data: { success: true, status, body } });
{
  const ok = after({ issue_raw: wrap(201, { number: 321, html_url: 'https://ahub-host.example.dev/inkstone/arcrun-rag/issues/321' }) });
  t('201＋票號 ⇒ 成功，拿得到票號', ok.success === true && ok.number === 321, JSON.stringify(ok));
  t('也吃得下已解析成物件的回應', after({ issue_raw: JSON.parse(wrap(201, { number: 5 })) }).number === 5);
  t('也吃得下多一層 data 的外殼', after({ issue_raw: JSON.stringify({ success: true, data: { data: { status: 201, body: { number: 6 } } } }) }).number === 6);
  for (const [st, msg] of [[401, 'token is required'], [404, 'repository not found'], [422, 'label not found: user'], [502, 'KBDB read failed (HTTP 500)'], [503, 'could not claim an issue number']]) {
    const bad = after({ issue_raw: wrap(st, { message: msg }) });
    t(`內層 ${st} ⇒ 誠實判失敗（外層 HTTP 是 200 也不能當成功），訊息帶狀態碼與原因`,
      bad.success === false && bad.error.includes(String(st)) && bad.error.includes(msg), JSON.stringify(bad));
  }
  t('200 但沒有票號 ⇒ 失敗', after({ issue_raw: wrap(201, {}) }).success === false);
  t('回應不是 JSON ⇒ 失敗', after({ issue_raw: '<html>524</html>' }).success === false);
  t('拿到 Gitea 形狀（沒有 {status,body} 外殼）⇒ 失敗，不假綠', after({ issue_raw: JSON.stringify({ number: 9 }) }).success === false);
  t('after_issue 不組任何通知文案', !('notify_text' in ok));
}

// ── 7) #309：事件鍵——同一事件併成留言、相近票被擋時把候選交給小幫手 ──────────
{
  const merged = after({ base: 'https://ahub-host.example.dev', issue_raw: wrap(200, { merged: true, merged_into: 'inkstone/arcrun-rag#1700', number: 1700, comment_id: 9 }) });
  t('200 merged ⇒ 成功（內容已併成留言），回第一張的票號與網址',
    merged.success === true && merged.merged === true && merged.number === 1700 && merged.html_url === 'https://ahub-host.example.dev/inkstone/arcrun-rag/issues/1700', JSON.stringify(merged));
  t('200 但不是 merged 且沒有票號 ⇒ 仍然失敗（不假綠）', after({ issue_raw: wrap(200, { ok: true }) }).success === false);
  const dup = after({ issue_raw: wrap(409, { message: '開票前比對到 2 張…', candidates: [{ ref: 'inkstone/arcrun-rag#198' }, { ref: 'inkstone/Arcrun#95' }, { ref: 'bad ref' }] }) });
  t('409 ⇒ 失敗，錯誤訊息帶「重複候選=」與每張候選的 ref（小幫手據此帶逐張交代重送）',
    dup.success === false && /重複候選=inkstone\/arcrun-rag#198 inkstone\/Arcrun#95$/.test(dup.error), JSON.stringify(dup));
  const k = prep({ text: 'x', event_key: 'abc.dev:file:foo-1a2b3c4d:cloud_ai', compared: [{ ref: 'inkstone/arcrun-rag#198', reason: '不同事件鍵' }] });
  t('prep 照傳小幫手帶來的事件鍵與逐張交代', k.event_key === 'abc.dev:file:foo-1a2b3c4d:cloud_ai' && k.compared.length === 1 && k.compared[0].ref === 'inkstone/arcrun-rag#198', JSON.stringify(k));
  t('壞的事件鍵（含空白／中文）⇒ 當沒帶、改由 prep 自己算，回報照樣送得出去', /^auto:/.test(prep({ text: 'x', event_key: '含 空白' }).event_key));
  t('同一個實例＋同一段話 ⇒ 同一個自動事件鍵；換一段話 ⇒ 不同鍵',
    prep({ text: '搜尋壞了', instance: 'a' }).event_key === prep({ text: '搜尋壞了', instance: 'a' }).event_key
    && prep({ text: '搜尋壞了', instance: 'a' }).event_key !== prep({ text: '上傳壞了', instance: 'a' }).event_key);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
