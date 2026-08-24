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
 * ── 這個 bundle 裡有什麼（2026-08-15 改，Arcrun#125）───────────────────────────
 *   **公庫**：這一版 Arcrun 編出來的**全部**零件，通通複製進來。
 *   **首裝**：`manifest.core`——安裝器真的會部署的那幾顆。
 *   **懶載**：公庫 − 首裝。它們的檔案**就在這個 bundle 裡**，所以「用到才下載」有貨可載。
 *   三份名單都由 `bundle-components.mjs` 算出來，沒有人在維護清單。
 *
 * 🔴 這段以前寫的是「首裝 4 顆核心，13 個邏輯零件用到才長」。
 *   前半是真的，後半**沒有任何實作，而且那些零件根本不在 bundle 裡**
 *   ⇒ 有人（包括 AI）照著這句話把解憑證那顆排除在首裝之外，於是 2026-08-14
 *     凡走網頁安裝器裝出來的實例，工作流一跑就 500（Arcrun#124／#125）。
 *   leo：「留著一個描述不存在機制的註解，比沒有註解更糟。」——這就是那次的物證。
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
import { resolveBundlePlan, layoutFor } from './bundle-components.mjs';
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

/** arcrun-rag 這個 repo 的根（找出貨的那顆安裝器與它會推的工作流用）。 */
const RAG_REPO_ROOT = join(import.meta.dirname, '..', '..');

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
function copyOne(name, artifactByName) {
  const artifact = artifactByName.get(name);
  if (!artifact) {
    throw new Error(
      `Arcrun 官方成品沒有 ${name}（.worker-builds/manifest.json 缺這一筆）——` +
      `這不是本檔的職責範圍，去 Arcrun repo 跑 scripts/build-worker-artifacts.mjs`,
    );
  }
  const { relDir, mainName } = layoutFor(name);
  const srcDir = join(ARTIFACTS_DIR, name);
  const outDir = join(OUT, relDir);
  mkdirSync(outDir, { recursive: true });

  const srcMain = join(srcDir, artifact.main_module || 'worker.mjs');
  if (!existsSync(srcMain)) throw new Error(`官方成品缺主檔: ${srcMain}`);
  copyFileSync(srcMain, join(outDir, mainName));

  const modules = [];
  for (const m of artifact.modules || []) {
    const srcWasm = join(ARTIFACTS_DIR, m.file || join(name, m.name));
    if (!existsSync(srcWasm)) throw new Error(`官方成品缺 wasm part: ${srcWasm}`);
    copyFileSync(srcWasm, join(outDir, m.name));
    modules.push({ name: m.name, type: m.type, file: `${relDir}/${m.name}` });
  }

  const jsSize = artifact.js_bytes ?? readFileSync(join(outDir, mainName)).length;
  return {
    name,
    main_module: mainName,
    main_file: `${relDir}/${mainName}`,
    js_bytes: jsSize,
    modules,
    compat_date: artifact.compat_date,
    compat_flags: artifact.compat_flags,
    // binding 需求（安裝器據此把「已建的資源 id」對上）——直接沿用官方成品算好的 requires，
    // 不在本檔重新解析 wrangler.toml（單一真相源＝Arcrun 那邊的建置腳本）。
    requires: artifact.requires,
    // 🔴 `stripped` 也照抄官方成品自己記的，不由本檔再宣告一次
    //   （再宣告一次＝多一份會跟成品不同步的說法）。
    stripped: artifact.stripped,
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
  // 這一版 bundle 的完整計畫：公庫（全部帶走）／首裝（安裝器會部署）／懶載（用到才下載）。
  // 三份名單都是算出來的，沒有人維護——見 bundle-components.mjs 檔頭。
  const plan = resolveBundlePlan({ arcrunRepo: REPO, repoRoot: RAG_REPO_ROOT, artifactManifest });
  console.log(
    `✔ 這一版：公庫 ${plan.library.length} 顆｜首裝 ${plan.firstInstall.length} 顆｜懶載 ${plan.lazy.length} 顆`);
  console.log(`   首裝：${plan.firstInstall.join('、')}`);
  for (const w of plan.warnings) console.log(`   ⚠️ ${w}`);

  const fresh = requireFreshArtifacts({
    repo: REPO,
    manifest: artifactManifest,
    components: plan.library.map((name) => ({ name })),
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
  for (const name of plan.library) {
    const d = join(OUT, layoutFor(name).relDir);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }

  // 🔴 2026-08-11：source 現在直接來自 Arcrun 官方成品的 repo_head，
  //   不再靠本檔自己 git-inspect ARCRUN_REPO_ROOT（那個 clone 的當下狀態可能跟
  //   .worker-builds 實際編出來的那次不同步；官方成品自己記的 repo_head 才是
  //   「這批位元組真正是哪個 commit 編的」）。
  const sourceRef = artifactManifest.repo_head ? `Arcrun@${artifactManifest.repo_head.slice(0, 12)}` : '';

  const manifest = {
    schema: 2,
    built_for: 'oauth-installer-lazy-load',
    // core     ＝ 安裝器真的會部署的那幾顆（首裝）
    // library  ＝ 這一版公庫的全部零件，**檔案都在這個 bundle 裡**——
    //             「用到才下載」下載的就是它們（D48：公庫永遠是全部，這台有幾顆是它自己要過幾顆）
    core: [],
    library: [],
    first_install_reasons: [],
    notes: [],
  };
  if (sourceRef) manifest.source = sourceRef;

  const firstInstall = new Set(plan.firstInstall);
  const entries = new Map();
  for (const name of plan.library) {
    try {
      const entry = copyOne(name, artifactByName);
      entries.set(name, entry);
      const wasmNote = entry.modules.length ? ` +${entry.modules.length} wasm` : '';
      const tag = firstInstall.has(name) ? '首裝' : '懶載';
      console.log(`✔ [${tag}] ${name}  js=${(entry.js_bytes / 1024).toFixed(0)}KB${wasmNote}  source=${(entry.source_commit || '').slice(0, 8)}`);
    } catch (e) {
      manifest.notes.push(`FAILED ${name}: ${e.message}`);
      console.error(`✗ ${name}: ${e.message}`);
    }
  }
  manifest.core = plan.firstInstall.map((n) => entries.get(n)).filter(Boolean);
  // 公庫條目寫**完整**的一份（含 requires／compat／wasm part）——
  // 懶載那一刻要部署它，需要的資訊與首裝完全一樣，少寫一欄就是那時候才炸。
  manifest.library = plan.library.map((n) => entries.get(n)).filter(Boolean)
    .map((e) => ({ ...e, first_install: firstInstall.has(e.name) }));
  manifest.first_install_reasons = plan.reasons;
  if (plan.warnings.length) manifest.notes.push(...plan.warnings);

  // 🔴 2026-08-05（leo 出貨時實撞）：先讀既有 manifest，只覆寫本次重建的欄位，其餘原樣保留
  //    （`daemon` 欄＝桌面 App 版本，不是本腳本產的，被吃掉會讓所有人的「檢查更新」失效）。
  const merged = { ...prevManifest, ...manifest };

  // 🔴 2026-08-24（leo 推 1.4.53 到 prod 時實撞）：**棘輪的第二個入口，在 daemon 區塊裡。**
  //    `ce3faae`（arcrun-rag#27）拆掉的是 `core` 條目那一支，立的哲學是
  //    「清單上沒有的，一律不進 manifest」——但它沒碰 daemon 區塊，
  //    而上面那個 `...prevManifest` 對 daemon 底下的**平台條目**同樣是單向棘輪：
  //    只會加、永遠不會減。prod 的 manifest 因此躺著兩筆 0.15.7 時代的東西：
  //        mac_dmg   → daemon/ArcrunRAG-mac.dmg
  //        win_msix  → daemon/ArcrunRAG-v0.15.7.msix
  //    而同一份 manifest 的 `daemon.version` 寫著 0.18.36。
  //    ⇒ **manifest 自己在說謊**：宣告這是 0.18.36，卻掛著 0.15.7 的檔。
  //    （stage 的 bundle repo 是後來新開的，從沒有過這兩筆 ⇒ **只有 prod 中招**——
  //      「只在單邊執行的路徑是共同盲區」的又一個實例，同 ship.mjs 檔頭 D65 那段。）
  //
  //    `daemon-in-bundle-gate` 掃**整個** daemon 區塊逐檔比檔名，所以它抓到了——很好，
  //    但它只能擋、清不掉。⇒ 清理要長在製造端，不是每次靠人手動刪。
  //
  //    判準沿用 #27 那條：**這一版的清單上沒有的，一律不進 manifest**。
  //    對 daemon 而言＝每個平台條目的檔名必須帶著這一版的版本號；帶不到就是上個時代的殘留。
  //    version／built／notes 不是平台條目（沒有 `file` 欄），不受影響。
  if (merged.daemon && typeof merged.daemon === 'object' && merged.daemon.version) {
    const ver = String(merged.daemon.version);
    const stale = [];
    for (const [key, val] of Object.entries(merged.daemon)) {
      if (!val || typeof val !== 'object' || typeof val.file !== 'string') continue;
      if (!val.file.includes(ver)) { stale.push(`${key} → ${val.file}`); delete merged.daemon[key]; }
    }
    if (stale.length) {
      console.log(`🧹 daemon 區塊裡不屬於 ${ver} 的殘留條目已移除 ${stale.length} 筆（棘輪殘留）：`);
      for (const s of stale) console.log(`    · ${s}`);
    }
  }
  // 🔴 棘輪拆掉（arcrun-rag#27／D48）：manifest 的內容**完全**由本次計畫決定，
  //    不再從舊 manifest 沿用任何零件條目。以前需要「沿用非本腳本產的那幾顆」，
  //    是因為 portal 前端由另一支腳本產；現在它跟其他零件走同一條路（D91），
  //    那個沿用路徑就沒有存在理由了——而它正是 08-09 那 19 顆殘留的通道。
  const prevNames = new Set((prevManifest.core || []).map((c) => c && c.name).filter(Boolean));
  const dropped = [...prevNames].filter((n) => !entries.has(n));
  if (dropped.length) {
    console.log(`🧹 上一版 manifest 有、這一版公庫沒有的 ${dropped.length} 顆已移除：${dropped.join('、')}`);
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(merged, null, 2));
  // 🔴 2026-08-02（leo：「做成自動化，不依賴你記得去更新」）：
  //    全量重建也一律走 syncManifest——版本號由內容指紋算出來，兩條 build 路徑共用同一套規則，
  //    不會再出現「走 A 路徑版本會動、走 B 路徑不會動」的漂移。
  const { syncManifest } = await import('./release.mjs');
  const { release, changed } = syncManifest(OUT, { repoRoot: join(import.meta.dirname, '..', '..') });
  console.log(
    `\nmanifest → ${join(OUT, 'manifest.json')}` +
    `（公庫 ${manifest.library.length}/${plan.library.length}、首裝 ${manifest.core.length}/${plan.firstInstall.length}）` +
    `｜版本 ${release}${changed ? '（已 bump）' : '（內容未變）'}`);
  if (manifest.library.length < plan.library.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
