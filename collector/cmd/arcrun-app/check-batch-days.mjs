#!/usr/bin/env node
// check-batch-days.mjs — 「這批還要幾天」的畫面驗收（inkstone/arcrun-rag#209 驗收 2、3）：真瀏覽器、真 GetState 輸出。
//   ① 超過一天的批次：狀態列有 N/M，hover 一句話   ② 第 2 天分子會動（1/4 → 2/4）
//   ③ 一天送得完 / 雲端沒報成本 ＝ 不出現（不編天數、不製造額度話題）
//   ④ 多帳號時只掛在算出這個數字的那一台   ⑤ 小格沒有句子（只有圖示＋N/M）
// 用法：node check-batch-days.mjs <state.json> [dist]   （state 來自 TestDumpStateManual）
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = process.argv[2]; const dist = process.argv[3] || path.join(here, 'frontend', 'dist');
if (!stateFile) { console.error('用法：node check-batch-days.mjs <state.json> [dist]'); process.exit(2); }
let chromium = null;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
  try { const m = await import(spec); chromium = m.chromium || (m.default && m.default.chromium); if (chromium) break; } catch { /* next */ }
}
if (!chromium) { console.log('❌ 找不到 playwright——這支不假裝驗過'); process.exit(1); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const BASE = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let bad = 0;
const check = (ok, msg, d = '') => { console.log(`  ${ok ? '✅' : '❌'} ${msg}${ok ? '' : ' ' + d}`); if (!ok) bad = 1; };
const browser = await chromium.launch();
const host = BASE.accounts[0].host;
// 形狀照 collector.QuotaMeter 的 JSON（quotameter_test.go TestMeterJSONKeysTheFrontendReads 釘住鍵名）
const meter = (over) => Object.assign({ account: host, write_known: true, batch_known: true, batch_total_days: 4, batch_day_no: 1, batch_pending_cards: 412, batch_total_cards: 412, batch_cards_per_day: 149 }, over);
async function open(m, idx = 0) {
  const st = JSON.parse(JSON.stringify(BASE)); st.quotaMeter = m;
  const ctx = await browser.newContext({ viewport: { width: 1029, height: 760 } }); const page = await ctx.newPage();
  page.on('pageerror', (e) => check(false, 'JS 例外', String(e)));
  await page.addInitScript(`const S=${JSON.stringify(st)};const b={GetState:async()=>S,ListApps:async()=>({apps:[]}),CheckUpdate:async()=>({}),GetFolderTree:async()=>null};window.go={main:{App:new Proxy(b,{get:(t,k)=>(k in t?t[k]:async()=>({}))})}};`);
  await page.goto(origin + '/'); await page.waitForTimeout(300);
  await page.click(`#nav .nav.acct[data-p="lib:${idx}"]`); await page.waitForTimeout(300);
  return page;
}
const cell = (p) => p.$eval('.strip.acc .batchdays', (e) => ({ text: e.innerText.trim(), title: e.getAttribute('title') })).catch(() => null);
console.log('① 第 1 天、共 4 天');
let page = await open(meter());
let c = await cell(page);
check(c && c.text === '1/4', '狀態列出現 1/4', JSON.stringify(c));
check(c && /4 天/.test(c.title) && /第 1 天/.test(c.title) && c.title.replace(/\s/g, '').length <= 25, 'hover 一句話、≤25 字', c && c.title);
check(c && !/[，。,.]/.test(c.title) && c.text.length <= 5, '小格只有 N/M、hover 沒有標點', JSON.stringify(c));
await page.screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'batchdays-day1.png') });
await page.context().close();
console.log('② 隔天（第 2 天）');
page = await open(meter({ batch_day_no: 2, batch_pending_cards: 263 }));
c = await cell(page);
check(c && c.text === '2/4', '分子跟著動：2/4', JSON.stringify(c));
await page.screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'batchdays-day2.png') });
await page.context().close();
console.log('③ 不該出現的時候');
page = await open(meter({ batch_total_days: 1, batch_day_no: 1 }));
check((await cell(page)) === null, '一天送得完＝不出現（裝一次試試看沒有額度話題）');
await page.context().close();
page = await open(meter({ batch_known: false, batch_total_days: 0, batch_day_no: 0 }));
check((await cell(page)) === null, '雲端沒報每卡成本＝不出現（不編天數）');
await page.context().close();
page = await open(null);
check((await cell(page)) === null, '沒有用量表資料＝不出現');
await page.context().close();
console.log('④ 多帳號只掛一台');
page = await open(meter(), 1);
check((await cell(page)) === null, '不是算出這個數字的那一台＝不出現');
await page.context().close();
await browser.close(); srv.close();
console.log(bad ? '\n❌ 這批還要幾天 驗收未過' : '\n✅ 這批還要幾天 驗收全過'); process.exit(bad);
