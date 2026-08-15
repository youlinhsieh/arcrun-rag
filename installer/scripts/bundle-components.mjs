/**
 * bundle-components.mjs — **一個 bundle 裡有什麼**的唯一定義。
 *
 * 現在它回答的是三個問題，不是一個：
 *   公庫（library）      這一版 Arcrun 編出來的**全部**零件，通通放進 bundle repo。
 *   首裝（first install） 安裝器真的會部署的那幾顆（`manifest.core`）＝**現階段就是公庫全部**。
 *   懶載（lazy）         公庫 − 首裝＝現階段是空的。
 *
 * 🔴 都不是人寫的清單：
 *   公庫 ＝ 讀 Arcrun `.worker-builds/manifest.json`（D91：成品只有一個產地）
 *   首裝 ＝ 公庫全部。leo 2026-08-15：「所有的零件也只有幾十個，量很少，我們只是希望
 *          啟動不要等太久，但**全裝上也不會太大，沒必要刪除**。」
 *   另外**推導**一份「這次帶的工作流證明需要哪幾顆」（`first-install-set.mjs`），
 *   角色是**證明首裝沒有漏**——leo：「不是設計一個清單，是設計工作流。」
 *
 * ⚖️ **代價不對稱**：漏裝是 bug（2026-08-14 實證：打死整個產品）；多裝只是多等一下下。
 *   所以推導的目的是「不會漏」，**不是「裝得少」**；有疑慮時往「裝上去」倒。
 *   「哪些可以延後以縮短首裝等待」是第二階段的優化。
 *
 * ⚠️ **「用到才下載」的觸發還沒有實作**（Arcrun#125 第二階段）。現況是「貨齊了、清單算得出來」，
 *   還缺「執行期跑同一條推導、把缺的裝上」那一段。在它落地之前，不要把懶載講成已經會動。
 *
 * ── 為什麼從「一份手寫清單」改成這樣（2026-08-14／15，Arcrun#125）──────────────
 * leo：「懶載一定要包含 ingest，這是它的基本功能，沒有它就只是 Arcrun，有它才是 Arcrun RAG。」
 *      「一切零件由 Arcrun 包好，而不是出貨時 build」「下載就給個清單觸發下載」
 *
 * 舊版這裡是一份手寫的 6 顆清單，它同時扮演公庫與首裝兩個角色。後果：
 *   ① 解憑證那顆不在清單上 ⇒ 每支產品工作流一遇到 `{{credential.…}}` 就去 fetch
 *      一顆不存在的 worker ⇒ `error code: 1042` ⇒ **ingest 與查詢全死**（Arcrun#124）。
 *      而那份清單**沒有任何辦法自己知道工作流需要什麼**——不是誰忘了寫。
 *   ② 清單以外的零件根本不在 bundle 裡 ⇒ 「用到才下載」**沒有貨可以下載**，
 *      於是那句話只是一段註解（stage 有一份 1.4.17 播種的舊 `tier1/`，prod 連那個都沒有）。
 *
 * ── 舊版留下、仍然成立的那一條（arcrun-rag#27／D48）────────────────────────────
 * leo 2026-08-09：「如果都相同，我測試一次安裝，就發現 5 顆變 24 顆。**如果是複製，為什麼不一致？**」
 * 真兇是**棘輪**：東西一旦掉進 bundle 目錄就永遠留著，沒有任何路徑會把它拿掉。
 * 那條教訓在新模型下更強：公庫、首裝兩份名單都由機器算出來，
 * `ship.mjs` 的 parity 站再拿同一份算式夾住結果——多一顆少一顆都當場失敗。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstInstallSet,
  loadInstallerPlaceholders,
  loadRecipeIds,
} from './first-install-set.mjs';

/**
 * bundle 裡的擺放位置。
 *
 * 預設＝`<worker 名>/worker.mjs`（與 Arcrun 成品目錄同構，最少驚喜）。
 * 唯一的例外是 portal 前端：它從第一天就住在 `tier2/ui/index.js`，
 * 而**安裝器、bundle repo 的 README、驗收腳本都照那個路徑寫死過**。
 * 搬它不會讓任何事情更對，只會在這次改動裡多一個會壞的地方 ⇒ 明文留成例外。
 */
const LAYOUT_OVERRIDE = {
  'arcrun-rag-ui': { relDir: 'tier2/ui', mainName: 'index.js' },
};

/** 這顆零件在 bundle 裡的相對位置。 */
export function layoutFor(name) {
  return LAYOUT_OVERRIDE[name] || { relDir: name, mainName: 'worker.mjs' };
}

/** 讀 Arcrun 官方成品 manifest（公庫的真相源）。 */
export function readArtifactManifest(arcrunRepoRoot) {
  return JSON.parse(readFileSync(join(arcrunRepoRoot, '.worker-builds', 'manifest.json'), 'utf8'));
}

/**
 * 算出這一版 bundle 的完整計畫。
 *
 * @param {{ arcrunRepo: string, repoRoot: string, artifactManifest?: object }} opts
 *   `repoRoot` ＝ arcrun-rag 的 repo 根（用來找出貨的那顆安裝器與它會推的工作流）
 * @returns {{ artifactManifest: object, library: string[], firstInstall: string[],
 *             lazy: string[], reasons: Array<{worker:string,why:string}>, warnings: string[] }}
 */
export function resolveBundlePlan({ arcrunRepo, repoRoot, artifactManifest }) {
  const artifacts = artifactManifest || readArtifactManifest(arcrunRepo);
  const library = (artifacts.workers || []).map((w) => w.name).sort();

  // 出貨的那顆安裝器＝`installer/oauth-prototype/`（見 installer/ship.targets.json）。
  // 首裝清單必須照**它**會推的工作流與**它**的佔位符代換表來算，不是照別的副本。
  const installerSrc = join(repoRoot, 'installer', 'oauth-prototype', 'worker.js');
  const workflowsJson = join(repoRoot, 'installer', 'oauth-prototype', 'workflows.json');

  const placeholders = loadInstallerPlaceholders(installerSrc);
  const recipes = loadRecipeIds(arcrunRepo);
  const workflows = JSON.parse(readFileSync(workflowsJson, 'utf8'));

  // 🔴 leo 2026-08-15：「**第一次安裝到底需要哪些零件，就看裡面有哪些工作流，
  //   不是設計一個清單，是設計工作流。**」
  //
  // ⇒ 這份推導**不是被寫下來的，是被算出來的**：加一支工作流，它要的零件自動出現在結果裡。
  //   它的用途是**證明首裝沒有漏**（見下面 uncovered 那道閘），不是拿來刪東西
  //   ——「哪些可以不裝」是第二階段的優化，見下一段 leo 的補述。
  //
  // ⚠️ 推導必須抓得到**隱含依賴**，不只節點型別——2026-08-14 打死整個產品的
  //   `auth_static_key`，工作流對它的依賴寫在 `{{credential.X}}` 這種參照裡，
  //   不在任何節點的型別上。只掃節點型別會產出一份「看起來很合理、卻漏掉關鍵那顆」的清單，
  //   跟出事的那份一模一樣。`first-install-set.mjs` 的自我檢查就是：它必須出現在結果裡。
  const { names: required, reasons, warnings } = firstInstallSet(workflows, {
    placeholders,
    recipes,
    library: new Set(library),
  });

  // 🔴 leo 2026-08-15（推導的目的是「不會漏」，不是「裝得少」）：
  //   「這個有考量，因為**所有的零件也只有幾十個，量很少**，
  //     我們只是希望**啟動不要等太久**，但**全裝上也不會太大，沒必要刪除**。」
  //
  // ⇒ **代價不對稱**：漏裝是 bug（2026-08-14 實證：打死整個產品）；多裝只是多等一下下。
  //   有疑慮時往「裝上去」倒。所以首裝＝公庫全部，而推導的角色是**證明沒有漏**。
  //
  // 「哪些可以延後到用到才裝、以縮短首裝等待」是第二階段的優化，不是現在要解的題。
  const firstInstall = [...library];
  const uncovered = required.filter((n) => !firstInstall.includes(n));
  if (uncovered.length) {
    throw new Error(
      `首裝清單漏了工作流證明需要的零件：${uncovered.join('、')}\n` +
      `  ⇒ 這正是 2026-08-14 那台「裝完什麼都不能做」的實例的成因（Arcrun#124／#125）。`);
  }

  // 公庫 − 首裝。現階段是空的（全裝）。
  // 🔴 **「用到才下載」的觸發沒有實作**（Arcrun#125 第二階段）。留這個欄位是為了讓
  //   「哪些不進首裝」有地方講，**不是**在暗示機制已經存在。
  const lazy = library.filter((n) => !firstInstall.includes(n));
  return { artifactManifest: artifacts, library, firstInstall, lazy, required, reasons, warnings };
}

/**
 * 把一份 manifest 與計畫對帳（`ship.mjs` 的 parity 站用）。
 *
 * 兩件事一起驗，因為它們壞掉的樣子不同：
 *   `core`    少一顆 ⇒ 裝完不能用（Arcrun#124）
 *   `library` 少一顆 ⇒ 這一版少帶了一顆零件；多一顆 ⇒ 棘輪殘留（08-09 那 19 顆的病）
 */
export function diffAgainstPlan(manifest, plan) {
  const nameSet = (arr) => new Set((arr || []).map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean));

  const haveCore = nameSet(manifest.core);
  const wantCore = new Set(plan.firstInstall);
  const coreMissing = plan.firstInstall.filter((n) => !haveCore.has(n));
  const coreExtra = [...haveCore].filter((n) => !wantCore.has(n));

  const haveLib = nameSet(manifest.library);
  const wantLib = new Set(plan.library);
  const libMissing = plan.library.filter((n) => !haveLib.has(n));
  const libExtra = [...haveLib].filter((n) => !wantLib.has(n));

  return {
    coreMissing, coreExtra, libMissing, libExtra,
    ok: !coreMissing.length && !coreExtra.length && !libMissing.length && !libExtra.length,
  };
}
