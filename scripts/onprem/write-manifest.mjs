// 寫／驗 快照的 MANIFEST.json。
//   寫：TENANT=<namespace> OUT=<快照資料夾> node --no-warnings write-manifest.mjs
//   驗：node --no-warnings write-manifest.mjs --check <快照資料夾>   （sha256 對不上 exit 1）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';

const sha = (f) => {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(1 << 20); let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd); return h.digest('hex');
};

if (process.argv[2] === '--check') {
  const d = process.argv[3];
  const m = JSON.parse(fs.readFileSync(`${d}/MANIFEST.json`, 'utf8'));
  for (const [f, h] of Object.entries(m.sha256)) {
    if (sha(`${d}/${f}`) !== h) { console.error(`✗ ${f} 摘要不符：檔案損壞或被改過`); process.exit(1); }
  }
  console.log(`✓ 快照檔摘要一致（entries ${m.entries}／templates ${m.templates}／vectors ${m.vectors}）`);
} else {
  const o = process.env.OUT;
  const db = new DatabaseSync(`${o}/kbdb.sqlite`, { readOnly: true });
  const by = Object.fromEntries(db.prepare('SELECT entry_type t, count(*) c FROM entries GROUP BY 1').all().map((r) => [r.t, r.c]));
  const v = new DatabaseSync(`${o}/vectors.sqlite`, { readOnly: true });
  let vecs = null;
  for (const q of ["SELECT count(*) c FROM vec_rowids WHERE id IS NOT NULL"]) {
    try { vecs = v.prepare(q).get().c; break; } catch { /* 試下一個表名 */ }
  }
  const m = {
    made_at: new Date().toISOString(), tenant: process.env.TENANT,
    entries: db.prepare('SELECT count(*) c FROM entries').get().c,
    templates: db.prepare('SELECT count(*) c FROM templates').get().c,
    by_entry_type: by, vectors: vecs,
    user_version: db.prepare('PRAGMA user_version').get().user_version,
    filter: JSON.parse(fs.readFileSync(`${o}/filter.json`, 'utf8')),
    sha256: { 'kbdb.sqlite': sha(`${o}/kbdb.sqlite`), 'vectors.sqlite': sha(`${o}/vectors.sqlite`) },
  };
  fs.writeFileSync(`${o}/MANIFEST.json`, JSON.stringify(m, null, 2));
  console.log(JSON.stringify({ entries: m.entries, templates: m.templates, vectors: m.vectors, user_version: m.user_version }));
}
