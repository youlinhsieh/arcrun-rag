#!/usr/bin/env node
/**
 * build-bundles.mjs — P0-4 懶載的「CI 打包腳本」（host 無關）。
 *
 * 定位：OAuth 安裝器是一顆裸 Worker，機內跑不了 wrangler/esbuild。所以由**我方 CI**
 *   預先把核心 worker 的 TS 用 esbuild 打成單一 ESM module（＋外掛 wasm module part），
 *   連同「每顆 worker 的 binding 需求」寫進 manifest.json；產物 `bundles/` 之後發佈到
 *   public GitHub（youlinhsieh/*），安裝器透過 jsDelivr（`cdn.jsdelivr.net/gh/...`）純 API 抓來上傳。
 *   （leo 2026-07-21 拍板 jsDelivr；R2 因綁卡淘汰。）
 *
 * 懶載首裝 = 4 顆核心：cypher-executor / kbdb / http_request / code
 *   （13 個邏輯零件 RAG 產品鏈不用 → 不裝、用到才長，見 journeys/installer-lazy-load-feasibility.md）。
 *   **cypher 打包時去掉 13 個 [[services]]**（懶載 Q1：靠 URL fallback，不需那 13 顆存在）。
 *
 * 用法：ARCRUN_REPO_ROOT=/path/to/Arcrun node build-bundles.mjs [--out bundles]
 * 輸出：<out>/<worker>/worker.mjs (+ *.wasm)；<out>/manifest.json
 *
 * ⚠️ wasm 多模組上傳的「import specifier ↔ CF module part 名」對應，須在首次真實部署驗證
 *   （sandbox 無法端到端驗 CF /scripts multipart 解析）。見 manifest 每筆的 modules[]。
 */
import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { CORE_COMPONENTS, BUNDLE_COMPONENT_NAMES } from './bundle-components.mjs';

const REPO = process.env.ARCRUN_REPO_ROOT || process.env.ARCRUN_REPO || '';
if (!REPO || !existsSync(REPO)) {
  console.error('ARCRUN_REPO_ROOT 未設或不存在:', REPO);
  process.exit(1);
}
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return resolve(i >= 0 ? process.argv[i + 1] : 'bundles');
})();

/** 4 顆核心 worker 定義。stripServices=cypher 去 13 個 service binding（懶載）。
 *  🔴 2026-08-09（arcrun-rag#27）：定義本身搬去 `bundle-components.mjs`——
 *  那裡是「一個 bundle 有哪幾顆」的唯一真相源，ship.mjs 的提升路徑讀的是同一份。
 *  以前這裡一份、ship.mjs `BUILD_MANAGED` 一份，兩份人手維護的清單＝必然漂移。 */
const CORE = CORE_COMPONENTS;

// ── 🔴 落後閘（t173，2026-08-02）：打包分支若落後 main，就是在把修好的東西推回舊版 ──
//
// 病史（同一天三個症狀、同一個根因）：
//   出貨用的 batch/step3456-20260801 從 07-24 與 main 分家，
//   main 那邊又進了 12 個 cypher commit（t52 庫／t103 版本回報／t128 圖搜尋／t142 子庫…），
//   **九天沒人把 main 合回來**。我拿 batch 打包 ⇒ 五天的產品修復全被推回舊版：
//     · leo「geek6688 沒有子庫」        ← t52／t142 被推掉
//     · leo「graph search 又壞了」       ← t128 被推掉
//     · leo「daemon 一直要我更新知識庫」 ← t103 被推掉（/health 不吐 bundle_version）
//   leo：「**可以不要修好的又壞嗎？**」「**現在別人在安裝**」「**為什麼會落後？**」
//
// 為什麼放在這裡（而非獨立腳本）：這是**打包當下**唯一能攔住的地方。
//   放進 verify-manifest 太晚（產物已生成）；寫成獨立腳本沒人會記得跑——
//   `scripts/check-deploy-drift.sh` 07-30 就存在，但 grep 全 repo **沒有任何東西呼叫它**。
//   （那支做的是「線上／Gitea／本機」三欄對帳，與本閘的「分支間落後」不同層，非重造。）
//
// 逃生門：BUILD_ALLOW_BEHIND=1（明知故犯時要在 commit 說明理由）。
function assertNotBehindMain(repoRoot, workers) {
  if (process.env.BUILD_ALLOW_BEHIND === '1') {
    console.warn('⚠️ BUILD_ALLOW_BEHIND=1：跳過落後檢查（請在 commit 說明理由）');
    return;
  }
  const behind = [];
  for (const w of workers) {
    try {
      const out = execSync(
        `git -C ${JSON.stringify(repoRoot)} log --oneline HEAD..main -- ${JSON.stringify(w.dir)}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) behind.push({ name: w.name, dir: w.dir, commits: out.split('\n') });
    } catch { /* 沒有 main／非 git（CI 淺 clone）⇒ 不擋 */ }
  }
  if (!behind.length) return;
  console.error('\n❌ 打包中止：**這個分支落後 main，打下去會把修好的東西推回舊版**（t173 的病）\n');
  for (const b of behind) {
    console.error(`   ${b.name}（${b.dir}）落後 ${b.commits.length} 個 commit：`);
    for (const c of b.commits.slice(0, 8)) console.error(`     ${c}`);
    if (b.commits.length > 8) console.error(`     …還有 ${b.commits.length - 8} 個`);
  }
  console.error('\n修法：先把 main 合回這條分支（git merge main），衝突逐一裁決後再打包。');
  console.error('明知故犯：BUILD_ALLOW_BEHIND=1（要在 commit 說明理由）。\n');
  process.exit(1);
}

/** 極簡 wrangler.toml 讀取：只抓我們注入時需要的欄位（非全 TOML parser，夠用即可）。 */
function readToml(tomlPath) {
  const t = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const spec = { kv: [], d1: [], vectorize: [], ai: null, vars: {}, compat_flags: [], compat_date: null };
  const compatFlags = t.match(/compatibility_flags\s*=\s*\[([^\]]*)\]/);
  if (compatFlags) spec.compat_flags = [...compatFlags[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const compatDate = t.match(/compatibility_date\s*=\s*["']([^"']+)["']/);
  if (compatDate) spec.compat_date = compatDate[1];
  // KV：[[kv_namespaces]] binding = "X"
  for (const m of t.matchAll(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*["']([^"']+)["']/g)) spec.kv.push(m[1]);
  // D1：[[d1_databases]] binding=+database_name=
  for (const m of t.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|\n*$)/g)) {
    const b = m[1].match(/binding\s*=\s*["']([^"']+)["']/);
    const n = m[1].match(/database_name\s*=\s*["']([^"']+)["']/);
    if (b) spec.d1.push({ binding: b[1], database_name: n ? n[1] : null });
  }
  // Vectorize（多為註解掉的 embed；只抓「未註解」的）
  for (const line of t.split('\n')) {
    const mm = line.match(/^\s*\[\[vectorize\]\]/);
    if (mm) spec.vectorize.push(true);
  }
  // [ai] binding（未註解才算）
  if (/^\s*\[ai\]/m.test(t)) spec.ai = true;
  // [vars]：抓 [vars] 段內 key = "value"（僅字面字串）
  const varsBlock = t.match(/\[vars\]([\s\S]*?)(?=\n\[|\n*$)/);
  if (varsBlock) for (const m of varsBlock[1].matchAll(/^\s*([A-Z0-9_]+)\s*=\s*["']([^"']*)["']/gm)) spec.vars[m[1]] = m[2];
  return spec;
}

/** esbuild plugin：把 .wasm import 標為 external 並攤平成 ./<basename>.wasm，記下要一起上傳的 wasm 檔。 */
function wasmPlugin(wasmParts) {
  return {
    name: 'wasm-external',
    setup(build) {
      build.onResolve({ filter: /\.wasm$/ }, (args) => {
        const abs = resolve(args.resolveDir, args.path);
        const flat = basename(abs); // e.g. component.wasm / quickjs.wasm
        if (!wasmParts.find((w) => w.part === flat)) wasmParts.push({ part: flat, abs });
        return { path: './' + flat, external: true };
      });
    },
  };
}

async function buildOne(w) {
  const dir = join(REPO, w.dir);
  const entry = join(dir, w.entry);
  if (!existsSync(entry)) throw new Error(`entry 不存在: ${entry}`);
  const outDir = join(OUT, w.name);
  mkdirSync(outDir, { recursive: true });

  const wasmParts = [];
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(outDir, 'worker.mjs'),
    // CF runtime 提供的東西一律 external：cloudflare:*、node: builtins（nodejs_compat）
    external: ['cloudflare:*', 'node:*'],
    plugins: [wasmPlugin(wasmParts)],
    logLevel: 'silent',
    metafile: true,
  });

  // 複製 wasm parts 進 bundle 目錄
  const modules = [];
  for (const wp of wasmParts) {
    if (!existsSync(wp.abs)) throw new Error(`wasm 找不到: ${wp.abs}（該 worker 需先 build/vendored wasm）`);
    copyFileSync(wp.abs, join(outDir, wp.part));
    modules.push({ name: wp.part, type: 'application/wasm', file: `${w.name}/${wp.part}` });
  }

  const spec = readToml(join(dir, 'wrangler.toml'));
  const jsSize = readFileSync(join(outDir, 'worker.mjs')).length;
  return {
    name: w.name,
    canonical: w.canonical,
    main_module: 'worker.mjs',
    main_file: `${w.name}/worker.mjs`,
    js_bytes: jsSize,
    modules,               // 額外 wasm module parts
    compat_date: spec.compat_date,
    compat_flags: spec.compat_flags,
    // binding 需求（安裝器據此把「已建的資源 id」對上）——注意 cypher 已無 service（stripServices）
    requires: {
      kv: spec.kv,                       // binding 名清單（值＝安裝器建的 namespace id）
      d1: spec.d1,                       // [{binding, database_name}]
      vectorize: spec.vectorize.length,  // 0=base（免綁卡）；embed 版才 >0
      ai: !!spec.ai,
      vars: spec.vars,                   // COMPONENT_ID 等字面 var（WORKER_SUBDOMAIN/CF_ACCOUNT_ID 安裝器注入）
    },
    stripped: w.stripServices ? { services: 13 } : undefined,
    warnings: result.warnings.map((x) => x.text),
  };
}

async function main() {
  // t173 落後閘：先擋，再做任何事——產物生成後才發現就太晚了
  assertNotBehindMain(REPO, CORE);
  // 🔴 2026-08-05：這裡把整個 --out 砍掉重建，**既有 manifest 一併陪葬**
  //    ⇒ `daemon` 欄（桌面 App 版本）被吃掉 ⇒ 使用者按「檢查更新」回
  //    「manifest 沒有 daemon 版本欄位」而全體失效（08-02 已在 release.mjs 修過同款病）。
  //    ⇒ 砍之前先把既有 manifest 讀進記憶體，重建後合併回去（見檔尾寫入處）。
  let prevManifest = {};
  try { prevManifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')); } catch { /* 首次 */ }
  // 🔴 2026-08-05 二修（同款病的**第三個入口**，leo 出貨時實撞）：
  //    上一輪只救了 manifest 的**欄位**，**磁碟上的檔案照樣被 rmSync 砍光**——
  //    `daemon/`（桌面 App 全部產物）、`tier2/ui/index.js`（portal 前端）、`README.md`
  //    都不是本腳本產的，卻跟著陪葬。
  //    後果實錄：release 1.4.12 就是這樣把 **portal 從 bundle 裡整個弄丟**
  //    （`@main/tier2/ui/index.js` → 404）⇒ 安裝器再也不會更新前端
  //    ⇒ leo 08-05：「下載完仍然是解壓縮就顯示單獨的一個 Arcrun icon」——
  //      portal 的下載鈕早就改成 DMG 了，但那份前端**根本送不到他的實例**。
  //    （當時沒炸掉 daemon/ 純粹是因為那次出貨改走「匿名 tarball 重建 git」，
  //      等於繞過了這個 bug——不是它被修好了。）
  //    ⇒ 只清「本次重建的那幾個目錄」，不碰別人的東西。
  mkdirSync(OUT, { recursive: true });
  for (const w of CORE) {
    const d = join(OUT, w.name);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  // 🔴 2026-08-08：`source` 從**產物來源 repo 的 HEAD** 推導，不再沿用舊 manifest。
  //
  // 病（同一天手動修了三次，才發現是腳本缺陷不是人的疏忽）：
  //   release.mjs:6 的註解寫著「manifest.built／source 只有全量重建的 build-bundles.mjs 會寫」，
  //   但本檔 grep "source" ＝ **0 命中**——根本沒寫；release.mjs:125 只有 `source: m.source`
  //   ＝從磁碟既有值原樣抄 ⇒ **source 永遠停在第一次寫進去的那個 commit**。
  //   實害：1.4.20 宣告 `Arcrun@0d49989`（07-31 的），產物其實來自 `5388f40`；
  //   每批都要人工改一次，改漏就是「宣告在說謊」。
  //
  // ⇒ 對齊 CP 08-06 的鐵律：**凡宣告版本，一律由產物推導**
  //   （那次是 daemon 版本號，這次是來源 commit——同一條病的第二種形態）。
  //
  // 📌 為什麼寫在這裡而不是 release.mjs：`syncManifest` 收的 `repoRoot` 是 **arcrun-rag** 的，
  //    拿不到 arcrun 的 HEAD；只有本檔有 `REPO`（＝ARCRUN_REPO_ROOT）。
  //    而 syncManifest 在本檔之後才跑、且 `source: m.source` 會原樣保留 ⇒ 這裡寫就夠。
  // 取不到 git 就誠實留空，不沿用舊值也不瞎猜。
  let sourceRef = '';
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
    // 🔴 2026-08-08（延續 b89ae0d 同一個方向：宣告一律由產物推導，不准說謊）：
    //    工作區不乾淨時 `Arcrun@<sha>` 是**假的**——產物裡有那個 commit 沒有的東西。
    //    誠實標 `+dirty`，讓「這一版從哪來」看得出來不可重現。
    //    （ship.mjs 對發佈目標本來就擋 dirty；這裡是別人直接跑本腳本時的保險。）
    const dirty = execSync('git status --porcelain', { cwd: REPO, encoding: 'utf8' }).trim();
    if (sha) sourceRef = `Arcrun@${sha}${dirty ? '+dirty' : ''}`;
  } catch { /* 非 git checkout → 留空，比留一個錯的值好 */ }

  const manifest = { schema: 1, built_for: 'oauth-installer-lazy-load', core: [], notes: [] };
  if (sourceRef) manifest.source = sourceRef;
  for (const w of CORE) {
    try {
      const entry = await buildOne(w);
      manifest.core.push(entry);
      const wasmNote = entry.modules.length ? ` +${entry.modules.length} wasm` : '';
      console.log(`✔ ${w.name}  js=${(entry.js_bytes / 1024).toFixed(0)}KB${wasmNote}`);
    } catch (e) {
      manifest.notes.push(`FAILED ${w.name}: ${e.message}`);
      console.error(`✗ ${w.name}: ${e.message}`);
    }
  }
  // 🔴 2026-08-05（leo 出貨時實撞）：這裡原本**直接覆寫整個 manifest**
  //    ⇒ 既有欄位（尤其 `daemon`）被整個吃掉 ⇒ daemon 的「檢查更新」回
  //    「manifest 沒有 daemon 版本欄位」而**全體失效**（08-02 已經被 release.mjs
  //    修過一次同款病，這裡是第二個入口，漏網）。
  //    ⇒ 先讀既有 manifest，只覆寫本次重建的欄位，其餘原樣保留。
  //    prevManifest 在砍目錄「之前」就讀好了（見上方），這裡鋪底讓 daemon 等欄位活下來。
  const merged = { ...prevManifest, ...manifest };
  // 🔴 2026-08-05 三修（同一個病的**第四個入口**）：上面的淺層合併會把 `core` **整個陣列換掉**
  //    ⇒ 不是本腳本產的那幾顆（現在是 `arcrun-rag-ui`＝portal 前端，由 build-ui-bundle.mjs 產）
  //      每重打包一次就從 manifest 消失一次。
  //    這正是 release 1.4.12 弄丟 portal 的**另一半**：檔案被 rmSync 砍掉（`2d45673` 修了），
  //    manifest 條目被這行蓋掉（此處修）。只修一半的下場是實際發生過的——
  //    1.4.15 重打時 portal 又從 core 消失（同日實測）。
  //    ⇒ 保留「舊 manifest 有、不屬於本腳本 CORE、且**檔案確實還在**」的條目。
  //      檔案不在就不留：不假裝有東西，讓 verify-manifest 的機械閘去抓。
  //
  //    🔴 2026-08-09 四修（arcrun-rag#27，leo：「如果是複製，為什麼不一致？」）：
  //    上面那條「檔案還在就沿用」是**單向棘輪**——只會加、永遠不會減。
  //    後果實錄：stage 的 `tier1/`（19 顆）是 1.4.17 播種時帶進來的舊世代版型
  //    （本腳本 `3fe8be6` 時代真的會打 25 顆，後來改懶載縮成 4 顆），
  //    prod 從來沒有 `tier1/` ⇒ **prod 5 顆、stage 24 顆**，而且只會越差越多。
  //    leo 裝一次 stage 就撞到：他驗的東西根本不是封測者會拿到的東西。
  //    ⇒ 沿用的白名單改成 `BUNDLE_COMPONENT_NAMES`（唯一真相源）：
  //      「本腳本沒產、但**清單上有**、且檔案真的在」才沿用（＝ portal 前端 `arcrun-rag-ui`，
  //      bbb433e 當初要救的就是它，照樣救得到）；
  //      **清單上沒有的，一律不進 manifest**——棘輪就此拆掉。
  //    （`daemon` 是 manifest 的獨立欄位、不在 core 裡，972acbc 那條保命邏輯不受影響。）
  const ownNames = new Set(CORE.map((w) => w.name));
  const canonical = new Set(BUNDLE_COMPONENT_NAMES);
  const prevCore = prevManifest.core ?? [];
  const inherited = prevCore.filter(
    (c) => c && c.name && !ownNames.has(c.name) && canonical.has(c.name)
      && c.main_file && existsSync(join(OUT, c.main_file)),
  );
  const dropped = prevCore.filter((c) => c && c.name && !canonical.has(c.name));
  merged.core = [...manifest.core, ...inherited];
  if (inherited.length) {
    console.log(`↺ 沿用非本腳本產的 ${inherited.length} 顆：${inherited.map((c) => c.name).join('、')}`);
  }
  if (dropped.length) {
    console.log(
      `🧹 清單外的 ${dropped.length} 顆已從 manifest 移除（棘輪殘留，非本 bundle 應有內容）：` +
      `${dropped.map((c) => c.name).join('、')}`);
    console.log(`   （磁碟上的檔案**不動**——要不要回收由人決定，見 arcrun-rag#27）`);
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(merged, null, 2));
  // 🔴 2026-08-02（leo：「做成自動化，不依賴你記得去更新」）：
  //    全量重建也一律走 syncManifest——版本號由內容指紋算出來，兩條 build 路徑共用同一套規則，
  //    不會再出現「走 A 路徑版本會動、走 B 路徑不會動」的漂移。
  const { syncManifest } = await import('./release.mjs');
  const { release, changed } = syncManifest(OUT, { repoRoot: join(import.meta.dirname, '..', '..') });
  console.log(`\nmanifest → ${join(OUT, 'manifest.json')} (${manifest.core.length}/${CORE.length} bundled)｜版本 ${release}${changed ? '（已 bump）' : '（內容未變）'}`);
  if (manifest.core.length < CORE.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
