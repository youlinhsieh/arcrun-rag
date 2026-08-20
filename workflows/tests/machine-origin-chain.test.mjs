// machine-origin-chain.test.mjs — `inkstone/mira#6`：**整條線**跑一次，不是逐處單測。
//
// 為什麼非得有這一支（總管 2026-08-18 的話就是理由）：
//   「只修其中一處，畫面上完全看不出還壞著——這正是今天反覆出現的『靜默失效』。
//     ⇒ 收工驗收必須是端到端（真的問一題、看出處列不列得出兩台），不是逐處單測。」
// 同一個需求被三個不同位置各自去重，每一處都有自己的綠燈單測，整條線卻是壞的。
// 逐處單測抓不到這件事，因為每一處都「照自己的規格做對了」。
//
// 所以本檔把三層**真正的實作**串起來跑，一個都不重寫：
//   ① workflow  `workflows/rag-chat.local.yaml` 的 assemble code 節點（本 repo）
//   ② 引擎      `cypher-executor/src/routes/portal-data.ts` 的 dedupeSourcesByPage（matrix/arcrun）
//   ③ 前端      `console-ui/public/portal/index.html` 的 machineLabelMap／srcCrumbs／
//               srcCrumbRowHtml（matrix/arcrun）
// 斷言下在**最後那一格 HTML** 上——leo 眼睛真的會看到的東西。
//
// 🔴 三層的程式碼一律**從原始檔讀出來執行**，絕不在本檔重寫一份。
//   這個 repo 被「測試複製了實作邏輯、變成回音而不是閘」咬過兩次：抄一份到測試裡，
//   實作改壞了測試照樣綠，因為它測的是那份副本。
//
// ⚠️ 本檔需要 matrix/arcrun 的 checkout（下游那兩層住在那裡）。找不到就**大聲失敗**，
//   不靜默略過——「跳過的測試」就是假綠的另一種長相。
//   指定位置：`ARCRUN_REPO=/path/to/matrix/arcrun node workflows/tests/machine-origin-chain.test.mjs`
//
// 🔴 下游兩層一律讀 **git 裡的 `main`**，不讀那個 repo 的工作目錄。
//   理由是實撞出來的（2026-08-18 本檔第一次跑）：matrix/arcrun 當時 detached 在
//   `ff098fa`，那個 commit 還沒有「頁×機器」去重 ⇒ 本檔紅了 5 格。
//   紅得對，但紅的是「那台機器上剛好 checkout 了哪一支分支」，不是會出貨的東西。
//   同時有好幾條線在那個 repo 上跑，工作目錄隨時在換分支 ⇒ 讀它等於讓本檔隨機紅。
//   要驗別的分支：`ARCRUN_REF=<ref>`。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { codeOf } from './_yaml-code.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

// ── 找到 matrix/arcrun（下游兩層的真身）────────────────────────────────────
const MARK = path.join('console-ui', 'public', 'portal', 'index.html');
function findArcrunRepo() {
  const cands = [];
  if (process.env.ARCRUN_REPO) cands.push(process.env.ARCRUN_REPO);
  const seeds = [here, process.cwd()];
  // git worktree 的實體目錄可能不在 repo 樹底下（本票就是在 worktree 裡做的）
  // ⇒ 從 git 的共用目錄再往上找一次。
  try {
    seeds.push(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: here, encoding: 'utf8' }).trim());
  } catch (e) { /* 不是 git 樹也沒關係，上面兩個 seed 通常就夠 */ }
  for (const seed of seeds) {
    let d = seed;
    for (let i = 0; i < 12 && d && d !== path.dirname(d); i++) {
      cands.push(path.join(d, 'matrix', 'arcrun'));
      d = path.dirname(d);
    }
  }
  for (const c of cands) { if (fs.existsSync(path.join(c, MARK))) return c; }
  throw new Error(
    '找不到 matrix/arcrun 的 checkout —— 本檔要跑的是下游兩層的**真實程式碼**，沒有它就無法端到端驗證。\n' +
    '請用 ARCRUN_REPO=<matrix/arcrun 的路徑> 指定。找過：\n  ' + cands.slice(0, 8).join('\n  '));
}
const ARCRUN = findArcrunRepo();
const ARCRUN_REF = process.env.ARCRUN_REF || 'main';
// 讀那個 repo 的 git 內容（不是工作目錄——見檔頭那段紅字）。
function arcrunFile(rel) {
  try {
    return execFileSync('git', ['-C', ARCRUN, 'show', `${ARCRUN_REF}:${rel}`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`讀不到 ${ARCRUN} 的 ${ARCRUN_REF}:${rel}（${String(e.message).split('\n')[0]}）`);
  }
}

// 從原始檔切出一個具名函式的原文（大括號配對）。切出來的是**真的那段程式碼**。
function fnSrc(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(`在來源裡找不到 function ${name}(`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(at, j + 1); }
  }
  throw new Error(`function ${name} 的大括號沒有收尾`);
}

// ① workflow：本 repo 的 assemble
const chatYaml = fs.readFileSync(path.join(here, '..', 'rag-chat.local.yaml'), 'utf8');
const assemble = new Function('input', codeOf(chatYaml, 'assemble'));

// ② 引擎：真的那支 dedupeSourcesByPage（TS → 用 node 內建的型別剝除，不是我自己翻寫成 JS）
const portalDataTs = arcrunFile('cypher-executor/src/routes/portal-data.ts');
const dedupeSourcesByPage = new Function(
  'return ' + stripTypeScriptTypes(fnSrc(portalDataTs, 'dedupeSourcesByPage')))();

// ③ 前端：真的那幾支（都是純 JS，直接切出來用）
const portalHtml = arcrunFile('console-ui/public/portal/index.html');
const FRONT = [
  // SOURCE_WEB_BASE 是伺服器注入的設定值（檔案裡就是空字串），不是邏輯 ⇒ 這裡給同樣的空值。
  'var SOURCE_WEB_BASE = "";',
  'var SEARCH_MODE_LABEL = ' + (/var SEARCH_MODE_LABEL = (\{[^}]*\});/.exec(portalHtml) || [])[1] + ';',
  fnSrc(portalHtml, 'esc'),
  fnSrc(portalHtml, 'encSrcPath'),
  fnSrc(portalHtml, 'srcHref'),
  fnSrc(portalHtml, 'srcLocalPath'),
  fnSrc(portalHtml, 'searchModeLabel'),
  fnSrc(portalHtml, 'machineLabelMap'),
  fnSrc(portalHtml, 'srcCrumbs'),
  fnSrc(portalHtml, 'srcCrumbRowHtml'),
  'return { machineLabelMap: machineLabelMap, srcCrumbs: srcCrumbs, srcCrumbRowHtml: srcCrumbRowHtml };',
].join('\n');
const front = new Function(FRONT)();

// ── 素材：daemon 實際會寫進 KBDB 的形狀 ───────────────────────────────────
const MBA = { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' };
const IMAC = { machine: 'youlinhsieh@Leo-iMac', machine_label: '教育部 Leo 的 iMac' };
const entry = (page, filePath, opts = {}) => ({
  page_name: page,
  content: opts.content || `# ${page}\n這一段是 ${page} 的原文。`,
  metadata_json: JSON.stringify({
    source: `kb://${filePath}#0`, source_path: filePath, library: opts.library || 'kb',
    ...(opts.machine ? { machine: opts.machine, machine_label: opts.machine_label } : {}),
    embed: true,
  }),
});

// 整條線跑一次：問句 + KBDB 回的 entries → 前端最後印出來的那段 HTML。
function askEndToEnd(question, entries) {
  const r = assemble({
    question,
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({ entries }),
  });
  // 引擎那一層：/portal/data/chat 就是把 workflow 的 sources 丟進這支再回給前端
  const deduped = dedupeSourcesByPage(r.sources);
  // 前端那一層：doAsk 就是 machineLabelMap(srcs) 後逐列 srcCrumbRowHtml
  const labels = front.machineLabelMap(deduped);
  const html = deduped.map((s) => front.srcCrumbRowHtml(s, labels)).join('');
  // 檢索過程那棵樹吃的是 retrieval.pages_read，走同一組 machineLabelMap/srcCrumbs
  const pages = r.retrieval.pages_read;
  const treeLabels = front.machineLabelMap(pages);
  const treeMachines = pages.map((p) => front.srcCrumbs(p.source, p.library, p, treeLabels).machineLabel);
  return { r, deduped, html, treeMachines };
}

// ══ 本題唯一真正的驗收條件 ═════════════════════════════════════════════════
// 同一份檔在兩台、**內容一模一樣**（同步過去的副本）時，出處那一列要列得出兩台。
{
  const e2e = askEndToEnd('這份設計在講什麼', [
    entry('design', 'RFP/design.md', MBA),
    entry('design', 'RFP/design.md', IMAC),
  ]);

  t('端到端：出處 HTML 同時印得出兩台機器的名字',
    e2e.html.includes('教育部 Leo 的 Mac') && e2e.html.includes('教育部 Leo 的 iMac'),
    e2e.html);
  t('端到端：兩列出處（引擎的頁×機器去重沒有把第二台併掉）',
    (e2e.html.match(/class="crumbrow"/g) || []).length === 2,
    JSON.stringify(e2e.deduped));
  t('端到端：沒有任何一列變成「未知來源」',
    !e2e.html.includes('未知來源'), e2e.html);
  t('端到端：兩列都指得出同一個本機相對路徑（leo 拿它去自己的資料夾找原稿）',
    (e2e.html.match(/data-copypath="RFP\/design\.md"/g) || []).length === 2, e2e.html);
  t('端到端：檢索過程那棵樹也是兩台（樹與出處列不會各說各話）',
    e2e.treeMachines.length === 2 &&
    JSON.stringify(e2e.treeMachines.slice().sort()) === JSON.stringify(['教育部 Leo 的 Mac', '教育部 Leo 的 iMac'].sort()),
    JSON.stringify(e2e.treeMachines));

  // 第二條驗收條件：餵給 LLM 的內容仍然只有一份（出處變多 ≠ 內容變多）
  const body = entry('design', 'x').content.split('\n')[1];
  t('端到端：同一份內容只餵 LLM 一次（不重複、不浪費 token）',
    e2e.r.prompt.split(body).length - 1 === 1, '出現 ' + (e2e.r.prompt.split(body).length - 1) + ' 次');
}

// ══ 舊資料（沒有 machine 那一格）：行為與改版前一字不差 ═══════════════════
{
  const e2e = askEndToEnd('這份設計在講什麼', [
    entry('design', 'RFP/design.md'),
    entry('design', 'RFP/design.md'),
  ]);
  t('端到端（舊資料）：仍然只有一列出處',
    (e2e.html.match(/class="crumbrow"/g) || []).length === 1, e2e.html);
  t('端到端（舊資料）：那一列誠實顯示「未知來源」，不憑空長出機器名',
    e2e.html.includes('未知來源'), e2e.html);
  t('端到端（舊資料）：樹也只有一格、且沒有機器名',
    e2e.treeMachines.length === 1 && !e2e.treeMachines[0], JSON.stringify(e2e.treeMachines));
}

// ══ 內容各自不同的兩台（各自改過的副本）：本來就該兩列，不可以被這次改動弄壞 ══
{
  const e2e = askEndToEnd('這份設計在講什麼', [
    entry('design', 'RFP/design.md', { ...MBA, content: '# design\nMBA 上這份多寫了一段。' }),
    entry('design', 'RFP/design.md', { ...IMAC, content: '# design\niMac 上這份還是舊的。' }),
  ]);
  t('端到端（內容各異）：兩台仍然各一列',
    (e2e.html.match(/class="crumbrow"/g) || []).length === 2 &&
    e2e.html.includes('教育部 Leo 的 Mac') && e2e.html.includes('教育部 Leo 的 iMac'), e2e.html);
  t('端到端（內容各異）：兩份內容都進了 prompt（這種情況不該去重）',
    e2e.r.prompt.includes('MBA 上這份多寫了一段。') && e2e.r.prompt.includes('iMac 上這份還是舊的。'),
    e2e.r.prompt);
}

// ══ 混合：同一台自己有多個片段 + 另一台是同步過去的完整副本 ═══════════════
// 真實資料就是這個樣子（一頁被切成好幾塊）。出處要按機器收斂成兩列，不是按片段列一堆。
{
  const e2e = askEndToEnd('這份設計在講什麼', [
    entry('design', 'RFP/design.md', { ...MBA, content: '# design\n第一塊。' }),
    entry('design', 'RFP/design.md', { ...MBA, content: '# design\n第二塊。' }),
    entry('design', 'RFP/design.md', { ...IMAC, content: '# design\n第一塊。' }),
    entry('design', 'RFP/design.md', { ...IMAC, content: '# design\n第二塊。' }),
  ]);
  t('端到端（多片段同步副本）：出處收斂成兩台各一列',
    (e2e.html.match(/class="crumbrow"/g) || []).length === 2 &&
    e2e.html.includes('教育部 Leo 的 Mac') && e2e.html.includes('教育部 Leo 的 iMac'), e2e.html);
  t('端到端（多片段同步副本）：每塊內容仍只餵一次',
    e2e.r.prompt.split('第一塊。').length - 1 === 1 && e2e.r.prompt.split('第二塊。').length - 1 === 1,
    e2e.r.prompt);
}

// ══ 出貨那份帶的是不是這段程式碼 ══════════════════════════════════════════
// 🔴 上面所有格子驗的都是 `workflows/*.local.yaml`，但**安裝器裝進用戶實例的不是那個檔**，
//   是預編好的 `installer/*/workflows.json`（裡面嵌著 code 的本文）。
//   改了 yaml 沒有跑 `node installer/scripts/compile-workflows.mjs`
//   ⇒ 上面十幾格全綠、而使用者拿到的還是舊的那一版。
//   這正是本 repo 最常漏的那一步（ship-check：「重打 bundle（最常漏）」）
//   ⇒ 把它做成機械閘，不要靠誰記得。
{
  // 只正規化「結尾那一個換行」：YAML 的 `|` 是 clip，會保留一個結尾換行，
  // 而 codeOf 是逐行收集不補結尾 ⇒ 差的永遠是這一個字元。除此之外一字都不准差。
  const tail = (s) => String(s).replace(/\n$/, '');
  const yamlCode = tail(codeOf(chatYaml, 'assemble'));
  for (const rel of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
    const bundled = JSON.parse(fs.readFileSync(path.join(here, '..', '..', rel), 'utf8'))
      .find((w) => w.name === 'rag_chat');
    t(`出貨檢查：${rel} 帶的 assemble 與 yaml 逐字相同`,
      !!bundled && tail(bundled.config?.assemble?.code) === yamlCode,
      bundled ? '預編檔裡的版本是舊的 ⇒ 跑 node installer/scripts/compile-workflows.mjs' : '找不到 rag_chat');
    t(`出貨檢查：${rel} 的預編圖還在（重打時不可以把 graph 洗掉，t152）`,
      !!bundled && !!bundled.graph && Array.isArray(bundled.graph.nodes) && bundled.graph.nodes.length > 0,
      JSON.stringify(bundled && Object.keys(bundled)));
  }
}

console.log(`\n（下游兩層讀自：${ARCRUN} 的 ${ARCRUN_REF}）`);
console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
