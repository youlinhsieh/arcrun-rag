// inkstone/arcrun-rag#296：rag_ingest_passages 的契約——段落進向量層，卡的 block 不進。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codeOf } from './_yaml-code.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const y = readFileSync(join(root, 'workflows/rag-ingest-passages.local.yaml'), 'utf8');
const prep = new Function('input', codeOf(y, 'prep'));
const base = { path: 'a/b.md', page_name: 'b', machine: 'm@x', library: 'kb', source_hash: 'h', chunker_rev: 1, total: 2 };
const P = (i) => ({ id: `psg-0123456789abcdef-${i}`, idx: i, heading: 'b › x', content: `b › x\n段${i}` });

test('段落寫成 source_passage 並標 embed:true、帶出處與原稿版本', () => {
  const r = prep({ ...base, passages: [P(0), P(1)], delete_ids: [] });
  assert.equal(r.put_item.length, 2);
  const m = JSON.parse(r.put_item[1].metadata_json);
  assert.equal(m.embed, true);
  assert.equal(m.source, 'kb://a/b.md#p1');
  assert.equal(m.source_hash, 'h');
  assert.equal(m.chunk_idx, 1);
  assert.equal(m.chunk_total, 2);
  assert.match(y, /template: "source_passage"/);
});

test('只准碰段落 id；缺必填一律 throw（什麼都不寫）', () => {
  assert.throws(() => prep({ ...base, passages: [], delete_ids: ['e123'] }), /不是段落 id/);
  assert.throws(() => prep({ ...base, passages: [{ ...P(0), id: 'x' }], delete_ids: [] }), /id 格式/);
  assert.throws(() => prep({ ...base, machine: '', passages: [P(0)] }), /machine/);
  assert.throws(() => prep({ ...base, path: '{{input.path}}', passages: [P(0)] }), /佔位符/);
  assert.throws(() => prep({ ...base, passages: Array.from({ length: 41 }, (_, i) => P(i)) }), /最多 40/);
});

test('可只刪不寫（改短／下架）', () => {
  const r = prep({ ...base, passages: [], delete_ids: ['psg-0123456789abcdef-7'] });
  assert.equal(r.put_item.length, 0);
  assert.equal(r.dead_item.length, 1);
});

for (const f of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
  test(`${f} 有預編圖且兩條 FOREACH 並行 6`, () => {
    const list = JSON.parse(readFileSync(join(root, f), 'utf8'));
    const w = list.find((x) => x.name === 'rag_ingest_passages');
    assert.ok(w && w.graph?.nodes?.length, '缺 rag_ingest_passages 或沒圖');
    assert.equal((JSON.stringify(w).match(/"concurrency":6/g) || []).length, 2);
  });
}

test('卡的 block 仍不標 embed（舊原則只對卡保留）', () => {
  const card = readFileSync(join(root, 'workflows/rag-ingest-card.local.yaml'), 'utf8');
  const m = card.match(/post_block:[\s\S]*?metadata_json:\s*"([^\n]*)"/);
  assert.ok(m && !/embed/.test(m[1]));
});
