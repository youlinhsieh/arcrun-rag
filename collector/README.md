# collector

> ✂️ **legacy Node 版（Gitea push 鏈）已於 2026-07-19 刪除**（SDD `ingest-hash-trigger` task 4：
> 「Gitea webhook 接收端程式碼與路由已刪除（git 記錄可查）」）。`index.js`/`transform.js`/
> `git-sync.js`/`config.js` 那套 watch → git commit/push → Gitea webhook 鏈要考古請看 git 歷史
> （本檔同 commit 之前的版本有完整說明）。現役＝Go 版 hash 偵測 collector，
> **不經 git、不經 Gitea**：scan → R2 上傳 → 直打 arcrun named-webhook。
> Markitdown 轉檔（docx/pptx/pdf→md）能力隨 legacy 一併退場，回歸產品化段 task 11 重做進 Go 版。

## Go 版：hash 偵測 collector（SDD ingest-hash-trigger）

```
collector scan   --root <知識資料夾> --manifest <manifest.json> [--max-removed-ratio 0.4] [--dry-run]
collector upload --root <知識資料夾> --manifest <manifest.json> [--max-removed-ratio 0.4] [--dry-run]
collector sync   --root <知識資料夾> --manifest <manifest.json> [--max-removed-ratio 0.4] [--dry-run]
```

一次掃描：走訪資料夾（先只認 .md/.markdown/.txt/.docx/.pptx/.pdf）→ mtime+size fast-path
（沒變→沿用 manifest hash；變了才算 sha256）→ 對照 manifest 產出事件 → 事件 JSON
（符合 `schemas/collector-trigger.v1.schema.json`）輸出 stdout → 更新 manifest（`--dry-run` 不寫）。

- **事件分類順序（design §3）**：先把本輪 removed×added 以 content_hash 配對成 `renamed`
  （只更新路徑映射，不 retire、不重萃）；再分 added / modified / removed。
- **大量刪除防呆（R6）**：removed 數 > manifest 條目 × 40%（`--max-removed-ratio` 可調）→
  removed 全部不執行、manifest 條目保留、輸出 `mass_delete_guard` 警告。
- **重試語意**：`ingested_hash` 只會在整條 ingest 鏈成功後回寫（回寫鉤子＝`Manifest.MarkIngested`，
  由 `sync` 在觸發回 2xx 後呼叫）；掃描與 R2 上傳都不寫它，所以「偵測過但未成功 ingest」的檔
  每輪都會重發 added/modified——這是設計（design §2），不是 bug；R2 端靠存在檢查 no-op，
  不會重複上傳。
- daemon 常駐（launchd）＝產品化段 task 11。

### `upload`：R2 content-addressed 原稿上傳（SDD task 3，design §4）

`upload`＝`scan`＋把本輪 **added/modified** 的原稿上傳 R2（renamed/removed 內容未變/已留底，不上傳）。

- **走 Cloudflare REST API**（`PUT /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}`，
  Bearer token）——不用 S3 sigv4，token 模型跟產品其他部分一致（客戶本來就有 CF API token）。
- **key＝`raw/<sha256hex>`**（不含 `sha256:` 前綴，對齊 `schemas/collector-trigger.v1.schema.json` 的 `r2_key`）。
- **冪等**：每 key 先做存在檢查，已存在＝`skipped_exists` 不重傳（content-addressed 天然去重）。
  ⚠️ CF REST API 的 objects 端點**不支援 HEAD**（2026-07-19 live 實測回 405），
  存在檢查走 `GET`＋`Range: bytes=0-0`（存在＝200/206 只讀 1 byte，404＝不存在）。
- **完整性**：上傳前重算 sha256 核對事件 hash；檔案在掃描後被改動＝該筆 `failed` 不上傳
  （不能把新內容塞進舊 hash 的 key），下輪重掃自然帶新 hash。
- **失敗語意**：任一筆 `failed` → exit code 1；manifest 照存（content_hash 反映現況、
  `ingested_hash` 不動）＝下輪自動重試。上傳成功也**不**標 ingested——上傳只是鏈的第一環。
- `--dry-run`：不碰網路、不寫 manifest，只列 `planned` 上傳清單。
- 輸出 JSON：`{"trigger": <collector-trigger payload>, "uploads": [{path, r2_key, status, error?}]}`，
  status＝`uploaded`／`skipped_exists`／`failed`／`planned`。

設定（**只走環境變數，絕不落 repo/code**）：

| 變數 | 說明 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare 帳號 ID |
| `CF_API_TOKEN` | 有該 bucket R2 read+write 權的 API token |
| `R2_BUCKET` | 目的 bucket 名（demo＝`arcrun-rag-raw-demo`） |
| `CF_API_BASE` | 選填，API 基底覆蓋（測試用；預設 `https://api.cloudflare.com/client/v4`） |

測試：`go test ./...`——掃描七項（五情境＋fast-path＋manifest 往返）＋上傳七項
（新檔上傳／同 hash 重傳 no-op／上傳失敗不標 ingested＋重試／非內容事件不上傳／
hash 不符不上傳／env 缺漏報錯／MarkIngested 鉤子），httptest mock 對齊真 API 行為（HEAD 405）。
live e2e（2026-07-19）：uncle6 帳號 `arcrun-rag-raw-demo` bucket 真上傳→重傳 no-op→
`wrangler r2 object get --remote` 下載 diff 一致、sha256 與 key 相符，全通。


### `sync`：一條龍（SDD task 4）＝ scan → upload → 觸發 ingest → 成功回寫

`sync`＝`upload` 再加最後一步：把整輪的 collector-trigger.v1 payload POST 到
`ARCRUN_TRIGGER_URL`（arcrun named-webhook 完整 URL，如
`{cypher}/webhooks/named/{ns}/rag_ingest/trigger`——端點是 arcrun 原生觸發機制，
design 鐵律段明言保留；被刪掉的是「Gitea push 事件」這個來源語意）。

- **回寫語意**：HTTP 2xx 才對本輪送出的 added/modified/renamed 檔呼叫 `Manifest.MarkIngested`；
  非 2xx／網路錯不回寫＝下輪自然重試（exit 1）。
- **上傳失敗的事件不送**：schema 約定 added/modified 的 `r2_key`＝原稿已在 R2，上傳失敗還送
  ＝叫消費端去 404 → 該事件本輪擋下（`dispatch.dropped_paths`），下輪重試補送；同路徑的
  renamed 也不回寫（防「內容從未上 R2 卻被標 ingested」）。
- **防呆警告輪照送**：mass_delete_guard 觸發時 removed 事件已被壓下，但 payload 連同
  `warnings[]` 照送——消費端看得到警告、不執行下架；notify 呈現歸 collector 端輸出／daemon。
- **無變更輪不發送**（`skipped_no_changes`）。
- 輸出 JSON：`{"trigger": <實際送出的 payload>, "uploads": [...], "dispatch":
  {status, http_status?, error?, marked_count, dropped_paths?}}`。

設定＝upload 的三個環境變數＋`ARCRUN_TRIGGER_URL`（皆絕不落 repo/code）。

測試：`go test ./...` 19/19——掃描 7＋上傳 7＋sync/trigger 5（成功回寫＋無變更輪不重發／
失敗不回寫＋修復後重試成功／防呆警告輪照送 warnings 零事件／上傳失敗事件擋下＋renamed
連坐不回寫／URL env 驗證），全部 httptest mock（**未實跑雲端 e2e**——等切換日與 leo 一起驗）。

## `direct`：daemon 直送萃取、無 R2 同步模式（SDD task 11）

`direct`＝**產品承諾核心的最短路徑**：監看資料夾 → 偵測新增/改動檔（沿用 `Scan` 的 hash 差異
偵測，與 `sync` 同一套）→ 讀檔內容 **inline POST** 進實例的 `rag_ingest_direct` workflow
（LLM 萃卡 → 機械切塊 → 寫 kbdb，**全在 Arcrun workflow**）。刪檔 → POST `{page_name, path}`
進 `rag_takedown_direct`（按 page_name 標 kbdb blocks/triplets `deprecated`）。

**繞開 R2/Gitea**：既有 `sync` 走 collector→R2→`rag_ingest`（要 R2 bucket＝綁卡），`rag_extract_one`
又要 Gitea repo 落卡。`direct` 兩者都不要——落地「丟檔進資料夾 → AI 查得到」的零綁卡版。

```
collector direct --config <config.json> [--once] [--dry-run]
```

- `--once`：掃一輪即退出（測試/cron）；預設常駐輪詢（`poll_interval_sec`，純 stdlib ticker，跨平台）。
- 設定檔（JSON，見 `install/direct-config.sample.json`）：`watch_folder` / `manifest` /
  `cypher_url` / `namespace` / `api_key`（空＝namespace）/ `library`（空＝kb）/
  `poll_interval_sec`（空＝5）/ `max_removed_ratio`（空＝0.4）/ `ingest_workflow`
  （空＝`rag_ingest_direct`）/ `removed_workflow`（空＝`rag_takedown_direct`）。
- **dogfooding（D29 daemon 薄殼豁免）**：本模式只「監看／讀檔／算 hash／HTTP POST」原生 Go——
  萃取/切塊/RAG 一律在實例 workflow，daemon 內零 LLM/切塊邏輯。
- **回寫語意**：POST 回 2xx 才 `Manifest.MarkIngested`（下輪不重送）；非 2xx 不回寫＝下輪重試。
- **大量刪除防呆**：沿用 `Scan` 的 `mass_delete_guard`（removed > manifest×`max_removed_ratio`
  → 本輪不下架、只回報警告）。

**配套 workflow**（`workflows/rag-ingest-direct.local.yaml` / `rag-takedown-direct.local.yaml`；
用 `install/push-demo-workflow.sh` 推，env 指向目標實例的 CYPHER/KBDB/HTTPREQ/CODE/LLM_MODEL/LIBRARY）：
blocks/triplets 寫法與 `rag_ingest` 逐欄一致 → `rag_chat` 一視同仁檢索得到。
> ⚠️ 下架另立 `rag_takedown_direct` 而非重用 `rag_ingest` removed 分支：後者在 `collect_changed`
> 有 `__CARDS_PREFIX__` 閘，direct 模式的檔在資料夾根會被擋掉零下架（2026-07-20 live e2e 實撞）。

**youlin live e2e 實證（2026-07-20，非 mock）**：
- 丟 `請假規則.md`/`差旅政策.md` → daemon `ingested`(200) → `rag_chat` 帶出處正確作答。
- 刪 `差旅政策.md` → daemon `removed`(200) → `rag_chat`「知識庫裡沒有這方面資料」（blocks 全 deprecated）。

**跨平台**：純 stdlib、零 CGo、輪詢式偵測（不依賴 fsnotify）→ `GOOS=darwin GOARCH=arm64` /
`GOOS=windows GOARCH=amd64` 直接交叉編譯（各約 5.6M / 5.9M）。托盤殼（Wails）＋Mac `.app`
簽章/TCC 是下一刀，且 Mac 打包要在 Mac 上做。
