// inkstone/arcrun-rag#300（W5，母票 inkstone/Arcrun#294）：
// 收卡時，卡上的實體要送 KBDB `POST /entities/resolve` 歸併，否則 entity 永遠是 0 筆。
//
// 守的事：
//   1. flow 接上了：parse_card → prep_entity_resolve → resolve_entities，兩個節點都有 ON_FAIL 吸收
//      （resolve 失敗不擋卡）。既有的 block／triplet／分群／概念四條出邊沒被動到。
//   2. 請求形狀：打 /entities/resolve、帶 kbdb_internal_token 佔位（D36，不寫真值）、owner_id 與 items。
//   3. prep_entity_resolve：主詞／受詞＋「## 實體」段（名字＋描述）、去重、不送 knowledge-base、
//      分段只送自己那一段、最多 50 個、沒有東西時 throw（只有 throw 才會走 ON_FAIL）。
//   4. 預編圖（workflows.json）含這幾個節點——使用者實例上種下去的是它，不是 YAML。
//
// 跑法：node --test workflows/tests/entity-resolve-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codeOf } from './_yaml-code.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const y = read('workflows/rag-ingest-card.local.yaml');
const prep = new Function('input', codeOf(y, 'prep_entity_resolve'));
const flow = [...y.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);

const CARD = [
  '# 黃仁勳', '## 一句話定義', '輝達創辦人。', '## 實體',
  '- **黃仁勳**（人物）— NVIDIA 創辦人兼執行長',
  '- **皮衣男**（人物）— 常穿皮衣的 NVIDIA 創辦人',
  '- **NVIDIA**（公司）— （原稿未提供描述）',
  '', '## 關聯',
  '- 黃仁勳 >> 創辦 >> NVIDIA', '- 皮衣男 >> 領導 >> NVIDIA', '- 黃仁勳 >> 描述 >> 庫克', '',
].join('\n');

test('flow：resolve 接在 parse_card 之後，且兩個節點都有 ON_FAIL 吸收', () => {
  for (const e of [
    'parse_card >> ON_SUCCESS >> prep_entity_resolve',
    'prep_entity_resolve >> ON_SUCCESS >> resolve_entities',
    'prep_entity_resolve >> ON_FAIL >> entity_resolve_absorb_prep_fail',
    'resolve_entities >> ON_FAIL >> entity_resolve_absorb_fail',
  ]) assert.ok(flow.includes(e), '缺邊：' + e);
  for (const e of [
    'parse_card >> 對每個 block 並行 6 >> post_block',
    'parse_card >> 對每個 rel 並行 6 >> post_triplet',
    'parse_card >> ON_SUCCESS >> prep_cluster_wiki',
    'parse_card >> ON_SUCCESS >> prep_entity_concept',
  ]) assert.ok(flow.includes(e), '既有邊被動到：' + e);
});

test('請求形狀：打 /entities/resolve，金鑰只寫佔位', () => {
  const blk = y.match(/  resolve_entities:[\s\S]*?(?=\n  #|\n  [a-z_]+:)/)[0];
  assert.match(blk, /url: "__KBDB_BASE__\/entities\/resolve"/);
  assert.match(blk, /\{\{credential\.kbdb_internal_token\}\}/);
  assert.match(blk, /owner_id: "__NAMESPACE__"/);
  assert.match(blk, /items: "\{\{prep_entity_resolve\.data\.items\}\}"/);
});

test('prep：名字＋描述、去重、不送 knowledge-base，別名候選（皮衣男）帶描述', () => {
  const r = prep({ card: CARD, page_name: '黃仁勳', rel_offset: 0, rel_limit: 0 });
  assert.equal(r.success, true);
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.deepEqual(Object.keys(byName).sort(), ['NVIDIA', '庫克', '皮衣男', '黃仁勳'].sort());
  assert.equal(byName['皮衣男'].description, '常穿皮衣的 NVIDIA 創辦人');
  assert.equal(byName['黃仁勳'].description, 'NVIDIA 創辦人兼執行長');
  assert.equal('description' in byName['NVIDIA'], false, '「原稿未提供描述」不能當描述送');
  assert.equal('description' in byName['庫克'], false);
  assert.ok(!('knowledge-base' in byName));
});

test('prep：分段只送自己那一段；實體段只在第一段', () => {
  const a = prep({ card: CARD, page_name: 'x', rel_offset: 0, rel_limit: 1 });
  assert.deepEqual(a.items.map((i) => i.name).sort(), ['NVIDIA', '皮衣男', '黃仁勳'].sort(), '第一段含實體段，但不含別段的庫克');
  const b = prep({ card: CARD, page_name: 'x', rel_offset: 2, rel_limit: 1 });
  assert.deepEqual(b.items.map((i) => i.name).sort(), ['庫克', '黃仁勳']);
});

test('prep：最多 50 個，多的記在 truncated', () => {
  const rels = Array.from({ length: 60 }, (_, i) => `- A${i} >> 屬於 >> B${i}`).join('\n');
  const r = prep({ card: '# t\n## 關聯\n' + rels + '\n', page_name: 't', rel_offset: 0, rel_limit: 0 });
  assert.equal(r.items.length, 50);
  assert.equal(r.truncated, 70);
});

test('prep：沒有可歸併的東西就 throw（才會走 ON_FAIL，不是 return success:false）', () => {
  assert.throws(() => prep({ card: '# t\n只有內文\n', page_name: 't', rel_offset: 0, rel_limit: 0 }), /沒有可歸併/);
  assert.throws(() => prep({ card: '# t\n## 關聯\n- X >> 屬於 >> knowledge-base\n', page_name: 't', rel_offset: 1, rel_limit: 0 }), /沒有可歸併/);
});

for (const f of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
  test(`${f} 的 rag_ingest_card 預編圖含歸併節點`, () => {
    const wf = JSON.parse(read(f));
    const card = (Array.isArray(wf) ? wf : Object.values(wf)).find((w) => w && w.name === 'rag_ingest_card');
    assert.ok(card.config.resolve_entities, 'config 缺 resolve_entities');
    assert.ok(card.flow.includes('parse_card >> ON_SUCCESS >> prep_entity_resolve'));
    const ids = (card.graph.nodes || []).map((n) => n.id);
    for (const n of ['prep_entity_resolve', 'resolve_entities', 'entity_resolve_absorb_fail', 'entity_resolve_absorb_prep_fail'])
      assert.ok(ids.includes(n), '預編圖缺節點 ' + n);
  });
}
