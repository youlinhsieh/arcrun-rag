#!/usr/bin/env python3
"""重現 stage 上 `rag_cluster_auto` 的部署步驟（inkstone/arcrun-rag#13 c14334 要求：
repo 裡要有一份定義，重建得出 stage 上那一支，不是只留 decide 節點的 JS 片段）。

用法：
    ARCRUN_NS=<租戶 namespace> ARCRUN_CYPHER_BASE=<cypher-executor URL> \
      python3 deploy_rag_cluster_auto.py

- <租戶 namespace>：同時是 X-Arcrun-API-Key 與 webhook 路徑裡的 __NAMESPACE__
  （見 InkStoneCo CLAUDE.md D36：只放名字，不放金鑰——這個字串本身是明碼分區標籤，
  不是密鑰，見 inkstone/arcrun-rag#13 comment 14327 引用的 webhooks-named.ts:300）。
- <cypher-executor URL>：**必填、不猜**。🔴 c14542 這輪抓到的真 bug：舊版曾經寫
  `base = f"https://arcrun-cypher-executor.{ns}.workers.dev"`（namespace 直接接
  workers.dev），這對 youlin 是錯的——youlin 的 CF 帳號子網域是 `arcrun-yuga3bse`，
  namespace 是 `yuga3bse`，兩者**不是同一個字串去掉字首那麼簡單的關係**（namespace
  與帳號子網域是分開設定的兩個東西，只是這個測試帳號的命名剛好相似），猜的結果是
  一個不存在的網域，Cloudflare 回 `530`／`error code 1016`（origin DNS error）——
  而且 `http_request` 零件不會把非 2xx 回應當節點失敗，錯誤訊息只會靜靜混進正常
  回應的 `data.body`，很容易被忽略。同本檔既有的 `install/push-workflow-update.sh`
  慣例一樣，網域一律由呼叫端明講，不衍生、不猜。

這支腳本只做「讀本檔 + 代入佔位符 + POST /webhooks/named」，不含任何業務邏輯——
業務邏輯（tokenize/tfVector/決策、③總編輯的 hub_editor/finalize_hub_card/
build_split_proposal，c14669）全部各自放在同目錄的 rag_cluster_auto_*_node.js，
這支只是部署殼，逐一把 JSON 裡的 __SEE_<檔名>.js__ 佔位符換成對應檔案內容，
避免「JS 邏輯」與「部署用的 JSON 骨架」兩處各存一份、彼此漂移。
"""
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ns = os.environ.get("ARCRUN_NS")
    if not ns:
        print("缺 ARCRUN_NS 環境變數（租戶 namespace，例：yuga3bse）", file=sys.stderr)
        sys.exit(2)
    base = os.environ.get("ARCRUN_CYPHER_BASE")
    if not base:
        print("缺 ARCRUN_CYPHER_BASE 環境變數（該租戶 cypher-executor 的完整網址，"
              "例：https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev）——"
              "不會從 ARCRUN_NS 自動猜，猜錯會打到不存在的網域（c14542 教訓）", file=sys.stderr)
        sys.exit(2)
    # c14669 繞過的坑（留給下一個改這支的人）：一開始想讓 check_hub_exists 打
    # `by-source` 路由（GET .../records/by-source/:template?field=&value=，跟
    # rag-ingest-card.local.yaml 的 list_old_triplets 同一種）查「這個 cluster_id
    # 有沒有 cluster_hub 記錄」——結果那個路由**只認白名單內的 template**（PR #225
    # 是為了 triplet 開的），打 cluster_hub 在路由層直接 404，連帶錯的
    # Authorization token 都一樣 404（不是 401），證實是路由不認得這個 template，
    # 不是認證問題。已改回跟 read_criteria／read_membership 一致、已驗證能用的
    # by-template 路由（見 rag_cluster_auto_hub_editor_node.js 內的過濾邏輯），
    # 🔴 c15294/c15345 之後（wiki_toc_item→00-INDEX 改版）：post_card_toc_entry／
    # post_hub_index_line／get_index_lines／post_hub_card_entry／delete_index_line
    # 這幾個節點都打 __KBDB_BASE__/entries，不再是「可有可無」——沒代入這格，
    # 部署出去的定義照樣能成功送出（cypher-executor 不驗證 URL 裡還有沒有殘留
    # 佔位符），但實跑時每一步都會撞 `fetch failed: Invalid URL: __KBDB_BASE__/...`。
    # c15411（總管實測抓到）：這種「部署『成功』但定義半殘」的狀況已經真的發生過一次
    # （10:29Z 總管用舊版 main 的腳本重部過，那版本還沒有 __KBDB_BASE__ 這格，
    # 之後沒人再重新代入過，下一次呼叫就直接炸）。改成必填＋部署前掃描殘留
    # 佔位符，早在本機端擋下，不要讓一個半殘的定義送上 stage。
    kbdb_base = os.environ.get("ARCRUN_KBDB_BASE")
    if not kbdb_base:
        print("缺 ARCRUN_KBDB_BASE 環境變數（該租戶 KBDB worker 的完整網址，"
              "例：https://arcrun-kbdb.arcrun-yuga3bse.workers.dev）——00-INDEX 相關節點"
              "都要打這個網址，沒代入會部署出一個『看起來成功、實跑必炸』的半殘定義"
              "（c15411 實測撞過），故這格現在是必填，不再靜默略過", file=sys.stderr)
        sys.exit(2)

    with open(os.path.join(HERE, "rag_cluster_auto.deployed.json"), encoding="utf-8") as f:
        raw = f.read()

    raw = raw.replace("__CYPHER_BASE__", base).replace("__NAMESPACE__", ns).replace("__KBDB_BASE__", kbdb_base)

    # 部署前的最後一道機械檢查：掃描 `__ALL_CAPS__` 形狀的殘留佔位符（排除
    # `__SEE_*.js__` 這種故意保留、稍後才展開成 code 內容的佔位符），有殘留就
    # 直接拒絕送出，不要讓半殘定義上 stage。
    leftover = {p for p in re.findall(r"__[A-Z0-9_]+__", raw) if not p.startswith("__SEE_")}
    if leftover:
        print("拒絕部署：以下佔位符沒有被代入，送出去只會得到一個半殘的定義——"
              + "、".join(sorted(leftover)), file=sys.stderr)
        sys.exit(2)

    doc = json.loads(raw)
    doc.pop("_note_decide_code_placeholder", None)

    # c14669：不再只有 decide 一個 code 節點掛外部 JS 檔——任何節點的 code 欄位
    # 只要長得像 __SEE_<檔名>.js__（同一套慣例，見上面 decide 的用法），一律去
    # 同目錄讀那個檔案貼進去。這樣新增 code 節點不用回來改這支部署殼。
    placeholder_re = re.compile(r"^__SEE_(.+?\.js)__$")
    for node in doc["graph"]["nodes"]:
        code_val = node.get("data", {}).get("code")
        if isinstance(code_val, str):
            m = placeholder_re.match(code_val)
            if m:
                js_path = os.path.join(HERE, m.group(1))
                with open(js_path, encoding="utf-8") as f:
                    node["data"]["code"] = f.read()

    body = json.dumps({
        "name": doc["name"],
        "description": doc["description"],
        "graph": doc["graph"],
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base}/webhooks/named",
        data=body,
        method="POST",
        # User-Agent: WAF 對預設的 python urllib UA 回 403（既有工具坑，見
        # install/push-workflow-update.sh 同一行註解），這裡照抄同款繞法。
        headers={"Content-Type": "application/json", "X-Arcrun-API-Key": ns,
                 "User-Agent": "curl/8.5.0"},
    )
    with urllib.request.urlopen(req) as r:
        print(r.read().decode())


if __name__ == "__main__":
    main()
