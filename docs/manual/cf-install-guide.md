# Arcrun RAG — Cloudflare 安裝手冊（v1，封測版）

> 這是唯一推薦的安裝方式：裝在**你自己的 Cloudflare 帳號**（免費層即可起步）。
> 資料完全屬於你、同事打網址就能用、語意查詢啟用。
> demo 站（rag-demo.arcrun.dev）就是用這條路裝出來的——本手冊以那次完整排練
> （`uncle6-deploy-record.md`）為底，v1 誠實標注哪些步驟仍粗糙，封測期我們陪裝。
>
> **建議由你的 AI（Claude Code 等）照本手冊執行**，你只做「申請帳號、複製 token」兩件人類的事。

## 0. 前置三樣（都免費）

| 東西 | 去哪拿 | 用途 |
|---|---|---|
| Cloudflare 帳號＋API Token | [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → Create Token（「Edit Cloudflare Workers」模板；另需 D1/KV/Vectorize 權限，Custom Token 勾 Workers Scripts:Edit、Workers KV:Edit、D1:Edit、Vectorize:Edit） | 部署引擎 |
| Google AI Studio API key | [aistudio.google.com](https://aistudio.google.com/apikey) | LLM 萃取定稿卡／Wiki（免費層夠測試） |
| 會跑指令的 AI | Claude Code／Cursor…（或你自己動手） | 執行以下所有步驟 |

本機工具：Node.js 20+、pnpm（或 npm）、git。

## 1. 取碼與身分設定

```bash
git clone https://git.uncle6.me/Leo/Arcrun.git ~/Arcrun
git clone https://git.uncle6.me/Leo/arcrun-rag.git && cd arcrun-rag
```

在 `arcrun-rag/.env`（不進版控）寫入：

```bash
CLOUDFLARE_API_TOKEN=<你的 CF token>
CLOUDFLARE_ACCOUNT_ID=<你的 Account ID>
NAMESPACE=<你的資料分區名，如公司代號，小寫英數>   # self-hosted 用明碼 namespace 當身分
GEMINI_API_KEY=<你的 AI Studio key>
```

## 2. 部署引擎（一條指令，約 24 個 Worker）

```bash
cd ~/Arcrun/cli && npm install && npm run build
cd <arcrun-rag 目錄>
node ~/Arcrun/cli/dist/index.js init --self-hosted
```

`acr init --self-hosted` 會：部署全部零件與引擎 Worker、建 KV/D1、跑 migration、
seed API/auth recipes 與 portal templates。**冪等**——失敗重跑即可。
（demo 排練實績：24/24 worker 全綠、seed 複跑冪等。）

## 3. 開語意查詢（Vectorize，建議做）

```bash
npx wrangler vectorize create arcrun-kbdb-embed --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed --property-name owner_id --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed --property-name entry_type --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed --property-name source --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed --property-name library --type string
```

⚠️ v1 粗糙點：API Token 常缺 Vectorize scope——`wrangler login`（OAuth）跑上面幾行最穩。
建完 index 後，kbdb 的 wrangler.toml 取消 `[[vectorize]]`／`[ai]` 兩段註解重部 kbdb
（見 `~/Arcrun/kbdb/wrangler.toml` 內註解），再 `POST /embed/backfill {"reindex":true}`。

## 4. 鋪 RAG 層（templates＋workflows）

```bash
node install/ensure-templates.mjs      # KBDB templates（triplet/entity/portal_*）
# workflows：以 workflows/*.local.yaml 為準 sed 佔位值後推（佔位說明見各 yaml 檔頭）
bash install/push-demo-workflow.sh workflows/graph-neighbors.local.yaml
bash install/push-demo-workflow.sh workflows/rag-chat.local.yaml
bash install/push-demo-workflow.sh workflows/rag-extract.local.yaml       # 萃取鏈 dispatcher
bash install/push-demo-workflow.sh workflows/rag-extract-one.local.yaml   # 萃取鏈 per-file 直鏈（兩支一組）
bash install/push-demo-workflow.sh workflows/rag-ingest-cards.local.yaml  # 定稿卡入庫（v2）
# （NS/CYPHER/KBDB/HTTPREQ/CODE/GITEA_*/GEMINI_API_KEY/DOCS_PREFIX/CARDS_DIR/INDEX_PATH
#   環境變數改成你的實例值——腳本檔頭有說明）
```

再到知識庫 repo 的 Settings → Webhooks 掛兩條 push webhook（同一個 repo）：
`…/webhooks/named/<你的NS>/rag_extract/trigger` 與 `…/webhooks/named/<你的NS>/rag_ingest/trigger`
——原稿 push 觸發萃卡、定稿卡 push 觸發入庫，靠路徑前綴各認各的。
前置：`CARDS_DIR` 目錄（放個 .gitkeep）與 `INDEX_PATH` 骨架檔要先存在，否則 contents API 404 斷鏈。

（2026-07-18 更新：萃取鏈 rag_extract → 定稿卡 → rag_ingest v2 已完成打包並全鏈實測——
上傳原稿 → LLM 萃定稿卡 → 自動維護索引 → 卡入庫（blocks＋知識圖譜三元組）→ 刪卡自動下架。）

## 5. Portal（多人入口）

```bash
# console owner session 登入後：
curl -X POST https://arcrun-cypher-executor.<你的subdomain>.workers.dev/portal/admin/bootstrap ...
```

bootstrap 建第一個 admin → `/portal` 登入 → 管理頁發帳號、勾庫權限。
可選 vars（wrangler deploy --var 或 dashboard 設）：`CONSOLE_BRAND`（品牌字）、
`PORTAL_SOURCE_WEB_BASE`（來源回溯超連結 base）、`PORTAL_UPLOAD_*`（網頁上傳）。

## 6. 成功判準

- `/portal` 登入 → 上傳一份 md → 一分鐘內：keyword 搜得到、總圖長出節點、問 AI 拿到帶 [n] 出處的答案。

## 卡住了？

封測期直接把「跑到哪一步＋完整指令＋完整錯誤訊息」丟回給邀請你的人——我們陪裝，
通常當天修。已知粗糙點都標在上面的 ⚠️，你撞到的很可能已在修。
