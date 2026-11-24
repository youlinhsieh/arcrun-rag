// node --no-warnings --test scripts/onprem/scrub-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scrub } from './scrub-snapshot.mjs';

function mkdb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT, entry_type TEXT NOT NULL DEFAULT '', metadata_json TEXT, updated_at INTEGER);
    CREATE VIRTUAL TABLE entries_fts USING fts5(content, content='entries', content_rowid='rowid', tokenize='trigram');
    CREATE TABLE field_value_index (rel_row TEXT PRIMARY KEY, value TEXT NOT NULL, cell_id TEXT NOT NULL) WITHOUT ROWID;
    CREATE TRIGGER entries_fts_ai AFTER INSERT ON entries WHEN new.content IS NOT NULL BEGIN INSERT INTO entries_fts(rowid, content) VALUES (new.rowid, new.content); END;
    CREATE TRIGGER entries_fts_au AFTER UPDATE OF content ON entries WHEN old.content IS NOT new.content BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, content) SELECT 'delete', old.rowid, old.content WHERE old.content IS NOT NULL;
      INSERT INTO entries_fts(rowid, content) SELECT new.rowid, new.content WHERE new.content IS NOT NULL; END;
    CREATE TRIGGER fvi_au AFTER UPDATE OF content ON entries WHEN old.content IS NOT new.content AND EXISTS (SELECT 1 FROM field_value_index f WHERE f.cell_id = new.id) BEGIN
      UPDATE field_value_index SET value = new.content WHERE cell_id = new.id; END;
  `);
  return db;
}
const M = ['youlinhsieh@Leo-MBA', 'Leo-MBA'];

test('出處行、機器值格、metadata 都換成同一個稱呼，列數與 id 不變', () => {
  const db = mkdb();
  db.exec(`INSERT INTO entries VALUES
    ('b1','### 出處\n- 原文位置（機器 › 知識庫 › 庫內路徑）：\`youlinhsieh@Leo-MBA › error_codes › 145-0010_001.md\`\n- x','block','{"machine":"youlinhsieh@Leo-MBA","machine_label":"youlinhsieh@Leo-MBA","library":"error_codes"}',7),
    ('v1','youlinhsieh@Leo-MBA','value',NULL,7),
    ('k1','半徑太小 145-0010','block','{"library":"error_codes"}',7)`);
  db.exec(`INSERT INTO field_value_index VALUES ('r1','youlinhsieh@Leo-MBA','v1')`);
  const r = scrub(db, { machines: M, label: '匯入快照' });
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT count(*) c FROM entries').get().c, 3);
  assert.match(db.prepare("SELECT content FROM entries WHERE id='b1'").get().content, /`匯入快照 › error_codes › 145-0010_001\.md`/);
  assert.equal(db.prepare("SELECT content FROM entries WHERE id='v1'").get().content, '匯入快照');
  const m = JSON.parse(db.prepare("SELECT metadata_json m FROM entries WHERE id='b1'").get().m);
  assert.deepEqual([m.machine, m.machine_label, m.library], ['匯入快照', '匯入快照', 'error_codes']);
  assert.equal(db.prepare("SELECT value FROM field_value_index").get().value, '匯入快照');
  assert.equal(db.prepare("SELECT updated_at FROM entries WHERE id='b1'").get().updated_at, 7);
  // 無關的列一個字不動
  assert.equal(db.prepare("SELECT content FROM entries WHERE id='k1'").get().content, '半徑太小 145-0010');
});

test('全文索引跟著換：搜舊機器名搜不到、搜新稱呼搜得到', () => {
  const db = mkdb();
  db.exec(`INSERT INTO entries VALUES ('b1','位置：youlinhsieh@Leo-MBA › error_codes','block',NULL,1)`);
  scrub(db, { machines: M, label: '匯入快照' });
  assert.equal(db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH '\"Leo-MBA\"'").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH '\"匯入快照\"'").get().c, 1);
});

test('只剩大小寫變體也算沒洗乾淨（ok=false）', () => {
  const db = mkdb();
  db.exec(`INSERT INTO entries VALUES ('b1','x leo-mba y','block',NULL,1)`);
  const r = scrub(db, { machines: ['Leo-MBA'], label: '匯入快照' });
  assert.equal(r.ok, false);
});

test('重跑不會出事（已洗過的複本再洗一次＝0 列）', () => {
  const db = mkdb();
  db.exec(`INSERT INTO entries VALUES ('v1','youlinhsieh@Leo-MBA','value',NULL,1)`);
  scrub(db, { machines: M, label: '匯入快照' });
  const r2 = scrub(db, { machines: M, label: '匯入快照' });
  assert.equal(r2.ok, true);
  assert.equal(r2.replaced['youlinhsieh@Leo-MBA'].content_rows, 0);
});
