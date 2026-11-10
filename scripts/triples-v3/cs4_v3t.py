#!/usr/bin/env python3
"""cs4_v3t.py — v3 提示（不改）＋容錯解析，對同一批卡、同一批題、同一套評分重量（inkstone/arcrun-rag#299 總監裁決 c1794277750959295）。

容錯解析：回文不整份當 JSON 解；JSON 解得出就用，解不出就用規則逐條撈出 ["主詞","述詞","受詞"]
（壞 JSON、一行多個 {"facts":…} 物件、少括號、被截斷的尾巴都撈得到已完整的條目）。撈到 0 條才重問（最多 3 次）。
重用 cs4_eval.py 結果檔裡的題目與標準答案、整張卡／v2／v3 成績，只重萃 v3t、作答、判分。
用法：cs4_v3t.py <cs4_eval 的 results.jsonl> <輸出資料夾> [--budget 0.9] [--workers 6]
"""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

import cs4_eval as c

STR = r'"((?:[^"\\]|\\.)*)"'
TRIPLE = re.compile(r"\[\s*" + STR + r"\s*,\s*" + STR + r"\s*,\s*" + STR + r"\s*\]")


def parse_facts_tolerant(text):
    j = c.jparse(text)
    if isinstance(j, dict) and isinstance(j.get("facts"), list):
        f = c.clean_facts(j["facts"])
        if f:
            return f
    out = []
    for m in TRIPLE.finditer(text):
        try:
            out.append([json.loads('"%s"' % g) for g in m.groups()])
        except Exception:
            out.append(list(m.groups()))
    return c.clean_facts(out)


def facts_tolerant(prompt, max_tokens=2200, tries=3):
    for _ in range(tries):
        f = parse_facts_tolerant(c.ai([{"role": "user", "content": prompt}], max_tokens))
        if f:
            return f
    return []


def extract_v3t(card):
    facts = []
    for i, seg in enumerate(c.split_segments(card)):
        p = c.V3.replace("__FIRST__", c.FIRST_HEAD if i == 0 else c.FIRST_TAIL) + seg
        facts += facts_tolerant(p)
    return c.clean_facts(facts)


def run(rec):
    if not rec.get("items"):
        return rec
    out = dict(rec)
    try:
        card = open(rec["card"], encoding="utf-8").read()
        f = extract_v3t(card)
        out["v3t_facts"], out["q3t"] = f, c.quality(f, card)
        t = c.fmt(f)
        items = []
        for it in rec["items"]:
            it = dict(it)
            a = c.answer(it["q"], t, "facts") if t.strip() else "無法判斷"
            it["v3t_ans"], it["v3t"] = a, c.judge(it["q"], it["gold"], a)
            items.append(it)
        out["items"] = items
    except RuntimeError as e:
        out["error"] = str(e)
    return out


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    cap = float(sys.argv[sys.argv.index("--budget") + 1]) if "--budget" in sys.argv else 0.9
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 6
    c.B = c.Budget(cap)
    os.makedirs(outdir, exist_ok=True)
    recs = [json.loads(l) for l in open(src)]
    resf = os.path.join(outdir, "results3t.jsonl")
    done = set()
    if os.path.exists(resf):
        done = {r["card"] for r in map(json.loads, open(resf)) if "error" not in r}
    todo = [r for r in recs if r["card"] not in done]
    print(f"cards={len(recs)} todo={len(todo)} budget=${cap}", flush=True)
    t0 = time.time()
    with open(resf, "a", encoding="utf-8") as fo, ThreadPoolExecutor(workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(run, r) for r in todo]), 1):
            fo.write(json.dumps(f.result(), ensure_ascii=False) + "\n")
            fo.flush()
            if i % 20 == 0:
                print(f"{i}/{len(todo)} cost=${c.B.cost:.3f} calls={c.B.calls} {time.time()-t0:.0f}s", flush=True)
    print(f"END cost=${c.B.cost:.3f} in={c.B.tin} out={c.B.tout} calls={c.B.calls}", flush=True)


if __name__ == "__main__":
    main()
