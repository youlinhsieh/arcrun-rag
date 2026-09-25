#!/usr/bin/env node
/**
 * local-install-check.mjs — 本機實裝驗收腳本（arcrun-rag#215 comment 11189，總管要求）
 *
 * 🔴 這不是離線測試。它會用真的 Cloudflare API token 呼叫真的 D1／KV／Workers API，
 *   在指定帳號上真的裝一次（或更新一次）——跟走瀏覽器 OAuth 安裝流程效果完全一樣，
 *   只是 session／進度存在**本機記憶體**（`env.INSTALLER_KV` 用 Map 假件），
 *   不需要先把 worker 部署上線、也不在安裝器上開任何後門端點。
 *
 * 為什麼可以這樣做：OAuth 流程最後拿到的也只是一張「Bearer <access_token>」——
 * 對 Cloudflare API 而言，一張具備同等權限的 API Token 效果相同。
 * `runInstall()` 本身完全不知道 token 是怎麼來的，只知道怎麼用它打 D1／Workers API。
 *
 * 用法：
 *   CLOUDFLARE_API_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN_YOULIN_CC_USE=' ../../../.env | cut -d= -f2-) \
 *   CLOUDFLARE_ACCOUNT_ID=1129efd7df2e8899d537e9c8fbabb6cb \
 *   INVITE_EMAIL=scout@example.com \
 *   node installer/scripts/local-install-check.mjs [--restart]
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN     必填。要用哪個帳號的 token 裝，就是哪個帳號被動到——
 *                            **只寫名字**（D36），真身留在 .env，不進 commit、不進本檔。
 *   CLOUDFLARE_ACCOUNT_ID    必填。目標帳號 id。
 *   INVITE_EMAIL             選填，預設 `local-check@arcrun-rag.internal`——
 *                            決定推導出的資源命名（`slugFromEmail`），同一個 email
 *                            重跑會認得回同一組資源（跟真的重新安裝行為一致）。
 *   --restart                傳給 runInstall 的 `force`；配合「立刻再裝一次」那個情境用。
 *
 * 跑完做什麼：印出 progress 的最終狀態、每一步的結果、
 *   這一次 schema 步驟自己算的 `migrationRowsWritten`（MigrationWriteBudget 的實際累計）、
 *   `skippedAccelerators`（哪些加速索引因為預算不夠先跳過），
 *   以及 `loadDailySpend()` 讀回的「這個帳號今天累計」——這個數字要跟
 *   CF GraphQL `d1QueriesAdaptiveGroups` 對帳。
 *
 * 三種情境（總管會各跑一次）：
 *   1. 全新安裝：目標帳號上沒有任何舊資源時直接跑。
 *   2. 立刻再裝一次：跑完情境 1 後馬上重跑同一支腳本（同一個 INVITE_EMAIL，
 *      並帶同一個 `--state-file <path>`）——不帶 `--state-file` 的話，每次呼叫都是
 *      全新 Node process、全新的記憶體 KV，deploy 步驟的「已經裝過哪幾顆」這種
 *      進度會整個消失，重裝會從頭來過，跟真實情況（同一顆 Worker 的 KV／未來的 DO
 *      本來就是持久的）不一致（🔴 arcrun-rag#215 c11236：總管實跑 run2→run3 就是
 *      栽在這裡——run3 用了新 process，deploy 從「6/23」重新開始，不是從 run2
 *      推進到的地方接續）。情境 2 的重點是「schema 步驟的 `migrationRowsWritten`
 *      應該接近 0」（`detectMigrationGeneration` 探到已經是最新一代，不必重跑）。
 *   3. 同一天連裝三次：一樣**傳同一個 `--state-file <path>`**，讓多次腳本呼叫
 *      共用整個 KV 內容（不只 `mig-budget:*`，deploy 進度、session 都在內），
 *      模擬 `env.INSTALLER_KV` 真的有跨呼叫持久性，逐字對應線上 worker 重啟後
 *      KV／DO 仍在的行為。
 *
 * 🔴 不准在安裝器 worker 上開後門端點——這支腳本完全不碰安裝器的 HTTP 介面，
 *   直接 import `runInstall` 這個函式本體，跟安裝器線上跑的是同一份程式碼。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import worker, {
  runInstall,
  freshProgress,
  writeProgress,
  readProgress,
  loadDailySpend,
} from '../oauth-prototype/worker.js';

function parseArgs(argv) {
  const out = { restart: false, stateFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--restart') out.restart = true;
    // `--shared-budget-file` 是舊名字，本版起涵蓋整個 KV（不只 mig-budget:*），
    // 保留這個別名純粹是避免上一輪跑到一半的人指令打到一半撲空。
    else if (argv[i] === '--state-file' || argv[i] === '--shared-budget-file') out.stateFile = argv[++i];
  }
  return out;
}

/** 記憶體版 KV（get/put/delete/list），介面跟 Workers KV／`#217` 之後的 DO shim 一致。
 *  `--state-file` 開著時，**整個 KV**（不只 `mig-budget:*`）鏡射到磁碟檔案——
 *  🔴 arcrun-rag#215 c11236：上一版只鏡射 `mig-budget:*`，deploy 進度
 *  （`prog:<sid>`／`deployed:*`／`sess:<sid>` 等）沒有跨 process 持久，
 *  導致總管的 run3 從「6/23」重新開始，不是接著 run2 推進到的地方——
 *  這是驗收腳本自己的持久化缺陷，不是產品的（線上 worker 本來就有持久的 KV／DO）。
 *  這是驗收腳本自己的持久化手段，不是產品的儲存設計。 */
function makeMemoryKv(stateFile) {
  const store = new Map();
  if (stateFile && existsSync(stateFile)) {
    const disk = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const [k, v] of Object.entries(disk)) store.set(k, v);
  }
  const persistIfNeeded = () => {
    if (!stateFile) return;
    const dump = Object.fromEntries(store);
    writeFileSync(stateFile, JSON.stringify(dump, null, 2));
  };
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    // kv-ok: 驗收腳本自己的本機記憶體假件（模擬 env.INSTALLER_KV 的介面），process 結束即消失
    // （除非帶 --state-file 額外鏡射到磁碟）；不是產品程式碼新增的長效寫入用途，
    // 只是在本機重現既有介面讓 runInstall() 能跑。
    async put(key, value, _opts) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      persistIfNeeded();
    },
    async delete(key) { store.delete(key); persistIfNeeded(); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
      return { keys };
    },
    _store: store,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const inviteEmail = process.env.INVITE_EMAIL || 'local-check@arcrun-rag.internal';
  if (!token || !accountId) {
    console.error('缺 CLOUDFLARE_API_TOKEN／CLOUDFLARE_ACCOUNT_ID（只讀環境變數，不寫死在本檔——D36）。');
    process.exit(1);
  }

  const sid = 'local-check-sid';
  const INSTALLER_KV = makeMemoryKv(args.stateFile);
  const PEER_INSTALLER_KV = makeMemoryKv(null); // t157 對方通道偵測用，這裡給一顆空的自己的（跟 youlin-stage wrangler.toml 同款設計）
  const env = {
    INSTALLER_KV,
    PEER_INSTALLER_KV,
    DEPLOY_ENV: 'local-install-check',
    BUNDLE_BASE: process.env.BUNDLE_BASE || 'https://git.uncle6.me/inkstone/arcrun-rag-bundles-staging/raw/branch/main',
    BUNDLE_BUILT: new Date().toISOString().slice(0, 10),
    LANDING_BASE: process.env.LANDING_BASE || 'https://arcrun-landing-youlin-stage.arcrun-yuga3bse.workers.dev',
    SITE_BASE: process.env.SITE_BASE || 'https://arcrun-landing-youlin-stage.arcrun-yuga3bse.workers.dev',
    DOCS_BASE: process.env.DOCS_BASE || 'https://arcrun-docs-youlin-stage.arcrun-yuga3bse.workers.dev/docs',
  };

  // 假 session：跟真的 OAuth 流程拿到的東西同一個形狀（見 getAccessToken()），
  // 只是 access_token 直接放一張 API token 進去、expires_at 給遠期，永遠不觸發 refresh。
  await INSTALLER_KV.put(`sess:${sid}`, JSON.stringify({ // kv-ok: 本機記憶體假件的 session，process 結束即消失，非產品新增長效用途
    inviteEmail,
    inviteVerified: true,
    access_token: token,
    refresh_token: null,
    expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000,
  }));

  const before = await loadDailySpend(INSTALLER_KV, accountId);
  console.log(`帳號 ${accountId} 這次呼叫開始前，此 process 記憶體 KV 看到的今日累計：${before}`
    + (args.stateFile ? `（讀自 ${args.stateFile}）` : '（全新 process，跨次累計要另外用 --state-file 或看 CF GraphQL）'));

  let progress = freshProgress();
  await writeProgress(env, sid, progress);
  const t0 = Date.now();

  // 🔴 arcrun-rag#215 c11213（總管實跑抓到的第 2 個問題）：deploy 步驟分批接力
  // （每輪最多裝幾顆，見 worker.js DEPLOY_BUDGET_PER_RUN），一輪 runInstall 跑完
  // 可能還停在 `paused_continue`——瀏覽器那邊靠前端 `continueInstall()` 每隔一段時間
  // 自動再打一次 `/api/install/start`（restart:false）接力。這支腳本沒有前端，
  // 所以要自己做同一件事：反覆呼叫 `runInstall`，直到 `done` 或 `error` 為止，
  // 否則情境 1（全新安裝）永遠不會跑完，deploy 步驟會停在「已裝 0/N，接力中」。
  const MAX_ROUNDS = 60; // 安全上限，避免真的卡住時腳本無限迴圈
  // 🔴 arcrun-rag#215 c11236：run2 第 12 輪、run3 第 7 輪都撞到 `TypeError: terminated`
  // （undici，TLS socket 中斷）——這支腳本原本一撞到 `error` 就停手，要總管手動重跑
  // 才能接著跑；瀏覽器使用者也是靠按「重新安裝」做同一件事（`handleInstallStart`
  // 對 `state==='error'` 會清掉 `progress.error` 再繼續，已完成的步驟不重做）。
  // 這裡自動做同一件事，但只對「看起來像暫時性網路問題」的錯誤重試（沿用
  // cfFetch 對這類例外給的中文提示字樣當判準），且有次數上限——真的壞掉的錯誤
  // （例如帳號設定問題）不該被靜默重試蓋過去，要老實停下來給人看。
  const TRANSIENT_RETRY_LIMIT = 5;
  let transientRetries = 0;
  let round = 0;
  let first = true;
  while (true) {
    round++;
    if (round > MAX_ROUNDS) {
      console.error(`超過 ${MAX_ROUNDS} 輪還沒走到 done／error，停手——請看下面最後一輪的步驟狀態。`);
      break;
    }
    await runInstall(env, sid, progress, first && !!args.restart);
    first = false;
    progress = await readProgress(env, sid);
    console.log(`  [第 ${round} 輪] state=${progress.state}`
      + ` steps=${(progress.steps || []).map((s) => `${s.id}:${s.state}`).join(',')}`);
    if (progress.state === 'done') break;
    if (progress.state === 'error') {
      const detail = String((progress.error && progress.error.detail) || '');
      const looksTransient = /terminated|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(detail)
        || /暫時性的網路問題/.test((progress.error && progress.error.hint) || '');
      if (looksTransient && transientRetries < TRANSIENT_RETRY_LIMIT) {
        transientRetries++;
        console.log(`  [第 ${round} 輪] 看起來是暫時性網路問題（${transientRetries}/${TRANSIENT_RETRY_LIMIT} 次自動重試）：${detail.slice(0, 200)}`);
        progress.error = null;
        progress.state = 'running'; // 跟 handleInstallStart 對 state==='error' 的處理一致：已完成的步驟不重做
        await writeProgress(env, sid, progress);
        await new Promise((r) => setTimeout(r, 3000)); // 比正常節奏多等一下，給暫時性問題時間過去
        continue;
      }
      break; // 不像暫時性、或重試次數用完——老實停下來，把 error 印給人看
    }
    // 跟前端 poll() 的節奏對齊（1.5 秒），避免對 D1／CF API 打太快。
    await new Promise((r) => setTimeout(r, 1500));
  }
  const elapsedMs = Date.now() - t0;

  console.log('\n=== 安裝結果 ===');
  console.log('state:', progress.state);
  console.log('耗時（毫秒）:', elapsedMs);
  if (progress.error) console.log('error:', JSON.stringify(progress.error, null, 2));
  console.log('\n=== 步驟 ===');
  for (const s of progress.steps || []) console.log(`  ${s.id}: ${s.state}${s.note ? ' — ' + s.note : ''}`);

  console.log('\n=== 這次 schema 步驟自己算的用量（不查 CF） ===');
  console.log('migrationRowsWritten（這次實際累加的 rows_written）:', progress.result.migrationRowsWritten ?? '(schema 步驟沒跑到／已是最新)');
  console.log('skippedAccelerators（因為預算不夠先跳過的加速索引）:', JSON.stringify(progress.result.skippedAccelerators ?? []));

  // arcrun-rag#215 c11219：CF 對帳出現 2.2 倍誤差，還沒定案根因（見 MigrationWriteBudget
  // 建構子的註解）。印出每一次呼叫的原始 meta 明細，讓這次跑完能直接比對「哪一次呼叫
  // 多算了」，不必再瞎猜——把這段輸出整段附在票上。
  const callLog = progress.result.migrationCallLog || [];
  console.log(`\n=== schema 步驟每一次 D1 呼叫的原始 meta（共 ${callLog.length} 次，供對帳用） ===`);
  for (const [i, c] of callLog.entries()) {
    console.log(`  [${i}] resultEntries=${c.resultEntries} callWritten=${c.callWritten} callRead=${c.callRead} sql="${c.sql}…"`);
    if (c.resultEntries > 1) console.log(`      metas=${JSON.stringify(c.metas)}`);
  }

  const after = await loadDailySpend(INSTALLER_KV, accountId);
  console.log(`\n這次呼叫結束後，此 process 記憶體 KV 看到的今日累計：${after}`
    + (args.stateFile ? `（已寫回 ${args.stateFile}，下一次帶同一個 --state-file 會接續讀到）` : ''));

  console.log('\n=== 對帳用：接下來請用 CF GraphQL 核對 ===');
  console.log(`帳號 ${accountId}，D1 database id：${progress.result.databaseId || '(未知，看上面 error)'}`);
  console.log('對帳做法：用 CF GraphQL d1QueriesAdaptiveGroups 篩這次跑的時間區間，'
    + '把 rowsWritten 加總，跟上面 migrationRowsWritten 比對，誤差請附在票上。');

  console.log(`\n${progress.state === 'done' ? '✅' : '❌'} 這次呼叫本身` + (progress.state === 'done' ? '成功' : '沒有走到 done——請看上面 error'));
}

main().catch((e) => {
  console.error('腳本本身丟出未接住的錯誤（不是安裝失敗，是這支腳本有問題）：', e);
  process.exit(1);
});
