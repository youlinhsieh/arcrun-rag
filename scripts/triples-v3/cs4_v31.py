#!/usr/bin/env python3
"""cs4_v31.py — v3.1 提示＋機械檢查重抽，對同一批卡、同一批題、同一套評分重量（inkstone/arcrun-rag#299 總監裁決 c1794275206032880）。

重用 v3 結果檔（cs4_eval.py 的 results.jsonl）裡的題目、標準答案、整張卡／v2／v3 成績，只重萃 v3.1 並作答判分，
所以三版用的是完全相同的題。v3.1 相對 v3 的改動：
  1 提示：路徑、網址、指令、型號、專有名稱逐字保留；原因與正確做法各自一條；只寫原稿有寫的，不編造
  2 機械檢查：空受詞／空主詞／代稱主詞（本文、該、它…）⇒ 帶著問題條目要求模型重寫整份；
    解析失敗或空清單 ⇒ 重問；仍有問題的條目丟掉（不送出壞條目）
用法：cs4_v31.py <v3 results.jsonl> <輸出資料夾> [--budget 0.8] [--workers 6]
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

import cs4_eval as c

V31 = c.V3.replace(
    "8. 條數約每 80 字原文一條，最多 40 條。",
    "8. 條數約每 80 字原文一條，最多 40 條。\n"
    "9. 路徑、網址、指令、型號、代碼、API 路徑、專有名稱一律照原文逐字保留，不翻譯、不簡化、不改寫。\n"
    "10. 原稿寫了「為什麼／原因／理由」就單獨一條「X >> 原因是 >> …」；寫了「正確做法／該怎麼做」也單獨一條「X >> 正確做法是 >> …」。\n"
    "11. 只寫原稿明確寫了的內容；不得推測、不得編造，原稿沒有的數字、名稱不要寫。\n"
    "12. 每條的三個欄位都不能是空字串。")

PRON = c.PRON


def bad(f):
    return (not f[0].strip()) or (not f[2].strip()) or (not f[1].strip()) or bool(PRON.match(f[0])) or bool(PRON.match(f[2]))


def call_facts(prompt, max_tokens=2200):
    return c.clean_facts((c.jparse(c.ai([{"role": "user", "content": prompt}], max_tokens)) or {}).get("facts"))


def extract_seg(prompt):
    best = None
    for attempt in range(3):
        p = prompt
        if best:  # 上一輪有壞條目：把它們列出來要求重寫整份
            lst = "\n".join(" >> ".join(f) for f in [x for x in best if bad(x)][:8])
            p = prompt + "\n\n【上一次輸出的這些條目有問題（空欄位或用代稱當主詞／受詞），請重寫整份並修正，每個欄位都要寫出完整名稱】\n" + lst
        fs = call_facts(p)
        if not fs:
            continue
        if best is None or sum(map(bad, fs)) < sum(map(bad, best)):
            best = fs
        if not any(bad(f) for f in best):
            break
    return [f for f in (best or []) if not bad(f)]


def extract_v31(card):
    facts = []
    for i, seg in enumerate(c.split_segments(card)):
        facts += extract_seg(V31.replace("__FIRST__", c.FIRST_HEAD if i == 0 else c.FIRST_TAIL) + seg)
    return c.clean_facts(facts)


def run(rec):
    if not rec.get("items"):
        return rec
    out = dict(rec)
    try:
        card = open(rec["card"], encoding="utf-8").read()
        f = extract_v31(card)
        out["v31_facts"], out["q31"] = f, c.quality(f, card)
        t = c.fmt(f)
        items = []
        for it in rec["items"]:
            it = dict(it)
            a = c.answer(it["q"], t, "facts") if t.strip() else "無法判斷"
            it["v31_ans"], it["v31"] = a, c.judge(it["q"], it["gold"], a)
            items.append(it)
        out["items"] = items
    except RuntimeError as e:
        out["error"] = str(e)
    return out


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    cap = float(sys.argv[sys.argv.index("--budget") + 1]) if "--budget" in sys.argv else 0.8
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 6
    c.B = c.Budget(cap)
    os.makedirs(outdir, exist_ok=True)
    recs = [json.loads(l) for l in open(src)]
    resf = os.path.join(outdir, "results31.jsonl")
    done = set()
    if os.path.exists(resf):
        done = {json.loads(l)["card"] for l in open(resf) if "error" not in json.loads(l)}
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
    json.dump({"in": c.B.tin, "out": c.B.tout, "calls": c.B.calls, "cost_usd_est": c.B.cost},
              open(os.path.join(outdir, f"usage31_{int(time.time())}.json"), "w"))


if __name__ == "__main__":
    main()
