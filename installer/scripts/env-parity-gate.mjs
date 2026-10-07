#!/usr/bin/env node
/**
 * env-parity-gate.mjs — prod 與 stage 只准差「身分」，不准差「行為」（D90）
 *
 * ⚠️ 名字別跟站表上的 `parity` 那一站搞混：那一站比的是**兩份 bundle 的內容**，
 *    這道閘比的是**兩個環境的設定**。所以叫「環境對等閘」。
 *
 * ── 這道閘在治什麼（leo 2026-08-14 立 D90）─────────────────────────────────
 * leo 原話：「你爲什麼不把 **prod 跟 stage 跟 cli 做到一模一樣**？
 *            **有一個不對的部分以後每次都會擔心。**」
 *
 * stage 存在的唯一理由是「**在這裡測過，prod 就會一樣**」。
 * 只要有一個**行為**差異，這個前提就破了——而且壞法是隱形的：
 * **stage 全綠、prod 炸給用戶看，而我們永遠測不出來**（因為我們只在 stage 測）。
 *
 * 實撞（D90 的觸發點）：`installer/oauth-prototype/wrangler.toml` 的
 * `compatibility_flags = ["global_fetch_strictly_public"]` 只加在 `[env.staging]`。
 * 當初註解寫「prod 的呼叫方是 custom domain 所以不踩這條」——但 CF 的 `1042`
 * **看的是目標，不是呼叫方**。若成立，每個走正式安裝器的用戶都會在最後一步撞 404。
 *
 * D90 最後一句是這道閘的規格：
 *   「出貨前比對 prod 與 stage 的設定，**差異只准落在身分白名單裡**，否則擋下。」
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ── 判準（這支的難點全在這裡，不在程式）─────────────────────────────────────
 * ═══════════════════════════════════════════════════════════════════════════
 * 這件事之前失敗過兩次，**兩種相反的錯**，兩邊都讓閘變成廢的：
 *   ① 第一版沒處理 **wrangler 的繼承** ⇒ 把「只在頂層宣告」判成差異 ⇒ 假警報
 *   ② 第二版修好繼承，卻把 KV namespace id、各種 `*_BASE` 網址判成行為差異 ⇒ 也是假警報
 * **永遠在響的閘 ＝ 沒有閘**（同 `.claude/branch-holds.md` 開頭那句）；
 * **放行太寬的閘 ＝ 有人在守的錯覺**（同 `Leo/arcrun-rag#86` 被退回補閘那次）。
 *
 * D90 給的是**原則**（身分／行為），白名單要自己列。這裡列出來的每一條都附理由。
 *
 * ── 第 0 層：先把兩邊「解析成 wrangler 真的會用的樣子」────────────────────
 * 不能拿原始檔字面比。wrangler 的 `--env` 有兩種鍵：
 *   · **可繼承**（`main`／`compatibility_date`／`compatibility_flags`／`triggers`…）
 *     ⇒ env 沒寫就用頂層的值。**這就是第一版錯的地方。**
 *   · **不可繼承**（`vars`／各種 binding／`assets`…）
 *     ⇒ env 沒寫就是**沒有**，不會拿頂層的來頂。
 * 所以先各自解析出 `resolveEnv(raw, null)`（prod）與 `resolveEnv(raw, 'staging')`，再比。
 * 🔴 「不可繼承的鍵只宣告在頂層、env 沒宣告」這種寫法**本身**就當違規報——
 *    wrangler 各版本對它的處置變過（本 repo 的 `docs-site/wrangler.toml` 就記著
 *    「官方文件說 routes 不繼承，但 4.100.0 實測仍會套用頂層值」），
 *    **靠不住的東西不要靠**，寫明比較快。
 *
 * ── 第 1 層：鍵屬於身分還是行為 ────────────────────────────────────────────
 * D90 的分類：身分＝名稱／對外網址／憑證與資源 id／環境標記；
 *             行為＝flag、相容性設定、功能開關、程式路徑、資源形狀、重試與逾時參數。
 *
 * 🔴 **預設是「行為」**（見 `IDENTITY_KEYS`／`IDENTITY_BINDING_FIELDS`——只有列名的才是身分）。
 *   方向是刻意的：**沒想過的新鍵應該擋下來讓人看一眼**，而不是安靜放行。
 *   假警報會被人改掉（改一行加註解），漏放行不會被任何人發現。
 *
 * ── 第 2 層：資源 binding 拆成「形狀」與「身分」兩半 ────────────────────────
 * 這是第二版誤殺 KV id 的解法。一筆 `[[kv_namespaces]]` 裡：
 *   · `binding = "INSTALLER_KV"` ＝ **形狀**（`worker.js` 讀 `env.INSTALLER_KV`；
 *      少一顆＝那條程式路徑在另一邊直接是 undefined）⇒ **行為，兩邊 binding 名的集合必須相同**
 *   · `id = "750c23fa…"`         ＝ **身分**（D90 明列「憑證與資源 id」）⇒ 准差
 * ⇒ 比的是「**binding 名的集合**」＋「同名 binding 裡**非 id 欄位**」，不是整包比。
 *
 * ── 第 3 層：`vars` 的名字是行為，值預設是身分（但只認得出身分形狀的值）──────
 * 這層是最容易寫寬的地方，所以拆三條：
 *   ① **var 名字的集合必須相同**——一邊有、一邊沒有 ＝ 另一邊那條程式路徑吃到 undefined。
 *      唯一例外＝`ENV_MARKER_VARS`（`DEPLOY_ENV`），D90 明列環境標記是身分。
 *   ② 值不同時，**只有兩邊的值都是「身分形狀」才准**：網址／長 hex（資源 id・指紋）／
 *      環境標記字串。⇒ 不必替每個新的 `*_BASE` 加白名單（第二版就是敗在這種名字白名單
 *      永遠追不上），也擋得住 `EMAIL_ENABLED = "false"` 這種**長得像開關的值**。
 *   ③ 值不是身分形狀、卻真的該跟著身分走的，列進 `COMPANION_VARS`，一條一個理由。
 *      現在只有一筆：`BUNDLE_BUILT`（它是 `BUNDLE_BASE` 那個釘點的 `manifest.built`，
 *      釘點一換它必然跟著換）。
 *
 * ── 第 4 層：真的需要行為差異怎麼辦（D90 明文留的門）────────────────────────
 * D90：「真的需要行為差異 ⇒ **必須有日期、理由、解除條件**，否則 stage 就不再是證據。」
 * ⇒ `WAIVERS`。三個欄位缺一不可，**過期的豁免＝違規**（不是自動續期），
 *   而且**對不到任何差異的豁免也是違規**（差異修好了就要把豁免刪掉，不留殭屍）。
 *
 * ── 這道閘擺在哪 ───────────────────────────────────────────────────────────
 * `ship.mjs` 的 `preflight`（`mutates:false`），跟資源規則閘同一個位置。理由一樣：
 *   ① **預演就看得到**——不必解保險、不必真的出貨
 *   ② deploy 站有「線上已是這版就跳過」的快路徑，擺那裡會有「跳過部署＝跳過檢查」的洞
 *
 * ── 掃哪些檔 ───────────────────────────────────────────────────────────────
 * **自己找**，不寫死清單。寫死＝新加一顆 worker 沒人記得加進來，
 * 那正是 2026-08-11「landing 不在站表裡 ⇒ 從沒被出貨過 ⇒ 而報告全綠」的形狀。
 *
 * 用法：
 *   node installer/scripts/env-parity-gate.mjs        # 不過就 exit 1
 *   node installer/scripts/env-parity-gate.mjs -v     # 連「哪些差異被判成身分」也印出來
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');

// ═══════════════════════════════════════════════════════════════════════════
// 白名單（每一條都要說得出為什麼歸在這邊）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * **不可繼承**的頂層鍵：env 沒宣告就是沒有，不會拿頂層的頂。
 * 出處＝wrangler 的 environments 文件「non-inheritable keys」那張表。
 * 這裡列得比實際用到的多，是因為**漏列的後果是假放行**（把「只有 prod 有」誤判成
 * 「stage 繼承了所以一樣」）——多列一個只會讓人多寫一行宣告。
 */
export const NON_INHERITABLE = new Set([
  'vars', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects',
  'services', 'queues', 'analytics_engine_datasets', 'vectorize', 'hyperdrive',
  'mtls_certificates', 'browser', 'ai', 'version_metadata', 'unsafe',
  'send_email', 'assets', 'dispatch_namespaces', 'workflows', 'pipelines',
  'tail_consumers', 'secrets_store_secrets', 'images', 'ratelimits',
]);

/**
 * **身分**鍵：准兩邊不一樣。鍵名 → 為什麼它是身分。
 * 🔴 沒列在這裡的一律當行為。要加一條，就要能把「這個東西不會改變程式怎麼跑」寫出來。
 */
export const IDENTITY_KEYS = {
  name: 'worker／服務名稱——D90 明列的四類身分之一',
  account_id: '部署到哪個帳號＝身分（帳號不同時本來就該不同；它不改變程式怎麼跑）',
  routes: '對外網址——D90 明列',
  route: '對外網址（單數寫法）——D90 明列',
  workers_dev: '要不要在 workers.dev 上給一個網址＝對外網址的一部分，不是行為',
  preview_urls: '預覽網址＝對外網址',
  // 註：`main`／`compatibility_date`／`compatibility_flags`／`triggers`／`observability`／
  //     `limits`／`placement`／`assets`／`rules`／`no_bundle`／`minify` 全部**不在**這裡
  //     ——它們正是 D90 點名的「行為」。
};

/**
 * 一筆 binding 裡的**身分欄位**：准兩邊不一樣。其餘欄位（含 `binding` 本身、
 * `class_name` 這種指到程式碼的）一律當行為。
 */
export const IDENTITY_BINDING_FIELDS = new Set([
  'id', 'preview_id',              // KV namespace id — D90 明列「資源 id」
  'database_id', 'database_name',  // D1：id 與資源名都是身分
  'bucket_name', 'jurisdiction',   // R2
  'index_name',                    // Vectorize
  'service', 'environment',        // service binding 指到的那顆 worker＝身分
  'script_name',                   // DO 寄居的 worker 名＝身分（class_name 不是！那是程式路徑）
  'queue', 'dead_letter_queue',    // Queue 名稱
  'certificate_id',
  'namespace_id', 'namespace',
  'project_name',
  'localConnectionString',         // 只有 wrangler dev 用
]);

/** var 名字只出現在單邊也 OK 的（D90 明列：環境標記是身分）。 */
export const ENV_MARKER_VARS = new Set(['DEPLOY_ENV', 'ENVIRONMENT', 'WORKER_ENV']);

/** 「身分形狀」的值：兩邊都長這樣時，值不同不算行為差異。 */
export const ENV_MARKER_VALUES = new Set(['prod', 'production', 'stage', 'staging', 'dev', 'development', 'preview', 'test']);

/**
 * 值**不是**身分形狀、但確實跟著某個身分值走的 var。一條一個理由，不准無故長胖。
 */
export const COMPANION_VARS = {
  BUNDLE_BUILT: {
    跟著: 'BUNDLE_BASE',
    理由:
      '它是 BUNDLE_BASE 那個釘點的 manifest.built（D37 單一真相源：換釘點時跟著改）。' +
      '釘點是網址＝身分，而 stage 一定先釘上新的一版、prod 後釘 ⇒ 這兩個日期在「stage 已出、' +
      'prod 未出」的正常視窗裡必然不同。不放行的話這道閘每次出貨都會響一次＝變成沒有閘。',
  },
};

/**
 * D90 明文留的門：真的需要行為差異，就在這裡記名。
 * **三個欄位缺一不可**（D90：「必須有日期、理由、解除條件」）：
 *   { 檔案, 鍵, 到期: 'YYYY-MM-DD', 理由, 解除條件 }
 * 🔴 過期＝違規（不自動續期）；🔴 對不到任何差異＝違規（修好了就把它刪掉）。
 *
 * 下面兩筆（InkStoneCo#139 c13898 收斂 youlin-stage 併進來後才出現）：
 * 兩個都不是這次新產生的判斷，是 `[env.youlin-stage]` 段自己的註解裡**已經寫死**的
 * 既有決定（inkstone/arcrun-rag#217 comment 11161／11162、arcrun-rag#215）——
 * 這裡只是把散文寫的決定也餵給機器閘，不是本票自己在裁。
 */
export const WAIVERS = [
  {
    檔案: 'installer/oauth-prototype/wrangler.toml',
    鍵: 'kv_namespaces',
    到期: '2026-12-26',
    理由:
      'INSTALLER_KV_LEGACY／PEER_INSTALLER_KV_LEGACY 是 prod／staging 從舊 KV 型儲存'
      + '過渡到 Durable Object 的唯讀相容層（見本檔 prod 段落註解「過渡期唯讀 KV」）。'
      + 'youlin-stage 是 2026-09-25 才建的新環境，從第一天就是 DO 型儲存，沒有任何舊'
      + '`deployed:` 紀錄要搬（總管 09-25 實查：youlin-stage 舊 INSTALLER_KV 0 筆）'
      + '——接了也只是白多兩顆沒用到的 binding。',
    解除條件:
      'prod／staging 的 INSTALLER_KV_LEGACY／PEER_INSTALLER_KV_LEGACY 讀量掉到 0、'
      + '整段過渡層被拔掉之後（見本檔案「拔掉的時機」段落），這筆差異連同 prod 那兩顆'
      + 'binding 一起消失，屆時刪掉這筆豁免；到期前若還沒拔，重新評估一個新到期日。',
  },
  {
    檔案: 'installer/oauth-prototype/wrangler.toml',
    鍵: 'vars.MAIL_RELAY_BASE',
    到期: '2026-12-26',
    理由:
      'youlin-stage 的 landing 寄不了信（arcrun.dev 這顆 zone 只在 uncle6 帳號，見下面 landing '
      + 'send_email 那筆），而 leo 2026-10-06 要求 stage 的忘記密碼「走同一條路」真的寄出信'
      + '（inkstone/arcrun-rag#38 c17719）。所以只有 youlin-stage 把 cypher 的代寄座標'
      + '（PORTAL_MAIL_RELAY_BASE）指向 uncle6 已 onboard 的 arcrun-landing-staging；'
      + 'prod 不設＝退回 landingBase(env)，行為不變。同一份郵差程式、同一個寄件網域，'
      + '不是另一條路。',
    解除條件:
      '與 landing 的 send_email／EMAIL_ENABLED 兩筆同一個解除條件：leo 裁定 arcrun.dev 委給 '
      + 'youlin、或 youlin-stage 另掛測試寄件網域之後，youlin-stage 的 landing 自己能寄信，'
      + '刪掉 wrangler.toml 的 MAIL_RELAY_BASE 與這筆豁免，三筆一起刪。',
  },
  {
    檔案: 'landing/wrangler.toml',
    鍵: 'send_email',
    到期: '2026-12-26',
    理由:
      '`send_email` binding 要求寄件網域（arcrun.dev）已在同一個 CF 帳號開通 Email '
      + 'Routing／Sending，而該 zone 只在 uncle6 帳號（見本檔案 [env.youlin-stage] 段'
      + '註解，查證：youlin 帳號 `GET /zones` 回空陣列）。要嘛把 arcrun.dev 委給 '
      + 'youlin、要嘛另掛測試網域，兩者都是要 leo 裁的結構決策，不是本票能自己決定的。',
    解除條件:
      'leo 裁定 arcrun.dev 的 email routing 委給 youlin 帳號，或幫 youlin-stage 另掛一個'
      + '測試專用寄件網域之後，補上 `[env.youlin-stage].send_email` 並刪掉這筆豁免；'
      + '到期前若還沒裁，回頭問一次是否仍要維持現狀。',
  },
  {
    檔案: 'landing/wrangler.toml',
    鍵: 'vars.EMAIL_ENABLED',
    到期: '2026-12-26',
    理由:
      '同上一筆 `send_email` 豁免——youlin-stage 故意留 `EMAIL_ENABLED = "false"`'
      + '（本檔案 [env.youlin-stage] 段落原文：「這是有意的例外，非身分差異」），'
      + 'worker.js:421/470 對 `EMAIL_ENABLED != true` 回乾淨的 503，不 500、不噴 stack。',
    解除條件: '與上一筆 `send_email` 豁免同一個解除條件——兩筆要一起補、一起刪。',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 解析：TOML 走 python3 tomllib（同 repo 既有做法：ship-stations 用 python3 讀 YAML）
// ═══════════════════════════════════════════════════════════════════════════

/** 把 JSONC 的註解換成空白（保留字串內容與位移）。 */
export function stripJsonComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
      continue;
    }
    out += c; i += 1;
  }
  // 尾逗號（JSONC 允許）
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

/** 讀一份 wrangler 設定（.toml／.jsonc／.json），回傳原始物件。 */
export function parseWranglerConfig(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  if (/\.jsonc?$/.test(absPath)) return JSON.parse(stripJsonComments(raw));
  let out;
  try {
    out = execFileSync('python3', ['-c',
      'import sys,tomllib,json; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout, ensure_ascii=False, default=str)'],
    { input: raw, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`wrangler.toml 讀不動（${absPath}）：${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' / ')}`);
  }
  return JSON.parse(out);
}

/**
 * 解析成「wrangler 真的會用的那份設定」。
 * @param {object} raw   整份設定
 * @param {string|null} envName  null ＝ prod（頂層）
 * @returns {{ config: object, ambiguous: string[] }}
 *   `ambiguous` ＝ 不可繼承的鍵只宣告在頂層、env 沒宣告（靠不住，另外報）
 */
export function resolveEnv(raw, envName) {
  const top = { ...raw };
  delete top.env;
  if (!envName) return { config: top, ambiguous: [] };
  const envRaw = (raw.env || {})[envName];
  if (!envRaw) throw new Error(`設定裡沒有 [env.${envName}]`);
  const config = {};
  const ambiguous = [];
  for (const k of new Set([...Object.keys(top), ...Object.keys(envRaw)])) {
    if (k in envRaw) { config[k] = envRaw[k]; continue; }
    if (NON_INHERITABLE.has(k)) { ambiguous.push(k); continue; } // 不繼承 ⇒ env 這邊沒有
    config[k] = top[k];                                          // 可繼承 ⇒ 用頂層的
  }
  return { config, ambiguous };
}

/** 這份設定宣告了哪些 env。 */
export function envNames(raw) {
  return Object.keys(raw.env || {});
}

// ═══════════════════════════════════════════════════════════════════════════
// 比對
// ═══════════════════════════════════════════════════════════════════════════

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (v === undefined ? '（沒有這個設定）' : JSON.stringify(v));

/** 是不是「一串 binding」——陣列、元素都是物件、都有同一個 key 欄位。 */
export function bindingKeyField(arr) {
  if (!Array.isArray(arr) || arr.length === 0 || !arr.every(isObj)) return null;
  for (const f of ['binding', 'name']) if (arr.every((e) => typeof e[f] === 'string')) return f;
  return null;
}

/** 值是不是「身分形狀」：網址／長 hex（資源 id・指紋）／環境標記字串。 */
export function isIdentityShaped(v) {
  if (typeof v !== 'string') return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^[0-9a-f]{16,}$/i.test(v)) return true;
  if (ENV_MARKER_VALUES.has(v.trim().toLowerCase())) return true;
  return false;
}

/**
 * 比 `vars`。回 `{ problems, identityDiffs }`。
 */
export function diffVars(prodVars = {}, stageVars = {}, envName = 'staging') {
  const problems = [];
  const identityDiffs = [];
  const names = [...new Set([...Object.keys(prodVars), ...Object.keys(stageVars)])].sort();
  for (const n of names) {
    const inProd = n in prodVars;
    const inStage = n in stageVars;
    if (inProd !== inStage) {
      if (ENV_MARKER_VARS.has(n)) {
        identityDiffs.push(`vars.${n}：只有 ${inStage ? envName : 'prod'} 有（環境標記＝身分，D90 明列）`);
        continue;
      }
      problems.push({
        key: `vars.${n}`,
        detail: `只有 ${inStage ? envName : 'prod'} 宣告了這個 var`,
        why: '另一邊讀到的是 undefined ⇒ 那條程式路徑兩邊不一樣，正是 D90 說的「功能開關／程式路徑」差異',
      });
      continue;
    }
    const a = prodVars[n];
    const b = stageVars[n];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (COMPANION_VARS[n]) {
      identityDiffs.push(`vars.${n}：跟著 ${COMPANION_VARS[n].跟著} 走（見 COMPANION_VARS 的理由）`);
      continue;
    }
    if (isIdentityShaped(a) && isIdentityShaped(b)) {
      identityDiffs.push(`vars.${n}：${show(a)} ≠ ${show(b)}（兩邊都是身分形狀：網址／資源 id／環境標記）`);
      continue;
    }
    problems.push({
      key: `vars.${n}`,
      detail: `prod ＝ ${show(a)}／${envName} ＝ ${show(b)}`,
      why: '值不是「身分形狀」（不是網址、不是資源 id、不是環境標記）⇒ 當成功能開關看待。'
         + '真的是身分就把它寫成身分形狀，或加進 COMPANION_VARS（要附理由）',
    });
  }
  return { problems, identityDiffs };
}

/** 比一串 binding：binding 名的集合＝行為；同名 binding 裡的 id 欄位＝身分。 */
export function diffBindings(section, keyField, prodArr = [], stageArr = [], envName = 'staging') {
  const problems = [];
  const identityDiffs = [];
  const idx = (arr) => Object.fromEntries((arr || []).map((e) => [e[keyField], e]));
  const P = idx(prodArr);
  const S = idx(stageArr);
  const namesP = Object.keys(P);
  const namesS = Object.keys(S);
  const onlyP = namesP.filter((n) => !(n in S));
  const onlyS = namesS.filter((n) => !(n in P));
  if (onlyP.length || onlyS.length) {
    problems.push({
      key: section,
      detail: `binding 集合不同：只有 prod 有 ${onlyP.length ? onlyP.join('、') : '（無）'}；`
            + `只有 ${envName} 有 ${onlyS.length ? onlyS.join('、') : '（無）'}`,
      why: '資源形狀是行為（D90 明列）——少一顆 binding，另一邊那段程式讀到的就是 undefined。'
         + 'id 可以不同（那是身分），但**有哪幾顆**必須相同',
    });
  }
  for (const n of namesP.filter((x) => x in S)) {
    for (const f of new Set([...Object.keys(P[n]), ...Object.keys(S[n])])) {
      const a = P[n][f];
      const b = S[n][f];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (IDENTITY_BINDING_FIELDS.has(f)) {
        identityDiffs.push(`${section}[${n}].${f}：${show(a)} ≠ ${show(b)}（資源 id／資源名＝身分，D90 明列）`);
        continue;
      }
      problems.push({
        key: `${section}[${n}].${f}`,
        detail: `prod ＝ ${show(a)}／${envName} ＝ ${show(b)}`,
        why: `binding 裡除了 id／資源名以外的欄位都指著程式怎麼跑（例如 class_name）⇒ 行為。`
           + `確定它是身分，就把 ${f} 加進 IDENTITY_BINDING_FIELDS（要附理由）`,
      });
    }
  }
  return { problems, identityDiffs };
}

/** 一般鍵的深比對（除了 binding 與 vars 之外的東西，全部當行為）。 */
function deepDiff(path, a, b, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(`${path}.${k}`, a[k], b[k], out);
    return;
  }
  out.push({ path, a, b });
}

/**
 * 比一份設定的 prod 與某個 env。
 * @returns {{ ok, problems, identityDiffs, file, envName }}
 */
export function compareEnv(raw, envName, fileLabel = '') {
  const problems = [];
  const identityDiffs = [];
  const prod = resolveEnv(raw, null).config;
  const { config: stage, ambiguous } = resolveEnv(raw, envName);

  for (const k of ambiguous) {
    problems.push({
      key: k,
      detail: `只宣告在頂層，[env.${envName}] 沒有宣告`,
      why: `\`${k}\` 是 wrangler 的「不可繼承」鍵——照規格 ${envName} 這邊會是空的，`
         + `但各版本 wrangler 對它的處置變過（本 repo docs-site/wrangler.toml 就記著 routes 的實測反例）。`
         + `⇒ 靠不住的東西不要靠：在 [env.${envName}] 明寫一份`,
    });
  }

  for (const k of new Set([...Object.keys(prod), ...Object.keys(stage)])) {
    if (k === 'env') continue;
    const a = prod[k];
    const b = stage[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;

    if (k in IDENTITY_KEYS) {
      identityDiffs.push(`${k}：${show(a)} ≠ ${show(b)}（${IDENTITY_KEYS[k]}）`);
      continue;
    }
    if (k === 'vars') {
      const r = diffVars(a || {}, b || {}, envName);
      problems.push(...r.problems);
      identityDiffs.push(...r.identityDiffs);
      continue;
    }
    const kf = bindingKeyField(a) || bindingKeyField(b);
    if (kf) {
      const r = diffBindings(k, kf, a || [], b || [], envName);
      problems.push(...r.problems);
      identityDiffs.push(...r.identityDiffs);
      continue;
    }
    // `durable_objects` 是 wrangler 唯一一個把 binding 陣列包在 `{ bindings: [...] }`
    // 底下的頂層鍵（其餘都是直接一個陣列，走上面那條）。不拆開的話，`script_name`
    // 這種已經在 IDENTITY_BINDING_FIELDS 白名單裡的身分欄位會被 deepDiff 整包比對，
    // 一律當「行為差異」報出來——InkStoneCo#139 c13898 實撞：PEER_INSTALLER_STORE
    // 兩邊互指對方 script_name（身分，本來就該不同），卻被這道閘誤判成行為差異。
    const aBindings = isObj(a) && Array.isArray(a.bindings) ? a.bindings : undefined;
    const bBindings = isObj(b) && Array.isArray(b.bindings) ? b.bindings : undefined;
    if (aBindings || bBindings) {
      const nestedKf = bindingKeyField(aBindings) || bindingKeyField(bBindings);
      if (nestedKf) {
        const r = diffBindings(`${k}.bindings`, nestedKf, aBindings || [], bBindings || [], envName);
        problems.push(...r.problems);
        identityDiffs.push(...r.identityDiffs);
        continue;
      }
    }
    const diffs = [];
    deepDiff(k, a, b, diffs);
    for (const d of diffs) {
      problems.push({
        key: d.path,
        detail: `prod ＝ ${show(d.a)}／${envName} ＝ ${show(d.b)}`,
        why: 'D90：flag／相容性設定／功能開關／程式路徑／資源形狀／重試逾時參數＝行為，兩邊必須一樣。'
           + '身分只有四類：名稱、對外網址、憑證與資源 id、環境標記',
      });
    }
  }
  return { ok: problems.length === 0, problems, identityDiffs, file: fileLabel, envName };
}

// ═══════════════════════════════════════════════════════════════════════════
// 豁免
// ═══════════════════════════════════════════════════════════════════════════

const REQUIRED_WAIVER_FIELDS = ['檔案', '鍵', '到期', '理由', '解除條件'];

/**
 * 套用豁免。回 `{ results, problems }`——`problems` 是**豁免自己的**毛病
 * （欄位缺、過期、對不到任何差異），那些一樣會擋下出貨。
 */
export function applyWaivers(results, waivers = WAIVERS, today = new Date().toISOString().slice(0, 10)) {
  const problems = [];
  const used = new Set();
  for (const [i, w] of waivers.entries()) {
    const missing = REQUIRED_WAIVER_FIELDS.filter((f) => !String(w?.[f] ?? '').trim());
    if (missing.length) {
      problems.push(`第 ${i + 1} 筆豁免缺欄位：${missing.join('、')}\n`
        + `       ⇒ D90 明文：「真的需要行為差異，必須有日期、理由、解除條件」。缺一個就不是豁免，是藉口。`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.到期)) {
      problems.push(`第 ${i + 1} 筆豁免的「到期」不是 YYYY-MM-DD：${w.到期}`);
      continue;
    }
    if (w.到期 < today) {
      problems.push(`豁免過期了：${w.檔案} 的 \`${w.鍵}\`（到期 ${w.到期}，今天 ${today}）\n`
        + `       解除條件寫的是：${w.解除條件}\n`
        + `       ⇒ 過期不會自動續期。要嘛把差異修掉，要嘛重新評估並寫一個新的到期日。`);
      continue;
    }
    let hit = 0;
    for (const r of results) {
      if (r.file !== w.檔案) continue;
      const before = r.problems.length;
      r.problems = r.problems.filter((p) => p.key !== w.鍵);
      hit += before - r.problems.length;
      if (before !== r.problems.length) r.waived = [...(r.waived || []), `${w.鍵}（到期 ${w.到期}：${w.理由}）`];
    }
    if (hit === 0) {
      problems.push(`豁免對不到任何差異：${w.檔案} 的 \`${w.鍵}\`\n`
        + `       ⇒ 差異已經不存在了（很好），那就把這筆豁免刪掉。殭屍豁免會在下一次真的出現差異時安靜放行。`);
    } else {
      used.add(i);
    }
  }
  for (const r of results) r.ok = r.problems.length === 0;
  return { results, problems };
}

// ═══════════════════════════════════════════════════════════════════════════
// 掃描 + 入口
// ═══════════════════════════════════════════════════════════════════════════

/** 不掃的目錄：外部套件、產生出來的鏡像、其他人的工作區、建置產物。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github-public', '.claude', '_archive',
  'dist', 'deploy', 'build', '.wrangler', 'coverage', 'vendor',
]);

/** 找出所有 wrangler 設定檔（相對路徑，排序過）。 */
export function findConfigs(repoRoot = REPO_ROOT) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(e) || e.startsWith('.') && e !== '.') continue;
        walk(abs);
      } else if (/^wrangler\.(toml|jsonc|json)$/.test(e)) {
        found.push(relative(repoRoot, abs));
      }
    }
  };
  walk(repoRoot);
  return found.sort();
}

/** 閘自己的測試檔——`REPO_ROOT` 底下才有，臨時目錄（測試用）沒有就跳過。 */
export const SELFTEST_REL = join('installer', 'scripts', 'env-parity-gate.test.mjs');
/** 遞迴保險：自我測試裡呼叫 runGate 時不要再 spawn 一次自我測試。 */
const SELFTEST_ENV = 'ENV_PARITY_GATE_SELFTEST';

/**
 * 跑閘自己的演練（同 resource-rule-gate 的 runScenarioTests，理由一樣）：
 * **沒跑過的閘等於沒有閘**——`copy-contract.test.mjs` 那份文案閘就是沒人跑，
 * 於是從來沒擋過任何東西。這裡讓每一次出貨都順手證明「這道閘該擋的還擋得住」。
 */
export function runSelfTest(repoRoot = REPO_ROOT) {
  if (process.env[SELFTEST_ENV] === '1') return { ok: true, problems: [], passed: 0, note: '（自我測試內，不遞迴）' };
  if (!existsSync(join(repoRoot, SELFTEST_REL))) return { ok: true, problems: [], passed: 0, note: '（這個目錄沒有測試檔，跳過）' };
  const r = spawnSync(process.execPath, ['--test', SELFTEST_REL],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, [SELFTEST_ENV]: '1' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  const ok = r.status === 0 && !!pass && Number(pass[1]) > 0 && (!fail || Number(fail[1]) === 0);
  return {
    ok,
    problems: ok ? [] : [`閘自己的演練沒過（${SELFTEST_REL}）：\n${out.split('\n').filter((l) => /^not ok|^# (pass|fail)/.test(l)).join('\n')}`],
    passed: pass ? Number(pass[1]) : 0,
  };
}

/**
 * 跑整道閘。回 `{ ok, sections, problems }`——**不自己 exit**，CLI 與測試共用同一個入口
 * （純函式才測得動所有分支，同 ship-report.mjs／ship-stations.mjs 檔頭的理由）。
 */
export function runGate(repoRoot = REPO_ROOT, { waivers = WAIVERS, today = undefined, configs = undefined, selfTest = true } = {}) {
  const files = configs || findConfigs(repoRoot);
  const results = [];
  const gateProblems = [];

  for (const rel of files) {
    let raw;
    try {
      raw = parseWranglerConfig(join(repoRoot, rel));
    } catch (e) {
      gateProblems.push(`${rel} 讀不動：${e.message}`);
      continue;
    }
    for (const env of envNames(raw)) {
      try {
        results.push(compareEnv(raw, env, rel));
      } catch (e) {
        gateProblems.push(`${rel} 的 [env.${env}] 比不了：${e.message}`);
      }
    }
  }

  // 🔴 防「檢查了 0 個卻通過」——同 resource-rule-gate 那道 `scanned.length === 0`。
  // 這個 repo 至少有 installer／landing／docs-site 三份設定宣告了 staging；
  // 掃到 0 對就是掃描範圍設錯了，而那種「全綠」是假的。
  if (results.length === 0) {
    gateProblems.push(
      `一對 prod／stage 都沒比到（掃了 ${files.length} 份 wrangler 設定）\n`
      + `       ⇒ 掃描範圍或排除清單設錯了。這種「全綠」是假的，比壞掉還糟。`);
  }

  const waived = applyWaivers(results, waivers, today);
  gateProblems.push(...waived.problems);

  const self = selfTest ? runSelfTest(repoRoot) : { ok: true, problems: [], passed: 0, note: '（呼叫端關掉了）' };

  const sections = results.map((r) => ({
    name: `${r.file} ── prod ⇄ env.${r.envName}`,
    ok: r.ok,
    problems: r.problems.map((p) => `\`${p.key}\`：${p.detail}\n         理由：${p.why}`),
    note: r.ok
      ? `只剩身分差異 ${r.identityDiffs.length} 項${r.waived ? `｜記名豁免 ${r.waived.length} 項` : ''}`
      : `行為差異 ${r.problems.length} 項｜身分差異 ${r.identityDiffs.length} 項`,
    identityDiffs: r.identityDiffs,
    waived: r.waived || [],
  }));
  if (gateProblems.length) sections.push({ name: '掃描範圍與豁免', ok: false, problems: gateProblems, note: '', identityDiffs: [], waived: [] });
  sections.push({
    name: '閘自己的演練（該擋的擋得住、不該擋的沒誤殺）',
    ok: self.ok, problems: self.problems, note: self.note || `${self.passed} 項通過`,
    identityDiffs: [], waived: [],
  });

  return { ok: sections.every((s) => s.ok), sections, files, pairs: results.length };
}

/** 出事時要印給人看的「下一步怎麼辦」——不是只說「不一致」。 */
export const NEXT_STEPS =
  '下一步（三選一，D90 已經指定了預設方向）：\n'
+ '  ① **把 prod 補成跟 stage 一樣**（預設）——我們所有測試都是在 stage 那個設定上做的，\n'
+ '     把 stage 的拿掉等於把「驗過的」改成「沒驗過的」。\n'
+ '     ⚠️ 改 prod 的行為＝出貨動作，要 leo 親手開閘。\n'
+ '  ② 確認 stage 那個設定本來就多餘 → 從 stage 拿掉，兩邊都沒有（然後在 stage 重測一次）。\n'
+ '  ③ 真的必須不一樣 → 去 installer/scripts/env-parity-gate.mjs 的 `WAIVERS` 加一筆，\n'
+ '     **必須有「到期／理由／解除條件」**（D90 明文），少一個欄位這道閘不收。\n'
+ '  ＊ 如果你覺得這是誤判（那個鍵其實是身分）：把它加進 `IDENTITY_KEYS`／\n'
+ '    `IDENTITY_BINDING_FIELDS`，並在旁邊寫清楚「為什麼它不改變程式怎麼跑」。';

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
  const { ok, sections, files } = runGate();
  console.log(`掃到 ${files.length} 份 wrangler 設定：${files.join('、')}\n`);
  for (const s of sections) {
    console.log(`${s.ok ? '✅' : '❌'} ${s.name}${s.note ? `（${s.note}）` : ''}`);
    for (const p of s.problems) console.log(`   - ${p}`);
    if (verbose) for (const d of s.identityDiffs) console.log(`   · 身分差異（放行）：${d}`);
    for (const w of s.waived || []) console.log(`   ⚠ 記名豁免：${w}`);
  }
  if (!ok) {
    console.error('\n🔴 環境對等閘不過——拒絕出貨（D90）。');
    console.error('   stage 存在的唯一理由是「在這裡測過，prod 就會一樣」。');
    console.error('   有一個行為差異，這個前提就破了——而且壞法是隱形的：stage 全綠、prod 炸給用戶看。\n');
    console.error(NEXT_STEPS);
    process.exit(1);
  }
  console.log('\n✅ 環境對等閘全過：prod 與 stage 的差異全部落在身分白名單裡（D90）。');
}
