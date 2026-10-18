// inkstone/arcrun-rag#267（母票 inkstone/Arcrun#297）：
// rag_entity_concept 每張卡為了「找相關概念」而讀的資料量，只能跟這張卡自己的 entity 有關，
// 不能跟庫的大小、也不能跟熱門名詞的成員數有關。
//
// 守的事：
//   1. 沒有任何請求是「撈整個庫」的形狀（field=library／全租戶 description／limit>100 的目錄）。
//      http_request 零件單次只收 64 KiB（約 170 筆三元組），超過整顆 trap（response-size-cap.test.mjs）。
//   2. 查詢鍵是「只屬於這個 entity」的記號（source_uri＝entity-desc://… ／ entity-concept://…），
//      不是 field=subject——熱門名詞當 subject 查一樣要把它所有同內容值格讀一遍（量過，見 lookup 檔頭）。
//      field=subject 只在舊資料退路（記號查不到）才用。
//   3. 判準沒變：has_desc 跨庫、in_lib_concept 限本庫、概念目錄含這幾個 entity 自己的既有概念。
//      用一個「世界」的 oracle（直接掃全部三元組）對照「經過 lookup 的新作法」，逐 entity 必須一致。
//   4. 查不到結論的 entity 這次不處理（不當成「沒有 description」去重寫）。
//   5. 寫入端有蓋記號，且記號的寫法與查詢端的寫法是同一個字串。
//
// 跑法：node --test workflows/tests/entity-concept-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codeOf } from './_yaml-code.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const conceptYaml = read('workflows/rag-entity-concept.local.yaml');
const lookupYaml = read('workflows/rag-entity-lookup.local.yaml');

const prepLookup = new Function('input', codeOf(lookupYaml, 'prep_lookup'));
const decide = new Function('input', codeOf(lookupYaml, 'decide'));
const mergeLegacy = new Function('input', codeOf(lookupYaml, 'merge_legacy'));
const prepLlm = new Function('input', codeOf(conceptYaml, 'prep_llm'));

const flowOf = (y) => [...y.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
const urlsOf = (y) => [...y.matchAll(/^\s*url:\s*"([^"]+)"/gm)].map((m) => m[1]);
const nodeUrl = (y, node) => y.match(new RegExp('  ' + node + ':[\\s\\S]*?url:\\s*"([^"]+)"'))[1];

// ── 1. 請求形狀 ──────────────────────────────────────────────────────────────
test('rag_entity_concept：不再有撈整個庫的請求', () => {
  const urls = urlsOf(conceptYaml);
  assert.ok(urls.length >= 2, '至少 fetch_lookup 與 fetch_global_concepts');
  for (const u of urls) {
    assert.ok(!/field=library/.test(u), `不得再用 field=library 撈整個子庫：${u}`);
    assert.ok(!/value=description/.test(u), `不得再撈全租戶 description：${u}`);
  }
  assert.ok(!/fetch_lib_triplets|fetch_global_desc/.test(conceptYaml.replace(/^\s*#.*$/gm, '')), '舊的兩個整庫節點要移除');
});

test('rag_entity_concept：每個 by-template 清單請求 limit ≤ 100（64 KiB 天花板）', () => {
  for (const u of urlsOf(conceptYaml).filter((x) => /by-template/.test(x))) {
    const m = u.match(/[?&]limit=(\d+)/);
    assert.ok(m, `要帶 limit：${u}`);
    assert.ok(Number(m[1]) <= 100, `limit=${m[1]} 超過 100：${u}`);
  }
});

test('rag_entity_lookup：主路徑用 source_uri 記號查（常數成本），field=subject 只在退路', () => {
  assert.match(nodeUrl(lookupYaml, 'fetch_desc_marker'), /field=source_uri&value=\{\{entity_item\.desc_q\}\}/);
  assert.match(nodeUrl(lookupYaml, 'fetch_concept_marker'), /field=source_uri&value=\{\{entity_item\.concept_q\}\}/);
  assert.match(nodeUrl(lookupYaml, 'fetch_legacy'), /field=subject&value=\{\{entity_item\.enc\}\}/);
  // 只有 fetch_legacy 一個節點用 field=subject
  assert.equal(urlsOf(lookupYaml).filter((u) => /field=subject/.test(u)).length, 1);
  for (const u of urlsOf(lookupYaml)) assert.ok(Number(u.match(/limit=(\d+)/)[1]) <= 80, u);
});

test('rag_entity_lookup：FOREACH 是 prep_lookup 唯一的出邊（results 才會成為回應）、有並行上限', () => {
  const flow = flowOf(lookupYaml);
  assert.deepEqual(flow.filter((x) => x.startsWith('prep_lookup >>')), ['prep_lookup >> 對每個 entity_item 並行 6 >> fetch_desc_marker']);
  assert.equal(flow.filter((x) => /對每個/.test(x)).length, 1);
});

test('rag_entity_lookup：每個查詢節點都有 ON_FAIL 接住（單一 entity 失敗不拖垮整支）', () => {
  const flow = flowOf(lookupYaml);
  for (const n of ['fetch_desc_marker', 'fetch_concept_marker', 'fetch_legacy']) {
    assert.ok(flow.includes(`${n} >> ON_FAIL >> item_failed`), `${n} 缺 ON_FAIL`);
  }
});

test('rag_entity_concept 不靠 FOREACH 的兄弟邊拿 results（引擎 #263 後那條路是壞的）', () => {
  const flow = flowOf(conceptYaml);
  assert.ok(flow.includes('input >> ON_SUCCESS >> fetch_lookup'));
  assert.ok(!flow.some((x) => /\.results|對每個 entity/.test(x)));
});

test('寫入端蓋的記號與查詢端是同一個字串格式', () => {
  assert.match(conceptYaml, /source_uri: "entity-desc:\/\/\{\{desc_item\.entity\}\}"/);
  assert.match(conceptYaml, /source_uri: "entity-concept:\/\/\{\{concept_item\.entity\}\}"/);
  const code = codeOf(lookupYaml, 'prep_lookup');
  assert.match(code, /encodeURIComponent\('entity-desc:\/\/' \+ e\)/);
  assert.match(code, /encodeURIComponent\('entity-concept:\/\/' \+ e\)/);
});

for (const f of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
  test(`${f}：預編圖已帶 rag_entity_lookup、concept 圖已換新`, () => {
    const list = JSON.parse(read(f));
    const lk = list.find((w) => w.name === 'rag_entity_lookup');
    assert.ok(lk, '找不到 rag_entity_lookup');
    const fe = lk.graph.edges.find((e) => e.type === 'FOREACH');
    assert.equal(fe.iterator, 'entity_item');
    assert.equal(fe.concurrency, 6);
    assert.ok(lk.graph.edges.some((e) => e.type === 'ON_TRUE' && e.from === 'decide' && e.to === 'fetch_legacy'));
    const ec = list.find((w) => w.name === 'rag_entity_concept');
    const ids = ec.graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('fetch_lookup'));
    assert.ok(!ids.includes('fetch_lib_triplets') && !ids.includes('fetch_global_desc'));
    assert.match(ec.config.fetch_lookup.url, /rag_entity_lookup\/query/);
    assert.match(ec.config.post_description.body_json.values.source_uri, /^entity-desc:\/\//);
    assert.match(ec.config.post_concept.body_json.values.source_uri, /^entity-concept:\/\//);
    assert.deepEqual(lk.placeholders.slice().sort(), ['__CODE_URL__', '__HTTP_REQ_URL__', '__KBDB_BASE__', '__NAMESPACE__']);
  });
}

// ── 2. 判準對照：世界的 oracle vs 經過 lookup 的新作法 ───────────────────────
// 模擬 KBDB 的欄位過濾：GET /records/by-template/triplet?field=F&value=V&limit=L
//   → 該欄位等於 V 的三元組，新到舊；頁滿時 total ＝ limit+1（誠實下界），否則精確。
function kbdbQuery(world, field, value, limit) {
  const hits = world.filter((r) => r[field] === value).reverse(); // world 越後面越新
  const page = hits.slice(0, limit);
  const total = hits.length > limit ? limit + 1 : hits.length;
  return { success: true, records: page.map((r) => ({ id: 'r', values: r })), count: page.length, total, total_exact: hits.length <= limit };
}

// 照 lookup 的 flow 跑一個 entity：兩個記號查詢 → decide →（branch=true）→ 退路查詢 → merge。
// stats 記下每個 entity 發了哪些請求，測「請求數只跟 entity 數有關」。
function runLookup(world, entitiesJson, library, stats = []) {
  const prep = prepLookup({ entities_raw: entitiesJson, library });
  const results = prep.entity_items.map((item) => {
    const q = { desc: decodeURIComponent(item.desc_q), concept: decodeURIComponent(item.concept_q), subject: decodeURIComponent(item.enc) };
    const dBody = JSON.stringify(kbdbQuery(world, 'source_uri', q.desc, 20));
    const cBody = JSON.stringify(kbdbQuery(world, 'source_uri', q.concept, 50));
    stats.push({ entity: item.entity, kind: 'marker' }, { entity: item.entity, kind: 'marker' });
    const d = decide({ desc_body: dBody, concept_body: cBody, entity: item.entity, library: item.library });
    if (d.branch !== 'true') return { success: true, data: d };
    stats.push({ entity: item.entity, kind: 'legacy' });
    const lBody = JSON.stringify(kbdbQuery(world, 'subject', q.subject, 80));
    return { success: true, data: mergeLegacy({ base: d, legacy_body: lBody, entity: item.entity, library: item.library }) };
  });
  return { success: true, data: { entity_count: prep.entity_count }, results };
}

function newPath(world, entities, library, directoryWindow = 100) {
  const lookup = runLookup(world, JSON.stringify(entities), library);
  const concepts = world.filter((r) => r.predicate === '屬於').reverse().slice(0, directoryWindow);
  return prepLlm({
    entities_raw: JSON.stringify(entities),
    card_content: '卡',
    library,
    lookup_body: JSON.stringify(lookup),
    global_concepts_body: JSON.stringify({ records: concepts.map((r) => ({ values: r })) }),
  });
}

// oracle：就是原本「撈整個庫再比對」想表達的判準（本庫有沒有屬於／任何庫有沒有 description）。
function oracle(world, entities, library) {
  const flags = {};
  for (const e of entities) {
    const needsDesc = !world.some((r) => r.subject === e && r.predicate === 'description');
    const needsConcept = !world.some((r) => r.subject === e && r.predicate === '屬於' && r.object && r.library === library);
    if (needsDesc || needsConcept) flags[e] = { needsDesc, needsConcept };
  }
  return flags;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// 世界：一部分 entity 的資料是新格式（帶記號），一部分是舊格式（沒有記號）——兩種都要判對。
function makeWorld(seed, nEntities, nLibs) {
  const r = rng(seed);
  const world = [];
  const libs = Array.from({ length: nLibs }, (_, i) => `lib${i}`);
  const concepts = ['科技公司執行長', '錯誤碼', '電動車廠', '資料庫'];
  for (let i = 0; i < nEntities; i++) {
    const e = `實體${i}`;
    const marked = r() < 0.6;
    for (const lib of libs) {
      if (r() < 0.5) world.push({ subject: e, predicate: 'description', object: `${e}的描述`, library: lib, ...(marked ? { source_uri: `entity-desc://${e}` } : {}) });
      if (r() < 0.5) world.push({ subject: e, predicate: '屬於', object: concepts[Math.floor(r() * concepts.length)], library: lib, ...(marked ? { source_uri: `entity-concept://${e}` } : {}) });
      for (let k = 0; k < Math.floor(r() * 4); k++) world.push({ subject: e, predicate: '提及', object: `x${k}`, library: lib, source_uri: 'kb://card.md' });
    }
  }
  return { world, libs };
}

test('新作法與 oracle 逐 entity 一致（新舊兩種資料格式、跨庫 description、本庫 membership）', () => {
  let compared = 0;
  for (const seed of [1, 7, 42, 2026, 99, 123]) {
    const { world, libs } = makeWorld(seed, 40, 3);
    const entities = [...new Set(Array.from({ length: 15 }, (_, i) => `實體${(i * 2 + seed) % 45}`))]; // 含不存在的 entity
    for (const lib of libs) {
      const want = oracle(world, entities, lib);
      if (Object.keys(want).length === 0) continue;
      const got = newPath(world, entities, lib);
      assert.deepEqual(JSON.parse(got.flags_json), want, `seed=${seed} ${lib}`);
      assert.deepEqual(JSON.parse(got.todo_json), Object.keys(want));
      compared++;
    }
  }
  assert.ok(compared >= 10, '比對不能空轉');
});

test('全都處理過 → 照舊丟 ALL_ALREADY_DESCRIBED（沒事做，不是失敗紀錄）', () => {
  const world = [
    { subject: 'A', predicate: 'description', object: 'a', library: 'kb', source_uri: 'entity-desc://A' },
    { subject: 'A', predicate: '屬於', object: 'C', library: 'kb', source_uri: 'entity-concept://A' },
  ];
  assert.throws(() => newPath(world, ['A'], 'kb'), /ALL_ALREADY_DESCRIBED/);
});

test('舊資料（沒有記號）也算已存在：不重寫 description、不重新歸類', () => {
  const world = [
    { subject: 'A', predicate: 'description', object: 'a', library: 'kb' },
    { subject: 'A', predicate: '屬於', object: 'C', library: 'kb' },
  ];
  assert.throws(() => newPath(world, ['A'], 'kb'), /ALL_ALREADY_DESCRIBED/);
});

test('概念目錄含這幾個 entity 自己已歸入的概念（即使不在最新視窗裡）', () => {
  // 'A' 在別的庫歸入「老概念」，之後塞滿 150 筆別的「屬於」把它擠出最新 100 筆視窗
  const world = [{ subject: 'A', predicate: '屬於', object: '老概念', library: 'other', source_uri: 'entity-concept://A' }];
  for (let i = 0; i < 150; i++) world.push({ subject: `m${i}`, predicate: '屬於', object: `新概念${i % 5}`, library: 'kb' });
  const got = newPath(world, ['A'], 'kb');
  assert.match(got.concept_directory, /「老概念」/, 'A 自己的既有概念要在目錄裡，LLM 才會照抄而不是另取同義詞');
  assert.match(got.concept_directory, /「新概念0」/);
  assert.deepEqual(JSON.parse(got.flags_json), { A: { needsDesc: true, needsConcept: true } });
});

test('概念目錄是有界視窗：庫裡有 5000 筆「屬於」，目錄最多 100 筆的成員', () => {
  const world = [];
  for (let i = 0; i < 5000; i++) world.push({ subject: `m${i}`, predicate: '屬於', object: `概念${i}`, library: 'kb' });
  const got = newPath(world, ['新人'], 'kb');
  assert.equal(got.concept_directory.split('\n').length, 100);
});

// ── 3. 成本：請求數只跟這張卡的 entity 數有關 ────────────────────────────────
test('已有記號的 entity：每個只發 2 個記號查詢，不走 field=subject 退路（熱門名詞也一樣）', () => {
  const world = [];
  const hot = ['錯誤碼', 'NC Error Messages', 'M150'];
  for (const h of hot) {
    world.push({ subject: h, predicate: 'description', object: `${h}的描述`, library: 'kb', source_uri: `entity-desc://${h}` });
    world.push({ subject: h, predicate: '屬於', object: '主題', library: 'kb', source_uri: `entity-concept://${h}` });
  }
  // 5000 張卡都把這三個熱門名詞當 object 指著
  for (let i = 0; i < 5000; i++) for (const h of hot) world.push({ subject: `卡${i}`, predicate: '整理出', object: h, library: 'kb', source_uri: `kb://c${i}.md` });
  const stats = [];
  const out = runLookup(world, JSON.stringify(hot.map((h) => `[[${h}]]`)), 'kb', stats);
  assert.equal(stats.filter((s) => s.kind === 'legacy').length, 0, '都有記號 ⇒ 不該走退路');
  assert.equal(stats.length, hot.length * 2);
  assert.ok(out.results.every((r) => r.data.has_desc && r.data.in_lib_concept));
});

test('新 entity（記號查不到）才走一次 field=subject 退路', () => {
  const stats = [];
  runLookup([], JSON.stringify(['新A', '新B']), 'kb', stats);
  assert.equal(stats.filter((s) => s.kind === 'legacy').length, 2);
});

test('熱門主詞的舊資料（超過 80 筆）：標 truncated，最壞只是多寫 description，不會漏寫、不會拋錯', () => {
  const world = [{ subject: '熱門', predicate: 'description', object: '舊描述', library: 'a' }];
  for (let i = 0; i < 200; i++) world.push({ subject: '熱門', predicate: '包含', object: `x${i}`, library: 'a' });
  const lookup = runLookup(world, JSON.stringify(['熱門']), 'a');
  assert.equal(lookup.results[0].data.truncated, true);
  const got = newPath(world, ['熱門'], 'a');
  assert.equal(got.lookup_truncated, 1);
  assert.deepEqual(JSON.parse(got.flags_json), { 熱門: { needsDesc: true, needsConcept: true } });
});

// ── 4. 查詢失敗 ≠ 沒有 ───────────────────────────────────────────────────────
test('某個 entity 的查詢失敗（item_failed）→ 這次不處理它，不當成沒有 description', () => {
  const lookup = {
    results: [
      { success: true, data: { entity: 'A', has_desc: false, in_lib_concept: false, concepts: [], truncated: false, seen: 0 } },
      { success: true, data: { failed: true, failed_entity: 'B' } }, // item_failed 的輸出：沒有 entity
    ],
  };
  const got = prepLlm({
    entities_raw: JSON.stringify(['A', 'B']), card_content: 'c', library: 'kb',
    lookup_body: JSON.stringify(lookup), global_concepts_body: JSON.stringify({ records: [] }),
  });
  assert.deepEqual(JSON.parse(got.todo_json), ['A']);
  assert.equal(got.lookup_unresolved, 1);
});

test('全部 entity 都查詢失敗 → 明講沒有結論（不是「都處理過了」）', () => {
  const lookup = { results: [{ success: true, data: { failed: true, failed_entity: 'A' } }] };
  assert.throws(() => prepLlm({
    entities_raw: JSON.stringify(['A']), card_content: 'c', library: 'kb',
    lookup_body: JSON.stringify(lookup), global_concepts_body: JSON.stringify({ records: [] }),
  }), /LOOKUP_NO_CONCLUSION/);
});

test('lookup 回應讀不出 results → 如實失敗，不猜', () => {
  for (const bad of ['', 'not json', JSON.stringify({ success: false })]) {
    assert.throws(() => prepLlm({
      entities_raw: JSON.stringify(['A']), card_content: 'c', library: 'kb',
      lookup_body: bad, global_concepts_body: JSON.stringify({ records: [] }),
    }), /LOOKUP_UNREADABLE/);
  }
});

// ── 5. 名字收斂：KBDB 寫入時會把 [[X]] 之類收斂，查詢不會 ─────────────────────
// 真實的卡片「## 關聯」段寫的是 `- [[A]] >> 整理出 >> [[M150]]`；prep_entity_concept 原樣取出，
// 所以 entities_json 裡是 `[[M150]]`。KBDB 存的 subject 卻是 `M150`（canonicalEntity）。
// 不收斂就查：永遠查不到 ⇒ 永遠判成「沒有 description」⇒ 每張卡都重寫一次。
// 向量取自 matrix/arcrun kbdb/src/actions/entity-canon.ts 的規則（檔頭①②③④）。
const CANON_VECTORS = [
  ['[[M150]]', 'M150'],
  ['`foo`', 'foo'],
  ['  A   B  ', 'A B'],
  ['[[160-012F (2／2)]]', '160-012F (2／2)'],
  ['[[NC軟體（160-012F (2／2)）]]', 'NC軟體（160-012F (2／2)）'],
  ['error_codes/160-012F_002.md', '160-012F_002'],
  ['[[dir/Note.md]]', 'Note'],
  ['資料夾：InkStoneCo/system-dev/wiki/cards', '資料夾：InkStoneCo/system-dev/wiki/cards'], // 沒有筆記副檔名＝不當路徑拆
  ['[[a [[b]] c]]', '[[a [[b]] c]]'],                                                        // 裡面還有包裝＝不剝
  ['[[]]', '[[]]'],
  ['', ''],
];

test('名字收斂與 KBDB canonicalEntity 同一份規則（向量）', () => {
  for (const [raw, want] of CANON_VECTORS) {
    const out = prepLookup({ entities_raw: JSON.stringify([raw, 'pad']), library: 'kb' });
    const got = out.entity_items.map((i) => i.entity);
    if (want === '') assert.deepEqual(got, ['pad'], `空字串要被濾掉：${JSON.stringify(raw)}`);
    else assert.equal(got[0], want, `${JSON.stringify(raw)} → ${JSON.stringify(got[0])}（要 ${JSON.stringify(want)}）`);
  }
});

test('卡片裡帶 [[ ]] 的 entity：查詢值與比對都用收斂後的名字，查得到已存在的 description', () => {
  // 世界裡存的是 KBDB 收斂後的 subject
  const world = [
    { subject: 'M150', predicate: 'description', object: '某型號', library: 'other', source_uri: 'entity-desc://M150' },
    { subject: 'M150', predicate: '屬於', object: '機型', library: 'kb', source_uri: 'entity-concept://M150' },
  ];
  const entities = ['[[M150]]', '[[新東西]]'];
  const prep = prepLookup({ entities_raw: JSON.stringify(entities), library: 'kb' });
  assert.equal(prep.entity_items[0].enc, 'M150');
  assert.equal(decodeURIComponent(prep.entity_items[0].desc_q), 'entity-desc://M150');
  const got = newPath(world, entities, 'kb');
  assert.deepEqual(JSON.parse(got.flags_json), { 新東西: { needsDesc: true, needsConcept: true } }, 'M150 已有 description 與本庫歸類，不得再被排進待辦');
});

test('prep_lookup：entity 去重（[[X]]、X、`X` 算一個）、濾掉 knowledge-base、名稱含 & # / 時 URL 編碼正確', () => {
  const out = prepLookup({ entities_raw: JSON.stringify(['[[X]]', 'X', '`X`', 'knowledge-base', 'x&y#z/w', '']), library: 'kb' });
  assert.deepEqual(out.entity_items.map((i) => i.entity), ['X', 'x&y#z/w']);
  assert.equal(out.entity_items[1].enc, 'x%26y%23z%2Fw');
  assert.equal(decodeURIComponent(out.entity_items[1].concept_q), 'entity-concept://x&y#z/w');
  assert.throws(() => prepLookup({ entities_raw: '[]', library: 'kb' }), /沒有可查的 entity/);
});
