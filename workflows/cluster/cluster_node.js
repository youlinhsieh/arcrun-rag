const items = Array.isArray(input.items) ? input.items : [];
const simThreshold = Number(input.sim_threshold || 0.22);
const k = Number(input.k || 6);
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

function find(parent, x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
function union(parent, a, b) { const ra = find(parent, a), rb = find(parent, b); if (ra !== rb) parent[ra] = rb; }

const texts = items.map(it => `${it.title || ''} ${(it.labels || []).join(' ')}`);
const labelsList = items.map(it => it.labels || []);
const tokensPerDoc = texts.map(tokenize);
const vecs = buildTfidf(tokensPerDoc, 0.35);
const n = items.length;
const parent = Array.from({ length: n }, (_, i) => i);

// 倒排索引：只比對「至少共享一個非樣板 token」的候選對，而不是全體 O(n^2)。
// 這對齊原設計「每一步只讀局部近鄰」的不變量——同時也是 Arcrun code 節點的
// tick 預算硬限制（500 ticks）逼出來的做法：343 張票的全對全在 n=150~200 之間就會爆預算。
const postingList = new Map();
for (let i = 0; i < n; i++) {
  for (const t of vecs[i].keys()) {
    if (!postingList.has(t)) postingList.set(t, []);
    postingList.get(t).push(i);
  }
}

const edges = [];
for (let i = 0; i < n; i++) {
  const candidateSet = new Set();
  for (const t of vecs[i].keys()) {
    const plist = postingList.get(t);
    if (!plist || plist.length > n * 0.5) continue; // 太常見的 token 不當候選來源
    for (const j of plist) if (j !== i) candidateSet.add(j);
  }
  const sims = [];
  for (const j of candidateSet) {
    const s = cosine(vecs[i], vecs[j]) + labelBonus(labelsList[i], labelsList[j]);
    if (s >= simThreshold) sims.push([s, j]);
  }
  sims.sort((a, b) => b[0] - a[0]);
  for (const [s, j] of sims.slice(0, k)) edges.push([s, i, j]);
}
edges.sort((a, b) => b[0] - a[0]);

const groupOf = new Map();
for (const [s, i, j] of edges) {
  const gi = find(parent, i), gj = find(parent, j);
  if (gi === gj) continue;
  const sizeI = groupOf.get(gi) || 1;
  const sizeJ = groupOf.get(gj) || 1;
  if (sizeI + sizeJ <= sizeCap) {
    union(parent, i, j);
    const merged = find(parent, i);
    groupOf.set(merged, sizeI + sizeJ);
  }
}

const groups = new Map();
for (let idx = 0; idx < n; idx++) {
  const r = find(parent, idx);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(idx);
}

let singletons = 0;
const out = [];
for (const [, idxs] of groups.entries()) {
  if (idxs.length === 1) { singletons++; continue; }
  out.push({
    size: idxs.length,
    members: idxs.map(i => ({ id: items[i].id, repo: items[i].repo || null, title: String(items[i].title || '').slice(0, 60) })),
  });
}
out.sort((a, b) => b.size - a.size);

return {
  success: true,
  total_items: n,
  groups_found: out.length,
  singletons: singletons,
  sim_threshold: simThreshold,
  size_cap: sizeCap,
  groups: out,
};
