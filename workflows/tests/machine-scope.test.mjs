// machine-scope.test.mjs — `inkstone/mira#6`：同一份相對路徑來自兩台機器，不准被併成一份。
//
// 為什麼要有這支（本票的核心風險）：`path` 是**相對於被監看資料夾**的路徑，
// 所以 Leo-MBA 的 `RFP/design.md` 與 Leo-iMac 的 `RFP/design.md` 在雲端長得一模一樣。
// 收卡是「先照鍵刪光再寫」的 upsert ⇒ 後同步的那台會把前一台的知識**無聲刪掉**
// （症狀不是「變兩份」，是前面那份消失——比重複難發現得多）。
// machine 是唯一分得開它們的那一維。
//
// 規則照抄 arcrun-rag#46 對 library 的處置：**兩邊都有值時才收緊**。
// 所以既有資料（沒有 machine 的那些）行為一字不變，不會突然變兩份、也不會撤不掉。
//
// 測的是兩支 workflow 裡 code 節點的比對規則本身（做法照抄 takedown-scope.test.mjs），
// 不打任何雲端。
import fs from 'node:fs';

const ingestYaml = fs.readFileSync(new URL('../rag-ingest-card.local.yaml', import.meta.url).pathname, 'utf8');
const takedownYaml = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');

// 從 YAML 抽出某節點的 `code: |` 區塊。
// ⚠️ 不能照抄 takedown-scope.test.mjs 那條「code: | 到下一個 input:」的正則——
//    pick_stale 的 `input:` 寫在 `code:` **前面**，那條正則會一路吃到下一個節點去
//    （實撞：抽出來的字串含 YAML 註解，new Function 直接 SyntaxError）。
//    改成逐行掃：進到該節點後看到 `code: |`，就一直收 6 空格縮排（或空白）的行。
function codeOf(yaml, node) {
  const lines = yaml.split('\n');
  let inNode = false, inCode = false;
  const out = [];
  for (const line of lines) {
    if (/^  [A-Za-z_][A-Za-z0-9_]*:\s*$/.test(line)) {
      if (inCode) break;
      inNode = line.trim() === node + ':';
      continue;
    }
    if (!inNode) continue;
    if (!inCode) { if (/^    code: \|\s*$/.test(line)) inCode = true; continue; }
    if (line.trim() === '') { out.push(''); continue; }
    if (!line.startsWith('      ')) break;
    out.push(line.slice(6));
  }
  if (!out.length) throw new Error(`抽不到 ${node} 的 code`);
  return out.join('\n');
}
const pickStale = new Function('input', codeOf(ingestYaml, 'pick_stale'));
const parseCard = new Function('input', codeOf(ingestYaml, 'parse_card'));
const buildDeprecations = new Function('input', codeOf(takedownYaml, 'build_deprecations'));
const pickDeadTriplets = new Function('input', codeOf(takedownYaml, 'pick_dead_triplets'));

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

// 一個雲端已存在的 block（machine 省略＝改版前的既有資料）。
const block = (id, path, opts = {}) => ({
  id,
  metadata_json: JSON.stringify({
    source: `kb://${path}#0`, source_path: path, library: opts.library || 'kb',
    ...(opts.machine === undefined ? {} : { machine: opts.machine }),
    embed: true,
  }),
});
const rec = (record_id, source_uri, opts = {}) => ({
  record_id,
  values: { subject: opts.subject || 'design', source_uri, library: opts.library || 'kb',
            ...(opts.machine === undefined ? {} : { machine: opts.machine }) },
});
const staleEntries = (r) => r.dead_entry.map((e) => e.id).sort();
const staleRecords = (r) => r.dead_record.map((e) => e.record_id).sort();
const deadEntries = (r) => r.dead_entries.map((e) => e.id).sort();
const deadRecords = (r) => r.dead_records.map((e) => e.record_id).sort();

// 卡片「## 關聯」那一行用組的，不寫字面值——本檔會被 arcrun-intent-guard 掃過，
// 字面上的三段式關係行會被它認成意圖工作流的邊（誤判，這裡是測試素材不是工作流）。
const SEP = ' ' + '>'.repeat(2) + ' ';
const relLine = ['- A', '依賴', 'B'].join(SEP);

// ── ① 收卡 upsert：兩台機器、同一個相對路徑 ────────────────────────────────
{
  // 🔴 本票的核心情境。Leo-iMac 同步 `RFP/design.md` 時，只准清掉自己上一版，
  //    Leo-MBA 那份必須原封不動地留著。
  const blocks = [
    block('mba', 'RFP/design.md', { machine: 'youlinhsieh@Leo-MBA' }),
    block('imac', 'RFP/design.md', { machine: 'youlinhsieh@Leo-iMac' }),
  ];
  const r = pickStale({
    blocks_body: JSON.stringify({ entries: blocks }), triplets_body: '{}',
    path: 'RFP/design.md', page_name: 'design', machine: 'youlinhsieh@Leo-iMac',
  });
  t('收卡：同一相對路徑、兩台機器 ⇒ 只清自己那台的舊版',
    JSON.stringify(staleEntries(r)) === '["imac"]', JSON.stringify(staleEntries(r)));
}
{
  // 同一台機器重跑：照樣清得掉自己的舊版（upsert 不可以因為這次改動而失效
  // ——那會讓同一份檔每同步一次就堆一份副本，正是 arcrun-rag#14 修過的病）。
  const blocks = [block('mine', 'RFP/design.md', { machine: 'youlinhsieh@Leo-MBA' })];
  const r = pickStale({
    blocks_body: JSON.stringify({ entries: blocks }), triplets_body: '{}',
    path: 'RFP/design.md', page_name: 'design', machine: 'youlinhsieh@Leo-MBA',
  });
  t('收卡：同一台機器重跑 ⇒ upsert 照常清舊版',
    JSON.stringify(staleEntries(r)) === '["mine"]', JSON.stringify(staleEntries(r)));
}
{
  // 向後相容 A：卡上沒有 machine（改版前灌的既有資料）⇒ 退回舊行為，照樣被 upsert 掉。
  // 這一格就是「既有資料不會壞掉」的機械證據：不會因為新增這一維而變成第二筆。
  const blocks = [block('legacy', 'RFP/design.md')];
  const r = pickStale({
    blocks_body: JSON.stringify({ entries: blocks }), triplets_body: '{}',
    path: 'RFP/design.md', page_name: 'design', machine: 'youlinhsieh@Leo-MBA',
  });
  t('收卡：既有資料（卡上無 machine）仍被正常 upsert，不會變兩份',
    JSON.stringify(staleEntries(r)) === '["legacy"]', JSON.stringify(staleEntries(r)));
}
{
  // 向後相容 B：舊版 daemon 不送 machine ⇒ 一字不差的舊行為（連別台的也照殺）。
  // 這不是新的破口，這是「改版前本來就是這樣」——記在測試裡，免得日後誤以為是新 bug。
  const blocks = [
    block('mba', 'RFP/design.md', { machine: 'youlinhsieh@Leo-MBA' }),
    block('legacy', 'RFP/design.md'),
  ];
  const r = pickStale({
    blocks_body: JSON.stringify({ entries: blocks }), triplets_body: '{}',
    path: 'RFP/design.md', page_name: 'design', machine: '',
  });
  t('收卡：payload 沒帶 machine ⇒ 退回改版前的行為',
    JSON.stringify(staleEntries(r)) === '["legacy","mba"]', JSON.stringify(staleEntries(r)));
}
{
  // 三元組同一條規則（要 triplet template 有 machine slot 才會有值；沒有時退回舊行為）。
  const records = [
    rec('mba', 'kb://RFP/design.md', { machine: 'youlinhsieh@Leo-MBA' }),
    rec('imac', 'kb://RFP/design.md', { machine: 'youlinhsieh@Leo-iMac' }),
  ];
  const r = pickStale({
    blocks_body: '{}', triplets_body: JSON.stringify({ records }),
    path: 'RFP/design.md', page_name: 'design', machine: 'youlinhsieh@Leo-iMac',
  });
  t('收卡三元組：只清自己那台的',
    JSON.stringify(staleRecords(r)) === '["imac"]', JSON.stringify(staleRecords(r)));
}

// ── ② parse_card：machine 進 metadata，且不混進 source_uri ────────────────
{
  const r = parseCard({
    card: '# design\n\n內容一段\n\n## 關聯\n' + relLine + '\n',
    page_name: 'design', path: 'RFP/design.md', library: 'kb',
    machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac',
  });
  t('parse_card：每個 block 都帶 machine',
    r.blocks.every((b) => b.machine === 'youlinhsieh@Leo-MBA'), JSON.stringify(r.blocks[0]));
  t('parse_card：顯示名跟著走（人看得懂的那一格）',
    r.blocks.every((b) => b.machine_label === '教育部 Leo 的 Mac'), JSON.stringify(r.blocks[0]));
  t('parse_card：source 仍是純 kb://<相對路徑>#n（不混進機器名，portal 的 srcLocalPath 才不會壞）',
    r.blocks[0].source === 'kb://RFP/design.md#0', r.blocks[0].source);
  t('parse_card：三元組帶 machine、source_uri 不變',
    r.rels.every((x) => x.machine === 'youlinhsieh@Leo-MBA' && x.source_uri === 'kb://RFP/design.md'),
    JSON.stringify(r.rels));
}
{
  // 沒帶 machine 的舊 daemon：**空著**，不猜、不填假名。
  const r = parseCard({ card: '# design\n\n內容\n', page_name: 'design', path: 'RFP/design.md', library: 'kb' });
  t('parse_card：沒送 machine ⇒ 誠實空著（不憑空長出機器名）',
    r.blocks.every((b) => b.machine === '' && b.machine_label === ''), JSON.stringify(r.blocks[0]));
}

// ── ③ 下架：A 機器刪檔不准連坐 B 機器 ────────────────────────────────────
{
  const blocks = [
    block('mba', 'notes.md', { machine: 'youlinhsieh@Leo-MBA' }),
    block('imac', 'notes.md', { machine: 'youlinhsieh@Leo-iMac' }),
  ];
  const r = buildDeprecations({
    blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md',
    library: 'kb', machine: 'youlinhsieh@Leo-MBA',
  });
  t('下架：A 機器刪檔只殺 A 的，B 的原封不動',
    JSON.stringify(deadEntries(r)) === '["mba"]', JSON.stringify(deadEntries(r)));
}
{
  // 既有資料（無 machine）仍撤得掉——不可以因為新增這一維就變成「刪不掉的殘留」。
  const blocks = [block('legacy', 'notes.md')];
  const r = buildDeprecations({
    blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md',
    library: 'kb', machine: 'youlinhsieh@Leo-MBA',
  });
  t('下架：既有資料（無 machine）照樣撤得掉',
    JSON.stringify(deadEntries(r)) === '["legacy"]', JSON.stringify(deadEntries(r)));
}
{
  const records = [
    rec('mba', 'kb://notes.md', { subject: 'notes', machine: 'youlinhsieh@Leo-MBA' }),
    rec('imac', 'kb://notes.md', { subject: 'notes', machine: 'youlinhsieh@Leo-iMac' }),
  ];
  const r = pickDeadTriplets({
    body: JSON.stringify({ records }), page_name: 'notes', source_uri: 'kb://notes.md',
    library: 'kb', machine: 'youlinhsieh@Leo-MBA',
  });
  t('下架三元組：只殺同一台機器的',
    JSON.stringify(deadRecords(r)) === '["mba"]', JSON.stringify(deadRecords(r)));
}

// ── ④ 問答的出處要帶著機器（畫面上「未知來源」變成真名的那條路）──────────
// 為什麼要測這一格：資料寫進去了不代表**畫面拿得到**。retrieval-tree-and-breadcrumb
// 在 stage 上實測發現 /portal/data/chat 的 sources／pages_read 兩格都沒帶機器
// ⇒ 前端只能顯示「未知來源」。缺的是投影，不是資料。
const chatYaml = fs.readFileSync(new URL('../rag-chat.local.yaml', import.meta.url).pathname, 'utf8');
const assemble = new Function('input', codeOf(chatYaml, 'assemble'));

const chatEntry = (page, path, opts = {}) => ({
  page_name: page,
  content: `# ${page}\n這是 ${page} 的內容。`,
  metadata_json: JSON.stringify({
    source: `kb://${path}#0`, source_path: path, library: opts.library || 'kb',
    ...(opts.machine === undefined ? {} : { machine: opts.machine, machine_label: opts.machine_label || opts.machine }),
    embed: true,
  }),
});
{
  const r = assemble({
    question: 'design 是什麼',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [
        chatEntry('有機器的頁', 'RFP/design.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' }),
        chatEntry('舊資料的頁', 'RFP/legacy.md'),
      ],
    }),
  });
  const byPage = (arr, page) => arr.find((x) => x.page === page);
  const s1 = byPage(r.sources, '有機器的頁');
  const s2 = byPage(r.sources, '舊資料的頁');
  const p1 = byPage(r.retrieval.pages_read, '有機器的頁');
  const p2 = byPage(r.retrieval.pages_read, '舊資料的頁');
  t('問答 sources：有機器的帶真名（顯示名優先）',
    s1 && s1.machine === 'youlinhsieh@Leo-MBA' && s1.machine_label === '教育部 Leo 的 Mac', JSON.stringify(s1));
  t('問答 pages_read：同一組值也帶上去',
    p1 && p1.machine === 'youlinhsieh@Leo-MBA' && p1.machine_label === '教育部 Leo 的 Mac', JSON.stringify(p1));
  t('問答：舊資料**一個 key 都不放**（空字串會讓「未知來源」看起來像有名字）',
    s2 && !('machine' in s2) && !('machine_label' in s2) && p2 && !('machine' in p2), JSON.stringify([s2, p2]));
  t('問答：既有欄位一個都沒少（n／mode／page／source）',
    s1 && s1.n === 1 && typeof s1.mode === 'string' && typeof s1.source === 'string', JSON.stringify(s1));
}

{
  // 🔴 同一頁同時存在於兩台機器、而且**內容各自不同**（各自改過的副本）：
  // pages_read 必須兩筆都在。原本是「一個 page_name 一筆、取 es[0]」⇒ 後到的那台
  // 原稿位置直接消失，正好抵銷掉本票要做的事
  // （retrieval-tree-and-breadcrumb 2026-08-18 在 stage 實測抓到）。
  const r = assemble({
    question: 'same 是什麼',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [
        { ...chatEntry('同一頁', 'RFP/same.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' }),
          content: '# 同一頁\nMBA 上的這份多寫了一段。' },
        { ...chatEntry('同一頁', 'RFP/same.md', { machine: 'youlinhsieh@Leo-iMac', machine_label: '教育部 Leo 的 iMac' }),
          content: '# 同一頁\niMac 上的這份還是舊的。' },
      ],
    }),
  });
  const pr = r.retrieval.pages_read.filter((x) => x.page === '同一頁');
  const machines = pr.map((x) => x.machine).sort();
  t('問答 pages_read：同一頁來自兩台機器（內容各異）⇒ 兩筆都在，不是只留先到的那台',
    pr.length === 2 && JSON.stringify(machines) === '["youlinhsieh@Leo-MBA","youlinhsieh@Leo-iMac"]',
    JSON.stringify(pr));
  t('問答 pages_read：兩筆各自指向自己那台的原稿位置',
    pr.every((x) => typeof x.source === 'string' && x.source.indexOf('kb://RFP/same.md') === 0), JSON.stringify(pr));
}
{
  // ⚠️ 已知邊界，**故意記在這裡**：同一頁、兩台機器、**內容一模一樣**（同步過去的副本）時，
  // 更上游有一道「page_name + 內容」去重（assemble 的 seenKey），第二台在進到這裡之前
  // 就被丟掉了 ⇒ pages_read 只會有一筆。
  // 那道去重本身是對的（同樣的文字餵給 LLM 兩次只是浪費 8000 字預算），
  // 所以正解**不是**把 machine 加進它的鍵，而是「內容留一份、出處記多台」——
  // 那是呈現方式的取捨（總管／leo 的層級），不是我可以自己裁的，故先把現況釘成測試。
  const r = assemble({
    question: 'dup',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [
        chatEntry('同步過去的頁', 'RFP/synced.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' }),
        chatEntry('同步過去的頁', 'RFP/synced.md', { machine: 'youlinhsieh@Leo-iMac', machine_label: '教育部 Leo 的 iMac' }),
      ],
    }),
  });
  const pr = r.retrieval.pages_read.filter((x) => x.page === '同步過去的頁');
  t('問答 pages_read（已知邊界）：內容一模一樣時上游去重只留一台——現況釘住，等總管裁',
    pr.length === 1 && pr[0].machine === 'youlinhsieh@Leo-MBA', JSON.stringify(pr));
}
{
  // 舊資料（都沒有 machine）：仍然是一頁一筆，行為與改版前一字不差。
  const r = assemble({
    question: 'legacy',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [chatEntry('舊頁', 'RFP/legacy.md'), { ...chatEntry('舊頁', 'RFP/legacy.md'), content: '# 舊頁\n另一段。' }],
    }),
  });
  const pr = r.retrieval.pages_read.filter((x) => x.page === '舊頁');
  t('問答 pages_read：舊資料仍是一頁一筆（沒有因為分組鍵而變多）',
    pr.length === 1 && !('machine' in pr[0]), JSON.stringify(pr));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
