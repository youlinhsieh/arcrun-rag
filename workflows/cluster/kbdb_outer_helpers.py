#!/usr/bin/env python3
"""inkstone/arcrun-rag#13 R4：KBDB 讀寫外層的純函式部分（可重用、已測）。

這次沒有做出一支「可以自己跑」的 orchestrator script——原因誠實記在
docs/3-specs/cluster-workflow/README.md「KBDB 讀寫外層」段：cypher-executor
沒有對外開放的 KBDB 讀取 HTTP 路由（只有 /kbdb/templates、/kbdb/records 兩個
「寫」路由被 prod-write-guard.sh 白名單放行），讀（kbdb_query／kbdb_get_record）
目前只能透過 MCP 連線（這條連線背後有登入身分，能查到系統內部才能查的東西）。

這支檔案只收「不需要 KBDB 連線」的那一半邏輯——tokenize/tf_vector/aggregate_clusters，
在 2026-09-27 這輪的手動 orchestration（MCP 讀 → curl 觸發 rag_cluster_step → curl 寫）
裡都实际用過、對過真資料。要串成全自動，缺的不是這幾個函式，是一個能讀 KBDB 的執行環境
（見 README 的「還缺什麼」段）。
"""
import json
import math
import re
from collections import Counter, defaultdict


def tokenize(text):
    text = re.sub(r"[`*_#>\[\]\(\)\{\}\|]", " ", str(text or ""))
    text = re.sub(r"https?://\S+", " ", text).lower()
    tokens = re.findall(r"[a-z0-9][a-z0-9\-_/#]{1,}", text)
    for run in re.findall(r"[一-鿿]+", text):
        if len(run) == 1:
            tokens.append(run)
        for i in range(len(run) - 1):
            tokens.append(run[i:i + 2])
    return tokens


def tf_vector(text):
    """新項目自己的向量：tf-only（沒有 idf——單次呼叫看不到全庫算 df，見主 README 的取捨說明）。"""
    toks = tokenize(text)
    tf = Counter(toks)
    norm = math.sqrt(sum(c * c for c in tf.values())) or 1.0
    return {t: c / norm for t, c in tf.items()}


def aggregate_clusters(membership_records):
    """把 KBDB 裡 append-only 的 cluster_membership record，依 cluster_id 加總成
    rag_cluster_step 要吃的 existing_clusters 格式。輸入是 kbdb_query 回傳的 records
    陣列（每筆 .values 底下有 cluster_id/vec_json/item_labels_json）。

    這步的成本是「目前為止的成員數」，不是「全庫項目數」——群數與群內成員數通常個位數
    到十幾，跟全庫累積到幾千張無關，這正是這輪要證明的複雜度不變量。
    """
    groups = defaultdict(lambda: {"vec": defaultdict(float), "size": 0, "rep_labels": []})
    for rec in membership_records:
        v = rec.get("values", rec)
        cid = v.get("cluster_id")
        vec = json.loads(v.get("vec_json") or "{}")
        for t, w in vec.items():
            groups[cid]["vec"][t] += w
        groups[cid]["size"] += 1
        if not groups[cid]["rep_labels"]:
            groups[cid]["rep_labels"] = json.loads(v.get("item_labels_json") or "[]")
    return [
        {"cluster_id": cid, "centroid": list(g["vec"].items()), "size": g["size"], "rep_labels": g["rep_labels"]}
        for cid, g in groups.items()
    ]
