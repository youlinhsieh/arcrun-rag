// graph-neighbors-node-lookup.test.mjs — inkstone/Arcrun#168：
// 圖譜鄰居查詢不准再「撈全表最新 N 筆再自己 BFS」，而且節點名進 URL 前一定要編碼。
//
// 這支守的是**兩個各自出過事的形狀**，不是守實作寫法：
//
//   ① 撈全表：`GET /records/by-template/triplet?...&limit=N` 只回「這個租戶最新 N 筆」
//      ⇒ 三元組越寫越多，越舊的實體越先被擠出視窗（實測：226 筆時 7/28 寫的那三條
//      排名 99/100/101，卡在 limit=100 門檻上）。調大 limit 已被真資料證偽——
//      226 筆打包成 http_request 零件的輸出形狀就已 68,387 bytes，超過 65,536 的 cap。
//      ⇒ 這支斷言「這條 workflow 不准再打那條路由」。它是**方向閘**：
//        下一個人若因為「查不到」而想把 limit 調大，會先撞到這裡。
//
//   ② 節點名沒編碼就塞進 URL 路徑：卡片標題含 `#` 時，`#` 是 URL 片段起點
//      ⇒ 後半整段（含 query string 的 owner_id）被截掉 ⇒ 症狀同樣是「查不到」。
//      本 repo 已經為同一個病立過慣例（rag_takedown_direct 的 `prep.page_enc`，
//      agent-memory §7），這支確保圖譜這條也守著它。
//
// 不打任何雲端：直接從 YAML 抽出 `prep` 節點的**真實那段 code** 來跑（照
// takedown-scope.test.mjs／isdoc.test.mjs 的既有做法，不抄第二份到測試裡）。
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const files = {
  'graph-neighbors.yaml': fs.readFileSync(new URL('../graph-neighbors.yaml', import.meta.url).pathname, 'utf8'),
  'graph-neighbors.local.yaml': fs.readFileSync(new URL('../graph-neighbors.local.yaml', import.meta.url).pathname, 'utf8'),
};

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

// 只看 `url:` 那幾行，避免命中檔頭那段解釋舊做法的註解。
const urlLines = (y) => y.split('\n').filter((l) => /^\s*url:\s*"/.test(l)).map((l) => l.trim());

for (const [name, y] of Object.entries(files)) {
  const urls = urlLines(y);
  t(`${name} 有 url 節點`, urls.length === 1, JSON.stringify(urls));

  const url = urls[0] || '';
  t(`${name} 打的是 /graph/neighbors/:node（伺服器端依節點查）`, url.includes('/graph/neighbors/'), url);
  t(`${name} 不准再撈全表三元組（/records/by-template）`, !url.includes('/records/by-template'), url);
  t(`${name} 不准帶 limit（撈全表才需要它；帶了就是舊做法回來了）`, !/[?&]limit=/.test(url), url);
  t(`${name} 節點名走編碼過的值，不是原始 {{input.node}}`,
    url.includes('node_enc') && !url.includes('/graph/neighbors/{{input.node}}'), url);
}

// ── prep 的真實程式碼：兩份要行為一致，且該編碼的都編了 ──────────────────────
for (const [name, y] of Object.entries(files)) {
  const prep = new Function('input', codeOf(y, 'prep'));

  // 本票的回歸案例：`[[小果被AFTEE詐貸]]`（2026-07-28 收的那張卡）。
  {
    const r = prep({ node: '[[小果被AFTEE詐貸]]', depth: 1, template: 'triplet' });
    t(`${name} prep：AFTEE 那張卡編得出來`, r.success === true, JSON.stringify(r));
    t(`${name} prep：CJK 與中括號都被 percent-encode`,
      r.node_enc === encodeURIComponent('[[小果被AFTEE詐貸]]') && !/[一-鿿]/.test(r.node_enc), r.node_enc);
    // 組出真正會被 fetch 的那條 URL，確認 query string 沒有被吃掉。
    const u = new URL(`https://kbdb.example/graph/neighbors/${r.node_enc}?depth=${r.depth}&template=${r.template}&directed=${r.directed}&owner_id=ns1`);
    t(`${name} prep：組出的 URL 解得回原節點名`, decodeURIComponent(u.pathname.split('/').pop()) === '[[小果被AFTEE詐貸]]', u.pathname);
    t(`${name} prep：組出的 URL 仍帶得到 owner_id`, u.searchParams.get('owner_id') === 'ns1', u.search);
  }

  // 🔴 `#` 是這一步唯一非做不可的理由：沒編碼的話它會把後面整段切掉。
  {
    const r = prep({ node: 'AI 協作規範 #2', depth: 2, template: 'triplet' });
    const u = new URL(`https://kbdb.example/graph/neighbors/${r.node_enc}?depth=${r.depth}&owner_id=ns1`);
    t(`${name} prep：含 # 的節點名不會把 query string 切掉`, u.searchParams.get('owner_id') === 'ns1', u.href);
    t(`${name} prep：含 # 的節點名解得回原值`,
      decodeURIComponent(u.pathname.split('/').pop()) === 'AI 協作規範 #2', u.pathname);
    t(`${name} prep：hash 是空的（沒有被誤判成片段）`, u.hash === '', u.hash);
  }

  // 參數的界線：depth 夾在 1..10（與 KBDB 端 graphNeighbors 同一組界線），
  // template 缺省成 `triplet`（本產品實際部署的 triplet template 名）。
  {
    t(`${name} prep：depth 空值 → 1`, prep({ node: 'X' }).depth === '1');
    t(`${name} prep：depth 超過上限 → 夾成 10`, prep({ node: 'X', depth: 99 }).depth === '10');
    t(`${name} prep：depth 非數字 → 1`, prep({ node: 'X', depth: 'abc' }).depth === '1');
    t(`${name} prep：template 空值 → triplet`, prep({ node: 'X' }).template === 'triplet');
    t(`${name} prep：directed 只認字串 "true"`,
      prep({ node: 'X', directed: 'true' }).directed === 'true' && prep({ node: 'X', directed: 'yes' }).directed === 'false');
    const empty = prep({ node: '   ' });
    t(`${name} prep：node 空白 → 誠實回失敗，不去打一條註定 404 的 URL`, empty.success === false, JSON.stringify(empty));
  }
}

// ── parse_neighbors：http_request 的 body 是字串，一定要解一次 ────────────────
for (const [name, y] of Object.entries(files)) {
  const parse = new Function('input', codeOf(y, 'parse_neighbors'));
  const payload = { success: true, start: 'A', neighbors: [{ node: 'B', predicate: 'r', from: 'A', depth: 1 }], edges: [], count: 1 };
  t(`${name} parse：字串 body 解得開`, parse({ body: JSON.stringify(payload) }).count === 1);
  t(`${name} parse：已經是物件就原樣回`, parse({ body: payload }).count === 1);
  const bad = parse({ body: '<html>502</html>' });
  t(`${name} parse：非 JSON → 誠實回失敗，不假裝 0 鄰居`,
    bad.success === false && String(bad.error).includes('不是合法 JSON'), JSON.stringify(bad));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
