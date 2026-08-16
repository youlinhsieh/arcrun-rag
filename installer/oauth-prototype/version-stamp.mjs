/**
 * version-stamp.mjs — 「這台實例跑的是哪一份碼」這個印記，整個 `installer/` 只准有一份算法。
 *
 * ── 為什麼有這支（Arcrun#106 的另一半，2026-08-16）────────────────────────────
 * 本票先修好了 `acr` 那條路：更新時**沿用**使用者實例上的設定 var、**重烙**版本標籤，
 * 而且把「真的部了哪個 commit」一起烙上去（`cli/src/lib/deploy.ts` 的 `resolveBundleStamp`
 * ＋ `CLI_MANAGED_VARS`）。理由寫在那支的註解裡，一句話是：
 *
 *   **版號是「發行頻道的編號」，commit 才是「真的部了哪份碼」——兩個一起看，
 *     才有辦法查「標籤有沒有跟成品漂掉」。**
 *
 * 安裝器這條路只烙了版號、沒烙 commit。結果 2026-08-16 leo 實撞：
 *
 * ```
 *                    更新前                    更新後（跑過 prod 安裝器）
 *   youlin            1.4.47 + commit d7a98f53  1.4.46 + commit 欄位消失
 *   geek6688          1.4.47 + commit d7a98f53  1.4.46 + commit 欄位消失
 *   leo21c（沒更新過） 1.4.46 + 從來就沒有 commit
 * ```
 *
 * ⇒ 那個「用來查標籤有沒有漂掉」的欄位，**恰好被唯一會貼標籤的那條路洗掉**
 * ⇒ 三台報同一個版號，而**沒有任何方法查出它們是不是同一份碼**。
 * leo：「這太可怕了。」——他是對的：所有「我驗過了」的說法底下都少了一塊地板。
 *
 * ── 這支的三條判準 ───────────────────────────────────────────────────────────
 * ① **兩個印記綁在一起**：`versionStampVars()` 是唯一產地，呼叫端拿到什麼就寫什麼，
 *    不准任何一條部署路徑自己拼「只寫版本不寫 commit」。
 *    機械閘＝`installer/scripts/version-stamp-gate.mjs`（凡寫版本處必寫 commit，違者出貨前擋下）。
 * ② **查不到就不要貼，不要編一個**。本 repo 有前科（worker.js t144）：
 *    一次安裝用了**捏造的 commit 碼**，失敗前已經把假版本號寫進實例，
 *    之後每次重裝都被「指紋一致」判成跳過 ⇒ 版本號永遠停在那個不存在的 commit。
 *    ⇒ 所以來源解析不出合法的 sha 時回空字串，呼叫端**少貼一個標籤**，
 *    **絕不讓安裝失敗、也絕不填一個看起來像 sha 的東西**。
 * ③ **比對用前綴，不用字串相等**：`acr` 那條烙 40 碼全 sha（Gitea archive 解出來的），
 *    安裝器這條烙 manifest 的 `source`（`Arcrun@` + 12 碼）。同一顆 commit 兩種長度，
 *    用 `===` 比會判成「不同的碼」⇒ 每次都全量重推。`commitsAgree()` 把這件事收在一處。
 *
 * 零依賴、純函式：這支會被 `worker.js`（跑在 CF Worker 上）import，
 * 所以**不准 import 任何 node: 模組**（那會讓 wrangler 打包失敗）。
 */

/**
 * 需要版本印記的 worker。
 *
 * cypher ＝ `/health` 吐 `bundle_version` / `bundle_commit` 的那顆（Portal 版本卡、
 *           daemon `cloudVersionStale()`、安裝器 `probeInstanceStale()` 都讀它）。
 * ui     ＝ `/__version` 自報版本的那顆（t170：只給 cypher 會讓「比版本」這個判準沒有牙齒）。
 *
 * ⚠️ 誠實限制：UI 的 `/__version` 目前**只吐 `bundle_version`，不吐 commit**
 *    （那條路由在 Arcrun 的 `scripts/build-ui-worker.mjs`，不在本 repo）。
 *    所以 UI 身上的 `ARCRUN_BUNDLE_COMMIT` 現在只有從 Cloudflare API 讀 worker settings
 *    才看得到。仍然要烙——印記的用途是「事後查得出這顆是哪份碼」，
 *    而不是「現在有沒有人在讀它」；且兩顆規則一致，機械閘才守得住。
 */
export function isStampTarget(name) {
  return Boolean(name) && (String(name).includes('cypher') || String(name) === 'arcrun-rag-ui');
}

/**
 * 從 bundle manifest 的 `source` 欄解出 Arcrun 原始碼 commit。
 *
 * manifest 由 `installer/scripts/build-bundles.mjs` 產生，格式固定是
 * `Arcrun@<12 碼>`（值來自 Arcrun 官方成品 manifest 的 `repo_head`——
 * 「這批位元組真正是哪個 commit 編的」）。實測 prod 1.4.46 ＝ `Arcrun@cacaa33f7d4e`。
 *
 * 🔴 解不出合法 sha 一律回 `''`（舊 bundle 沒有 `source` 欄就是這種情況）。
 * 回空字串的意思是「**這趟不貼 commit**」，不是「安裝失敗」——見檔頭判準②。
 *
 * @param {string|{source?:string}|null|undefined} source manifest 物件或它的 `source` 字串
 * @returns {string} 小寫 hex sha（7–40 碼），或 `''`
 */
export function sourceCommitOf(source) {
  const raw = typeof source === 'string' ? source : (source && source.source) || '';
  const m = String(raw).match(/(?:^|@)([0-9a-fA-F]{7,40})$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 這趟部署要烙上去的兩個印記。**唯一產地。**
 *
 * 版號（`ARCRUN_BUNDLE_VERSION`）的算法原樣保留既有規則，不在本次動它：
 *   · 有 `manifest.release`（semver，例 `1.4.46`）→ 就用它
 *     ——Portal 版本卡拿它跟 `/api/latest` 的 release 比，兩邊必須同格式才比得動。
 *   · 舊 bundle 沒有 release 欄 → 退回 `建置日+釘點短碼`
 *     （Portal 會判成「較舊版本」＝落後，那正是我們要的：舊實例本來就該被提示更新）。
 *
 * commit（`ARCRUN_BUNDLE_COMMIT`）＝這批位元組是哪顆 Arcrun commit 編的。
 * **解不出來就整個欄位不存在**，不塞空字串——與 cypher `/health` 的既有慣例一致
 * （`...(bundleVersion ? { bundle_version } : {})`：沒有就不吐這一欄，不吐假的）。
 *
 * @param {{release?:string, built?:string, pinCommit?:string, sourceCommit?:string}} o
 * @returns {{ARCRUN_BUNDLE_VERSION:string, ARCRUN_BUNDLE_COMMIT?:string}}
 */
export function versionStampVars({ release, built, pinCommit, sourceCommit } = {}) {
  const version = release
    ? String(release)
    : (built ? String(built) : '') + '+' + (pinCommit || 'unknown');
  const commit = sourceCommitOf(sourceCommit);
  return {
    ARCRUN_BUNDLE_VERSION: version,
    ...(commit ? { ARCRUN_BUNDLE_COMMIT: commit } : {}),
  };
}

/**
 * 兩個 commit 印記講的是不是同一顆。
 *
 * 為什麼不是 `a === b`：兩條部署路徑烙的長度不同（`acr` 40 碼／安裝器 12 碼），
 * 而它們**本來就該互相比對得動**——那正是本票的目標。所以規則是
 * 「都合法、且短的是長的前綴」。任一邊空／不是 hex ⇒ 比不動，回 `false`
 * （fail-stale：比不動一律當「不一樣」，寧可多推一次，不可把不同的碼當成一樣）。
 */
export function commitsAgree(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(x) || !/^[0-9a-f]{7,40}$/.test(y)) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short);
}
