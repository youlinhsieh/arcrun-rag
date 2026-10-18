// sliced-triplets.test.mjs — inkstone/arcrun-rag#255：一次呼叫的雲端工作量要有上限。
// 跑的是 YAML 裡真的那幾段 code（prep／parse_card／pick_stale／prep_cluster_wiki／prep_entity_concept）。
//
// 這支鎖住四件量出來的事：
//  ① 不帶新輸入＝與從前逐字相同（舊版小幫手、舊資料完全不受影響）
//  ② 同一份文件的不同張卡（文件卡／概念卡）三元組各管各的，彼此刪不到
//  ③ 一張很多關係的卡切成幾段送：每條關係恰好落在一段裡、段與段加起來＝不分段的結果
//  ④ 後面的段不碰 block；「這份有沒有整個提交過」只看第一段留在 block 上的指紋
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const yaml = fs.readFileSync(new URL('../rag-ingest-card.local.yaml', import.meta.url).pathname, 'utf8');
const prep = new Function('input', codeOf(yaml, 'prep'));
const parseCard = new Function('input', codeOf(yaml, 'parse_card'));
const pickStale = new Function('input', codeOf(yaml, 'pick_stale'));
const prepCluster = new Function('input', codeOf(yaml, 'prep_cluster_wiki'));
const prepEntity = new Function('input', codeOf(yaml, 'prep_entity_concept'));
const tdYaml = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');
const tdPrep = new Function('input', codeOf(tdYaml, 'prep'));

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};
const d = (r) => (r && r.data !== undefined && r.success !== undefined && r.data && typeof r.data === 'object' ? r.data : r);

const SEP = ' ' + '>'.repeat(2) + ' ';
const bigCard = (n, body = '摘要') => `# 大卡\n## 摘要\n${body}\n## 關聯\n${Array.from({ length: n }, (_, i) => `- S${i}${SEP}依賴${SEP}O${i}`).join('\n')}\n`;
const base = (md, extra = {}) => ({ page_name: '大卡', path: 'x/大卡.pdf', library: 'kb', machine: 'm1', machine_label: 'Mac', card_content: md, ...extra });

function run(p) {
  const pr = d(prep(p));
  const pc = d(parseCard({ card: p.card_content, page_name: p.page_name, path: p.path, library: p.library,
    machine: p.machine, machine_label: p.machine_label, card_hash: pr.card_hash,
    trip_src_uri: pr.trip_src_uri, rel_offset: pr.rel_offset, rel_limit: pr.rel_limit }));
  return { pr, pc };
}

// ① 向下相容
{
  const p = base(bigCard(7));
  const { pr, pc } = run(p);
  t('不帶新輸入：三元組的 source_uri 還是 kb://<路徑>', pr.trip_src_uri === 'kb://x/大卡.pdf' && pc.rels.every((r) => r.source_uri === 'kb://x/大卡.pdf'));
  t('不帶新輸入：整張卡的關係都在（7 條＋part_of）、block 照寫', pc.rel_count === 8 && pc.block_count > 0, JSON.stringify({ rc: pc.rel_count, bc: pc.block_count }));
  t('不帶新輸入：要寫 block、slice_len＝總條數', pr.do_blocks === true && pr.slice_len === 8 && pr.rel_total === 8);
  // 引擎對沒傳的選填輸入會把字面 {{input.x}} 原樣塞進來
  const lit = run(base(bigCard(3), { rel_offset: '{{input.rel_offset}}', rel_limit: '{{input.rel_limit}}', triplet_scope: '{{input.triplet_scope}}' }));
  t('選填輸入沒被代入（字面樣板）：當作沒傳', lit.pr.rel_offset === 0 && lit.pr.rel_limit === 0 && lit.pr.trip_scope === '' && lit.pc.rel_count === 4);
}

// ② 同一份文件的不同張卡各管各的
{
  const hub = run(base(bigCard(3)));
  const concept = run({ ...base(bigCard(3)), page_name: 'KDDI', triplet_scope: 'c.KDDI' });
  t('概念卡的三元組有自己的 source_uri（多一個 #t= 尾巴）', concept.pr.trip_src_uri === 'kb://x/大卡.pdf#t=c.KDDI' && concept.pc.rels.every((r) => r.source_uri === concept.pr.trip_src_uri));
  t('文件卡與概念卡撈「舊的」用的是不同的鍵（刪不到對方）', hub.pr.trip_src_uri_enc !== concept.pr.trip_src_uri_enc);
  t('尾巴進網址前有編碼（# 不會被當成網址的片段）', concept.pr.trip_src_uri_enc.includes('%23t%3Dc.KDDI') || concept.pr.trip_src_uri_enc.includes('%23t=') , concept.pr.trip_src_uri_enc);
  t('block 的來源不受影響（仍是 kb://<路徑>#<第幾段>）', concept.pc.blocks.every((b) => /^kb:\/\/x\/大卡\.pdf#\d+$/.test(b.source)));
}

// ③ 切段
{
  const md = bigCard(250);
  const whole = run(base(md)).pc.rels.map((r) => r.subject + '|' + r.object);
  const calls = [{ rel_offset: 200, rel_limit: 0, triplet_scope: 's2' }, { rel_offset: 100, rel_limit: 100, triplet_scope: 's1' }, { rel_offset: 0, rel_limit: 100 }];
  const got = [];
  let blocksSeen = 0;
  for (const c of calls) {
    const { pr, pc } = run(base(md, c));
    t(`段 offset=${c.rel_offset}：prep 算的條數＝parse_card 實際給的條數`, pr.slice_len === pc.rel_count, JSON.stringify({ a: pr.slice_len, b: pc.rel_count }));
    t(`段 offset=${c.rel_offset}：只有 offset=0 這一段寫 block`, (c.rel_offset === 0) === (pc.block_count > 0));
    if (pc.block_count > 0) blocksSeen++;
    got.push(...pc.rels.map((r) => r.subject + '|' + r.object));
  }
  t('三段加起來＝不分段的全部關係（每條恰好一次，含 part_of）', got.length === whole.length && new Set(got).size === got.length && [...got].sort().join() === [...whole].sort().join(), `${got.length} vs ${whole.length}`);
  t('整份只有一段寫 block', blocksSeen === 1);
  const last = run(base(md, calls[0])).pr;
  t('最後一段 limit＝0 ＝寫到最後（就算收的人數的條數比雲端多／少也不漏）', last.rel_limit === 0 && last.slice_len === 51);
  const s1 = run(base(md, calls[1]));
  t('各段的 source_uri 各自獨立', s1.pc.rels.every((r) => r.source_uri === 'kb://x/大卡.pdf#t=s1'));
}

// ④ 後面的段不碰 block；提交標記
{
  const md = bigCard(250);
  const first = run(base(md, { rel_offset: 0, rel_limit: 100 }));
  const second = run(base(md, { rel_offset: 100, rel_limit: 100, triplet_scope: 's1' }));
  const hashNew = second.pr.card_hash;
  const blockMeta = (hash) => first.pc.blocks.map((b, i) => ({ id: 'e' + i, metadata_json: JSON.stringify({ source: b.source, source_path: b.source_path, library: 'kb', machine: 'm1', card_hash: hash, card_blocks: b.card_blocks, card_rels: b.card_rels }) }));
  const stale = (cloudBlocks, recs, pr = second.pr) => d(pickStale({ blocks_body: JSON.stringify({ entries: cloudBlocks }), triplets_body: JSON.stringify({ record_ids: recs }),
    path: 'x/大卡.pdf', machine: 'm1', card_hash: pr.card_hash, do_blocks: String(pr.do_blocks), slice_len: String(pr.slice_len) }));
  const recs100 = Array.from({ length: 100 }, (_, i) => 'r' + i);

  let r = stale(blockMeta('舊指紋'), recs100);
  t('後面的段：block 上還是舊指紋（第一段還沒提交）⇒ 判有變、重寫', r.result === false && r.dead_record.length === 100);
  t('後面的段：不論如何都不刪 block', r.dead_entry.length === 0);
  r = stale([], recs100);
  t('後面的段：雲端還沒有這張卡的 block（第一次送）⇒ 判有變', r.result === false);
  r = stale(blockMeta(hashNew), recs100);
  t('後面的段：block 已帶這次的指紋、這段條數也剛好 ⇒ 沒變、什麼都不動', r.result === true && r.dead_record.length === 0 && r.dead_entry.length === 0);
  r = stale(blockMeta(hashNew), recs100.slice(1));
  t('後面的段：指紋對但這段少一條（半寫入）⇒ 判有變', r.result === false);
  r = stale(blockMeta(hashNew), []);
  t('後面的段：這段名下一條都沒有 ⇒ 判有變（要寫）', r.result === false);

  // 第一段（offset 0）仍走原判準，且 card_rels 是它自己名下的條數
  const m0 = JSON.parse(blockMeta(first.pr.card_hash)[0].metadata_json);
  t('第一段 block 記的 card_rels＝它名下的條數（100）', Number(m0.card_rels) === 100, String(m0.card_rels));
  const u = stale(blockMeta(first.pr.card_hash), recs100, first.pr);
  t('第一段：指紋、段數、條數都對 ⇒ 沒變', u.result === true);
  const u2 = stale(blockMeta(first.pr.card_hash), recs100.concat(['legacy1', 'legacy2']), first.pr);
  t('第一段：名下多出別人的舊三元組（改版前概念卡寫的）⇒ 判有變，順手清掉', u2.result === false && u2.dead_record.length === 102);
}

// 分群／概念歸屬只在第一段做
{
  const run1 = (fn, extra) => { try { return { ok: true, v: fn(extra) }; } catch (e) { return { ok: false, e: String(e.message || e) }; } };
  const c1 = run1(prepCluster, { page_name: '大卡', blocks: [{ content: '# 大卡' }], library: 'kb', do_blocks: 'false' });
  const c2 = run1(prepCluster, { page_name: '大卡', blocks: [{ content: '# 大卡' }], library: 'kb', do_blocks: 'true' });
  t('後面的段：不觸發分群（丟例外＝走吸收分支）', c1.ok === false && /第一段/.test(c1.e));
  t('第一段：照常觸發分群', c2.ok === true);
  const e1 = run1(prepEntity, { card: bigCard(3), page_name: '大卡', library: 'kb', do_blocks: 'false' });
  const e2 = run1(prepEntity, { card: bigCard(3), page_name: '大卡', library: 'kb', do_blocks: 'true' });
  t('後面的段：不觸發概念歸屬', e1.ok === false && /第一段/.test(e1.e));
  t('第一段：照常觸發概念歸屬', e2.ok === true);
}

// 下架：帶 triplet_scope 就只下架那一批；不帶＝與從前一樣
{
  const a = d(tdPrep({ machine: 'youlinhsieh@Leo-MBA', page_name: '概念甲', path: 'x/大卡.pdf' }));
  t('下架不帶 triplet_scope：撈的還是 kb://路徑（文件卡本人／改版前共用的那批）', a.trip_src_uri === 'kb://x/大卡.pdf' && a.src_uri_enc === a.trip_src_uri_enc);
  const b = d(tdPrep({ machine: 'youlinhsieh@Leo-MBA', page_name: '概念甲', path: 'x/大卡.pdf', triplet_scope: 'c.概念甲' }));
  t('下架帶 triplet_scope：撈那一批的 source_uri（與收卡寫進去的一模一樣）', b.trip_src_uri === 'kb://x/大卡.pdf#t=c.概念甲');
  const ingest = run({ ...base(bigCard(3)), page_name: '概念甲', triplet_scope: 'c.概念甲' }).pr;
  t('收卡寫的 source_uri＝下架要找的 source_uri（兩邊對得上才刪得到）', ingest.trip_src_uri === b.trip_src_uri && ingest.trip_src_uri_enc === b.trip_src_uri_enc);
  const c = d(tdPrep({ machine: 'youlinhsieh@Leo-MBA', page_name: '概念甲', path: 'x/大卡.pdf', triplet_scope: '{{input.triplet_scope}}' }));
  t('下架的 triplet_scope 沒被代入（字面樣板）：當作沒傳', c.trip_src_uri === 'kb://x/大卡.pdf');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
