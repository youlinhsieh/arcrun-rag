// inkstone/arcrun-rag#13 R4：真正的「單張新項目 + 讀既有群摘要」O(m) 步驟。
//
// 09-27 實測發現：把「持久索引」誤解成「同一次呼叫內依序處理全部項目、只是改用
// centroid 而非全對全」（cluster_incremental_node.js）仍然會撞 500-tick——
// 因為 500-tick 是**單次呼叫的總指令量**，不是「複雜度類別」，跑 343 張的 tokenize
// + tfidf + 逐張比對本身的指令量就超過預算，跟演算法是 O(n^2) 或 O(n*m) 無關。
//
// 真正符合 proposal §4 place_card 精神的做法是：**每次呼叫只處理一張新項目**，
// 既有的群摘要（centroid + size + repLabels）從 KBDB 讀回當作 input 傳進來，
// 這次呼叫只需要對這 m 個摘要做比對（m = 現有群數，不是總項目數 n），
// 決定 attach 現有群或新開一群，再把結果寫回 KBDB。呼叫本身完全不重算其他項目。
//
// 本節點只做「比對＋決策」這一步（純函式，不含 KBDB 讀寫——讀寫是外層 workflow 節點的事）。
// input: { new_item: {id,title,labels}, existing_clusters: [{cluster_id, centroid:[[token,weight],...], size, rep_labels}], sim_threshold, size_cap }
// output: { action: 'attach'|'new', cluster_id?, sim? , updated_centroid?(僅 attach 用，caller 負責寫回) }
const newItem = input.new_item || {};
const existingClusters = Array.isArray(input.existing_clusters) ? input.existing_clusters : [];
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

// 新項目自己的向量：只用 tf（沒有 idf，因為沒有全庫可算 df）。
// 這是持久化設計必然的取捨（proposal 也承認 embedding 才是正式解，見 README「已知限制」）：
// 每次只看 1 張新項目時，「這個詞在全庫多常見」這個統計量本來就拿不到，
// 用 tf-only 向量比對既有群的 centroid（centroid 本身是用當初建群時的 tfidf 累加出來的），
// 精度會比全量 tfidf 略低，但複雜度換到 O(m)，且可用 Vectorize embedding 取代整段來解掉這個取捨。
function tfVector(text) {
  const toks = tokenize(text);
  const v = new Map();
  for (const t of toks) v.set(t, (v.get(t) || 0) + 1);
  let norm = 0;
  for (const x of v.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const t of v.keys()) v.set(t, v.get(t) / norm);
  return v;
}

function labelBonus(la, lb) {
  if (!la || !lb || !la.length || !lb.length) return 0;
  const setB = new Set(lb);
  const inter = la.filter(x => setB.has(x));
  if (!inter.length) return 0;
  const meaningful = inter.filter(l => !String(l).startsWith('s/'));
  return meaningful.length ? 0.15 : 0;
}

const text = `${newItem.title || ''} ${(newItem.labels || []).join(' ')}`;
const vec = tfVector(text);

let bestSim = -1;
let bestCluster = null;
let comparisons = 0;

for (const c of existingClusters) {
  comparisons++;
  if ((c.size || 0) >= sizeCap) continue;
  const centroid = new Map(c.centroid || []);
  let s = 0;
  for (const [t, w] of vec.entries()) if (centroid.has(t)) s += w * centroid.get(t);
  const centroidNorm = Math.sqrt(Array.from(centroid.values()).reduce((a, x) => a + x * x, 0)) / (c.size || 1) || 1;
  const sim = (s / (c.size || 1) / centroidNorm) + labelBonus(newItem.labels, c.rep_labels);
  if (sim > bestSim) { bestSim = sim; bestCluster = c; }
}

if (bestCluster && bestSim >= simThreshold) {
  const updated = new Map(bestCluster.centroid || []);
  for (const [t, w] of vec.entries()) updated.set(t, (updated.get(t) || 0) + w);
  return {
    success: true,
    action: 'attach',
    cluster_id: bestCluster.cluster_id,
    sim: bestSim,
    comparisons_done: comparisons,
    updated_centroid: Array.from(updated.entries()),
    updated_size: (bestCluster.size || 0) + 1,
  };
}

return {
  success: true,
  action: 'new',
  comparisons_done: comparisons,
  new_centroid: Array.from(vec.entries()),
  rep_labels: newItem.labels || [],
};
