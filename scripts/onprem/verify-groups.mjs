// 搬庫後的「分組對照」：來源（線上 D1）是活的，搬完之後還在被寫，所以整庫逐列摘要幾乎一定對不上。
// 改成：依 (owner_id, entry_type) 分群，每群比 筆數／content 長度和／metadata 長度和／id 長度和／created_at 與 updated_at 最大值。
// 判準：知識群（不屬於下列「活的」群）必須完全一致；「活的」群的差異只印出來、不算失敗：
//   owner 為空（系統列）、owner 以 ::assets 結尾、::portal 結尾（上線後會被拿掉）、execution_log／credential／portal_user（也會被拿掉）。
// 用法：CF_ACCOUNT=… CF_TOKEN=… D1=<databaseId> node --no-warnings verify-groups.mjs <kbdb.sqlite>   → 印 JSON；有知識群不一致 exit 1
import { DatabaseSync } from 'node:sqlite';
const { CF_ACCOUNT: A, CF_TOKEN: T, D1: D } = process.env;
const f = process.argv[2];
if (!A || !T || !D || !f) { console.error('用法見檔頭'); process.exit(2); }
const SQL = `SELECT coalesce(owner_id,'') o, entry_type t, count(*) n, sum(length(coalesce(content,''))) c, sum(length(coalesce(metadata_json,''))) m, sum(length(id)) i, sum(length(coalesce(content_hash,''))) h, sum(length(coalesce(page_name,''))) p, sum(length(coalesce(refs_json,''))) r, max(created_at) ca, max(updated_at) ua FROM entries GROUP BY 1,2`;
const r = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/d1/database/${D}/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql: SQL }),
})).json();
if (!r.success) { console.error(JSON.stringify(r.errors)); process.exit(2); }
const src = new Map(r.result[0].results.map((x) => [`${x.o}|${x.t}`, x]));
const db = new DatabaseSync(f, { readOnly: true });
const dst = new Map(db.prepare(SQL).all().map((x) => [`${x.o}|${x.t}`, x]));
const live = (k) => { const [o, t] = k.split('|'); return o === '' || o.endsWith('::assets') || o.endsWith('::portal') || ['execution_log', 'credential', 'portal_user'].includes(t); };
const same = (a, b) => a && b && ['n', 'c', 'm', 'i', 'h', 'p', 'r', 'ca', 'ua'].every((p) => a[p] === b[p]);
const out = { groups: 0, identical: 0, knowledge_diff: [], live_diff: [] };
for (const k of new Set([...src.keys(), ...dst.keys()])) {
  out.groups++;
  const a = src.get(k), b = dst.get(k);
  if (same(a, b)) { out.identical++; continue; }
  const d = { group: k, source: a && { n: a.n, c: a.c, ca: a.ca, ua: a.ua }, copy: b && { n: b.n, c: b.c, ca: b.ca, ua: b.ua } };
  (live(k) ? out.live_diff : out.knowledge_diff).push(d);
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.knowledge_diff.length ? 1 : 0);
