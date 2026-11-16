// inkstone/Arcrun#343（Leo 2026-11-16）：原稿段落在 ingest 產生；已萃好的庫「再啟動一次萃取」就補上。
// 守的事：
//   1. flow：卡有變（parse_card）與卡沒變（skip_unchanged）兩條路都走到 prep_card_passages → card_passages，且都有 ON_FAIL 吸收。
//   2. 請求形狀：打 KBDB /entries/card-passages、帶 kbdb_internal_token 佔位（D36）、整張卡內容與身分都帶上。
//   3. prep_card_passages：只有負責 block 的那一段送；source_path 去掉 kb:// 前綴；沒帶 library 退回 kb。
//   4. 預編圖（workflows.json）含這幾個節點——使用者實例上種下去的是它，不是 YAML。
// 跑法：node --test workflows/tests/card-passages-ingest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codeOf } from './_yaml-code.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const y = read('workflows/rag-ingest-card.local.yaml');
const prep = new Function('input', codeOf(y, 'prep_card_passages'));
const flow = [...y.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);

test('flow：變與不變兩條路都產生段落，失敗都被吸收', () => {
  for (const e of [
    'parse_card >> ON_SUCCESS >> prep_card_passages',
    'skip_unchanged >> ON_SUCCESS >> prep_card_passages',
    'prep_card_passages >> ON_SUCCESS >> card_passages',
    'prep_card_passages >> ON_FAIL >> card_passages_absorb_prep_fail',
    'card_passages >> ON_FAIL >> card_passages_absorb_fail',
  ]) assert.ok(flow.includes(e), '缺邊：' + e);
  // 既有的出邊沒被動到
  for (const e of ['parse_card >> 對每個 block 並行 6 >> post_block', 'pick_stale >> ON_TRUE >> skip_unchanged',
    'parse_card >> ON_SUCCESS >> prep_entity_resolve']) assert.ok(flow.includes(e), '既有邊不見：' + e);
});

test('請求形狀：打 /entries/card-passages，金鑰只寫佔位', () => {
  const m = y.match(/\n  card_passages:\n([\s\S]*?)\n\n/);
  assert.ok(m, '找不到 card_passages 節點');
  const node = m[1];
  assert.match(node, /method: POST/);
  assert.match(node, /__KBDB_BASE__\/entries\/card-passages/);
  assert.match(node, /\{\{credential\.kbdb_internal_token\}\}/);
  for (const k of ['owner_id', 'page_name', 'source_path', 'library', 'machine', 'machine_label', 'card_hash', 'card_content']) {
    assert.match(node, new RegExp('\\n      ' + k + ':'), '缺欄位 ' + k);
  }
});

test('prep：整張卡與身分原樣交給 KBDB；source_path 去掉 kb://', () => {
  const r = prep({ card: '# X\n\n## 原文段落\n### PDF 第 1 頁的段落：A\nhello', page_name: 'X', path: 'kb://a/b.pdf',
    library: 'lib_1', machine: 'leo@Mac', machine_label: 'Leo 的 Mac', card_hash: 'h', do_blocks: true });
  assert.equal(r.source_path, 'a/b.pdf');
  assert.equal(r.library, 'lib_1');
  assert.equal(r.card_hash, 'h');
  assert.match(r.card_content, /原文段落/);
});

test('prep：沒帶或未代入的 library 退回 kb；未代入的樣板字串不流進去', () => {
  const r = prep({ card: 'c', page_name: 'X', path: 'kb://X.md', library: '{{input.library}}', machine: '{{input.machine}}', do_blocks: 'true' });
  assert.equal(r.library, 'kb');
  assert.equal(r.machine, '');
});

test('prep：不負責 block 的分段 throw（只有 throw 才走 ON_FAIL），不重複送', () => {
  assert.throws(() => prep({ card: 'c', page_name: 'X', path: 'kb://X.md', do_blocks: false }), /不負責 block/);
  assert.throws(() => prep({ card: 'c', page_name: 'X', path: 'kb://X.md', do_blocks: 'false' }), /不負責 block/);
});

test('預編圖含這幾個節點', () => {
  const wf = JSON.parse(read('installer/src/workflows.json')).find((w) => w.name === 'rag_ingest_card');
  assert.ok(wf, '預編圖沒有 rag_ingest_card');
  for (const n of ['prep_card_passages', 'card_passages', 'card_passages_absorb_fail', 'card_passages_absorb_prep_fail']) {
    assert.ok(wf.config[n], '設定裡沒有 ' + n);
    assert.ok(JSON.stringify(wf.graph).includes(n), '圖裡沒有 ' + n);
  }
});
