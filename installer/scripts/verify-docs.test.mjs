/**
 * verify-docs.test.mjs — 證明「線上的文件站不是這份原始碼建的」真的會被擋下來。
 *
 * 跑法：node --test installer/scripts/verify-docs.test.mjs
 * （零依賴、全程離線，fetch 用注入的替身）
 *
 * ── 這支在守什麼（2026-08-17 leo「這個頁面刪除」之後）────────────────────────
 * 舊的斷言是「版本說明頁上有這一版」，而那一頁已經刪掉了（改連 GitHub 版本發佈）。
 * 「使用者查得到這一版」那道閘搬去 `ship.mjs` 的 `release-record` 站，不在這裡。
 *
 * 這裡守的是**部署本身**：舊網址現在是一條轉去 GitHub 版本發佈的靜態轉址頁，
 * 它是這份原始碼的產物 ⇒ 線上沒有它，就代表站沒重建／沒 rsync／部署到別顆。
 * 要證明的是：**那條轉址不在，閘一定紅**，而且「站掛了」「轉址掉了」「頁面在但
 * 內容是別的」三種壞法各自都報得出來——不會有一種安靜通過。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocsLive, changelogUrl, RELEASES_URL } from './verify-docs.mjs';

const BASE = 'https://arcrun-docs-staging.uncle6-me.workers.dev/docs/';
const CL = changelogUrl(BASE);

/**
 * Astro 對**外部**轉址目標實際產出的那一頁（2026-08-18 `npm run build` 原樣複製，
 * 只把網址換成參數）——網址全部在**屬性**裡，所以斷言必須看原始 HTML 而不是剝過的純文字。
 */
const redirectPage = (to = RELEASES_URL) =>
  `<!doctype html><title>Redirecting to: ${to}</title>` +
  `<meta http-equiv="refresh" content="0;url=${to}">` +
  `<meta name="robots" content="noindex">` +
  `<link rel="canonical" href="${to}"><body>	` +
  `<a href="${to}">Redirecting from <code>/docs/help/changelog/</code> to <code>${to}</code></a></body>`;

function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const v = key === undefined ? { status: 404 } : routes[key];
    const headers = { get: (h) => (v && v.location && h.toLowerCase() === 'location' ? v.location : null) };
    if (typeof v === 'string') return { ok: true, status: 200, headers, text: async () => v };
    return { ok: false, status: v.status, headers, text: async () => '' };
  };
}
// 注意：CL 以 BASE 開頭 ⇒ 路由比對要把長的放前面，這裡靠物件鍵順序（Object.keys 保序）。
const routes = (home, changelog) => ({ [CL]: changelog, [BASE]: home });

test('站是這份原始碼建的（轉址頁在，指向 GitHub 版本發佈）⇒ 全過', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes('<html>首頁</html>', redirectPage())),
  });
  assert.deepEqual(r.fails, [], r.lines.join('\n'));
});

test('平台層 301／302 轉址（不是 meta refresh）也算數——看 Location 標頭', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes('<html>首頁</html>', { status: 301, location: RELEASES_URL })),
  });
  assert.deepEqual(r.fails, [], r.lines.join('\n'));
});

test('🔴 舊網址還是那一頁舊的版本說明（站沒重建）⇒ 一定抓到', async () => {
  const stale = '<html><body><h1>版本說明</h1><h2>1.4.47（2026-08-15）</h2><p>改了一些東西</p></body></html>';
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes('<html>首頁</html>', stale)),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
  assert.ok(r.fails[0].includes(RELEASES_URL), r.fails[0]);
});

test('🔴 轉址整個掉了（404）⇒ 報出來，不當成「已經刪乾淨了所以沒事」', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes('<html>首頁</html>', { status: 404 })),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
  assert.ok(r.fails[0].includes('沒有把人送去'), r.fails[0]);
});

test('🔴 轉去別的地方（改錯網址）⇒ 也算斷，不是「有轉就好」', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes('<html>首頁</html>', redirectPage('https://example.com/somewhere'))),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
});

test('文件站整個掛掉 ⇒ 首頁那條就斷，不再往下推論', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    fetchImpl: fakeFetch(routes({ status: 500 }, redirectPage())),
  });
  assert.equal(r.fails.length, 1);
  assert.ok(r.fails[0].includes('文件站首頁讀不到'), r.fails[0]);
});
