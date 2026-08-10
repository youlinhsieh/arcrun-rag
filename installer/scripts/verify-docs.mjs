/**
 * verify-docs.mjs — 「使用者更新完想知道這版改了什麼，他真的查得到嗎？」
 *
 * ── 為什麼要有這支（2026-08-09，Gitea Leo/arcrun-rag#27）────────────────────
 * leo 推完 1.4.29 prod 後問：「你推完 prod 以後有去檢查上架的東西是否正確嗎？
 *   比如說版本有沒有版本說明？有沒有上 docs？」
 * 一查就漏了：`rag.arcrun.dev/docs/help/changelog/` 線上最新只到 v0.18.24，
 * 而封測者當天按更新拿到的是 v0.18.25 ⇒ **他更新完，查不到自己拿到的是什麼。**
 *
 * 而當時管線裡**已經有**一道「文件站部署後驗一下」——它只問 `GET /docs/ → 200`。
 * 一個從沒重建過、內容停在三天前的站，那道閘一樣是綠的。
 * ⇒ 「部署成功」不是驗收，**「使用者查得到這一版」才是**（CRITICAL-PATH 使用規則 6：
 *   HTTP 200 不算驗過）。
 *
 * ── 這支斷言什麼 ──────────────────────────────────────────────────────────
 *   ① 文件站首頁活著（`GET <docsBase>` → 2xx）
 *   ② **版本說明頁上真的有這一版**：bundle release（例 `1.4.29`）與
 *      daemon 版本（例 `v0.18.25`）兩個字串都要出現在線上那一頁
 *      ——這兩個號碼正是使用者在 portal 版本卡／小幫手更新畫面看到的號碼，
 *        他會拿著它們來這一頁對照。缺任一個＝這次出貨對他而言沒有說明。
 *
 * 三件事被同一個斷言一起夾住，都不必靠人記得：
 *   · 文件根本沒寫這一版         → 頁面上找不到 → ❌
 *   · 寫了但沒重新建（astro）    → 舊 HTML 上沒有 → ❌
 *   · 建了但沒部署／部署到別顆   → 線上那顆沒有 → ❌
 *
 * ── 為什麼是獨立模組 ──────────────────────────────────────────────────────
 * 與 `verify-download.mjs` 同理：ship.mjs 是一支會 push、會 deploy 的管線，
 * 沒辦法拿它來演練「文件站是舊的，閘會不會抓到」。判斷邏輯抽成純函式＋可注入 fetch，
 * 同一份實作既被真出貨用、也被 `verify-docs.test.mjs` 用假頁面反覆演練。
 */

/** 版本說明頁的網址。docsBase 例：`https://…/docs/` ⇒ `https://…/docs/help/changelog/` */
export function changelogUrl(docsBase) {
  return `${String(docsBase).replace(/\/+$/, '')}/help/changelog/`;
}

/** HTML → 純文字（只為了找版本號；標籤內的屬性值不算數，避免 id="…" 誤判成有寫）。 */
export function htmlText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * 線上文件站是不是這一版的。
 * @param {object} o
 * @param {string} o.docsBase        文件站根（登錄簿 docsSite.verifyUrl）
 * @param {string[]} o.versions      必須出現在版本說明頁上的版本號（release／daemon）
 * @param {function} [o.fetchImpl]   注入用（測試）
 * @returns {Promise<{lines:string[], fails:string[]}>}
 */
export async function checkDocsLive({ docsBase, versions, fetchImpl = fetch }) {
  const lines = [];
  const fails = [];
  const bust = () => `cb=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const want = [...new Set((versions || []).filter(Boolean).map(String))];

  const home = await fetchImpl(`${String(docsBase).replace(/\/+$/, '')}/?${bust()}`,
    { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
  if (!home || !home.ok) {
    fails.push(`文件站首頁讀不到：${docsBase} → ${home ? 'HTTP ' + home.status : '(fetch 失敗)'}`);
    return { lines, fails };
  }
  lines.push(`文件站首頁 ${docsBase} → HTTP ${home.status}`);

  const url = changelogUrl(docsBase);
  const page = await fetchImpl(`${url}?${bust()}`, { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
  if (!page || !page.ok) {
    fails.push(`版本說明頁讀不到：${url} → ${page ? 'HTTP ' + page.status : '(fetch 失敗)'}`);
    return { lines, fails };
  }
  const text = htmlText(await page.text());
  const missing = want.filter((v) => !text.includes(v));
  lines.push(`版本說明頁 ${url} → HTTP ${page.status}｜找 ${want.join('／')}｜${missing.length ? '缺：' + missing.join('／') : '都在'}`);
  if (missing.length) {
    fails.push(
      `版本說明頁上沒有 ${missing.join('／')}——使用者更新完查不到這版改了什麼（${url}）。` +
      `可能是：changelog 沒寫這一版／寫了沒重建 astro／建了沒部署到這顆 worker`);
  }
  return { lines, fails };
}
