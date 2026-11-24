出貨報告　release 1.4.296／小幫手 0.18.124／安裝器 1.0.106　共 29 站（上次（1.4.295／小幫手 0.18.124／安裝器 1.0.106）29 站　無增減）
來源（stage）＝Arcrun@ff655d248683　｜　來源（prod）＝Arcrun@ff655d248683
機器（stage）＝b603c18c637e　｜　機器（prod）＝b603c18c637e

🧾 stage 佇列：上一顆（線上當時）＝ff655d248683；這版多帶 1 筆，票：inkstone/Arcrun#510

| 件次 | 項目 | stage | prod |
| --- | --- | --- | --- |
| 1 | 對齊目標（打錯目標打不進去） | ✅ | ✅ |
| 2 | 點名已交回卻沒進這一版來源的分支（緊急或放太久的不處理就切不了版） | ✅ | ✅ |
| 3 | 掃公開樹：說明這一版的東西還成不成立（README／安裝手冊／Portal 導覽…） | ✅ | ✅ |
| 4 | 把本機最新已發佈的 daemon 產物搬進 bundle | ⬜ | ⬜ |
| 5 | 查證這一版的 daemon 真的在成品裡（逐檔算 sha256，不是比版號字串） | ✅ | ✅ |
| 6 | 核對 changelog 宣告的那一版，成品就是照這份源碼打的（比指紋，不查歷史） | ✅ | ✅ |
| 7 | 向 Arcrun 取用編好的零件（這一站不編任何東西） | ✅ | ✅ |
| 8 | 確認這些零件不是我們自己編的（D91：成品只有一個產地） | ✅ | ✅ |
| 9 | 核對 bundle 內容＝唯一真相源（stage 與 prod 因此必然一一對應） | ✅ | ✅ |
| 10 | 產生更新畫面那一行（來源＝changelog） | ⬜ | ⬜ |
| 11 | 算版本並過機械閘（內容一變版本一定變；跨目標共用同一個號碼） | ✅ | ✅ |
| 12 | 確認這版已經寫進說明文件（缺了就中止，不安靜跳過） | ✅ | ✅ |
| 13 | 海關：這一版有沒有有效的意圖完成簽證（只 prod 查；缺了退回並列出缺哪些票） | ⬜ | ✅ |
| 14 | bundle repo 的 README 由零件清單算出來（不留會過期的手寫數字） | ⬜ | ✅ |
| 15 | 把產物寫進 bundle repo 的版控 | ⬜ | ✅ |
| 16 | 推上 bundle repo | ✅ | ✅ |
| 17 | 換安裝器釘子（真身是 wrangler.toml 的 vars） | ⬜ | ✅ |
| 18 | 部署安裝器（帳號由登錄簿釘死） | ⬜ | ✅ |
| 19 | 建＋部署說明文件站（並驗它真的是這份原始碼建的） | ✅ | ✅ |
| 20 | 部署郵差（忘記密碼代寄），並驗證它真的接得起來 | ✅ | ✅ |
| 21 | 讓送貨管道拿到新版並確認它真的收斂了 | ✅ | ✅ |
| 22 | 驗收（用戶端視角，不是部署訊息） | ✅ | ✅ |
| 23 | 在這個環境對應的 repo 留一份使用者點得到的版本發佈（每條版本線各一筆） | ⬜ | ✅ |
| 24 | 回頭查證：每條版本線在產品 repo 都真的有版本發佈（不聽上一站說） | ✅ | ✅ |
| 25 | 走使用者那條路更新 youlin（安裝頁認得已授權帳號＋Portal「立即更新」＋讀回版號與耗時） | ✅ | ⬜ |
| 26 | 讓 youlin 實例真的換到這一版（acr update＋讀回 /health 版號與 commit） | ✅ | ⬜ |
| 27 | 正門：從 MCP 走一遍寫意圖到跑起一條工作流（任何一環斷＝這版不算 stage 驗過） | ✅ | ⬜ |
| 28 | 把這一版寫進 AHub 的 stage 現況（只在出貨那一下寫一次） | ✅ | ⬜ |
| 29 | 把這一版寫進 AHub 的 prod 現況（出 prod 那一下寫一次） | ⬜ | ✅ |

真的做事的站：stage 20／29 站（與上次相同）　｜　prod 23／29 站（與上次相同）

⬜ 跳過的站（15 筆）——**這一欄要自己看過**：「登錄簿宣告本目標沒這東西」與「已經是這一版、沒事可做」是正常，其他都要當成漏做：
   · stage｜daemon-sync：bundle 已委任 0.18.124；內容是否真的到位由下一站 daemon-check 逐檔查證
   · stage｜notes：已是最新：Mac 小幫手整理大 PDF 不再被系統中途砍掉（細節見說明文件）
   · stage｜visa-gate：stage 沒宣告 visaGate（不是 prod）：測試版不查簽證
   · stage｜readme：README 已是最新（零件清單與版本都沒變）
   · stage｜commit：工作區乾淨——這一版的產物已經在版控裡了
   · stage｜pin：釘子沒動（built 2026-11-24）；安裝器原始碼指紋 b54d35f4bccf（烙在 version.mjs，不寫這裡）
   · stage｜deploy：線上已是 1.4.296／pin 2803082／安裝器原始碼 b54d35f4bccf 未變，且釘子沒動 ⇒ 不重複部署
   · stage｜release-record：⏭ 內部版本物件｜安裝器 1.0.106 已存在：https://arcrun-cypher-executor.leo21c.workers.dev/inkstone/arcrun-rag/releases/tag/installer-1.0.106
   · stage｜prod-record：不是 prod 目標：不寫 prod 現況
   · prod｜daemon-sync：bundle 已委任 0.18.124；內容是否真的到位由下一站 daemon-check 逐檔查證
   · prod｜notes：已是最新：Mac 小幫手整理大 PDF 不再被系統中途砍掉（細節見說明文件）
   · prod｜user-path-update：本目標沒宣告 userPathUpdate（不是 stage）：prod 的那一次要 geek6688 授權、由 leo 簽 prod 之後才跑（inkstone/arcrun-rag#163）
   · prod｜instance-update：本目標沒宣告 instanceUpdate（不是 stage）：實例不由出貨線更新（prod 的 leo21c 由 leo 在 Portal 按「立即更新」）
   · prod｜front-door：本目標沒宣告 frontDoor（登錄簿）：不由出貨線走正門（prod 的 leo21c／geek6688 由總管用 MCP 連線各走一次，貼票）
   · prod｜stage-record：本目標沒宣告 stageQueue（不是 stage）：不寫 stage 現況

件數：stage 29 站　｜　prod 29 站
✅ 兩欄件數相同（29 站）——暫存站有的，上架也有
