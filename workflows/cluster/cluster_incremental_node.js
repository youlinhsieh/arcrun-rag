// inkstone/arcrun-rag#13 → milestone 73 R4：持久索引版分群（取代 O(n^2) 全對全批次跑法）。
//
// 設計對齊 proposal §4 place_card 的精神：新項目只跟「既有群的代表向量」比對，
// 不跟「既有全部個別項目」比對。群數 m 遠小於項目數 n（且成長速度遠慢於 n），
// 所以整體複雜度是 O(n*m)，不是 O(n^2)。這解決的是 8064347 那次撞到的真限制：
// 500-tick 預算讓全對全在 n≈290 就爆——這次改法在單次呼叫裡處理全部 343 張不必切批。
//
// 正式生產型態：這支應該被拆成「單張新項目 + 讀回 KBDB 裡的既有群摘要」，由開票事件觸發，
// 每次呼叫只處理 1 張、只讀 m 個群摘要（見 README「還沒做」段）。這次先在單一呼叫內
// 用「依序處理」模擬那個 O(n*m) 特性，證明複雜度確實可以脫離 n^2，還沒接 KBDB 持久化。
const items = Array.isArray(input.items) ? input.items : [];
const simThreshold = Number(input.sim_threshold || 0.22);
const sizeCap = Number(input.size_cap || 8);

function tokenize(text) {
  text = String(text || '').replace(/[`*_#>\[\]\(\)\{\}\|]/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase();
  const tokens = [];
  const asciiMatches = text.match(/[a-z0-9][a-z0-9\-_/#]{1,}/g) || [];
  for (const w of asciiMatches) tokens.push(w);
  const cjkRuns = text.match(/[一-鿿]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function buildTfidf(docsTokens, maxDfRatio) {
  const df = new Map();
  const docTf = [];
  for (const toks of docsTokens) {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    docTf.push(tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = docsTokens.length;
  const maxDf = Math.max(2, Math.floor(n * maxDfRatio));
  const idf = new Map();
  for (const [t, c] of df.entries()) if (c <= maxDf) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  const vecs = [];
  for (const tf of docTf) {
    const total = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;
    const v = new Map();
    for (const [t, c] of tf.entries()) {
      if (!idf.has(t)) continue;
      v.set(t, (c / total) * idf.get(t));
    }
    let norm = 0;
    for (const x of v.values()) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (const t of v.keys()) v.set(t, v.get(t) / norm);
    vecs.push(v);
  }
  return vecs;
}

function cosine(a, b) {
  if (a.size > b.size) { const t = a; a = b; b = t; }
  let s = 0;
  for (const [t, w] of a.entries()) if (b.has(t)) s += w * b.get(t);
  return s;
}

function labelBonus(la, lb) {
  if (!la || !lb || !la.length || !lb.length) return 0;
  const setB = new Set(lb);
  const inter = la.filter(x => setB.has(x));
  if (!inter.length) return 0;
  const meaningful = inter.filter(l => !String(l).startsWith('s/'));
  return meaningful.length ? 0.15 : 0;
}

// centroid = 群內成員向量的加總（不除以 size，cosine 前用 size 正規化即可，省一次除法迴圈）
function addToCentroid(centroid, vec) {
  for (const [t, w] of vec.entries()) centroid.set(t, (centroid.get(t) || 0) + w);
}
function cosineToCentroid(vec, centroid, size) {
  if (size <= 0) return 0;
  let s = 0;
  for (const [t, w] of vec.entries()) if (centroid.has(t)) s += w * centroid.get(t);
  const centroidNorm = Math.sqrt(Array.from(centroid.values()).reduce((a, x) => a + x * x, 0)) / size || 1;
  return s / size / centroidNorm;
}

const texts = items.map(it => `${it.title || ''} ${(it.labels || []).join(' ')}`);
const labelsList = items.map(it => it.labels || []);
const tokensPerDoc = texts.map(tokenize);
const vecs = buildTfidf(tokensPerDoc, 0.35);
const n = items.length;

// 持久索引（本次呼叫內模擬：正式版這個陣列該存在 KBDB，逐張呼叫時讀回、寫回）
// 每個群只存：代表向量總和 centroid、成員數 size、成員清單、代表標籤（第一個成員的）
const clusters = [];
let comparisons = 0; // 只是為了在輸出裡證明複雜度量級，不影響邏輯

for (let i = 0; i < n; i++) {
  let bestSim = -1;
  let bestCluster = -1;
  for (let c = 0; c < clusters.length; c++) {
    comparisons++;
    if (clusters[c].size >= sizeCap) continue; // 已滿的抽屜不再收新成員
    const sim = cosineToCentroid(vecs[i], clusters[c].centroid, clusters[c].size) + labelBonus(labelsList[i], clusters[c].repLabels);
    if (sim > bestSim) { bestSim = sim; bestCluster = c; }
  }
  if (bestCluster >= 0 && bestSim >= simThreshold) {
    const c = clusters[bestCluster];
    addToCentroid(c.centroid, vecs[i]);
    c.size += 1;
    c.members.push(i);
  } else {
    clusters.push({ centroid: new Map(vecs[i]), size: 1, members: [i], repLabels: labelsList[i] });
  }
}

let singletons = 0;
const out = [];
for (const c of clusters) {
  if (c.size === 1) { singletons++; continue; }
  out.push({
    size: c.size,
    members: c.members.map(i => ({ id: items[i].id, repo: items[i].repo || null, title: String(items[i].title || '').slice(0, 60) })),
  });
}
out.sort((a, b) => b.size - a.size);

return {
  success: true,
  algo: 'incremental_centroid_o_nm',
  total_items: n,
  clusters_created: clusters.length,
  comparisons_done: comparisons,       // 應遠小於 n*n；若持久化到 KBDB，逐張呼叫時這裡永遠是 O(m)
  groups_found: out.length,
  singletons: singletons,
  sim_threshold: simThreshold,
  size_cap: sizeCap,
  groups: out,
};
