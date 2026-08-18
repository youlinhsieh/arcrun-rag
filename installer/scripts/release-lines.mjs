/**
 * release-lines.mjs — 「這一次出貨，把**哪幾條版本線**送到使用者手上」的唯一真相源。
 *
 * ── 這支為什麼存在（inkstone/arcrun-rag#88，2026-08-18）──────────────────────
 * 出貨線一直把「版本發佈」當成**這一趟出貨的屬性**（一趟出貨＝一筆 release），
 * 而不是**這趟出貨送出去的每一條版本線各自的屬性**。
 * `ship.mjs` 的 `release-record` 站寫死 `tag = v${ctx.release}`——`ctx.release` 是
 * 零件包版本（`1.4.x`）⇒ 桌面小幫手那條線（`0.18.x`）**從來沒有任何一站在管它有沒有被發佈**。
 *
 * 實證（`system-dev/docs/3-specs/autonomy-dispatch/github-contact-log.md` 三行同一個任務）：
 * ```
 * 2026-08-16 18:53:22  推 prod：daemon v0.18.28（三平台）＋對應零件包   → push bundles
 * 2026-08-16 18:55:28  同一個任務                                      → push 公開鏡像
 * 2026-08-16 18:55:29  同一個任務                                      → 建立 release v1.4.46
 * ```
 * 那趟出貨**明明在送 daemon v0.18.28**，而它建出來的唯一一筆 release 是 `v1.4.46`。
 * 21 站全綠。⇒ 病不在「忘了發」，在「**發佈這件事沒有以版本線為單位**」。
 *
 * ── 判準：什麼算一條「版本線」（看事實，不看關鍵字）──────────────────────────
 * 🔴 一條版本線 ＝ **使用者端真的會讀到、並據以決定「我能拿到哪一版」的那個版本號**。
 *
 * 那不是一個需要猜的東西，它有一個具體的落點：安裝器的 `GET /api/latest`
 * （`installer/oauth-prototype/worker.js`）——安裝頁與桌面小幫手的「檢查更新」都讀它。
 * 2026-08-18 實測 `https://install.arcrun.dev/api/latest`：
 * ```
 * { "release": "1.4.46", "daemon": { "version": "v0.18.28", … } }
 * ```
 * **兩個版本號，兩條線。** 這就是本檔 `LINES` 的來源，不是誰拍腦袋列的清單。
 *
 * 🔴 為什麼不用「掃 manifest 裡長得像版本號的字串」：manifest 裡還有
 * `promoted_from.release`（`1.4.33`，2026-08-11 拆 promoteFrom 後留下的歷史紀錄），
 * 它長得跟版本號一模一樣，但**沒有任何使用者會拿到它**——照字串掃會把它當成
 * 「第三條沒發佈的線」而誤擋。⇒ 判準要問「**使用者端讀不讀得到**」，不是「長不長得像」。
 * 這正是本票紅線點名的那件事：不要做成字串比對。
 *
 * ── 對外命名（leo 2026-08-17 拍板，見 InkStoneCo `system-dev/wiki/ops-facts.md`）────
 * ```
 * tag    裸號，不帶 v      1.4.47                0.18.29
 * 標題   產品名 ＋ 裸號    Arcrun RAG 1.4.47     桌面小幫手 0.18.29
 * ```
 * leo：「不要 v」「對外號就是三個數字」。既有 10 個帶 `v` 的 tag **不回頭改**
 * （改 tag 會斷連結）⇒ 過渡期兩種寫法並存是**已知且刻意的**，所以 `tagMatches()`
 * 兩種都認得——否則這道閘會把已經發過的舊版誤判成「沒發」。
 */

/** 版本號的形狀（`1.4.46`／`v0.18.28` 都算）。只用在**驗證**與**正規化**，不用來探勘欄位。 */
export const VERSION_RE = /^v?\d+\.\d+\.\d+$/;

/**
 * 兩條版本線。`latestPath` 是它在 `GET /api/latest` 回應裡的位置——
 * **那個位置就是「使用者讀得到」的定義**，不是註解，是可以拿真的回應去對的欄位路徑。
 * `manifestPath` 是同一條線在 bundle `manifest.json` 裡的位置（離線時的同一個事實）。
 */
export const LINES = [
  {
    id: 'bundle',
    product: 'Arcrun RAG',
    label: '零件包（使用者的 Cloudflare 帳號上跑的那些 worker）',
    latestPath: ['release'],
    manifestPath: ['release'],
  },
  {
    id: 'daemon',
    product: '桌面小幫手',
    label: '桌面小幫手（使用者電腦上那支 App，按「檢查更新」拿到的就是它）',
    latestPath: ['daemon', 'version'],
    manifestPath: ['daemon', 'version'],
  },
];

/** 依路徑取值，中途缺任何一層就回 undefined（不丟例外——「這個 payload 沒有這條線」是合法狀態）。 */
export function at(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** 去掉開頭的 `v`——對外號就是三個數字（leo 2026-08-17）。 */
export function bareVersion(v) {
  return String(v == null ? '' : v).replace(/^v/, '');
}

/** 新 release 的 tag：一律裸號。 */
export function releaseTagFor(version) {
  return bareVersion(version);
}

/** 新 release 的標題：產品名 ＋ 裸號（兩條線並排在同一頁，沒有產品名就分不出誰是誰）。 */
export function releaseTitleFor(product, version) {
  return `${product} ${bareVersion(version)}`;
}

/**
 * 這個 tag 是不是「這一版的 release」。
 * 🔴 `v1.4.46` 與 `1.4.46` 都算數——既有 10 個舊 tag 帶 `v` 且不回頭改，
 * 不認它們的話這道閘會把**已經發過的版本**判成沒發，變成永遠擋著的假警報。
 */
export function tagMatches(tag, version) {
  return bareVersion(tag) === bareVersion(version) && bareVersion(version) !== '';
}

/**
 * 從一份 payload（`/api/latest` 回應，或 bundle manifest）讀出這次交付的所有版本線。
 * @param {object} payload
 * @param {'latest'|'manifest'} kind 決定用哪組欄位路徑
 * @returns {{id,product,label,version,tag,title,path:string}[]} 只回**這份 payload 真的有值**的線
 */
export function linesFrom(payload, kind = 'latest') {
  const key = kind === 'manifest' ? 'manifestPath' : 'latestPath';
  const out = [];
  for (const line of LINES) {
    const version = at(payload, line[key]);
    if (!version) continue;
    out.push({
      id: line.id,
      product: line.product,
      label: line.label,
      version,
      tag: releaseTagFor(version),
      title: releaseTitleFor(line.product, version),
      path: line[key].join('.'),
    });
  }
  return out;
}

/**
 * 掃出這份 payload 裡**所有**版本號欄位（含尚未被宣告成版本線的）。
 *
 * 這一支是「有人加了第三條線卻沒人發佈它」的偵測器：`/api/latest` 是使用者端的
 * 交付面，任何在那裡露出的版本號，就是有人會據以判斷「我能拿到什麼」的東西
 * ⇒ 它必須有一筆對應的版本發佈。掃描只走 `/api/latest` 這份回應（不是 manifest），
 * 因為交付面才是判準；manifest 裡的內部帳（`promoted_from`）本來就不在這裡。
 *
 * @returns {{path:string, version:string}[]}
 */
export function versionFieldsIn(payload) {
  const out = [];
  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (VERSION_RE.test(node)) out.push({ path: trail.join('.'), version: node });
      return;
    }
    // 陣列＝清單（零件庫、notes…），不是版本線的住處；進去掃只會撈到零件各自的版本。
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) walk(v, [...trail, k]);
  };
  walk(payload, []);
  return out;
}

/** 已宣告成版本線的欄位路徑集合（`/api/latest` 座標系）。 */
export function declaredLatestPaths() {
  return new Set(LINES.map((l) => l.latestPath.join('.')));
}

/**
 * 交付面上**露出了版本號、卻沒有人負責發佈它**的欄位。
 * 非空 ＝ 有一條線在沒人看管的情況下送到使用者手上。
 * @returns {{path:string, version:string}[]}
 */
export function undeclaredVersionFields(latestPayload) {
  const declared = declaredLatestPaths();
  return versionFieldsIn(latestPayload).filter((f) => !declared.has(f.path));
}
