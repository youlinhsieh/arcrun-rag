// paged-old-blocks.test.mjs — inkstone/arcrun-rag#269 c21857（geek 1.4.111 實撞）：
// 一張疊了三份、147 個 block 的大卡，list_old_blocks 單頁 78 KB > http_request 的 64 KB 上限，
// 整張卡重收失敗、舊的清不掉。守三件事：
//   ① 每頁大小（用實測量級的 block 列）不超過 64 KB，且有帶 offset 的後續頁
//   ② 多頁合併後，147 個 block 一個不漏地被判成待刪（排重＝只剩新的一份）
//   ③ 超過一次能清的上限時明講失敗，不靜默漏刪
// 跑法：node workflows/tests/paged-old-blocks.test.mjs
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const rd = (f) => fs.readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
const specs = [
  { f: 'rag-ingest-card.local.yaml', first: 'list_old_blocks', next: 'list_old_triplets', node: 'pick_stale' },
  { f: 'rag-takedown-direct.local.yaml', first: 'list_dead_blocks', next: 'build_deprecations', node: 'build_deprecations' },
];
let pass = 0, fail = 0;
const t = (label, cond, extra = '') => { cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++); };

const PATH = 'CompactB-3020(Z1250)+K2 (A63)24K-Machine Features.pdf';
const row = (i, hash) => ({ id: 'e' + i + '_' + hash, entry_type: 'block', owner_id: 'ckxt8yr9', page_name: 'CompactB-3020(Z1250)+K2 (A63)24K-Machine Features', // geek 實測 147 筆 ≈ 78 KB（約 530 B/筆）
 
  created_at: 1792335000, updated_at: 1792335000,
  metadata_json: JSON.stringify({ source_path: PATH, source: 'kb://' + PATH + '#' + i, machine: 'youlinhsieh@Leo-MBA',
    card_hash: hash, card_blocks: 49, library: 'lib_473ed4', card_rels: 21 }) });

for (const s of specs) {
  const y = rd(s.f);
  const pageUrls = [...y.matchAll(new RegExp(`\\n  (${s.first}(?:_p\\d+)?):\\n[\\s\\S]*?\\n    url: "([^"]+)"`, 'g'))].map((m) => [m[1], m[2]]);
  t(`${s.f}: 有多頁節點`, pageUrls.length >= 8, String(pageUrls.length));
  const limits = pageUrls.map(([, u]) => Number(/limit=(\d+)/.exec(u)[1]));
  const offs = pageUrls.map(([, u]) => Number(/offset=(\d+)/.exec(u)[1]));
  t(`${s.f}: 每頁 limit ≤ 60，offset 逐頁遞增不重疊`, limits.every((l) => l <= 60) && offs.every((o, i) => o === i * limits[i]), JSON.stringify([limits, offs]));
  // 單頁實際大小
  const page60 = JSON.stringify({ success: true, entries: Array.from({ length: 60 }, (_, i) => row(i, 'h')), count: 60, total: 147 });
  t(`${s.f}: 滿頁（60 筆）回應 < 64 KB`, Buffer.byteLength(page60) < 65536, String(Buffer.byteLength(page60)));
  const full = JSON.stringify({ success: true, entries: Array.from({ length: 147 }, (_, i) => row(i, 'h')) });
  t(`（對照）舊寫法一頁撈 147 筆 > 64 KB`, Buffer.byteLength(full) > 65536, String(Buffer.byteLength(full)));
  // flow 串成一條
  const chainOk = pageUrls.every(([name], i) => i === pageUrls.length - 1
    ? y.includes(`"${name} >> ON_SUCCESS >> ${s.next}"`) : y.includes(`"${name} >> ON_SUCCESS >> ${pageUrls[i + 1][0]}"`));
  t(`${s.f}: flow 逐頁串到 ${s.next}`, chainOk);
  // 每頁都餵進處理節點
  const nodeBlock = y.slice(y.indexOf(`\n  ${s.node}:`));
  t(`${s.f}: ${s.node} 吃到每一頁`, pageUrls.every(([name]) => nodeBlock.includes(`{{${name}.data.body}}`)));

  // 行為：147 筆（三份疊）分頁餵進去，全部判待刪
  const fn = new Function('input', codeOf(y, s.node));
  const all = [...Array(49).keys()].flatMap((i) => ['a', 'b', 'c'].map((h) => row(i * 3 + 'abc'.indexOf(h), h)));
  const input = { path: PATH, machine: 'youlinhsieh@Leo-MBA', library: 'lib_473ed4', card_hash: 'NEW', do_blocks: 'true', slice_len: '0', triplets_body: JSON.stringify({ record_ids: [] }) };
  const names = pageUrls.map(([n]) => n);
  names.forEach((n, i) => {
    const slice = all.slice(i * 60, i * 60 + 60);
    input[i === 0 ? 'blocks_body' : `blocks_body_p${i + 1}`] = JSON.stringify({ entries: slice, count: slice.length, total: all.length });
  });
  const out = fn(input); const r = out.data ?? out;
  const dead = r.dead_entry ?? r.dead_entries;
  t(`${s.f}: 三份疊的 147 個 block 跨頁合併後全部待刪（舊的清乾淨、不漏頁）`, dead && dead.length === 147, String(dead && dead.length));

  // 超量：明講失敗
  const big = { ...input, blocks_body: JSON.stringify({ entries: all.slice(0, 60), total: 601 }) };
  let threw = false; try { fn(big); } catch (e) { threw = /601/.test(String(e.message)); }
  t(`${s.f}: total 超過一次能清的上限 ⇒ throw（不靜默漏刪）`, threw);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
