// inkstone/arcrun-rag#273 同類：rag-ingest*.yaml 的頁名進 URL query 必先編碼。
// 跑真的 collect_changed 程式碼（不抄一份），並檢查 list_* 節點的 URL 都吃 *_enc。
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';
let pass = 0, fail = 0;
const t = (l, c, e = '') => { c ? (console.log('PASS:', l), pass++) : (console.log('FAIL:', l, e), fail++); };
const evil = 'notes/Rotor-1250MT+K2SA & 報銷#1.md';
for (const f of ['rag-ingest.yaml', 'rag-ingest-cards.local.yaml']) {
  const y = fs.readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
  const code = codeOf(y, 'collect_changed').replace(/__CARDS_PREFIX__/g, 'system-dev/wiki/cards/');
  const run = new Function('input', code);
  const prefix = f === 'rag-ingest-cards.local.yaml' ? 'system-dev/wiki/cards/' : '';
  const p = prefix + evil;
  const r = run({ schema_version: '1', folder_id: 'x', events: [
    { type: 'removed', path: p },
    { type: 'renamed', old_path: p, path: p.replace('notes/', 'n2/') },
  ] });
  const rm = (r.removed_files || [])[0], rn = (r.renamed_files || [])[0];
  t(`${f} removed 有 page_name_enc`, rm && rm.page_name_enc === encodeURIComponent(rm.page_name), JSON.stringify(rm));
  t(`${f} removed enc 不含 + & # 空白`, rm && !/[+&# ]/.test(rm.page_name_enc));
  t(`${f} renamed 有 page_name_old_enc`, rn && rn.page_name_old_enc === encodeURIComponent(rn.page_name_old), JSON.stringify(rn));
  const urls = [...y.matchAll(/url: "__KBDB_BASE__\/entries\?page_name=([^&"]*)&/g)].map(m => m[1]);
  t(`${f} 所有 entries 查詢的 page_name 都用 *_enc`, urls.length > 0 && urls.every(u => /_enc\}\}$/.test(u)), urls.join(' | '));
  if (f === 'rag-ingest.yaml') {
    t('rag-ingest wiki 頁名也編碼', rm.wiki_page_enc === encodeURIComponent(rm.wiki_page) && rn.wiki_page_old_enc === encodeURIComponent(rn.wiki_page_old));
  }
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
