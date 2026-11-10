#!/usr/bin/env python3
"""cs4_eval.py — 非表格知識卡「內文三元組」提示 v2 vs v3 的答題驗收（inkstone/arcrun-rag#299）。

原腳本 daqian/triples-v3/cs4.py 只在 Mac（雲端找不到），這份依策略文件
（https://claude.ai/artifact/QpqdoavJhxChhQFanwX4Rn）重建最小評測。v2 提示是依
collector/extract_prompt_legacy.go 的 facts 規則＋「卡片截在 4000 字」重建的，不是當年那份原檔。

流程（每張卡）：
  1 出題：模型讀整張卡，出 2 題「要看卡的結論／原因／數字／步驟才答得出」的題目與標準答案
  2 萃取：v2（截 4000 字、一次呼叫）與 v3（分段、v3 提示）各產一份三元組
  3 作答：只給三元組（v2／v3 各一份）、或整張卡（對照組）去答題
  4 判分：模型比對標準答案，1／0
只讀本地 md 卡，不寫任何正式卡。金鑰只讀環境變數 CLOUDFLARE_ACCOUNT_ID_YOULIN／CLOUDFLARE_API_TOKEN_YOULIN_CC_USE。
用法：cs4_eval.py <卡片清單檔> <輸出資料夾> [--budget 0.8] [--workers 6]
可續跑：輸出資料夾裡已有結果的卡會跳過。
"""
import json, os, re, sys, time, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ACC = os.environ["CLOUDFLARE_ACCOUNT_ID_YOULIN"]
TOK = os.environ["CLOUDFLARE_API_TOKEN_YOULIN_CC_USE"]
MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"
# 單價（USD／百萬 token）：憑記憶，沒查證（developers.cloudflare.com 在本雲端環境連不到）。
PRICE_IN, PRICE_OUT = 0.27, 0.85


class Budget:
    def __init__(self, cap):
        self.cap, self.tin, self.tout, self.calls, self.lock = cap, 0, 0, 0, threading.Lock()

    def add(self, i, o):
        with self.lock:
            self.tin += i; self.tout += o; self.calls += 1

    @property
    def cost(self):
        return self.tin / 1e6 * PRICE_IN + self.tout / 1e6 * PRICE_OUT


B = None


def ai(messages, max_tokens=1200):
    if B.cost > B.cap:
        raise RuntimeError("budget_exceeded")
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{MODEL}"
    body = json.dumps({"messages": messages, "max_tokens": max_tokens, "temperature": 0}).encode()
    last = None
    for k in range(4):
        try:
            req = urllib.request.Request(url, body, {"Authorization": f"Bearer {TOK}", "content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=120))["result"]
            u = r.get("usage") or {}
            B.add(u.get("prompt_tokens", 0), u.get("completion_tokens", 0))
            return r["choices"][0]["message"]["content"] or ""
        except Exception as e:
            last = e
            time.sleep(2 + 3 * k)
    raise RuntimeError(f"ai_failed: {last}")


def jparse(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(text[s:e + 1])
    except Exception:
        return None


# ---------- 提示 ----------
V2 = """你是知識整理員。讀完原稿後，把它的知識整理成 facts：[主詞,述詞,受詞] 三元組，端點盡量用原稿裡的實體名；任何欄位不得含雙箭頭符號。只輸出 JSON：{"facts":[["","",""]]}，不要說明。

原稿：
"""
V3 = """你要把一張知識卡轉成「內文三元組」，讓只看這些三元組的人也猜得出卡在講什麼、答得出卡裡的結論與理由。只輸出 JSON：{"facts":[["主詞","述詞","受詞"]]}，不要任何說明。

規則：
1. __FIRST__
2. 原因、結果、處理方式、前後變化都要有。前後數值變化把「前→後」數字寫進同一個受詞，例如「客服機器人 >> 回應時間由 >> 四分多鐘降到 34.3 秒」。
3. 清單、步驟、條列：一項一條，不准只抽前兩三項；步驟要帶順序（第 1 步…）。
4. 受詞可以是 25 字內的短句，不必是名詞；要保留原文的型號、代碼、數字、專有名詞。
5. 不寫目錄資訊：建立於、最後更新於、來源於、屬於某文件集、檔案路徑，一律不要。
6. 主詞與受詞都要離開這張卡也讀得懂：不用「本文」「該系統」「它」這類代稱，不留空受詞。
7. 述詞要具體（例如「導致」「解法是」「限制為」「取代」「步驟1」），避免「是」「相關」「提及」「描述」「包含」。
8. 條數約每 80 字原文一條，最多 40 條。

原稿：
"""
FIRST_HEAD = "第一條一定是「主題 >> 結論 >> 一句話答案」（三個欄位：主題名稱、\"結論\"、答案一句話）。"
FIRST_TAIL = "這是原稿的後半段，不必再寫「結論」那條，直接依規則抽這段的內容。"


def split_segments(text, limit=3500):
    if len(text) <= limit:
        return [text]
    segs, cur = [], ""
    for p in re.split(r"\n\s*\n", text):
        while len(p) > limit:  # 超長段硬切
            if cur:
                segs.append(cur); cur = ""
            segs.append(p[:limit]); p = p[limit:]
        if len(cur) + len(p) + 2 > limit and cur:
            segs.append(cur); cur = p
        else:
            cur = (cur + "\n\n" + p) if cur else p
    if cur:
        segs.append(cur)
    return segs


def clean_facts(fs):
    out, seen = [], set()
    for f in fs or []:
        if isinstance(f, list) and len(f) == 3 and all(isinstance(x, (str, int, float)) for x in f):
            t = tuple(str(x).strip() for x in f)
            if t not in seen:
                seen.add(t); out.append(list(t))
    return out


def facts_with_retry(prompt, max_tokens, tries=3):
    """模型偶爾回壞掉的 JSON 或空清單（實測 200 卡有 6%）：解析不出或沒有條目就重問，最多 tries 次。"""
    for _ in range(tries):
        f = clean_facts((jparse(ai([{"role": "user", "content": prompt}], max_tokens)) or {}).get("facts"))
        if f:
            return f
    return []


def extract_v2(card):
    return facts_with_retry(V2 + card[:4000], 900)


def extract_v3(card):
    facts = []
    for i, seg in enumerate(split_segments(card)):
        p = V3.replace("__FIRST__", FIRST_HEAD if i == 0 else FIRST_TAIL) + seg
        facts += facts_with_retry(p, 2200)
    return clean_facts(facts)


def fmt(facts):
    return "\n".join(f"{s} >> {p} >> {o}" for s, p, o in facts)


def gen_questions(card):
    p = ("讀下面這張知識卡，出 2 題考題。題目要看卡的「結論、原因、數字、步驟、處理方式」才答得出，"
         "不要問卡名、日期、檔案路徑；題目要能獨立看懂（不要說「這張卡」）；標準答案要短（30 字內）且卡上明確寫了。"
         "只輸出 JSON：{\"qa\":[{\"q\":\"\",\"a\":\"\"},{\"q\":\"\",\"a\":\"\"}]}\n\n卡片：\n" + card[:7000])
    j = jparse(ai([{"role": "user", "content": p}], 500)) or {}
    return [x for x in (j.get("qa") or []) if isinstance(x, dict) and x.get("q") and x.get("a")][:2]


def answer(q, ctx, kind):
    src = {"facts": "下面是一組三元組（主詞 >> 述詞 >> 受詞）。只根據它們回答；三元組裡找不到答案就回「無法判斷」，不要猜。",
           "card": "下面是一張知識卡。只根據它回答；卡裡找不到答案就回「無法判斷」。"}[kind]
    return ai([{"role": "user", "content": f"{src}\n\n{ctx[:9000]}\n\n問題：{q}\n用一兩句話回答。"}], 150).strip()


def judge(q, gold, cand):
    p = (f"題目：{q}\n標準答案：{gold}\n考生答案：{cand}\n考生答案的重點若與標準答案一致（說法不同沒關係、關鍵事實或數字要對）就是 1，"
         "答「無法判斷」、答錯、漏掉關鍵事實就是 0。只輸出 JSON：{\"score\":0或1}")
    j = jparse(ai([{"role": "user", "content": p}], 30)) or {}
    return 1 if j.get("score") in (1, "1", True) else 0


# ---------- 不花模型的品質檢查 ----------
VAGUE = {"是", "相關", "提及", "描述", "包含", "有", "屬於"}
PRON = re.compile(r"^(本文|該|此|它|其|本卡|本文件|這|那)")


def quality(facts, card):
    n = len(facts)
    if n == 0:
        return {"n": 0}
    return {"n": n,
            "enough": n >= len(card) / 150,
            "vague_rate": sum(1 for f in facts if f[1] in VAGUE) / n,
            "empty_or_pron": sum(1 for f in facts if not f[0] or not f[2] or PRON.match(f[0]) or PRON.match(f[2])),
            "first_is_conclusion": facts[0][1] == "結論"}


def run_card(path):
    card = open(path, encoding="utf-8").read()
    rec = {"card": path, "chars": len(card)}
    try:
        qa = gen_questions(card)
        if not qa:
            rec["skip"] = "no_questions"
            return rec
        f2, f3 = extract_v2(card), extract_v3(card)
        rec.update(v2_facts=f2, v3_facts=f3, q2=quality(f2, card), q3=quality(f3, card), items=[])
        t2, t3 = fmt(f2), fmt(f3)
        for x in qa:
            it = {"q": x["q"], "gold": x["a"]}
            for name, ctx, kind in (("full", card, "card"), ("v2", t2, "facts"), ("v3", t3, "facts")):
                a = answer(x["q"], ctx, kind) if ctx.strip() else "無法判斷"
                it[name + "_ans"], it[name] = a, judge(x["q"], x["a"], a)
            rec["items"].append(it)
    except RuntimeError as e:
        rec["error"] = str(e)
    return rec


def main():
    global B
    lst, outdir = sys.argv[1], sys.argv[2]
    cap = float(sys.argv[sys.argv.index("--budget") + 1]) if "--budget" in sys.argv else 0.8
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 6
    B = Budget(cap)
    os.makedirs(outdir, exist_ok=True)
    paths = [l.strip() for l in open(lst) if l.strip()]
    resf = os.path.join(outdir, "results.jsonl")
    done = set()
    if os.path.exists(resf):
        for l in open(resf):
            r = json.loads(l)
            if "error" not in r:
                done.add(r["card"])
    todo = [p for p in paths if p not in done]
    print(f"cards total={len(paths)} done={len(done)} todo={len(todo)} budget=${cap}", flush=True)
    t0 = time.time()
    with open(resf, "a", encoding="utf-8") as fo, ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(run_card, p): p for p in todo}
        for i, f in enumerate(as_completed(futs), 1):
            fo.write(json.dumps(f.result(), ensure_ascii=False) + "\n")
            fo.flush()
            if i % 10 == 0:
                print(f"{i}/{len(todo)} cost=${B.cost:.3f} calls={B.calls} {time.time()-t0:.0f}s", flush=True)
    print(f"END cost=${B.cost:.3f} in={B.tin} out={B.tout} calls={B.calls}", flush=True)
    json.dump({"in": B.tin, "out": B.tout, "calls": B.calls, "cost_usd_est": B.cost},
              open(os.path.join(outdir, f"usage_{int(time.time())}.json"), "w"))


if __name__ == "__main__":
    main()
