// 示範知識庫快照的整理工具（inkstone/arcrun-rag#349）。在私有雲映像檔裡跑（要它的 node:sqlite 與 sqlite-vec）：
//   docker run --rm -v <快照資料夾>:/s -v <本檔>:/t.mjs:ro --entrypoint node <映像> --no-warnings /t.mjs <指令> /s [參數]
// 指令：
//   filter   <dir>                 拿掉建置機自己的營運資料（帳號、登入、金鑰目錄、工作流資產、執行紀錄），只留知識
//   retarget <dir> <新租戶>        把快照的租戶整份改名（知識列的 owner、三元組端點、向量的 owner），
//                                  推導出來的地圖／計數列刪掉（引擎第一次讀時自己重算）
//   manifest <dir>                 寫 MANIFEST.json（格式與 1.4.204-onprem.1 的 kb/MANIFEST.json 相同）
//   tenant   <dir>                 印出快照目前的租戶
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
const [cmd, dir, arg] = process.argv.slice(2);
if (!cmd || !dir) { console.error('用法：demo-kb-tool.mjs filter|retarget|manifest|tenant <dir> [新租戶]'); process.exit(2); }
const K = `${dir}/kbdb.sqlite`, V = `${dir}/vectors.sqlite`;
const openVec = async () => { const db = new DatabaseSync(V, { allowExtension: true }); (await import('/app/node_modules/sqlite-vec/index.mjs')).load(db); return db; };
const tenantOf = (db) => db.prepare(`SELECT owner_id o, count(*) c FROM entries WHERE owner_id IS NOT NULL AND owner_id NOT LIKE '%::%' AND owner_id NOT LIKE '\\_\\_%' ESCAPE '\\' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`).get()?.o;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tidy = (db) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); };

if (cmd === 'tenant') { console.log(tenantOf(new DatabaseSync(K, { readOnly: true }))); }

if (cmd === 'filter') {
  const db = new DatabaseSync(K);
  // 與 arcrun-rag scripts/onprem/filter-snapshot.mjs 同一組規則，再加三類（新版引擎把它們存成一般列，entry_type 是空的）：
  //   owner 以 ::assets 結尾 → 建置機的工作流資產與小幫手提示（精靈會在客戶那台重裝 RAG 工作流）
  //   金鑰目錄列（metadata 有 secret_ref，或密文列 CRED_*）→ 建置機主金鑰加密的，客戶解不開，留著只是漏
  const WHERE = `entry_type IN ('execution_log','credential','portal_user')
    OR owner_id LIKE '%::portal' OR owner_id LIKE '%::assets' OR owner_id = '__arcrun_auth_store__'
    OR page_name LIKE 'CRED\\_%' ESCAPE '\\' OR json_extract(metadata_json,'$.secret_ref') IS NOT NULL`;
  const before = db.prepare('SELECT count(*) c FROM entries').get().c;
  const dropped = db.prepare(`SELECT entry_type, owner_id, count(*) c FROM entries WHERE ${WHERE} GROUP BY 1,2 ORDER BY c DESC`).all().map((r) => ({ entry_type: r.entry_type, owner_id: r.owner_id, n: r.c }));
  db.exec(`DELETE FROM entries WHERE ${WHERE}`);
  const after = db.prepare('SELECT count(*) c FROM entries').get().c;
  tidy(db);
  const rep = { before, after, dropped_total: before - after, dropped };
  fs.writeFileSync(`${dir}/filter.json`, JSON.stringify(rep));
  console.log(JSON.stringify(rep));
}

if (cmd === 'retarget') {
  const to = String(arg ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(to)) { console.error('新租戶名要是小寫英數（例 ckxt8yr9）'); process.exit(2); }
  const db = new DatabaseSync(K);
  const from = tenantOf(db);
  if (!from) { console.error('快照裡讀不到租戶'); process.exit(2); }
  if (from === to) { console.log(JSON.stringify({ from, to, changed: 0 })); process.exit(0); }
  db.exec('BEGIN');
  // 推導列（地圖、每庫卡數、接手標記）：身分是 owner 的雜湊，改名後對不上 ⇒ 刪掉，引擎第一次讀時從知識列重算
  const derived = db.prepare(`DELETE FROM entries WHERE substr(id,1,4)='lmap' OR substr(id,1,9)='relb_lmap'`).run().changes;
  const n = db.prepare('UPDATE entries SET owner_id=? WHERE owner_id=?').run(to, from).changes;
  const like = `%${from}%`;
  const ids = db.prepare('UPDATE entries SET id=replace(id,?,?) WHERE id LIKE ?').run(from, to, like).changes;
  const ends = db.prepare('UPDATE entries SET src_id=replace(src_id,?,?), dst_id=replace(dst_id,?,?) WHERE src_id LIKE ? OR dst_id LIKE ?').run(from, to, from, to, like, like).changes;
  const left = db.prepare('SELECT count(*) c FROM entries WHERE owner_id LIKE ? OR id LIKE ? OR content LIKE ? OR metadata_json LIKE ?').get(like, like, like, like).c;
  db.exec('COMMIT');
  tidy(db);
  const vdb = await openVec();
  const vn = vdb.prepare('UPDATE vec SET owner_id=? WHERE owner_id=?').run(to, from).changes;
  vdb.exec('VACUUM');
  const rep = { from, to, derived_dropped: derived, owner_rows: n, ids_renamed: ids, triple_ends: ends, vectors: vn, still_mentions_old: left };
  console.log(JSON.stringify(rep));
  if (left) process.exit(1);
}

if (cmd === 'manifest') {
  const db = new DatabaseSync(K, { readOnly: true });
  const by = Object.fromEntries(db.prepare('SELECT entry_type t, count(*) c FROM entries GROUP BY 1').all().map((r) => [r.t, r.c]));
  const vdb = await openVec();
  const m = {
    made_at: new Date().toISOString(), tenant: tenantOf(db), kind: 'demo',
    note: '示範知識庫（與任何客戶無關）：5 份食譜＋虛構公司請假規定 3 份。inkstone/arcrun-rag#349',
    entries: db.prepare('SELECT count(*) c FROM entries').get().c,
    templates: db.prepare('SELECT count(*) c FROM templates').get().c,
    by_entry_type: by,
    vectors: vdb.prepare('SELECT count(*) c FROM vec_rowids WHERE id IS NOT NULL').get().c,
    user_version: db.prepare('PRAGMA user_version').get().user_version,
    filter: fs.existsSync(`${dir}/filter.json`) ? JSON.parse(fs.readFileSync(`${dir}/filter.json`, 'utf8')) : null,
    sha256: { 'kbdb.sqlite': sha(K), 'vectors.sqlite': sha(V) },
  };
  fs.writeFileSync(`${dir}/MANIFEST.json`, JSON.stringify(m, null, 2));
  console.log(JSON.stringify({ tenant: m.tenant, entries: m.entries, templates: m.templates, vectors: m.vectors }));
}
