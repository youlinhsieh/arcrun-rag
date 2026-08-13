# `shared/resource-rule` — 「這個實例該用哪些資源」的唯一一份規則

> leo 2026-08-12：
> ①「如果你沒有裝，就是新的；**如果你已經有，原來叫什麼名字就繼續用下去**。」
> ②「**根本就不應該在 CLI，我要的是一個大家都可以用到的規則。**」

① 是規則本身，② 是它該住哪裡。這個目錄就是 ②。

---

## 1. 規則（三句話）

判準是「**這顆 worker 現在綁著誰**」，**不是**「有沒有叫這個名字的資源」。

1. **已部署的 worker 上綁著什麼，那就是事實** → 原封不動沿用，不管那顆資源叫什麼名字。
2. **只有「確定沒有任何人綁過它」才准新建**（新版本新增的 binding、或真的全新帳號）。
3. **只要有一點說不準就整趟停手**——讀不到綁定／綁著的資源不見了／同一個 binding 指向兩顆／
   該更新的 worker 一顆都不在 ⇒ **什麼都不建、什麼都不部署**，把話說清楚讓人來判斷。

`planResources()`（不寫入，只出計畫）與 `applyResourcePlan()`（有 blocker 就拒絕執行）分兩段，
所以「被擋下的時候一顆資源都不會被建出來」是**結構上的保證**，不是靠誰記得寫 early return。

---

## 2. 為什麼在這裡，不在 cypher-executor 的 API

`.claude/rules/07-thin-shell.md` 的標準答案是「能力放 API」。這一條**不走那條路**，理由是自舉：

| 問題 | 說明 |
|---|---|
| **cypher 可能還不存在** | 這條規則要在「決定怎麼裝」的當下就用得到，而安裝器的工作正是把 cypher 生出來。把規則放進 cypher = 要先有雞才能有蛋。 |
| **輸入是使用者自己的帳號狀態** | 判斷的依據是使用者 Cloudflare 帳號上的綁定。送去平台託管的 worker 換一個答案 ⇒ ①「能不能安裝」綁在平台是否活著，②使用者的帳號拓撲交給第三方。 |
| **它根本不需要是服務** | 這是**純函式**：唯一的 IO 由呼叫端注入（`ResourceApi`）。薄殼原則要求「能力只實作一次」，不是「能力一定要是 HTTP」。 |

所以形態是**一份零依賴的 ESM**——Node 18+ 與 Cloudflare Workers runtime 都能直接 import，
不必編譯、不必連網、不必先有任何 arcrun 元件活著。

其他評估過的形態：**共用 npm 套件** → 要多發一個 package + token，且安裝器得先 `npm i` 才能判斷，
自舉問題只是換個位置；**做成一顆零件** → 得用 TinyGo/AssemblyScript 重寫一次，那正是「第二份實作」。

---

## 3. 檔案

| 檔案 | 內容 |
|---|---|
| `rule.mjs` | 規則本體：`planResources` / `applyResourcePlan` / `parseWranglerRequirements` ＋ 把 CF 回應讀成事實的 `normalizeLiveBindings` / `normalizeLiveVars` |
| `cf-resource-api.mjs` | `ResourceApi` 的 CF REST 實作（只用 global `fetch`）。**眼睛也要共用**——見下 §5 |
| `installer-entry.mjs` | 安裝器唯一該碰的入口：`resolveInstanceResources()` |
| `tests/fixture-account.mjs` | 假 Cloudflare 帳號（`fetch` 替身）＋三種情境 |
| `tests/demo.mjs` | `node shared/resource-rule/tests/demo.mjs`——零依賴、零建置就能跑的示範 |

🔴 **零依賴是硬規則**：只准 import 同目錄的兄弟檔，不准碰 `node:*`。
有外部依賴就會有某條路吃不到它。`cli/tests/single-implementation.test.ts` ③ 會擋。

---

## 4. 兩條路怎麼取用

### 安裝器 / 任何 Worker（不需要副本）

安裝器本來就會下載本 repo 的 archive 當部署來源（`.claude/rules/05-deploy-convention.md`
「WASM 來源」），`shared/resource-rule/` 就在那份 archive 裡：

```js
import { resolveInstanceResources } from './shared/resource-rule/installer-entry.mjs';

const r = await resolveInstanceResources({
  accountId, apiToken,
  wranglerTomls: [cypherToml, registryToml, mcpToml, kbdbToml],  // toml 的「內容」，不是路徑
  mode: isUpdate ? 'update' : 'init',
});

if (r.blocked) {
  // 🔴 一顆資源都沒被建。把 r.blockers 原文顯示給使用者，**不要自己「試著繼續」**。
  return showAndStop(r.blockers);
}
// r.bindings  : { 'kv_namespace:WEBHOOKS': 'kvid-…', 'd1:DB': 'uuid-…', … }
// r.origin    : { 'kv_namespace:WEBHOOKS': 'adopted' | 'created', … }
// r.liveVars  : { 'arcrun-cypher-executor': { ARCRUN_BUNDLE_VERSION: '1.4.33', … } }  ← #106
```

**安裝器不准自己判斷要不要建資源**，也不准自己解讀 CF 的 binding 回應。只呼叫這一支。

### `acr` CLI（需要一份鏡射）

`arcrun` 是獨立 npm 套件，`npm pack` 打不進套件目錄外的檔案 ⇒ 套件裡必須自帶一份。
`cli/src/lib/resource-rule/` 就是本目錄的**逐位元組鏡射**，由
`node scripts/sync-resource-rule.mjs` 產生。

**要改規則就改這個目錄，然後重跑 sync。** 手改鏡射會被擋下：
`npm run build` 與 `npm test` 都先跑 `sync-resource-rule.mjs --check`，
差一個位元組就 exit 1（同 `cli/harness/` 的產生物＋世代閘慣例）。

---

## 5. 為什麼連 CF client 也共用

判斷一致還不夠，**看到的東西**也要一致。

「已部署的 worker 綁著什麼」是從 `GET /workers/scripts/{script}/settings` 讀來的。
兩條路各自寫一份 client，只要有一邊把 404 當錯誤、漏了 `per_page`、少認一種欄位名
（`namespace_id` vs `id`），那一邊就會「看不到既有綁定」——
而看不到既有綁定的下一步，依規則就是**新建**。

**Arcrun#97 不需要規則寫錯，眼睛不一樣就足以重演。**
所以 `cli/src/lib/cf-api.ts` 的 `CfAccountClient` 把 `ResourceApi` 那七個方法**全部委派**
給 `cf-resource-api.mjs`，自己不留實作。

---

## 6. 驗收

```bash
cd cli && npm test          # 58 項，含下列三組
node shared/resource-rule/tests/demo.mjs   # 安裝器那條路，零依賴獨立跑
```

| 測試 | 證的事 |
|---|---|
| `cli/tests/two-paths-agree.test.ts` | 同一個帳號狀態餵給 `acr` 那條與安裝器那條，**選出的 resource id 相同**、建的東西相同、停手的理由相同 |
| `cli/tests/single-implementation.test.ts` | ①規則的 7 支函式全 repo 只有這裡有實作 ②鏡射逐位元組相同 ③共用層零依賴 |
| `cli/tests/resource-adoption.test.ts` | #97 本身的迴歸（沿用／不多建／四種停手情境），改共用層後照樣全過 |

三種情境（`tests/fixture-account.mjs` 的 `SCENARIOS`）：

- `fresh` — 沒裝過 → **正常建新的**（不能為了沿用而變成永遠不建）
- `installed` — 裝過了 → 沿用原本那幾顆，工作流與登入 session 都還在
- `renamed` — **資源在但名字與預期完全不同** → 仍然沿用（#97 的病根，專門驗）

---

## 7. 相關

- `Arcrun#97` — 「我按了更新，工作流和登入全不見了」：CLI 那條已修，本目錄是把同一條規則交給所有路徑
- `Arcrun#106` — 重部署把 `plain_text` var（含版本標籤）洗掉：`liveVars` 就是那些標籤
- `Arcrun#80` / `arcrun-rag#39` — 同一個「重複做 Arcrun 的工作」家族；Arcrun 是唯一編譯點的既有慣例
- `.claude/rules/07-thin-shell.md` — 本目錄存在的依據
