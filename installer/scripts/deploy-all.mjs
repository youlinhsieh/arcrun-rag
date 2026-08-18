#!/usr/bin/env node
/**
 * deploy-all.mjs — 一鍵安裝器的「施工隊」腳本（在 Cloudflare Workers Builds 容器內跑）。
 *
 * 定位（one-click-installer-design.md C 段）：
 *   這**不是**新 workflow、也**不重寫**任何 RAG 業務邏輯。它是把 Arcrun CLI 既有的
 *   `cli/src/lib/deploy.ts::downloadAndDeploy` 產品化——改裝成**非互動、env 驅動、讀本地 repo 樹**
 *   的獨立 mjs，好在 Builds 容器（有 Node + wrangler + Scripts:Edit token）裡跑，部署平台本體的
 *   24 個 worker（19 個預編譯 wasm 零件 + code 沙箱 + cypher/registry/kbdb/mcp 引擎）。
 *
 * 與 deploy.ts 的差異（刻意）：
 *   - 不下載 Gitea tarball：Builds 容器裡 repo 已在（用戶 fork 的完整鏡像，含 .component-builds/*.wasm）。
 *     改成讀 ARCRUN_REPO_ROOT（或自動往上找含 .component-builds 的目錄）。
 *   - 不讀 ~/.arcrun manifest、不互動提示：所有輸入走環境變數。
 *   - 保留 deploy.ts 的注入邏輯逐字對齊：injectWranglerConfig（KV id / WORKER_SUBDOMAIN /
 *     CF_ACCOUNT_ID / D1 database_id / MULTI_TENANT / KBDB_BASE_URL）+ stripOfficialOnlyBindings
 *     （routes/r2_buckets/ai）+ tier1 先 tier2 後的順序。
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN  必填（實際部署時）；Builds 自動 token 或用戶自備
 *   CF_ACCOUNT_ID         必填；注入各 worker CF_ACCOUNT_ID var
 *   WORKER_SUBDOMAIN      workers.dev subdomain（用戶自己的，如 acme-inc），注入 cypher WORKER_SUBDOMAIN / KBDB_BASE_URL
 *   D1_DATABASE_ID        arcrun-kbdb 的 D1 id（button 開通後取得），注入 kbdb toml
 *   KV_<BINDING>          9 把 KV 的 namespace id，逐把一個 env（見 REQUIRED_KV_NAMESPACES）
 *                         例：KV_WEBHOOKS、KV_CREDENTIALS_KV、KV_RECIPES …
 *   ARCRUN_REPO_ROOT      Arcrun 部署物 repo 根（含 .component-builds/）；不設則自動偵測
 *   KBDB_EMBED            'false' → 不取消 kbdb vectorize/ai 註解（預設開啟語義查詢）
 *   DRY_RUN              'true' → 只印「將部署 N 個 worker + 注入摘要」不真部署（離線驗收用）
 *
 * 離線驗收：DRY_RUN=true node deploy-all.mjs → 印部署清單 + 每個 worker 注入後 config 摘要，
 *   證明清單完整（對照 deploy.ts REQUIRED_KV_NAMESPACES=9、24 worker）。輸出存 DRYRUN-SAMPLE.txt。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 建 Cloudflare 資源這件事只准有一份實作（Leo/Arcrun#97 家族）——共用層在
// `installer/oauth-prototype/shared/resource-rule/`，是上游 Arcrun 那個目錄的逐位元組鏡射。
import { createCloudflareResourceApi } from '../oauth-prototype/shared/resource-rule/cf-resource-api.mjs';

// ── 常數（逐字對齊 Arcrun/cli/src/lib/deploy.ts）────────────────────────────────

/** init 要建立、且各 worker toml 需注入 id 的 9 把 KV namespace（title = binding 名）。 */
export const REQUIRED_KV_NAMESPACES = [
  'WEBHOOKS',
  'CREDENTIALS_KV',
  'RECIPES',
  'USERS_KV',
  'SESSIONS_KV',
  'ANALYTICS_KV',
  'EXEC_CONTEXT',
  'SUBMISSIONS_KV',
  'OAUTH_KV',
];

/**
 * 共享部署依賴（逐字對齊 deploy.ts SHARED_DEPLOY_DEPS）：24 個 worker 的 runtime dep（hono…）+ wrangler。
 * 在 repo root 裝「一次」，各 worker 目錄靠 node 往上 resolve（.component-builds/* 與 tier2 引擎皆在 root 之下）。
 * 少了這步，wrangler deploy 會全數 `Could not resolve "hono"`（e2e 2026-07-20 youlin 實撞）。
 */
export const SHARED_DEPLOY_DEPS = {
  hono: '^4.7.0',
  wrangler: '^4.0.0',
  zod: '^3.23.0',
  '@hono/zod-openapi': '^0.18.0',
  '@modelcontextprotocol/sdk': '^1.0.0',
  'js-yaml': '^4.1.0',
  yaml: '^2.4.0',
  'quickjs-emscripten-core': '^0.31.0',
  '@jitl/quickjs-wasmfile-release-sync': '^0.32.0',
};

/** 自足 Worker 零件（非 TinyGo-wasm 家族）：目錄相對 root + 必要產物 gate。目前只有 code。 */
const SELF_CONTAINED_COMPONENT_WORKERS = [
  { dir: ['registry', 'components', 'code'], requires: [['vendor', 'quickjs.wasm']] },
];

/** tier2 引擎（順序：cypher → registry → kbdb → mcp）。 */
const TIER2_WORKERS = ['cypher-executor', 'registry', 'kbdb', 'mcp'];

// ── Vectorize（語意搜尋）常數（對齊 cf-install-guide.md §3）────────────────────────
// 🔴 2026-08-03 換代（leo 拍板；08-05：「換 embed model 當然要合併，當然要換 vectorize，
//   原本的根本不能用」）：`bge-base-en-v1.5`(768) → `bge-m3`(1024)。
//   5 組中文測資實證：舊模型排序 2/5、margin -0.0413（中文分數全擠 0.65-0.81＝沒有區辨力）；
//   bge-m3 5/5、+0.1410、959ms。
//   必須換「名字」不是只改維度：舊 index 收不進 1024 維；不同模型的向量混在同一 index
//   比對出來是垃圾，而 #58（Vectorize vector delete 未接）代表舊向量刪不掉
//   ⇒ 開新名字順手繞開 #58，且新舊並存可回滾。
//   ⚠️ 這組值必須與 Arcrun 同步（漏一處就漂移，且**不報錯**、只是分數全垃圾）：
//     Arcrun:kbdb/src/embed.ts      DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3'
//     Arcrun:cli/src/lib/deploy.ts  KBDB_VECTORIZE_INDEX + dimensions
//     本檔 ＋ installer/oauth-prototype/worker.js
const VECTORIZE_INDEX_NAME = 'arcrun-kbdb-embed-m3';
const VECTORIZE_DIMENSIONS = 1024;
const VECTORIZE_METRIC = 'cosine';
const VECTORIZE_METADATA_PROPS = ['owner_id', 'entry_type', 'source', 'library'];

// ── 注入純函式（逐字對齊 deploy.ts；export 供離線測試）──────────────────────────

/**
 * self-hosted：確保 worker [vars] 有 `MULTI_TENANT = "false"`。四種既有狀態處理同 deploy.ts。
 */
export function injectMultiTenant(toml) {
  if (/^\s*MULTI_TENANT\s*=/m.test(toml)) {
    return toml.replace(/^(\s*MULTI_TENANT\s*=\s*")[^"]*(".*)$/m, `$1false$2`);
  }
  if (/^\s*#\s*MULTI_TENANT\s*=/m.test(toml)) {
    return toml.replace(/^(\s*)#\s*(MULTI_TENANT\s*=\s*)"[^"]*"(.*)$/m, `$1$2"false"$3`);
  }
  if (/^\s*\[vars\]\s*$/m.test(toml)) {
    return toml.replace(
      /^(\s*\[vars\]\s*)$/m,
      `$1\nMULTI_TENANT = "false"  # self-hosted 單租戶（installer 注入，mcp-account-source §5.5）`,
    );
  }
  return toml;
}

/**
 * 移除 self-hosted fork 帳號沒有、會導致 wrangler deploy 失敗的官方專屬 TOML 區塊：
 *   [[routes]]（無 arcrun.dev zone）、[[r2_buckets]]（dead storage + 綁卡）。
 * 回傳 { toml, stripped:[...] }（stripped 供 dry-run 摘要）。
 *
 * 🔴 **`[ai]` 一律保留，而且不准再加回剝除清單**（2026-08-17，Arcrun#106）。
 *
 * 同一個根因咬了兩次，第二次是因為第一次只修了一半：
 *   - **08-07**：本檔無條件剝 `[ai]` ⇒ 重部把 youlin 的雲端萃取
 *     （`/portal/daemon/extract` 走 `env.AI`）打成 501。當時的修法是加
 *     `keepAi` **opt-in 開關**（env `KEEP_AI=true`），**預設仍然剝**。
 *   - **08-17**：同一個根因從**另一份實作**（`arcrun/cli/src/lib/deploy.ts`）再犯一次，
 *     這次拔掉的是 cypher 的 `AI` binding ⇒ 免金鑰 AI 問答（recipe `workers_ai_chat`）
 *     整個死掉，錯誤訊息還叫使用者「自己去 wrangler.toml 補 binding 再重新部署」
 *     ——一句他既看不懂、也沒有 wrangler.toml 可以改的話。
 *
 * ⇒ 兩個教訓，寫在這裡免得再被當成「保守預設」重新引入：
 *   ① **opt-in 修法沒有修好任何事**。預設值才是絕大多數人拿到的行為；
 *      把正解藏在一個沒人知道的 env 後面，等於留著那個 bug 並多發一把鑰匙。
 *      （當時的配套是在 wiki 寫「重部一律記得帶 `KEEP_AI=true`」——
 *      靠人記得的閘，就是還沒修好的閘。）
 *   ② 舊註解那句「帳號沒開 Workers AI 卻硬留 `[ai]` 會讓 deploy 失敗」
 *      **從來沒有被實測過**。反證很好拿：youlin 的 `arcrun-kbdb` 一直帶著 `AI`
 *      binding 部署成功。Workers AI 在自架帳號上綁得起來，它不是部署阻斷項。
 *      就算真有帳號綁不起來，`wrangler deploy` 會**當場大聲失敗**，
 *      那遠好過招牌功能靜默死掉。
 *
 * ⚠️ 剝除清單的判準是「**這個帳號結構上不可能有**」（zone、綁卡資源），
 * 不是「預設用不到」。後者請讓 toml 自己註解掉（見 kbdb 的 `# [ai]`，
 * 由 `ctx.kbdbEmbed` 決定要不要取消註解），不要在這裡剝。
 *
 * 📌 這份與 `arcrun/cli/src/lib/deploy.ts` 的 `stripOfficialOnlyBindings()`
 * 是**兩份實作**（CLI 走 `acr update`、安裝器走 install.arcrun.dev，真實用戶多半走後者）。
 * 兩份必須同進退——08-07 只修了這份、08-17 只有那份被咬，就是漏同步的代價。
 * 動其中一份時**一定要同時檢查另一份**。
 */
export function stripOfficialOnlyBindings(toml) {
  const lines = toml.split('\n');
  const out = [];
  const stripped = [];
  const isBlockHeader = (l) => /^\s*\[\[?(routes|r2_buckets)\]?\]\s*$/.test(l);
  let skipping = false;
  for (const line of lines) {
    if (isBlockHeader(line)) {
      skipping = true;
      stripped.push(line.trim());
      continue;
    }
    if (skipping) {
      if (/^\s*\[/.test(line)) {
        skipping = false;
      } else if (line.trim() === '') {
        skipping = false;
        continue;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  return { toml: out.join('\n'), stripped };
}

/**
 * 注入用戶資源 id 到一份 wrangler.toml（純函式，回傳 { toml, summary }）。
 * 對齊 deploy.ts::injectWranglerConfig 的每一步。ctx = { accountId, workerSubdomain,
 *   kvNamespaceIds, d1DatabaseId, kbdbEmbed }。
 */
export function injectWranglerConfig(rawToml, ctx) {
  let toml = rawToml;
  const summary = { kvInjected: [], subdomain: false, accountId: false, d1: false, multiTenant: false, kbdbBaseUrl: false, embed: false, stripped: [] };

  // KV binding id 注入
  for (const [binding, id] of Object.entries(ctx.kvNamespaceIds)) {
    if (!id) continue;
    const re = new RegExp(`(binding\\s*=\\s*"${binding}"\\s*\\n\\s*id\\s*=\\s*")[^"]*(")`, 'g');
    if (re.test(toml)) {
      summary.kvInjected.push(binding);
      toml = toml.replace(
        new RegExp(`(binding\\s*=\\s*"${binding}"\\s*\\n\\s*id\\s*=\\s*")[^"]*(")`, 'g'),
        `$1${id}$2`,
      );
    }
  }

  // cypher WORKER_SUBDOMAIN
  if (ctx.workerSubdomain && /WORKER_SUBDOMAIN/.test(toml)) {
    toml = toml.replace(/(WORKER_SUBDOMAIN\s*=\s*")[^"]*(")/, `$1${ctx.workerSubdomain}$2`);
    summary.subdomain = true;
  }
  // CF_ACCOUNT_ID var
  if (ctx.accountId && /CF_ACCOUNT_ID/.test(toml)) {
    toml = toml.replace(/(CF_ACCOUNT_ID\s*=\s*")[^"]*(")/, `$1${ctx.accountId}$2`);
    summary.accountId = true;
  }
  // D1 database_id
  if (ctx.d1DatabaseId && /database_id\s*=/.test(toml)) {
    toml = toml.replace(/(database_id\s*=\s*")[^"]*(")/, `$1${ctx.d1DatabaseId}$2`);
    summary.d1 = true;
  }
  // self-hosted 恆為單租戶：MULTI_TENANT + KBDB_BASE_URL
  if (/MULTI_TENANT/.test(toml) || /\[vars\]/.test(toml)) {
    const before = toml;
    toml = injectMultiTenant(toml);
    if (before !== toml || /MULTI_TENANT\s*=\s*"false"/.test(toml)) summary.multiTenant = true;
  }
  if (ctx.workerSubdomain && /KBDB_BASE_URL/.test(toml)) {
    toml = toml.replace(
      /(KBDB_BASE_URL\s*=\s*")[^"]*(")/,
      `$1https://arcrun-kbdb.${ctx.workerSubdomain}.workers.dev$2`,
    );
    summary.kbdbBaseUrl = true;
  }

  // 🔴 2026-08-08 補漏：ARCRUN_BUNDLE_VERSION —— **本腳本原本完全不注入它**。
  //
  // 同一天撞兩次，第二次是總管自己踩的：
  //   ① 早上 stage 驗收發現 `bundle_version: null`，當時只記進 wiki（status.md:7715）**沒修**。
  //   ② 晚上總管用本腳本把 24 顆部到 leo 的實例救登入——登入是修好了，
  //      但 portal 版本卡變成「**無法讀取目前版本（知識庫服務可能正在啟動）**」。
  //      真因＝版本卡讀 cypher `/health` 的 `bundle_version`，而它回 `{"ok":true}`；
  //      那個值來自 `ARCRUN_BUNDLE_VERSION`，**只有安裝器注入**（`worker.js:1118`）。
  //
  // ⇒ 兩層教訓：
  //   · **「有注入的腳本」≠「注入齊全的腳本」**——本檔檔頭自稱是 `deploy.ts` 的產品化版，
  //     卻少這一項 ⇒ 用它部署過的實例，**版本卡與 daemon 的「檢查更新」都會失準**
  //     （daemon 也是比對這個值判斷雲端要不要更新）。
  //   · **記進 wiki ≠ 修好**——①已經記過了，②還是照樣發生。
  //
  // 注入對象與安裝器一致：cypher ＋ arcrun-rag-ui 兩顆
  // （t170 教訓：只給 cypher 會讓 UI 的 `/__version` 回空字串 ⇒「比版本」的判準永遠跳過＝沒牙齒）。
  //
  // 🔴 2026-08-16（Arcrun#106 另一半）：**版號旁邊要有 commit**。
  //   版號是部署時貼上去的標籤，貼了就看不出「這顆到底是哪份碼」——08-16 三台實例
  //   報同一個版號，而唯一能拆穿它的 `bundle_commit` 欄位被安裝器那條路洗掉。
  //   本腳本是第三條部署路徑，同一條規則照走：**凡烙版本，必烙 commit**
  //   （機械閘＝`installer/scripts/version-stamp-gate.mjs`）。
  //   `bundleCommit` 沒有就不貼——同 bundleVersion 的規矩，**不猜、不編**。
  if (ctx.bundleVersion && /\[vars\]/.test(toml)
      && (/name\s*=\s*"[^"]*cypher/.test(toml) || /name\s*=\s*"arcrun-rag-ui"/.test(toml))) {
    toml = /ARCRUN_BUNDLE_VERSION\s*=/.test(toml)
      ? toml.replace(/(ARCRUN_BUNDLE_VERSION\s*=\s*")[^"]*(")/, `$1${ctx.bundleVersion}$2`)
      : toml.replace(/(\[vars\]\n)/, `$1ARCRUN_BUNDLE_VERSION = "${ctx.bundleVersion}"\n`);
    summary.bundleVersion = true;
    if (ctx.bundleCommit) {
      toml = /ARCRUN_BUNDLE_COMMIT\s*=/.test(toml)
        ? toml.replace(/(ARCRUN_BUNDLE_COMMIT\s*=\s*")[^"]*(")/, `$1${ctx.bundleCommit}$2`)
        : toml.replace(/(\[vars\]\n)/, `$1ARCRUN_BUNDLE_COMMIT = "${ctx.bundleCommit}"\n`);
      summary.bundleCommit = true;
    }
  }

  // strip 官方專屬綁定（必須在注入 embed 之前）
  // 註（Arcrun#106）：這裡曾經讀 `process.env.KEEP_AI` 決定要不要保住 `[ai]`。
  // 已移除——`[ai]` 現在無條件保留，見 stripOfficialOnlyBindings 的註解。
  // 舊的 `KEEP_AI=true` 呼叫端不會壞，只是變成沒有作用的環境變數。
  const s = stripOfficialOnlyBindings(toml);
  toml = s.toml;
  summary.stripped = s.stripped;

  // 語義查詢：取消 kbdb 的 vectorize/ai 註解
  if (ctx.kbdbEmbed) {
    const before = toml;
    toml = toml.replace(
      /# (\[\[vectorize\]\])\n# (binding = "VECTORIZE")\n# (index_name = "[^"]*")/,
      '$1\n$2\n$3',
    );
    toml = toml.replace(/# (\[ai\])\n# (binding = "AI")/, '$1\n$2');
    if (before !== toml) summary.embed = true;
  }

  return { toml, summary };
}

// ── Vectorize index 建立（語意搜尋前置）────────────────────────────────────────────

/**
 * 在用戶 CF 帳號建立 Vectorize index（arcrun-kbdb-embed）及 4 個 metadata index。
 * 冪等：已存在（409 / error code 10006）靜默跳過；建立失敗時再 GET 複核一次
 * （token 可能只缺 create 權限、index 其實已在——別把好的判成壞的）。
 *
 * 🔴 回傳 false ＝ 語意搜尋的地基不存在。caller（main）把它當**致命錯誤**中止安裝：
 * 語意搜尋是一安裝就提供的功能（leo 2026-08-09），這裡若只印 warning 續行，產出的是
 * 一台「看起來裝好了、其實少一條腿」的實例，之後畫面上再被誤說成「還沒開通」
 * ——youlin 實例 07-20 那輪就是這樣出貨的（status-archive：「語意查詢待
 * Vectorize:Edit scope（本輪跳過）」），正是封測「語義搜尋搜不到」一族的源頭。
 */
export async function ensureVectorizeIndex(ctx) {
  if (!ctx.accountId || !ctx.apiToken) {
    console.log('[deploy-all] ✗ 無法建立 Vectorize（缺 CF_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN）');
    return false;
  }

  // ⚠️ 這裡刻意只組「**那一顆 index** 的網址」，不留一個指向資源集合的變數：
  //    集合端點＝建資源的入口，而建資源只准走共用層（resource-rule-gate.mjs 會擋）。
  const indexBase = `https://api.cloudflare.com/client/v4/accounts/${ctx.accountId}/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}`;
  const headers = { 'Authorization': `Bearer ${ctx.apiToken}`, 'Content-Type': 'application/json' };
  const manualHint = `手動指令：\n  npx wrangler vectorize create ${VECTORIZE_INDEX_NAME} --dimensions=${VECTORIZE_DIMENSIONS} --metric=${VECTORIZE_METRIC}\n  npx wrangler vectorize create-metadata-index ${VECTORIZE_INDEX_NAME} --property-name owner_id --type string\n  （同理 entry_type / source / library）`;

  // 1. 建 index
  //
  // 🔴 2026-08-12（`Leo/Arcrun#97` 家族）：這裡以前自己組 POST。**建資源這件事只准有一份實作**，
  //    所以改成呼叫共用層（`shared/resource-rule/cf-resource-api.mjs`，`acr` 與安裝器同一份）。
  //    順帶把「維度／metric 四處同步」少掉一處：那組值現在只活在共用層。
  //    `installer/scripts/resource-rule-gate.mjs` 會擋住任何人再寫一份。
  process.stdout.write(`[deploy-all] 建立 Vectorize index "${VECTORIZE_INDEX_NAME}"...`);
  let indexOk = false;
  try {
    const api = createCloudflareResourceApi({ accountId: ctx.accountId, apiToken: ctx.apiToken });
    const existing = await api.listVectorizeIndexes().catch(() => null);
    if (existing && existing.includes(VECTORIZE_INDEX_NAME)) {
      console.log(' 已存在，跳過。');
      indexOk = true;
    } else {
      await api.createVectorizeIndex(VECTORIZE_INDEX_NAME); // 已存在（409）視為成功，見共用層
      console.log(' ✓');
      indexOk = true;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 建立失敗 ≠ 一定不存在：GET 複核（更新既有實例時 index 早建好，token 換過少了
    // create 權限的情況不該被判死）。
    const probe = await fetch(indexBase, { headers }).catch(() => null);
    if (probe && probe.ok) {
      console.log(` 建立呼叫失敗（${errMsg}），但 GET 複核 index 已存在 → 續行。`);
      indexOk = true;
    } else {
      console.log(` ✗ 失敗：${errMsg}（多半是 token 缺 Vectorize:Edit scope）\n${manualHint}`);
      return false;
    }
  }

  if (!indexOk) return false;

  // 2. 建 metadata indices（冪等）
  const metaBase = `${indexBase}/metadata-index/create`;
  for (const prop of VECTORIZE_METADATA_PROPS) {
    try {
      const res = await fetch(metaBase, {
        method: 'POST',
        headers,
        body: JSON.stringify({ propertyName: prop, indexType: 'string' }),
      });
      const data = await res.json().catch(() => ({}));
      const alreadyExists = res.status === 409 || data?.errors?.[0]?.code === 10006;
      if (res.ok) {
        console.log(`[deploy-all]   ✓ metadata index: ${prop}`);
      } else if (alreadyExists) {
        console.log(`[deploy-all]   metadata index "${prop}" 已存在`);
      } else {
        const errMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
        console.log(`[deploy-all]   ⚠ metadata index "${prop}" 失敗：${errMsg}`);
      }
    } catch (e) {
      console.log(`[deploy-all]   ⚠ metadata index "${prop}" 呼叫失敗：${e instanceof Error ? e.message : e}`);
    }
  }

  return true;
}

// ── repo 樹掃描 ────────────────────────────────────────────────────────────────

/** 找 Arcrun 部署物 repo 根（含 .component-builds/）。ARCRUN_REPO_ROOT 優先，否則自 cwd/腳本位置往上找。 */
export function findRepoRoot() {
  if (process.env.ARCRUN_REPO_ROOT) {
    const r = process.env.ARCRUN_REPO_ROOT;
    if (existsSync(join(r, '.component-builds'))) return r;
    throw new Error(`ARCRUN_REPO_ROOT=${r} 下找不到 .component-builds/`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), join(here, '..', '..'), join(here, '..', '..', '..')];
  const seen = new Set();
  for (let base of candidates) {
    for (let i = 0; i < 6; i++) {
      base = base || '/';
      if (seen.has(base)) break;
      seen.add(base);
      if (existsSync(join(base, '.component-builds'))) return base;
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
  }
  throw new Error('找不到含 .component-builds/ 的 repo 根；請設 ARCRUN_REPO_ROOT');
}

/** 掃 tier1（.component-builds/* 有 wasm + 自足 code）與 tier2（4 引擎）。對齊 deploy.ts::discoverWorkerDirs。 */
export function discoverWorkerDirs(root) {
  const tier1 = [];
  const tier2 = [];
  const cbRoot = join(root, '.component-builds');
  if (existsSync(cbRoot)) {
    for (const name of readdirSync(cbRoot).sort()) {
      const dir = join(cbRoot, name);
      if (existsSync(join(dir, 'wrangler.toml')) && existsSync(join(dir, 'component.wasm'))) {
        tier1.push(dir);
      }
    }
  }
  for (const { dir: rel, requires } of SELF_CONTAINED_COMPONENT_WORKERS) {
    const dir = join(root, ...rel);
    const complete = existsSync(join(dir, 'wrangler.toml')) && requires.every((r) => existsSync(join(dir, ...r)));
    if (complete) tier1.push(dir);
  }
  for (const name of TIER2_WORKERS) {
    const dir = join(root, name);
    if (existsSync(join(dir, 'wrangler.toml'))) tier2.push(dir);
  }
  return { tier1, tier2 };
}

// ── ctx 組裝（全 env）─────────────────────────────────────────────────────────

export function buildContextFromEnv(env = process.env) {
  const kvNamespaceIds = {};
  const missingKv = [];
  for (const title of REQUIRED_KV_NAMESPACES) {
    const v = env[`KV_${title}`];
    if (v) kvNamespaceIds[title] = v;
    else missingKv.push(title);
  }
  return {
    accountId: env.CF_ACCOUNT_ID || '',
    apiToken: env.CLOUDFLARE_API_TOKEN || '',
    workerSubdomain: env.WORKER_SUBDOMAIN || '',
    d1DatabaseId: env.D1_DATABASE_ID || '',
    // 版本標記（見下方注入段的病史）。沒給就不注入——**不猜、不編**，
    // 因為安裝器有過「用捏造的 commit 碼把假版本號寫進實例」的前科（worker.js:1634）。
    bundleVersion: env.ARCRUN_BUNDLE_VERSION || '',
    // Arcrun#106 另一半：版號旁邊的 commit 印記。env 沒給時由 main() 從 repo 樹的
    // git HEAD 推導（`resolveRepoCommit`）——本腳本部的就是那棵樹，那是它唯一誠實的答案。
    bundleCommit: env.ARCRUN_BUNDLE_COMMIT || '',
    kbdbEmbed: env.KBDB_EMBED !== 'false',
    kvNamespaceIds,
    missingKv,
    dryRun: env.DRY_RUN === 'true',
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────

function labelOf(dir) {
  return dir.replace(/^.*\.component-builds\//, '').replace(/^.*\//, '');
}

/**
 * 這棵 repo 樹現在是哪顆 commit（Arcrun#106 另一半）。
 *
 * 本腳本不下載 tarball、部的就是本機這棵樹 ⇒ 「它是哪份碼」的誠實答案＝這棵樹的 git HEAD。
 * 🔴 **工作區有未提交的改動就回空字串**——那時候貼任何 sha 都是在說謊
 *   （部上去的位元組不等於那顆 commit）。回空 ⇒ 不貼 commit ⇒ 少一個欄位，
 *   而不是貼一個假的：本 repo 有過「捏造 commit 碼」的前科（見注入段 t144）。
 */
export function resolveRepoCommit(root, exec = execFileSync) {
  try {
    const dirty = exec('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    if (dirty) return '';
    const sha = exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : '';
  } catch {
    return ''; // 不是 git 樹／沒有 git ⇒ 查不到就不貼
  }
}

async function main() {
  const ctx = buildContextFromEnv();
  const root = findRepoRoot();
  // env 沒指定就問這棵樹自己（乾淨才算數，見 resolveRepoCommit）
  if (!ctx.bundleCommit) ctx.bundleCommit = resolveRepoCommit(root);
  const { tier1, tier2 } = discoverWorkerDirs(root);
  const allDirs = [...tier1, ...tier2];

  console.log(`[deploy-all] repo root: ${root}`);
  console.log(`[deploy-all] mode: ${ctx.dryRun ? 'DRY-RUN（不真部署）' : 'DEPLOY'}`);
  console.log(`[deploy-all] tier1（零件）: ${tier1.length}｜tier2（引擎）: ${tier2.length}｜合計: ${allDirs.length} worker`);
  console.log(`[deploy-all] KV 提供: ${Object.keys(ctx.kvNamespaceIds).length}/${REQUIRED_KV_NAMESPACES.length}` +
    (ctx.missingKv.length ? `（缺 env: ${ctx.missingKv.map((t) => `KV_${t}`).join(', ')}）` : '（齊）'));
  console.log(`[deploy-all] D1 id: ${ctx.d1DatabaseId ? '有' : '缺'}｜subdomain: ${ctx.workerSubdomain || '缺'}｜embed: ${ctx.kbdbEmbed}`);
  console.log('');

  // 前置檢查（非 dry-run 才強制）
  if (!ctx.dryRun) {
    const fatal = [];
    if (!ctx.apiToken) fatal.push('CLOUDFLARE_API_TOKEN');
    if (!ctx.accountId) fatal.push('CF_ACCOUNT_ID');
    if (ctx.missingKv.length) fatal.push(...ctx.missingKv.map((t) => `KV_${t}`));
    if (fatal.length) {
      console.error(`[deploy-all] ✗ 缺必要環境變數：${fatal.join(', ')}`);
      process.exit(1);
    }
    try {
      execFileSync('npx', ['wrangler', '--version'], { stdio: 'ignore' });
    } catch {
      console.error('[deploy-all] ✗ 找不到 wrangler（Builds 容器應內建；本地測試需 npx wrangler 可用）');
      process.exit(1);
    }
  }

  if (allDirs.length === 0) {
    console.error('[deploy-all] ✗ 掃不到任何 worker（root 錯誤或鏡像缺 .component-builds wasm）');
    process.exit(1);
  }

  // 2. Vectorize index（語意搜尋基礎設施；kbdbEmbed 預設 true 故幾乎必跑）
  // 🔴 2026-08-09（leo：「語義搜尋已經確定是一安裝就提供的功能⋯⋯是壞了」）：
  //   地基建不起來＝**致命**，立刻中止，不准安靜地出一台只有關鍵字搜尋的實例。
  //   舊行為（只印 warning 續行）讓故障實例照樣過安裝驗收，之後在搜尋頁被說成
  //   「還沒開通」，製造「幫我開通」的假客服工單，而真正的故障沒人修。
  if (!ctx.dryRun && ctx.kbdbEmbed) {
    const vecOk = await ensureVectorizeIndex(ctx);
    if (!vecOk) {
      console.error('[deploy-all] ✗ 語意搜尋地基（Vectorize index）建立失敗。語意搜尋是安裝即提供的功能，');
      console.error('             缺它就不是一次成功的安裝——中止，不出「少一條腿」的實例。');
      console.error('             修法：給部署 token 補 Vectorize:Edit 權限（或先手動建 index）後重跑。');
      process.exit(1);
    }
    console.log('');
  } else if (!ctx.dryRun && !ctx.kbdbEmbed) {
    console.log('[deploy-all] ⚠ KBDB_EMBED=false：這台實例將**沒有**語意搜尋（產品預設是必裝，確定要這樣？）');
  }

  // 2.5 共享部署依賴：repo root 裝一次（對齊 deploy.ts §2.5）。少了它 24 worker 的 wrangler deploy
  //     會全數 `Could not resolve "hono"`（e2e 2026-07-20 youlin 實撞的 installer bug）。
  //     失敗不致命：sharedBin 留空 → 迴圈退回各 worker 自裝。DRY_RUN 跳過。
  let sharedBin = '';
  if (!ctx.dryRun) {
    try {
      process.stdout.write('[deploy-all] 安裝共享部署依賴（一次，取代每個 worker 各裝）...');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'arcrun-deploy-shared', private: true, type: 'module', dependencies: SHARED_DEPLOY_DEPS }),
      );
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
      const bin = join(root, 'node_modules', '.bin', 'wrangler');
      sharedBin = existsSync(bin) ? bin : '';
      console.log(sharedBin ? ' ✓' : ' ⚠ 退回各 worker 自裝');
    } catch (e) {
      const tail = (e && e.stderr ? e.stderr.toString() : '').trim().split('\n').slice(-2).join(' | ').slice(0, 200);
      console.log(` ⚠ 共享安裝失敗，退回各 worker 自裝${tail ? `：${tail}` : ''}`);
    }
  }

  const failures = [];
  let deployed = 0;

  for (let i = 0; i < allDirs.length; i++) {
    const dir = allDirs[i];
    const tomlPath = join(dir, 'wrangler.toml');
    const label = labelOf(dir);
    const tier = i < tier1.length ? 'tier1' : 'tier2';
    if (!existsSync(tomlPath)) {
      failures.push(`${label}: 缺 wrangler.toml`);
      continue;
    }
    const raw = readFileSync(tomlPath, 'utf8');
    const { toml, summary } = injectWranglerConfig(raw, ctx);

    const bits = [
      `KV注入 ${summary.kvInjected.length}`,
      summary.subdomain ? 'subdomain✓' : null,
      summary.accountId ? 'CF_ACCOUNT_ID✓' : null,
      summary.d1 ? 'D1✓' : null,
      summary.bundleVersion ? `版本=${ctx.bundleVersion}` : null,
      summary.bundleCommit ? `commit=${ctx.bundleCommit.slice(0, 12)}` : null,
      summary.multiTenant ? 'MULTI_TENANT=false' : null,
      summary.kbdbBaseUrl ? 'KBDB_BASE_URL✓' : null,
      summary.embed ? 'embed✓' : null,
      summary.stripped.length ? `strip[${summary.stripped.join(',')}]` : null,
    ].filter(Boolean).join(' · ');
    console.log(`  [${String(i + 1).padStart(2)}/${allDirs.length}] ${tier} ${label.padEnd(22)} ${bits}`);

    if (ctx.dryRun) continue;

    // 真部署：寫回注入後 toml（容器內鏡像副本，非用戶 repo）→ wrangler deploy
    // 有 sharedBin＝用 root 共享 wrangler（deps 往上 resolve）；否則 fallback 各 worker 自裝一次（對齊 deploy.ts::runWranglerDeploy）
    try {
      writeFileSync(tomlPath, toml, 'utf8');
      if (!sharedBin && existsSync(join(dir, 'package.json'))) {
        const installer = existsSync(join(dir, 'pnpm-lock.yaml'))
          ? ['pnpm', ['install', '--frozen-lockfile']]
          : ['npm', ['install', '--no-audit', '--no-fund']];
        execFileSync(installer[0], installer[1], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
      }
      const wranglerCmd = sharedBin || 'npx';
      const wranglerArgs = sharedBin ? ['deploy'] : ['wrangler', 'deploy'];
      execFileSync(wranglerCmd, wranglerArgs, {
        cwd: dir,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, CLOUDFLARE_API_TOKEN: ctx.apiToken, CLOUDFLARE_ACCOUNT_ID: ctx.accountId },
      });
      deployed++;
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('');
  if (ctx.dryRun) {
    // 離線驗收斷言
    const okCount = allDirs.length === 24;
    const okKv = REQUIRED_KV_NAMESPACES.length === 9;
    console.log(`[deploy-all] DRY-RUN 完成。斷言：worker=${allDirs.length}（期望 24 → ${okCount ? 'PASS' : 'FAIL'}）` +
      `｜REQUIRED_KV=${REQUIRED_KV_NAMESPACES.length}（期望 9 → ${okKv ? 'PASS' : 'FAIL'}）`);
    if (!okCount || !okKv) process.exit(1);
    return;
  }

  if (failures.length) {
    console.error(`[deploy-all] ⚠ 部署 ${deployed}/${allDirs.length} 成功，${failures.length} 失敗（誠實回報，未假綠）：`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`[deploy-all] ✓ ${deployed} 個 worker 全部部署成功。`);
}

// 只有被直接執行才跑 main（被 import 當測試模組時不跑）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[deploy-all] ✗ ${e instanceof Error ? e.stack : e}`);
    process.exit(1);
  });
}
