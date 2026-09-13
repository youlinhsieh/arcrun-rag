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
    // 零件包沒有「一個檔」——它是幾十顆 worker。**manifest 就是那一版的定義**
    // （安裝器照它逐顆部署），所以掛它：點下去拿到的是「這一版到底裝了什麼」，
    // 不是一包誰也用不到的原始碼快照。
    assetKeys: null,
  },
  {
    id: 'daemon',
    product: '桌面小幫手',
    label: '桌面小幫手（使用者電腦上那支 App，按「檢查更新」拿到的就是它）',
    latestPath: ['daemon', 'version'],
    manifestPath: ['daemon', 'version'],
    // 🔴 明列三個鍵，**不掃整個 daemon 區塊**：manifest.daemon 底下還躺著
    // `mac_dmg`（ArcrunRAG-mac.dmg）與 `win_msix`（ArcrunRAG-v0.15.7.msix）兩筆歷史遺留，
    // 它們釘在 0.15.7，跟這一版無關。照「有 file 欄就掛」會把兩個舊檔掛到新版頁面上
    // ——那正是本輪要治的病（「看起來能下載、點下去給錯東西」）的另一種長法。
    // 加平台就在這裡加一個鍵，跟 REPO_SHORT_CODES 同一種明列哲學。
    assetKeys: ['mac', 'win', 'msix'],
    publishes: true,
  },
  {
    // ── 第三條線（inkstone/arcrun-rag#169，2026-09-01）────────────────────────
    // 由來：2026-08-31 安裝器被改掉 1640 行（`inkstone/Arcrun#190`／`#191`），
    // 而 leo 會看的每一個畫面上版本號一動也沒動——因為安裝器在出貨線上是**產出物**
    // （pin／deploy／verify 三站碰它），不是**版本線**。上面兩條的指紋都認不得它。
    id: 'installer',
    product: '安裝器',
    label: '安裝器（install.arcrun.dev 那個網站自己——按「開始安裝／更新」的那一頁）',
    latestPath: ['installer', 'version'],
    manifestPath: ['installer', 'version'],
    // 🔴 `[]` 不是 `null`：**明說這條線沒有可掛的檔**（見下面那段宣告）。
    //   寫 `null` 的話它會去掛 manifest.json——那是零件包這一版的定義，跟安裝器無關。
    assetKeys: [],

    // 🔴 **內部版本物件：照樣發，但發在內部那一側，而且不對使用者宣告。**
    //
    // ── 2026-09-02 leo 裁決，推翻本檔前一版的宣告（原文留在版控裡）─────────────
    // 前一版寫 `publishes: false`，理由是「安裝器是一個網站不是一份下載物，
    // 使用者不會選版本、也沒有成品可以掛」。leo 原話（兩段）：
    //   「**你的宣告有誤**，安裝器是 arcrun 的一部分，**什麼東西改了不用聲明**？
    //     **那是說不用告訴用戶。**」
    //   「留着補開，安裝器線不獨立發版本，它是 arcrun 的一部分，不然你把 install 放在哪個 repo？
    //     ⋯⋯不獨立發版本，但那是用戶，**我不能沒有版本，內部所有開發都要有版本**」
    //
    // 🔴 那條宣告的錯在**把兩件事講成同一句**：
    //     「使用者不會選版本」（真）　⇒　「不用發版本物件」（假）
    //   版本物件不是給使用者下載的，**是給 leo 驗收的**（規則三點七：交貨就是版本）。
    //   前一版換來的兩道閘（號碼跟得上原始碼、有寫 changelog）只保證**號碼誠實**，
    //   不保證**有一個東西可以打開來驗**——而「可以打開來驗」正是版本的定義。
    //   實害已經發生：`1.0.3` 2026-09-01 上了 prod，而 leo 當晚去 Gitea 找版本
    //   **一個都找不到**（那筆 `installer-1.0.3` 是隔天照裁決手動補開的）。
    //
    // ⇒ 現在的形狀：`publishes: 'internal'`
    //   · **發**——release-record 站照樣建一筆版本物件，不需要任何人手動補
    //   · **只發在內部主機（Gitea）**——不論這趟出貨的目標是 stage 還是 prod。
    //     「發到哪個 repo／哪台主機」照 D95 宣告在 `ship.targets.json` 的
    //     `releaseRecord.lineRepos.installer`（兩個目標都指 `inkstone/arcrun-rag` + gitea）。
    //   · **tag 帶前綴**（`installer-1.0.5`）——它跟 `1.4.63` 住同一個 repo，
    //     前綴就是「這條歷史是誰的」那個答案。leo：「不然你把 install 放在哪個 repo？」
    //   · **沒有附檔**，而這一次是**宣告的**而不是碰巧的：`assetKeys: []`。
    //     它的成品是線上跑著的那個網站 ⇒ 驗法寫進版本物件的內文（打開那頁比對
    //     版本號與原始碼指紋），不是掛一包沒有人裝得起來的原始碼快照
    //     （leo 2026-08-18 指著 release 頁問過那件事）。
    //
    // 什麼時候才需要改成 `publishes: true`（對外那一側也發）：安裝器哪天變成
    // **使用者會下載、會選版本**的東西（例如出一支離線安裝程式）。那是一件要先開票、
    // 由 leo 決定的事，不是改一個字串。
    publishes: 'internal',
    tagPrefix: 'installer-',
    whyInternal: '安裝器是 arcrun 的一部分，不是使用者會選版本的獨立產品線（leo 2026-09-02）'
      + ' ⇒ 版本物件發在內部 Gitea 的 arcrun-rag（tag 帶 `installer-` 前綴），不進對外那一側；'
      + '它沒有下載物可掛，要驗就打開線上那頁比對版本號與原始碼指紋。',
  },
];

/**
 * 這條線的版本物件**發給誰看**。三種，缺一種就會有人把「不對外」講成「不存在」
 * ——2026-09-02 leo 裁決點掉的那條錯誤宣告就是這樣長出來的。
 *   `public`   對外那一側也發（bundle／daemon）——使用者點得到、會掛成品
 *   `internal` 只發在內部主機，給 leo 與開發驗收用（installer）
 *   `none`     完全不發（今天一條都沒有；留著是讓「不發」必須被明確宣告，不是預設）
 */
export function releaseVisibility(line) {
  const id = line && line.id ? line.id : line;
  const decl = LINES.find((l) => l.id === id);
  if (!decl) return 'public';                       // 未宣告＝照既有兩條的行為
  if (decl.publishes === false) return 'none';
  if (decl.publishes === 'internal') return 'internal';
  return 'public';
}

/** 這條線會不會產生一筆版本物件（內部的也算——它一樣是「打得開的版本」）。 */
export function publishesRelease(line) {
  return releaseVisibility(line) !== 'none';
}

/** 這條線的版本物件會不會送到**使用者**那一側（＝要掛成品、要發到對外主機）。 */
export function publishesToUsers(line) {
  return releaseVisibility(line) === 'public';
}

/** 這條線為什麼只發內部（`publishes:'internal'` 才有值）。錯誤訊息與留痕都印它。 */
export function whyInternal(line) {
  const id = line && line.id ? line.id : line;
  const decl = LINES.find((l) => l.id === id);
  return (decl && decl.whyInternal) || '';
}

/**
 * 這條線的 tag 前綴（沒宣告＝沒有前綴，＝既有兩條的行為）。
 * 🔴 它不是裝飾：前綴是「同一個 repo 裡兩條歷史誰是誰」的**唯一**分辨依據，
 * 也是 release-line-gate 願意讓兩條線共用一個 repo 的條件（見該檔 checkDestination）。
 */
export function tagPrefixFor(line) {
  const id = line && line.id ? line.id : line;
  const decl = LINES.find((l) => l.id === id);
  return (decl && decl.tagPrefix) || '';
}

/**
 * 三條線的 MAJOR.MINOR **必須互不相同**。
 *
 * 為什麼要一道機械閘：`notesFromChangelog()` 是「拿版號去三份 changelog 裡找那一段」，
 * 靠的就是三條線的號碼形狀互斥（`0.18.x`／`1.0.x`／`1.4.x`）。哪天有人把
 * `installer/INSTALLER_LINE` 改成 `1.4`，出貨線會**安靜地**去零件包的 changelog 撈到
 * 別條線的段落，而且 release tag 也會撞號——兩種都不會報錯，只會給錯答案。
 * @param {Record<string,string>} lines 例 { bundle:'1.4', daemon:'0.18', installer:'1.0' }
 * @returns {string[]} 問題清單（空＝通過）
 */
export function lineCollisionProblems(lines) {
  const seen = new Map();
  const problems = [];
  for (const [id, v] of Object.entries(lines)) {
    const k = String(v == null ? '' : v).trim();
    if (!k) { problems.push(`版本線 \`${id}\` 沒宣告 MAJOR.MINOR——沒有線就分不出哪一段 changelog 是誰的。`); continue; }
    if (seen.has(k)) {
      problems.push(
        `版本線 \`${seen.get(k)}\` 與 \`${id}\` 都宣告成 ${k}。\n`
        + `         ⇒ 兩條線的號碼形狀不再互斥：出貨線會去別條線的 changelog 撈到那一段，\n`
        + `           而 release tag 也會撞號——兩種都不報錯，只會給錯答案。`);
      continue;
    }
    seen.set(k, id);
  }
  return problems;
}

/**
 * 這條版本線這一趟**該掛哪些檔**（路徑相對於 bundle 工作區）。
 *
 * ── 為什麼這件事要宣告在版本線上 ────────────────────────────────────────
 * leo 2026-08-18 指著 release 頁問：「**assets 都寫 source code，這兩個附檔實際是什麼？
 * 是 dmg 還是 go？**」——那兩個是 Gitea／GitHub 自動產生的整包 repo 快照。
 * ⇒ 「這一版的成品是什麼」必須是**每條線各自宣告的事實**，
 *   否則補發佈只會補出一頁一頁點下去給錯東西的版本頁。
 *
 * 回傳空陣列＝這份 manifest 裡這條線沒有可掛的成品 ⇒ 呼叫端該擋，不該默默發一個空頁。
 * @returns {string[]} 例 ['daemon/Arcrun-0.18.29.dmg', 'daemon/Arcrun-win-0.18.29.exe']
 */
export function assetsFor(line, manifest, { manifestFileName = 'manifest.json' } = {}) {
  const decl = LINES.find((l) => l.id === line.id);
  if (!decl) return [];
  // 🔴 `null` 與 `[]` 是兩個不同的宣告，不是同一件事的兩種寫法：
  //   `null` ＝ 這條線沒有逐檔清單，掛 manifest（零件包）
  //   `[]`   ＝ **明說沒有可掛的檔**（安裝器：成品是線上跑著的網站）
  //   ⇒ 呼叫端拿到空陣列時要看這條線的可見度再決定怎麼做，不是一律當成「宣告漏了」。
  if (decl.assetKeys === null || decl.assetKeys === undefined) return [manifestFileName];
  const block = at2(manifest, decl.manifestPath.slice(0, -1));
  if (!block) return [];
  const out = [];
  for (const k of decl.assetKeys) {
    const f = block[k] && typeof block[k].file === 'string' ? block[k].file : null;
    if (f) out.push(f);
  }
  return out;
}

/** 同 `at`，但回物件（`at` 只回字串——它是給版本號用的）。 */
function at2(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur && typeof cur === 'object' ? cur : undefined;
}

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

/**
 * 新 release 的 tag：裸號（leo 2026-08-17「不要 v」），**內部線在前面加宣告的前綴**。
 * 前綴的用途只有一個：同一個 repo 裡分得出「這條歷史是誰的」（`installer-1.0.5` vs `1.4.63`）。
 */
export function releaseTagFor(version, prefix = '') {
  return `${prefix}${bareVersion(version)}`;
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
export function tagMatches(tag, version, prefix = '') {
  const t = String(tag == null ? '' : tag);
  // 有前綴的線：**一定要帶那個前綴才算**。少了這一條，`1.0.5`（如果哪天零件包走到這個號碼）
  // 會被當成安裝器已經發過 ⇒ 假綠；反過來 `installer-1.0.5` 也不准冒充零件包的 `1.0.5`
  // （沒有前綴的線走下面那條路，`bareVersion('installer-1.0.5')` 本來就對不上）。
  if (prefix) {
    if (!t.startsWith(prefix)) return false;
    return bareVersion(t.slice(prefix.length)) === bareVersion(version) && bareVersion(version) !== '';
  }
  return bareVersion(t) === bareVersion(version) && bareVersion(version) !== '';
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
      // 前綴與可見度**跟著這條線一起交出去**：呼叫端不必再回頭查 LINES，
      // 也就不會出現「有的地方記得加前綴、有的地方忘了」這種只在某一站現形的漂移。
      tagPrefix: line.tagPrefix || '',
      visibility: releaseVisibility(line.id),
      tag: releaseTagFor(version, line.tagPrefix || ''),
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
