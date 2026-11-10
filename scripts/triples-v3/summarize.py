#!/usr/bin/env python3
"""summarize.py — 讀 cs4_eval.py 的 results.jsonl，印 v2 vs v3 的答對率、品質閘、失敗類型、前後對照。用法：summarize.py <results.jsonl>"""
import json, sys, statistics as st

rs = [json.loads(l) for l in open(sys.argv[1])]
ok = [r for r in rs if r.get("items")]
items = [i for r in ok for i in r["items"]]
n = len(items)
print(f"卡片 {len(rs)} 張，成功 {len(ok)}，略過/失敗 {len(rs)-len(ok)}；題數 {n}")
for k in ("full", "v2", "v3"):
    print(f"答對率 {k}: {sum(i[k] for i in items)}/{n} = {sum(i[k] for i in items)/n:.1%}")
base = [i for i in items if i["full"] == 1]
print(f"整張卡答得出的題 {len(base)}：只看三元組 v2 {sum(i['v2'] for i in base)/len(base):.1%}，v3 {sum(i['v3'] for i in base)/len(base):.1%}（占整張卡比 v2 {sum(i['v2'] for i in base)/len(base):.0%} / v3 {sum(i['v3'] for i in base)/len(base):.0%}）")
both = [(i["v2"], i["v3"]) for i in base]
print("僅 v3 對", sum(1 for a, b in both if b and not a), "僅 v2 對", sum(1 for a, b in both if a and not b), "都對", sum(1 for a, b in both if a and b), "都錯", sum(1 for a, b in both if not a and not b))
for q in ("q2", "q3"):
    qs = [r[q] for r in ok if r[q].get("n")]
    print(q, "每卡條數 平均", round(st.mean(x["n"] for x in qs), 1), "中位", st.median(x["n"] for x in qs),
          "條數夠(>=字數/150)", f"{sum(x['enough'] for x in qs)/len(qs):.0%}",
          "空泛述詞率 平均", f"{st.mean(x['vague_rate'] for x in qs):.1%}",
          "含代稱/空欄的卡", f"{sum(1 for x in qs if x['empty_or_pron'])/len(qs):.0%}",
          "第一條是結論", f"{sum(x['first_is_conclusion'] for x in qs)/len(qs):.0%}")
empty3 = sum(1 for r in ok if not r["v3_facts"]); empty2 = sum(1 for r in ok if not r["v2_facts"])
print("三元組為空的卡 v2", empty2, "v3", empty3)
# 長卡（> 4000 字，v2 會截尾）
lg = [i for r in ok if r["chars"] > 4000 for i in r["items"]]
if lg:
    print(f"長卡(>4000字)題數 {len(lg)}：full {sum(i['full'] for i in lg)/len(lg):.0%} v2 {sum(i['v2'] for i in lg)/len(lg):.0%} v3 {sum(i['v3'] for i in lg)/len(lg):.0%}")
# v3 還是答不出的（整張卡答得出）
miss = [(r["card"], i) for r in ok for i in r["items"] if i["full"] and not i["v3"]]
print(f"v3 仍答不出（整張卡答得出）{len(miss)} 題；前 8 題：")
for c, i in miss[:8]:
    print(" -", c.split('/')[-1][:30], "|", i["q"][:50], "| 標準:", i["gold"][:40], "| v3答:", i["v3_ans"][:40])
print("對照（v2 錯、v3 對）：")
shown = 0
for r in ok:
    for i in r["items"]:
        if i["v3"] and not i["v2"] and shown < 4:
            shown += 1
            print(" *", r["card"].split('/')[-1][:30], "|", i["q"][:50], "| 標準:", i["gold"][:40], "| v2答:", i["v2_ans"][:30], "| v3答:", i["v3_ans"][:40])
