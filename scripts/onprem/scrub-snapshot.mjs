// 搬給客戶前，把「原廠機器名」從搬出來的複本裡洗掉（只動複本檔，不碰來源）。
// 用法：node --no-warnings scrub-snapshot.mjs <kbdb.sqlite> [--machine <要洗掉的機器名>]... [--label <換成的稱呼>]
//   → 印出 JSON 報告（洗了幾列、還剩幾列含機器名）；還剩 > 0 就 exit 1。
//
// 為什麼要洗（inkstone/arcrun-rag#389）：快照是在原廠 Mac 上萃的卡，每張卡的「### 出處」寫著
//   「原文位置（機器 › 知識庫 › 庫內路徑）：`<機器名> › error_codes › 145-0010_001.md`」，
//   同仁開出處就看到原廠的機器名（約 2.2 萬列）。metadata 的 machine／machine_label 與
//   「機器」實體值格也帶著同一個字串。
//
// 怎麼洗：機器名換成一個中性稱呼（預設「匯入快照」），三處同一個字串換成同一個字串——
//   · entries.content            「### 出處」那行與機器實體值格
//   · entries.metadata_json      machine、machine_label（Portal 依 machine 分組；換成同一個稱呼＝仍是一組，不會變空）
// 不刪列、不改 id、不動關係，所以搜尋、圖譜、向量（key 是 entry id）都不受影響。
// 全文索引（entries_fts）與欄位值索引（field_value_index）由表上的觸發器跟著改，這支不手動碰。
// 這是搬運管線的一步（跟 filter-snapshot.mjs 同一類：只對匯出的複本做、可重跑），
// 不是在跑著的 KBDB 上寫 SQL。
//
// 只洗機器名；快照裡其他個人路徑（例如 /Users/…）不在這支範圍，報告會另外數出來讓人決定。
import { DatabaseSync } from 'node:sqlite';

export function scrub(db, { machines, label }) {
  const report = { label, machines, replaced: {}, remaining: {}, other_leaks: {} };
  const lit = (s) => `'${s.replace(/'/g, "''")}'`;
  db.exec('BEGIN');
  try {
    for (const m of machines) {
      // 先整串換（含 user@host 與只有 host 兩種寫法，長的在前）
      const c = db.prepare('UPDATE entries SET content = replace(content, ?, ?) WHERE content LIKE ?').run(m, label, `%${m}%`);
      const j = db.prepare('UPDATE entries SET metadata_json = replace(metadata_json, ?, ?) WHERE metadata_json LIKE ?').run(m, label, `%${m}%`);
      report.replaced[m] = { content_rows: Number(c.changes), metadata_rows: Number(j.changes) };
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const m of machines) {
    // LIKE 對 ASCII 不分大小寫，剛好抓到大小寫變體
    const rc = db.prepare('SELECT count(*) c FROM entries WHERE content LIKE ?').get(`%${m}%`).c;
    const rj = db.prepare('SELECT count(*) c FROM entries WHERE metadata_json LIKE ?').get(`%${m}%`).c;
    const rf = db.prepare('SELECT count(*) c FROM field_value_index WHERE value LIKE ?').get(`%${m}%`).c;
    report.remaining[m] = { content_rows: rc, metadata_rows: rj, field_value_index_rows: rf };
  }
  report.other_leaks['/Users/'] = db.prepare("SELECT count(*) c FROM entries WHERE content LIKE '%/Users/%' OR metadata_json LIKE '%/Users/%'").get().c;
  // rank=0 只驗索引自身一致；rank=1 會拿 entries 全表比對，而 ~v~ 版本列本來就不進索引（觸發器 WHEN），原檔就過不了
  report.fts_integrity = (() => { try { db.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 0)"); return 'ok'; } catch (e) { return String(e.message); } })();
  report.ok = Object.values(report.remaining).every((r) => r.content_rows === 0 && r.metadata_rows === 0 && r.field_value_index_rows === 0) && report.fts_integrity === 'ok';
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('scrub-snapshot.mjs')) {
  const a = process.argv.slice(2);
  const f = a[0];
  if (!f || f.startsWith('--')) { console.error('用法：scrub-snapshot.mjs <kbdb.sqlite> [--machine <名>]... [--label <稱呼>]'); process.exit(2); }
  const machines = []; let label = '匯入快照';
  for (let i = 1; i < a.length; i += 2) {
    if (a[i] === '--machine') machines.push(a[i + 1]);
    else if (a[i] === '--label') label = a[i + 1];
    else { console.error(`不認得的參數：${a[i]}`); process.exit(2); }
  }
  // 預設：原廠那台 Mac（user@host 在前、單獨 host 在後）
  if (!machines.length) machines.push('youlinhsieh@Leo-MBA', 'Leo-MBA');
  const db = new DatabaseSync(f);
  const r = scrub(db, { machines, label });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // WAL 模式下 VACUUM 會把整庫寫進 -wal，不收掉交出去的複本旁邊會多一個幾百 MB 的檔
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
