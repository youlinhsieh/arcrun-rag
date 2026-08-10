# MIGRATION：舊 Gitea push payload → 新 collector-trigger.v1

> 給改寫 workflow（SDD `ingest-hash-trigger` task 4）的人看。
> 舊真相源＝`workflows/rag-ingest-cards.local.yaml`（名 `rag_ingest`），現行只消費
> `input.commits[].added/modified/removed`、`input.after`、`input.repository.full_name`。
> 新真相源＝`schemas/collector-trigger.v1.schema.json`。
> **觸發端點不變**：`POST {cypher}/webhooks/named/{ns}/rag_ingest/trigger` 是 arcrun named-webhook
> 原生機制，design 鐵律段明言保留——換的是「誰打它、帶什麼 payload」，不是端點本身。

## 逐欄對照

| 舊欄位（Gitea push payload） | 新欄位（collector-trigger.v1） | 說明 |
|---|---|---|
| `input.commits[].added[]`（路徑字串陣列） | `events[]` 內 `type:"added"` 的事件 | 路徑＝`event.path`。新增資訊：`source_hash`（冪等鍵）、`size`、`r2_key`（原稿已在 R2）——舊 payload 全沒有，workflow 不用再打 Gitea raw API 撈內容。 |
| `input.commits[].modified[]` | `events[]` 內 `type:"modified"` | 同上。冪等判準從「腳本 GET+PATCH 湊」升級為 `source_hash` 比對（server 端）。 |
| `input.commits[].removed[]` | `events[]` 內 `type:"removed"` | `event.source_hash`＝最後已知 hash，下架反查用。**注意**：舊鏈裡「改名」會拆成 removed＋added（誤下架＋重萃）；新 payload 由 collector 先配對成 `renamed`，removed 分支不會再收到改名檔。 |
| （無對應——舊 payload 表達不了） | `events[]` 內 `type:"renamed"`（`old_path`→`path`） | **新類型**。消費端只更新路徑映射（metadata_json.$.source_path），不 retire、不重萃、不重傳（R5）。改寫 workflow 時必須新增這條分支。 |
| `input.after`（push 後 commit SHA） | **作廢** | 舊用途＝拼 Gitea raw URL 的 `?ref=`。內容定址改為 per-event `source_hash`／`r2_key`，commit 層身分不存在了。 |
| `input.repository.full_name` | `folder_id` | 舊用途＝拼 raw URL 的 repo 段＋事件溯源。新語意＝被勾選資料夾的穩定 UUID（manifest 生成），repo 概念整個移除。 |
| （collect_changed 自組的）`enc_path`、`ref`、`repo_full` | **作廢** | 這些是為了打 `GET {gitea}/api/v1/repos/{repo}/raw/{path}?ref=` 而生。新鏈原稿在 R2 `raw/<sha256>`，`fetch_raw` 節點改打 R2（或由 ingest API 帶 `content` inline），Gitea API 呼叫整段刪除。 |
| （無） | `schema_version`（const 1） | 消費端先驗版本再處理。 |
| （無） | `warnings[]`（如 `mass_delete_guard`） | R6 防呆：removed 比例超門檻時 removed 全壓下、只發警告。workflow 收到 warnings 應轉 notify，不執行下架。 |
| （無） | `generated_at`、`root`（選填） | 除錯/顯示用，消費端不得依賴 `root`。 |

## 改寫 workflow 時的行為差異備忘

1. **`fetch_raw` 換源**：Gitea raw API → R2 `raw/<hash>`（或 ingest 請求 inline `content`）。`__GITEA_BASE__`／`__GITEA_TOKEN__` 佔位隨之作廢。
2. **`collect_changed` 大幅簡化**：不再解析 commits 陣列/去重/組 URL——collector 已把事件整理好，workflow 只按 `type` 分流。
3. **新增 renamed 分支**：只 PATCH 路徑類 metadata，零 LLM 呼叫（驗收 R5：改名後無新萃取）。
4. **removed 分支照舊語意**（blocks＋triplets 標 deprecated，含 source_uri 比對治 G9），但來源清單改讀 `events[type=removed]`，且要先看 `warnings` 有沒有 `mass_delete_guard`。
5. **冪等移到 server 端**：kbdb ingest 端點以 `source_hash` 為鍵（見 `kbdb-ingest-request.v1.schema.json`），workflow 不再自己 GET+PATCH 湊冪等。
