// skip-unchanged.test.mjs — inkstone/arcrun-rag#241：沒改過的卡不再被重寫。
// 跑的是 YAML 裡真的那幾段 code（prep／parse_card／pick_stale），不抄一份。
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const yaml = fs.readFileSync(new URL('../rag-ingest-card.local.yaml', import.meta.url).pathname, 'utf8');
const prep = new Function('input', codeOf(yaml, 'prep'));
const parseCard = new Function('input', codeOf(yaml, 'parse_card'));
const pickStale = new Function('input', codeOf(yaml, 'pick_stale'));

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

const SEP = ' ' + '>'.repeat(2) + ' ';
const card = (body = '摘要內容') => `# 頁\n## 摘要\n${body}\n## 關聯\n- ${['A', '依賴', 'B'].join(SEP)}\n`;
const payload = (md, extra = {}) => ({ page_name: '頁', path: 'x/頁.md', library: 'kb', machine: 'm1', machine_label: 'Mac', card_content: md, ...extra });

// 模擬「把一張卡寫進雲端」：回雲端現況（block 清單＋三元組 id 清單）
function cloudAfterWrite(p) {
  const pr = prep(p).data ?? prep(p);
  const pc = parseCard({ card: p.card_content, page_name: p.page_name, path: p.path, library: p.library,
    machine: p.machine, machine_label: p.machine_label, card_hash: pr.card_hash });
  const r = pc.data ?? pc;
  const entries = r.blocks.map((b, i) => ({ id: 'e' + i + '_' + Math.random(), metadata_json: JSON.stringify({
    source: b.source, source_path: b.source_path, library: b.library, machine: b.machine, machine_label: b.machine_label,
    card_hash: b.card_hash, card_blocks: b.card_blocks, card_rels: b.card_rels, embed: true }) }));
  const record_ids = r.rels.map((_, i) => 'r' + i);
  return { entries, record_ids };
}
const stale = (p, cloud) => {
  const pr = prep(p);
  const out = pickStale({ blocks_body: JSON.stringify({ entries: cloud.entries }), triplets_body: JSON.stringify({ record_ids: cloud.record_ids }),
    path: p.path, machine: p.machine, card_hash: (pr.data ?? pr).card_hash });
  return out.data ?? out;
};

{
  const p = payload(card());
  const cloud = cloudAfterWrite(p);
  const r = stale(p, cloud);
  t('同一張卡再送一次：判定沒變、不刪任何東西', r.result === true && r.dead_entry.length === 0 && r.dead_record.length === 0, JSON.stringify(r));
}
{
  const cloud = cloudAfterWrite(payload(card('舊')));
  const p2 = payload(card('改了一個字'));
  const r = stale(p2, cloud);
  t('內容改一個字：判定有變，舊的 block 與三元組全列入刪除', r.result === false && r.dead_entry.length === cloud.entries.length && r.dead_record.length === cloud.record_ids.length, JSON.stringify(r));
}
{
  const p = payload(card());
  const cloud = cloudAfterWrite(p);
  const r = stale(payload(card(), { machine_label: '改名了' }), cloud);
  t('只改機器稱呼：也算有變（稱呼會寫進 block 給 portal 顯示）', r.result === false);
}
{
  const p = payload(card());
  const c1 = cloudAfterWrite(p), c2 = cloudAfterWrite(p);
  const dup = { entries: [...c1.entries, ...c2.entries], record_ids: [...c1.record_ids, ...c2.record_ids.map((x) => x + 'b')] };
  const r = stale(p, dup);
  t('雲端同錨點有兩份：不算一樣，兩份都列入刪除（清掉重複）', r.result === false && r.dead_entry.length === dup.entries.length && r.dead_record.length === dup.record_ids.length, JSON.stringify(r));
}
{
  const p = payload(card());
  const c = cloudAfterWrite(p);
  const r = stale(p, { entries: c.entries.slice(1), record_ids: c.record_ids });
  t('雲端少一段 block（半寫入）：不算一樣', r.result === false);
  const r2 = stale(p, { entries: c.entries, record_ids: c.record_ids.slice(1) });
  t('雲端少一條三元組：不算一樣', r2.result === false);
}
{
  // 改版前寫的舊資料（沒有 card_hash）：一律重寫一次
  const p = payload(card());
  const old = { entries: [{ id: 'old', metadata_json: JSON.stringify({ source: 'kb://x/頁.md#0', source_path: 'x/頁.md', library: 'kb', machine: 'm1', embed: true }) }], record_ids: ['r0'] };
  const r = stale(p, old);
  t('舊資料沒有指紋：判定有變、重寫一次', r.result === false && r.dead_entry.length === 1);
}
{
  const p = payload(card());
  const r = stale(p, { entries: [], record_ids: [] });
  t('雲端還沒有這張卡：判定有變（要寫）', r.result === false);
}
{
  // 別台機器的同路徑卡不被當成「這張卡的重複」
  const other = cloudAfterWrite(payload(card(), { machine: 'm2' }));
  const r = stale(payload(card(), { machine: 'm1' }), other);
  t('別台機器的同路徑卡：不列入刪除', r.dead_entry.length === 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
