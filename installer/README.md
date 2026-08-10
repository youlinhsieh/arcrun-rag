# Arcrun RAG 一鍵安裝器（installer/）— SDD ingest-hash-trigger task 13 第 1 刀

把既有 `acr init --self-hosted`／`cli/src/lib/deploy.ts` 產品化成「Deploy 按鈕」流程。
**這不是新 workflow、也不重寫任何 RAG 邏輯**——只是搬運既有部署邏輯與既有 workflow yaml。

## 架構（設計主圖 one-click-installer-design.md C 段）

```
[landing 頁] --填 email--> [中央發碼 API]  (首刀已 live)
      │ Deploy 按鈕（url=公開鏡像，subdirectory=installer）
      ▼
[CF dashboard 設定頁]
   自動開通 9 KV + D1 arcrun-kbdb（全綁「安裝器 worker」）
   + secrets 欄：ARCRUN_CODE / GEMINI_API_KEY /（選配）CF_API_TOKEN
      │
      ▼
[Workers Builds 容器]  自訂 deploy command：
   node installer/scripts/deploy-all.mjs && npx wrangler deploy --config installer/wrangler.jsonc
   # 鏡像已在容器（含 Arcrun 的 .component-builds/*.wasm）→ 免下載
   # deploy-all 重用 deploy.ts 注入邏輯，用 Builds 自動 token 逐顆部 24 個平台 worker
   # 最後 wrangler deploy 部安裝器本體
      │
      ▼
[安裝器 worker]（用戶打開的 URL＝工地主任）
   GET  /              辨識碼閘 → 進度 checklist（前端輪詢 /api/status）
   GET  /api/state     {verified}
   POST /api/verify-code  打中央 API 驗碼 + 綁 email（過閘前只開放這個）
   GET  /api/status    實查 24 worker /health、D1 表、kbdb templates、5 workflow（誠實逐項不假綠）
   POST /api/finish    冪等補完：D1 migration（TEST_D1 binding）→ /init/seed → templates×3 → 推 5 workflow
   POST /api/console   精靈代理 console setup→login→portal bootstrap（帳密用戶輸入，安裝器不存）
```

## 檔案

| 檔 | 作用 |
|---|---|
| `scripts/deploy-all.mjs` | 施工隊：非互動、env 驅動、讀本地 repo 樹，注入各 worker toml 後 `wrangler deploy`。`DRY_RUN=true` 只印清單。 |
| `scripts/compile-workflows.mjs` | 打包期：把 `workflows/*.local.yaml` 抽成 `src/workflows.json`（讓 worker 零依賴、不帶 YAML parser）。 |
| `scripts/compile-migrations.mjs` | 打包期：把 Arcrun `kbdb/migrations/*.sql` 切成單語句陣列 `src/migrations.json`（worker 走 D1 binding 逐句跑）。 |
| `src/index.js` | 安裝器 worker 本體（純 module worker，零 runtime 依賴）。 |
| `src/workflows.json` / `src/migrations.json` | 打包期產物（committed）。改上游 yaml/sql 後需重跑對應 compile 腳本。 |
| `wrangler.jsonc` | 安裝器 worker 設定＋按鈕宣告的 9 KV + D1 資源。 |
| `scripts/DRYRUN-SAMPLE.txt` | 離線驗收留樣（deploy-all dry-run 輸出，24 worker / 9 KV 清單完整）。 |

## Builds deploy command 設定

在 CF dashboard 的 Workers Builds → Build configuration：

- **Deploy command**：`node installer/scripts/deploy-all.mjs && npx wrangler deploy --config installer/wrangler.jsonc`
- **Root directory**：repo 根（deploy-all 會自動往上找含 `.component-builds/` 的目錄；或設 `ARCRUN_REPO_ROOT`）。

> ⚠️ 前提：**部署用的公開鏡像必須同時含 Arcrun 的平台 worker 樹**（`.component-builds/*.wasm` + `cypher-executor/`、`registry/`、`kbdb/`、`mcp/`、`registry/components/code/`）。
> 24 個 worker 的原始碼在 Arcrun repo，不在 arcrun-rag。鏡像打包方式見「leo 手動閘 ①」。

## 環境變數 / secrets 清單

deploy-all.mjs（Builds 容器內；多由按鈕開通資源後轉交）：

| 變數 | 必填 | 說明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 是 | Builds 自動 token（Scripts/KV edit）或用戶自備 |
| `CF_ACCOUNT_ID` | 是 | 注入各 worker `CF_ACCOUNT_ID` var |
| `WORKER_SUBDOMAIN` | 建議 | workers.dev subdomain（注入 cypher `WORKER_SUBDOMAIN`／`KBDB_BASE_URL`） |
| `D1_DATABASE_ID` | 建議 | 按鈕開通的 arcrun-kbdb D1 id（注入 kbdb toml） |
| `KV_<BINDING>` ×9 | 是 | 9 把 KV 的 namespace id（`KV_WEBHOOKS`、`KV_CREDENTIALS_KV` …，binding 名見 deploy.ts `REQUIRED_KV_NAMESPACES`） |
| `ARCRUN_REPO_ROOT` | 選配 | Arcrun 部署物 repo 根；不設則自動偵測 |
| `KBDB_EMBED` | 選配 | `true` → 開語義查詢（取消 kbdb vectorize/ai 註解） |
| `DRY_RUN` | 選配 | `true` → 只印部署清單不真部署（離線驗收） |

安裝器 worker（`wrangler.jsonc` vars + Deploy 按鈕 secrets 欄）：

| 名 | 類型 | 說明 |
|---|---|---|
| `LANDING_VERIFY_URL` | var | 中央驗碼端點（指向官方 landing＝**正確的預設值**，別亂改） |
| `WORKER_SUBDOMAIN`／`CYPHER_BASE`／`KBDB_BASE`／`HTTP_REQ_URL`／`CODE_URL` | var | 實例位址（留空則由 subdomain 推導；Builds 可 `--var` 覆寫） |
| `NAMESPACE`／`LLM_MODEL` | var | 資料分區標籤／LLM 模型 |
| `ARCRUN_CODE` | secret | 封測辨識碼（去 landing 換取） |
| `GEMINI_API_KEY` | secret | Google AI Studio key（aistudio.google.com/apikey）；推 RAG workflow 用 |
| `CF_API_TOKEN` | secret（選配） | 給第 3 刀代設 worker secrets／建 Vectorize metadata index |

> D1 migration 走安裝器自己的 `TEST_D1` binding（零 CF token）＝設計指定的唯一「安裝器直碰 D1」例外（建表）。
> KBDB 其餘一律走 API（namespace），不直碰 D1。

## leo 的兩個手動閘（本刀不碰、需人類做）

1. **arm GitHub 建公開 repo `youlinhsieh/arcrun-rag-installer`**，把「Arcrun 平台 worker 樹 + 本 `installer/`」打包推上去當 Deploy 按鈕的 `url` 來源。
   本刀**不碰 GitHub**（D20 防 flag）；打包/鏡像刷新節奏見設計 D-5。
2. **完整 e2e 需一個乾淨的 CF 帳號跑一次**（真按一次 Deploy 按鈕 → Builds 部 24 worker → 開安裝器 → verify → finish → console）。
   本刀只在乾淨帳號能做，**uncle6 帳號不可用**——那是官方件所在的帳號，同名 deploy 會蓋掉官方安裝器／landing，
   且部署官方件＝出貨動作，需 leo 開閘（見 repo `CLAUDE.md`「範例在哪、測試在哪」）。

## 離線驗收狀態（誠實標注）

**已離線驗過**（本機 wrangler dev --local + deploy-all DRY_RUN）：

- `deploy-all.mjs` DRY_RUN：掃出 **24 worker（tier1=20 + tier2=4）**、**KV=9/9**、注入摘要逐項正確（cypher 注入 7 KV + subdomain + CF_ACCOUNT_ID + D1 + KBDB_BASE_URL；kbdb 注入 D1；strip routes/r2/ai）。斷言 PASS，輸出見 `scripts/DRYRUN-SAMPLE.txt`。
- 安裝器 worker 全端點回合理 JSON：辨識碼閘擋住 /api/status（403）；verify 未設 landing url 誠實報錯；/api/status 無實例時逐項顯 false（誠實不假綠）；**/api/finish 的 D1 migration 16 句在本機 TEST_D1 全跑成功，跑完 /api/status 的 d1_tables 4 表翻 true**（證明自檢是實查）；seed/templates/workflows 無實例時誠實回失敗；/api/console 驗證輸入並誠實回報缺 cypher base。

**未跑真實 e2e，待乾淨 CF 帳號**：真按 Deploy 按鈕、Builds 實部 24 worker、對活實例做 finish/console 全鏈——皆未驗（見「leo 手動閘 ②」）。設計 D-3/D-4（按鈕對子目錄+多資源宣告的實際行為、Builds 自訂 deploy command 部 23 顆的穩定性）屬第 0 刀驗證項，本刀假設其成立。
