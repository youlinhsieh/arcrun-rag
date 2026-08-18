/**
 * internal-version.mjs — 內部版本號的產生器，與「內外對應」那張表的產生器
 *
 * ── 這支要解的問題（inkstone/arcrun-rag#88，leo 2026-08-17／08-18）────────────
 * leo：「外部版本號**不可跳號**，內部改了 5 版終於修復可以公佈，
 *       但**不可以用跳了 4 版的號公佈**，內外是分離的。
 *       我的問題是內外雖然分離，但**看起來差不多，容易誤解，難管理**。」
 *
 * 🔴 **他問的不是「怎麼對應」，是「怎麼一眼分辨」**（總管在這條上連錯兩次，
 *   全文見 InkStoneCo `system-dev/wiki/ops-facts.md`「版本號規約」與 commit 73bd8eb）：
 *     ① `1.4.47s` 尾碼 → `1.4.50s` 看起來還是像對外號碼，**沒解決**
 *     ② 共用計數器、發佈脫掉 s → 那會讓外部跳號，**是他明令禁止的**
 *   ⇒ 判準只有一句：**看到一個號碼，不必查任何東西就知道它是內是外。**
 *     做不到這點的方案（尾碼、後綴、相同格式加標記）都不算解決。
 *
 * ── 定案的兩種形狀 ──────────────────────────────────────────────────────
 * ```
 * 對外   1.4.46 → 1.4.47 → 1.4.48        連續、不跳號、三個數字（不帶 v）
 * 內部   RAG-20260817-002-dcd0132        <repo短碼>-日期-當天序號-commit7
 * ```
 * 兩者連長度與字元集都不一樣 ⇒ 不會誤認。
 * **對應關係記在該次發佈的 release note 上，不靠號碼本身編碼**（leo 同句）。
 *
 * ── 🔴 沒有成品的內部號不算版本 ────────────────────────────────────────
 * leo 同句：「**所以在內部每次就要出貨 bundle 的版本**」
 * ⇒ 內部號不能只是一個 git tag，它必須對應到一份**真的打好、可以裝的成品**。
 *   ops-facts 當時記著：「這件事目前**靠自律，沒有機械閘**」。
 *   本模組就是那道閘：`formatInternalVersion()` **要求傳入 artifacts**，
 *   空陣列直接丟例外 ⇒ **算不出一個沒有成品的內部號**，不是「請記得附上成品」。
 */

/** 內部號的形狀。`^`/`$` 是刻意的：拿它去比對整個字串，不要當成「內文裡找找看」。 */
export const INTERNAL_VERSION_RE = /^([A-Z]{2,5})-(\d{8})-(\d{3})-([0-9a-f]{7})$/;

/** 在一段文字裡撈內部號（release note 是 markdown，號碼夾在句子裡）。 */
export const INTERNAL_VERSION_SCAN_RE = /\b[A-Z]{2,5}-\d{8}-\d{3}-[0-9a-f]{7}\b/g;

/**
 * repo 短碼。**不是自動推導**（`arcrun-rag` → `AR`？`ARR`？猜不準且會漂），
 * 而是一張明列的表：加新 repo 就在這裡加一行，加不進來的當場報錯，
 * 不會默默生出第二種短碼。`ARC` 已在 2026-08-17 實際用過（ops-facts 有紀錄）。
 */
export const REPO_SHORT_CODES = {
  'arcrun-rag': 'RAG',
  arcrun: 'ARC',
  // D95（2026-08-18，InkStoneCo#40）：桌面小幫手搬進自己的 repo，
  // 它的內部號要指得回**它自己那個 repo 的 commit**，不是 arcrun-rag 的。
  'arcrun-collector': 'ACO',
};

/** @returns {string} 例 'RAG'。查不到就丟——短碼漂掉之後兩個號碼會被當成兩個 repo。 */
export function shortCodeFor(repoName) {
  const code = REPO_SHORT_CODES[String(repoName || '').trim()];
  if (!code) {
    throw new Error(
      `不認得 repo「${repoName}」的短碼。請在 internal-version.mjs 的 REPO_SHORT_CODES 補一行。\n` +
      `     不自動推導是刻意的：推導規則一改，同一個 repo 就會有兩種短碼，而歷史上的號碼不會跟著變。`);
  }
  return code;
}

/** Date → `YYYYMMDD`（本地時區——「當天第幾版」的「當天」是人所在的那一天）。 */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 產生一個內部版本號。
 *
 * @param {object} o
 * @param {string} o.repoName  例 'arcrun-rag'
 * @param {string} o.commit    完整或短 sha（取前 7 碼）
 * @param {number} o.sequence  當天第幾版（1 起算；用 nextSequence() 從事實算出來）
 * @param {string[]} o.artifacts 🔴 這一版**真的打出來的成品**檔名。空的就丟例外——
 *                               沒有成品的內部號是一個指向原始碼的標籤，測不了，也就不是版本。
 * @param {Date} [o.date]
 * @returns {string} 例 'RAG-20260817-002-dcd0132'
 */
export function formatInternalVersion({ repoName, commit, sequence, artifacts, date = new Date() }) {
  const short = shortCodeFor(repoName);
  const sha7 = String(commit || '').trim().toLowerCase().slice(0, 7);
  if (!/^[0-9a-f]{7}$/.test(sha7)) {
    throw new Error(`commit 看起來不是 sha：「${commit}」——內部號要能一路查回那顆 commit`);
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new Error(`當天序號要是 1–999 的整數，收到 ${sequence}`);
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(
      `這個內部號沒有對應任何成品，不准產生（leo 2026-08-17：「內部每次就要出貨 bundle 的版本」）。\n` +
      `     沒有成品的內部號＝一個指向原始碼的標籤，**測不了，也就不是版本**。\n` +
      `     ⇒ 這道閘取代了原本的自律（ops-facts 記著「目前靠自律，沒有機械閘」）。`);
  }
  return `${short}-${dateStamp(date)}-${String(sequence).padStart(3, '0')}-${sha7}`;
}

/**
 * 從**既有的 release 內文**算出「今天已經出到第幾版」，回下一個序號。
 *
 * 🔴 為什麼讀 release 內文，而不是自己維護一本帳：
 * 帳本會漂（出貨失敗、兩台機器各出一次、有人手動建了一筆），而漂掉的時候
 * 它**不會報錯，只會給出一個重複的號碼**。release 內文是那些版本**真的存在過**的證據，
 * 也是 leo 會親眼看到的那一面 ⇒ 從它算，序號就不可能與看得到的事實不一致。
 * （同 `release-check` 站的判準：不聽上一步說什麼，回頭問那個真的會被人看的地方。）
 *
 * @param {string[]} existingBodies 該 repo 現有 release 的內文（順序無所謂）
 * @param {string} short  repo 短碼
 * @param {string} today  `YYYYMMDD`
 * @returns {number} 下一個序號（今天還沒有任何一版就是 1）
 */
export function nextSequence(existingBodies, short, today = dateStamp()) {
  let max = 0;
  for (const body of existingBodies || []) {
    for (const hit of String(body || '').match(INTERNAL_VERSION_SCAN_RE) || []) {
      const m = INTERNAL_VERSION_RE.exec(hit);
      if (!m) continue;
      if (m[1] !== short || m[2] !== today) continue;
      max = Math.max(max, Number(m[3]));
    }
  }
  return max + 1;
}

/** release note 裡對應段落的標題——查證時靠它定位，所以是常數不是字面值散落各處。 */
export const MAPPING_HEADING = '### 版本對應';

/**
 * 產生要**附在 release note 末尾**的內外對應段落。
 *
 * leo 2026-08-18：「對應關係記在該次發佈的 release note，**不靠號碼本身編碼**。」
 * ⇒ 這一段就是那個「記在哪裡」的具體長相，而它由機器產生：
 *   在此之前這張對應表是**總管手寫**在 note 裡的，於是它會漏、會寫錯、會格式不一。
 *
 * @param {object} o
 * @param {string} o.product   例 '桌面小幫手'
 * @param {string} o.external  對外號（裸號）例 '0.18.29'
 * @param {string} o.internal  內部號 例 'RAG-20260818-001-dcd0132'
 * @param {string} [o.upstream] 上游來源，例 manifest 的 `source` 欄（'Arcrun@cacaa33f7d4e'）
 * @param {string[]} o.artifacts 這一版掛在本頁上的成品檔名
 */
export function mappingSection({ product, external, internal, upstream, artifacts }) {
  const lines = [
    MAPPING_HEADING,
    '',
    `- **對外版本**：${product} ${external}（使用者看到的就是這個號碼）`,
    `- **內部版本**：\`${internal}\``,
  ];
  if (upstream) lines.push(`- **上游來源**：\`${upstream}\``);
  lines.push(`- **本版成品**：${artifacts.map((a) => `\`${a}\``).join('、')}`);
  lines.push('');
  lines.push('> 內外兩條號分離：對外連續不跳號，內部一天可以有很多版。');
  lines.push('> 兩者格式刻意不同，看到號碼就知道是內是外，不必查表。');
  return lines.join('\n');
}

/**
 * 把對應段落接到 changelog 內文後面，產生**最終要送上去的 release 內文**。
 * 冪等：內文裡已經有對應段落就不重複追加（同一版重跑 --confirm 不該長出兩張表）。
 */
export function withMappingSection(body, mapping) {
  const base = String(body || '').replace(/\s+$/, '');
  // 🔴 兩條出口都要**收尾一致**（結尾剛好一個換行）。
  //   第一版這裡是 `return base`（沒補換行），而另一條出口是 `...\n`
  //   ⇒ 第二次呼叫會少掉那個換行 ⇒ 「同一版重跑」時算出來的內文與上一次**逐字不同**。
  //   那不只是難看：release-check 那類回頭查證會拿內文比對，差一個換行就變成
  //   「內容被改過」的假警報。冪等要冪等到位元，不是「看起來一樣」。
  if (base.includes(MAPPING_HEADING)) return `${base}\n`;
  return `${base}\n\n${mapping}\n`;
}

/**
 * 一筆 release 內文**有沒有帶內外對應**——供回頭查證用（不聽上一步說它加了）。
 * @returns {{ok: boolean, internal: string|null}}
 */
export function mappingIn(body) {
  const text = String(body || '');
  const hit = (text.match(INTERNAL_VERSION_SCAN_RE) || [])[0] || null;
  return { ok: text.includes(MAPPING_HEADING) && Boolean(hit), internal: hit };
}
