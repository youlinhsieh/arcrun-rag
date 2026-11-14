// 搬給客戶前，把「geek 自己的營運資料」從搬出來的複本裡拿掉（只動複本檔，不碰來源）。
// 用法：node --no-warnings filter-snapshot.mjs <kbdb.sqlite>   → 印出 JSON 報告（刪了什麼、剩什麼）
// 拿掉的類別（客戶的機器上不該有、也沒有用）：
//   execution_log          geek 的工作流執行紀錄（22 萬列）
//   credential             金鑰保存處的目錄列（密文，客戶沒有對應主金鑰，留著只是漏）
//   portal_user            geek 的 portal 使用者
//   owner_id 以 ::portal 結尾   geek 的 portal 登入／工作階段
//   owner_id = __arcrun_auth_store__   geek 的 console 帳號
// 知識內容（card/block/record/relation/value/workflow 與 templates）一列不動。
import { DatabaseSync } from 'node:sqlite';
const f = process.argv[2];
if (!f) { console.error('用法：filter-snapshot.mjs <kbdb.sqlite>'); process.exit(2); }
const db = new DatabaseSync(f);
const WHERE = `entry_type IN ('execution_log','credential','portal_user') OR owner_id LIKE '%::portal' OR owner_id = '__arcrun_auth_store__'`;
const before = db.prepare('SELECT count(*) c FROM entries').get().c;
const dropped = db.prepare(`SELECT entry_type, owner_id, count(*) c FROM entries WHERE ${WHERE} GROUP BY 1,2 ORDER BY c DESC`).all().map((r) => ({ entry_type: r.entry_type, owner_id: r.owner_id, n: r.c }));
db.exec(`DELETE FROM entries WHERE ${WHERE}`);
const after = db.prepare('SELECT count(*) c FROM entries').get().c;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
console.log(JSON.stringify({ before, after, dropped_total: before - after, dropped }));
