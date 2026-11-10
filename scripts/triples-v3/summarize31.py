#!/usr/bin/env python3
"""summarize31.py — 讀 cs4_v31.py 的 results31.jsonl，印 v2／v3／v3.1 對照。用法：summarize31.py <results31.jsonl>"""
import json, sys, statistics as st

rs = [json.loads(l) for l in open(sys.argv[1])]
ok = [r for r in rs if r.get("items") and "v31_facts" in r]
items = [i for r in ok for i in r["items"]]
n = len(items)
print(f"卡片 {len(rs)}，有 v3.1 結果 {len(ok)}，錯誤 {sum(1 for r in rs if 'error' in r)}；題數 {n}")
for k in ("full", "v2", "v3", "v31"):
    print(f"答對率 {k}: {sum(i[k] for i in items)}/{n} = {sum(i[k] for i in items)/n:.1%}")
b = [i for i in items if i["full"]]
print(f"占整張卡比：v2 {sum(i['v2'] for i in b)/len(b):.1%}  v3 {sum(i['v3'] for i in b)/len(b):.1%}  v3.1 {sum(i['v31'] for i in b)/len(b):.1%}（門檻 85%）")
print("v3.1 對 v3：僅 v3.1 對", sum(1 for i in items if i["v31"] and not i["v3"]), "僅 v3 對", sum(1 for i in items if i["v3"] and not i["v31"]))
for q, name in (("q3", "v3"), ("q31", "v3.1")):
    qs = [r[q] for r in ok if r.get(q, {}).get("n")]
    print(name, "有結果的卡", len(qs), "每卡條數", round(st.mean(x["n"] for x in qs), 1),
          "條數夠", f"{sum(x['enough'] for x in qs)/len(qs):.0%}", "空泛述詞", f"{st.mean(x['vague_rate'] for x in qs):.1%}",
          "含代稱/空欄的卡", f"{sum(1 for x in qs if x['empty_or_pron'])/len(qs):.0%}",
          "第一條是結論", f"{sum(x['first_is_conclusion'] for x in qs)/len(qs):.0%}")
print("三元組為空的卡 v3", sum(1 for r in ok if not r["v3_facts"]), "v3.1", sum(1 for r in ok if not r["v31_facts"]))
lg = [i for r in ok if r["chars"] > 4000 for i in r["items"]]
if lg:
    print(f"長卡(>4000字) {len(lg)} 題：full {sum(i['full'] for i in lg)/len(lg):.0%} v2 {sum(i['v2'] for i in lg)/len(lg):.0%} v3 {sum(i['v3'] for i in lg)/len(lg):.0%} v3.1 {sum(i['v31'] for i in lg)/len(lg):.0%}")
shown = 0
print("前後對照（v3 錯、v3.1 對；只印題目與答案，不印卡內容）：")
for r in ok:
    for i in r["items"]:
        if i["v31"] and not i["v3"] and shown < 5:
            shown += 1
            print(" *", r["card"].split('/')[-1][:24], "|", i["q"][:45], "| 標準:", i["gold"][:30], "| v3:", i["v3_ans"][:25], "| v3.1:", i["v31_ans"][:30])
