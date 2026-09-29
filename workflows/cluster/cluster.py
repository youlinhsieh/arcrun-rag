#!/usr/bin/env python3
"""分群工作流（R4）：向量相似度（char-bigram TF-IDF + cosine）+ 準則過濾 + union-find 分群 + 抽屜/hub 大小上限。
純 python，不依賴 numpy/sklearn（環境沒裝）。每一步只讀局部候選（top-k 近鄰），不掃全庫做笛卡兒積之外的事。
用法：
  python3 cluster.py issues issues_compact.json --sim 0.28 --cap 8
  python3 cluster.py mistakes mistakes_sections.json --sim 0.30 --cap 8
"""
import json, re, sys, math, argparse
from collections import Counter, defaultdict

def tokenize(text):
    text = re.sub(r'[`*_#>\[\]\(\)\{\}\|]', ' ', text)
    text = re.sub(r'https?://\S+', ' ', text)
    text = text.lower()
    tokens = []
    # ascii words
    for w in re.findall(r'[a-z0-9][a-z0-9\-_/#]{1,}', text):
        tokens.append(w)
    # cjk char-bigrams (無 jieba，中文用字元 bigram 當 token，是可行的近似)
    cjk = re.findall(r'[一-鿿]+', text)
    for run in cjk:
        if len(run) == 1:
            tokens.append(run)
        for i in range(len(run) - 1):
            tokens.append(run[i:i+2])
    return tokens

def build_tfidf(docs, max_df_ratio=0.35):
    df = Counter()
    doc_tf = []
    for toks in docs:
        tf = Counter(toks)
        doc_tf.append(tf)
        for t in tf:
            df[t] += 1
    n = len(docs)
    max_df = max(2, int(n * max_df_ratio))
    # max_df 截斷：出現在超過 35% 文件裡的 token 視為模板樣板字（如 User Story 的「身為／我要／我才」），
    # 直接剔除而不是靠 idf 弱化——弱化在 boilerplate 佔比高時仍會主導相似度。
    idf = {t: (math.log((n + 1) / (c + 1)) + 1) for t, c in df.items() if c <= max_df}
    vecs = []
    for tf in doc_tf:
        v = {t: (c / max(1, sum(tf.values()))) * idf[t] for t, c in tf.items() if t in idf}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        v = {t: x / norm for t, x in v.items()}
        vecs.append(v)
    return vecs

def cosine(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(w * b.get(t, 0.0) for t, w in a.items())

def label_bonus(labels_a, labels_b):
    if not labels_a or not labels_b:
        return 0.0
    inter = set(labels_a) & set(labels_b)
    if not inter:
        return 0.0
    # 忽略純狀態標籤（s/*）避免把「都在 backlog」誤判成同題
    meaningful = {l for l in inter if not l.startswith('s/')}
    return 0.15 if meaningful else 0.0

class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb

def cluster(items, texts, labels_list, sim_threshold, k, size_cap):
    vecs = build_tfidf([tokenize(t) for t in texts])
    n = len(items)
    uf = UnionFind(n)
    edges = []
    for i in range(n):
        sims = []
        for j in range(n):
            if i == j:
                continue
            s = cosine(vecs[i], vecs[j]) + label_bonus(labels_list[i], labels_list[j])
            if s >= sim_threshold:
                sims.append((s, j))
        sims.sort(reverse=True)
        for s, j in sims[:k]:
            edges.append((s, i, j))
    edges.sort(reverse=True)
    for s, i, j in edges:
        # 抽屜大小上限：合併前檢查合併後群大小，超過就不合併（觸發「拆成兩個抽屜」準則）
        groups_tmp = defaultdict(list)
        for idx in range(n):
            groups_tmp[uf.find(idx)].append(idx)
        gi, gj = uf.find(i), uf.find(j)
        if gi != gj and len(groups_tmp[gi]) + len(groups_tmp[gj]) <= size_cap:
            uf.union(i, j)
    groups = defaultdict(list)
    for idx in range(n):
        groups[uf.find(idx)].append(idx)
    return groups, vecs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('kind', choices=['issues', 'mistakes'])
    ap.add_argument('infile')
    ap.add_argument('--sim', type=float, default=0.28)
    ap.add_argument('--k', type=int, default=6)
    ap.add_argument('--cap', type=int, default=8)
    args = ap.parse_args()

    data = json.load(open(args.infile))
    if args.kind == 'issues':
        texts = [f"{it['title']} {' '.join(it.get('labels', []))} {it.get('body','')}" for it in data]
        labels_list = [it.get('labels', []) for it in data]
        ids = [f"#{it['number']}" for it in data]
        titles = [it['title'] for it in data]
    else:
        texts = [f"{it['title']} {it.get('body','')}" for it in data]
        labels_list = [[] for it in data]
        ids = [it.get('id', str(i)) for i, it in enumerate(data)]
        titles = [it['title'] for it in data]

    groups, vecs = cluster(data, texts, labels_list, args.sim, args.k, args.cap)

    out = []
    singleton = 0
    for gid, idxs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        if len(idxs) == 1:
            singleton += 1
            continue
        out.append({
            "members": [{"id": ids[i], "title": titles[i]} for i in idxs],
            "size": len(idxs),
        })
    print(json.dumps({
        "kind": args.kind,
        "total_items": len(data),
        "groups_found": len(out),
        "singletons": singleton,
        "sim_threshold": args.sim,
        "size_cap": args.cap,
        "groups": out,
    }, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
