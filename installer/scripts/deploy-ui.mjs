#!/usr/bin/env node
/**
 * deploy-ui.mjs — 手動部署 `arcrun-rag-ui`（用戶實例的 portal 前端）的**唯一合法路徑**
 *
 * ── 🔴 為什麼有這支（2026-08-08 事故）─────────────────────────────────────
 * leo 的 youlin 實例整個 portal 不能用，頂端一條紅字「設定檔沒載入（config.js），
 * 這個頁面連不到你的服務」。鏈路：
 *
 *   portal 的 apiBase ← UI worker 動態產生的 /config.js ← 環境變數 WORKER_SUBDOMAIN
 *   而 WORKER_SUBDOMAIN **只有安裝器那條路會注入**（worker.js 的 bindings 組裝）。
 *
 * 有人用 `wrangler deploy` 手動補了那顆 worker ⇒ 繞過注入 ⇒ 變數空 ⇒ apiBase 空字串。
 * **而那次部署是「成功」的**：worker 上線、HTTP 200、/__version 版本還是對的——
 * 只有真人打開瀏覽器才看得出壞了。
 *
 * 為什麼會有人手動補：**這顆不在任何「要部署哪些東西」的清單裡**。
 *   `deploy-all.mjs` 的 TIER2_WORKERS 只有 cypher/registry/kbdb/mcp——
 *   arcrun-rag-ui 是本產品專屬、不在 Arcrun 平台核心，全量部署掃不到它
 *   （wiki status.md 2026-08-08 已記為「UI worker 落差」，當時只記下沒補）。
 *   人發現前端沒更新 → 手動 `wrangler deploy` 補 → 就掉進上面那個洞。
 *
 * ⇒ 本腳本＝把那條手動路變成**帶注入、帶驗證、缺值就拒絕跑**的正規路：
 *     ① 沒有 subdomain 就**拒絕部署**（不 fallback、不猜、不預設空字串）
 *     ② 部署後**實際回頭抓 /config.js 與 /__version 驗**，apiBase 空就 exit 1
 *        ——不看 wrangler 的 exit code，因為這場事故裡 wrangler 是成功的
 *
 * 用法：
 *   node installer/scripts/deploy-ui.mjs --subdomain <workers.dev 子網域> [選項]
 *
 *   --subdomain <s>   必填。實例的 workers.dev 子網域（如 youlin-hsieh-dev）
 *   --bundle <dir>    bundle 目錄（讀 <dir>/tier2/ui/index.js 與 <dir>/manifest.json）
 *                     不給則現場用 build-ui-bundle.mjs 從 --arcrun 打一份到暫存目錄
 *   --arcrun <path>   Arcrun repo 路徑（只在沒給 --bundle 時用）
 *   --version <v>     ARCRUN_BUNDLE_VERSION；不給則讀 bundle 的 manifest.release
 *   --commit <sha>    ARCRUN_BUNDLE_COMMIT；不給則讀 bundle 的 manifest.source（解不出就不貼）
 *   --dry-run         只印「將部署什麼、注入什麼」，不真部署
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN     選填。不給就用 wrangler 既有登入態（OAuth）
 *   CLOUDFLARE_ACCOUNT_ID    選填。多帳號時必填，否則 wrangler 會問（非互動會失敗）
 *
 * ⚠️ 紅線：這支只部署 UI 那一顆。**它不會、也不該去碰 cypher**——
 *    用不完整的設定覆蓋既有 worker，會把它身上其他好的東西一起洗掉。
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
// 版本＋commit 兩個印記只有一份算法（Arcrun#106 另一半）——見 version-stamp.mjs 檔頭。
import { sourceCommitOf } from '../oauth-prototype/version-stamp.mjs';

const WORKER_NAME = 'arcrun-rag-ui';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const subdomain = opt('--subdomain', process.env.WORKER_SUBDOMAIN || '');
const bundleDir = opt('--bundle', '');
const arcrunPath = opt('--arcrun', '');
const versionOpt = opt('--version', '');
const commitOpt = opt('--commit', '');
const dryRun = has('--dry-run');

// ── 閘①：沒有 subdomain 就拒絕（這就是整場事故的那一格）──────────────────
if (!subdomain) {
  console.error('✘ 缺 --subdomain（或環境變數 WORKER_SUBDOMAIN）。');
  console.error('');
  console.error('  這不是可以省略的參數：UI worker 的 apiBase 完全由它算出來');
  console.error('  （apiBase = https://arcrun-cypher-executor.<subdomain>.workers.dev）。');
  console.error('  缺了它部署出去的實例會「上線、HTTP 200、但前端連不到自己的後端」，');
  console.error('  而且只有真人開瀏覽器才看得出來——2026-08-08 就是這樣壞掉的。');
  console.error('');
  console.error('  查法：npx wrangler whoami 確認帳號後，看實例任一 worker 的網址');
  console.error('        https://arcrun-cypher-executor.<這一段就是>.workers.dev');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(subdomain)) {
  console.error(`✘ --subdomain 格式不對：${subdomain}（只允許小寫英數與連字號）`);
  process.exit(2);
}

// ── 取得 UI worker 產物 ────────────────────────────────────────────────────
let uiDir = bundleDir;
if (!uiDir) {
  if (!arcrunPath) {
    console.error('✘ 沒給 --bundle 就必須給 --arcrun（要從哪份 console-ui/public 打包）。');
    process.exit(2);
  }
  uiDir = mkdtempSync(join(tmpdir(), 'ui-bundle-'));
  console.log(`[deploy-ui] 現場打包：${arcrunPath} → ${uiDir}`);
  execFileSync(process.execPath, [
    join(import.meta.dirname, 'build-ui-bundle.mjs'), '--arcrun', arcrunPath, '--out', uiDir,
  ], { stdio: 'inherit' });
}

const srcPath = join(uiDir, 'tier2', 'ui', 'index.js');
if (!existsSync(srcPath)) {
  console.error(`✘ 找不到 UI worker 產物：${srcPath}`);
  console.error('   （--bundle 要指向 bundles 目錄，不是 index.js 本身）');
  process.exit(2);
}
const src = readFileSync(srcPath, 'utf8');

// ── 閘②：產物本身要是「會大聲失敗」的那一版 ───────────────────────────────
// 舊版產物缺 WORKER_SUBDOMAIN 時安靜退成空字串（就是事故那版）。用舊產物部署，
// 就算這裡注入對了，下一個人手動部署又會靜默壞掉 ⇒ 直接擋，逼重打包。
if (!src.includes('x-arcrun-config-error')) {
  console.error('✘ 這份 UI 產物是**舊版**：/config.js 缺值時會安靜退成空 apiBase，不會大聲失敗。');
  console.error('   用 installer/scripts/build-ui-bundle.mjs 重打一份再來。');
  process.exit(1);
}

// 版本號：優先 --version，其次 bundle 的 manifest.release
// commit 印記（Arcrun#106 另一半）：優先 --commit，其次 manifest.source（`Arcrun@<12碼>`）。
//   版號是這條路貼上去的標籤，commit 才是「真的部了哪份碼」——只貼版號＝把「查得出漂沒漂」
//   這個能力洗掉（08-16 三台實例報同一個版號、卻無從比對的病根）。
//   🔴 解不出合法 sha 就**不貼**，絕不編一個（見 version-stamp.mjs 檔頭的 t144 前科）。
let version = versionOpt;
let commit = sourceCommitOf(commitOpt);
if (!version || !commit) {
  try {
    const m = JSON.parse(readFileSync(join(uiDir, 'manifest.json'), 'utf8'));
    if (!version) version = String(m.release || '');
    if (!commit) commit = sourceCommitOf(m.source);
  } catch { /* 沒 manifest 就留空，下面警告 */ }
}
if (!version) {
  console.warn('⚠ 沒有版本號（--version 也沒給、manifest 也讀不到）⇒ /__version 會回空字串，');
  console.warn('  安裝器會把這個實例一律判定為「舊的」而重推。功能不會壞，但每次都會全量重推。');
}

const apiBase = `https://arcrun-cypher-executor.${subdomain}.workers.dev`;
const uiUrl = `https://${WORKER_NAME}.${subdomain}.workers.dev`;

console.log(`[deploy-ui] worker      : ${WORKER_NAME}`);
console.log(`[deploy-ui] 產物        : ${srcPath}（${(src.length / 1024).toFixed(0)}KB）`);
console.log(`[deploy-ui] 注入 vars   : WORKER_SUBDOMAIN=${subdomain}｜ARCRUN_BUNDLE_VERSION=${version || '(空)'}`
  + `｜ARCRUN_BUNDLE_COMMIT=${commit || '(查不到，這趟不貼)'}`);
console.log(`[deploy-ui] 部署後 apiBase 應為 : ${apiBase}`);

if (dryRun) {
  console.log('[deploy-ui] DRY-RUN：不真部署。');
  process.exit(0);
}

// ── 部署（暫存工作目錄，不污染 repo）─────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'deploy-ui-'));
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'index.js'), src);
writeFileSync(join(work, 'wrangler.toml'), [
  `name = "${WORKER_NAME}"`,
  'main = "index.js"',
  'compatibility_date = "2026-07-01"',
  '',
  '[vars]',
  `WORKER_SUBDOMAIN = "${subdomain}"`,
  `ARCRUN_BUNDLE_VERSION = "${version}"`,
  // 查不到就整行不寫（少一個欄位 ≠ 部署失敗；貼假的才是災難）
  ...(commit ? [`ARCRUN_BUNDLE_COMMIT = "${commit}"`] : []),
  '',
].join('\n'));

console.log('[deploy-ui] wrangler deploy …');
try {
  execFileSync('npx', ['wrangler', 'deploy'], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });
} catch (e) {
  console.error(`[deploy-ui] ✘ wrangler deploy 失敗：${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

// ── 閘③：部署成功 ≠ 裝對了。回頭問實例自己（這場事故裡 wrangler 是成功的）──
console.log('[deploy-ui] 部署完成，回頭驗實例真實狀態（不看 wrangler 的 exit code）…');
const verify = await verifyInstanceUi({ uiUrl, expectApiBase: apiBase });
for (const line of verify.lines) console.log('  ' + line);
if (!verify.ok) {
  console.error('[deploy-ui] ✘ 部署「成功」但實例不健康——這正是 2026-08-08 那個洞，誠實回報不假綠。');
  process.exit(1);
}
console.log(`[deploy-ui] ✓ 通。portal：${uiUrl}/portal/`);

/**
 * 問實例自己：/config.js 的 apiBase 對不對、/__version 的 config_ok 是不是真。
 * 一律 no-cache——不加的話驗到的是 Cloudflare 邊緣快取，不是線上真實狀態
 * （2026-08-08 實撞，害人誤判修復失敗）。
 */
export async function verifyInstanceUi({ uiUrl, expectApiBase, fetchImpl = fetch }) {
  const lines = [];
  let ok = true;
  const noCache = { headers: { 'Cache-Control': 'no-cache' } };

  try {
    const r = await fetchImpl(`${uiUrl}/config.js`, noCache);
    const body = await r.text();
    const err = r.headers.get('x-arcrun-config-error');
    const m = body.match(/apiBase:\s*"([^"]*)"/);
    const got = m ? m[1] : '';
    if (err) {
      ok = false;
      lines.push(`✘ /config.js HTTP ${r.status}｜x-arcrun-config-error: ${err}（變數沒注入）`);
    } else if (!r.ok) {
      ok = false;
      lines.push(`✘ /config.js HTTP ${r.status}`);
    } else if (!got) {
      ok = false;
      lines.push('✘ /config.js 回 200 但 apiBase 是空的（舊版產物才會這樣）');
    } else if (expectApiBase && got !== expectApiBase) {
      ok = false;
      lines.push(`✘ /config.js apiBase=${got}，期望 ${expectApiBase}`);
    } else {
      lines.push(`✓ /config.js apiBase=${got}`);
    }
  } catch (e) {
    ok = false;
    lines.push(`✘ /config.js 抓不到：${e instanceof Error ? e.message : e}`);
  }

  try {
    const r = await fetchImpl(`${uiUrl}/__version`, noCache);
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (!j) {
      ok = false;
      lines.push(`✘ /__version 不是 JSON（HTTP ${r.status}）＝舊世代產物`);
    } else if (j.config_ok === false) {
      ok = false;
      lines.push('✘ /__version config_ok=false（實例自己說它沒拿到 WORKER_SUBDOMAIN）');
    } else {
      lines.push(`✓ /__version config_ok=${j.config_ok}｜version=${j.bundle_version || '(空)'}｜subdomain=${j.worker_subdomain || '(空)'}`);
    }
  } catch (e) {
    ok = false;
    lines.push(`✘ /__version 抓不到：${e instanceof Error ? e.message : e}`);
  }

  return { ok, lines };
}
