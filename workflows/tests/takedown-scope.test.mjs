// takedown-scope.test.mjs — arcrun-rag#46：撤除只准殺「這一份」，不准連坐。
//
// 為什麼要有這支：撤除的比對鍵是 (page_name, path)，而 path 是**相對於被監看資料夾**的
// 路徑。兩個被監看的資料夾各自放著 `notes.md` 時，兩邊的 page_name 與 path 完全相同
// ⇒ 移除其中一個會把另一個還在用的一起殺掉。巢狀資料夾（A 與 A/sub 同時被看守）
// 是同一個病的另一種形狀。修法＝把逐資料夾導出的 library 當第二把鍵。
//
// 這支測的是 workflow 裡兩個 code 節點的比對規則本身（照 isdoc.test.mjs 的做法，
// 直接從 YAML 抽出程式碼跑），不打任何雲端。
import fs from 'node:fs';

const y = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');

// 從 YAML 抽出某個節點的 code: | 區塊（縮排 6 空格的那一段）。
function codeOf(node) {
  const re = new RegExp(`\\n  ${node}:\\n[\\s\\S]*?\\n    code: \\|\\n([\\s\\S]*?)\\n    input:`);
  const m = y.match(re);
  if (!m) throw new Error(`抽不到 ${node} 的 code`);
  return m[1].replace(/^ {6}/gm, '');
}
const buildDeprecations = new Function('input', codeOf('build_deprecations'));
const pickDeadTriplets = new Function('input', codeOf('pick_dead_triplets'));

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

const block = (id, path, library) => ({
  id,
  metadata_json: JSON.stringify({ source: `kb://${path}#0`, source_path: path, library, embed: true }),
});
const idsOf = (r) => r.dead_entries.map((e) => e.id).sort();

// ── build_deprecations（blocks）────────────────────────────────────────────
{
  // 🔴 本票的核心情境：兩個資料夾各有 notes.md，page_name 與相對 path 完全相同。
  const blocks = [block('gone', 'notes.md', 'gone_folder'), block('keep', 'notes.md', 'keep_folder')];
  const r = buildDeprecations({
    blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md', library: 'gone_folder',
  });
  t('同名同路徑：只殺被移除那個資料夾的', JSON.stringify(idsOf(r)) === '["gone"]', JSON.stringify(idsOf(r)));
}
{
  // 巢狀：A 與 A/sub 同時被看守，同一個實體檔在兩邊的相對路徑不同——
  // 光靠 path 就分得開了，但 library 也不該把該殺的擋掉。
  const blocks = [block('outer', 'sub/notes.md', 'outer'), block('inner', 'notes.md', 'inner')];
  const r = buildDeprecations({
    blocks_body: JSON.stringify({ entries: blocks }), path: 'sub/notes.md', library: 'outer',
  });
  t('巢狀：只殺外層那份', JSON.stringify(idsOf(r)) === '["outer"]', JSON.stringify(idsOf(r)));
}
{
  // 向後相容 A：舊版 daemon 不送 library ⇒ 行為與從前一字不差（只看 path）。
  const blocks = [block('a', 'notes.md', 'lib_a'), block('b', 'other.md', 'lib_b')];
  const r = buildDeprecations({ blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md', library: '' });
  t('payload 沒帶 library：退回只看 path 的舊行為', JSON.stringify(idsOf(r)) === '["a"]', JSON.stringify(idsOf(r)));
}
{
  // 向後相容 B：卡上沒有 library（改版前寫進去的舊資料）⇒ 不可以因此撤不掉。
  const blocks = [{ id: 'old', metadata_json: JSON.stringify({ source_path: 'notes.md' }) }];
  const r = buildDeprecations({ blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md', library: 'anything' });
  t('舊資料沒有 library：照樣撤得掉（不能變成撤不掉）', JSON.stringify(idsOf(r)) === '["old"]', JSON.stringify(idsOf(r)));
}
{
  // 完全沒有來源資訊的老資料，維持既有的 fallback（本清單已按 page_name 查過）。
  const blocks = [{ id: 'ancient' }];
  const r = buildDeprecations({ blocks_body: JSON.stringify({ entries: blocks }), path: 'notes.md', library: 'x' });
  t('無 source 的老資料：維持 page_name fallback', JSON.stringify(idsOf(r)) === '["ancient"]', JSON.stringify(idsOf(r)));
}

// ── pick_dead_triplets（三元組）────────────────────────────────────────────
const rec = (id, srcUri, library, subject) => ({
  record_id: id, values: { source_uri: srcUri, library, subject },
});
const recIds = (r) => r.dead_records.map((x) => x.record_id).sort();
{
  // 同名同路徑 ⇒ source_uri 也完全相同，library 是唯一分得開的那一維。
  const records = [
    rec('gone', 'kb://notes.md', 'gone_folder', 'notes'),
    rec('keep', 'kb://notes.md', 'keep_folder', 'notes'),
  ];
  const r = pickDeadTriplets({
    body: JSON.stringify({ records }), page_name: 'notes',
    source_uri: 'kb://notes.md', library: 'gone_folder',
  });
  t('三元組：同 source_uri 只殺對的庫', JSON.stringify(recIds(r)) === '["gone"]', JSON.stringify(recIds(r)));
}
{
  // 2026-08-16 那次修的規則不可以被本次改動弄壞：有 source_uri 就只認精確比對，
  // 不因為 subject 等於頁名就殺掉別條路徑的三元組。
  const records = [rec('other-path', 'kb://moved/notes.md', 'gone_folder', 'notes')];
  const r = pickDeadTriplets({
    body: JSON.stringify({ records }), page_name: 'notes',
    source_uri: 'kb://notes.md', library: 'gone_folder',
  });
  t('三元組：有 source_uri 時不吃 subject 寬鬆比對（守 08-16 的修正）',
    r.dead_records.length === 0, JSON.stringify(recIds(r)));
}
{
  // 沒有 source_uri 的舊三元組：維持 subject fallback（G9 的初衷）。
  const records = [{ record_id: 'old', values: { subject: 'notes' } }];
  const r = pickDeadTriplets({
    body: JSON.stringify({ records }), page_name: 'notes',
    source_uri: 'kb://notes.md', library: 'gone_folder',
  });
  t('三元組：無 source_uri 維持 subject fallback', JSON.stringify(recIds(r)) === '["old"]', JSON.stringify(recIds(r)));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
