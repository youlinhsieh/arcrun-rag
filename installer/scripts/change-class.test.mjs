import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './change-class.mjs';

test('只有 app-market：軟更新，走市集線，不出主程式新版號', () => {
  const r = classify(['app-market/declarations/notes.json', 'app-market/catalog.json']);
  assert.equal(r.kind, 'soft');
  assert.ok(r.soft.every((s) => s.via === 'market'));
});
test('動到 cypher-executor／console-ui 的非畫面檔／builtins：硬', () => {
  for (const p of ['cypher-executor/src/a.ts', 'console-ui/scripts/deploy.mjs', 'builtins/x/worker.mjs', 'mcp/src/i.ts']) assert.equal(classify([p]).kind, 'hard', p);
});
test('只改 Portal 畫面（console-ui/public）：軟，走畫面包線（inkstone/arcrun-rag#398）', () => {
  const r = classify(['console-ui/public/portal/index.html', 'console-ui/public/portal/replykit.js']);
  assert.equal(r.kind, 'soft');
  assert.ok(r.soft.every((x) => x.via === 'portal'));
  assert.match(r.reason, /畫面包線/);
});
test('Portal 畫面＋一個 worker 檔：整體硬（畫面仍被列為資料類）', () => {
  const r = classify(['console-ui/public/portal/index.html', 'cypher-executor/src/a.ts']);
  assert.equal(r.kind, 'hard');
  assert.equal(r.soft.length, 1);
});
test('認不得的路徑一律算硬', () => assert.equal(classify(['something/new.bin']).kind, 'hard'));
test('只有文件與測試：無需送達', () => {
  assert.equal(classify(['README.md', 'docs/x.md', 'cypher-executor/src/a.test.ts', 'system-dev/wiki/a.md']).kind, 'none');
});
test('App＋一個 worker 檔：整體硬，但 App 仍被列為資料類', () => {
  const r = classify(['app-market/catalog.json', 'cypher-executor/src/a.ts']);
  assert.equal(r.kind, 'hard');
  assert.equal(r.soft.length, 1);
});
test('只有內建工作流變：資料類，但匯入路徑還沒接 ⇒ 今天仍算硬，並說明原因', () => {
  const r = classify(['workflows/global_index.app.json']);
  assert.equal(r.kind, 'hard');
  assert.match(r.reason, /匯入路徑還沒接/);
});
