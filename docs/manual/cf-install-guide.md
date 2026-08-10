# Arcrun RAG — Cloudflare 安裝手冊（v2，封測版）

> **這份是「從原始碼裝到你自己的 Cloudflare 帳號」的手動路徑。**
> 不想碰終端機的話，主線是一鍵安裝器（[rag.arcrun.dev](https://rag.arcrun.dev) 領辨識碼 →
> [install.arcrun.dev](https://install.arcrun.dev) 安裝），結果與本手冊相同：同一套 workflow、同一個 Portal。
>
> 兩條路裝出來的東西一樣，資料都完全屬於你、同事打網址就能用、語意查詢啟用。
> v2 誠實標注哪些步驟仍粗糙，封測期我們陪裝。
>
> **建議由你的 AI（Claude Code 等）照本手冊執行**，你只做「申請帳號、複製 token」兩件人類的事。

## 0. 前置

| 東西 | 去哪拿 | 用途 |
|---|---|---|
| Cloudflare 帳號＋API Token | [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → Create Token（「Edit Cloudflare Workers」模板；另需 D1/KV/Vectorize 權限，Custom Token 勾 Workers Scripts:Edit、Workers KV:Edit、D1:Edit、Vectorize:Edit） | 部署引擎 |
| 會跑指令的 AI | Claude Code／Cursor…（或你自己動手） | 執行以下所有步驟 |
| Google AI Studio API key（**選配**） | [aistudio.google.com](https://aistudio.google.com/apikey) | 只有你要把萃取／問答改用 Gemini 才需要。**預設不用**——萃取與問答都走你自己帳號的 Workers AI，免金鑰 |

本機工具：**Node.js 22+**（與 `install/install.sh` 的硬性檢查一致）、pnpm、git、
`python3` ＋ `pyyaml`（§4 推 workflow 的腳本要用）。

## 1. 取碼與身分設定

```bash
git clone https://github.com/youlinhsieh/Arcrun.git ~/Arcrun
git clone https://github.com/youlinhsieh/arcrun-rag.git && cd arcrun-rag
```

在 `arcrun-rag/.env`（不進版控）寫入：

```bash
CLOUDFLARE_API_TOKEN=<你的 CF token>
CLOUDFLARE_ACCOUNT_ID=<你的 Account ID>
NAMESPACE=<你的資料分區名，如公司代號，小寫英數>   # self-hosted 用明碼 namespace 當身分
```

（要改用 Gemini 才需要多加 `GEMINI_API_KEY=<你的 AI Studio key>`。）

## 2. 部署引擎（一條指令，約 24 個 Worker）

```bash
cd ~/Arcrun/cli && npm install && npm run build
cd <arcrun-rag 目錄>
node ~/Arcrun/cli/dist/index.js init --self-hosted
```

`acr init --self-hosted` 會：部署全部零件與引擎 Worker、建 KV/D1、跑 migration、
seed API/auth recipes 與 portal templates。**冪等**——失敗重跑即可。
（demo 排練實績：24/24 worker 全綠、seed 複跑冪等。）

## 3. 語意查詢（Vectorize）——`acr init` 已自動完成

`acr init --self-hosted` 過程中會問「要不要開語義查詢」（**預設開**，回 `n` 才關）。開著的話它
會在部署 kbdb 前自動呼叫 CF API 建立 Vectorize index（`arcrun-kbdb-embed-m3`，**bge-m3 模型／
dimensions=1024／cosine**）及 4 個 metadata index（owner_id / entry_type / source / library），
並開啟 kbdb 的 vectorize/ai 綁定。**裝完語意搜尋直接可用，無需額外步驟。**
（一鍵安裝器走 `installer/scripts/deploy-all.mjs`，建的是同一顆 index、同一組參數。）

> 🔴 2026-08-03 換過一代：舊 index 名 `arcrun-kbdb-embed`（bge-base-en-v1.5／768 維）
> **中文沒有區辨力**，已換成 `arcrun-kbdb-embed-m3`。新裝的實例一律用新的那顆；
> 舊 index 收不進 1024 維向量，兩者不可混用。

若 CF API token 缺少 Vectorize:Edit scope，安裝日誌會印出警告及手動指令（deploy 本身不受影響）：

```bash
npx wrangler vectorize create arcrun-kbdb-embed-m3 --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed-m3 --property-name owner_id --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed-m3 --property-name entry_type --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed-m3 --property-name source --type string
npx wrangler vectorize create-metadata-index arcrun-kbdb-embed-m3 --property-name library --type string
```

⚠️ Token scope：建 Vectorize 需要 Custom Token 勾 **Vectorize:Edit**（見 §0）。

## 4. 鋪 RAG 層（templates ＋ workflows）

先建 KBDB templates（`triplet` / `entity` / `entity_pending`，冪等；portal_* 那組已由 §2 的
`/init/seed` 灌好）：

```bash
node install/ensure-templates.mjs https://arcrun-kbdb.<你的subdomain>.workers.dev
```

再推四支 workflow——這就是一套用戶實例會用到的全部：

| workflow | 做什麼 |
|---|---|
| `rag_ingest_card` | 收同步器送上來的定稿知識卡 → 寫 KBDB blocks ＋三元組 |
| `rag_takedown_direct` | 資料夾刪檔時把對應內容標 `deprecated` 下架 |
| `rag_chat` | 問答：keyword＋semantic＋graph 三路檢索 → Workers AI 組出帶出處的答案（免金鑰） |
| `graph_neighbors` | 知識圖譜 1..N 跳鄰居查詢 |

```bash
export NS=<你的 namespace>
export CYPHER=https://arcrun-cypher-executor.<你的subdomain>.workers.dev
export KBDB=https://arcrun-kbdb.<你的subdomain>.workers.dev
export HTTPREQ=https://arcrun-http-request.<你的subdomain>.workers.dev
export CODE=https://arcrun-code.<你的subdomain>.workers.dev

bash install/push-demo-workflow.sh workflows/rag-ingest-card.local.yaml
bash install/push-demo-workflow.sh workflows/rag-takedown-direct.local.yaml
bash install/push-demo-workflow.sh workflows/rag-chat.local.yaml
bash install/push-demo-workflow.sh workflows/graph-neighbors.local.yaml
```

（這五個 env 都是必填、沒有預設值——腳本刻意不猜你要打哪個實例。腳本會 sed 佔位值 →
`/cypher/search` 編圖 → POST `/webhooks/named`，等同 `acr push`。）

> ⚠️ **這支腳本只適用「自己從原始碼裝」的實例**（腳本檔頭自己標的判準：無 `bundle_version`）。
> 一鍵安裝器裝出來的實例，workflow 是安裝器直接帶上去的
> （`workflows/*.local.yaml` → `installer/scripts/compile-workflows.mjs` → `installer/src/workflows.json`），
> 要更新那種實例走那條鏈，不是這支。

🚫 **不需要掛任何 webhook，也不需要 Gitea／git repo。** 舊版曾用「知識庫 repo 掛兩條 push
webhook（`rag_extract` / `rag_ingest`）觸發萃取與入庫」那條鏈，已於 2026-07-19 隨架構改版退場
（舊的 Node 版收集器同日刪除）。**現在的入庫來源只有一個：桌面同步器（§6）。**
`workflows/` 底下還留著 `rag-extract*.local.yaml`／`rag-ingest-cards.local.yaml`／`rag-ingest.yaml`，
那是舊鏈的遺留，**用戶實例不推它們**。

## 5. Portal（多人入口）

```bash
# console owner session 登入後，用該 session token 建第一個 admin：
curl -X POST https://arcrun-cypher-executor.<你的subdomain>.workers.dev/portal/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <console owner session token>' \
  -d '{"email":"you@example.com","password":"<夠強的密碼>","display_name":"Admin"}'
```

bootstrap 建第一個 admin（只能跑一次，已有 admin 會回 409）→ `/portal` 登入 →
管理頁發帳號給同事、逐一勾選每個帳號可查詢的庫。
可選 vars（`wrangler deploy --var` 或 dashboard 設）：`CONSOLE_BRAND`（品牌字）、
`PORTAL_SOURCE_WEB_BASE`（來源回溯超連結 base）。

> ℹ️ `PORTAL_UPLOAD_REPO`／`PORTAL_UPLOAD_GITEA`／`PORTAL_UPLOAD_TOKEN` 是舊示範站的「網頁上傳」
> 功能（把檔案寫進一個 Gitea repo），三個都設齊才會啟用。**新裝的實例不要設**——
> 沒設＝上傳頁不存在（nav 隱藏、`/portal/data/upload` 回 404），入庫走 §6 的同步器。

## 6. 同步器（讓「丟檔進資料夾」自動進庫）

這是新裝實例唯一的入庫路徑，也是產品的主要用法（含 docx/pptx/pdf 自動轉檔）。
裝桌面同步器：

- Mac：<https://install.arcrun.dev/download/mac>
- Windows：<https://install.arcrun.dev/download/win>
- 或自己從原始碼編：`collector/cmd/arcrun-app/build-{dmg,mac,msix,win}.sh`

第一次開啟輸入**你的實例網址＋Portal 帳密**、指定要監看的資料夾即可上工
（不必自己下載或編輯 config 檔）。它做的事：content-hash 偵測增刪改 → 本機轉純文字 →
LLM 萃成定稿卡 → POST `rag_ingest_card`；刪檔 → POST `rag_takedown_direct`。
細節見 [collector/README.md](../../collector/README.md)。

## 7. 成功判準

往同步器監看的資料夾丟一份 md → 同步器顯示 `ingested` → 到 `/portal` 登入，一分鐘內：
keyword 搜得到、總圖長出節點、問 AI 拿到帶 [n] 出處的答案。
再把那份檔案從資料夾刪掉 → 同步器顯示 `removed` → 問 AI 應答「知識庫裡沒有這方面資料」。

## 卡住了？

封測期直接把「跑到哪一步＋完整指令＋完整錯誤訊息」丟回給邀請你的人——我們陪裝，
通常當天修。已知粗糙點都標在上面的 ⚠️，你撞到的很可能已在修。
