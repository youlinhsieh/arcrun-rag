/**
 * installer-release.mjs — **安裝器那條線的「版本物件」長什麼樣**（inkstone/arcrun-rag#169，2026-09-02）
 *
 * ── 為什麼有這支（leo 2026-09-02 裁決）────────────────────────────────────────
 * 前一輪把安裝器宣告成「不發版本頁」，理由是「它是一個網站不是下載物，
 * 使用者不會選版本、也沒有成品可以掛」。leo 原話：
 *
 *   「**你的宣告有誤**，安裝器是 arcrun 的一部分，**什麼東西改了不用聲明**？
 *     **那是說不用告訴用戶。**」
 *   「不獨立發版本，但那是用戶，**我不能沒有版本，內部所有開發都要有版本**」
 *
 * 🔴 那條宣告把兩件事講成同一句：「使用者不會選版本」（真）⇒「不用發版本物件」（假）。
 *   **版本物件不是給使用者下載的，是給 leo 驗收的。** 實害已經發生：`1.0.3` 上了 prod，
 *   而 leo 當晚去 Gitea 找版本一個都找不到。
 *
 * ── 這支負責的那一格：**把「可以打開來看」做成內容，而不是做成一個附檔** ────────
 * 安裝器真的沒有下載物（它的成品是線上跑著的那個網站），所以這一筆版本物件
 * 若只有一個 tag，就會是 leo 2026-08-18 罵過的那種「點下去什麼都沒有」的頁面。
 * ⇒ 內文必須自帶三件事，缺一件就不是版本物件而是一個標籤：
 *   ① **這一版改了什麼**（使用者語言，取自 `installer/CHANGELOG.md`）
 *   ② **這是哪一份原始碼**（commit ＋ `INSTALLER_SRC_SHA`——線上 `/api/latest` 會回同一串）
 *   ③ **怎麼驗**（打開那個網址，比對版本號與指紋；對不上就是這筆物件在說謊）
 *
 * 為什麼不用 `internal-version.mjs` 的 `formatInternalVersion`／`mappingSection`：
 * 那一套是**對外號 ↔ 內部號**的對應表，而且明文拒絕「沒有成品的內部號」
 * （「沒有成品的內部號＝一個指向原始碼的標籤，測不了，也就不是版本」）。
 * 那條判準是對的，這裡不繞過它——安裝器的「可測物」不是檔案而是網址，
 * 所以它要的是**另一種可測性**：線上那份碼自己會回報自己的指紋（`version.mjs` 烙的那串）。
 * ⇒ 兩套並存是刻意的，判準寫在這裡：**掛得出檔的線用那一套，掛不出檔的線用這一套，
 *   而兩套都不接受「只有一個號碼、沒有任何辦法驗」。**
 *
 * 全部純函式（不碰網路、不碰磁碟）⇒ `installer-release.test.mjs` 餵它該過與不該過的輸入。
 */

/** 這條線的 tag 前綴。真相源在 `release-lines.mjs` 的宣告，這裡只是給它一個名字。 */
export const INSTALLER_TAG_PREFIX = 'installer-';

/** 內文裡那兩個小節的標題——回頭查證靠它們定位，所以是常數，不是散落各處的字面值。 */
export const SOURCE_HEADING = '### 這一版是哪一份';
export const VERIFY_HEADING = '### 怎麼驗這一筆';

/** 版本物件的標題：`安裝器 1.0.5（零件包 1.4.63）`。同 leo 2026-09-02 手動補開那筆的寫法。 */
export function installerReleaseTitle(version, { bundleRelease } = {}) {
  const v = String(version || '').trim();
  if (!v) throw new Error('安裝器版本號是空的——不准建一個沒有號碼的版本物件。');
  return bundleRelease ? `安裝器 ${v}（零件包 ${bundleRelease}）` : `安裝器 ${v}`;
}

/**
 * 組出要送上去的版本物件內文。
 *
 * 🔴 **少任何一格就丟例外，不補一句「未知」。** 一筆寫著「原始碼：未知」的版本物件
 * 比沒有更貴——它看起來像答案，於是 leo 會拿它去對帳（同 CLAUDE.md 那條：
 * 不准交出帶著不確定聲明的東西）。
 *
 * @param {object} o
 * @param {string} o.version       安裝器版本號（`1.0.5`）
 * @param {string} o.srcSha        `version.mjs` 烙的原始碼指紋（＝線上 `/api/latest` 的 `installer_sha`）
 * @param {string} o.commit        這一版原始碼的 commit（完整或短 sha 都收，內文印短的）
 * @param {string} o.repoSlug      那顆 commit 住在哪個 repo（`inkstone/arcrun-rag`）
 * @param {string} o.changelog     `installer/CHANGELOG.md` 裡這一版那一段（使用者語言）
 * @param {string} o.liveUrl       這一版部到哪（`verify.installerBase`）
 * @param {string} o.targetName    出貨目標名（`stage`／`prod`）
 * @param {string} [o.bundleRelease] 同一趟出貨的零件包版本（有就寫進去，沒有就不寫）
 */
export function installerReleaseBody({
  version, srcSha, commit, repoSlug, changelog, liveUrl, targetName, bundleRelease,
} = {}) {
  const missing = [];
  const need = { version, srcSha, commit, repoSlug, changelog, liveUrl, targetName };
  for (const [k, v] of Object.entries(need)) if (!String(v == null ? '' : v).trim()) missing.push(k);
  if (missing.length) {
    throw new Error(
      `安裝器版本物件缺 ${missing.join('、')}，不准建。\n` +
      `     少了它們這一筆就只是一個標籤：打開來看不出「這是哪一份原始碼」也「不知道怎麼驗」，\n` +
      `     而那正是 2026-09-02 leo 找不到版本那件事的另一種長法（有頁面，但答不出問題）。`);
  }
  const short = String(commit).slice(0, 7);
  const shaShort = String(srcSha).slice(0, 12);
  const body = String(changelog).replace(/\s+$/, '');
  return [
    body,
    '',
    SOURCE_HEADING,
    '',
    `- **安裝器版本**：\`${version}\`（線上 \`/api/latest\` 的 \`installer.version\`）`,
    `- **原始碼指紋**：\`${srcSha}\`（線上 \`/api/latest\` 的 \`installer_sha\`——那串是這份碼自己帶著的）`,
    `- **原始碼 commit**：\`${short}\`（${repoSlug}）`,
    bundleRelease ? `- **同一趟出貨的零件包**：\`${bundleRelease}\`（安裝器改動不會讓它跳號，兩條線各自為真）` : null,
    `- **這一版部到哪**：${targetName} → ${liveUrl}`,
    '',
    VERIFY_HEADING,
    '',
    `1. 打開 ${liveUrl} ，按鈕上要寫「安裝器 ${version}」`,
    `2. \`GET ${String(liveUrl).replace(/\/$/, '')}/api/latest\`：`,
    `   \`installer.version\` ＝ \`${version}\`、\`installer_sha\` ＝ \`${shaShort}…\`（逐字元相同）`,
    `3. 對不上 ⇒ 線上跑的不是這一版，**這一筆在說謊**，不要拿它對帳（去查 deploy 那一站）`,
    '',
    '> **這是內部版本物件，不是給使用者選版本的產品線。**',
    '> 安裝器是 arcrun 的一部分（leo 2026-09-02）：使用者打開那個網站就是最新的那份，',
    '> 不會、也不該去選要用哪一版安裝器。這一筆存在的理由是「**內部所有開發都要有版本**」',
    '> ——它是這一版**可以被打開、被問問題**的那個東西。',
    '> 沒有附檔是刻意的：這條線的成品是線上跑著的網站，掛一包原始碼快照只會給錯東西',
    '> （leo 2026-08-18 指著 release 頁問過的那件事）。',
  ].filter((l) => l !== null).join('\n') + '\n';
}

/**
 * **回頭查證**：讀回來的那筆版本物件內文，答不答得出本檔開頭那三件事。
 * 不聽「我建好了」——同 `release-check` 站的形狀（ship.mjs 建完會再讀一次餵這支）。
 * @returns {string[]} 問題清單（空＝這一筆是完整的）
 */
export function installerReleaseBodyProblems(body, { version, srcSha } = {}) {
  const text = String(body || '');
  const problems = [];
  if (!text.trim()) return ['版本物件的內文是空的——那就是「有頁面、點進去什麼都沒有」。'];
  if (!text.includes(SOURCE_HEADING)) problems.push(`內文沒有「${SOURCE_HEADING}」那一節 ⇒ 答不出這是哪一份原始碼。`);
  if (!text.includes(VERIFY_HEADING)) problems.push(`內文沒有「${VERIFY_HEADING}」那一節 ⇒ 沒有人知道怎麼驗它。`);
  if (version && !text.includes(String(version))) problems.push(`內文裡找不到版本號 ${version}。`);
  if (srcSha && !text.includes(String(srcSha))) {
    problems.push(`內文裡找不到原始碼指紋 ${String(srcSha).slice(0, 12)}… ⇒ 對不回線上那份碼。`);
  }
  return problems;
}

/**
 * **這一版到了沒**——拿線上 `/api/latest` 的回應跟這棵樹逐字元比。
 *
 * 🔴 為什麼版本物件建立前一定要問這一句：內文裡寫著「這一版部到 <網址>」。
 * 那句話若是假的，這一筆就是**看起來像答案的謊**——而 leo 會拿它去對帳
 * （2026-09-01 那次的教訓是「找不到版本」，這一條擋的是它的反面：「找得到，但它在騙你」）。
 * 也是這一站本來的規矩：只有使用者真的拿得到這一版，才留下那一筆紀錄。
 *
 * @param {object} o
 * @param {string} o.version 這棵樹的安裝器版本
 * @param {string} o.srcSha  這棵樹的原始碼指紋
 * @param {object} o.live    `GET /api/latest` 的回應（原封不動）
 * @param {string} o.liveUrl 問的是哪個網址（寫進訊息，讓人知道去哪看）
 * @returns {string|null} null＝到了；字串＝中止理由（已經是完整訊息，呼叫端直接丟）
 */
export function deliveredProblem({ version, srcSha, live, liveUrl }) {
  const liveVersion = live && live.installer && live.installer.version;
  const liveSha = live && live.installer_sha;
  if (liveVersion === version && liveSha === srcSha) return null;
  return `線上還不是這一版，不留紀錄（${liveUrl}）：\n`
    + `       版本　線上 ${liveVersion || '(無)'} ／ 這棵樹 ${version}\n`
    + `       指紋　線上 ${String(liveSha || '(無)').slice(0, 12)}… ／ 這棵樹 ${String(srcSha).slice(0, 12)}…\n`
    + `     ⇒ 一筆寫著「這一版部到 ${liveUrl}」而那裡不是它的版本物件，比沒有更貴——\n`
    + `       它看起來像答案，而 leo 會拿它去對帳。先把這一版部上去，再留紀錄。`;
}
