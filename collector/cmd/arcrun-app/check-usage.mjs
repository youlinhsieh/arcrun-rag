#!/usr/bin/env node
// check-usage.mjs — 用量分頁的畫面驗收（inkstone/arcrun-rag#246）：真瀏覽器、真 GetState 輸出。
// 驗的是 leo 10-10 的四個問題＋「圖示不是字」：
//   ① 數字有千分位  ② 沒有「✅／天 N/M／⌛」這類看了不知道是用光還是沒用的符號
//   ③ 付費越線＝$ 亮起、免費越線＝暫停符號、沒越線＝沒有符號  ④ 頁籤是圖示（名稱只在 title）
//   ⑤ 數字會往前跳（里程表在兩次讀取之間變大）  ⑥ 查不到＝不編數字
// 用法：node check-usage.mjs <state.json> [dist]   （state 來自 TestDumpStateManual）
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = process.argv[2]; const dist = process.argv[3] || path.join(here, 'frontend', 'dist');
if (!stateFile) { console.error('用法：node check-usage.mjs <state.json> [dist]'); process.exit(2); }
let chromium = null;
for (const spec of ['playwright', path.resolve(here, '../../../node_modules/playwright/index.js'), '/opt/node22/lib/node_modules/playwright/index.js']) {
  try { const m = await import(spec); chromium = m.chromium || (m.default && m.default.chromium); if (chromium) break; } catch { /* next */ }
}
if (!chromium) { console.log('❌ 找不到 playwright——這支不假裝驗過'); process.exit(1); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const STATE = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let bad = 0;
const check = (ok, msg, d = '') => { console.log(`  ${ok ? '✅' : '❌'} ${msg}${ok ? '' : ' ' + d}`); if (!ok) bad = 1; };
const browser = await chromium.launch();
async function open(state, idx) {
  const ctx = await browser.newContext({ viewport: { width: 1029, height: 760 } }); const page = await ctx.newPage();
  page.on('pageerror', (e) => check(false, 'JS 例外', String(e)));
  await page.addInitScript(`const S=${JSON.stringify(state)};const b={GetState:async()=>S,ListApps:async()=>({apps:[]}),CheckUpdate:async()=>({}),GetFolderTree:async()=>null};window.go={main:{App:new Proxy(b,{get:(t,k)=>(k in t?t[k]:async()=>({}))})}};`);
  await page.goto(origin + '/'); await page.waitForTimeout(300);
  await page.click(`#nav .nav.acct[data-p="lib:${idx}"]`); await page.click('[data-libtab="usage"]'); await page.waitForTimeout(300);
  return page;
}
console.log('① geek6688：付費、AI 已在收費');
let page = await open(STATE, 0);
const tabs = await page.$$eval('.tabs .tab', (n) => n.map((e) => [e.textContent.replace(/\d+/g, '').trim(), e.getAttribute('title')]));
check(tabs.every(([t, ti]) => t === '' && ti), '五個頁籤只有圖示、名稱在 title', JSON.stringify(tabs));
const txt = await page.$eval('.udash', (e) => e.innerText);
check(/\d,\d{3}/.test(txt) && !/\b\d{5,}\b/.test(txt.replace(/,/g, '#')), '數字有千分位（沒有裸的長數字）', txt.slice(0, 80));
check(!/[✅⌛]|天\s*\d+\/\d+/.test(await page.$eval('#page', (e) => e.innerText)), '沒有 ✅／⌛／「天 N/M」');
check((await page.$$('.udash .urow .udollar')).length >= 1 && (await page.$$('.udash .urow.ok .udollar')).length === 0, '越線的列亮 $、沒越線的列沒有任何符號');
const first = await page.$eval('.udash .urow', (e) => e.dataset.ukey);
check(first === 'ai', '計費項固定順序、AI 在第一列', first);
const w = await page.$eval('.udash .urow.ok .ubar i', (e) => e.getBoundingClientRect().width).catch(() => -1);
check(w >= 0, '進度條畫得出來');
const t1 = await page.$eval('.udash .uodov .uused', (e) => e.textContent);
await page.waitForTimeout(3500);
const t2 = await page.$eval('.udash .uodov .uused', (e) => e.textContent);
check(t1 !== t2, '里程表會跳（兩次讀取之間變大）', `${t1} → ${t2}`);
check((await page.$$('.udash .ucells .ucell')).length === 3, '中精度三格（離爆多遠／升級／剎車）');
await page.screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'usage-geek.png') });
await page.context().close();
console.log('② youlin：免費、接近上限');
page = await open(STATE, 1);
check((await page.$$('.udash .ucell.dist.near, .udash .ucell.dist.over')).length === 1, '離爆多遠那一格變色');
check((await page.$$('.udash .udollar')).length === 0, '免費帳號不出現 $');
await page.context().close();
console.log('③ 舊版雲端查不到');
const s3 = JSON.parse(JSON.stringify(STATE)); s3.accounts.forEach((a) => { delete a.usage; });
page = await open(s3, 0);
check((await page.$('.udash.unk')) !== null && (await page.$$('.udash .urow')).length === 0, '查不到＝一顆問號燈，沒有編數字');
await page.context().close();
await browser.close(); srv.close();
console.log(bad ? '\n❌ 用量分頁驗收未過' : '\n✅ 用量分頁驗收全過'); process.exit(bad);
