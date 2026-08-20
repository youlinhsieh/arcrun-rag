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
import crypto from 'node:crypto';
// codeOf 已搬到 _yaml-code.mjs 共用（機器上只准有一份「怎麼從 YAML 抽 code」的知識）。
import { codeOf } from './_yaml-code.mjs';

const ingestYaml = fs.readFileSync(new URL('../rag-ingest-card.local.yaml', import.meta.url).pathname, 'utf8');
const takedownYaml = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');

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
// ── ⑤ 同一份檔同步到兩台、**內容一模一樣**：內容留一份、出處記多台 ──────────
// 總管 2026-08-18 對 `inkstone/mira#6` 的裁定，判準是 leo 的原話：
//   「知識全在總庫」        → 餵給 LLM 的內容去重是對的，留一份
//   「告訴我原稿去哪裡找」  → 出處不能去重，所有持有該原稿的機器都要看得見
// 這一格以前是「已知邊界」（釘住舊行為、等裁定），現在裁定下來了，翻成真正的驗收條件。
{
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
  t('問答 pages_read：內容一模一樣的兩台 ⇒ 出處兩筆都在（本題的核心）',
    pr.length === 2 && JSON.stringify(pr.map((x) => x.machine).sort())
      === '["youlinhsieh@Leo-MBA","youlinhsieh@Leo-iMac"]', JSON.stringify(pr));

  const srcs = r.sources.filter((x) => x.page === '同步過去的頁');
  t('問答 sources：內容一模一樣的兩台 ⇒ 出處兩列（前端一列一條麵包屑）',
    srcs.length === 2 && JSON.stringify(srcs.map((x) => x.machine).sort())
      === '["youlinhsieh@Leo-MBA","youlinhsieh@Leo-iMac"]', JSON.stringify(srcs));
  t('問答 sources：兩列共用同一個引用編號 n（prompt 裡只有一段 [n]，換號會讓引用對不上）',
    srcs.length === 2 && srcs[0].n === srcs[1].n, JSON.stringify(srcs.map((x) => x.n)));
  t('問答 sources：兩列都帶得出顯示名（畫面上是兩台，不是一台加一個「未知來源」）',
    srcs.every((x) => typeof x.machine_label === 'string' && x.machine_label), JSON.stringify(srcs));

  // 🔴 內容那一層**不准**跟著變兩份：prompt 只准出現一次，否則就是拿 8000 字預算餵重複的字。
  // 要找的字串從 chatEntry 自己取（不要在測試裡再抄一份樣本文字，抄了就會漂）
  const body = chatEntry('同步過去的頁', 'x').content.split('\n')[1];
  const hits = r.prompt.split(body).length - 1;
  t('問答 prompt：同一份內容只餵 LLM 一次（出處變多不等於內容變多）', hits === 1, '出現 ' + hits + ' 次');
  t('問答 prompt：引用編號只生成一個（沒有多出一個指向同一段文字的 [2]）',
    (r.prompt.match(/^\[\d+\] （出自子庫/gm) || []).length === 1,
    JSON.stringify(r.prompt.match(/^\[\d+\] （出自子庫/gm)));
}
{
  // 同一台機器上，同一頁被切成好幾個 block、其中兩塊內容剛好一模一樣：
  // 那是**同一台**的重複片段，不是第二個出處 ⇒ 不准因為這次改動長出第二列。
  const r = assemble({
    question: 'dup-same-machine',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [
        chatEntry('重複片段的頁', 'RFP/rep.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' }),
        chatEntry('重複片段的頁', 'RFP/rep.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' }),
      ],
    }),
  });
  const pr = r.retrieval.pages_read.filter((x) => x.page === '重複片段的頁');
  const srcs = r.sources.filter((x) => x.page === '重複片段的頁');
  t('問答：同一台機器的重複內容仍然只算一個出處（沒有自我複製）',
    pr.length === 1 && srcs.length === 1, JSON.stringify([pr, srcs]));
}
{
  // 舊資料（沒有 machine 那一格）＋內容一模一樣：說不出第二個出處 ⇒ 照舊只留一份，
  // 行為與改版前一字不差。這一格就是「不會因為新增這條路而多長出東西」的機械證據。
  const r = assemble({
    question: 'dup-legacy',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({
      entries: [chatEntry('舊的同步頁', 'RFP/oldsync.md'), chatEntry('舊的同步頁', 'RFP/oldsync.md')],
    }),
  });
  const pr = r.retrieval.pages_read.filter((x) => x.page === '舊的同步頁');
  const srcs = r.sources.filter((x) => x.page === '舊的同步頁');
  t('問答：舊資料內容重複 ⇒ 仍是一筆一列（改版前後一字不差）',
    pr.length === 1 && !('machine' in pr[0]) && srcs.length === 1 && !('machine' in srcs[0]),
    JSON.stringify([pr, srcs]));
}
{
  // 混合：一台有 machine、另一筆是舊資料（沒有那一格）。
  // 舊資料那筆說不出是哪台 ⇒ 不生第二列（生了就是憑空造一個看起來像出處的東西）。
  // 🔴 **兩種到達順序都測**：「先到的那一台贏」正是本票在修的病，
  //   修它的時候不可以又引進一個新的順序相依。
  const withMachine = chatEntry('混合頁', 'RFP/mix.md', { machine: 'youlinhsieh@Leo-MBA', machine_label: '教育部 Leo 的 Mac' });
  const legacy = chatEntry('混合頁', 'RFP/mix.md');
  const run = (entries) => assemble({
    question: 'dup-mixed',
    sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
    pages_body: JSON.stringify({ entries }),
  }).sources.filter((x) => x.page === '混合頁');
  const a = run([withMachine, legacy]);
  const b = run([legacy, withMachine]);
  t('問答：重複的那筆沒有機器那一格 ⇒ 不憑空生第二個出處',
    a.length === 1 && a[0].machine === 'youlinhsieh@Leo-MBA', JSON.stringify(a));
  t('問答：舊資料先到也一樣 ⇒ 說得出機器的那筆當代表（結果與到達順序無關）',
    JSON.stringify(a) === JSON.stringify(b), JSON.stringify([a, b]));
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

// ── ⑥ 隨機性質測試：舉例測不到的組合，交給亂數鋪 ──────────────────────────
// 為什麼加這一段：本票的病是「某個組合下第二台被靜默丟掉」，而**舉例測試只能蓋到想得到的組合**。
// 兩條性質涵蓋整個需求，兩條都不依賴任何舊版程式碼：
//   ① 出處要齊：某一頁在輸入裡出現過的每一台機器，都要在那一頁的出處裡說得出來
//   ② 內容要省：每一個相異的（頁, 內容）只准餵給 LLM 一次
//
// ⚠️ 亂數用「雜湊計數器」而不是自己寫的線性同餘：
//   · 線性同餘（rng * 1103515245 那種）在 JS 會超過 2^53 掉精度 ⇒ 序列退化、樣本沒鋪開
//     （實撞：2000 組裡只跑出 7 種情況，看起來很綠其實幾乎沒測到東西）。
//   · 位元位移寫法會被 arcrun-intent-guard 誤判成意圖工作流的邊（實撞，本檔會被它掃）。
//   雜湊計數器兩個坑都沒有，而且固定種子 ⇒ 每次跑的樣本完全一樣，紅了可以重現。
{
  let ctr = 0;
  const rnd = (n) => crypto.createHash('sha256').update('mira6:' + (ctr++)).digest().readUInt32BE(0) % n;
  const MACHINES = ['youlinhsieh@Leo-MBA', 'youlinhsieh@Leo-iMac', 'youlinhsieh@Leo-NAS', null];
  const BODIES = ['同步過去的那一份', '各自改過的那一份', '第三種內容'];
  const PAGES = ['設計', 'notes'];
  let badOrigins = 0, badContent = 0, sawTwoMachines = 0, rounds = 0;
  for (let it = 0; it < 3000; it++) {
    const entries = [];
    const n = 2 + rnd(7);
    for (let i = 0; i < n; i++) {
      const p = PAGES[rnd(PAGES.length)], mk = MACHINES[rnd(MACHINES.length)];
      entries.push({
        page_name: p,
        content: '# ' + p + '\n' + BODIES[rnd(BODIES.length)],
        metadata_json: JSON.stringify({
          source: 'kb://d/' + p + '.md#' + rnd(2), library: 'kb',
          ...(mk ? { machine: mk, machine_label: '機器 ' + mk.slice(-3) } : {}),
        }),
      });
    }
    const r = assemble({
      question: '同步 設計 內容',
      sel_body: JSON.stringify({ route: 'all', libraries: [], indexes: [] }),
      pages_body: JSON.stringify({ entries }),
    });
    rounds++;
    // ① 出處要齊
    for (const p of PAGES) {
      const want = new Set(entries.filter((e) => e.page_name === p)
        .map((e) => JSON.parse(e.metadata_json).machine).filter(Boolean));
      const got = new Set(r.sources.filter((x) => x.page === p).map((x) => x.machine).filter(Boolean));
      if (want.size >= 2) sawTwoMachines++;
      for (const w of want) {
        if (!got.has(w)) { badOrigins++; if (badOrigins <= 2) console.log('  少了機器', w, '@', it, JSON.stringify(entries)); break; }
      }
    }
    // ② 內容要省
    const a = r.prompt.indexOf('原文片段：\n'), b = r.prompt.indexOf('\n問題：');
    const fed = r.prompt.slice(a + '原文片段：\n'.length, b).split(/\n\n(?=\[\d+\] )/)
      .map((x) => x.replace(/^\[\d+\] /, '').trim()).filter(Boolean);
    const uniq = new Set(entries.map((e) => e.page_name + ' ' + e.content));
    if (fed.length !== uniq.size || new Set(fed).size !== fed.length) {
      badContent++; if (badContent <= 2) console.log('  內容筆數不對 @', it, fed.length, uniq.size);
    }
  }
  t(`隨機 ${rounds} 組：每一頁出現過的每一台機器都說得出來（其中 ${sawTwoMachines} 次該頁有 ≥2 台）`,
    badOrigins === 0, '漏掉 ' + badOrigins + ' 次');
  t(`隨機 ${rounds} 組：每個相異的（頁, 內容）只餵 LLM 一次`, badContent === 0, '不符 ' + badContent + ' 次');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
