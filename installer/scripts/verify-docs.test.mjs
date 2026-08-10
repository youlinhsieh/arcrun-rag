/**
 * verify-docs.test.mjs — 證明「文件站是舊的」這件事真的會被擋下來。
 *
 * 跑法：node --test installer/scripts/verify-docs.test.mjs
 * （零依賴、全程離線，fetch 用注入的替身）
 *
 * 為什麼需要（arcrun-rag#27）：舊的文件站檢查只問 `GET /docs/ → 200`，
 * 一個內容停在三天前的站照樣是綠的——leo 08-09 就是這樣在 prod 上看到
 * 版本說明最新只到 v0.18.24，而封測者當天拿到的是 v0.18.25。
 * ⇒ 這裡要證明的是：**版本說明頁上沒有這一版，閘一定紅**，
 *   而且「站掛了」「頁面掉了」「內容是舊的」三種壞法各自都報得出來。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocsLive, changelogUrl, htmlText } from './verify-docs.mjs';

const BASE = 'https://arcrun-docs-staging.uncle6-me.workers.dev/docs/';
const CL = changelogUrl(BASE);

/** 假的版本說明頁：帶哪幾版就長哪幾版的 <h2>。 */
const pageWith = (...versions) =>
  '<html><body><h1>版本說明</h1>' +
  versions.map((v) => `<h2 id="section">${v}（2026-08-09）</h2><p>改了一些東西</p>`).join('') +
  '</body></html>';

function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const v = key === undefined ? { status: 404 } : routes[key];
    if (typeof v === 'string') return { ok: true, status: 200, text: async () => v };
    return { ok: false, status: v.status, text: async () => '' };
  };
}
// 注意：CL 以 BASE 開頭 ⇒ 路由比對要把長的放前面，這裡靠物件鍵順序（Object.keys 保序）。
const routes = (home, changelog) => ({ [CL]: changelog, [BASE]: home });

test('這一版有寫、也真的部署出去了 ⇒ 全過', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['1.4.29', 'v0.18.25'],
    fetchImpl: fakeFetch(routes('<html>首頁</html>', pageWith('1.4.29', 'v0.18.25'))),
  });
  assert.deepEqual(r.fails, [], r.lines.join('\n'));
});

test('🔴 文件站內容停在上一版（daemon 版本缺）⇒ 一定抓到', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['1.4.29', 'v0.18.25'],
    // 這就是 08-09 prod 的實況：頁面最新只到 v0.18.24
    fetchImpl: fakeFetch(routes('<html>首頁</html>', pageWith('1.4.28', 'v0.18.24'))),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
  assert.ok(r.fails[0].includes('1.4.29'), r.fails[0]);
  assert.ok(r.fails[0].includes('v0.18.25'), r.fails[0]);
});

test('🔴 bundle 版本有、daemon 版本沒有 ⇒ 也算缺（使用者拿到的是 daemon 那個號碼）', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['1.4.29', 'v0.18.25'],
    fetchImpl: fakeFetch(routes('<html>首頁</html>', pageWith('1.4.29'))),
  });
  assert.equal(r.fails.length, 1);
  assert.ok(r.fails[0].includes('v0.18.25') && !r.fails[0].includes('缺 1.4.29'), r.fails[0]);
});

test('版本說明頁 404（路由/建置掉了）⇒ 報「頁面讀不到」，不冒充成內容不對', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['1.4.29'],
    fetchImpl: fakeFetch(routes('<html>首頁</html>', { status: 404 })),
  });
  assert.ok(r.fails[0].includes('版本說明頁讀不到'), r.fails.join('\n'));
});

test('文件站整個掛掉 ⇒ 首頁那條就斷，不再往下推論', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['1.4.29'],
    fetchImpl: fakeFetch(routes({ status: 500 }, pageWith('1.4.29'))),
  });
  assert.equal(r.fails.length, 1);
  assert.ok(r.fails[0].includes('文件站首頁讀不到'), r.fails[0]);
});

test('版本號只出現在標籤屬性裡不算數（避免 id="v0.18.25" 這種假陽性）', async () => {
  const r = await checkDocsLive({
    docsBase: BASE,
    versions: ['v0.18.25'],
    fetchImpl: fakeFetch(routes('<html>首頁</html>', '<html><body><a href="/x/v0.18.25/">舊連結</a></body></html>')),
  });
  assert.equal(r.fails.length, 1, r.lines.join('\n'));
});

test('htmlText 把標籤剝掉、屬性不留', () => {
  assert.equal(htmlText('<h2 id="a-1">1.4.29</h2>').trim(), '1.4.29');
  assert.ok(!htmlText('<a href="v9.9.9">x</a>').includes('v9.9.9'));
});
