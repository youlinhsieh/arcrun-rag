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

// ── list_triplets（三元組怎麼撈）──────────────────────────────────────────
// 🔴 `InkStoneCo#138`（2026-09-20）：本票要達成的事**只有這一格看得到**——
//   撈三元組的成本必須跟「這張卡自己有幾筆」成正比，不能跟租戶三元組總數綁在一起。
//   下面那些 code 節點的測試怎麼綠，都證明不了這件事（它們拿到的是已經撈好的東西），
//   所以這一格直接釘住 YAML 裡那條 URL。
{
  const m = y.match(/\n {2}list_triplets:\n[\s\S]*?\n {4}url: "([^"]+)"/);
  const url = m ? m[1] : '';
  t('撈三元組走 by-source（按這張卡自己的來源取，不是撈全租戶再過濾）',
    url.indexOf('/records/by-source/triplet') >= 0, url);
  t('by-source 的鍵是 source_uri，值來自 prep 算好的 encodeURIComponent',
    url.indexOf('field=source_uri') >= 0 && url.indexOf('{{prep.data.src_uri_enc}}') >= 0, url);
  // 只看真的會發出去的 url:（註解裡引用舊端點是在說明歷史，不是行為——
  // 同 response-size-cap.test.mjs 對註解行的處置）。
  const liveUrls = y.split('\n').filter((l) => !/^\s*#/.test(l) && /^\s*url:\s*"/.test(l));
  t('不准再有任何 url 打 by-template（那條會讀三輪整張 sheet，且 limit=100 根本刪不乾淨）',
    liveUrls.every((l) => l.indexOf('/records/by-template/') < 0),
    JSON.stringify(liveUrls.filter((l) => l.indexOf('/records/by-template/') >= 0)));
}

// ── pick_dead_triplets（三元組）────────────────────────────────────────────
// 比對已經在**伺服器端**做完（by-source 用 source_uri 精確比對），這裡只把 id 攤平。
// 舊版在這裡做的 library／machine／subject 三道比對的去向，逐條寫在 YAML 節點註解上。
const recIds = (r) => r.dead_records.map((x) => x.record_id).sort();
{
  const r = pickDeadTriplets({ body: JSON.stringify({ record_ids: ['a', 'b'], count: 2, total: 2 }) });
  t('三元組：by-source 回來的 id 原樣成為刪除清單',
    JSON.stringify(recIds(r)) === '["a","b"]' && r.count === 2, JSON.stringify(r));
}
{
  // 這張卡本來就沒有三元組（或 template 不存在）⇒ 空集合，不可以炸掉整條鏈：
  // 這個節點一失敗，後面的 deprecate_triplet 全部不執行。
  const r = pickDeadTriplets({ body: JSON.stringify({ record_ids: [], count: 0, total: 0 }) });
  t('三元組：沒有命中就是空集合，不報錯', r.success === true && r.dead_records.length === 0, JSON.stringify(r));
  const r2 = pickDeadTriplets({ body: 'not json' });
  t('三元組：回應不是 JSON 也只是空集合（不整條鏈斷掉）',
    r2.success === true && r2.dead_records.length === 0, JSON.stringify(r2));
}
{
  // 一張卡的三元組破了單頁上限時，total 會比實拿的多。**不准靜默少刪**——
  // 要在輸出裡看得見，執行紀錄才說得出「這次沒刪乾淨」。
  const r = pickDeadTriplets({ body: JSON.stringify({ record_ids: ['a'], count: 1, total: 3 }) });
  t('三元組：拿不完時 truncated 要說出來（不靜默少刪）',
    r.truncated === true && r.total === 3, JSON.stringify(r));
  const r2 = pickDeadTriplets({ body: JSON.stringify({ record_ids: ['a', 'b'], count: 2, total: 2 }) });
  t('三元組：拿齊了就不亂報 truncated', r2.truncated === false, JSON.stringify(r2));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
