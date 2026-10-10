// 向量只做 entity／關係詞排重（arcrun-rag CLAUDE.md、inkstone/InkStoneCo#226、inkstone/Arcrun#297 c18592）：
// 收卡寫卡正文 block 時不得標 embed:true（標了 KBDB 就會為每段正文嵌一次向量）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('rag-ingest-card.local.yaml 的 post_block 不標 embed', () => {
  const y = read('workflows/rag-ingest-card.local.yaml');
  const m = y.match(/post_block:[\s\S]*?metadata_json:\s*"([^\n]*)"/);
  assert.ok(m, '找不到 post_block 的 metadata_json');
  assert.ok(!/embed/.test(m[1]), 'post_block 的 metadata_json 不得含 embed');
  assert.ok(/card_hash/.test(m[1]), '其他欄位（card_hash）要還在');
});

for (const f of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
  test(`${f} 的 rag_ingest_card 預編圖不含 embed`, () => {
    const wf = JSON.parse(read(f));
    const list = Array.isArray(wf) ? wf : Object.values(wf);
    const card = list.find((w) => w && w.name === 'rag_ingest_card');
    assert.ok(card, '找不到 rag_ingest_card');
    assert.ok(!/embed/.test(JSON.stringify(card.config.post_block)), 'post_block 預編圖不得含 embed');
  });
}
