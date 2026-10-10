#!/usr/bin/env node
// check-errors.mjs — 「!N 點下去帶到出錯的檔」＋圖示按鈕的畫面驗收（inkstone/arcrun-rag#246 c18700）。
// 真瀏覽器、真 GetState／GetFolderTree 輸出（state 來自 TestZZRealDump 或 TestDumpStateManual 加樹）。
// 用法：node check-errors.mjs <real.json {state,trees}> [dist] [截圖資料夾]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.argv[2]; const dist = process.argv[3] || path.join(here, 'frontend', 'dist');
const shots = process.argv[4] || (process.env.TMPDIR || '/tmp');
if (!dataFile) { console.error('用法：node check-errors.mjs <real.json> [dist] [shots]'); process.exit(2); }
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
const D = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
let bad = 0;
const check = (ok, msg, d = '') => { console.log(`  ${ok ? '✅' : '❌'} ${msg}${ok ? '' : ' ' + d}`); if (!ok) bad = 1; };
const browser = await chromium.launch();
async function open(idx, tab) {
  const ctx = await browser.newContext({ viewport: { width: 1029, height: 760 } }); const page = await ctx.newPage();
  page.on('pageerror', (e) => check(false, 'JS 例外', String(e)));
  await page.addInitScript(`const S=${JSON.stringify(D.state)};const T=${JSON.stringify(D.trees)};window.__reports=[];
    const b={GetState:async()=>S,ListApps:async()=>({apps:[]}),CheckUpdate:async()=>({}),GetFolderTree:async(p)=>T[p]||null,
      ReportedFiles:async()=>[],ReportFileProblem:async(a,r,f)=>{window.__reports.push([a,r,f]);},RefreshUsage:async()=>{}};
    window.go={main:{App:new Proxy(b,{get:(t,k)=>(k in t?t[k]:async()=>({}))})}};`);
  await page.goto(origin + '/'); await page.waitForTimeout(300);
  await page.click(`#nav .nav.acct[data-p="lib:${idx}"]`); await page.waitForTimeout(200);
  if (tab) { await page.click(`[data-libtab="${tab}"]`); await page.waitForTimeout(200); }
  return page;
}
const errN = (i) => D.state.accounts[i].progress.errors;

console.log('① youlin（撞名由機器處理後 !0；#246 c18722）——不得再有名稱撞名的出錯檔');
let page = await open(1);
check(errN(1) === 0, `youlin 帳號出錯數＝0（實際 ${errN(1)}）`);
check((await page.$$('[data-goerr]')).length === 0, '狀態列沒有 !N');
check(!JSON.stringify(D.trees).includes('名稱撞名'), '資料夾樹裡沒有「名稱撞名」');
await page.screenshot({ path: path.join(shots, 'err-youlin-folders.png') });
await page.context().close();

console.log('② geek6688（無解：新問題）——回報鈕');
page = await open(0);
const hdr = await page.$eval('.strip.acc [data-goerr]', (e) => e.textContent.trim());
check(hdr.includes(String(errN(0))), `狀態列 ! 的數字＝帳號出錯數 ${errN(0)}`, hdr);
await page.click('.strip.acc [data-goerr]'); await page.waitForTimeout(700);
const n0 = (await page.$$('.fterr')).length;
check(n0 === errN(0), `出錯檔列數＝${errN(0)}`, String(n0));
check((await page.$$('.fterr.unsolvable [data-fprob]')).length === (await page.$$('.fterr.unsolvable')).length && n0 > 0, '每個無解的檔有自己的回報鈕');
await page.click('.fterr.unsolvable [data-fprob]'); await page.waitForTimeout(300);
const rep = await page.evaluate(() => window.__reports);
check(rep.length === 1 && rep[0][2] && rep[0][1], '回報鈕送出的是「這一份」', JSON.stringify(rep));
check((await page.$$('.fterr.unsolvable .ftdone')).length === 1, '回報後那一列變 ✓');
const sumFolders = await page.$$eval('.folder .bangbtn', (n) => n.reduce((t, e) => t + Number((e.querySelector('b') || {}).textContent || 0), 0));
check(sumFolders === errN(0), `資料夾列 !N 加總＝帳號 !N（${sumFolders}）`);
await page.screenshot({ path: path.join(shots, 'err-geek-folders.png') });
// 資料夾列上的 !N：只展開那一個資料夾
await page.click('.folder .bangbtn'); await page.waitForTimeout(500);
check((await page.$$('.pop')).length === 0, '資料夾列的 !N 也沒有 popup');
await page.context().close();

console.log('③ 圖示按鈕（c18700 第 1–8 項）');
page = await open(1);
const head = await page.$eval('.acchead', (e) => ({
  sync: e.querySelector('[data-synclib]').innerText.trim(), syncT: e.querySelector('[data-synclib]').title, syncSvg: !!e.querySelector('[data-synclib] svg'),
  home: e.querySelector('[data-gohome]') && e.querySelector('[data-gohome]').title, homeFirst: e.firstElementChild.hasAttribute('data-gohome') }));
check(head.sync === '' && head.syncSvg && head.syncT === '同步', '1 同步＝圖示（沒有字），hover 說「同步」', JSON.stringify(head));
check(head.home === '回首頁' && head.homeFirst, '6 帳號標題前有回首頁圖示', JSON.stringify(head));
const cloud = await page.$eval('[data-portal]', (e) => [e.innerText.trim(), e.title, !!e.querySelector('svg')]);
check(cloud[0] === '' && cloud[2] && cloud[1].includes('網頁'), '4 網頁＝雲圖示', JSON.stringify(cloud));
await page.click('[data-gohome]'); await page.waitForTimeout(200);
check(await page.$eval('#brandHome', (e) => e.classList.contains('on')), '6 點回首頁圖示真的回首頁');
await page.click('#nav .nav.acct[data-p="lib:1"]'); await page.click('[data-libtab="folders"]'); await page.waitForTimeout(200);
const add = await page.$eval('[data-addto]', (e) => [e.innerText.trim(), e.title, !!e.querySelector('svg')]);
check(add[0] === '' && add[2] && add[1] === '加資料夾', '8 加資料夾＝圖示', JSON.stringify(add));
await page.click('[data-libtab="apps"]'); await page.waitForTimeout(300);
const rf = await page.$eval('#apRefresh', (e) => [e.innerText.trim(), e.title, !!e.querySelector('svg')]).catch(() => null);
check(rf && rf[0] === '' && rf[2], '7 九宮格重整＝圖示', JSON.stringify(rf));
await page.click('[data-libtab="ai"]'); await page.waitForTimeout(200);
const ai = await page.$eval('#libBody', (e) => e.innerText);
check(!ai.includes('這個知識庫') && ai.includes('CF 帳號'), '2、3 設定不寫「這個知識庫」、帳號改 CF 帳號', ai.slice(0, 60));
await page.screenshot({ path: path.join(shots, 'err-youlin-settings.png') });
await page.close();
await browser.close(); srv.close();
console.log(bad ? '❌ 有項目沒過' : '✅ 出錯導引＋圖示驗收全過');
process.exit(bad);
