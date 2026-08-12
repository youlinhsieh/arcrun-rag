#!/usr/bin/env node
/**
 * build-bundles.mjs — P0-4 懶載的「CI 打包腳本」（host 無關）。
 *
 * 🔴 2026-08-11（arcrun-rag#39／Arcrun#80）：本檔**不再自己跑 esbuild**。
 *   舊版直接對 Arcrun 原始碼路徑（`cypher-executor/src/index.ts` 等）跑 esbuild，
 *   結果同一份原始碼在不同機器編出不同位元組（雲端 vs 地端的 cwd 深度不同 → esbuild
 *   把不同的相對路徑寫進 bundle 內部註解；node_modules 用不同套件管理器裝出不同的
 *   間接依賴版本）——證據見本 repo 1.4.33 changelog 段與 arcrun-rag#72。
 *
 *   正解（leo 2026-08-09 拍板，Arcrun#80 原話）：「Arcrun 編譯好一組放在固定的位置，
 *   任何人要安裝只要指明安裝哪一個就去下載編譯後的檔」——**編譯只發生在 Arcrun 那邊**
 *   （`scripts/build-worker-artifacts.mjs`，成品固定放 `.worker-builds/`，commit 進
 *   Arcrun repo），本檔現在只做兩件事：① 讀 Arcrun 的 `.worker-builds/manifest.json`
 *   ② 把每顆成品複製進本檔的輸出目錄，補上「安裝器層」需要的欄位（stripped 等）。
 *   **本檔完全沒有任何 esbuild 呼叫**——這正是 arcrun-rag#39 的驗收條件第一條。
 *
 * 定位（其餘不變）：OAuth 安裝器是一顆裸 Worker，機內跑不了 wrangler/esbuild。所以由**我方 CI**
 *   預先把核心 worker 的**官方編譯成品**（現在＝原樣複製，不是自己重編）連同「每顆 worker 的
 *   binding 需求」寫進 manifest.json；產物 `bundles/` 之後發佈到 public GitHub
 *   （youlinhsieh/*），安裝器透過 jsDelivr（`cdn.jsdelivr.net/gh/...`）純 API 抓來上傳。
 *   （leo 2026-07-21 拍板 jsDelivr；R2 因綁卡淘汰。）
 *
 * 懶載首裝 = 4 顆核心：cypher-executor / kbdb / http_request / code
 *   （13 個邏輯零件 RAG 產品鏈不用 → 不裝、用到才長，見 journeys/installer-lazy-load-feasibility.md）。
 *   cypher 的 `stripped.services=13` 標記沿用 Arcrun 那邊成品自帶的 metadata。
 *
 * 用法：ARCRUN_REPO_ROOT=/path/to/Arcrun node build-bundles.mjs [--out bundles]
 *   要求：ARCRUN_REPO_ROOT 底下已經跑過 `node scripts/build-worker-artifacts.mjs`，
 *   即 `.worker-builds/manifest.json` 存在——本檔找不到就誠實中止，不會退回自己編譯
 *   （沒有「A/B 兩條路可選」，只有這一條，見 arcrun-rag#39 comment 845）。
 * 輸出：<out>/<worker>/worker.mjs (+ *.wasm)；<out>/manifest.json
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { CORE_COMPONENTS, BUNDLE_COMPONENT_NAMES } from './bundle-components.mjs';
import { requireFreshArtifacts } from './artifact-freshness.mjs';

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

/** Arcrun 官方成品的固定位置——見 Arcrun repo `scripts/build-worker-artifacts.mjs`。
 *  本檔的「安裝器 name」（`arcrun-cypher-executor` 等）與 Arcrun 那邊的成品 name
 *  是同一套字面值（兩邊都照 `arcrun-<kebab>` 命名），直接對得上，不需要額外映射表。 */
const ARTIFACTS_DIR = join(REPO, '.worker-builds');
const ARTIFACTS_MANIFEST = join(ARTIFACTS_DIR, 'manifest.json');

// ── 🔴 落後閘（t173，2026-08-02；2026-08-11 改看 .worker-builds，邏輯不變）──
//
// 病史（同一天三個症狀、同一個根因）：見原版註解——打包分支若落後 main，就是在把
// 修好的東西推回舊版。過去檢查的是「原始碼目錄落後 main」；現在編譯搬去 Arcrun 那邊後，
// 本檔真正依賴的只剩 `.worker-builds/`——這個 clone 的 `.worker-builds` 若落後它自己的
// main，代表你正在用一份過時的官方成品打包，同一個病换了個位置重演。
function assertNotBehindMain(repoRoot) {
  if (process.env.BUILD_ALLOW_BEHIND === '1') {
    console.warn('⚠️ BUILD_ALLOW_BEHIND=1：跳過落後檢查（請在 commit 說明理由）');
    return;
  }
  try {
    const out = execSync(
      `git -C ${JSON.stringify(repoRoot)} log --oneline HEAD..main -- .worker-builds`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return;
    const commits = out.split('\n');
    console.error('\n❌ 打包中止：**這個 Arcrun clone 的 .worker-builds 落後它自己的 main**（t173 的病，換了位置重演）\n');
    console.error(`   落後 ${commits.length} 個 commit：`);
    for (const c of commits.slice(0, 8)) console.error(`     ${c}`);
    if (commits.length > 8) console.error(`     …還有 ${commits.length - 8} 個`);
    console.error('\n修法：在 ARCRUN_REPO_ROOT 那個 clone 跑 `git merge main`（或重新 pull 到最新 main），再打包。');
    console.error('明知故犯：BUILD_ALLOW_BEHIND=1（要在 commit 說明理由）。\n');
    process.exit(1);
  } catch {
    /* 沒有 main／非 git（CI 淺 clone）⇒ 不擋 */
  }
}

/** 從 Arcrun 官方成品複製一顆到本檔輸出目錄——**取代舊版的 esbuild buildOne()**。
 *  不重新編譯，只搬運 + 補上安裝器層需要的欄位。找不到官方成品＝硬停，不退回自己編。 */
function copyOne(w, artifactByName) {
  const artifact = artifactByName.get(w.name);
  if (!artifact) {
    throw new Error(
      `Arcrun 官方成品沒有 ${w.name}（.worker-builds/manifest.json 缺這一筆）——` +
      `這不是本檔的職責範圍，去 Arcrun repo 補上 scripts/build-worker-artifacts.mjs 的 WORKERS 清單`,
    );
  }
  const srcDir = join(ARTIFACTS_DIR, w.name);
  const outDir = join(OUT, w.name);
  mkdirSync(outDir, { recursive: true });

  const srcMain = join(srcDir, artifact.main_module || 'worker.mjs');
  if (!existsSync(srcMain)) throw new Error(`官方成品缺主檔: ${srcMain}`);
  copyFileSync(srcMain, join(outDir, 'worker.mjs'));

  const modules = [];
  for (const m of artifact.modules || []) {
    const srcWasm = join(ARTIFACTS_DIR, m.file || join(w.name, m.name));
    if (!existsSync(srcWasm)) throw new Error(`官方成品缺 wasm part: ${srcWasm}`);
    copyFileSync(srcWasm, join(outDir, m.name));
    modules.push({ name: m.name, type: m.type, file: `${w.name}/${m.name}` });
  }

  const jsSize = artifact.js_bytes ?? readFileSync(join(outDir, 'worker.mjs')).length;
  return {
    name: w.name,
    canonical: w.canonical,
    main_module: 'worker.mjs',
    main_file: `${w.name}/worker.mjs`,
    js_bytes: jsSize,
    modules,
    compat_date: artifact.compat_date,
    compat_flags: artifact.compat_flags,
    // binding 需求（安裝器據此把「已建的資源 id」對上）——直接沿用官方成品算好的 requires，
    // 不在本檔重新解析 wrangler.toml（單一真相源＝Arcrun 那邊的建置腳本）。
    requires: artifact.requires,
    stripped: w.stripServices ? { services: 13 } : undefined,
    // 每顆的來源答到單顆層級（Arcrun#80 的核心要求）——不再是整包一個 source 欄位。
    source_commit: artifact.source_commit || null,
    source_content_sha256: artifact.content_sha256 || null,
  };
}

async function main() {
  // t173 落後閘：先擋，再做任何事——產物生成後才發現就太晚了
  assertNotBehindMain(REPO);

  if (!existsSync(ARTIFACTS_MANIFEST)) {
    console.error(`\n❌ 找不到 Arcrun 官方成品 manifest：${ARTIFACTS_MANIFEST}`);
    console.error('   本檔不會退回自己 esbuild（那正是 arcrun-rag#39 要拔掉的病）。');
    console.error('   先在 ARCRUN_REPO_ROOT 那個 clone 跑：node scripts/build-worker-artifacts.mjs\n');
    process.exit(1);
  }
  const artifactManifest = JSON.parse(readFileSync(ARTIFACTS_MANIFEST, 'utf8'));
  if (artifactManifest.repo_dirty) {
    console.error(`\n❌ Arcrun 官方成品是從一個不乾淨的工作區編出來的（repo_dirty=true）——`);
    console.error('   這種成品的來源不可信（"這一版從哪來" 答不出來），不打包。');
    console.error('   先在 ARCRUN_REPO_ROOT 那個 clone commit 乾淨後重新跑 build-worker-artifacts.mjs。\n');
    process.exit(1);
  }
  const artifactByName = new Map((artifactManifest.workers || []).map((w) => [w.name, w]));
  console.log(`✔ 讀到 Arcrun 官方成品：Arcrun@${(artifactManifest.repo_head || '').slice(0, 8)}（${artifactByName.size} 顆可用）`);

  // ── 🔴 新鮮度閘（Leo/Arcrun#93，2026-08-12）──────────────────────────────
  //
  // 上面那道 assertNotBehindMain() 問的是「我這個 clone 是不是拿到最新的成品」；
  // 這道問的是**「這批成品是不是還算數」**——兩個問題不同，08-12 出事的是後者：
  // 併完 Arcrun#85／#88 之後沒有人重編，`.worker-builds` 目錄因此**完全沒動過**
  // ⇒ 落後閘無話可說地放行，而 cypher-executor（797e7f7 vs 525faaf）與
  //    kbdb（a7e23ba vs 3eb8b31）送出去的都是舊執行檔。是人工逐顆比才發現的。
  //
  // 擺在這裡而不是更後面：**產物生成後才發現就太晚了**（同 t173 落後閘的理由）。
  const fresh = requireFreshArtifacts({
    repo: REPO,
    manifest: artifactManifest,
    components: CORE,
    allowDirty: process.env.ARTIFACT_ALLOW_DIRTY_SOURCE === '1',
  });
  if (fresh.ok) console.log(`✔ 成品新鮮度：${fresh.results.length} 顆的 source_commit 都還等於它源碼目錄的現況`);

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
  //    ⇒ 只清「本次重建的那幾個目錄」，不碰別人的東西。
  mkdirSync(OUT, { recursive: true });
  for (const w of CORE) {
    const d = join(OUT, w.name);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }

  // 🔴 2026-08-11：source 現在直接來自 Arcrun 官方成品的 repo_head，
  //   不再靠本檔自己 git-inspect ARCRUN_REPO_ROOT（那個 clone 的當下狀態可能跟
  //   .worker-builds 實際編出來的那次不同步；官方成品自己記的 repo_head 才是
  //   「這批位元組真正是哪個 commit 編的」）。
  const sourceRef = artifactManifest.repo_head ? `Arcrun@${artifactManifest.repo_head.slice(0, 12)}` : '';

  const manifest = { schema: 1, built_for: 'oauth-installer-lazy-load', core: [], notes: [] };
  if (sourceRef) manifest.source = sourceRef;
  for (const w of CORE) {
    try {
      const entry = copyOne(w, artifactByName);
      manifest.core.push(entry);
      const wasmNote = entry.modules.length ? ` +${entry.modules.length} wasm` : '';
      console.log(`✔ ${w.name}  js=${(entry.js_bytes / 1024).toFixed(0)}KB${wasmNote}  source=${(entry.source_commit || '').slice(0, 8)}`);
    } catch (e) {
      manifest.notes.push(`FAILED ${w.name}: ${e.message}`);
      console.error(`✗ ${w.name}: ${e.message}`);
    }
  }
  // 🔴 2026-08-05（leo 出貨時實撞）：先讀既有 manifest，只覆寫本次重建的欄位，其餘原樣保留。
  const merged = { ...prevManifest, ...manifest };
  // 🔴 2026-08-05 三修 + 2026-08-09 四修（arcrun-rag#27）：只沿用「舊 manifest 有、
  //    不屬於本腳本 CORE、且在 BUNDLE_COMPONENT_NAMES 清單上、且檔案確實還在」的條目
  //    （＝ portal 前端 arcrun-rag-ui）。清單上沒有的，一律不進 manifest——棘輪拆掉。
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
