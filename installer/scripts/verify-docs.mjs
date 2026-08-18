/**
 * verify-docs.mjs — 「文件站真的重建並部署出去了嗎？」
 *
 * ── 為什麼要有這支（2026-08-09，Gitea Leo/arcrun-rag#27）────────────────────
 * leo 推完 1.4.29 prod 後問：「你推完 prod 以後有去檢查上架的東西是否正確嗎？
 *   比如說版本有沒有版本說明？有沒有上 docs？」
 * 當時管線裡**已經有**一道「文件站部署後驗一下」——它只問 `GET /docs/ → 200`。
 * 一個從沒重建過、內容停在三天前的站，那道閘一樣是綠的。
 * ⇒ 「部署成功」不是驗收（CRITICAL-PATH 使用規則 6：HTTP 200 不算驗過）。
 *
 * ── 🔴 2026-08-17（leo「這個頁面刪除」，inkstone/arcrun-rag#41）：本支斷言換了對象 ──
 * 原本的第二條斷言是「**版本說明頁上真的有這一版**」（release 與 daemon 兩個版號都要
 * 出現在 `<docsBase>/help/changelog/` 上）。**那一頁已經不存在了**——
 * leo 2026-08-09 就講過「不要同步，docs 的版本說明直接連回 github 的版本發佈」，
 * 08-17 收口成三個字。文件站不再自己維護一份版本內容。
 *
 * 🔴 **「使用者查得到這一版」這道閘沒有消失，它換了地方**：
 *    現在由 `ship.mjs` 的 `release-record` 站保證——每條版本線都要在 GitHub／Gitea
 *    上有一筆版本發佈，內文由 `github-release.mjs` 的 `releaseSectionFor()`
 *    從兩份 changelog 原稿抽出來，抽不到就當場中止（不是「先跳過、之後再補」）。
 *    那一站有牙齒且**早於**本支存在，所以刪掉舊斷言不會留下無人看守的缺口。
 *
 * ⇒ 本支現在斷言的是**這次部署真的發生了**，方法是查那條轉址還在不在：
 *    ① 文件站首頁活著（`GET <docsBase>` → 2xx）
 *    ② `<docsBase>/help/changelog/` 仍然把人送去 GitHub 版本發佈
 *       ——這條轉址宣告在 `docs-site/astro.config.mjs`，是**這份原始碼建出來的產物**。
 *       它不在線上 ⇒ 這顆 worker 上的站是舊的（或根本沒部署到這顆）。
 *
 * ⚠️ 這比舊斷言弱：舊的能抓到「內容停在上一版」，新的只抓得到「站不是這份原始碼建的」。
 *    這是頁面刪除的代價，不是疏忽——被拿掉的那件事已由 `release-record` 承接。
 *
 * 🔴 2026-08-18（arcrun-rag#88 複驗①）：上面那句「只抓得到站不是這份原始碼建的」
 *    當時被高估了——第一版拿 `body.includes(RELEASES_URL)` 判「有指過去」，
 *    但「每一版的完整發佈紀錄在這裡：GitHub 版本發佈」這行連結，早在 08-09（本頁還
 *    自己維護版本內容的年代）就已經長在頁面最上方，一路留到 dcd0132 才整頁換成轉址。
 *    ⇒ 任何一顆卡在 08-09～dcd0132 之間舊 build 的 worker，內文一樣含這串網址，
 *    `includes()` 一樣判「有指過去」——**假綠**，抓不到「這站沒重建、還是舊版」。
 *    已改成只認轉址頁的具名產物（`<meta refresh>` / `<link canonical>`），
 *    見下方 `checkDocsLive()` 內的註解與 `verify-docs.test.mjs` 對應案例。
 *
 * ── 為什麼是獨立模組 ──────────────────────────────────────────────────────
 * 與 `verify-download.mjs` 同理：ship.mjs 是一支會 push、會 deploy 的管線，
 * 沒辦法拿它來演練「文件站是舊的，閘會不會抓到」。判斷邏輯抽成純函式＋可注入 fetch，
 * 同一份實作既被真出貨用、也被 `verify-docs.test.mjs` 用假頁面反覆演練。
 */

/**
 * 版本說明的**唯一對外紀錄**。`docs-site/astro.config.mjs` 的 `redirects` 指向它，
 * repo 根與 `collector/` 兩份 changelog 原稿的檔頭也都指向它。
 * 🔴 改網址時三處要一起改——這裡是出貨閘會實際去線上比對的那一份。
 */
export const RELEASES_URL = 'https://github.com/youlinhsieh/arcrun-rag/releases';

/** 舊版本說明頁的網址（現在是一條轉址）。docsBase 例：`https://…/docs/`。 */
export function changelogUrl(docsBase) {
  return `${String(docsBase).replace(/\/+$/, '')}/help/changelog/`;
}

/**
 * 線上這個文件站，是不是**這份原始碼**建出來並部署上去的？
 *
 * @param {object} o
 * @param {string} o.docsBase        文件站根（登錄簿 docsSite.verifyUrl）
 * @param {function} [o.fetchImpl]   注入用（測試）
 * @returns {Promise<{lines:string[], fails:string[]}>}
 */
export async function checkDocsLive({ docsBase, fetchImpl = fetch }) {
  const lines = [];
  const fails = [];
  const bust = () => `cb=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const noCache = { headers: { 'cache-control': 'no-cache' } };

  const home = await fetchImpl(`${String(docsBase).replace(/\/+$/, '')}/?${bust()}`, noCache).catch(() => null);
  if (!home || !home.ok) {
    fails.push(`文件站首頁讀不到：${docsBase} → ${home ? 'HTTP ' + home.status : '(fetch 失敗)'}`);
    return { lines, fails };
  }
  lines.push(`文件站首頁 ${docsBase} → HTTP ${home.status}`);

  // 舊的版本說明網址現在是一條轉去 GitHub 版本發佈的靜態轉址頁
  // （Astro 對外部目標產出的是 `<meta http-equiv="refresh">` ＋ canonical 連結的 HTML）。
  // 🔴 因此**不能只看 HTTP 狀態**：一頁 200 但沒有那個網址，代表這顆 worker 上的站
  //    不是這份原始碼建的。要看的是內容裡有沒有 releases 網址。
  const url = changelogUrl(docsBase);
  const page = await fetchImpl(`${url}?${bust()}`, { ...noCache, redirect: 'manual' }).catch(() => null);
  if (!page) {
    fails.push(`舊版本說明網址讀不到：${url} →（fetch 失敗）`);
    return { lines, fails };
  }
  // 比對用**原始 HTML**，不剝標籤：Astro 產出的轉址頁把網址放在 `<meta http-equiv=refresh>`
  // 的 content、`<link rel=canonical>` 的 href 與 `<a href>` 裡——那些都是屬性。
  // （舊版這裡先剝成純文字，是因為當時找的是**裸版號**，`id="v0.18.25"` 會誤判成
  //   「頁面寫了這一版」。現在找的是一整條網址，出現在屬性裡就是真的有指過去。）
  //
  // 🔴 2026-08-18（arcrun-rag#88 複驗①，實測抓到的假綠）：原本這裡是
  //   `body.includes(RELEASES_URL)`——只要頁面**任何地方**出現這串網址就算數。
  //   問題是「每一版的完整發佈紀錄在這裡：GitHub 版本發佈」這行連結，早在
  //   2026-08-09 就長在**舊版**（尚未刪除、仍自己維護版本內容）的 changelog 頁最上方，
  //   一路留到 dcd0132 才被整頁換成轉址。⇒ 任何一顆卡在 08-09～dcd0132 之間舊 build
  //   的 worker（例如這次 rsync／deploy 沒跑，線上還是昨天的頁），內文一樣含這串網址，
  //   `includes()` 一樣判定「有指過去」——**假綠**：這站明明沒有換成轉址頁、版本內容
  //   停在舊的，這道閘卻是綠的。
  //   實測見 `verify-docs.test.mjs`「🔴 舊版本說明頁本身也連了 GitHub releases」。
  //   修法：不再認「內文含這串網址」，只認**轉址頁的兩個具名產物**——
  //   `<meta http-equiv=refresh content="...url=RELEASES_URL">` 或
  //   `<link rel=canonical href="RELEASES_URL">`（HTTP 3xx 的 Location 已經另外比對）。
  //   這兩個屬性只有 Astro 真的把這頁編譯成外部轉址時才會出現，舊版有版本內容的頁面
  //   不會有——用 `npm run build` 的實際產物核對過（見上）。
  const location = page.headers?.get?.('location') || '';
  const body = page.status >= 200 && page.status < 300 ? await page.text().catch(() => '') : '';
  const metaRefreshMatch = String(body).match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)["']/i);
  const canonicalMatch = String(body).match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  const metaRefreshTo = metaRefreshMatch ? metaRefreshMatch[1] : '';
  const canonicalHref = canonicalMatch ? canonicalMatch[1] : '';
  const pointsToReleases = location.startsWith(RELEASES_URL)
    || metaRefreshTo.startsWith(RELEASES_URL)
    || canonicalHref.startsWith(RELEASES_URL);

  lines.push(`舊版本說明網址 ${url} → HTTP ${page.status}`
    + (location ? `｜Location ${location}` : '')
    + `｜${pointsToReleases ? '有送去 GitHub 版本發佈' : '沒有指向 GitHub 版本發佈'}`);

  if (!pointsToReleases) {
    fails.push(
      `${url} 沒有把人送去 ${RELEASES_URL}——線上這個站不是這份原始碼建出來的。` +
      `可能是：astro 沒重建／建了沒 rsync 進 deploy/docs／部署到別顆 worker。` +
      `（這個網址是公開過的，掛在 landing「這一版改了什麼」旁邊，撲空＝使用者查不到版本紀錄）`);
  }
  return { lines, fails };
}
