/**
 * Arcrun RAG 一鍵安裝器（原型）
 *
 * 單一 JS module worker，零框架零 npm 依賴。
 * 需要一個 KV binding：INSTALLER_KV（存 OAuth state / session / 安裝進度）
 *
 * 流程：
 *   GET  /                    安裝首頁
 *   GET  /auth/start          產生 PKCE + state，導去 Cloudflare 授權頁
 *   GET  /auth/callback       換 token，存 KV，導去 /install
 *   GET  /install             安裝進度頁（前端輪詢）
 *   POST /api/install/start   真正執行安裝
 *   GET  /api/install/status  回進度 JSON
 *   POST /api/setup-account   帳密精靈：代理 console setup→login→portal bootstrap（帳密不落地）
 */

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

// PKCE public client，無 secret。
// ⚠️ **這個值必須與「installer worker 所在帳號」註冊的 OAuth client 一致**——
// client 的 redirect_uri 是註冊時綁死的，對不上會在 Cloudflare 授權頁直接噴
// `redirect_uri does not match any of the OAuth 2.0 Client's pre-registered redirect urls`
// （2026-07-28 leo 實撞：整條安裝流程斷掉）。
// 真兇＝07-27 把 installer 從 youlin 搬到 uncle6（wiki agent-memory「對外資產歸屬地圖」），
// **但這行寫死的 client_id 沒跟著換**，仍是 youlin 時代那顆 a314ca87…。
// 換帳號／換網域時，**這行與 redirect_uri 註冊值要一起改**。
const OAUTH_CLIENT_ID = '79b44eac75163a82c47bbcfe31c44359';
const OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const CF_API = 'https://api.cloudflare.com/client/v4';

const OAUTH_SCOPES = [
  'workers-scripts.write',
  'workers-kv-storage.write',
  'd1.write',
  'vectorize.write',
  'account-settings.read',
  'offline_access',
].join(' ');

const SESSION_COOKIE = 'arcrun_sid';
const STATE_TTL = 600;          // OAuth state 10 分鐘
const SESSION_TTL = 86400;      // session 本身 1 天
const PROGRESS_TTL = 86400;

// 辨識碼驗證中央服務（landing）。可用 env.LANDING_BASE 覆蓋（換官方帳號時）。
const DEFAULT_LANDING_BASE = 'https://arcrun-landing.uncle6-me.workers.dev';
function landingBase(env) {
  return (env && env.LANDING_BASE ? String(env.LANDING_BASE) : DEFAULT_LANDING_BASE).replace(/\/+$/, '');
}

// 🔴 人看的導覽網址（arcrun-rag#29 驗收帶出的坑，2026-08-09）：`LANDING_BASE` 是
// **後端**打 landing API 用的（值是 workers.dev），跟畫面上「首頁／說明文件」導覽
// 連結該顯示的**人看的網址**是兩件事——後者以前整段寫死 `rag.arcrun.dev`，
// 查過 `git log -S"xnav"／-S"docsBase"／-S"SITE_BASE"`：nav 只被改過視覺樣式
// （7d07847），從沒人做過環境感知，不是重修舊坑。
// 實測踩到：staging 頁面導覽列全部把人導去 prod（剛做好的 stage 文件站完全連不到）。
// 新增這兩個各自可覆蓋，staging 段落照 LANDING_BASE 同一個模式覆蓋，
// prod 沿用預設值＝零行為改變。
const DEFAULT_SITE_BASE = 'https://rag.arcrun.dev';
function siteBase(env) {
  return (env && env.SITE_BASE ? String(env.SITE_BASE) : DEFAULT_SITE_BASE).replace(/\/+$/, '');
}
const DEFAULT_DOCS_BASE = 'https://rag.arcrun.dev/docs';
function docsBase(env) {
  return (env && env.DOCS_BASE ? String(env.DOCS_BASE) : DEFAULT_DOCS_BASE).replace(/\/+$/, '');
}

// P0-3 逾時偵測：安裝進度超過這個時間沒有任何更新，視為卡死（waitUntil 被中斷）。
// 各步驟之間、自檢輪詢每輪都會回寫進度，正常間隔遠小於此值。
// stall 判定門檻。**必須大於最長的單一步驟**——07-29 事故：自我檢查最長重試約 3 分鐘
// （26 次：前 10 次 3s、之後 10s），但門檻是 2 分鐘 ⇒ 健檢還在正常等 DNS 生效，
// 外層就宣告「安裝好像卡住了」。改 5 分鐘，留足餘裕。
const STALL_MS = 300000; // 5 分鐘

// P0-4 懶載：核心 worker bundle 的公開來源（leo 拍板 jsDelivr over GitHub 門面）。
// 可用 env.BUNDLE_BASE 覆蓋（換 ref／換 repo／本機測試）。
// 佔位符——待 bundles/ 發佈上 public GitHub（總管 arm）後填實際 <owner>/<repo>@<ref>/<dir>。
// 🔒 釘死 commit 而非 @main（leo 2026-07-28：「更新快取是靠什麼？版本號？那每次推要改版本號」）
// jsDelivr 對 @main 快取 ~12h 且 purge 不可靠（07-28 害 leo 白重裝一次，mistakes 二十二）；
// 對 @<commit> 則**永久不變、永不供舊**。⇒ 推 bundle 的收尾步驟＝
//   ① cd bundles repo && git rev-parse HEAD ② 換掉下面這行 ③ 部署本 worker（見 install-flow-map §3.5）
// **漏做 ②③ ＝ 用戶永遠拿舊版**，比 @main 更明確地壞 ⇒ 好處是「壞法可預測、驗一次就知道」。
const DEFAULT_BUNDLE_BASE = 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@20d4ad6900f51e02242815402a70890fc5b12712';
const BUNDLE_BUILT = '2026-08-13'; // manifest.built 鏡像（b1305e9），換 bundle 時和上行釘碼一起改
// 安裝器自身補丁標記（bundle 沒動、只改安裝器邏輯時遞增；顯示在首頁按鈕，部署驗證用）
const INSTALLER_PATCH = '2026-08-10b'; // b＝拆掉帳號選擇頁（CF 授權屏已有 Select account(s)），只留 fail-closed
function bundleBase(env) {
  return (env && env.BUNDLE_BASE ? String(env.BUNDLE_BASE) : DEFAULT_BUNDLE_BASE).replace(/\/+$/, '');
}
/** 釘點 commit 短碼——從 bundleBase(env) 導出（支援 jsDelivr `@<sha>` 與 Gitea raw `/raw/commit/<sha>/`）。
 *  D37：staging 用 env.BUNDLE_BASE 蓋掉釘點時，版本標記必須跟著 env 走，不能寫死 DEFAULT。 */
function bundleCommitOf(env) {
  const b = bundleBase(env);
  const m = b.match(/@([0-9a-f]{7,40})/) || b.match(/\/raw\/commit\/([0-9a-f]{7,40})/);
  return m ? m[1].slice(0, 7) : 'unknown';
}
/** manifest.built 的顯示值——deploy 時由部署腳本從釘點 manifest 導出、以 env.BUNDLE_BUILT 注入
 *  （D37 版本單一真相源＝manifest）；未注入時退回常數（漂移風險，見 mistakes「BUNDLE_BUILT 漏改」）。
 *  ⚠️ 2026-08-02 起僅供內部除錯／退路使用，**不再是用戶看到的版本號**（見下方 releaseOf）。 */
function bundleBuiltOf(env) {
  return (env && env.BUNDLE_BUILT ? String(env.BUNDLE_BUILT) : BUNDLE_BUILT);
}

/**
 * 🆕 用戶看到的版本號（leo 2026-08-02 選定 semver，例 `1.4.2`）。
 *
 * ── 為什麼改成 runtime 讀 manifest ────────────────────────────────────
 * 舊做法把版本字串寫成常數（`BUNDLE_BUILT`）＋landing 再手抄一份，結果 08-02 被 leo 抓到：
 * 四代釘點 ui 內容都變了、顯示的日期卻永遠是 2026-07-31，landing 更落後兩代。
 * 根因是「同一個事實有三份手抄本」⇒ 換釘子時一定會漏改其中幾份。
 * 現在版本號**只存在 manifest.release 一處**，安裝器每次讀釘點 manifest 拿它，
 * **沒有任何地方需要人去同步** ⇒ leo：「做成自動化，不依賴你記得去更新」。
 *
 * 快取：釘點是 immutable commit sha，manifest 內容永不變 ⇒ 可長快取（1 天）。
 * 讀失敗時退回舊格式字串，只是顯示退化，不影響安裝流程。
 */
async function releaseOf(env) {
  const base = bundleBase(env);
  const cacheKey = new Request(`https://internal.arcrun/release?base=${encodeURIComponent(base)}`);
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.text();
  } catch { /* caches 不可用（本機測試）就直接抓 */ }

  let version;
  try {
    const r = await fetch(base + '/manifest.json', { cf: { cacheTtl: 86400 } });
    if (r.ok) {
      const m = await r.json();
      version = m && m.release ? String(m.release) : null;
    }
  } catch { /* 網路失敗 → 退路 */ }

  // 退路：manifest 還沒有 release 欄（舊 bundle）時，沿用舊格式，至少不是空白
  if (!version) version = `${bundleBuiltOf(env)}+${bundleCommitOf(env)}`;

  try {
    await cache.put(cacheKey, new Response(version, {
      headers: { 'cache-control': 'max-age=86400', 'content-type': 'text/plain; charset=utf-8' },
    }));
  } catch { /* 寫快取失敗不影響回傳 */ }
  return version;
}

/**
 * 🆕 授權頁「技術細節」要顯示的安裝內容數量——從 manifest 動態算，不再寫死。
 *
 * ── 為什麼不能手抄一個數字（arcrun-rag PR #89 教訓）───────────────────
 * 舊寫法把「Workers script ×N」直接寫死在 HTML 字串裡。PR #89 把 ×1 改成 ×6，
 * 但那只是把一個會過期的數字換成另一個會過期的數字——`bundle-components.mjs`
 * 本來就會隨產品演進增減零件（08-10 才剛從 5 顆變 6 顆，見該檔案開頭病史），
 * 下次再加一顆，這裡又得有人記得手動再改一次字面值。
 *
 * KV 數更不能亂猜：runInstall（cache 步驟一帶）是「manifest.core 裡每個不重複的
 * requires.kv binding 名，各建一個 CF KV namespace」——不是固定 1 個。當前 prod
 * manifest 實測有 8 個不重複 KV binding（EXEC_CONTEXT／WEBHOOKS／CREDENTIALS_KV／
 * ANALYTICS_KV／RECIPES／USERS_KV／SESSIONS_KV／OAUTH_KV），舊文案寫「×1」本來就是錯的。
 * D1 目前恆為 1（ensureD1Database 只呼叫一次，所有 requires.d1 條目共用同一顆
 * resources.d1Id），這裡仍然用「不重複 database_name 數」算出來、不寫死 1——
 * 未來若真的變成多顆，這裡不需要人記得回來改。
 *
 * 算法必須跟 runInstall 讀同一份 manifest、用同一條規則，manifest 換了這裡自動跟著換，
 * 不會再出現「授權頁說的數字」與「實際會建立的資源」兜不起來的狀況。
 */
async function manifestCountsOf(env) {
  const base = bundleBase(env);
  const cacheKey = new Request(`https://internal.arcrun/manifest-counts?base=${encodeURIComponent(base)}`);
  // typeof 判斷放最前面：Node 離線測試環境沒有全域 `caches`（存取 `caches.default` 本身
  // 就會先丟 ReferenceError），要在進 try 之前就擋掉，不能只包 `.match()` 那一步。
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    const hit = cache && (await cache.match(cacheKey));
    if (hit) return await hit.json();
  } catch { /* caches 不可用（本機測試）就直接抓 */ }

  let counts = null;
  try {
    const r = await fetch(base + '/manifest.json', { cf: { cacheTtl: 86400 } });
    if (r.ok) {
      const m = await r.json();
      if (m && Array.isArray(m.core)) {
        const workerCount = m.core.length;
        // 與 runInstall 建 KV 那段同一條算法：不重複 kv binding 名數
        const kvNames = new Set(m.core.flatMap((c) => (c.requires && c.requires.kv) || []));
        // 與 runInstall 建 D1 那段（ensureD1Database）同一件事：不重複 database_name 數
        const d1Names = new Set(
          m.core
            .flatMap((c) => (c.requires && c.requires.d1) || [])
            .map((d) => (d && d.database_name) || null)
            .filter(Boolean),
        );
        counts = { workerCount, kvCount: kvNames.size, d1Count: d1Names.size || 1 };
      }
    }
  } catch { /* 網路失敗 → 退路 */ }

  // 退路：manifest 抓不到時老實說「讀不到」，不要硬填一個可能早就錯的數字充版面
  if (!counts) counts = { workerCount: null, kvCount: null, d1Count: null };

  try {
    if (cache) {
      await cache.put(cacheKey, new Response(JSON.stringify(counts), {
        headers: { 'cache-control': 'max-age=86400', 'content-type': 'application/json; charset=utf-8' },
      }));
    }
  } catch { /* 寫快取失敗不影響回傳 */ }
  return counts;
}

import MIGRATIONS from './migrations.json' with { type: 'json' };
import WORKFLOWS from './workflows.json' with { type: 'json' };
import SKILLS from './skills.json' with { type: 'json' };

// ── 「這台實例該用哪幾顆資源」＝上游 Arcrun 的共用規則，本檔一行都不重寫 ──────
//
// leo 2026-08-12：「如果你沒有裝，就是新的；**如果你已經有，原來叫什麼名字就繼續用下去**。」
//                「**根本就不應該在 CLI，我要的是一個大家都可以用到的規則。**」
//
// 規則住在 `Leo/Arcrun` 的 `shared/resource-rule/`（PR #111，已併 main 13155a1），
// `acr` 與本安裝器吃**同一份**。`./shared/resource-rule/` 是它的逐位元組鏡射，
// 由 `installer/scripts/resource-rule-sync.mjs` 產生、`resource-rule-gate.mjs` 在出貨
// preflight 上核對指紋——**不准手改**（為什麼要鏡射而不是直接 import 上游路徑，
// 見 resource-rule-sync.mjs 檔頭：這顆是裸 Worker，import 必須在部署當下解析得到）。
//
// 🔴 判準從此是「**這顆 worker 現在綁著誰**」，不是「有沒有叫這個名字的資源」。
//    舊寫法（ensureKvNamespace/ensureD1Database/ensureVectorizeIndex：照名字找、找不到就建）
//    已整段刪除——那正是 `Leo/Arcrun#97`「我按了更新，工作流和登入全不見了」的病根。
import { planResources, applyResourcePlan, ResourcePlanBlocked, bindingKey } from './shared/resource-rule/rule.mjs';
import { createCloudflareResourceApi } from './shared/resource-rule/cf-resource-api.mjs';

// 安裝步驟定義（順序即執行順序）
const STEPS = [
  { id: 'account',   label: '確認你的 Cloudflare 帳號' },
  { id: 'cache',     label: '建立快取空間' },
  { id: 'database',  label: '建立知識庫資料庫' },
  { id: 'schema',    label: '建立資料表結構' },
  { id: 'deploy',    label: '部署你的專屬服務' },
  { id: 'workflows', label: '安裝 AI 工作流' },
  { id: 'verify',    label: '自我檢查' },
];

const COMPAT_DATE = '2026-01-01';

// t26 分批接力（stall 修復）：runInstall 整段跑在 ctx.waitUntil 裡，真兇＝waitUntil 的
// ~30 秒牆鐘上限（付費帳號同樣適用）——前置步驟＋兩顆 worker 的流量吃光後，第 3 顆被
// 靜默掐死（無錯誤、單純 stall，P0-3 逾時偵測器抓到的就是這個死法）。免費層另有 50
// subrequests/invocation 頂，是用戶未來實際會撞到的第二道牆（youlin 帳號是付費 1000，
// 這次沒撞到但產品必須治）。兩道牆用同一組護欄治：每輪 deploy 迴圈最多新部署
// DEPLOY_BUDGET_PER_RUN 顆＋超過 DEPLOY_TIME_BUDGET_MS 就停手，把游標存進
// progress.result.deployedNames，state 設 paused_continue（不是 error）；前端輪詢看到
// paused_continue 自動再打一次 /api/install/start 接力，直到 26 顆全部部署完。
// 每輪最多新部署幾顆。受 waitUntil 30 秒與免費層 50 subrequests/invocation 雙重限制
// （每顆約 4 個 subrequest）。6 顆≈24 subrequests，留餘裕給前置步驟。
const DEPLOY_BUDGET_PER_RUN = 6;
// ⚠️ **絕對不可超過 waitUntil 的 ~30 秒牆鐘上限**（見上方註解；超過＝整輪被靜默掐死）。
// 07-29 總管一度改成 45000＝把護欄拆了，會讓每輪必死——leo 點破「兩個獨立帳號同時卡
// ⇒ 只有提供方（安裝器 worker 本身）爆掉才會同時」才發現。20 秒留 10 秒餘裕給收尾。
const DEPLOY_TIME_BUDGET_MS = 20000;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomB64(len = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(len)));
}

/** 資源命名用的短隨機碼（小寫英數，避開易混淆字元） */
function shortId(n = 6) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(digest);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * 品牌圖示（照抄 landing/worker.js 既有實作，同一顆 icon、同樣 content-type／route 寫法。
 * 2026-07-31 換裝第四處：rag.arcrun.dev／托盤／app／msix 已換，這裡補上 install.arcrun.dev）。
 *
 * 幾何抄自 CIS 的 `mark-square-ink.svg`（512 格），這裡改成 256 格：
 * 墨底（Ink #17181A）＋ paper 色雙 chevron，單色（CIS 規定 mark 永遠單色）。
 *
 * 一顆 SVG 同時服務三個位置：瀏覽器分頁 favicon、CF OAuth 授權頁品牌圖示（logo_uri）、
 * 以及 apple-touch-icon。要換品牌就改 `InkStoneCo/arcrun-cis/` 再重產。
 */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Arcrun 知識庫"><rect width="1024" height="1024" fill="#17181A"/><path fill="#FDFCFB" fill-rule="nonzero" d="M463.01,612.91 L436.06,612.91 L436.06,485.41 L435.86,477.78 L435.27,470.46 L434.28,463.44 L432.89,456.73 L431.11,450.31 L428.93,444.20 L426.36,438.39 L423.39,432.88 L420.02,427.68 L416.26,422.78 L412.10,418.18 L407.55,413.88 L402.62,409.91 L397.31,406.28 L391.65,402.99 L385.61,400.06 L379.21,397.47 L372.44,395.22 L365.30,393.32 L357.79,391.76 L349.92,390.55 L341.68,389.69 L333.08,389.17 L324.10,389.00 L317.39,389.10 L310.90,389.40 L304.63,389.89 L298.59,390.58 L292.77,391.47 L287.17,392.56 L281.80,393.85 L276.65,395.33 L271.72,397.02 L267.02,398.90 L262.53,400.98 L258.28,403.25 L254.20,405.69 L250.26,408.26 L246.45,410.95 L242.78,413.76 L239.25,416.71 L235.86,419.77 L232.60,422.97 L229.48,426.29 L226.50,429.74 L223.65,433.31 L220.94,437.01 L218.37,440.83 L257.76,476.08 L259.43,473.77 L261.16,471.52 L262.96,469.32 L264.81,467.18 L266.73,465.09 L268.71,463.05 L270.75,461.07 L272.85,459.15 L275.01,457.27 L277.23,455.45 L279.51,453.69 L281.86,451.98 L284.30,450.36 L286.86,448.89 L289.55,447.55 L292.37,446.36 L295.31,445.31 L298.38,444.39 L301.58,443.62 L304.90,442.99 L308.34,442.50 L311.91,442.15 L315.61,441.94 L319.44,441.87 L323.74,441.95 L327.85,442.21 L331.75,442.65 L335.45,443.25 L338.95,444.03 L342.24,444.98 L345.34,446.10 L348.23,447.40 L350.93,448.87 L353.42,450.51 L355.71,452.32 L357.79,454.31 L359.70,456.45 L361.44,458.74 L363.01,461.18 L364.42,463.75 L365.66,466.47 L366.73,469.34 L367.64,472.35 L368.39,475.50 L368.97,478.80 L369.38,482.24 L369.63,485.82 L369.71,489.55 L369.71,509.25 L323.58,509.25 L314.52,509.39 L305.80,509.82 L297.44,510.53 L289.43,511.52 L281.78,512.80 L274.47,514.37 L267.52,516.22 L260.93,518.35 L254.68,520.77 L248.79,523.47 L243.25,526.45 L238.06,529.72 L233.26,533.28 L228.88,537.14 L224.91,541.30 L221.36,545.76 L218.23,550.52 L215.52,555.57 L213.22,560.93 L211.34,566.58 L209.88,572.53 L208.84,578.78 L208.21,585.33 L208.00,592.18 L208.15,598.13 L208.62,603.87 L209.39,609.41 L210.48,614.75 L211.87,619.89 L213.57,624.83 L215.58,629.57 L217.91,634.11 L220.54,638.44 L223.48,642.57 L226.73,646.50 L230.29,650.23 L234.14,653.71 L238.25,656.88 L242.63,659.75 L247.28,662.32 L252.19,664.59 L257.37,666.56 L262.82,668.22 L268.53,669.58 L274.51,670.64 L280.75,671.40 L287.26,671.85 L294.04,672.00 L299.07,671.91 L303.96,671.63 L308.72,671.17 L313.33,670.53 L317.81,669.71 L322.16,668.70 L326.37,667.50 L330.44,666.13 L334.37,664.57 L338.17,662.82 L341.83,660.89 L345.35,658.78 L348.71,656.49 L351.88,654.01 L354.85,651.35 L357.62,648.50 L360.20,645.47 L362.59,642.26 L364.78,638.87 L366.78,635.29 L368.58,631.52 L370.19,627.58 L371.60,623.45 L372.82,619.13 L375.93,619.13 L376.52,622.61 L377.24,625.98 L378.09,629.22 L379.07,632.35 L380.19,635.36 L381.44,638.24 L382.83,641.01 L384.34,643.67 L385.99,646.20 L387.78,648.61 L389.69,650.91 L391.74,653.08 L393.92,655.11 L396.23,656.96 L398.66,658.64 L401.22,660.14 L403.90,661.46 L406.71,662.61 L409.64,663.58 L412.71,664.37 L415.89,664.99 L419.21,665.43 L422.65,665.69 L426.21,665.78 L463.01,665.78 L463.01,612.91 Z M475.77,630.42 L546.23,713.58 L762.31,530.50 L546.23,347.42 L475.77,430.58 L593.69,530.50 L475.77,630.42 Z M667.77,630.42 L738.23,713.58 L954.31,530.50 L738.23,347.42 L667.77,430.58 L785.69,530.50 L667.77,630.42 Z"/></svg>`;

const WORDMARK_INK_B64 = "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";
const WORDMARK_PAPER_ON_INK_B64 = "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";
/** 官方 PNG data URI（1840x560，透明底）。08-01 緊急修正：自產 SVG outline 版
 *  字腔（a/u/n 內圈）缺失作廢，改用官方點陣圖，靠 CSS 依主題切換 -ink / -paper-on-ink。 */
const WORDMARK_HTML = `<img class="wm-ink" src="data:image/png;base64,${WORDMARK_INK_B64}" alt="arc>>run" width="986" height="176">` +
  `<img class="wm-paper" src="data:image/png;base64,${WORDMARK_PAPER_ON_INK_B64}" alt="arc>>run" width="986" height="176">`;

/**
 * favicon.ico 真身（16/32/48 三尺寸 ICO，base64 內嵌）。與 landing/worker.js 的
 * FAVICON_ICO_B64 同一份位元組（同一顆 CIS mark），名實相符：`.ico` 回真 ICO、`.svg` 回 SVG。
 */
const FAVICON_ICO_B64 = [
  "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",
].join("");

/**
 * apple-touch-icon（180×180 PNG，base64 內嵌）。iOS 加到主畫面只吃 PNG，不吃 SVG。
 */
const APPLE_ICON_B64 = [
  "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAABmJLR0QA/wD/AP+gvaeTAAATEklEQVR4nO3dd1xTV/8H8JOEERGM",
  "ILKs4kDA+jjroyxBNipFwFV9LHsoD+JAcLXV2mr9dWhdVauCqAy1sgQnyKiKiKgMkSlLTVCCbDUB8vsjz8tS5ISMk4S+Xt/3X0DO",
  "Pd8LfJKce++5JxRtHT0EQH+o8t4BMHhBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgA",
  "FoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BB",
  "OAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQD",
  "YEE4ABaEQxA3N9ct4WEUCkWqVb7d+Y2To6NUS4iHpqqqJu99GKSmT5t26sRxCwtzY2PDtLRbXV1d0qgSGOC3ccN6FxdnCoWSk3NP",
  "GiXEBuHo3+jRn1w8H8tgMBBChhMn2trZpKXdam9vJ1vF2tp6/76fqVQqhUIxMzUZpTfqVkZmT08P2Spio2jr6Ml7HwYdVVXVpMT4",
  "ScZGvX/IZLG8vHyLiotJVTEyNExOildT+9uT8/6DB76+AWw2m1QVScCYoy8ajfbb4YN9koEQ0tXRib90wcHBnkgVbW2t6HNRfZKB",
  "EJo9a1ZyYoKBwQQiVSQEbyt97f5ul7u7W78PKSkpfe68kMPl5OU9kKQEnU6PPnfG0HBiv4+qqw93c1306HFBff1zSapIDsLxN76+",
  "3hs3rBPQgEqlWs610NHRycwUc3BAoVAOHdhvPc9KQBs6ne7u5spmswsKi8QoQcogHXMoKioaGxqOmzBeV0dbc4QmYziD/3Mej9fa",
  "0spuYjNZDc+qnpVXVLx//55UURsb66jIUzQaTZjGWdnZgauDWlvbRK2ybcvm4OAgIRsfPvzb3h9/ktcQdXCFQ09Pz9XVxdbG+rOZ",
  "M5WUlAZsz+V2FRUXZ2Vlp6amljwtlaT0JGOjpMR4VVVV4TcpL6/w8PKuq6sXfpNly5b8uu8XkXYs9cqVkHUb3759K9JWRAyWcEwy",
  "NgoN3eDo4CDkE/djjx4X/PbbsStXr/J4PFG31dLSSklO+OSTT0TdkM1m+/j65z3IF6axqYlJXOw5RUVFUasUFBZ6+/ixWA2ibigh",
  "+YdjyJAhWzeHe3t7ih2L3vIe5IeFby4vrxB+Ezqd/sfF8zNnTBevIofD2RgaHp+QILjZ+PFjLyclqquri1eFyWR6evoUl5SIt7l4",
  "5DwgNTI0vHA+1s7Olkolc1A9Sk/vi+XL6uqfl5YK9S5DoVCOHDowz8pS7Io0Gm3+fEcqlZpzD3t+k8FgXDwfp6cn/vNQTU3N3d2t",
  "rLy8quqZ2J2ISp7hmDvXIi72nI6ODtluFRQUFsx3YjexCwoKB2wcHrbJ0+NLCStSKBRTUxODCePT0m91d3f3eVRRUeHM6chp06ZK",
  "WIV/IN3Z2ZGf/1DCroQkt3DMs7I6czpiyJAh0uicQqHYWM8rKSmtrKoS0GzJ4sU7d3xN6rqasbHR3LkWaWnpnZ2dvX/+0//tXbDA",
  "iUgJKpU6z8pKW1s7MytLBocw8hlzTJk8OT7+4tChQ6VapaW11drGDjeOGzt2TOatdGGOiURSX1/v6eVbWlbG/3axu/uhg/vJlkAI",
  "/fnn7YDANS2trcR77k0OrxzDhqldvBA3cqSmtAvRlZVHjtS8cvVav482N7e0tLbOs7IkNdzhYzAY7u6uT56U1NTUIISqqqpGjRo1",
  "+dNPCZZACOnrj3FydMzIzGhubiHbc29yCIe7u9uypUuEbMxkMp+UlBQWFZWVlbNYDVxuF4PBEP7faWRklJSU/OZNc7+PPn5c8Phx",
  "gYO9nbKyspAdCkNZWdl1kUtzS/PjxwXd3d3Xrl3v6uoyNzMjOy9EQ0PDzdU1/8HDFy9fEuy2N/m8raxftzZsU6iAP1Z1de2pyIir",
  "V68zmcw+D6mqqtrZ2a4O9J86ZYowtY4dP7Hru+8FNDA2Moo6fWr06NHC9CaSyMiob3Z+yx+iOjsvPPjrPjqdTrYEh8PZFLblj0uX",
  "yHbLJ58B6b3c+y+ZL21tbD5+Dejq6vpl3/6g4OD8/If9zp/gcDilpWUxsXEIUUxNTQaspa2tdfJUhIAGjWx2UvLl2bP/raerK9Jv",
  "MaAZM6bPmD71Zlo6h8MpL6/Izv7T3s6W7EiLRqM5OTkoKirevZtDsNv/dS6vo5Xi4ieFRcVOjg69zxi2trZ5+fidv3BxwKE4j8e7",
  "m5MzQmPE9OnTBLdkMBiX4uMFvzd3dnbGxyeMG6tv/NGVegmNGzfO3t72VkZGa2sri9VwOeWKhYU52fEWhUIxmTPbyHDizbR0stPV",
  "5Hmeo7q6+vbtO46ODioqKgihltbW5ctXinQ1/F7u/ZUrlvM3F+B+Xn55ebngNt3d3VeuXqNQKCYmc8gODjQ1NV0XueTl5TGZrLa2",
  "tviExE8nTRo/fhzBEgghQ0NDS0vLtLT0jo4OUn3K+Qwpk8W6ceOGna2tisrQLz288h+KdnqHy+Vqao7896zPBDcrKSnJzb0vTId3",
  "c3Jqamrt7GyInMv/YOjQoYvd3Wpqa8vKyjgcTvLllGFqajNnziBYAiGkq6PzufPCO3fuvG5sJNKh/OdzvHnTnHw5pai4OD39lhib",
  "83i8pUsWC25TUV55KyNDyA6flpbevZNjb2834AuSSBQUFBYumI8Q717u/Z6enozMrMbGxnlWVmQPpIcNG+bu7lbytLS6ulry3uQf",
  "DoRQR0dHWdkAL/s4HM77wAB/wW0qq6quXbsufJ8vXr68cvWq5dy5I0aMEG+v+kWhUMzMTMeN0+efZS8oKHz48LGDvT3ZA2klJaVF",
  "Lp+3tbc9fPhIwq7+8XNIm5reDNhGUUFB1G5ra+tcXN2ysrPF2ilB3N3cLlyI5ccuKzvbxdVNpBkhwqDRaLt27vhhz24F0X/x3v7x",
  "4fj4Qhcpra1tX3p4nzkbTbzn2bNmpSQn8ueQlpdXOLu4CjkjRCSeHqvOnokcNkz8d4Z/fDikqqura8vWbeGbtxK/o0lff0xKcqKt",
  "rQ1CqLGxcemyL6RxIsvK0vJKSsr48WPF2xzCMbBz0TEenj5tbSJPFxVMVVX1dMRJb29PhBCHw1m3PnT3D3uJX2vlTzIymTNHjG0l",
  "ek+SHmVlZX39Mbo6upqamqqqKqof3d/xAdnRPk5mVpab+5Ko0xGjRo0i2C2NRtv93a6x+vq7vtvd3d195MjRFy9e7v/lJ7JDVHV1",
  "9diYsxs3hSckJIq0ofynCX6gra1lbT3PzNRkxvQZY8fqEzzTkJiYFBQcInk/2tpaEadOzhjonKwY0tLSg4JD+JcLZn02M+LUCU1N",
  "wleteTzevv0H9u3/Vfg5tvIPB41Gmz/fyfPLVaamJlJ6GSAVDoQQnU4/dGD/woULiPTWW8nTUk8vnxcvXiCERo/+5ExUpJGhIfEq",
  "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",
  "cpWEz+ba2tqGV68c7LFvYeeiY4LXrnv7lvDZM1FBOPp69epVZeUzZ+cFHx8SJydf9vULILKKS1FR8XDG8I9Xm+zu7t7x7a4ff/x5",
  "MHwuNYSjHxWVlRwud67FX1f5+YtbfPX1DoLrP2VlZ/9r8uQJE/66j7yjo8M/cM2lS/GkSkgIwtG/+/fztLW1p06dgvhrMm0IjYg8",
  "TbYEj8dLS79lY2OjNXIkQojJZK5Ysepebi7ZKpKAASmWoqJCzLmzEycaePv4iXrhRni6OjopKUlMJsvbx+/1a8IXAiUE4RBEXV1d",
  "RUWFv9qO9BgYTKivf07w4hwpEA6A9Q9YaQnIC4QDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4",
  "ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANg",
  "QTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOAAWhANgQTgAFoQDYEE4ABaEA2BBOADW/wPYvdSqRewFmQAAAABJ",
  "RU5ErkJggg==",
].join("");

/** base64 → Uint8Array（Workers 沒有 Buffer） */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function sessionCookie(sid) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Cloudflare API 呼叫封裝
// ---------------------------------------------------------------------------

/**
 * 呼叫 CF API，把 CF 特有的錯誤格式翻成好懂的 Error。
 * 一律回 result；失敗丟 InstallError。
 */
class InstallError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'InstallError';
    this.hint = opts.hint || null;      // 給用戶看的「可以怎麼辦」
    this.detail = opts.detail || null;  // 技術細節（摺疊區）
    this.status = opts.status || null;
    // #45：{ href, label }——這個錯的正解不是「重試」而是「去某一頁做一件事」時，
    // 讓錯誤卡片畫得出一顆按得到的按鈕（見 fail() 與 renderError）。
    this.action = opts.action || null;
  }
}

async function cfFetch(token, path, init = {}) {
  let res;
  try {
    res = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    throw new InstallError('無法連線到 Cloudflare 服務', {
      hint: '這通常是暫時性的網路問題，請稍後按「重新安裝」再試一次。',
      detail: `fetch failed: ${e && e.message}`,
    });
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（例如 CF 擋下來的 HTML 錯誤頁）
    throw new InstallError('Cloudflare 回傳了無法解讀的內容', {
      hint: '請稍後再試一次。若持續發生，請把下方技術細節回報給我們。',
      detail: `HTTP ${res.status} / non-JSON body: ${text.slice(0, 500)}`,
      status: res.status,
    });
  }

  if (!res.ok || (body && body.success === false)) {
    const errs = (body && body.errors) || [];
    const first = errs[0] || {};
    const msg = first.message || `HTTP ${res.status}`;
    throw new InstallError(translateCfError(res.status, first.code, msg), {
      hint: cfErrorHint(res.status, first.code),
      detail: `HTTP ${res.status} ${path}\n${JSON.stringify(body && body.errors ? body.errors : body).slice(0, 800)}`,
      status: res.status,
    });
  }

  return body ? body.result : null;
}

function translateCfError(status, code, msg) {
  if (status === 401) return '你的授權已經過期或被撤銷';
  if (status === 403) return '目前的授權沒有足夠的權限完成這一步';
  if (status === 429) return 'Cloudflare 暫時限制了請求頻率';
  if (code === 10014 || /already exists/i.test(msg)) return '這個名稱已經被使用過了';
  return `Cloudflare 回報：${msg}`;
}

function cfErrorHint(status, code) {
  if (status === 401) return '請回到首頁重新連結你的 Cloudflare 帳號。';
  if (status === 403) return '請回到首頁重新授權，並在 Cloudflare 頁面上確認所有權限都有勾選。';
  if (status === 429) return '請稍等一下再按「重新安裝」。';
  if (code === 10014) return '請按「重新安裝」，系統會換一組新的名稱重試。';
  return '請按「重新安裝」再試一次；若持續失敗，請把技術細節回報給我們。';
}

// ---------------------------------------------------------------------------
// Token 管理（含 refresh rotation）
// ---------------------------------------------------------------------------

async function exchangeCode(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  return tokenRequest(body);
}

async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  return tokenRequest(body);
}

async function tokenRequest(body) {
  // 實測：Worker 內部 server-to-server 呼叫 token 端點不會被 CF error 1010 擋。
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstallError('Cloudflare 授權服務回傳了無法解讀的內容', {
      hint: '請回到首頁重新連結一次。',
      detail: `HTTP ${res.status}: ${text.slice(0, 500)}`,
    });
  }
  if (!res.ok || data.error) {
    throw new InstallError('連結 Cloudflare 帳號失敗', {
      hint: '請回到首頁重新點一次「連結我的 Cloudflare 帳號」。授權連結只能用一次，重新整理舊頁面是沒有用的。',
      detail: `HTTP ${res.status}: ${data.error || ''} ${data.error_description || ''}`,
    });
  }
  return data;
}

/**
 * 取得可用的 access token。過期就用 refresh token 換新的，
 * 並且務必把「新的 refresh token」存回 —— CF 是 rotation 制，舊的用過即失效。
 */
async function getAccessToken(env, sid) {
  const raw = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  if (!raw || !raw.access_token) {
    throw new InstallError('找不到你的授權資訊', {
      hint: '可能是閒置太久了。請回到首頁重新連結你的 Cloudflare 帳號。',
      detail: 'session missing or has no access_token',
    });
  }

  const now = Date.now();
  // 留 5 分鐘安全邊際
  if (raw.expires_at && now < raw.expires_at - 300_000) {
    return raw.access_token;
  }

  if (!raw.refresh_token) {
    throw new InstallError('你的授權已經過期', {
      hint: '請回到首頁重新連結你的 Cloudflare 帳號。',
      detail: 'access token expired and no refresh_token available',
    });
  }

  const fresh = await refreshTokens(raw.refresh_token);
  const updated = {
    ...raw,
    access_token: fresh.access_token,
    // rotation：一定要存回新的 refresh_token；若對方沒給就沿用舊的
    refresh_token: fresh.refresh_token || raw.refresh_token,
    expires_at: Date.now() + (Number(fresh.expires_in) || 57600) * 1000,
    refreshed_at: Date.now(),
  };
  await env.INSTALLER_KV.put(`sess:${sid}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL,
  });
  return updated.access_token;
}

// ---------------------------------------------------------------------------
// 進度管理
// ---------------------------------------------------------------------------

function freshProgress() {
  return {
    state: 'pending',              // pending | running | paused_continue | done | error
    startedAt: null,
    finishedAt: null,
    currentStep: null,
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, state: 'pending', note: null })),
    result: {},                    // 安裝出來的資源資訊
    error: null,                   // { step, stepLabel, message, hint, detail }
  };
}

async function readProgress(env, sid) {
  return (await env.INSTALLER_KV.get(`prog:${sid}`, 'json')) || null;
}

async function writeProgress(env, sid, progress) {
  progress.updatedAt = Date.now(); // P0-3：每次寫入蓋時間戳，狀態端據此判斷是否卡死
  await env.INSTALLER_KV.put(`prog:${sid}`, JSON.stringify(progress), {
    expirationTtl: PROGRESS_TTL,
  });
}

// ---------------------------------------------------------------------------
// 安裝流程
// ---------------------------------------------------------------------------

/** 要部署給用戶的示範 worker 原始碼（自檢 API） */
function instanceWorkerSource(meta) {
  return `// Arcrun RAG instance — 由一鍵安裝器產生於 ${new Date().toISOString()}
const INSTANCE = ${JSON.stringify(meta, null, 2)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      const checks = { cache: null, database: null };

      // 檢查快取空間是否綁上
      try {
        const stamp = String(Date.now());
        await env.RAG_CACHE.put('__healthcheck', stamp, { expirationTtl: 60 });
        const back = await env.RAG_CACHE.get('__healthcheck');
        checks.cache = back === stamp ? { ok: true } : { ok: false, error: 'readback mismatch' };
      } catch (e) {
        checks.cache = { ok: false, error: String(e && e.message || e) };
      }

      // 檢查資料庫是否綁上、schema 是否在
      try {
        const r = await env.RAG_DB.prepare(
          "SELECT COUNT(*) AS n FROM entries"
        ).first();
        checks.database = { ok: true, entries: r ? r.n : null };
      } catch (e) {
        checks.database = { ok: false, error: String(e && e.message || e) };
      }

      const ok = checks.cache && checks.cache.ok && checks.database && checks.database.ok;
      return Response.json(
        { service: 'arcrun-rag', instance: INSTANCE, ok, checks, time: new Date().toISOString() },
        { status: ok ? 200 : 503 }
      );
    }

    if (url.pathname === '/entries') {
      try {
        const { results } = await env.RAG_DB.prepare(
          'SELECT id, title, body, created_at FROM entries ORDER BY id DESC LIMIT 50'
        ).all();
        return Response.json({ ok: true, entries: results });
      } catch (e) {
        return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 });
      }
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
`;
}

// migration 必須冪等（P0-2 斷點續傳）：DDL 全 IF NOT EXISTS，seed 靠記帳表 guard。
// wrangler CLI 用 d1_migrations 表追蹤狀態；Worker 內無 CLI，故自建 _installer_migrations。
// 種子只在「該 migration 尚未記帳」時插入，重跑不會重複塞（實測 CLI 缺此表時 INSERT 會 1→2 筆）。
// 真 kbdb schema（工地主任 installer/src/migrations.json，冪等 DDL；
// 舊示範版的 entries(title,body) 與真 kbdb entries 撞名，已整段汰換——t20④c）
const MIGRATION_SQL = MIGRATIONS.statements.join(';\n') + ';';

/** 用戶身分 → 可重現的資源短碼（P0-2）：同一 email 每次安裝得到同一組名稱，
 *  斷點續傳才認得出上次建的那組、不會再建一整套。 */
async function slugFromEmail(email) {
  const norm = String(email || '').trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode('arcrun-rag:' + norm));
  const bytes = new Uint8Array(digest);
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 資源解析：判斷全部委外給上游共用規則，本檔只做「輸入整形」與「產品層取捨」
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 這裡以前有三支 `ensureKvNamespace` / `ensureD1Database` / `ensureVectorizeIndex`
//    （照名字找既有、找不到就建）。**整段刪掉，不留註解版**——
//    死代碼＝錯誤環境信號，留著下一個人就會照它走。要看它們長什麼樣去翻 git 歷史。
//
//    為什麼刪：名字是安裝器自己算的（`arcrun-rag-<email 短碼>-kv-<binding>`），
//    使用者那顆資源實際叫什麼名字**不歸我們管**——他改過名、或當初是別的版本／別條
//    通道裝的，名字就對不上 ⇒ 舊寫法會安靜地建一顆空的頂上去 ⇒ `Leo/Arcrun#97`
//    「我按了更新，工作流和登入全不見了」。
//
//    現在的判準是「**這顆 worker 現在綁著誰**」，由 `shared/resource-rule/` 決定。

/**
 * Vectorize index 名（bge-m3＝1024 維／cosine）。**只在真的要新建時**才會被拿來當名字用——
 * 已經綁著別的 index 的實例，共用規則會照原樣沿用，不會被這個名字覆蓋。
 *
 * 🔴 2026-08-03 換代（leo 拍板；08-05：「換 embed model 當然要合併，當然要換 vectorize，
 *   原本的根本不能用」）：bge-base-en-v1.5(768) → bge-m3(1024)。
 *   5 組中文測資：舊 2/5、margin -0.0413（中文分數全擠 0.65-0.81＝沒區辨力）；新 5/5、+0.1410。
 *   換名字而非只改維度：舊 index 收不進 1024 維；不同模型向量混同一 index＝垃圾；
 *   且 #58（Vectorize delete 未接）舊向量刪不掉 ⇒ 開新名字順手繞開、可回滾。
 *   ⚠️ 必須與 Arcrun:kbdb/src/embed.ts、Arcrun:cli/src/lib/deploy.ts、
 *      installer/scripts/deploy-all.mjs 四處同步（漏一處＝不報錯但分數全垃圾）。
 *   ⚠️ 維度／metric 的真相源現在是共用層的 `cf-resource-api.mjs#createVectorizeIndex`
 *      （1024／cosine，同一份），本檔不再自己送建立請求。
 * kbdb runtime 契約：VECTORIZE + AI binding 存在即啟用語意，無需 env var。
 */
const VECTORIZE_INDEX = 'arcrun-kbdb-embed-m3';

/**
 * bundle manifest → 共用規則要的 `BindingRequirement[]`。
 *
 * 這支**只做輸入整形**：誰（哪顆 worker）需要哪個 binding、以及「萬一真的要新建」時
 * 該取什麼名字。要不要建、該用哪一顆，一律由 `planResources` 判斷。
 *
 * ⚠️ 為什麼不直接用上游的 `installer-entry.mjs#resolveInstanceResources()`：
 *    它的輸入是各 worker 的 `wrangler.toml` **文字**，而安裝器手上只有
 *    `arcrun-rag-bundles` 的 manifest（`requires`＝Arcrun 建置期就從那些 toml 抽好的），
 *    bundle 裡沒有 toml。而且 toml 表達不出「KV 該叫什麼名字」（只有 `binding`），
 *    照 toml 走會讓新裝的人在自己帳號看到 9 個叫 `WEBHOOKS`／`RECIPES` 的裸名 namespace。
 *    ⇒ 這裡改呼叫共用層的 `planResources`／`applyResourcePlan`（同一份規則、同一雙眼睛），
 *      動作與 `installer-entry.mjs` 逐步對應。上游若加一個「直接吃 requirements」的入口，
 *      這幾行就能再收掉——已在 PR 內文標給總管。
 *
 * @param {{core?: Array<{name?: string, requires?: {kv?: string[], d1?: Array<{binding: string}>}}>}} manifest
 * @param {string} baseName  `arcrun-rag-<email 短碼>`
 * @param {boolean} withVectorize  是否把 VECTORIZE 也納入（語意搜尋，見 runInstall 的取捨）
 */
function manifestRequirements(manifest, baseName, withVectorize) {
  const reqs = [];
  for (const entry of manifest.core || []) {
    const worker = entry && entry.name;
    if (!worker) continue;
    for (const binding of (entry.requires && entry.requires.kv) || []) {
      reqs.push({
        kind: 'kv_namespace',
        binding,
        worker,
        createName: `${baseName}-kv-${binding.toLowerCase()}`,
      });
    }
    for (const d of (entry.requires && entry.requires.d1) || []) {
      // 所有 d1 binding 都宣告同一個 createName ⇒ 共用層的 shareSameResource 會收斂成
      // 「建一顆、大家共用」，維持本安裝器一直以來「整台實例一顆 D1」的形狀。
      reqs.push({ kind: 'd1', binding: d.binding, worker, createName: `${baseName}-db` });
    }
    // kbdb 語意搜尋：VECTORIZE 不在 manifest.requires 裡（那個 toml 區塊預設是註解狀態），
    // 「哪顆 worker 要吃它」一直是安裝器這邊的決定（見 deployBundledWorker）。
    if (withVectorize && worker.includes('kbdb')) {
      reqs.push({ kind: 'vectorize', binding: 'VECTORIZE', worker, createName: VECTORIZE_INDEX });
    }
  }
  return reqs;
}

/**
 * 跑一次共用規則：**不確定就整趟停手，一顆資源都不建**（結構保證在 plan／apply 兩段之間）。
 *
 * 回傳形狀與上游 `installer-entry.mjs#resolveInstanceResources()` 相同：
 *   `{ blocked, blockers[], bindings: {'kv_namespace:WEBHOOKS': 'kvid-…'}, origin, liveVars }`
 *
 * @param {string} token   使用者授權的 CF token（Bearer）
 * @param {string} accountId
 * @param {Array} requirements  manifestRequirements() 的輸出
 * @param {'update'|'init'} mode  這台照我們的紀錄裝過了沒
 */
async function resolveResourcesByRule(token, accountId, requirements, mode) {
  const stop = (blockers) => ({ blocked: true, blockers, bindings: {}, origin: {}, liveVars: {} });
  if (!requirements.length) return stop(['這包 bundle 讀不到任何資源綁定需求——不確定要裝什麼，停手。']);

  const api = createCloudflareResourceApi({ accountId, apiToken: token });
  let plan;
  try {
    plan = await planResources(api, requirements, mode);
  } catch (e) {
    return stop([`資源解析失敗（${e instanceof Error ? e.message : String(e)}）。沒有建立任何資源。`]);
  }
  if (plan.blockers.length > 0) return stop(plan.blockers);

  let resolved;
  try {
    resolved = await applyResourcePlan(api, plan);
  } catch (e) {
    return stop(e instanceof ResourcePlanBlocked ? e.blockers : [e instanceof Error ? e.message : String(e)]);
  }

  const bindings = {};
  const origin = {};
  for (const [key, r] of resolved) {
    bindings[key] = r.value;
    origin[key] = r.origin;
  }
  return { blocked: false, blockers: [], bindings, origin, liveVars: Object.fromEntries(plan.liveVars) };
}

/**
 * Vectorize 的 metadata index（best-effort）。
 *
 * ⚠️ 這支**不建 index 本身**（那是共用規則的事），只在既有 index 上補 metadata 欄位；
 * 失敗不阻塞——語意搜尋不過濾 metadata 仍然可用。
 */
async function ensureVectorizeMetadataIndexes(token, accountId, indexName) {
  const metaProps = ['owner_id', 'entry_type', 'source', 'library'];
  for (const prop of metaProps) {
    try {
      await cfFetch(token, `/accounts/${accountId}/vectorize/v2/indexes/${indexName}/metadata-index/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyName: prop, indexType: 'string' }),
      });
    } catch { /* metadata index 失敗不阻塞 */ }
  }
}

/** 向 landing 中央服務驗證辨識碼（P0-1）。fail-closed：驗不過或連不上都回 ok:false。 */
async function verifyInviteCode(env, email, code) {
  if (!email || !code) return { ok: false, reason: 'invalid' };
  let res;
  try {
    res = await fetch(`${landingBase(env)}/api/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: String((e && e.message) || e) };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 一律視為驗證失敗 */
  }
  if (res.ok && data && data.ok === true) return { ok: true };
  return { ok: false, reason: res.status === 429 ? 'rate' : 'invalid' };
}

/** 從 jsDelivr URL 推算對應的 GitHub raw 備援 URL。
 *  cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/<path>
 *  → raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>
 */
function jsdelivrToGithubRaw(primaryUrl) {
  try {
    const m = primaryUrl.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^@/]+\/[^@/]+)@([^/]+)(.*)/);
    if (!m) return null;
    return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + m[3];
  } catch (_) { return null; }
}

/**
 * 抓 bundle 靜態資源（帶重試＋備援）：
 * - 最多重試 3 次，指數退避（300ms / 900ms / 2700ms）
 * - 5xx 與網路錯誤重試；404 直接報錯（不重試、不備援）
 * - 重試用盡後嘗試 raw.githubusercontent.com 備援；備援也失敗才丟 InstallError
 * 回 { response, usedFallback }。
 */
async function fetchBundleAsset(primaryUrl, what) {
  let lastErr = null;
  const retryDelays = [300, 900, 2700];
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(function(r) { setTimeout(r, retryDelays[attempt - 1]); });
    try {
      const res = await fetch(primaryUrl);
      if (res.ok) return { response: res, usedFallback: false };
      if (res.status === 404) {
        throw new InstallError('找不到 ' + what + '（HTTP 404）', {
          hint: '這可能是版本設定問題，請把技術細節回報給我們。',
          detail: 'GET ' + primaryUrl + ' → HTTP 404',
          status: 404,
        });
      }
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      if (e instanceof InstallError) throw e;
      lastErr = e;
    }
  }
  // 主來源重試用盡，嘗試 GitHub raw 備援
  const fallbackUrl = jsdelivrToGithubRaw(primaryUrl);
  if (fallbackUrl) {
    try {
      const res = await fetch(fallbackUrl);
      if (res.ok) return { response: res, usedFallback: true };
    } catch (_) { /* 備援也失敗，下面報錯 */ }
  }
  throw new InstallError('下載元件時網路不穩（已重試 3 次）', {
    hint: '請按「重新安裝」再試一次；若持續發生，請把技術細節回報給我們。',
    detail: 'GET ' + primaryUrl + ' → ' + (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  });
}

/**
 * t151：哪些 worker 要「還原 service binding」，以及每個 binding 指向同帳號內的哪顆 worker。
 *
 * 為什麼要有這張表：打包時 service binding 被 strip 掉，manifest 只用 `stripped_services`
 * 記下 **binding 名**、**不記目標 worker**（`COMPONENT_REGISTRY → arcrun-registry` 不是機械規則，
 * 推不出來）⇒ 目標只能在這裡明列。
 *
 * 🔴 為什麼是白名單而不是「凡 stripped_services 都還原」：
 * `arcrun-cypher-executor` 的 13 個 `SVC_*` 是**故意**剝掉的（D28：零件走 cypher binding／URL 懶載，
 * 不用 service binding）。無條件還原＝把 D28 反過來做，還會讓 cypher 綁 13 顆不必要的服務。
 * ⇒ 只還原這張表裡有的，其餘一律不動。
 */
/*
 * 🔴 2026-08-10：欄位改成 `{ service, optional? }`——因為 `arcrun-mcp` 進 bundle 清單的那一刻，
 *   這張表原本隱含的「三個目標都必須在 manifest 裡」就會**擋住整個安裝**。
 *
 *   `COMPONENT_REGISTRY → arcrun-registry` 是**唯一一個目標不在 bundle 清單裡**的依賴
 *   （bundle-components.mjs 是那張清單的唯一真相源）。它服務的是三支「查零件目錄」的工具
 *   （arcrun_get_component／arcrun_get_component_guide／arcrun_search_components），
 *   而那三支在 mcp 原始碼裡**本來就寫了 binding 缺席時的誠實回覆**
 *   （`"Error: COMPONENT_REGISTRY service binding is not configured."`）。
 *
 *   為什麼不乾脆把 arcrun-registry 也打進 bundle：它自帶兩個 KV＋一個 AI binding，
 *   而新用戶那顆會是**空的**（零件目錄的內容不在 bundle 裡）⇒ 多裝一顆 worker、多建兩個 KV，
 *   換到的是同樣查不到東西，只是換一種說法。⇒ 誠實缺席勝過假裝有。
 *
 *   ⚠️ optional **只准用在「目標不在 bundle 清單裡」的依賴**。KBDB／CYPHER_EXECUTOR
 *   是 MCP 能不能用的命脈（前者缺＝工具全爆，後者缺＝同意頁驗不了 Portal 帳密），
 *   兩者都在清單裡，因此維持 fail-closed：缺一即當場失敗，不裝出半通的 worker。
 */
const SERVICE_BINDINGS = {
  'arcrun-mcp': {
    COMPONENT_REGISTRY: { service: 'arcrun-registry', optional: true },
    CYPHER_EXECUTOR: { service: 'arcrun-cypher-executor' },
    KBDB: { service: 'arcrun-kbdb' },
  },
};

/**
 * 這顆 worker 在**這包 manifest** 底下真正綁得起來的 service binding：{binding: 目標worker}。
 * 必要目標缺席＝丟 InstallError（fail-closed）；optional 目標缺席＝安靜不綁。
 *
 * `names`＝manifest.core 的名字集合。判準永遠是「**這包 bundle 有什麼**」，
 * 不是「這個帳號現在有什麼」——後者會讓 stage（youlin 帳號裡還留著上個世代的
 * `arcrun-registry`）驗到一條新用戶根本走不到的路，也就是又一次「測試場與出貨物不同」。
 */
function resolveServiceBindings(entryName, names) {
  const spec = SERVICE_BINDINGS[entryName];
  if (!spec) return null;
  const out = {};
  for (const [binding, def] of Object.entries(spec)) {
    if (names.has(def.service)) { out[binding] = def.service; continue; }
    if (def.optional) continue;
    throw new InstallError(`安裝包缺少 ${entryName} 需要的服務 ${def.service}`, {
      detail: `manifest.core 沒有 ${def.service}（SERVICE_BINDINGS[${entryName}].${binding} 的目標）`,
    });
  }
  return out;
}

/** 抓懶載 manifest（CI build-bundles.mjs 產出的 bundles/manifest.json）。 */
async function fetchBundleManifest(env) {
  const { response } = await fetchBundleAsset(bundleBase(env) + '/manifest.json', '安裝包清單');
  const manifest = await response.json();
  return reorderForServiceBindings(manifest);
}

/**
 * t151：把「有 service binding 的 worker」排到它依賴的目標之後。
 *
 * 為什麼需要：service binding 只綁得上**已經存在**的 script。實測 manifest 順序是
 * `arcrun-mcp`(24) 早於 `arcrun-registry`(26) ⇒ 照原順序裝，mcp 部署時 registry 還不存在。
 * 這裡只做「把依賴者往後移」的穩定重排，不改 manifest 內容、不動 tier 語意。
 *
 * 安全性：接力游標（`deployedNames`）與差異更新指紋都以**名稱**比對（指紋還先 sort），
 * 與陣列順序無關 ⇒ 重排不會讓已裝的重裝、也不會讓指紋漂移。
 */
function reorderForServiceBindings(manifest) {
  if (!manifest || !Array.isArray(manifest.core)) return manifest;
  const dependents = [];
  const rest = [];
  for (const entry of manifest.core) {
    (SERVICE_BINDINGS[entry.name] ? dependents : rest).push(entry);
  }
  if (!dependents.length) return manifest;
  // 必要目標若根本不在這包 manifest 裡＝打包漏了，寧可當場失敗也不要裝出一顆呼叫即 500 的 worker。
  // 2026-08-10：解析結果**當場釘在 entry 上**（`service_bindings`），deployBundledWorker 直接用它。
  // 為什麼不讓 deploy 那邊再查一次表：它拿不到 manifest ⇒ 只能重查「帳號裡有沒有」，
  // 那就是兩套判準（這包有什麼 vs 這個帳號有什麼），必然漂移。一次解析、一個答案。
  const names = new Set(manifest.core.map((c) => c.name));
  for (const entry of dependents) {
    entry.service_bindings = resolveServiceBindings(entry.name, names);
  }
  manifest.core = [...rest, ...dependents];
  return manifest;
}

/**
 * P0-4：把一顆「預先打包好的核心 worker」抓下來、純 CF API 上傳到用戶帳號。
 *
 * entry＝manifest.core[] 的一筆（含 main_file / modules[]（wasm）/ compat / requires binding 需求）。
 * resources＝安裝器已建的資源：{ kv: {BINDING: id}, d1Id }。
 * inject＝安裝時才知道的值：{ accountId, subdomain }（覆蓋官方預設 var）。
 *
 * bundle 不綁 cypher 的 13 個 service（打包時已 strip，requires.kv 也不含它們）＝懶載。
 * ⚠️ 帶 wasm 的多模組上傳（part 名 ↔ import specifier 解析）須首次真部署驗。
 */
/**
 * D36 第1步（leo 07-29 拍板「安裝器代寫」）：把 credential 種進用戶實例。
 *
 * 為什麼由安裝器代寫，而不是讓 cypher 自己寫：
 *   cypher 的 POST /credentials 走 CF Workers Secrets API，需要 CF_SECRETS_API_TOKEN
 *   + CF_ACCOUNT_ID。但安裝器手上的 OAuth **access token 16 小時就過期**、refresh token
 *   還會 rotation ⇒ 兩者都不能存進用戶 worker 當長期憑證（存了會靜默壞掉）。
 *   ⇒ 改由安裝器在安裝當下、用自己還有效的 token 直接寫；**cypher 身上不留任何 CF token**。
 *   accountId 是既有流程 GET /accounts 就拿到的，不需要新機制。
 *
 * 寫兩個地方（與 cypher credentials.ts 同語意，命名規則必須一致否則 WASM 找不到）：
 *   ① CF Workers per-script secret：名稱 CRED_<NAME大寫>_<sha256(api_key)前8碼大寫>
 *   ② D1 credentials 表的目錄列（只存 ref 不存值）
 */
async function sha256Prefix8(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

/**
 * D36 第2步：獨立寫入 per-script secret（不走 code 上傳路徑）。
 * CF API 是「唯寫」的：能 create/update/delete/list 名字，讀不回值（D19 不擁有內容物）。
 */
async function putWorkerSecretDirect(token, accountId, scriptName, name, value) {
  await cfFetch(token, `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text: value, type: 'secret_text' }),
  });
}

async function seedCredential(token, accountId, dbId, apiKey, name, value, service, sensitivity) {
  const ref = `CRED_${name.toUpperCase()}_${(await sha256Prefix8(apiKey)).toUpperCase()}`;
  // ① 明文進 CF Workers secret（掛在 cypher script 上，唯寫 API）
  await cfFetch(token, `/accounts/${accountId}/workers/scripts/arcrun-cypher-executor/secrets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: ref, text: value, type: 'secret_text' }),
  });
  // ② D1 目錄列（不存值，只存 ref；ON CONFLICT 冪等）
  const now = Math.floor(Date.now() / 1000);
  await cfFetch(token, `/accounts/${accountId}/d1/database/${dbId}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: 'INSERT INTO credentials (api_key, name, service, sensitivity, secret_ref, created_at, last_used_at)'
         + ' VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(api_key, name) DO UPDATE SET'
         + ' service = excluded.service, sensitivity = excluded.sensitivity, secret_ref = excluded.secret_ref',
      params: [apiKey, name, service, sensitivity, ref, now],
    }),
  });
  return ref;
}

/**
 * 探測「這個實例是不是舊的、該不該重推」——**判斷落在這一個函式裡，別再散回呼叫點**。
 *
 * ── 唯一判準＝比版本號，不猜特徵 ───────────────────────────────────────
 * t146（07-29）：deployState（KV 裡「我以為裝了什麼」）**會說謊**——部署 404 失敗前
 *   已經寫過紀錄 ⇒ 之後每次都被判「sha 沒變」跳過，triplet seed 永遠種不進去。
 *   ⇒ 唯一可信的是**直接問實例自己**。
 * t168（08-01 leo 實撞：portal 換 CIS 後重裝，畫面完全沒變）：
 *   **cypher 的 /health 看不到 ui 那顆的死活** ⇒ 兩顆都要問。
 * t170（08-02）：t168 當時的補救是猜「/favicon.svg 開頭是不是 `<svg`」，
 *   但那**只能分辨「有沒有 favicon 路由」這一個世代差**——舊 UI 早就有 favicon 路由
 *   ⇒ 判定「UI 是新的」⇒ 整批跳過 ⇒ **UI 永遠不重推**（cypher 到 1.4.1、portal 連版本卡都沒有）。
 *   ⇒ 根治＝**讓 UI 自己報版本**（build-ui-bundle.mjs 的 `/__version`），安裝器直接比對。
 *   猜特徵每出一個新世代就要再猜一次，猜錯就是那次事故。
 *
 * ⚠️ 只比 `bundle_version`，**不比指紋**：manifest 那顆 ui 的 `sha256` 是「整個 worker.js 檔案」
 *    的 sha，而 `/__version` 回的 `ui_fingerprint` 是「內嵌網頁檔集合」的 sha
 *    ——**兩者定義不同，永遠不會相等**（08-02 實測 a806bd13… vs b14340fc…）。
 *    指紋只留作除錯顯示。
 *
 * ── 🔒 fail-stale：問不出可信版本一律當「舊的」──────────────────────────
 * 打不通／非 JSON／欄位空／舊世代沒這條路由 ⇒ 一律 stale＝重推。
 * **絕不可因為「讀不到」就假設是新的**——那正是 t168/t170 事故的形狀
 * （探測回不出東西 → 判定已是最新 → 永遠不更新，用戶重裝幾次都拿到舊前端）。
 * 特別是 `bundle_version` 為空字串這一格：舊寫法用 `uj.bundle_version && …` 判斷，
 * 空字串是 falsy ⇒ **靜默跳過比對＝當成最新**。08-02 就因為版本只注入給 cypher、
 * 沒注入給 ui，這條判準整段沒在運作，當時沒爆純粹是靠「舊 UI 沒有這條路由」在擋
 * ——那是一次性的。所以這裡把空值明確列成 stale。
 *
 * @returns {{stale:boolean, instanceVersion:string, wantVersion:string, uiFingerprint:string, reason:string}}
 */
export async function probeInstanceStale({ healthUrl, uiVersionUrl, wantVer, timeoutMs = 10000 }) {
  const out = {
    stale: true,
    instanceVersion: '(讀不到)',
    wantVersion: wantVer,
    uiFingerprint: '(無)',
    reason: '',
  };

  // ① cypher：實例的後端版本
  try {
    const hr = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const hj = hr.ok ? await hr.json().catch(() => null) : null;
    const gotVer = (hj && hj.bundle_version) || '';
    out.instanceVersion = gotVer || '(讀不到)';
    if (!gotVer) {
      out.reason = 'cypher 讀不到 bundle_version（舊實例沒這欄位）＝重推';
      return out;
    }
    if (gotVer !== wantVer) {
      out.reason = `cypher bundle_version=${gotVer} ≠ ${wantVer}＝重推`;
      return out;
    }
    // arcrun-rag#38/#69/#25（2026-08-11）：**版本號相同不代表 config 也是最新的**——
    // PORTAL_MAIL_RELAY_BASE 是這次才第一次被安裝器寫入的 var，跟 bundle_version
    // 完全無關（同一個 cypher 版本，先裝的實例沒有這個 var，之後裝的才有）。
    // 只比版本號的話，leo 自己那台（已經是最新版）永遠不會因為「按更新」而重推
    // ⇒ 這個 var 永遠補不進去、忘記密碼永遠是斷的。這裡額外問一句「這個 var 到底有沒有」，
    // 沒有就跟版本不符一樣處理＝重推（fail-stale：讀不到／沒設一律當舊的，不假設已經最新）。
    if (!(hj && hj.mail_relay_configured)) {
      out.reason = 'cypher 沒有設定 PORTAL_MAIL_RELAY_BASE（忘記密碼寄不出信）＝重推';
      return out;
    }
  } catch (e) {
    out.reason = 'cypher 探測失敗＝重推（實例可能根本還沒建）';
    return out;
  }

  // ② ui：cypher 對得上不代表前端也對得上（t168）
  try {
    const ur = await fetch(uiVersionUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const uj = ur.ok ? await ur.json().catch(() => null) : null;
    const gotFp = (uj && uj.ui_fingerprint) || '';
    out.uiFingerprint = gotFp || '(無)';
    if (!gotFp) {
      // 舊世代沒有 /__version ⇒ SPA fallback 回首頁 HTML ⇒ JSON 解析失敗。
      // 天然向後相容：不需要額外的世代判斷。
      out.reason = 'ui 無 /__version（舊世代不會自報版本）＝重推';
      return out;
    }
    const uiVer = (uj && uj.bundle_version) || '';
    if (!uiVer) {
      out.reason = 'ui 有 /__version 但沒報版本（空字串）＝重推';
      return out;
    }
    if (uiVer !== wantVer) {
      out.reason = `ui bundle_version=${uiVer} ≠ ${wantVer}＝重推`;
      return out;
    }
  } catch (e) {
    out.reason = 'ui 探測失敗＝重推（寧可多推，不可漏推）';
    return out;
  }

  out.stale = false;
  out.reason = `cypher 與 ui 都是 ${wantVer}＝已是最新，整批可跳過`;
  return out;
}

async function deployBundledWorker(env, token, accountId, entry, resources, inject) {
  const base = bundleBase(env);
  // 1. 抓主模組 + wasm 模組（fetchBundleAsset：3 次重試 + GitHub raw 備援）
  let usedFallback = false;
  const { response: mainRes, usedFallback: mf } = await fetchBundleAsset(base + '/' + entry.main_file, entry.name + ' 主模組');
  if (mf) usedFallback = true;
  const mainSrc = await mainRes.text();
  const wasmBlobs = [];
  for (const m of entry.modules || []) {
    const { response: wres, usedFallback: wf } = await fetchBundleAsset(base + '/' + m.file, entry.name + ' 模組 ' + m.name);
    if (wf) usedFallback = true;
    wasmBlobs.push({ name: m.name, type: m.type || 'application/wasm', buf: await wres.arrayBuffer() });
  }

  // 2. binding：把「需求名」對上「共用規則解出來的那顆資源」，缺一即 fail-closed（不假綠）
  //
  // 🔴 真相源是 `resources.bindings`（`shared/resource-rule/` 解出來的 `kind:binding → id`）。
  //    `resources.kv` / `resources.d1Id` 是它攤平出來的舊欄位，留給只推單顆的路徑與離線測試；
  //    兩者衝突時**以 bindings 為準**——那是「這顆 worker 現在綁著誰」的答案。
  const resolvedFor = (kind, binding) =>
    (resources.bindings && resources.bindings[bindingKey(kind, binding)]) || null;
  const bindings = [];
  for (const name of entry.requires?.kv || []) {
    const id = resolvedFor('kv_namespace', name) || resources.kv?.[name];
    if (!id) throw new InstallError(`缺少快取空間 ${name}`, { detail: `no resolved kv for ${name}` });
    bindings.push({ type: 'kv_namespace', name, namespace_id: id });
  }
  for (const d of entry.requires?.d1 || []) {
    const id = resolvedFor('d1', d.binding) || resources.d1Id;
    if (!id) throw new InstallError(`缺少資料庫給 ${d.binding}`, { detail: `no resolved d1 for ${d.binding}` });
    bindings.push({ type: 'd1', name: d.binding, id });
  }
  if (entry.requires?.ai) bindings.push({ type: 'ai', name: 'AI' });
  // t151：還原被 strip 掉的 service binding（見 SERVICE_BINDINGS 那張表的說明）。
  // 病灶＝安裝器一個都沒注入 ⇒ env.KBDB／CYPHER_EXECUTOR／COMPONENT_REGISTRY 全 undefined
  // ⇒ 用戶的 AI 一呼叫工具就爆（實測 MCP client 回「KBDB service binding unavailable」）。
  // `service_bindings` 由 reorderForServiceBindings 依**這包 manifest** 解析後釘在 entry 上。
  // 沒被釘過（單顆重推等路徑）就退回照表解析，但此時無從得知 manifest ⇒ 只認必要目標。
  const svc = entry.service_bindings
    ?? (SERVICE_BINDINGS[entry.name]
      ? Object.fromEntries(Object.entries(SERVICE_BINDINGS[entry.name])
        .filter(([, d]) => !d.optional).map(([b, d]) => [b, d.service]))
      : null);
  if (svc) {
    // 漂移閘：manifest 說被剝掉的 binding，這張表沒給目標＝新版 bundle 多了一個依賴而沒人補表。
    // 照本檔既有 fail-closed 慣例（缺一即失敗、不假綠）當場擋下，而不是裝出半通的 worker。
    // ⚠️ 只認「表裡完全沒有這個 binding」＝真漂移；表裡有但因目標不在 bundle 而 optional 略過的
    //    不算漂移（那是已知取捨，見 SERVICE_BINDINGS 說明）。
    const known = SERVICE_BINDINGS[entry.name] || {};
    for (const stripped of entry.stripped_services || []) {
      if (!known[stripped]) {
        throw new InstallError(`${entry.name} 需要的服務 ${stripped} 沒有對應目標`, {
          detail: `manifest.stripped_services 有 ${stripped}，但 SERVICE_BINDINGS[${entry.name}] 沒有它`,
        });
      }
    }
    for (const [name, service] of Object.entries(svc)) {
      bindings.push({ type: 'service', name, service });
    }
  }
  // kbdb 語意搜尋：binding 存在即開關（kbdb runtime 契約，無需 env var）
  // index 有建才注入 VECTORIZE；AI binding 若 manifest 未聲明則補上
  const vectorizeIndex = resolvedFor('vectorize', 'VECTORIZE') || resources.vectorizeIndexName;
  if (vectorizeIndex && entry.name && entry.name.includes('kbdb')) {
    bindings.push({ type: 'vectorize', name: 'VECTORIZE', index_name: vectorizeIndex });
    if (!bindings.some((b) => b.type === 'ai')) {
      bindings.push({ type: 'ai', name: 'AI' });
    }
  }
  // cypher 版本標記：daemon 比對雲端版本用；portal 也讀它顯示「目前版本」
  //
  // 🔴 2026-08-02 t170 續修（leo 重裝 geek6688 後總管實測抓到）：
  //    原本條件是 `includes('cypher')` ⇒ **UI 那顆拿不到 ARCRUN_BUNDLE_VERSION**
  //    ⇒ 新加的 /__version 回 `bundle_version: ""` ⇒ 安裝器那條
  //    「ui bundle_version ≠ wantVer 就重推」的判準**根本沒在運作**（空字串 falsy 被跳過）。
  //    當時沒出事純粹是靠「舊 UI 沒有 /__version 這條路由」在擋——
  //    但那是一次性的（下個世代大家都有 /__version 了就失效）＝又回到猜特徵的老路。
  //    ⇒ UI 也要注入版本，讓「比版本」這個判準真的有牙齒。
  if (entry.name && (entry.name.includes('cypher') || entry.name === 'arcrun-rag-ui')) {
    // D37：commit 短碼跟 bundleBase(env) 走——staging 用 env.BUNDLE_BASE 蓋釘點時才不會標成 prod 的碼
    const bundleCommit = bundleCommitOf(env);
    // 🔴 2026-08-02：優先寫 manifest.release（semver，例 `1.4.2`）——
    //    portal 的版本卡拿它跟 /api/latest 的 release 比對，兩邊必須同一種格式才比得動。
    //    舊 bundle 沒有 release 欄時退回舊格式 `建置日+短碼`（portal 會判定為「較舊版本」＝落後，
    //    這正是我們要的：舊實例本來就該被提示更新）。
    const versionText = inject.bundleRelease
      ? String(inject.bundleRelease)
      : (inject.bundleBuilt ? String(inject.bundleBuilt) : '') + '+' + bundleCommit;
    bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: versionText });
  }
  // D36 第2步（07-29）：KBDB_INTERNAL_TOKEN **不再塞進 bindings**。
  //
  // 為什麼拆掉：bindings 隨 multipart code 上傳一起送 ⇒「程式碼沒變→跳過上傳→金鑰也沒送」
  // ⇒ worker 身上舊金鑰、workflow 帶新金鑰 ⇒ 全 401（t145 實錄：萃取切出的 5 個三元組
  // 一筆都寫不進去，且指紋一致→永遠跳過→重裝幾次都修不好）。
  // 改由 putWorkerSecretDirect() 在部署後獨立寫入（見 runInstall），
  // **金鑰同步與「程式碼有沒有變」徹底解耦**＝t145 根治（第4步可回收那個繞法補丁）。
  //
  // 實證（07-29 拿 arcrun-installer 當白老鼠，五步）：獨立寫入的 secret **不會**被
  // 帶 bindings 的部署洗掉——secret 掛在 script 外部，與 bindings 是兩套獨立資源。
  // 證據見 wiki/agent-memory.md「獨立寫入的 CF secret 不會被帶 bindings 的部署洗掉」。
  // vars：manifest 從官方（leo）實例的 toml 抓來，會夾帶 leo 專屬營運 var——
  // 絕不可原封灌進客戶實例（會把 leo 的私有 Gitea 座標/租戶標籤寫進別人的 worker）。
  // denylist 掉這些；per-install 的租戶/憑證由 runInstall 組裝階段依 deploy.ts injectWranglerConfig 語意設。
  const LEO_ONLY_VARS = new Set(['CONSOLE_TENANT', 'GITEA_BASE_URL', 'GITEA_SPRINT_REPO', 'GITEA_SPRINT_DIR']);
  const safeVars = {};
  for (const [k, v] of Object.entries(entry.requires?.vars || {})) {
    if (!LEO_ONLY_VARS.has(k)) safeVars[k] = v;
  }
  // 安裝時注入（覆蓋官方預設 subdomain/account/kbdb url）
  const vars = {
    ...safeVars,
    CF_ACCOUNT_ID: accountId,
    WORKER_SUBDOMAIN: inject.subdomain,
    KBDB_BASE_URL: `https://arcrun-kbdb.${inject.subdomain}.workers.dev`,
    // t34 租戶對齊：portal/console/搜尋 scope 到用戶自己的 ns（denylist 剔了 leo 值，這裡補用戶值）
    ...(inject.tenant ? { CONSOLE_TENANT: String(inject.tenant) } : {}),
    // 用戶 GUI（arcrun-rag-ui，第 26 顆）的跨域放行——cypher 缺它＝登入靜默全斷（07-22 實撞同型）
    UI_ORIGINS: `https://arcrun-rag-ui.${inject.subdomain}.workers.dev`,
    // arcrun-rag#38/#69/#25（2026-08-11）：D62「忘記密碼」代寄——**這行以前完全沒被寫過**，
    // `grep -rn PORTAL_MAIL_RELAY installer/` 曾是零命中，即使 landing 那半（郵差）已經
    // 出貨（c0ef64c／1.4.35）。cypher 端（matrix/arcrun portal.ts）早就會讀
    // `env.PORTAL_MAIL_RELAY_BASE`，沒收到就誠實回 503 `mail_relay_not_configured`
    // ——leo 按「忘記密碼」看到的正是這句話。
    // 值＝這個環境（stage/prod）自己的郵差 workers.dev 網址，跟後端已經在用的
    // `landingBase(env)` 是同一個函式、同一份真相（env.LANDING_BASE 覆蓋，
    // prod/staging 各自的 wrangler.toml vars 早就設好，見 installer/oauth-prototype/wrangler.toml）
    // ⇒ 不新增第二個要維護的座標。只在 cypher 這顆宣告（cypher-executor/src/types.ts 的
    // Bindings 只有這一顆有這個欄位；UI 沒有）。
    ...(entry.name && entry.name.includes('cypher') ? { PORTAL_MAIL_RELAY_BASE: landingBase(env) } : {}),
    // t151：MCP 的租戶對齊。**這兩個不給就是「連得上但什麼都查不到」的假通**——
    // partner-auth.ts:60 的預設是 `MCP_OWNER_NAMESPACE || "leo"` ⇒ 用戶實例發出的 access token
    // 會綁在 namespace `leo` 這個分區，而他的卡片是寫在自己的租戶分區底下
    // ⇒ AI 接上了、查詢卻永遠是空的（實測 leo 實例 arcrun_whoami 回 `"account_namespace": "leo"`）。
    // MULTI_TENANT="false"＝self-hosted 單租戶語意（對齊 mcp/wrangler.toml 的註解與 cypher 同名旗標）。
    ...(entry.name === 'arcrun-mcp' && inject.tenant
      ? { MCP_OWNER_NAMESPACE: String(inject.tenant), MULTI_TENANT: 'false' }
      : {}),
    // 2026-08-10：MCP 也要能一條 curl 說出「我是哪一版」。
    // `GET /health` 的 `build` 欄讀的就是這個 var（mcp/src/index.ts）；不給就回 "unknown"
    // ⇒ 又回到「要判斷某台的 MCP 是哪一代，只能打 /authorize 剖 HTML 數欄位」的土法。
    // 值＝這次出貨的 release（與 cypher／ui 的 ARCRUN_BUNDLE_VERSION 同一個來源，
    // 對齊「凡宣告版本一律由產物推導」）。
    ...(entry.name === 'arcrun-mcp' && inject.bundleRelease
      ? { MCP_BUILD: String(inject.bundleRelease) }
      : {}),
  };
  for (const [k, v] of Object.entries(vars)) bindings.push({ type: 'plain_text', name: k, text: String(v) });

  // 3. multipart PUT /scripts
  const metadata = {
    main_module: entry.main_module,
    compatibility_date: entry.compat_date || COMPAT_DATE,
    compatibility_flags: entry.compat_flags || [],
    bindings,
  };
  const form = new FormData();
  form.append('metadata', new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }));
  form.append(entry.main_module, new File([mainSrc], entry.main_module, { type: 'application/javascript+module' }));
  for (const w of wasmBlobs) form.append(w.name, new File([w.buf], w.name, { type: w.type }));

  await cfFetch(token, `/accounts/${accountId}/workers/scripts/${entry.name}`, { method: 'PUT', body: form });

  // 4. 開 workers.dev 子域（cypher 靠 URL 找零件，component worker 也要對外可達）
  try {
    await cfFetch(token, `/accounts/${accountId}/workers/scripts/${entry.name}/subdomain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  } catch { /* 子域開通失敗不擋（可能官方帳號無 subdomain），caller 記 note */ }

  return { name: entry.name, url: 'https://' + entry.name + '.' + inject.subdomain + '.workers.dev', usedFallback };
}

/** 佔位代換：整棵 JSON stringify → 逐一 replace → parse（等價 push-demo-workflow.sh sed 段）。 */
function applySubs(obj, subs) {
  let s = JSON.stringify(obj);
  for (const [k, v] of Object.entries(subs)) s = s.split(k).join(String(v).replace(/(["\\])/g, '\\$1'));
  return JSON.parse(s);
}

/** 推一條 workflow 到（新裝好的）實例：/cypher/search 編圖 → config 合節點 → /webhooks/named。
 *  手法逐字對齊工地主任 pushWorkflow（installer/src/index.js）＝push-demo-workflow.sh 的 API 復刻。 */
async function pushWorkflowTo(cypherBase, ns, subs, wf) {
  const name = wf.name;
  try {
    const flow = applySubs(wf.flow, subs);
    const cfg = applySubs(wf.config, subs);
    const hdr = { 'content-type': 'application/json', 'X-Arcrun-API-Key': ns, 'user-agent': 'curl/8.5.0' };
    // t158 P0「部署≠發現」（leo 07-31：「這裡只是複製一些工作流的 data 過去，沒有要在
    // 這裡驗證」「打包好的幾個工作流準備好直接 import 就好了」）：
    // graph 已在**打包期**預編進 workflows.json（引擎自己的 parser 產、mode:compile）——
    // 安裝＝import 純上傳，**全程 0 次 /cypher/search**。實例 cypher 冷不冷、search 壞不壞
    // 都炸不到安裝（今晚 prod 的雷＝daa047a 實例冷啟 search 25.7s vs 15s timeout）。
    // fallback：舊 workflows.json 無 graph 時才退回 mode:compile 編圖（相容）。
    let g;
    if (wf.graph && Array.isArray(wf.graph.nodes)) {
      g = applySubs(wf.graph, subs);
    } else {
      const cres = await fetch(`${cypherBase}/cypher/search`, { method: 'POST', headers: hdr, body: JSON.stringify({ triplets: flow, mode: 'compile' }), signal: AbortSignal.timeout(20000) });
      const compiled = await cres.json().catch(() => ({}));
      if (!cres.ok) return { name, ok: false, error: `/cypher/search HTTP ${cres.status}` };
      g = compiled.cypher;
    }
    const nodes = (g.nodes || []).map((node) => {
      const c = cfg[node.id];
      if (!c) return node;
      const params = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'component'));
      const n = { ...node };
      if (typeof c.component === 'string') n.componentId = c.component;
      if (Object.keys(params).length) n.data = { ...(node.data || {}), ...params };
      return n;
    });
    const dres = await fetch(`${cypherBase}/webhooks/named`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ name, graph: { id: name, name, nodes, edges: g.edges || [] }, config: cfg, description: wf.description || '' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!dres.ok) return { name, ok: false, error: `/webhooks/named HTTP ${dres.status}` };
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 把 skills.json 逐支種進實例 kbdb（經 cypher /kbdb 代打；與工地主任 installer/src/index.js
 *  seedSkills 同一手法）。kbdb 自 t115 起 fail-closed（要 Bearer KBDB_INTERNAL_TOKEN）——
 *  安裝器不直打 kbdb、不碰那把金鑰（D36），改走 cypher 既有 kbdb-proxy 路由
 *  （X-Arcrun-API-Key 租戶認證，owner_id 由 proxy 強制注入，金鑰在 cypher 自己的 env）。
 *  冪等：GET 探 page_name+entry_type；**已存在且內容不同 → PATCH 更新**（t164）。
 *  entry 形態逐字對齊 Arcrun
 *  scripts/sync-registry-to-kbdb.py（讀取端 arcrun_list_skills 認 entry_type=agent-skill）。
 *
 *  🔴 t164（2026-08-01）：原本「已存在就 skip」⇒ **既有實例的 skill 永遠停在第一次安裝的
 *  世代，重裝也不會更新**。實撞：步驟 5 把條件分支寫進 write_intent_workflow，
 *  stage 重裝後讀到的仍是 4033 字舊版（無 ON_BRANCH），得手動 PATCH 才更新。
 *  這與步驟 1 的「harness 世代脫節」同一個病——**發得出去 ≠ 收得到**。
 *  修法：內容不同才 PATCH（相同則 skip，維持冪等、不製造無謂寫入）。 */
async function seedSkillsTo(cypherBase, ns) {
  const sk = { created: [], existed: [], updated: [], errors: [] };
  const hdr = { 'X-Arcrun-API-Key': ns, 'user-agent': 'curl/8.5.0' };
  for (const s of SKILLS) {
    const pageName = `skill-${s.slug}`;
    try {
      const probe = await fetch(
        `${cypherBase}/kbdb/entries?page_name=${encodeURIComponent(pageName)}&entry_type=agent-skill&limit=1`,
        { headers: hdr, signal: AbortSignal.timeout(10000) },
      );
      const pbody = await probe.json().catch(() => ({}));
      const hit = probe.ok && Array.isArray(pbody && pbody.entries) ? pbody.entries[0] : null;
      if (hit) {
        // t164：內容一致＝真的不用動；不一致＝上一個世代，PATCH 成現行版本。
        if ((hit.content || '') === s.content) { sk.existed.push(s.slug); continue; }
        const upd = await fetch(`${cypherBase}/kbdb/entries/${encodeURIComponent(hit.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...hdr },
          body: JSON.stringify({ content: s.content }),
          signal: AbortSignal.timeout(15000),
        });
        if (upd.ok) sk.updated.push(s.slug);
        else sk.errors.push(`${s.slug}: 更新 HTTP ${upd.status}`);
        continue;
      }
      const res = await fetch(`${cypherBase}/kbdb/entries`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...hdr },
        body: JSON.stringify({
          entry_type: 'agent-skill',
          page_name: pageName,
          content: s.content,
          metadata_json: JSON.stringify({ slug: s.slug, title: s.title, source: 'installer-seed' }),
          tags_json: JSON.stringify(['agent-skill', `skill:${s.slug}`]),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) sk.created.push(s.slug);
      else sk.errors.push(`${s.slug}: HTTP ${res.status}`);
    } catch (e) { sk.errors.push(`${s.slug}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return sk;
}

// 具名匯出僅供離線測試用（CF Worker runtime 只認 default.fetch，多這幾個無副作用）。
export {
  fetchBundleManifest, deployBundledWorker, bundleBase, landingBase,
  slugFromEmail, verifyInviteCode, MIGRATION_SQL,
  // 資源解析（判斷本身在 shared/resource-rule/，這兩支只做輸入整形與呼叫）
  manifestRequirements, resolveResourcesByRule, ensureVectorizeMetadataIndexes, VECTORIZE_INDEX,
  applySubs, pushWorkflowTo,
  hasDeployRecordForToken, // t154
  SERVICE_BINDINGS, reorderForServiceBindings, // t151
  seedSkillsTo, // skills 種入（本班）
  manifestCountsOf, homePage, // 授權頁「技術細節」數量與建置識別——供離線測試證明「換 manifest 數字會跟著變」
};

/**
 * 執行整個安裝。每一步都會即時把進度寫回 KV。
 *
 * 🔴 資源判斷已不是「配合 ensure* 冪等建立」（那三支 PR #87 已整段刪掉，見上方
 * 767 行區塊）。現在委外給 `shared/resource-rule/`：已部署的 worker 綁著什麼就
 * 沿用什麼，不看名字；只有確定沒人綁過才新建。email 推導的可重現短碼
 * （`slugFromEmail`，見下方 `baseName`）現在只在「真的要新建」時拿來當新資源
 * 的名字，不再是「找不找得到既有資源」的判斷依據——這件事本身就是斷點續傳
 * 續得下去的原因：接力續跑靠的是 `progress.result`，不是靠猜資源名字。
 */
async function runInstall(env, sid, progress, force) {
  // 可重現命名：用已驗證的 email 推導。P0-1 保證 email 必在；缺席＝閘被繞過的異常，
  // 直接失敗（不退回隨機命名——隨機會破壞斷點續傳、留下孤兒資源）。
  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  const email = sess && sess.inviteEmail;
  if (!email) {
    progress.state = 'error';
    progress.startedAt = Date.now();
    progress.finishedAt = Date.now();
    progress.error = {
      step: 'account',
      stepLabel: '確認你的辨識碼',
      message: '找不到你的辨識碼資訊',
      hint: '請回到首頁，用你登記的 Email 和辨識碼重新開始。',
      detail: 'session has no inviteEmail — invite gate may have been bypassed',
    };
    await writeProgress(env, sid, progress);
    return;
  }
  const suffix = await slugFromEmail(email);
  const baseName = `arcrun-rag-${suffix}`;
  const runStart = Date.now(); // 本輪 invocation 起算（deploy 迴圈的牆鐘護欄用這個，不是總安裝耗時）
  progress.state = 'running';
  if (!progress.startedAt) progress.startedAt = runStart; // 接力續跑：保留第一輪的起始時間
  progress.result.suffix = suffix;
  progress.result.bundleBase = bundleBase(env); // t120 log 用
  // t26：主身分＝email（暱稱選配、CF 全程隱形）。存進 progress.result 讓
  // handleInstallStatus 的 JSON（status 輪詢）與成功頁前端組 config 時都拿得到，
  // 不必前端另外打 session API。
  progress.result.email = email;
  await writeProgress(env, sid, progress);

  let kbdbToken = null; // t141：實際取值在拿到 accountId 之後（見下方 ensureKbdbToken）
  const ensureKbdbToken = async (accId) => {
    // t141（07-29 事故）：金鑰必須**跟著實例走**，不能跟著「本次安裝進度」走。
    // 原本存 progress.result（每次安裝 freshProgress 重來）⇒ 重裝產生新金鑰，
    // 但 kbdb worker 因 t132 差異更新「sha 沒變被跳過」而沒重新注入 ⇒ 它身上還是舊金鑰，
    // 工作流卻帶新金鑰 ⇒ **圖譜/查詢全 401**（leo 實測 graph_neighbors Unauthorized）。
    // 存 INSTALLER_KV `kbdbtok:<accountId>`：同一帳號的實例永遠同一把。
    if (progress.result.kbdbToken) { kbdbToken = progress.result.kbdbToken; return kbdbToken; }
    const k = 'kbdbtok:' + accId;
    let saved = await env.INSTALLER_KV.get(k).catch(() => null);
    if (!saved) {
      const tb = crypto.getRandomValues(new Uint8Array(32));
      saved = Array.from(tb, (b) => b.toString(16).padStart(2, '0')).join('');
      await env.INSTALLER_KV.put(k, saved).catch(() => {});
    }
    progress.result.kbdbToken = saved;
    kbdbToken = saved;
    return saved;
  };

  // 🔴 2026-08-10：`MCP_OWNER_SECRET` 的產生與下發**整段拆掉**（原 t151 收尾 #7）。
  //
  // 為什麼現在才能拆、也必須拆：這一版起 `arcrun-mcp` **進了 bundle 清單**
  // （bundle-components.mjs）⇒ 安裝器每次跑都會把**新世代**的 mcp 推上去
  // （舊實例的 deploy 游標裡從來沒有 arcrun-mcp 這一筆 ⇒ 逐顆跳過的 sha 比對必定 miss ⇒ 必推）。
  // 而新世代的 `/authorize` 驗的是**用戶自己的 Portal 帳密**（mcp/src/oauth/routes.ts:233，
  // 走 CYPHER_EXECUTOR service binding 打 /portal/login），全檔對 MCP_OWNER_SECRET
  // 只剩 `types.ts` 一個沒人讀的選填欄位。
  // ⇒ 留著它＝**在同一次安裝裡同時佈署兩代認證的殘骸**：多一次 CF API 寫入、
  //   多一把沒有任何程式碼會讀的 32 bytes、以及一個會誤導下一個讀這段的人的訊號
  //   （「所以到底要不要給用戶那把密碼？」——答案是不要，同意頁根本沒有那個欄位）。
  // 保留的相容性論述在這一版失效：它當初的理由是「不砍還沒升級的舊實例」，
  // 但安裝器現在就是那個升級動作本身。
  // ⚠️ 既有的 `mcpsecret:<accountId>` KV 條目**不刪**（不做不可逆的清理），只是不再讀寫。
  // 驗法：裝完打 `GET /health` 應回 `auth: "portal-login"`——那就是「這台是新世代」的證據。

  const setStep = async (id, state, note) => {
    const s = progress.steps.find((x) => x.id === id);
    if (s) {
      s.state = state;
      if (note !== undefined) s.note = note;
    }
    progress.currentStep = state === 'running' ? id : progress.currentStep;
    await writeProgress(env, sid, progress);
  };

  // 接力續跑用：已經 done 的步驟直接沿用 progress.result 裡的舊結果，不重打 CF API
  // （省下的 subrequests/時間留給 deploy 迴圈繼續裝下一顆）。
  const stepDone = (id) => {
    const s = progress.steps.find((x) => x.id === id);
    return !!s && s.state === 'done';
  };

  const fail = async (stepId, err) => {
    const step = STEPS.find((s) => s.id === stepId);
    const s = progress.steps.find((x) => x.id === stepId);
    if (s) s.state = 'error';
    progress.state = 'error';
    progress.finishedAt = Date.now();
    progress.error = {
      step: stepId,
      stepLabel: step ? step.label : stepId,
      message: err instanceof InstallError ? err.message : '發生了預期外的錯誤',
      hint: (err && err.hint) || '請按「重新安裝」再試一次；若持續失敗，請把技術細節回報給我們。',
      detail: (err && err.detail) || String((err && err.stack) || err),
      // #45：有些錯的正解不是「重試」，是「去某一頁做一件事」。
      // 只給文字叫使用者自己把網址打對＝把修復成本丟回給他
      // （leo 2026-07-22：「人去按了連到錯的機制、安裝失敗，不算友善」）
      // ⇒ 錯誤本身可以帶一顆按鈕，讓那條出路是**按得到的**。
      action: (err && err.action) || null,
    };
    await writeProgress(env, sid, progress);
    await writeInstallLog(env, sid, progress); // t120
  };

  let token;
  try {
    token = await getAccessToken(env, sid);
  } catch (e) {
    await fail('account', e);
    return;
  }

  // --- a. 帳號 -------------------------------------------------------------
  let accountId, accountName;
  if (stepDone('account')) {
    // 接力續跑：上一輪已經 done，沿用結果，不再打 CF /accounts（省額度給 deploy 迴圈）
    accountId = progress.result.accountId;
    await ensureKbdbToken(accountId); // t141
    accountName = progress.result.accountName;
  } else {
    try {
      await setStep('account', 'running');
      const accounts = await cfFetch(token, '/accounts');
      if (!accounts || accounts.length === 0) {
        throw new InstallError('你的 Cloudflare 帳號底下沒有可用的空間', {
          hint: '請先到 Cloudflare 官網完成帳號設定，再回來重新安裝。',
          detail: 'GET /accounts returned empty array',
        });
      }
      // 🔴 #45（2026-08-09）：多個帳號時**不准默默取第一個**（`GET /accounts` 排序不保證，
      // 有機會把 worker/D1 建進另一個帳號——leo 的第二筆是他接案代管的**客戶帳號**）。
      //
      // 但**也不在這裡問第二次**（leo：「不要保留，避免造成誤解」）：
      // Cloudflare 的授權屏本身就有 `Select account(s)` 勾選清單，**使用者在上游已經選過了**，
      // 勾哪個換到的 token 就只含哪個；而身分更早就定了——填 Email 拿驗證碼那一刻。
      // 我們再問一次＝同一件事問兩次，比不問更糟。
      // ⇒ 所以這裡只做 fail-closed：真的收到多個就停下來說清楚，請他**回上游改**。
      // 教訓全文見頂層 `wiki/mistakes.md`「動手做一個保護之前，沒問『平台是不是已經做了』」。
      if (accounts.length > 1) {
        throw new InstallError('你在 Cloudflare 授權時勾選了多個帳號', {
          // ⚠️ 這段是**純文字**（前端用 esc() 逃脫後直接塞進 <p>，沒有 markdown 轉換）——
          // 寫 `**粗體**` 會原樣顯示星號給使用者看。2026-08-10 瀏覽器實看抓到。
          hint: '請回首頁重新開始，在 Cloudflare 的授權畫面只勾選「你要安裝到的那一個帳號」，'
            + '我們就會裝到那裡。我們不會替你猜要裝哪一個。',
          action: { href: '/', label: '回首頁重新授權' },
          detail: `GET /accounts returned ${accounts.length} accounts `
            + `(${accounts.map((a) => a && a.id).join(', ')}) — refusing to guess (#45)`,
        });
      }
      const picked = accounts[0]; // 只有一個＝使用者在授權屏已經定案，不再多問
      accountId = picked.id;
      accountName = picked.name;
      progress.result.accountId = accountId;
      await ensureKbdbToken(accountId); // t141
      progress.result.accountName = accountName;
      progress.result.accounts = accounts.map((a) => ({ id: a.id, name: a.name }));
      await setStep('account', 'done', `使用「${accountName}」`);
    } catch (e) {
      await fail('account', e);
      return;
    }
  }

  // 真品清單（26 顆＋各自 requires）走 jsDelivr/GitHub 鏡像，跟 CF 額度無關——
  // 不論是否接力續跑都重抓一次，deploy 迴圈續跑一定要用到。
  let manifest;
  try {
    manifest = await fetchBundleManifest(env);
  } catch (e) {
    await fail('cache', e);
    return;
  }

  // --- b+c. 資源解析：KV／D1／Vectorize 一次決定 -----------------------------
  //
  // 🔴 `Leo/Arcrun#97` 的根治點。這裡以前是「照安裝器自己算出來的名字找，找不到就建」
  //    ——名字對不上（使用者改過名／當初是別的版本裝的／另一條通道裝的）就會建一套
  //    空的頂上去，於是「我按了更新，工作流和登入全不見了」。
  //
  //    現在整段的判斷都在共用規則（`shared/resource-rule/`，`acr` 吃同一份）：
  //      ① 已部署的 worker 上綁著什麼＝事實 → 原封沿用，名字長什麼樣完全不看
  //      ② 只有「確定沒有任何人綁過它」才准新建
  //      ③ 有一點說不準就整趟停手，什麼都不建、什麼都不部署
  //
  //    ⚠️ 本輪解出來的對照表存進 `progress.result.resourceBindings`＝接力續跑的游標。
  //    第一次安裝時資源已建、worker 還沒部署 ⇒ 那個當下帳號上沒有任何 binding，
  //    游標若掉了就只能重新建一批（會留下沒人綁的孤兒，但**不會弄丟任何資料**）。
  //    這是刻意的取捨：寧可多一批孤兒，也不要退回「照名字猜使用者的資源」。
  let resourceBindings = progress.result.resourceBindings || null;
  let kvIds = {};
  let dbId = null;
  let vectorizeIndexName = null;

  if (!resourceBindings) {
    try {
      await setStep('cache', 'running');
      // mode：這台照**我們的紀錄**裝過了沒。'update' 時共用規則會多一道保險——
      // 「說是更新，卻一顆要更新的 worker 都找不到」就停手（那是 #97 的另一道門）。
      // 兩條通道的 KV 都看（t157：同帳號被 staging／prod 各裝一半是真實發生過的事）。
      let installedBefore = false;
      for (const kvBinding of [env.INSTALLER_KV, env.PEER_INSTALLER_KV]) {
        if (!kvBinding || typeof kvBinding.list !== 'function' || installedBefore) continue;
        const list = await kvBinding.list({ prefix: `deployed:${accountId}:`, limit: 1 }).catch(() => null);
        if (list && list.keys && list.keys.length > 0) installedBefore = true;
      }
      const mode = installedBefore ? 'update' : 'init';
      progress.result.resourceMode = mode;
      await writeProgress(env, sid, progress); // 心跳：解析期間頁面不該看起來像卡死

      // 先連 Vectorize 一起解。語意搜尋是**選配**（kbdb 沒有 VECTORIZE binding 就自動
      // 降級成關鍵字搜尋），所以它擋不住整趟安裝——但「該不該建、該用哪一顆」仍然只由
      // 共用規則決定，這裡沒有第二套判斷。
      let r = await resolveResourcesByRule(token, accountId, manifestRequirements(manifest, baseName, true), mode);
      if (r.blocked) {
        // 拿掉 Vectorize 再解一次。**成功＝剛才被擋下的原因就是 Vectorize**
        // （不必去讀 blocker 的字串猜它在講什麼）；還是擋＝真的有事，照原始理由停手。
        const retry = await resolveResourcesByRule(token, accountId, manifestRequirements(manifest, baseName, false), mode);
        if (!retry.blocked) {
          progress.result.vectorizeWarning = r.blockers.join('\n');
          r = retry;
        }
      }
      if (r.blocked) {
        // 🔴 停手時**一顆資源都沒被建**（共用規則的 plan／apply 兩段保證）。
        //    原因原文照轉給使用者——這條路會動他的資料綁定，不確定就不要替他決定。
        throw new InstallError('為了保護你既有的資料，這次更新已經停下來了', {
          hint: r.blockers.join('\n\n') + '\n\n（沒有建立或改動任何資源。）',
          detail: 'resource-rule blocked: ' + r.blockers.join(' | '),
        });
      }

      resourceBindings = r.bindings;
      progress.result.resourceBindings = r.bindings;
      progress.result.resourceOrigin = r.origin;
      // #106：已部署 worker 上現有的 plain_text var（含 ARCRUN_BUNDLE_VERSION）。
      // 這一版先留紀錄供診斷；沿用它們是另一張票的事（見 PR 內文）。
      progress.result.liveVars = r.liveVars;

      const adopted = Object.values(r.origin).filter((o) => o === 'adopted').length;
      const created = Object.values(r.origin).filter((o) => o === 'created').length;
      await setStep('cache', 'done', adopted > 0
        ? `沿用你原本的 ${adopted} 項資源${created ? `，新增 ${created} 項` : ''}`
        : `${created} 個快取空間已就緒`);
    } catch (e) {
      await fail('cache', e);
      return;
    }
  } else {
    kvIds = {}; // 下面統一從 resourceBindings 攤平
  }

  // 攤平成既有欄位（deploy 迴圈與進度頁沿用同一組名字，不新增第二種真相）
  for (const [key, value] of Object.entries(resourceBindings)) {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const binding = key.slice(sep + 1);
    if (kind === 'kv_namespace') kvIds[binding] = value;
    else if (kind === 'd1' && !dbId) dbId = value;
    else if (kind === 'vectorize') vectorizeIndexName = value;
  }
  const kvId = kvIds[Object.keys(kvIds)[0]] || null;
  progress.result.kvIds = kvIds;
  progress.result.cacheId = kvId;
  progress.result.kvCount = Object.keys(kvIds).length;

  if (!dbId) {
    await fail('database', new InstallError('沒有解析到知識庫資料庫', {
      hint: '請按「重新安裝」再試一次；若持續失敗請把技術細節回報給我們。',
      detail: 'resourceBindings has no d1:* entry — bundle manifest requires.d1 may be empty',
    }));
    return;
  }
  progress.result.databaseId = dbId;
  {
    const d1Origin = Object.entries(progress.result.resourceOrigin || {}).find(([k]) => k.startsWith('d1:'));
    const adoptedD1 = !!(d1Origin && d1Origin[1] === 'adopted');
    // 「技術細節」那格：沿用時**不准報 `${baseName}-db`**——那是我們會取的名字，
    // 不是他帳號上那顆實際叫什麼（照名字報＝又把名字當識別，#97 的思路）。
    progress.result.databaseName = adoptedD1 ? `（沿用你原本那顆，id ${dbId}）` : `${baseName}-db`;
    if (!stepDone('database')) {
      await setStep('database', 'done', adoptedD1 ? '沿用你原本的知識庫資料庫' : '知識庫資料庫已建立');
    }
  }

  // --- d. migration（一次批次送多語句，已實測可行）-------------------------
  if (!stepDone('schema')) {
    try {
      await setStep('schema', 'running');
      await cfFetch(token, `/accounts/${accountId}/d1/database/${dbId}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: MIGRATION_SQL }),
      });
      await setStep('schema', 'done', '資料表已就緒');
    } catch (e) {
      await fail('schema', e);
      return;
    }
  }

  // --- e. 部署 worker（分批接力——見檔頭 DEPLOY_BUDGET_PER_RUN/DEPLOY_TIME_BUDGET_MS 註解）---
  let workerUrl;
  if (stepDone('deploy')) {
    // 防禦性保留：正常不會落到這裡（deploy done 代表已經進到 workflows 步了）
    workerUrl = progress.result.apiUrl;
  } else {
    try {
      await setStep('deploy', 'running');
      // 子網域先行：零件靠 URL 互打（cypher→component），沒有 workers.dev 子網域整套不通＝fail-closed
      let subdomain = progress.result.subdomain;
      if (!subdomain) {
        const sub = await cfFetch(token, `/accounts/${accountId}/workers/subdomain`).catch(() => null);
        subdomain = sub && sub.subdomain;
        if (!subdomain) {
          throw new InstallError('你的 Cloudflare 帳號還沒開通 workers.dev 專屬網址', {
            hint: '請到 Cloudflare 後台 Workers 頁面設定一個子網域（免費），再回來按「重新安裝」。',
            detail: 'GET /workers/subdomain returned no subdomain',
          });
        }
        progress.result.subdomain = subdomain;
      }
      // 語意搜尋：index 該用哪一顆（沿用或新建）已經在上面由共用規則決定完了。
      // 這裡只補「新建出來的那顆要加 metadata 欄位」——沿用既有的不動它
      // （跟舊寫法一致：以前 GET 得到就直接 return，不會去補 metadata）。
      if (vectorizeIndexName && !progress.result.vectorizeReady) {
        const created = (progress.result.resourceOrigin || {})['vectorize:VECTORIZE'] === 'created';
        if (created) await ensureVectorizeMetadataIndexes(token, accountId, vectorizeIndexName);
        progress.result.vectorizeReady = true;
        await writeProgress(env, sid, progress);
      }
      const resources = { kv: kvIds, d1Id: dbId, vectorizeIndexName, bindings: resourceBindings, kbdbToken };
      if (!Array.isArray(progress.result.deployedNames)) progress.result.deployedNames = [];
      let budget = DEPLOY_BUDGET_PER_RUN;
      // t132: 差異更新——讀上次部署 sha256 紀錄（force=true 時忽略，強制全裝）
      const deployedKey = 'deployed:' + accountId + ':' + subdomain;
      let prevDeployState = null;
      if (!force) {
        prevDeployState = await env.INSTALLER_KV.get(deployedKey, 'json').catch(() => null);
      }
      // t157（07-31 實錄）：同帳號雙通道互蓋偵測——youlin 先被 staging（Gitea 釘點）裝了 24 顆，
      // leo 又用 prod（jsDelivr 釘點）裝到 9/27 ⇒ 混血實例。bundleBase 的 host 不同＝另一通道。
      // 只告知不擋：警告寫進 progress.channelWarning，前端進度頁頂部顯示黃卡。
      try {
        const curHost = new URL(bundleBase(env)).host;
        const chanRec = prevDeployState || await env.INSTALLER_KV.get(deployedKey, 'json').catch(() => null);
        const localForeign = !!(chanRec && chanRec.bundleBase && new URL(chanRec.bundleBase).host !== curHost);
        // t157 補完（07-31 深夜實錘半成品：binding 綁了但沒讀）：兩通道 KV 分離互不知情，
        // 必須讀**對方通道**的 KV（PEER_INSTALLER_KV，唯讀）才偵測得到「youlin 被 staging
        // 24 顆＋prod 9/27 裝成混血」這型。peer 有這個帳號的部署紀錄＝另一通道裝過。
        const peerRec = env.PEER_INSTALLER_KV
          ? await env.PEER_INSTALLER_KV.get(deployedKey, 'json').catch(() => null) : null;
        const peerForeign = !!(peerRec && peerRec.bundleBase && new URL(peerRec.bundleBase).host !== curHost);
        if (localForeign || peerForeign) {
          const isStaging = env && env.DEPLOY_ENV === 'staging';
          const cur = isStaging ? 'staging（測試版）' : '正式版';
          const prevName = isStaging ? '正式版' : 'staging（測試版）';
          progress.channelWarning = '提醒：這個帳號也被' + prevName + '安裝器裝過，你現在用的是' + cur
            + '——繼續裝會把整套服務切換成' + cur + '。資料（知識庫內容）不會動到，但程式版本會整個換過去。';
          await writeProgress(env, sid, progress);
        }
      } catch (_) { /* 警告產生失敗不擋安裝 */ }
      // t132 二修（leo：「a b 沒變卻每版重裝＝完全不是正確設計」）：本輪已裝 sha 紀錄，
      // 以上次紀錄為底（接力不掉），**每顆成功後立刻寫該顆**——不再收尾時照抄整份 manifest
      // （那會把沒真的裝到的也記成已裝＝「紀錄說裝了實際沒裝」，比重裝更危險）。
      const deployedShaNow = Object.assign({}, (prevDeployState && prevDeployState.workers) || {});
      // t132 三修（leo 07-29：「把所有 27 個的 sha 放在一起產生一張紙，再產生一個 sha，
      // 那不就只要去比對兩邊的『總 sha』是否一致，如果一致就不用輪詢了，整個跳過就好了」）：
      // 逐顆比對雖然會跳過部署，但**每顆仍寫一次 KV**（27 次寫入 ≈ 數十秒），
      // 用戶看到的還是「一顆一顆慢慢走」。改成先算總指紋，一致就整段秒過。
      // t144（07-29 leo 實測揪出）：指紋**必須含 bundleBase（commit 碼）**，不能只含各顆 sha256。
      // 病史：一次安裝用了捏造的 commit 碼 → 失敗前已把假版本號寫進實例的 ARCRUN_BUNDLE_VERSION；
      // 之後換成正確 commit 重裝，因各顆 sha256 相同被判「整段跳過」⇒ 實例版本號永遠停在假碼，
      // health 報一個不存在的 commit，看起來像「更新一直沒生效」（實際程式碼是新的）。
      // 版本號隨 bundleBase 走，所以 bundleBase 一變就必須真的重跑一次讓 var 更新。
      //
      // t145（07-29 leo 實測 rag_ingest_card 三次執行全 401 揪出）：指紋**還要含 kbdbToken**。
      // 病史：kbdb/cypher 身上的 KBDB_INTERNAL_TOKEN 只在 deployBundledWorker 注入，
      // 該顆被判「sha 沒變、跳過」時完全不會重新注入 ⇒ KV 裡是新 token、worker 身上是舊 token，
      // 而安裝時推的 workflow 帶的是新 token ⇒ **workflow 打 kbdb 全部 401、三元組一筆都寫不進去**
      // （實測：cypher 自己的 proxy 打 kbdb 200，同一個 kbdb 對 workflow 卻 401＝兩把 token 不同步）。
      // token 一變就必須真的重跑，讓 worker 身上那把跟上。
      const manifestFingerprint = bundleBase(env) + '||' + (resources.kbdbToken || '').slice(0, 8) + '||' + manifest.core.map((c) => c.name + ':' + (c.sha256 || '')).sort().join('|');
      const prevFingerprint = prevDeployState && prevDeployState.fingerprint;
      // t146（07-29 leo 重裝後實測揪出）：**指紋一致仍要查實例真實版本**。
      // 病史：leo 實例的 cypher 版本停在 bc507f7（假 commit），一直被判「sha 沒變」跳過
      // ⇒ 新 bundle 的 triplet template seed 永遠裝不進去 ⇒ 三元組寫入 400
      // 「template not found: triplet」⇒ 總圖永遠空白。
      // deployState（KV 裡「我以為裝了什麼」）**會說謊**——那次 404 失敗前已寫過紀錄。
      // ⇒ 唯一可信的是**直接問實例自己**：打 cypher /health 讀 bundle_version，
      //   與本次 bundle 版本不符 ⇒ 強制重推（比 t145 無條件重推精準：只在真的落後時才推）。
      // t146 三修（07-29）：**無條件先查實例真實版本**，不能只在「指紋一致」時查。
      // 二修的錯：instanceStale 只在指紋一致時計算 ⇒ 這次 pin 換了、指紋不一致
      // ⇒ instanceStale 恆為 false ⇒ 逐顆跳過照常生效 ⇒ 修了等於沒修（leo 連三次重裝都沒解）。
      let instanceStale = false;
      if (!force) {
        // 🔴 2026-08-02：wantVer 必須與**寫進實例的格式**一致（deployBundledWorker 的
        //    ARCRUN_BUNDLE_VERSION）。兩邊算法一旦不同步，instanceStale 會恆為 true
        //    ⇒ 每次安裝都全量重推 24 顆（慢且無謂）。故一律優先用 manifest.release，
        //    只有舊 bundle（無 release 欄）才退回舊格式——與寫入端同一條規則。
        const wantVer = manifest.release
          ? String(manifest.release)
          : (manifest.built || '') + '+' + (bundleBase(env).split('@')[1] || '').slice(0, 7);
        const probe = await probeInstanceStale({
          healthUrl: `https://arcrun-cypher-executor.${subdomain}.workers.dev/health`,
          uiVersionUrl: `https://arcrun-rag-ui.${subdomain}.workers.dev/__version`,
          wantVer,
        });
        instanceStale = probe.stale;
        progress.result.instanceVersion = probe.instanceVersion;
        progress.result.wantVersion = probe.wantVersion;
        progress.result.uiFingerprint = probe.uiFingerprint;
        progress.result.staleReason = probe.reason;
      }
      if (!force && !instanceStale && prevFingerprint && prevFingerprint === manifestFingerprint) {
        progress.result.deployedNames = manifest.core.map((c) => c.name);
        progress.result.deployed = progress.result.deployedNames.length;
        progress.result.skippedAll = true;
        workerUrl = `https://arcrun-cypher-executor.${subdomain}.workers.dev`;
        progress.result.url = `https://arcrun-rag-ui.${subdomain}.workers.dev/portal/`;
        progress.result.apiUrl = workerUrl;
        // D36 第4步（07-29）：t145 的「兩顆永不跳過」繞法**已回收**。
        // 那個補丁是為了「金鑰隨 code 上傳、跳過就不同步」而設；D36 第2步把金鑰改成
        // 獨立寫入（見下方 putWorkerSecretDirect）後，金鑰同步與部署徹底解耦
        // ⇒ 不必再為了金鑰而強制重推兩顆 worker（省 2 顆部署時間，且不再有繞法要維護）。
        // t168 修②（2026-08-01）：整批跳過**也要把 workers{} 用當前 manifest 重寫並寫回 KV**。
        // 病根：原本這條快路徑完全不呼叫 INSTALLER_KV.put ⇒ workers{} 是**累積式帳本、從不重設**
        // ⇒ 過期條目永遠無法自我修正。leo 實例實證（08-01）：同一筆記錄裡
        // fingerprint 已含新 sha 26440bb4…，workers['arcrun-rag-ui'] 卻仍是舊 sha 30ea4769…，
        // 且殘留 3 個孤兒（arcrun-claude-api / arcrun-kbdb-upsert-block / arcrun-km-writer）。
        const rebuiltShas = {};
        for (const c of manifest.core) { if (c.sha256) rebuiltShas[c.name] = c.sha256; }
        await env.INSTALLER_KV.put(deployedKey, JSON.stringify({
          bundleBase: bundleBase(env), fingerprint: manifestFingerprint, workers: rebuiltShas,
        }), { expirationTtl: 180 * 86400 }).catch(() => {});
        await setStep('deploy', 'done', `${manifest.core.length} 個服務都沒有變動，直接沿用（金鑰已重新同步）`);

      } else {
      // tier1 先、tier2 後（manifest 已排序）；逐顆回寫進度＋游標（deployedNames）
      for (let i = 0; i < manifest.core.length; i++) {
        const entry = manifest.core[i];
        if (progress.result.deployedNames.includes(entry.name)) continue; // 接力續跑：上一輪已裝過這顆
        // 註：以下 budget/牆鐘判斷放在「真的要部署」之前——跳過的顆不打 CF API，
        // 不該消耗額度，也不該觸發接力暫停（07-29 leo 卡在 27/27 的真因之一）。
        // t132: sha256 比對——相同且 bundleBase 未變就跳過，計入完成數讓進度條正常走
        // t132 二修（leo 07-29：「每個版本也只有部分的有變，但全部要重跑一次，完全不經濟，
        // 如果有 3 個東西，前面 10 版 a b 都沒變，但 c 變了 10 次，結果每次 a b 都要重裝，
        // 這完全不是正確設計」）：**判準只有 sha256 一個**——零件內容沒變就不必重推，
        // 與 bundleBase（版本號）無關。原本比對 bundleBase 等於每次換版本就全裝＝跳過永不生效。
        const prevSha = prevDeployState && prevDeployState.workers && prevDeployState.workers[entry.name];
        // t146 二修（07-29 leo 重裝後仍失敗）：**逐顆跳過也要看實例真實版本**。
        // 一修只擋掉「整段跳過」，但這裡還有第二層——每顆仍因 sha 沒變被個別略過
        // ⇒ cypher 永遠裝不到 ⇒ triplet seed 永遠種不進去（leo 連兩次重裝都沒解）。
        // instanceStale 為真時，**逐顆跳過一律失效**。
        if (!instanceStale && prevSha && entry.sha256 && prevSha === entry.sha256) {
          const s2skip = progress.steps.find((x) => x.id === 'deploy');
          if (s2skip) s2skip.note = `${progress.result.deployedNames.length + 1}/${manifest.core.length}：${entry.name}（未變動，略過）`;
          progress.result.deployedNames.push(entry.name);
          if (entry.sha256) deployedShaNow[entry.name] = entry.sha256;
          // 跳過的顆**不逐顆寫 KV**（27 次 KV 寫入≈數十秒，用戶會看到卡在 N/27）：
          // 每 5 顆或最後一顆才回寫一次，兼顧進度可見與速度。
          if ((i % 5 === 4) || i === manifest.core.length - 1) await writeProgress(env, sid, progress);
          continue;
        }
        // t137 三修（leo 推理：「兩個帳號一個死在 24 一個死在 27，同一個 bug 應該死在同位置
        // ⇒ 是共用依賴當下掛了」）：真相＝抓 bundle 失敗時的重試（0.3+0.9+2.7s）＋備援
        // **全算在這 30 秒裡**，所以 CDN 一抖，各自死在「剛好跑到的那一顆」＝位置不同。
        // 修：每顆開始前保留「重試最壞情況」的餘裕（約 8 秒），不夠就先暫停交給下一輪，
        // 而不是做到一半被 waitUntil 砍掉（那會連狀態都來不及寫）。
        // t137 四修（leo：「jsDelivr 掛掉會轉 GitHub raw，**source 有備援**，
        // 那就是**關卡死了**」——推理正確：備援會成功，但重試+備援的等待全算在 30 秒裡，
        // 最後死在時間關卡，且是**被硬砍**（來不及寫狀態⇒前端看到「卡住」而非「接力中」；
        // 主動暫停的路徑是有寫狀態的）。
        // ⇒ 治法：每顆開始前先問「**這一顆最壞情況做不做得完？**」做不完就先暫停交棒，
        // 絕不冒險開始一個可能被砍在中途的工作。RETRY_WORST_MS 涵蓋
        // 重試 3 次(0.3+0.9+2.7s)＋備援一次＋上傳，抓 12 秒。
        const RETRY_WORST_MS = 12000;
        if (budget <= 0 || (Date.now() - runStart) > (DEPLOY_TIME_BUDGET_MS - RETRY_WORST_MS)) {
          // 本輪額度（顆數／牆鐘，雙保險）用完——不是失敗，存游標讓下一輪接著裝
          progress.state = 'paused_continue';
          const s2 = progress.steps.find((x) => x.id === 'deploy');
          if (s2) s2.note = `已裝 ${progress.result.deployedNames.length}/${manifest.core.length}，接力中…`;
          await writeProgress(env, sid, progress);
          return;
        }
        const s2 = progress.steps.find((x) => x.id === 'deploy');
        if (s2) s2.note = `${progress.result.deployedNames.length + 1}/${manifest.core.length}：${entry.name}`;
        // 保底：先把 state 標成 paused_continue 再開始這一顆——萬一被 waitUntil 硬砍，
        // KV 裡留下的仍是「接力中」而不是「running」，前端就會自動接手（不會永久卡住）。
        progress.state = 'paused_continue';
        await writeProgress(env, sid, progress);
        const r = await deployBundledWorker(env, token, accountId, entry, resources, { accountId, subdomain, tenant: suffix, bundleBuilt: manifest.built, bundleRelease: manifest.release });
        progress.result.deployedNames.push(r.name);
        progress.state = 'running'; // 這一顆平安做完，恢復 running（上面是被砍時的保底）
        if (r.usedFallback) progress.result.bundleFallbackUsed = true;
        if (entry.sha256) deployedShaNow[entry.name] = entry.sha256;
        try {
          await env.INSTALLER_KV.put(deployedKey, JSON.stringify({ bundleBase: bundleBase(env), fingerprint: manifestFingerprint, workers: deployedShaNow }), { expirationTtl: 365 * 86400 });
        } catch (_) { /* 紀錄寫入失敗不炸安裝 */ }
        budget--;
        await writeProgress(env, sid, progress); // 每顆成功立刻落地游標——即使下一顆才真的被牆鐘掐死也不會丟進度
      }
      // t132: 儲存本次 sha256 狀態，下次更新只裝有變動的顆（TTL 365 天）
      try {
        await env.INSTALLER_KV.put(deployedKey, JSON.stringify({ bundleBase: bundleBase(env), fingerprint: manifestFingerprint, workers: deployedShaNow }), { expirationTtl: 365 * 86400 });
      } catch (_) { /* 紀錄寫入失敗不炸安裝 */ }
      workerUrl = `https://arcrun-cypher-executor.${subdomain}.workers.dev`;
      // 用戶點的主連結＝GUI（八步旅程「雲端 GUI 搜得到」）；API 網址另欄保留
      progress.result.url = `https://arcrun-rag-ui.${subdomain}.workers.dev/portal/`;
      progress.result.apiUrl = workerUrl;
      progress.result.deployed = progress.result.deployedNames.length;
      const fallbackNote = progress.result.bundleFallbackUsed ? '（部分元件使用備用來源下載）' : '';
      if (progress.result.deployedNames.length < manifest.core.length) {
        // 保險：迴圈結束但還沒裝完（額度/牆鐘剛好在最後一顆用盡）——
        // 必須明確標 paused_continue 讓前端接力，不能停在 running 沒人推（07-29 leo 卡 27/27）。
        progress.state = 'paused_continue';
        const s3 = progress.steps.find((x) => x.id === 'deploy');
        if (s3) s3.note = `已裝 ${progress.result.deployedNames.length}/${manifest.core.length}，接力中…`;
        await writeProgress(env, sid, progress);
        return;
      }
      await setStep('deploy', 'done', progress.result.deployedNames.length + ' 個服務已部署' + fallbackNote);
      }
    } catch (e) {
      await fail('deploy', e);
      return;
    }
  }

  // --- e2. AI 工作流（graph_neighbors / rag_chat / rag_ingest_card）---------
  try {
    await setStep('workflows', 'running');
    const ns = suffix; // 用戶實例 namespace＝email 短碼（單租戶自足）

    // t147（07-29 leo 問「為什麼自己安裝沒有？別人裝會有嗎」——答：**別人裝也不會有**）：
    // 安裝器從未打 /init/seed，只打了 /portal/admin/bootstrap，
    // 而 bootstrap **需要 console owner session**（實測回 401「需要 console owner session」）
    // ⇒ 安裝當下沒登入態 ⇒ **triplet template 從來種不進去** ⇒ 三元組寫入 400
    // ⇒ 總圖永遠空白。這是**每個新用戶都會中**的 bug，不是 leo 實例特有。
    // /init/seed 不需 session、冪等（回 created/existing），是種 template 的正確入口。
    // 實測手動打一次即建立 triplet：{"created":["triplet"],"existing":[...]}。
    try {
      const seedRes = await fetch(`${workerUrl}/init/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Arcrun-API-Key': ns },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      const seedJson = await seedRes.json().catch(() => null);
      progress.result.seedTemplates = seedJson && seedJson.portal_templates
        ? seedJson.portal_templates
        : (seedRes.ok ? 'ok' : `HTTP ${seedRes.status}`);
    } catch (e) {
      progress.result.seedError = String((e && e.message) || e);
    }

    // D36 第2步：金鑰獨立寫入 kbdb/cypher 兩顆 worker（已不隨 code 上傳，見 deployBundledWorker）。
    // 順序重要：必須在 worker 部署完成之後（script 要先存在才寫得進 secret）。
    // 冪等：同名 secret 重寫即覆蓋；跳過部署的實例也會走到這裡 ⇒ 金鑰永遠同步。
    try {
      // t151 加入 arcrun-mcp：MCP 走 service binding 打 kbdb，但 kbdb 是 fail-closed
      // （t115：沒 token 一律 401），而 mcp/src/lib/kbdb-client.ts 是拿 env.KBDB_INTERNAL_TOKEN
      // 當 Bearer 送。⇒ **只補 service binding 的話，錯誤只會從 500 變成 401，工具還是不能用。**
      // 這裡沿用既有的 putWorkerSecretDirect（D36 認可的那條路），不另開第二套金鑰傳遞法。
      // 🔴 2026-08-10：這個迴圈**在今天以前每次都是失敗收場**，而且沒有任何一步會紅燈。
      //   `arcrun-mcp` 不在 bundle 清單裡 ⇒ 新用戶帳號裡沒有這顆 script ⇒
      //   `PUT /scripts/arcrun-mcp/secrets` 回 404 ⇒ 這裡 throw ⇒ 被下面的 catch 吃成
      //   `secretSyncError` 一行字（連 `secretsSynced` 都沒設成 true，也沒人在看）。
      //   kbdb 與 cypher 是因為排在迴圈前兩位才「剛好」拿到金鑰——**靠順序活著**。
      //   把 mcp 打進 bundle 之後這條路才第一次真的走得完。
      for (const sn of ['arcrun-kbdb', 'arcrun-cypher-executor', 'arcrun-mcp']) {
        await putWorkerSecretDirect(token, accountId, sn, 'KBDB_INTERNAL_TOKEN', kbdbToken);
      }
      // MCP_OWNER_SECRET 的下發已於 2026-08-10 拆除（見上方 ensureKbdbToken 下面那段說明）：
      // 新世代 /authorize 驗的是 Portal 帳密，沒有任何程式碼會讀那把值。
      progress.result.secretsSynced = true;
    } catch (e) {
      progress.result.secretSyncError = String((e && e.message) || e);
    }

    // D36 第1步（leo 07-29 拍板「安裝器代寫」）：把金鑰種進 credential 中心。
    // 種完後 workflow 只帶名稱 {{credential.kbdb_internal_token}}，執行期才由
    // auth_static_key WASM resolve_credentials 取值回填 ⇒ **祕密不落在 workflow 定義上**。
    // 這同時根治 t145：金鑰不再隨 code 上傳（差異更新跳過部署也不影響金鑰同步）。
    try {
      await seedCredential(token, accountId, dbId, ns, 'kbdb_internal_token', kbdbToken, 'kbdb', 'high');
      progress.result.credentialSeeded = true;
    } catch (e) {
      // 不擋安裝：種失敗就退回舊路（workflow 帶明文 token），但記下來讓驗收看得到。
      progress.result.credentialSeedError = String((e && e.message) || e);
    }

    // agent skills 種入（本班補洞）：裝完的實例 AI 要能 arcrun_get_skill 拿到
    // 「怎麼寫意圖工作流」等 playbook——過去從未 seed ⇒ 新裝封測者的 AI 拿不到 skill。
    // 放在 KBDB_INTERNAL_TOKEN 同步（上面 putWorkerSecretDirect）之後，cypher 代打才通。
    // 冪等（有就跳過），失敗不擋安裝但誠實記進 result 讓驗收看得到。
    try {
      progress.result.skills = await seedSkillsTo(workerUrl, ns);
      progress.updatedAt = Date.now();
      await writeProgress(env, sid, progress);
    } catch (e) {
      progress.result.skillsSeedError = String((e && e.message) || e);
    }
    const subs = {
      '__NAMESPACE__': ns,
      '__CYPHER_BASE__': workerUrl,
      // t143（07-29 事故）：workflow **不要直打 kbdb**——kbdb 自 t115 起要金鑰，
      // 而 workflow 的金鑰是安裝時寫死進 workflow 記錄的，一旦 kbdb worker 因差異更新被跳過
      // （env 還是舊金鑰）就對不上 ⇒ **所有工作流 401**（收卡、圖搜尋、AI 問答全掛）。
      // 改指向 cypher 的 kbdb 代打（/kbdb/*）：它用自己 env 的金鑰，永遠一致；
      // 認證用工作流本來就有的 X-Arcrun-API-Key。
      // t143 二修（leo 07-29：「不是應該像 n8n 那樣，金鑰都放在 credential 裡，
      // 任何人帶金鑰都只帶名稱，執行時才抓金鑰真身送出？因為文件數量大的時候，
      // 每一萃都是兩倍執行量」——**採納**：Arcrun 本來就有這機制（auth_static_key +
      // {{credential.NAME}}，graph-executor.ts:247 執行時解密回填）。
      // ⇒ 直打 kbdb（零跳數）＋祕密只存 credential 一份（不落在 workflow 定義）。
      '__KBDB_BASE__': `https://arcrun-kbdb.${progress.result.subdomain}.workers.dev`,
      '__KBDB_TOKEN__': kbdbToken,   // t115：workflow http_request 打 kbdb 帶此授權
      '__HTTP_REQ_URL__': `https://arcrun-http-request.${progress.result.subdomain}.workers.dev`,
      '__CODE_URL__': `https://arcrun-code.${progress.result.subdomain}.workers.dev`,
      '__LLM_MODEL__': 'gemma-4-31b-it',
      '__GEMINI_API_KEY__': '', // rag_chat 之後由設定精靈補 key；rag_ingest_card 零依賴
    };
    // t143 三修（07-29 實測）：**不能用 credential 種金鑰**——
    // `POST /credentials` 走 CF Secrets API，需要 CF_SECRETS_API_TOKEN + CF_ACCOUNT_ID，
    // 安裝器只有 OAuth token（非長存 API token）⇒ 實測 502「寫入路徑未就緒」。
    // ⇒ 維持 workflow 帶 __KBDB_TOKEN__（安裝時替換），但**金鑰已改為跟著實例走**（t141，
    // 存 INSTALLER_KV kbdbtok:<accountId>）⇒ 重裝不會產生新金鑰，不會再與 kbdb env 不同步。
    // leo 的 n8n 模式（credential 引用）是更好的目標，待 CF_SECRETS_API_TOKEN 就緒後再改
    // （記 pending-changes）。
    const pushed = [];
    // t136 二修（leo 07-29：youlin 卡在「安裝 AI 工作流」）：原本四條跑完才回寫一次進度，
    // 每條要打兩次 API（編圖＋部署），總時間可能超過 stall 門檻 ⇒ 正常執行被判死。
    // 改成**每條前後都回寫**，兼作心跳與可見進度。
    for (let wi = 0; wi < WORKFLOWS.length; wi++) {
      const wf = WORKFLOWS[wi];
      const sw = progress.steps.find((x) => x.id === 'workflows');
      if (sw) sw.note = `${wi + 1}/${WORKFLOWS.length}：${wf.name}`;
      progress.updatedAt = Date.now();
      await writeProgress(env, sid, progress);
      pushed.push(await pushWorkflowTo(workerUrl, ns, subs, wf));
      progress.result.workflows = pushed;
      progress.updatedAt = Date.now();
      await writeProgress(env, sid, progress);
    }
    const bad = pushed.filter((x) => !x.ok);
    progress.result.workflows = pushed;
    if (bad.length) {
      throw new InstallError(`有 ${bad.length} 條 AI 工作流沒裝成`, {
        hint: '請按「重新安裝」再試一次（已裝好的不會重複）。',
        detail: bad.map((b) => `${b.name}: ${b.error}`).join('; '),
      });
    }
    await setStep('workflows', 'done', `${pushed.length} 條工作流已就緒`);
  } catch (e) {
    await fail('workflows', e);
    return;
  }

  // --- f. 自檢 -------------------------------------------------------------
  try {
    await setStep('verify', 'running');
    if (workerUrl) {
      // 新 worker 的 workers.dev 網址要等 DNS 傳播，實測約 1-2 分鐘（不是幾秒）。
      // 舊版只重試 5 次 × 2 秒＝10 秒，必定過早判定失敗，害用戶拿到一個當下點不開的網址。
      // 改成最多約 3 分鐘：前 10 次間隔 3 秒（多數情況這裡就過了），之後間隔 10 秒。
      let lastErr = null;
      let ok = false;
      for (let i = 0; i < 26; i++) {
        try {
          // 加 10s timeout：health 若掛住，既餓死 progress 回寫又會誤觸 P0-3 stall 判死
          const res = await fetch(`${workerUrl}/health`, { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(10000) });
          const body = await res.json();
          progress.result.health = body;
          if (body && (body.ok || body.status === 'ok')) {
            ok = true;
            break;
          }
          lastErr = `健檢回報未通過：${JSON.stringify(body).slice(0, 300)}`;
        } catch (e) {
          lastErr = String((e && e.message) || e);
        }
        // 每輪都回寫進度，讓狀態頁能顯示「還在等生效」而不是靜止不動
        progress.result.verifyAttempt = i + 1;
        const vs = progress.steps.find((x) => x.id === 'verify');
        if (vs) vs.note = `等你的網址生效中…（第 ${i + 1} 次，新網址通常 1-2 分鐘）`;
        await writeProgress(env, sid, progress);
        // 長間隔切成 5 秒一段並回寫心跳，避免看起來靜止不動（也讓 stall 判定看得到活著）
        const waitMs = i < 10 ? 3000 : 10000;
        for (let w = 0; w < waitMs; w += 5000) {
          await new Promise((r) => setTimeout(r, Math.min(5000, waitMs - w)));
          progress.updatedAt = Date.now();
          await writeProgress(env, sid, progress);
        }
      }
      if (ok) {
        await setStep('verify', 'done', '一切正常');
      } else {
        // 自檢沒過不算致命 —— 資源都建好了，只是網址還沒生效。
        // 文案必須講清楚「這是正常的、要等、不是壞了」，否則用戶會以為安裝失敗。
        await setStep(
          'verify',
          'warn',
          '服務已經裝好了。網址第一次啟用需要幾分鐘才會生效，這是正常的——如果現在打不開，等一下再重新整理就好。'
        );
        progress.result.healthWarning = lastErr;
        progress.result.urlPending = true;
      }
    } else {
      await setStep('verify', 'warn', '沒有公開網址，略過線上檢查');
    }
  } catch (e) {
    await setStep('verify', 'warn', '檢查時發生問題，但你的服務已經建立完成');
    progress.result.healthWarning = String((e && e.message) || e);
  }

  progress.state = 'done';
  progress.currentStep = null;
  progress.finishedAt = Date.now();
  await writeProgress(env, sid, progress);
  await writeInstallLog(env, sid, progress); // t120
}

// ---------------------------------------------------------------------------
// 頁面
// ---------------------------------------------------------------------------

const SHARED_CSS = `
:root{
  /* Arcrun CIS token（arcrun-cis/README.md 唯一真相源，不自調色）。
     深色底＝預設：Ink 底／Paper 字／Relation(dark) 強調。 */
  --cis-ink:#17181A; --cis-paper:#FDFCFB; --cis-canvas:#F2F1ED;
  --cis-muted:#9A978F; --cis-relation:#B04A2F; --cis-relation-dark:#D9784F;
  --bg:var(--cis-ink); --panel:#1e1f22; --panel-2:#25262a; --line:#33343a;
  --text:var(--cis-paper); --muted:var(--cis-muted); --accent:var(--cis-relation-dark); --accent-2:#e89a72;
  --ok:#3ddc97; --warn:#ffd166; --err:#ff6b6b;
  --radius:14px;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:var(--cis-canvas); --panel:var(--cis-paper); --panel-2:#ebe9e4; --line:#dedbd3;
    --text:var(--cis-ink); --muted:var(--cis-muted); --accent:var(--cis-relation);
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;
  line-height:1.75; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:720px;margin:0 auto;padding:48px 20px 80px}
header.brand{display:flex;align-items:center;margin-bottom:40px}
/* CIS 橫式 lockup：24px＝UI header 尺寸。08-01 緊急修正：改用官方 PNG
   （WORDMARK_HTML，見上方常數註解——自產 SVG outline 字腔缺失作廢）。
   08-01 二次修正：官方原始 PNG（1840x560）畫布只有 32% 高度是實際字形，
   height:24px 時實際字高僅約 7.7px。改用裁淨版（493x88，長寬比 5.604:1，
   四邊已裁到字腔邊緣無留白），此時 height:24px＝實際字高 24px。
   本頁預設深色底（:root 無 media 時＝dark），light 是 override：
   dark 顯示 -paper-on-ink（淺字），light 顯示 -ink（深字）。
   本頁 wrap 寬 720px，屬「夠寬版面」——用橫式 lockup 當預設，不用方形 icon。 */
.lockup{display:inline-flex;align-items:center}
.lockup img{height:clamp(32px,8.5vw,48px);width:auto;display:block;max-width:100%}
.lockup .wm-ink{display:none}
.lockup .wm-paper{display:block}
@media (prefers-color-scheme: light){
  .lockup .wm-ink{display:block}
  .lockup .wm-paper{display:none}
}
h2{font-size:28px;line-height:1.4;margin:0 0 14px;font-weight:700}
p.lead{font-size:17px;color:var(--muted);margin:0 0 32px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin-bottom:20px}
.card h3{margin:0 0 14px;font-size:16px;font-weight:650}
ul.plain{list-style:none;padding:0;margin:0}
ul.plain li{padding:9px 0 9px 30px;position:relative;color:var(--muted)}
ul.plain li::before{content:"";position:absolute;left:6px;top:17px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
ul.plain li b{color:var(--text);font-weight:600}
label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}
.hint{font-size:13px;color:var(--muted);margin-top:8px}
input[type=text],input[type=email],input[type=password]{
  width:100%;padding:13px 15px;font-size:16px;border-radius:10px;
  border:1px solid var(--line);background:var(--panel-2);color:var(--text);
  font-family:inherit;
}
input[type=text]:focus,input[type=email]:focus,input[type=password]:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.btn{
  display:block;width:100%;text-align:center;text-decoration:none;
  padding:16px 20px;font-size:17px;font-weight:650;border:0;border-radius:12px;
  background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--cis-paper);
  cursor:pointer;font-family:inherit;transition:transform .12s ease,filter .12s ease;
}
.btn:hover{filter:brightness(1.07)}
.btn:active{transform:translateY(1px)}
.btn.secondary{background:transparent;border:1px solid var(--line);color:var(--text)}
details{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}
summary{cursor:pointer;font-size:14px;color:var(--muted);user-select:none}
summary:hover{color:var(--text)}
details pre{
  background:var(--panel-2);border:1px solid var(--line);border-radius:10px;
  padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;color:var(--muted);
}
footer{margin-top:44px;font-size:13px;color:var(--muted);text-align:center}
@media (max-width:520px){ .wrap{padding:32px 16px 60px} h2{font-size:23px} }
`;

function pageShell(title, bodyHtml, extraHead = '', env = null) {
  // 導覽列連結：env 有值就照該環境算（stage 導去 stage、prod 導去 prod）；
  // env 沒傳（少數呼叫端還沒線）就落回 prod 網址——與改動前行為一致，不會變更壞。
  // 「安裝」用相對路徑指自己，不管在哪個環境部署都對，不需要另開一個 var。
  const navSite = siteBase(env);
  const navDocs = docsBase(env);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${SHARED_CSS}</style>
${extraHead}
</head>
<body>
<style>
.xnav{position:sticky;top:0;z-index:99999;background:#17181A;border-bottom:1px solid rgba(253,252,251,.14)}
.xnav .xwrap{max-width:1100px;margin:0 auto;padding:.55rem 1.2rem;display:flex;gap:.4rem;align-items:center}
.xnav a{color:#FDFCFB;text-decoration:none;font-size:.95rem;font-weight:500;padding:.35rem .85rem;border-radius:.4rem;line-height:1.2;opacity:.78}
.xnav a:hover{opacity:1;background:rgba(253,252,251,.10)}
.xnav a.on{opacity:1;color:#FDFCFB;background:#B04A2F;font-weight:700}
body{margin-top:0 !important}
</style>
<nav class="xnav">
  <div class="xwrap">
    <a href="${navSite}/">首頁</a>
    <a href="/" class="on">安裝</a>
    <a href="${navDocs}/">📖 說明文件</a>
  </div>
</nav>
<div class="wrap">
  <header class="brand">
    <div class="lockup" role="img" aria-label="Arcrun 知識庫">${WORDMARK_HTML}</div>
  </header>
  ${bodyHtml}
  <footer>安裝過程中我們不會保存你的 Cloudflare 密碼，也不會讀取你既有的任何資料。</footer>
</div>
</body>
</html>`;
}

async function homePage(notice, env, release) {
  const stagingTag = env && env.DEPLOY_ENV === 'staging' ? '（測試站）' : '';
  // 2026-08-02：改用 manifest.release 這個單一真相源（例 `1.4.2`）。
  // leo：「不要這麼難懂的版本號，傳統數字顯示就好了」——舊的 `2026-07-31+8e83589`
  // 既難懂又會說謊（日期凍結、sha 用戶看不懂）。釘點短碼移到 title 供除錯，不佔版面。
  const bundleVer = String(release || '') + stagingTag;
  // 「技術細節」裡的安裝數量：從 manifest 動態算，見 manifestCountsOf() 檔頭病史
  // （arcrun-rag PR #89 教訓：手抄的數字會過期，這裡不准再手寫死一個。
  //  同日另一分支 fix/oauth-installer-worker-count 把 ×1 手改成 ×6——同一種錯，不採用）。
  const counts = await manifestCountsOf(env);
  const fmtCount = (n) => (n == null ? '讀不到（manifest 暫時抓不到）' : `×${n}`);
  const noticeHtml = notice
    ? `<div class="card" style="border-color:var(--err)"><h3 style="color:var(--err)">${escapeHtml(notice.title)}</h3><p style="margin:0;color:var(--muted)">${escapeHtml(notice.body)}</p></div>`
    : '';

  return pageShell(
    '安裝 Arcrun 知識庫',
    `
${noticeHtml}
<h2>把你的知識庫<br>裝到你自己的雲端空間</h2>
<p class="lead" style="margin-bottom:6px"><b>已經裝過的人也從這裡更新</b>（同一組 Email＋辨識碼，資料不會動到）。</p>
<p class="lead">不需要安裝任何軟體，也不需要懂技術。裝好之後，這套系統完全屬於你，資料只存在你自己的帳號裡。</p>

<div class="card">
  <h3>這一鍵會幫你做什麼</h3>
  <ul class="plain">
    <li><b>建立一個知識庫資料庫</b>——之後你的所有筆記與資料都存在這裡</li>
    <li><b>建立一個快取空間</b>——讓查詢跑得更快</li>
    <li><b>啟動你的專屬服務</b>——一個只有你能用的網址，裝好會直接給你</li>
    <li><b>自動做一次健康檢查</b>——確認每個部分都接好了才算完成</li>
  </ul>
</div>

<form class="card" method="GET" action="/auth/start">
  <label for="email">你登記用的 Email</label>
  <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" spellcheck="false" required>
  <div style="height:14px"></div>
  <label for="code">辨識碼</label>
  <!-- t154：required 拔掉——更新者（帳號已有部署紀錄）免碼，授權後自動核可 -->
  <input id="code" name="code" type="text" placeholder="例如 BLKYLR9M（更新可留空）" autocomplete="off" spellcheck="false">
  <p class="hint">填你登記那封信裡的 Email 和辨識碼——這是確認你有封測資格，不是要你的密碼。<b>已經裝過、回來更新？辨識碼可以留空</b>，我們認得你的帳號。</p>
  <!-- t153（leo 07-31：「要更新時已經距離申請一陣子了，誰知道辨識碼跑到哪裡去？」）：
       提示放在真的會缺的那個位置（07-27 鐵律）——就在辨識碼欄下方，不事先預告。
       同 email 重申請＝landing 冪等重寄同一組碼（handleRequestCode），這條路已實測走得通。 -->
  <p class="hint">找不到辨識碼？<a href="${siteBase(env)}" target="_blank" rel="noopener">重新申請一組</a>，用同一個 Email 就會把它再寄給你。</p>
  <div style="height:20px"></div>
  <!-- t133 三修（leo 07-29：「install.arcrun.dev 裡面的「開始安裝/更新」，
       也要把版本號寫在按鈕裡面，你只改了首頁」）：版本寫進按鈕本身，不另起一行。 -->
  <button class="btn" type="submit" title="釘點 ${escapeHtml(bundleCommitOf(env))}／建置 ${escapeHtml(bundleBuiltOf(env))}／安裝器 ${escapeHtml(INSTALLER_PATCH)}">開始安裝／更新<span style="opacity:.75;font-size:12px;font-weight:400;margin-left:8px">版本：${escapeHtml(bundleVer)}</span></button>
  <p class="hint" style="text-align:center;margin-top:8px">第一次裝、或要更新到最新版，都是按這裡。</p>
  <p class="hint" style="text-align:center;margin-top:14px">按下後會跳到 Cloudflare 的官方頁面請你確認授權，確認完會自動跳回來。</p>
</form>

<div class="card" id="update-card">
  <h3>已經裝過了？想更新到最新版</h3>
  <p style="margin:0 0 12px;color:var(--muted);font-size:14px">
    用<b>同一組 Email 和辨識碼</b>再跑一次上面的流程就會更新——
    系統會沿用你原本的資料庫，<b>資料、帳號、已同步的檔案都不會動到</b>，
    只把程式換成最新版。
  </p>
  <p style="margin:0;color:var(--muted);font-size:14px">
    什麼時候需要更新？<b>我們修好了某個問題、但你這邊還是舊的樣子</b>時
    （例如畫面上少了某個按鈕、某個功能存不進去）。
  </p>
</div>

<details>
  <summary>技術細節（給工程師看的）</summary>
  <pre>授權方式：OAuth 2.0 authorization_code + PKCE (S256)，public client 無 secret
授權範圍：workers-scripts.write / workers-kv-storage.write / d1.write /
          vectorize.write / account-settings.read / offline_access
安裝內容：Workers script ${fmtCount(counts.workerCount)}、KV namespace ${fmtCount(counts.kvCount)}、
          D1 database ${fmtCount(counts.d1Count)}（含 migration）
          ↑ 這三個數字現在讀當前 bundle manifest 現算，manifest 加減零件會自動跟著變，
            不是寫死的（此頁曾把它寫死成固定數字，那個做法已經不用了）
辨識碼閘：/auth/start 先向 landing /api/verify-code 驗 {email, code}，通過才進 OAuth
資源沿用：你已經裝過的東西（快取空間／資料庫）一律直接沿用、不會被砍掉重建——
          判準是「這顆服務現在實際綁的是哪一個」，不是看名字對不對得上；
          只有確定你完全還沒裝過任何東西時才會新建，新建才用
          arcrun-rag-&lt;email 推導 8 碼&gt; 這個名字（見 shared/resource-rule/，PR #87）
安裝器版本：${escapeHtml(INSTALLER_PATCH)}（這頁本身的邏輯版本，只有改本安裝器程式碼才會動；
          與上面「版本：${escapeHtml(bundleVer)}」是兩件事——那個是零件包版本，
          零件沒動、只改安裝器邏輯時，只有這個數字會變）
bundle 依據：建置日 ${escapeHtml(bundleBuiltOf(env))}／釘點 ${escapeHtml(bundleCommitOf(env))}
token 保存：access_token 存在本安裝器的 KV，隨 session 過期自動清除；
          refresh_token 為 rotation 制，每次更新都會寫回新的一把</pre>
</details>
`,
    '',
    env
  );
}

function installPage(env) {
  return pageShell(
    '正在安裝…',
    `
<h2 id="title">正在為你安裝</h2>
<p class="lead" id="subtitle">請不要關閉這個頁面，好了會直接顯示你的網址。</p>

<div class="card">
  <ul class="plain" id="steps">
    <li>正在準備…</li>
  </ul>
</div>

<div id="result"></div>
<div id="error"></div>
`,
    `<style>
#steps li{padding-left:34px;transition:color .2s}
#steps li::before{content:"";left:6px;top:16px;width:9px;height:9px;border:2px solid var(--line);background:transparent;border-radius:50%}
#steps li[data-state=running]{color:var(--text)}
#steps li[data-state=running]::before{border-color:var(--accent);background:var(--accent);animation:pulse 1s ease-in-out infinite}
#steps li[data-state=done]{color:var(--text)}
#steps li[data-state=done]::before{border-color:var(--ok);background:var(--ok)}
#steps li[data-state=warn]::before{border-color:var(--warn);background:var(--warn)}
#steps li[data-state=error]{color:var(--err)}
#steps li[data-state=error]::before{border-color:var(--err);background:var(--err)}
#steps .note{display:block;font-size:13px;color:var(--muted);margin-top:2px}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.75)}}
.url-box{
  background:linear-gradient(135deg,rgba(176,74,47,.14),rgba(217,120,79,.08));
  border:1px solid var(--accent);border-radius:var(--radius);
  padding:26px;text-align:center;margin-bottom:20px;
}
.url-box .cap{font-size:14px;color:var(--muted);margin:0 0 12px}
.url-box a{
  display:inline-block;font-size:19px;font-weight:700;color:var(--accent);
  text-decoration:none;word-break:break-all;line-height:1.5;
}
.url-box a:hover{text-decoration:underline}
.copy{margin-top:16px;font-size:14px;padding:10px 18px;border-radius:9px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer;font-family:inherit}
.err-card{background:var(--panel);border:1px solid var(--err);border-radius:var(--radius);padding:24px;margin-bottom:20px}
.err-card h3{color:var(--err);margin:0 0 10px;font-size:17px}
</style>`,
    env
  );
}

// 進度頁的前端腳本（分開放，避免 template 字串巢狀太亂）
const INSTALL_SCRIPT = `
const stepsEl = document.getElementById('steps');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');
const resultEl = document.getElementById('result');
const errorEl = document.getElementById('error');

let stopped = false;
let failures = 0;
let channelWarned = false; // t157：雙通道互蓋警告只插一次
var forceMode = new URLSearchParams(window.location.search).get('force') === '1';

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// t28b 門面順修①：後端 STEPS 的白話標籤鏡像一份在前端當保底——server 正常都會帶
// error.stepLabel，這裡只在極端情況（例如帶了 error.step 卻沒帶 stepLabel）接住，
// 不讓「部署你的專屬服務」這類使用者看得懂的字掉成「未知步驟」。
const STEP_LABELS = {
  account: '確認你的 Cloudflare 帳號',
  cache: '建立快取空間',
  database: '建立知識庫資料庫',
  schema: '建立資料表結構',
  deploy: '部署你的專屬服務',
  workflows: '安裝 AI 工作流',
  verify: '自我檢查',
};

// t28b 門面順修②：技術細節摺疊框過去直接吃 e.detail || ''——detail 若是空字串/undefined
// 就整塊 <pre> 視覺全空白，用戶會以為「這裡本來就沒東西/壞了」。改成明確佔位文字，
// 也順手接住 detail 不是字串（物件/陣列）的情況，不會安靜漏字。
function fmtDetail(d){
  if (d === undefined || d === null || d === '') return '（沒有更多技術細節）';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d, null, 2); } catch (e) { return String(d); }
}

function renderSteps(steps){
  stepsEl.innerHTML = steps.map(function(s){
    var note = s.note ? '<span class="note">' + esc(s.note) + '</span>' : '';
    return '<li data-state="' + esc(s.state) + '">' + esc(s.label) + note + '</li>';
  }).join('');
}

function renderDone(p){
  titleEl.textContent = '安裝完成';
  subEl.textContent = '你的知識庫已經準備好了。';
  var r = p.result || {};
  var html = '';

  if (r.url) {
    html += '<div class="url-box">'
      + '<p class="cap">這是你的專屬網址，請把它收藏起來</p>'
      + '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" id="inst-url">' + esc(r.url) + '</a>'
      + '<div><button class="copy" id="copy-btn">複製網址</button></div>'
      + '</div>';
    // #45（2026-08-09）：**裝到哪個帳號要看得見**。以前只藏在下面「技術細節」的 JSON 裡，
    // 等於選錯了也看不出來——而多帳號的人挑錯就是整套裝到別台。
    // 這不違 t79「完成頁只給網址」：t79 拔掉的是「之後還要做的事」那類卡（該去 portal），
    // 這一行講的是**這次安裝本身的結果**，跟版本號同一性質、同一個位置。
    var extras = [];
    if (r.accountName) extras.push('裝在你的 Cloudflare 帳號：' + esc(r.accountName));
    var bv = r.health && r.health.bundle_version;
    if (bv) extras.push('版本：' + esc(bv));
    if (extras.length) {
      html += '<p style="text-align:center;color:var(--muted);font-size:13px;margin:-10px 0 20px">'
        + extras.join('<br>') + '</p>';
    }
  } else if (r.urlNote) {
    html += '<div class="card"><h3>關於你的網址</h3><p style="margin:0;color:var(--muted)">' + esc(r.urlNote) + '</p></div>';
  }

  // t152（leo 07-31 原話「現在立刻拿掉這一塊」）：t151 曾在此顯示 MCP 屋主密碼卡＝
  // **又一次違反 t79「完成頁只給網址」**（同類第 3 次：t76 下載小幫手卡→t151 密碼卡→本次拔）。
  // 且密碼已作廢——b8ca98c 起 MCP 認證改 portal 帳密（daa047a bundle 即新版），用戶不需要這串。
  // 🔴 2026-08-10 更新：後端那半（ensureMcpOwnerSecret＋putWorkerSecretDirect）**也拆掉了**。
  // 上面那句「舊實例仍讀 MCP_OWNER_SECRET」在 arcrun-mcp 進 bundle 之後失效——
  // 安裝器本身就是把舊實例升級成新世代的那個動作。詳見 runInstall 內的說明。

  // t79（leo 2026-07-28 定調）：**安裝完成頁只給網址，其餘一律不放**。
  // leo 原話：「建立你的帳號、下載同步小幫手、接下來可以做什麼**都是在 portal 做**，
  //           **安裝到顯示連結就完畢了**」。
  // 為什麼：安裝器是**一次性**的，portal 是**常駐**的。把「之後還要做的事」放在一次性頁面，
  // 使用者關掉就再也找不到；放 portal 才會在他需要時就在那裡。
  // ⚠️ 我 07-28 曾在此加「下載同步小幫手」卡（t76）＝**加錯地方**，本次一併移除。
  // 職責邊界見 system-dev/docs/4-guides/install-flow-map.md §3。
  // ⚠️ 本檔在 template literal 內，註解**不可用反引號**（會提早結束字串→esbuild 語法錯，
  //    但 node --check 抓不到，只有 wrangler deploy 才會爆）。

  var detail = {
    帳號: r.accountName,
    知識庫資料庫: r.databaseName,
    快取空間: r.cacheName,
    服務名稱: r.scriptName,
    健檢結果: r.health,
    健檢提醒: r.healthWarning
  };
  html += '<details><summary>技術細節（給工程師看的）</summary><pre>'
    + esc(JSON.stringify(detail, null, 2)) + '</pre></details>';

  resultEl.innerHTML = html;

  var btn = document.getElementById('copy-btn');
  if (btn) {
    btn.addEventListener('click', function(){
      var u = document.getElementById('inst-url').textContent;
      navigator.clipboard.writeText(u).then(function(){
        btn.textContent = '已複製';
        setTimeout(function(){ btn.textContent = '複製網址'; }, 1800);
      }).catch(function(){
        btn.textContent = '請手動選取複製';
      });
    });
  }

  // t152：MCP 密碼卡的複製鈕已隨卡一併移除（t79：完成頁只給網址）。

  // t79：建立帳號的事件處理器已隨那張卡一起移除——**建帳號在 portal 做**。
  // 下載同步小幫手 config.json：純前端從安裝結果組 data URL，內容不經伺服器
  // t75 ③：config.json 下載的事件處理器已隨那張卡一起移除（HTML 沒了它就是死代碼，
  // 留著會讓後人以為那個功能還在——見 mistakes「死代碼＝錯誤環境信號」）。
}

function renderError(p){
  titleEl.textContent = '安裝沒有完成';
  subEl.textContent = '別擔心，沒有造成任何損害。下面是發生的狀況。';
  var e = p.error || {};
  errorEl.innerHTML =
    '<div class="err-card">'
    + '<h3>卡在這一步：' + esc(e.stepLabel || STEP_LABELS[e.step] || '未知步驟') + '</h3>'
    + '<p style="margin:0 0 12px">' + esc(e.message || '發生了預期外的錯誤') + '</p>'
    + '<p style="margin:0;color:var(--muted)"><b>可以怎麼辦：</b>' + esc(e.hint || '請再試一次。') + '</p>'
    + '<div style="height:18px"></div>'
    // #45：錯誤自帶出路時（例如「還沒選帳號」），那顆按鈕排第一——
    // 它才是真正的解法，「重新安裝」在這種錯上只會再撞同一面牆。
    + (e.action && e.action.href
        ? '<a class="btn" href="' + esc(e.action.href) + '">' + esc(e.action.label || '繼續') + '</a>'
          + '<div style="height:10px"></div>'
        : '')
    + '<button class="btn' + (e.action ? ' secondary' : '') + '" id="retry-btn">重新安裝</button>'
    + '<div style="height:10px"></div>'
    + '<a class="btn secondary" href="/">回到首頁重新連結帳號</a>'
    + '<details><summary>技術細節（回報問題時請附上這段）</summary><pre>' + esc(fmtDetail(e.detail)) + '</pre></details>'
    + '</div>';

  var rb = document.getElementById('retry-btn');
  if (rb) rb.addEventListener('click', function(){
    rb.disabled = true;
    rb.textContent = '重新開始中…';
    start(true);
  });
}

// t26 分批安裝接力：runInstall 每輪最多裝幾顆／跑幾秒就會停手存游標
// （state 變 paused_continue，不是 error）。前端看到就自動再打一次
// /api/install/start 接著裝，用戶完全不用手動按任何東西。
var continuing = false;
let lastSig = '';
let lastProgressAt = Date.now();
async function continueInstall(){
  if (continuing) return;
  continuing = true;
  try {
    const r = await fetch('/api/install/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restart: false })
    });
    // 讀串流到結束＝保持連線讓後端跑完（t138）
    if (r.body) { const rd = r.body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; } }
  } catch (e) { /* 打失敗也沒關係，下一輪 poll 還會再觸發一次 */ }
  finally { continuing = false; }
}

async function poll(){
  if (stopped) return;
  try {
    const res = await fetch('/api/install/status', { cache: 'no-store' });
    if (res.status === 401) {
      stopped = true;
      titleEl.textContent = '需要重新連結帳號';
      subEl.textContent = '你的授權已經過期或找不到了。';
      errorEl.innerHTML = '<div class="err-card"><h3>請重新開始</h3><p style="margin:0 0 16px;color:var(--muted)">回到首頁重新連結一次 Cloudflare 帳號就可以了。</p><a class="btn" href="/">回到首頁</a></div>';
      return;
    }
    const p = await res.json();
    failures = 0;
    // t157：同帳號另一通道（staging↔prod）已裝過 → 進度頁頂部黃卡告知（不擋安裝）
    if (p.channelWarning && !channelWarned) {
      channelWarned = true;
      errorEl.innerHTML = '<div class="err-card" style="border-color:var(--warn)">'
        + '<h3 style="color:var(--warn)">換版本提醒</h3>'
        + '<p style="margin:0;color:var(--muted)">' + esc(p.channelWarning) + '</p></div>'
        + errorEl.innerHTML;
    }
    if (p.steps) renderSteps(p.steps);
    if (p.state === 'done'){ stopped = true; renderDone(p); return; }
    if (p.state === 'error'){ stopped = true; renderError(p); return; }
    if (p.state === 'paused_continue'){
      // 分批安裝中——這是正常的（避免用完你帳號這一輪的限額），馬上自動接著裝
      subEl.textContent = '還在裝，請不要關閉這個頁面。';
      lastProgressAt = Date.now();
      continueInstall();
    } else if (p.state === 'running') {
      // t137 五修（leo：「第一個連閃橘色都沒有」＝後端被硬砍、狀態停在 running，
      // 前端只認 paused_continue 才接力 ⇒ 等一個永遠不會來的 done）。
      // 治本：**前端自己判斷「太久沒進展就主動接力」**，不依賴後端把狀態設對。
      const sig = JSON.stringify(p.steps ? p.steps.map(function(x){ return x.state + (x.note || ''); }) : []);
      if (sig !== lastSig) { lastSig = sig; lastProgressAt = Date.now(); }
      else if (Date.now() - lastProgressAt > 25000) {
        // 25 秒沒有任何步驟變化 ⇒ 上一輪多半被 waitUntil 砍掉了，主動再踢一次
        subEl.textContent = '還在裝，請不要關閉這個頁面。';
        lastProgressAt = Date.now();
        continueInstall();
      }
    }
  } catch (e) {
    failures++;
    if (failures >= 8){
      // t156（07-31 leo 用餐回來實錄）：連敗多半是電腦休眠/網路暫斷。
      // 舊行為＝stopped:true 永久凍結＋「網路好像斷了，請重新整理」誤導文案
      // （網路沒斷、也不用重新整理——接力只是需要頁面活著）。
      // 新行為＝**不停止**，講真話＋降頻（5s）續試；連線恢復（failures 歸零）就自動接關。
      subEl.textContent = '連線暫時中斷（可能是電腦休眠或網路不穩）。安裝需要這個頁面保持開啟；連線恢復後會自動從上次進度續跑，已裝好的不會重裝。';
      setTimeout(poll, 5000);
      return;
    }
  }
  setTimeout(poll, 1500);
}

async function start(retry){
  stopped = false;
  failures = 0;
  errorEl.innerHTML = '';
  resultEl.innerHTML = '';
  titleEl.textContent = '正在為你安裝';
  subEl.textContent = '請不要關閉這個頁面，好了會直接顯示你的網址。';
  try {
    // t138：後端改成 streaming（安裝在「請求生命週期」內跑完，牆鐘無限）。
    // 這裡**不能 await**——要讓連線一直開著（那就是保命繩），同時往下走去啟動輪詢顯示進度。
    // 連線若被關（用戶關頁面），後端也會跟著結束，下次重按會從 KV 的斷點接續。
    fetch('/api/install/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restart: !!retry, force: forceMode || !!retry })
    }).then(function (r) {
      // 讀完串流才算結束（心跳點點點＋最後的 done）；讀取本身就是「保持連線」的動作。
      if (r.body) { const rd = r.body.getReader(); (function pump(){ rd.read().then(function(x){ if(!x.done) pump(); }).catch(function(){}); })(); }
    }).catch(function () { /* 斷線由輪詢的停滯偵測接手 */ });
  } catch (e) { /* 失敗也照樣輪詢，狀態頁會反映 */ }
  poll();
}

start(false);
`;

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export default {
  // t156 正解（leo 07-31「用餐離開＝安裝凍結」）：**伺服器端自續**——cron 每 2 分鐘掃
  // 自家 INSTALLER_KV 的進行中安裝，paused_continue（或 running 停滯逾 STALL_MS）就代替
  // 前端接力續跑一輪。頁面接力仍是主路徑（快）；cron 是保底（頁面關了安裝照樣走完）。
  // 紅線核對：掃的是**自己 worker 的 KV**（CF 內部），非 GitHub 輪詢（D20 管的是那個）。
  // 牆鐘：cron scheduled 可跑到 15 分鐘 wall，一輪 budget（3 顆）綽綽有餘。
  async scheduled(event, env, ctx) {
    const list = await env.INSTALLER_KV.list({ prefix: 'prog:' });
    for (const k of list.keys) {
      const sid = k.name.slice('prog:'.length);
      let progress;
      try { progress = await env.INSTALLER_KV.get(k.name, 'json'); } catch { continue; }
      if (!progress) continue;
      const stalledRunning = progress.state === 'running'
        && Number(progress.updatedAt || 0) > 0 && Date.now() - Number(progress.updatedAt) > STALL_MS;
      if (progress.state !== 'paused_continue' && !stalledRunning) continue;
      // 防重入：同 sid 5 分鐘內只有一個 cron 續跑者（前端接力同時打也只是 alreadyRunning 級碰撞）
      const lockKey = `cronlock:${sid}`;
      if (await env.INSTALLER_KV.get(lockKey)) continue;
      await env.INSTALLER_KV.put(lockKey, String(Date.now()), { expirationTtl: 300 });
      try {
        // session 還在才續（token 在 sess 裡；過期就沒得續，留給用戶重走 OAuth）
        const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
        if (!sess) continue;
        progress.error = null;
        progress.state = 'running';
        progress.updatedAt = Date.now();
        await writeProgress(env, sid, progress);
        await runInstall(env, sid, progress, false);
      } catch (_) { /* 這輪失敗＝下輪 cron 再試；progress 內已有各步狀態 */ }
      finally {
        try { await env.INSTALLER_KV.delete(lockKey); } catch (_) { /* TTL 兜底 */ }
      }
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 品牌 icon（照抄 landing/worker.js 既有寫法）：放在 INSTALLER_KV 檢查之前，
    // 圖示不該依賴任何 binding 才能回應。
    if (pathname === "/logo.svg" || pathname === "/favicon.svg") {
      return new Response(LOGO_SVG, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }
    if (pathname === "/favicon.ico") {
      return new Response(b64ToBytes(FAVICON_ICO_B64), {
        headers: {
          "content-type": "image/x-icon",
          "cache-control": "public, max-age=86400",
        },
      });
    }
    if (pathname === "/apple-touch-icon.png" ||
        pathname === "/apple-touch-icon-precomposed.png") {
      return new Response(b64ToBytes(APPLE_ICON_B64), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (!env.INSTALLER_KV) {
      return html(
        pageShell(
          '安裝器尚未設定完成',
          `<h2>安裝器還沒設定好</h2><p class="lead">系統管理員需要先完成設定才能開始安裝。</p>
           <details open><summary>技術細節</summary><pre>缺少 KV binding：INSTALLER_KV
請在 wrangler.toml 填入實際的 namespace id 後重新部署。</pre></details>`,
          '',
          env
        ),
        500
      );
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /':
          return handleHome(request, env, url);
        case 'GET /auth/start':
          return handleAuthStart(request, env, url);
        case 'GET /auth/callback':
          return handleAuthCallback(request, env, url);
        case 'GET /install':
          return handleInstallPage(request, env);
        case 'GET /install.js':
          return new Response(INSTALL_SCRIPT, {
            headers: {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'no-store',
            },
          });
        case 'GET /api/latest':
        case 'OPTIONS /api/latest':
          return handleLatest(request, env);
        case 'GET /download/win':
          return handleDownload(env, 'win');
        case 'GET /download/mac':
          return handleDownload(env, 'mac');
        case 'POST /api/install/start':
          return handleInstallStart(request, env, ctx);
        case 'GET /api/install/status':
          return handleInstallStatus(request, env);
        case 'POST /api/setup-account':
          return handleSetupAccount(request, env);
        case 'GET /admin/logs':
          return handleAdminLogs(request, env, url);
        default:
          if (url.pathname === '/healthz') return json({ ok: true });
          return html(
            pageShell(
              '找不到這個頁面',
              `<h2>找不到這個頁面</h2><p class="lead">你可能點到過期的連結了。</p><a class="btn" href="/">回到安裝首頁</a>`,
              '',
              env
            ),
            404
          );
      }
    } catch (e) {
      // 最外層兜底：不讓任何未預期錯誤變成裸 500
      return html(
        pageShell(
          '發生預期外的錯誤',
          `<h2>發生了預期外的錯誤</h2>
           <p class="lead">很抱歉，安裝器本身出了狀況。你的 Cloudflare 帳號沒有受到任何影響。</p>
           <a class="btn" href="/">回到安裝首頁重新開始</a>
           <details><summary>技術細節（回報問題時請附上這段）</summary><pre>${escapeHtml(
             (e && e.stack) || String(e)
           )}</pre></details>`,
          '',
          env
        ),
        500
      );
    }
  },
};

// --- t120 安裝 log ----------------------------------------------------------

/** 安裝完成或失敗時寫一筆紀錄到 INSTALLER_KV（TTL 90 天），供 GET /admin/logs 查閱。不記 token/secret。 */
async function writeInstallLog(env, sid, progress) {
  try {
    const now = Date.now();
    const key = 'log:' + now + '-' + sid.slice(0, 6);
    const r = progress.result || {};
    const record = {
      at: now,
      sid: sid.slice(0, 6),
      email: r.email || null,
      accountId: r.accountId || null,
      subdomain: r.subdomain || null,
      state: progress.state,
      failedStep: progress.error ? progress.error.step : null,
      errorMessage: progress.error ? progress.error.message : null,
      errorDetail: progress.error ? String(progress.error.detail || '').slice(0, 500) : null,
      deployedCount: Array.isArray(r.deployedNames) ? r.deployedNames.length : 0,
      durationMs: (progress.startedAt && progress.finishedAt) ? (progress.finishedAt - progress.startedAt) : null,
      bundleBase: r.bundleBase || null,
    };
    await env.INSTALLER_KV.put(key, JSON.stringify(record), { expirationTtl: 90 * 86400 });
  } catch (_) { /* log 寫入失敗不炸安裝 */ }
}

/** GET /admin/logs?key=<ADMIN_LOG_KEY>：列最近 50 筆安裝紀錄（JSON）。env 未設 ADMIN_LOG_KEY 回 404。 */
/**
 * 🆕 GET /api/latest — 對外公開的「最新版是幾號」（2026-08-02）
 *
 * 誰在用：
 *   ① portal（用戶實例的側邊欄）── 比對自己的版本，落後就亮紅點＋給一鍵更新
 *   ② rag.arcrun.dev 行銷頁 ────── 取代原本手抄在 wrangler.toml 的 SITE_BUNDLE_VERSION
 * ⇒ 這支是「最新版」這個事實的**唯一對外出口**，兩邊都讀它，不再各抄一份。
 *
 * CORS：必須開放（portal 跑在用戶自己的 workers.dev 子網域，屬跨來源）。
 * 這裡只吐公開資訊（版本號／釘點／建置日），無敏感資料，故 `*` 即可。
 */
/**
 * handleDownload — 從**我們自己的網域**把安裝檔送出去。
 *
 * 🔴 為什麼要有這條（leo 2026-08-06 封測回報：「Windows 用戶說 exe 檔直接無法下載」）
 *    原本下載鈕直接指向 `raw.githubusercontent.com/...`，這在兩種情況會死：
 *      ① **企業網路／部分電信擋掉 githubusercontent 網域**——連線根本不成立，
 *         使用者看到的是「一直轉圈」或「無法連線」，完全猜不到是網域被擋。
 *      ② 瀏覽器對「陌生網域來的未簽章 exe」更敏感（Chrome 的「無法安全地下載」）。
 *    走自家網域解掉①，並讓②的來源至少是使用者剛剛才互動過的同一個網站。
 *    （SmartScreen 那一關**解不掉**——那要買簽章憑證或上 Store，見 docs/store-submission.md。）
 *
 * 設計要點：
 *   · 檔案來源仍是**釘住的那個 commit**（與 /api/latest 同一個真相源），不另立第二條路徑
 *   · `content-disposition: attachment` 帶正確檔名 ⇒ 使用者存下來就是 `Arcrun-win-v0.18.8.exe`
 *   · 串流轉發（直接傳 upstream 的 body），不在 Worker 裡緩衝 26MB
 *   · 失敗時給**人話**，不是裸 500——這條路一旦壞掉，使用者是完全裝不了的
 */
async function handleDownload(env, os) {
  const daemon = await daemonOf(env);
  const url = daemon && daemon.downloads && daemon.downloads[os];
  if (!url) {
    return html(
      pageShell(
        '暫時拿不到安裝檔',
        `<h2>暫時拿不到安裝檔</h2>
         <p class="lead">安裝檔的清單讀取失敗了，通常過幾分鐘就會恢復。</p>
         <a class="btn" href="/">回到安裝首頁</a>`,
        '',
        env
      ),
      503
    );
  }
  const upstream = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!upstream.ok) {
    return html(
      pageShell(
        '安裝檔下載失敗',
        `<h2>安裝檔下載失敗</h2>
         <p class="lead">來源回應 ${upstream.status}。請稍後再試一次。</p>
         <a class="btn" href="/">回到安裝首頁</a>`,
        '',
        env
      ),
      502
    );
  }
  const filename = url.split('/').pop();
  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': upstream.headers.get('content-length') || '',
      // 檔名帶版本號 ⇒ 內容不會變 ⇒ 可以放心長快取
      'cache-control': 'public, max-age=86400',
      'x-arcrun-daemon-version': (daemon && daemon.version) || '',
    },
  });
}

async function handleLatest(request, env) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const release = await releaseOf(env);
  const daemon = await daemonOf(env);
  return new Response(JSON.stringify({
    release,                              // 例 "1.4.2" ← 用戶看到、拿來比對的就是這個
    pin: bundleCommitOf(env),             // 釘點短碼（除錯用，用戶不必看懂）
    built: bundleBuiltOf(env),            // 建置日（除錯用）
    // 🔴 2026-08-06 新增（leo：「Portal 和 rag.arcrun.dev 應該顯示同步器的版本⋯⋯
    //    因為你說最新 0.18.5 **連我都沒辦法確認**，所以用戶到底是否最新版他自己也不知道」）
    //    release（雲端知識庫）與 daemon（桌面同步器）是**兩條版本線**；
    //    以前只吐前者 ⇒ 用戶手上那支同步器新不新，全站沒有任何地方看得出來。
    daemon,                               // { version, notes, downloads: { mac, win } }
    install_url: 'https://install.arcrun.dev/',
    // 🔴 2026-08-13（arcrun-rag#95）：出貨線的「線上已是這版就不重推」判準，以前只比
    //   release／pin（bundle 內容），對**這個 worker 自己的原始碼**是隱形的——改了安裝
    //   器邏輯、bundle 沒動，管線就判「沒變」跳過部署，改動永遠送不出去。
    //   這裡把安裝器原始碼的內容指紋也吐出來，讓 ship.mjs 能拿它跟這次要出的那份比對，
    //   不吻合就強制重部署。值由部署腳本注入（env.INSTALLER_SRC_SHA），不落地也不影響行為。
    installer_sha: (env && env.INSTALLER_SRC_SHA) ? String(env.INSTALLER_SRC_SHA) : null,
  }), {
    headers: {
      ...cors,
      'content-type': 'application/json; charset=utf-8',
      // 5 分鐘：出貨後用戶最多 5 分鐘內就會看到新版提示，又不會把安裝器打爆
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * 🆕 桌面同步器（daemon）的版本與下載網址（2026-08-06）。
 *
 * 與 releaseOf 同一個原則、同一份真相源：**只讀釘點 manifest，不留手抄本**
 * （08-02 的教訓：同一個事實有三份手抄本，換釘子時必漏改）。
 * 差別只在讀的是 `manifest.daemon` 而非 `manifest.release`。
 *
 * 下載網址走 **raw.githubusercontent**，與 selfupdate.go:158 同源——那裡寫得很清楚：
 * `@main` 的 jsDelivr ref 解析會卡住抓到舊檔（08-04 撞過，更新永遠失敗且靜默），
 * 且 Mac 產物曾大於 jsDelivr 單檔 20MB 上限。**不要在這裡自創第二條下載路徑。**
 * 用釘點 sha（非 @main）⇒ 免疫 CDN 與 ref 快取，下載到的必然是這一版。
 *
 * 🔴 2026-08-08 修（stage 實測撞到，`git log -S"daemonOf"` 查過，是 08-06 引入以來
 * 沒人動過的原始寫法，非別分支已修好又被我改壞）：上面理由只講對了 **prod**——prod 的
 * `bundleBase` 是 jsDelivr `@sha`，jsDelivr 不能直接放大檔，才需要換去
 * raw.githubusercontent.com。但 **staging 的 `bundleBase` 本來就是可以直接讀檔的
 * Gitea raw root**（`.../raw/commit/<sha>`，見 wrangler.toml `[env.staging]`），
 * 舊寫法卻無條件把抓到的 sha 塞進 `raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/`
 * ⇒ 對 staging 而言那是**別的 repo**（prod GitHub），該 sha 在那裡不存在
 * ⇒ 下載鈕在 stage 上 100% 502（`/api/latest` 實測抓到）。
 * 修法：只有偵測到 prod 的 jsDelivr `@sha` 格式才換宿主去 raw.githubusercontent；
 * 其餘（staging／任何 env.BUNDLE_BASE 覆蓋）直接用 `base` 本身當下載來源——
 * 來源與 manifest 讀的是同一個 base，沒有另立第二條路徑。
 */
async function daemonOf(env) {
  const base = bundleBase(env);
  // cacheKey 帶版本後綴（v2）＝這次修 routing bug 的一次性 cache-buster——
  // Cache API 的內容存在邊緣節點，**不會**因為重新 deploy 就失效，舊 key 底下
  // 還卡著修復前的錯誤 JSON（24h TTL）。換一個新 key 保證這次部署後立刻是 cache miss。
  const cacheKey = new Request(`https://internal.arcrun/daemon?v=2&base=${encodeURIComponent(base)}`);
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch { /* caches 不可用（本機測試）就直接抓 */ }

  let out = null;
  try {
    const r = await fetch(base + '/manifest.json', { cf: { cacheTtl: 86400 } });
    if (r.ok) {
      const m = await r.json();
      const d = m && m.daemon;
      if (d && d.version) {
        // prod 的 DEFAULT_BUNDLE_BASE 是 jsDelivr `@sha` 格式——只有這種才需要換宿主。
        // staging／其他 env.BUNDLE_BASE 覆蓋（如 Gitea `/raw/commit/<sha>`）本身就是可讀的
        // raw root，直接用 base，不再誤指去 prod 的 GitHub repo。
        const jsDelivrSha = (base.match(/@([0-9a-f]{7,40})/) || [])[1];
        const raw = jsDelivrSha
          ? `https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/${jsDelivrSha}/`
          : base + '/';
        out = {
          version: String(d.version),
          notes: d.notes ? String(d.notes) : '',
          downloads: {
            mac: d.mac && d.mac.file ? raw + d.mac.file : null,
            win: d.win && d.win.file ? raw + d.win.file : null,
          },
        };
      }
    }
  } catch { /* 抓不到就回 null，前端自己處理「暫時查不到」 */ }

  if (out) {
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(out), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
      }));
    } catch { /* 存不進快取不影響正確性 */ }
  }
  return out;
}

async function handleAdminLogs(request, env, url) {
  const adminKey = url.searchParams.get('key');
  if (!adminKey || !env.ADMIN_LOG_KEY || adminKey !== env.ADMIN_LOG_KEY) {
    return new Response(null, { status: 404 });
  }
  const listResult = await env.INSTALLER_KV.list({ prefix: 'log:', limit: 1000 });
  const sorted = listResult.keys.slice().sort(function(a, b) { return b.name > a.name ? 1 : -1; });
  const top50 = sorted.slice(0, 50);
  const logs = await Promise.all(top50.map(function(k) { return env.INSTALLER_KV.get(k.name, 'json'); }));
  return json(logs.filter(Boolean));
}

// --- handlers --------------------------------------------------------------

async function handleHome(request, env, url) {
  let notice = null;
  const err = url.searchParams.get('error');
  if (err === 'state') {
    notice = {
      title: '這個連結已經失效了',
      body: '可能是等太久，或是從舊的分頁點進來的。請重新按一次下面的按鈕。',
    };
  } else if (err === 'denied') {
    notice = {
      title: '你在 Cloudflare 頁面上取消了授權',
      body: '沒有授權我們就沒辦法幫你安裝。如果剛才是不小心按到，可以再試一次。',
    };
  } else if (err === 'token') {
    notice = {
      title: '連結帳號時發生問題',
      body: '授權連結只能使用一次。請重新按一次下面的按鈕，從頭走一遍。',
    };
  } else if (err === 'code') {
    notice = {
      title: '辨識碼或 Email 對不上',
      body: '請確認填的是官網登記那封信裡的 Email 和 8 碼辨識碼（大小寫沒關係）。還沒有辨識碼的話，要先到官網登記索取。',
    };
  } else if (err === 'code_rate') {
    notice = {
      title: '嘗試太頻繁了',
      body: '請稍等一下再試一次。',
    };
  } else if (err === 'code_unreachable') {
    notice = {
      title: '暫時連不上驗證服務',
      body: '這通常是暫時的。請稍等一下再按一次；若持續發生請回報我們。',
    };
  } else if (err === 'need_code') {
    // t154：無碼進 OAuth 但帳號沒有部署紀錄＝第一次安裝，要辨識碼
    notice = {
      title: '第一次安裝需要辨識碼',
      body: '這個 Cloudflare 帳號還沒裝過。請填上辨識碼再試一次；還沒有的話到 rag.arcrun.dev 申請。',
    };
  }
  return html(await homePage(notice, env, await releaseOf(env)));
}

async function handleAuthStart(request, env, url) {
  const inviteCode = (url.searchParams.get('code') || '').trim().slice(0, 64);
  const inviteEmail = (url.searchParams.get('email') || '').trim().slice(0, 254).toLowerCase();

  // P0-1：辨識碼閘。驗不過就不進 OAuth（避免用戶白授權一次才被拒），
  // 也擋掉「任何拿到網址的人都能裝」。fail-closed：連不上中央服務也拒。
  //
  // t154（leo 07-31「有必要重新 install 嗎？」）：**更新者免碼**——辨識碼是首次申請的
  // 節流閘，不該攔已核可的更新者。code 留空 → 放行進 OAuth（inviteVerified=false），
  // callback 換到 token 後查此帳號有無本安裝器的部署紀錄（deployedKey）：
  // 有紀錄＝既有實例更新 → 視同已核可；無紀錄＝新裝 → 導回要求辨識碼（need_code）。
  // 閘等效性：無碼者最多白走一次 OAuth，沒有部署紀錄仍裝不了。
  if (inviteCode) {
    const verdict = await verifyInviteCode(env, inviteEmail, inviteCode);
    if (!verdict.ok) {
      const key = verdict.reason === 'unreachable' ? 'code_unreachable'
        : verdict.reason === 'rate' ? 'code_rate' : 'code';
      return Response.redirect(`${url.origin}/?error=${key}`, 302);
    }
  } else if (!inviteEmail) {
    return Response.redirect(`${url.origin}/?error=code`, 302);
  }

  const sid = randomB64(18);
  const verifier = randomB64(48);
  const challenge = await pkceChallenge(verifier);
  const state = randomB64(24);

  // state → verifier + 已驗證的辨識碼/email，TTL 10 分鐘
  await env.INSTALLER_KV.put(
    `state:${state}`,
    // t154：有碼＝已驗過（上方閘）；無碼＝false，callback 以部署紀錄補驗（更新者路徑）
    JSON.stringify({ verifier, sid, inviteCode, inviteEmail, inviteVerified: !!inviteCode, createdAt: Date.now() }),
    { expirationTtl: STATE_TTL }
  );

  const redirectUri = `${url.origin}/auth/callback`;
  const authUrl = new URL(OAUTH_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      'set-cookie': sessionCookie(sid),
      'cache-control': 'no-store',
    },
  });
}

/** t154：查「這把 token 摸得到的帳號」有沒有本安裝器的部署紀錄（deployed:<accId>: 前綴）。
 *  更新者免辨識碼的判準——有紀錄＝這個 CF 帳號裝過本產品。exported 供單元測試。 */
async function hasDeployRecordForToken(env, accessToken, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(`${CF_API}/accounts?per_page=10`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    const accounts = (j && j.result) || [];
    for (const a of accounts) {
      if (!a || !a.id) continue;
      const list = await env.INSTALLER_KV.list({ prefix: `deployed:${a.id}:`, limit: 1 });
      if (list && list.keys && list.keys.length > 0) return true;
    }
  } catch (_) { /* 查不到＝當無紀錄（fail-closed：導回要碼） */ }
  return false;
}


async function handleAuthCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return Response.redirect(
      `${url.origin}/?error=${oauthError === 'access_denied' ? 'denied' : 'token'}`,
      302
    );
  }
  if (!code || !state) {
    return Response.redirect(`${url.origin}/?error=state`, 302);
  }

  // 比對 state（防 CSRF）。用完立刻刪，確保一次性。
  const stored = await env.INSTALLER_KV.get(`state:${state}`, 'json');
  if (!stored || !stored.verifier) {
    return Response.redirect(`${url.origin}/?error=state`, 302);
  }
  await env.INSTALLER_KV.delete(`state:${state}`);

  // cookie 裡的 sid 必須跟發出 state 時綁定的 sid 一致
  const cookieSid = getCookie(request, SESSION_COOKIE);
  if (!cookieSid || cookieSid !== stored.sid) {
    return Response.redirect(`${url.origin}/?error=state`, 302);
  }
  const sid = stored.sid;

  let tokens;
  try {
    tokens = await exchangeCode(code, stored.verifier, `${url.origin}/auth/callback`);
  } catch (e) {
    return Response.redirect(`${url.origin}/?error=token`, 302);
  }

  // t154：無碼進來的（inviteVerified=false）＝自稱更新者——OAuth 成功後查「這個帳號
  // 有沒有本安裝器的部署紀錄」（deployedKey 前綴）。有＝既有實例更新，視同已核可；
  // 無＝新裝，導回首頁要求辨識碼（need_code）。exported 供單元測試。
  let inviteVerified = stored.inviteVerified === true;
  if (!inviteVerified) {
    inviteVerified = await hasDeployRecordForToken(env, tokens.access_token);
    if (!inviteVerified) {
      return Response.redirect(`${url.origin}/?error=need_code`, 302);
    }
  }

  await env.INSTALLER_KV.put(
    `sess:${sid}`,
    JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: Date.now() + (Number(tokens.expires_in) || 57600) * 1000,
      scope: tokens.scope || OAUTH_SCOPES,
      inviteCode: stored.inviteCode || null,
      inviteEmail: stored.inviteEmail || null,
      inviteVerified, // P0-1：有碼在 /auth/start 已驗；無碼在上方以部署紀錄補驗（t154）
      createdAt: Date.now(),
    }),
    { expirationTtl: SESSION_TTL }
  );

  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/install`,
      'set-cookie': sessionCookie(sid),
      'cache-control': 'no-store',
    },
  });
}

async function handleInstallPage(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return Response.redirect(new URL('/', request.url).toString(), 302);
  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  if (!sess) return Response.redirect(new URL('/?error=state', request.url).toString(), 302);
  return html(installPage(env).replace('</body>', '<script src="/install.js"></script></body>'));
}

async function handleInstallStart(request, env, ctx) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return json({ error: 'no_session' }, 401);
  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  if (!sess) return json({ error: 'no_session' }, 401);
  // P0-1 防禦縱深：沒有通過辨識碼閘的 session 不准啟動安裝
  if (sess.inviteVerified !== true) return json({ error: 'not_verified' }, 403);

  let body = {};
  try {
    body = await request.json();
  } catch { /* 空 body 也可以 */ }

  const existing = await readProgress(env, sid);
  // 已在跑或已完成就不重複跑（除非明確要求重來）
  if (existing && !body.restart && (existing.state === 'running' || existing.state === 'done')) {
    return json({ ok: true, alreadyRunning: true, state: existing.state });
  }

  // t26 分批接力：paused_continue（本輪 waitUntil 時間／subrequests 額度用完，前端自動
  // 再打這支 API 接力）與 error（可能是接力中途真失敗，或用戶按「重新安裝」）都沿用同一份
  // progress——已完成的步驟（steps[].state==='done'）與已部署的 worker 清單
  // （result.deployedNames）是游標，砍掉＝逼用戶的帳號把已經吃過的額度/流量再吃一次。
  // runInstall 內的 stepDone() 只會跳過真的 done 的步驟，error 的步驟仍會正常重跑。
  let progress;
  if (existing && (existing.state === 'paused_continue' || existing.state === 'error')) {
    progress = existing;
    progress.error = null;
  } else {
    progress = freshProgress();
  }
  await writeProgress(env, sid, progress);

  // t138（leo 07-29 指出方向）：**不要用 waitUntil**。
  // 官方限制（developers.cloudflare.com/workers/platform/limits/）：
  //   ctx.waitUntil ＝ 30 秒（**免費與付費相同，升級無用**）
  //   HTTP 請求只要 client 保持連線 ⇒ **牆鐘無限**
  // 原本「請求立刻回、工作丟背景」＝主動把自己關進 30 秒牢裡，
  // 一天內卡死四次（快取空間／自我檢查／工作流／27-27）全是這個根因。
  // 改法：**保持連線** —— 回一個 streaming response，安裝在請求生命週期內跑完，
  // 邊跑邊送心跳（也讓中間的 CDN/瀏覽器不會把連線當閒置切斷）。
  // 進度仍寫 KV（前端輪詢照舊可用，斷線重連也看得到）。
  const force = !!(body.restart || body.force);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const heartbeat = setInterval(function () {
    writer.write(enc.encode('.')).catch(function () {});
  }, 5000);
  const runPromise = (
    runInstall(env, sid, progress, force).catch(async (e) => {
      progress.state = 'error';
      progress.finishedAt = Date.now();
      progress.error = {
        step: progress.currentStep || 'unknown',
        stepLabel: '安裝過程',
        message: '發生了預期外的錯誤',
        hint: '請按「重新安裝」再試一次；若持續失敗，請把技術細節回報給我們。',
        detail: String((e && e.stack) || e),
      };
      await writeProgress(env, sid, progress);
    })
  );
  // 跑完就關掉串流（用戶端的 fetch 才會結束）。整段在「請求生命週期」內，牆鐘無限。
  runPromise.finally(function () {
    clearInterval(heartbeat);
    writer.write(enc.encode('\n{"done":true}')).catch(function () {});
    writer.close().catch(function () {});
  });
  return new Response(readable, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // 防中間層緩衝（心跳要真的即時送達）
    },
  });
}

async function handleInstallStatus(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return json({ error: 'no_session' }, 401);
  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  if (!sess) return json({ error: 'no_session' }, 401);

  const progress = await readProgress(env, sid);
  if (!progress) return json(freshProgress());

  // P0-3 逾時偵測：仍 running 但超過 STALL_MS 沒更新＝背景工作被中斷（waitUntil 砍掉）。
  // 判成 error 並落庫，讓狀態頁停止空轉、給用戶「重新安裝」的出路（斷點續傳會接手）。
  if (progress.state === 'running') {
    const last = progress.updatedAt || progress.startedAt || 0;
    if (last && Date.now() - last > STALL_MS) {
      const curStep = STEPS.find((s) => s.id === progress.currentStep);
      const s = progress.steps.find((x) => x.id === progress.currentStep);
      if (s) s.state = 'error';
      progress.state = 'error';
      progress.finishedAt = Date.now();
      progress.error = {
        step: progress.currentStep || 'unknown',
        stepLabel: curStep ? curStep.label : '安裝過程',
        message: '安裝好像卡住了',
        hint: '請按「重新安裝」——已經建好的部分會沿用，會從卡住的地方接著做，不會重複建立。',
        detail: `stalled: no progress update for >${Math.round(STALL_MS / 1000)}s (last=${new Date(last).toISOString()})`,
      };
      await writeProgress(env, sid, progress);
    }
  }

  return json(progress);
}

// --- 帳密精靈（t20④d-3）-----------------------------------------------------

/** POST JSON helper：回 {status, ok, body}；連線失敗回 status:0（不丟例外）。 */
async function postJson(url, payload, extraHeaders) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0', ...(extraHeaders || {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * 帳密精靈代理：console setup（首次）→ 若沒拿到 session 則 login → portal admin bootstrap。
 * 手法逐字對齊工地主任 handleConsole（installer/src/index.js）。
 * - cypher base＝該 session 安裝結果的 result.apiUrl（progress KV），不吃前端傳的網址（防 SSRF/指鹿為馬）。
 * - 帳密只過境不落地：不寫 KV、不進 log；report 只留 HTTP 狀態與訊息。
 */
async function handleSetupAccount(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return json({ ok: false, error: 'no_session' }, 401);
  const sess = await env.INSTALLER_KV.get(`sess:${sid}`, 'json');
  if (!sess) return json({ ok: false, error: 'no_session' }, 401);

  const body = await request.json().catch(() => null);
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  const displayName = String((body && body.display_name) || '').trim() || email;
  if (!email || password.length < 8) {
    return json({ ok: false, error: 'Email 必填，密碼至少 8 碼' }, 400);
  }

  // cypher base 一律取自「這個 session 自己的安裝結果」——安裝沒完成就沒得設定
  const progress = await readProgress(env, sid);
  const cypherBase = progress && progress.state === 'done' && progress.result && progress.result.apiUrl;
  if (!cypherBase) {
    return json({ ok: false, error: '你的安裝還沒完成，等安裝完成後再建立帳號' }, 409);
  }

  const report = { setup: null, login: null, bootstrap: null };
  let sessionToken = '';

  // 1. setup（首次）；已設定過會失敗（409）→ 改走 login
  const setup = await postJson(`${cypherBase}/console/setup`, { email, password }, {});
  report.setup = { status: setup.status, ok: setup.ok, message: (setup.body && (setup.body.error || setup.body.message)) || null };
  if (setup.ok && setup.body && setup.body.session_token) {
    sessionToken = setup.body.session_token;
  } else {
    const login = await postJson(`${cypherBase}/console/login`, { email, password }, {});
    report.login = { status: login.status, ok: login.ok, message: (login.body && login.body.error) || null };
    if (login.ok && login.body && login.body.session_token) sessionToken = login.body.session_token;
  }

  if (!sessionToken) {
    // D61 明顯失敗（ADR D61 / arcrun-rag#55，接 #10「寧可明顯失敗，不要靜默錯置」）：
    // 舊訊息說「請確認密碼跟當時填的一樣」，**沒說剛才輸入的那組密碼從頭到尾沒有被採用過**
    // ⇒ 用戶（含 2026-08-09 的 leo）以為自己剛設好了新密碼，於是一直用新密碼重試，被鎖 15 分鐘。
    // ⚠️ 這裡刻意**不**叫人「去 console 救援」——leo 已否決那條路
    //    （decisions-summary：「我要是記得密碼，還來找忘記密碼幹嘛？」，正解是 email＋一次性
    //     驗證碼，屬 #42/#43 尚未落地的改版）。在那之前只說事實，不給假出路。
    const alreadySet = report.setup && report.setup.status === 409;
    return json({
      ok: false,
      error: alreadySet
        ? '這台機器之前就設過管理員帳密了，你剛才輸入的新密碼沒有被採用——目前的密碼還是當初設定的那一組。'
          + '請改用當初那組登入。不要一直用新密碼重試，連續失敗 5 次會被鎖 15 分鐘。'
        : '帳號沒有建立成功，請再試一次。',
      password_applied: false,
      report,
    }, 502);
  }

  // 2. portal admin bootstrap（需 console owner session；已有 admin 回 409＝冪等視為已就緒）
  const boot = await postJson(
    `${cypherBase}/portal/admin/bootstrap`,
    { email, password, display_name: displayName },
    { authorization: `Bearer ${sessionToken}` }
  );
  report.bootstrap = { status: boot.status, ok: boot.ok || boot.status === 409, message: (boot.body && (boot.body.error || boot.body.message)) || null };

  if (!report.bootstrap.ok) {
    return json({ ok: false, error: '帳號建好了，但管理員設定沒有完成。請再按一次「建立帳號」。', report }, 502);
  }
  return json({ ok: true, report });
}
