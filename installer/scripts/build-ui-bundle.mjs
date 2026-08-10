#!/usr/bin/env node
/**
 * build-ui-bundle.mjs — 把 console-ui/public 內嵌成單檔 UI worker（`arcrun-rag-ui`）
 *
 * 產物：`<out>/tier2/ui/index.js`，並就地把 manifest 的 `arcrun-rag-ui` 條目換新、
 * 走 release.mjs 的 syncManifest() 重算版本（版本號由內容指紋算，不靠人記得改）。
 *
 * 用法：
 *   node installer/scripts/build-ui-bundle.mjs --ui <console-ui/public 路徑> --out <bundles 目錄>
 *   node installer/scripts/build-ui-bundle.mjs --arcrun <Arcrun repo 路徑>   --out <bundles 目錄>
 *
 * ── 🔴 為什麼這支被合併重寫（2026-08-06）────────────────────────────────
 * 這個檔**同時存在兩份互不相容的版本**，各自有對方沒有的東西，而且都是必要的：
 *
 *   A. main 上這份    ── 有 t131「前端 JS 語法閘」；`--out` 是單一檔案；
 *                        **完全不碰 manifest**；**沒有 /__version**
 *   B. `fix/cis-round3-install` 上那份 ── 有 `/__version`（t170 的正解）、
 *                        t160 世代閘、manifest 併入＋syncManifest；**沒有語法閘**
 *
 * 真正在出貨的是 B（實際指令 `node /tmp/build-ui-bundle.mjs --ui … --out <staging>`，
 * 從那條分支複製到 /tmp 跑）。後來**那條分支被刪掉了** ⇒ `/__version` 整條路由蒸發，
 * 而 main 這份從來沒有過它 ⇒ **1.4.2 明明實測有效的機制，之後打出來的 bundle 全都沒有**。
 *
 * 實測鐵證（2026-08-06，youlin 實例，release 1.4.15）：
 *   GET /__version → HTTP 200、content-type `text/html`、335,508 bytes（＝SPA fallback 的首頁）
 * ⇒ 現在線上的 UI **沒有版本端點**。
 *
 * 後果分兩面，兩面都是病：
 *   ① 安裝器的 UI 探測永遠解析不到 JSON ⇒ 永遠判 stale ⇒ **每次安裝都全量重推 24 顆**
 *      （「都沒有變動，直接沿用」那條快路徑等於死碼）
 *   ② 只要哪天 UI 又長回一條會回 JSON 的路由、卻沒帶版本號，就會反向誤判成「已是最新」
 *      ⇒ 回到 t168/t170 事故的原形
 *
 * ⇒ 本檔＝**A ∪ B**，兩邊的閘都留著，從此只有這一份（單一真相源）。
 *    另外把 walk 的 `readdirSync().sort()`（A 才有）留下——**指紋要可重現**，
 *    目錄列舉順序若隨檔案系統浮動，同樣的內容會算出不同指紋。
 *
 * 🔒 出貨保險：`release.mjs` 的 verifyManifest() 會驗產物裡真的有 `/__version`，
 *    少了就拒絕出貨（機械閘，不靠人記得）。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ARCRUN = opt('--arcrun', '');
const UI = opt('--ui', ARCRUN
  ? join(ARCRUN, 'console-ui', 'public')
  : join(process.cwd(), '..', '..', 'matrix', 'arcrun', 'console-ui', 'public'));
const OUT = opt('--out', '/tmp/arcrun-rag-bundles');
// RELEASE_LINE（MAJOR.MINOR）所在的 repo 根；預設＝本腳本上兩層（installer/scripts/ → repo 根）
const REPO_ROOT = opt('--repo-root', join(import.meta.dirname, '..', '..'));

// A 版的 `--out` 是「輸出檔」、B 版是「bundles 目錄」——兩種語意都在文件裡出現過。
// 猜錯會把 bundles 目錄寫成一個檔（或反之），所以這裡明講而不是默默照做。
if (/\.(js|mjs)$/.test(OUT)) {
  console.error(`✘ --out 要給 **bundles 目錄**（本腳本會寫進 <out>/tier2/ui/index.js），不是單一檔案：${OUT}`);
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);
// config.js 由 worker 動態產生（apiBase 注入），不吃靜態版
const SKIP = new Set(['/config.js']);

// ⚠️ 一定要 sort()：指紋是 JSON.stringify(files) 算的，鍵的順序＝目錄列舉順序。
//    不排序的話同樣的內容在不同機器會得到不同指紋（B 版就漏了這一步）。
function walk(dir, base, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, base, out); continue; }
    const key = '/' + relative(base, p).split('\\').join('/');
    if (SKIP.has(key)) continue;
    const ext = extname(name);
    const type = TYPES[ext];
    if (!type) continue; // 未知型別不進 bundle
    if (TEXT_EXT.has(ext)) out[key] = { type, b64: false, data: readFileSync(p, 'utf8') };
    else out[key] = { type, b64: true, data: readFileSync(p).toString('base64') };
  }
}

// ── 閘① t160 世代閘（B 版）─────────────────────────────────────────────
// 打包前驗 portal 頁指紋——舊世代（缺「不需要人工新增」文案／含人工建庫「登記新庫」表單）
// 直接拒打包。病史：t159 重打包吃了停在舊世代的分支 public/，把 leo 實例的 UI 打回
// 被淘汰的人工登記典範。
// 🔴 2026-08-02 修誤判：原本直接對整份原始碼 grep「登記新庫」，但**現行世代的 HTML
//    註解裡就寫著「07-27 leo：拿掉『登記新庫』…」**——那是「已經拿掉了」的紀錄，
//    是新世代的證據，卻被當成舊世代特徵 ⇒ 閘把對的東西擋下來。
//    正解：**先剝掉註解再驗**，只看用戶真的會看到的 UI 內容。
{
  const portalRaw = readFileSync(join(UI, 'portal', 'index.html'), 'utf8');
  const portal = portalRaw.replace(/<!--[\s\S]*?-->/g, '');
  if (!portal.includes('不需要人工新增') || portal.includes('登記新庫')) {
    console.error('✘ 世代閘：--ui 指向的 public 不是現行世代（缺「不需要人工新增」或含「登記新庫」）——拒絕打包舊 UI。');
    console.error(`   剝註解後：不需要人工新增=${portal.includes('不需要人工新增')}／登記新庫=${portal.includes('登記新庫')}`);
    process.exit(1);
  }
}

const files = {};
walk(UI, UI, files);
if (!files['/portal/index.html']) throw new Error(`/portal/index.html 不在 ${UI} — 路徑錯了？`);

// ── 閘② t131 前端 JS 語法閘（A 版）────────────────────────────────────
// 2026-07-29 事故：誤刪一個 `})();` ⇒ portal 白畫面，驗收沒抓到——
// 因為測試只測後端、grep 只看字串，**沒有人驗過前端 JS 語法**。
// 打包前用 node --check 驗每個 HTML 內嵌 script，語法錯就拒絕產出 bundle。
{
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'uicheck-'));
  for (const [name, f] of Object.entries(files)) {
    if (!name.endsWith('.html') || f.b64) continue;
    const blocks = [...String(f.data).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    blocks.forEach((m, i) => {
      const jsPath = join(tmp, `${name.replace(/[^\w]/g, '_')}_${i}.js`);
      writeFileSync(jsPath, m[1]);
      try {
        execFileSync(process.execPath, ['--check', jsPath], { stdio: 'pipe' });
      } catch (e) {
        const msg = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n');
        throw new Error(`❌ ${name} 的第 ${i + 1} 個 <script> 有語法錯，拒絕打包（會導致白畫面）：\n${msg}`);
      }
    });
  }
  console.log('✅ 前端 JS 語法閘通過');
}

// 🔴 2026-08-02（leo 實撞：「一樣從 install 安裝，為什麼會裝到錯誤版本？」）
//    UI 內容指紋——**UI 過去沒有自己的版本號**，安裝器只能猜特徵
//    （t168 猜「/favicon.svg 開頭是不是 <svg」），而那只能分辨「有沒有 favicon 路由」
//    這一個世代差 ⇒ 舊 UI 早就有 favicon 路由，於是被判定「已是新版」
//    ⇒ **整批跳過、UI 永遠不重推**，用戶重裝幾次都拿到舊前端。
//    正解不是再想一個新特徵去猜（下個世代還會再猜錯），是**讓 UI 自己報版本**。
const uiFingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');

const worker = `// arcrun-rag-ui — 用戶實例的 GUI（console-ui/public 內嵌；由 build-ui-bundle.mjs 產生，勿手改）
const FILES = ${JSON.stringify(files)};
const UI_FINGERPRINT = ${JSON.stringify(uiFingerprint)};
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let p = url.pathname;
    // 🔴 UI 自報版本（安裝器據此判斷要不要重推，取代「猜 favicon 特徵」）。
    //    比照 cypher 的 /health。舊世代的 UI 沒有這條路由 ⇒ SPA fallback 回 HTML
    //    ⇒ 安裝器解析 JSON 失敗＝判定為舊版＝重推。**天然向後相容，不需額外世代判斷。**
    //    bundle_version 由安裝器以 ARCRUN_BUNDLE_VERSION 注入（cypher /health 同一個值）；
    //    沒注入就回空字串，安裝器那端把空值一律當「舊的」處理。
    if (p === '/__version') {
      // 🔴 2026-08-08：多報 worker_subdomain / config_ok 兩格。
      //    這條路由是**安裝器唯一會去問實例的地方**（probeInstanceStale），
      //    以前它只報版本 ⇒「版本對、但 apiBase 空」的實例在安裝器眼中是「已是最新」
      //    ⇒ 永遠不會被重推＝壞掉的實例自己好不了。報了之後，安裝器把
      //    config_ok:false 一律當成 stale ⇒ **下一次安裝／更新就自動治好它**。
      return new Response(JSON.stringify({
        ok: true,
        ui_fingerprint: UI_FINGERPRINT,
        bundle_version: env.ARCRUN_BUNDLE_VERSION || '',
        worker_subdomain: env.WORKER_SUBDOMAIN || '',
        config_ok: Boolean(env.WORKER_SUBDOMAIN),
      }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    // config.js 動態產生：apiBase 指向同帳號的 cypher（WORKER_SUBDOMAIN 由安裝器注入）
    //
    // 🔴 2026-08-08 事故（leo 的 youlin 實例整頁不能用，頂端紅字「設定檔沒載入」）：
    //    有人用 wrangler deploy 手動補這顆 worker ⇒ 繞過安裝器的變數注入
    //    ⇒ WORKER_SUBDOMAIN 空 ⇒ 這裡**安靜地**退成 apiBase:""（而且回 HTTP 200！）
    //    ⇒ 前端連不到自己的後端，但**部署是「成功」的**：worker 活著、curl 200、
    //      /__version 版本也對——只有真人打開瀏覽器才看得出壞了。
    //    正解不是「退一個合理的預設值」（沒有合理預設，猜錯更慘），
    //    是**大聲失敗**：回 500＋專用標頭，讓機器檢查一眼看穿。
    //    瀏覽器不執行非 2xx 的 <script>，所以用戶端行為與今天一致
    //    （portal 照樣顯示「設定檔沒載入」紅字），差別是**機器也看得見了**。
    //    no-store：這頁被邊緣快取過就會「修好了還是壞的」（08-08 實撞，害人誤判修復失敗）。
    if (p === '/config.js') {
      const sub = env.WORKER_SUBDOMAIN || '';
      if (!sub) {
        return new Response(CONFIG_MISSING_BODY, {
          status: 500,
          headers: {
            'content-type': TYPES_JS,
            'cache-control': 'no-store',
            'x-arcrun-config-error': 'WORKER_SUBDOMAIN-missing',
          },
        });
      }
      const apiBase = \`https://arcrun-cypher-executor.\${sub}.workers.dev\`;
      return new Response(\`window.ARCRUN_CONFIG = { apiBase: \${JSON.stringify(apiBase)} };\`, {
        headers: { 'content-type': TYPES_JS, 'cache-control': 'no-store' },
      });
    }
    if (p.endsWith('/')) p += 'index.html';
    let f = FILES[p] || FILES[p + '/index.html'] || FILES[p + '.html'];
    if (!f && !p.includes('.')) f = FILES[p + '/index.html'];
    if (!f) { p = '/portal/index.html'; f = FILES[p]; } // SPA fallback→portal
    if (!f) return new Response('not found', { status: 404 });
    const body = f.b64 ? b64ToBytes(f.data) : f.data;
    return new Response(body, { headers: { 'content-type': f.type, 'cache-control': 'no-cache' } });
  },
};
const TYPES_JS = 'application/javascript; charset=utf-8';
const CONFIG_MISSING_BODY = [
  '/* ============================================================',
  '   arcrun-rag-ui：WORKER_SUBDOMAIN 這個變數沒有被注入。',
  '   算不出 apiBase ＝ 前端不知道自己的後端在哪 ＝ 整個 portal 不能用。',
  '',
  '   成因幾乎一定是：這顆 worker 被手動 wrangler deploy 部署，繞過了注入。',
  '   修法（擇一）：',
  '     1. 重跑一次安裝器（它會注入，且會把這顆判定為 stale 而重推）',
  '     2. node installer/scripts/deploy-ui.mjs --subdomain <你的 workers.dev 子網域>',
  '   ============================================================ */',
  'throw new Error("arcrun-rag-ui: WORKER_SUBDOMAIN 未注入，apiBase 無法產生");',
].join('\\n');
`;

mkdirSync(join(OUT, 'tier2', 'ui'), { recursive: true });
const dest = join(OUT, 'tier2', 'ui', 'index.js');
writeFileSync(dest, worker);
const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
const entry = {
  name: 'arcrun-rag-ui', tier: 2,
  main_file: 'tier2/ui/index.js', main_module: 'index.js', sha256: sha,
  compat_date: '2026-07-01', compat_flags: [], modules: [],
  requires: { kv: [], d1: [], ai: false, vars: {} },
};
// 併入既有 manifest（若存在）
//
// 🔴 2026-08-02 修（leo：「版本沒更新，8/1 改了不少東西它沒動」）：
//    這段以前只換掉 core 裡的 ui 那筆就收工，**完全沒動 built／release**
//    ⇒ 四代釘點的 ui sha 都變了、`built` 卻永遠凍在 2026-07-31，用戶看到的版本號等於在說謊。
//    現在改成一律走 release.mjs 的 syncManifest()：重算全部 sha → 比內容指紋 → 自動 bump patch。
//    **版本號由內容算出來，不靠任何人記得改。**
const mPath = join(OUT, 'manifest.json');
try {
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.core = m.core.filter((c) => c.name !== 'arcrun-rag-ui');
  m.core.push(entry);
  writeFileSync(mPath, JSON.stringify(m, null, 1));

  const { syncManifest } = await import('./release.mjs');
  const { release, changed } = syncManifest(OUT, { repoRoot: REPO_ROOT });
  console.log(`✅ ui bundle ${(statSync(dest).size / 1024).toFixed(0)}KB（${Object.keys(files).length} 檔）｜指紋 ${uiFingerprint.slice(0, 12)}…｜manifest core=${m.core.length} 顆｜版本 ${release}${changed ? '（已 bump）' : '（內容未變）'}`);
} catch (e) {
  if (e && e.code !== 'ENOENT') throw e; // 只有「manifest 不存在」可以容忍，其餘一律炸出來
  console.log(`✅ ui bundle 產出（manifest 不存在，僅出檔）：${dest}｜指紋 ${uiFingerprint.slice(0, 12)}…`);
}
