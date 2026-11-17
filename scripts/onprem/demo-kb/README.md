# 地端版示範知識庫（任何客戶都能用）

票：`inkstone/arcrun-rag#349`（母票 `inkstone/InkStoneCo#203`）。做成日 2026-11-17。

一份很小、刻意跟客戶無關的知識庫快照：**5 份食譜＋一家虛構公司的請假規定（拆成 3 份）**。
裝進任何一台地端版（1.4.204-onprem.1 起），問「法國麵包怎麼做」就會去查那份食譜，再照食譜回答。

## 裡面有什麼

| 檔案 | 說明 |
|---|---|
| `kbdb.sqlite`（1.0 MB）、`vectors.sqlite`（4.4 MB）、`MANIFEST.json` | 快照本體，租戶 `demokb01`（通用版） |
| `ckxt8yr9/` | 同一份快照改名成大前測試機的租戶 `ckxt8yr9`，給那台直接匯入 |
| `SHA256SUMS` | 這三個檔的摘要（`sha256sum -c SHA256SUMS`） |
| `SHA256SUMS.package` | 放進安裝包後，蓋掉安裝包根目錄的 `SHA256SUMS` 用（`install.sh check/import` 會驗它） |
| `source/` | 8 份原稿（Markdown），想看內容或重做時用 |
| `tools/` | 重做與改租戶的工具（見最後兩節） |
| `evidence/` | 乾淨容器匯入後的 Portal 畫面（搜尋、問知識庫，桌機與手機） |

三個檔都小於 10 MB，**不用切段**。

## 怎麼裝（在安裝包資料夾 `1.4.204-onprem.1/` 裡）

> ⚠️ 匯入是**整個知識庫檔換掉**。那台原本的知識（例如大前的庫）會被這份取代。
> 要回到客戶自己的庫，就再匯一次客戶那份快照。

1. 選對版本：新機器（還沒 `up` 過）用本資料夾根目錄那份；**已經是 `ckxt8yr9` 的大前測試機**用 `ckxt8yr9/` 那份。其他租戶見「改租戶」。
2. 放進去：
   ```sh
   cp <本資料夾>/kbdb.sqlite <本資料夾>/vectors.sqlite <本資料夾>/MANIFEST.json kb/
   cp <本資料夾>/SHA256SUMS.package SHA256SUMS
   ```
3. 新機器：`bash install.sh up` → 貼啟用碼 → `bash install.sh import` → 走精靈。
   已走過精靈的機器：`WIPE=1 bash install.sh import`，之後重走精靈。
4. 成功＝ import 最後一行「✓ 與快照清單一致」，`bash install.sh status` 顯示「知識庫：2041 筆（templates 30）」（`ckxt8yr9` 版是 1997 筆：改名時刪掉的是地圖計數列，引擎第一次讀會自己重算）。
5. 精靈：「語意搜尋」選不開也查得到（走目錄找卡，不靠向量）。要用 Portal 的「問知識庫」，精靈要設萃取 AI（回答也用它）。

`bash install.sh n8n-test` 的「知識庫 lib_473ed4／lib_1e221c／error_codes」三格會打 ✗：那是大前的庫名，這份的庫名是 `demo`，**這是預期**。

## 可以問的 5 題與預期答案

在 Portal「問知識庫」、n8n 的 AI Agent（MCP `kbdb_search`）或 Claude 問都可以。
2026-11-17 在乾淨容器匯入後實測：5 題 `kbdb_search` 全是 `found_by=index`；「問知識庫」5 題都答對並附出處卡。

| # | 問 | 會找到的卡 | 預期答案 |
|---|---|---|---|
| 1 | 法國麵包怎麼做？ | 法國長棍麵包食譜 | T65 法國粉 500 g、水 340 g、鹽 10 g、速發酵母 3 g。水合 30 分 → 加酵母與鹽 → 基本發酵 90 分（中間拉摺兩次）→ 分 3 份、整形 → 最後發酵 45 分 → 割紋 → 250°C 預熱、加蒸氣、入爐降到 230°C 烤 22～25 分 |
| 2 | 戚風蛋糕要烤幾度、烤多久？ | 戚風蛋糕食譜 | 170°C 烤 35～40 分鐘，竹籤不沾就熟；出爐立刻倒扣放涼至少 1 小時 |
| 3 | 番茄炒蛋要先炒蛋還是先炒番茄？ | 番茄炒蛋食譜 | 先炒蛋到七分熟盛起，再炒番茄到出汁，最後把蛋倒回去拌勻 |
| 4 | 婚假有幾天？ | 請假規定-病假事假婚假喪假產假天數 | 8 天、薪水照給，要在結婚日前 10 天到婚後 3 個月內請完，可以分次請 |
| 5 | 年資三年的特休有幾天？ | 請假規定-特休年假天數 | 滿 3 年未滿 5 年，每年 14 天；沒休完可延到下一年度，再沒休完公司折算工資 |

也驗過、可以加問的：病假請幾天以上要附診斷證明（3 天）、請假要提前幾天申請（事假與特休 3 個工作天前）、味噌湯的味噌什麼時候放（關火後）、滷肉飯要燉多久（小火 60～90 分）、特休沒休完怎麼辦。

## 這份是怎麼做的（走正規管線，不是手寫進資料庫）

1. 在雲端起一台乾淨的地端版容器（同一個 1.4.204-onprem.1 映像檔，換上測試公鑰才能啟用），租戶 `demokb01`，走精靈。
2. 萃取 AI 與向量：精靈設「OpenAI 相容端點＋Ollama 嵌入」，指向一個轉接器，轉給 Cloudflare Workers AI（youlin stage 帳號；萃取用 `llama-4-scout-17b`，與雲端版預設同一支；嵌入用 `bge-m3`，與地端預設同一支）。8 份約 15 次對話、70 句嵌入，用量在免費額度內。
3. 用小幫手本體（`arcrun-collector` 0.18.119 編成 Linux 版，`collector direct --once`）看守 `source/` 資料夾：讀檔 → 萃取 → 組卡 → `rag_ingest_card` 寫卡片與三元組 → 自動產生庫目錄 `00-INDEX` 與資料夾總覽。8 份一輪全部成功。
4. 停容器取出 `/data/kbdb.sqlite`、`vectors.sqlite`，拿掉建置機自己的資料（管理員帳號、登入、金鑰目錄、工作流資產；共 185 列，明細在 `MANIFEST.json` 的 `filter`），寫 MANIFEST。快照裡不含任何金鑰或建置機網址（已逐項查過）。
5. 另起一台乾淨容器，用原封不動的 `install.sh` 走 `up → 啟用 → import → 精靈 → n8n-test`，再問上面那些題目。

第一版把請假規定放在同一份文件，「婚假有幾天」查不到（`found_by=none`）：目錄是用檔名和一句話摘要比對問句的，「婚假」兩個字不在那份的摘要裡。拆成 3 份、檔名寫明假別後才全部查得到。**給客戶的建議也一樣：一份文件講一件事，檔名寫出別人會問的詞。**

已知小瑕疵：「法國長棍麵包食譜」卡的「重點」段有一個簡體字「进」（萃取模型寫的），不影響查詢。

## 改租戶（評估結論：可以改，已實測）

快照裡租戶只出現在三個地方：知識列的擁有者、向量的擁有者、由租戶雜湊算出來的地圖與計數列。
`tools/demo-kb-tool.mjs retarget` 改前兩個、刪掉第三個（引擎第一次讀時從知識列重算）。
實測把 `demokb01` 改成 `ckxt8yr9`、匯進 `ARCRUN_TENANT=ckxt8yr9` 的乾淨容器：5 題全部 `found_by=index`，庫地圖重算後三元組 84、條目 97，與改名前一致。

```sh
mkdir snap && cp kbdb.sqlite vectors.sqlite snap/
T="docker run --rm --user 0 -v $PWD/snap:/s -v $PWD/tools/demo-kb-tool.mjs:/t.mjs:ro --entrypoint node arcrun-private-cloud:1.4.204-onprem.1 --no-warnings /t.mjs"
$T retarget /s <新租戶> && $T manifest /s      # snap/ 裡就是新租戶的三個檔
```

建議下一步（還沒做）：把這一步做進 `install.sh import`（偵測到容器租戶與快照不同時自動改名再匯入，不必 `docker rm` 重建容器），同一包就能直接給任何一台。這要改安裝包，歸 `inkstone/arcrun-rag#339` 那條線。

## 重做（換內容或換模型）

`tools/build.sh`：起乾淨容器 → 啟用 → 精靈 → 小幫手萃取 `source/`。需要 `tools/shim.mjs` 先跑著（讀環境變數 `CF_ACCOUNT`／`CF_TOKEN`，金鑰不落檔）。
做完用 `demo-kb-tool.mjs filter` 與 `manifest` 出快照。
