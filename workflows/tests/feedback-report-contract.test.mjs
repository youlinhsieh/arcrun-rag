// feedback-report.yaml 的四條契約（inkstone/arcrun-rag#210）
//
// 跑法：node workflows/tests/feedback-report-contract.test.mjs
//
// 治的病：這幾件都是**靜默失效**——YAML 讀起來完全正常、推得上去、工作流也會跑，
// 但學員按下送出之後，票不會出現、或是票出現了學員卻被告知「沒送出去」。
// 沒有任何一站會喊。
//
//   ① 節點引用私庫 recipe（`component: gitea_create_issue` / `notify_leo_relay`）
//      → 上線變成兩個動作，而推 recipe 那個動作在雲端推不上去（comment 10532/10540）。
//      改成引擎自帶的 `http_request` 之後，推一次 workflow 就完整上線。
//   ② `http_request` 的 body 寫成 `body:`（字串）而不是 `body_json:`（物件）
//      → 換行與引號要自己跳脫，跟舊的 recipe 裸 body: 同一個病。
//   ③ canonical .yaml 裡留著 `__CODE_URL__` 佔位
//      → 那個佔位只有**安裝器**那條路會代換（installer/src/index.js 的 subsMap，
//        對象是 *.local.yaml 編出來的 workflows.json）。canonical 版沒人代換它，
//        會原字串推上實例 → component-loader 走到「找不到零件」。
//   ④ 🔴 **兩條 ON_SUCCESS 從同一個節點分叉，第二條會被第一條的結果決定走不走。**
//      `graph-executor.ts:484` 的出邊迴圈裡 `result` 是共用變數，跑完第一條邊就被覆寫。
//      舊版 `after_issue >> ON_SUCCESS >> notify` ＋ `after_issue >> ON_SUCCESS >> finalize`
//      ⇒ notify 404（現況）就把 finalize 整個跳掉 ⇒ 票開成了、學員卻看到「沒送出去」
//      ⇒ 他再送一次 ⇒ **每則回報兩張票**。第 5 段用引擎那段迴圈的謄寫版證明這件事。
//
// 🔴 本檔第 2 段與第 5 段是把引擎實作**謄寫**過來的（它們住在 inkstone/Arcrun，不在本 repo）：
//    graph-executor.ts:695 `interpolateString`／:711 `interpolateValue`／:484-530 出邊迴圈／
//    component-loader.ts:270 `makeHttpRunner`／:402 recipe 裸 body 那條／
//    registry/components/http_request/main.go:77 `json.Marshal(body_json)`。
//    謄寫就有漂移風險——**引擎那幾段變了，要回來重看這個前提**，不要因為這裡還是綠的
//    就當它還成立。第 1、3、4 段不依賴謄寫（直接讀檔／跑 YAML 裡真的那段 code）。

import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const yamlPath = new URL('../feedback-report.yaml', import.meta.url).pathname;
const y = fs.readFileSync(yamlPath, 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  if (cond) { console.log('PASS:', label); pass++; }
  else { console.log('FAIL:', label, extra); fail++; }
};

// ⚠️ 一律只看**實際生效的行**，不看註解——檔頭那幾段正是在解釋「為什麼不可以用
//    __CODE_URL__／不可以引用 recipe」，連它一起擋掉的話，寫下理由就會把自己的測試弄紅。
const liveLines = y.split('\n').filter(l => !/^\s*#/.test(l));
const live = liveLines.join('\n');

// ── 1) 檔案契約（直接讀檔，不依賴任何謄寫）──────────────────────────────
t('canonical .yaml 的生效行不得殘留 __CODE_URL__ 佔位',
  liveLines.filter(l => l.includes('__CODE_URL__')).length === 0);

t('三個 code 節點都用零件名 component: code',
  (live.match(/^    component: code$/gm) || []).length === 3);

t('兩個對外節點都用引擎自帶的 component: http_request',
  (live.match(/^    component: http_request$/gm) || []).length === 2);

// ① 這條才是「推一次就上線」的守門員
const recipeRefs = liveLines.filter(l => /^\s*component:\s*"?(gitea_create_issue|notify_leo_relay)"?\s*$/.test(l));
t('生效行不得引用任何私庫 recipe（引用了就變成兩個上線動作）',
  recipeRefs.length === 0, JSON.stringify(recipeRefs));

// ② body_json 而不是 body
t('兩個 http_request 節點都用 body_json:',
  (live.match(/^    body_json:$/gm) || []).length === 2);
t('沒有任何節點在第一層寫裸 body:（那是 recipe 的寫法，跳脫順序是反的）',
  (live.match(/^    body:/gm) || []).length === 0);

// 金鑰只寫名字（D36）
t('金鑰只寫 {{credential.gitea_token}}，檔裡沒有任何真身',
  live.includes('{{credential.gitea_token}}') && !/token [A-Za-z0-9]{20,}/.test(live));

// ── 2) 節點那條路的跳脫順序（謄寫，見檔頭紅字）────────────────────────────
function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}
/** graph-executor.ts:695 interpolateString —— 整串是單一 {{x}} 就回原型別 */
function renderString(s, ctx) {
  const single = s.match(/^\s*\{\{([\w.]+)\}\}\s*$/);
  if (single) { const v = getPath(ctx, single[1]); return v === undefined ? s : v; }
  return s.replace(/\{\{([\w.]+)\}\}/g, (m, k) => {
    const v = getPath(ctx, k);
    return v === undefined ? m : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
}
/** graph-executor.ts:711 interpolateValue —— 在**物件結構上**逐值替換 */
function renderValue(v, ctx) {
  if (typeof v === 'string') return renderString(v, ctx);
  if (Array.isArray(v)) return v.map(x => renderValue(x, ctx));
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = renderValue(val, ctx);
    return o;
  }
  return v;
}
/** 節點路徑：interpolateData 先替換 → makeHttpRunner 整包 stringify 一次
 *  → http_request main.go 再 json.Marshal(body_json) 一次。兩次都是「先組物件再序列化」。*/
const viaNode = (def, ctx) => JSON.stringify(renderValue(def, ctx));
/** component-loader.ts:402 recipe 裸 body：先序列化、再對字串做替換（不跳脫）——留著當對照組 */
const viaBareBody = (def, ctx) =>
  JSON.stringify(def).replace(/\{\{(auth\.)?([\w.]+)\}\}/g, (_, a, k) => String(a ? '' : (getPath(ctx, k) ?? '')));

const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

/** 從 YAML 抽某節點底下某個 4 空格縮排區塊的「6 空格 key: value」平面對映。
 *  抽不到就 throw——形狀變了要紅，不要靜默略過。 */
function blockOf(yaml, node, key) {
  const lines = yaml.split('\n');
  let inNode = false, inBlock = false;
  const out = {};
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (/^  [A-Za-z_][A-Za-z0-9_]*:\s*$/.test(line)) {
      if (inBlock) break;
      inNode = line.trim() === node + ':';
      continue;
    }
    if (!inNode) continue;
    if (!inBlock) { if (line.trim() === key + ':') inBlock = true; continue; }
    const m = line.match(/^      ([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) break;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  if (!Object.keys(out).length) throw new Error(`抽不到 ${node}.${key}`);
  return out;
}

const createIssueBody = blockOf(y, 'create_issue', 'body_json');
t('create_issue.body_json 就是 title/body/labels 三欄',
  ['title', 'body', 'labels'].every(k => k in createIssueBody) && Object.keys(createIssueBody).length === 3,
  JSON.stringify(createIssueBody));

// ── 3) 拿**真的那段 prep**（從 YAML 抽出來跑，不是抄一份）────────────────
const prep = new Function('input', codeOf(y, 'prep'));

const cases = {
  '最短最乾淨（一行、無引號）': { text: '搜尋找不到', version: '1.4.72', instance: 'ns', os: 'mac', reporter: '王小明（ming@example.com）' },
  '一行、內含雙引號':          { text: '它說 "已索引" 但查不到', version: '1.4.72', instance: 'ns', os: 'mac', reporter: '王小明（ming@example.com）' },
  '多行':                      { text: '第一行\n第二行', version: '1.4.72', instance: 'ns', os: 'mac', reporter: '王小明（ming@example.com）' },
  '附診斷檔':                  { text: '搜尋找不到', version: '1.4.72', instance: 'ns', os: 'mac', reporter: '王小明（ming@example.com）', diagnostics: { docs: 1 } },
  '桌面小幫手（沒有 reporter）': { text: '搜尋找不到', version: '1.4.72', instance: 'ns', os: 'darwin' },
};

for (const [name, input] of Object.entries(cases)) {
  const o = prep(input);
  t(`prep 回 success（${name}）`, o && o.success === true, JSON.stringify(o).slice(0, 80));

  // 這一條才是「為什麼跳脫順序要對」的根：prep 組的 body 必定是多行
  t(`prep 的 body 必定含換行（${name}）`, typeof o.body === 'string' && o.body.includes('\n'));

  // 🔴 票上紅線：不能看起來像機器自己開的 ⇒ 內文一定要有回報者那一段
  t(`body 帶得出回報者（${name}）`,
    o.body.includes('## 回報者\n' + o.reporter), o.reporter);

  const ctx = { prep: { data: o } };

  t(`節點路徑送得出合法 JSON（${name}）`, parses(viaNode(createIssueBody, ctx)));
  t(`裸 body 路徑送出的不是合法 JSON（${name}）— 對照組，說明為什麼不能退回去`,
    !parses(viaBareBody(createIssueBody, ctx)));

  const got = JSON.parse(viaNode(createIssueBody, ctx));
  t(`labels 保持陣列原型別（${name}）`,
    Array.isArray(got.labels) && got.labels.length === 2 && got.labels[0] === 493,
    JSON.stringify(got.labels));
  t(`body 的換行原樣保留（${name}）`, got.body.includes('\n'));
}

// reporter 的兩個邊界：有名字就用名字、沒名字就誠實說沒名字（不要假裝有）
t('有 reporter 時原樣寫進票', prep(cases['最短最乾淨（一行、無引號）']).reporter === '王小明（ming@example.com）');
t('沒有 reporter 時誠實標「桌面小幫手（本機，未具名）」',
  prep(cases['桌面小幫手（沒有 reporter）']).reporter === '桌面小幫手（本機，未具名）');
t('reporter 裡的控制字元被洗掉（不能讓它把票的內文排版撐爛）',
  prep({ text: 'x', reporter: '壞\n人\u0000' }).reporter === '壞 人');

// 內含雙引號那則，節點路徑要把引號原樣保住
{
  const o = prep(cases['一行、內含雙引號']);
  const got = JSON.parse(viaNode(createIssueBody, { prep: { data: o } }));
  t('雙引號原樣保留在 body 裡', got.body.includes('"已索引"'), got.body.slice(0, 60));
}

// ── 3.5) 呼叫端「沒帶」的欄位：插值後是字面 {{input.x}}，不是 undefined ──────
//    graph-executor.ts:700 取不到值就回原字串 ⇒ prep 必須自己認出這種「沒帶」。
//    不認的話：沒附診斷檔的票會印出 ```json "{{input.diagnostics}}"```、
//    桌面小幫手（沒有登入身分、不帶 reporter）送的票回報者寫成「{{input.reporter}}」。
//    兩者都是靜默的——YAML 正常、工作流照樣回 success，只有票長得很奇怪。
{
  const unresolved = prep({
    text: '搜尋找不到', version: '1.4.72', instance: 'ns', os: 'darwin',
    reporter: '{{input.reporter}}', diagnostics: '{{input.diagnostics}}',
    repo: '{{input.repo}}', notify_url: '{{input.notify_url}}',
  });
  t('沒帶 reporter（字面佔位）→ 誠實標「桌面小幫手（本機，未具名）」',
    unresolved.reporter === '桌面小幫手（本機，未具名）', unresolved.reporter);
  t('沒附診斷檔（字面佔位）→ 寫「（沒有附上診斷檔）」，不是把佔位塞進 json 區塊',
    unresolved.body.includes('## 診斷檔\n（沒有附上診斷檔）'),
    unresolved.body.split('## 診斷檔')[1].slice(0, 40));
  t('沒帶 repo（字面佔位）→ 回到 inkstone/arcrun-rag', unresolved.repo === 'inkstone/arcrun-rag');
  t('沒帶 notify_url（字面佔位）→ 用預設端點，不是拿佔位當網址',
    unresolved.notify_url.startsWith('https://'), unresolved.notify_url);
  t('整個 body 裡不得殘留任何 {{...}} 字面',
    !/\{\{[\w.]+\}\}/.test(unresolved.body),
    (unresolved.body.match(/\{\{[\w.]+\}\}/g) || []).join(','));
  // 學員原話裡自己寫了 {{something}} 是**資料**，不可以被當成沒帶而吃掉
  const literal = prep({ text: '我打 {{input.text}} 它就壞掉', reporter: '王小明' });
  t('學員原話裡的 {{...}} 是資料，原樣保留（不要當成沒帶）',
    literal.title === '我打 {{input.text}} 它就壞掉', literal.title);
  // 只認 {{input.x}}：其他形狀的大括號一律當資料（縮小「把學員的話吃掉」的面）
  const braces = prep({ text: 'x', reporter: '{{foo}}' });
  t('只吃 {{input.x}} 這一種佔位，{{foo}} 當資料保留', braces.reporter === '{{foo}}', braces.reporter);
}

// ── 4) after_issue 讀的是 http_request 的信封形狀 ─────────────────────────
//    http_request 成功時回 {success:true, data:{body:"<回應原文字串>"}}（main.go 末段）
//    ⇒ after_issue.input.issue_raw 必須指到 create_issue.data.body，指到 .data 會拿到物件、
//      而那個物件沒有 number ⇒ 永遠判成「開票失敗」。
{
  const rawIssueRef = (y.match(/^      issue_raw: "(.+)"$/m) || [])[1];
  t('after_issue 讀 create_issue.data.body（不是 .data）',
    rawIssueRef === '{{create_issue.data.body}}', String(rawIssueRef));

  const afterIssue = new Function('input', codeOf(y, 'after_issue'));
  const giteaRaw = JSON.stringify({ number: 999, html_url: 'https://git.uncle6.me/inkstone/arcrun-rag/issues/999' });
  const out = afterIssue({ issue_raw: giteaRaw, title: '搜尋找不到' });
  t('after_issue 從回應原文字串解析得出票號',
    out && out.success === true && out.number === 999, JSON.stringify(out).slice(0, 80));
  t('after_issue 也吃得下已經是物件的回應（防呆）',
    afterIssue({ issue_raw: JSON.parse(giteaRaw), title: 'x' }).number === 999);
  t('Gitea 回錯誤時誠實判失敗（不假綠）',
    afterIssue({ issue_raw: '{"message":"token does not have write access"}', title: 'x' }).success === false);
  t('notify_text 只有一句話＋連結',
    out.notify_text.split('\n').length === 2 && out.notify_text.includes('/issues/999'));

  const notifyBody = blockOf(y, 'notify', 'body_json');
  t('notify 只帶 text 一欄', Object.keys(notifyBody).length === 1 && 'text' in notifyBody);
  t('notify：節點路徑送得出合法 JSON（notify_text 必定含換行）',
    parses(viaNode(notifyBody, { after_issue: { data: out } })));
}

// ── 5) 出邊迴圈：notify 紅了也一定走得到 finalize（謄寫，見檔頭紅字）──────
//    謄寫來源：graph-executor.ts:484-530。重點是 `result` 是迴圈外的共用變數。
function isFailure(r) {
  if (r === null || typeof r !== 'object') return false;
  return r.success === false || 'error' in r;
}
const flowEdges = (y.match(/^  - "(.+)"$/gm) || []).map(l => {
  const [from, type, to] = l.replace(/^  - "/, '').replace(/"$/, '').split('>>').map(s => s.trim());
  return { from, type, to };
});
t('flow 有 notify >> ON_FAIL >> finalize 這條退路（這是圖的形狀，不是註解）',
  flowEdges.some(e => e.from === 'notify' && e.type === 'ON_FAIL' && e.to === 'finalize'));
t('finalize 沒有別的入邊來源（它是圖上唯一的終點）',
  flowEdges.filter(e => e.to === 'finalize').every(e => e.from === 'notify'));

/** 只跑 ON_SUCCESS / ON_FAIL 兩種邊，回「最後 result 是誰的」。nodeOut: nodeId → 該節點的 output */
function runFrom(nodeId, edges, nodeOut, seen = new Set()) {
  if (seen.has(nodeId)) return nodeOut[nodeId];
  seen.add(nodeId);
  let result = nodeOut[nodeId];
  for (const e of edges.filter(x => x.from === nodeId)) {
    if (e.type === 'ON_SUCCESS' && !isFailure(result)) result = runFrom(e.to, edges, nodeOut, seen);
    else if (e.type === 'ON_FAIL' && isFailure(result)) result = runFrom(e.to, edges, nodeOut, seen);
  }
  return result;
}
const nodeOut = {
  after_issue: { success: true, data: { number: 999 } },
  notify:      { success: false, status: 404, error: 'HTTP 404' },   // ← 現況：通道是死的
  finalize:    { success: true, data: { number: 999, notify_ok: false } },
};
t('🔴 notify 404 時，本版仍然回得出票號（finalize 有跑到）',
  getPath(runFrom('after_issue', flowEdges, nodeOut), 'data.number') === 999);

const notifyOk = { ...nodeOut, notify: { success: true, data: { body: 'ok' } } };
t('notify 成功時同樣回得出票號（不會重複跑 finalize）',
  getPath(runFrom('after_issue', flowEdges, notifyOk), 'data.number') === 999);

// 舊形狀（兩條 ON_SUCCESS 分叉）拿同一組輸入跑——證明它真的會掉票號
const oldEdges = [
  { from: 'after_issue', type: 'ON_SUCCESS', to: 'notify' },
  { from: 'after_issue', type: 'ON_SUCCESS', to: 'finalize' },
];
t('對照組：舊的兩條 ON_SUCCESS 形狀在 notify 404 時回不出票號（這就是本版改圖的理由）',
  getPath(runFrom('after_issue', oldEdges, nodeOut), 'data.number') === undefined);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
