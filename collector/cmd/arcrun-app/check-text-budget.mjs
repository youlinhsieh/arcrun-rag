// check-text-budget.mjs — 畫面字數預算的機械檢查（inkstone/arcrun-rag#240 c18306）
//
// 規則：InkStoneCo wiki「說明文字代表設計不良」字數預算節。
//   按鈕 ≤ 4 字／常駐標籤 ≤ 6 字／其餘常駐文字一行 ≤ 20 字且不帶句號逗號／
//   hover 提示 ≤ 25 字且只有一句／通知展開 ≤ 3 行、每行 ≤ 20 字。
// 做法：把真的 GetState 輸出（Go 的 TestDumpStateManual 產生）掛在建好的前端 dist 上，
// 逛過首頁、每個帳號的每個分頁、更新頁、求救頁、首次啟動、各種對話框，把「看得到的字」逐個量。
// 超過預算就印出是哪一頁哪一句並以 exit 1 擋下——新加的字逃不掉。
//
// 用法：node check-text-budget.mjs <state.json> [dist目錄]
// 資料（帳號名、路徑、版本、檔名、網址）不是我們寫的字，不受預算；見 DATA 選擇器。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import { auditPage } from '../../../schemas/text-budget-audit.mjs';
const stateFile = process.argv[2];
const dist = process.argv[3] || path.join(here, 'frontend', 'dist');
if (!stateFile || !fs.existsSync(stateFile)) { console.error('用法：node check-text-budget.mjs <state.json> [dist]'); process.exit(2); }

async function loadChromium() {
  for (const spec of ['playwright', '/Users/youlinhsieh/Documents/tech_projects/InkStoneCo/products/arcrun-rag/node_modules/playwright/index.js', '/opt/node22/lib/node_modules/playwright/index.js']) {
    try { const m = await import(spec); const c = m.chromium || (m.default && m.default.chromium); if (c) return c; } catch { /* 下一個 */ }
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) { console.log('⚠️  沒有 playwright，跳過'); process.exit(0); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const STATE = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const mock = (empty) => `
const S = ${JSON.stringify(STATE)};
if (${empty ? 'true' : 'false'}) S.accounts = [];
const APPS = [{id:'note',name:'筆記',icon:'🗒️',glyph:'note',hasUi:true,version:'0.1.0'}];
const base = { GetState: async () => S, ListApps: async (i) => ({accIdx:i,account:'x',host:'h',apps:APPS,error:'',source:'session',glyphs:{note:'<path d="M1 1"/>'}}),
  PlanFolderCleanup: async () => ({files:5, remove:[{rel:'.wiki',is_dir:true,files:5}], keep:[{rel:'a',reason:'不是我們建的'}]}),
  CheckUpdate: async () => ({ latest:'v9', available:true, notes:'' }), GetFolderTree: async () => null };
window.go = { main: { App: new Proxy(base, { get: (t, k) => (k in t ? t[k] : async () => ({})) }) } };
try { localStorage.setItem('arcrun_app_theme','light'); localStorage.setItem('arcrun_app_pins', JSON.stringify([{h:S.accounts[0]&&S.accounts[0].host,id:'note'}])); } catch (e) {}
`;

// 不是我們寫的字：名稱、路徑、版本、檔名、網址、輸入框。
const DATA = '#rmPlan li,.pickacc,.nm,.path,.host,.kbv,.mono,.num,.av,.nchip,.ftbody,.skiplist,input,textarea,code,pre,.ver,.big-num,.vr,.cnt,.corner,.lb2';
const SENT = /[。，；]/;

const problems = [];
const browser = await chromium.launch();

async function audit(page, where) {
  const found = await auditPage(page, where, { data: DATA, roots: ['#side', '#page', '#sheet'], hoverExempt: '.mapp,.apptile,[data-tnode],.path,[data-data]' });
  found.forEach((f) => problems.push(f));
}

async function openPage(empty) {
  const ctx = await browser.newContext({ viewport: { width: 1029, height: 669 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(mock(empty));
  await page.goto(origin + '/');
  await page.waitForTimeout(500);
  return { ctx, page, errs };
}

{
  const { ctx, page, errs } = await openPage(false);
  await audit(page, '首頁');
  if (await page.$('#notifToggle')) { await page.click('#notifToggle'); await page.waitForTimeout(150); await audit(page, '首頁・通知展開'); }
  const n = await page.$$eval('#nav .nav.acct', (a) => a.length);
  for (let i = 0; i < n; i++) {
    await page.click(`#nav .nav.acct[data-p="lib:${i}"]`);
    await page.waitForTimeout(250);
    for (const tab of ['sync', 'folders', 'apps', 'usage', 'ai']) {
      await page.click(`[data-libtab="${tab}"]`);
      await page.waitForTimeout(250);
      await audit(page, `帳號${i}・${tab}`);
      if (tab === 'folders') {
        const rm = await page.$('[data-rm]');
        if (rm) { await rm.click(); await page.waitForTimeout(150); await page.click('#rmClean').catch(() => {}); await page.waitForTimeout(250); await audit(page, `帳號${i}・移除對話框`); await page.click('#c1'); }
      }
    }
  }
  await page.click('#navUpdate'); await page.waitForTimeout(200); await audit(page, '更新頁');
  await page.click('#uCheck').catch(() => {}); await page.waitForTimeout(250); await audit(page, '更新頁・有新版');
  await page.click('#helpBtn'); await page.waitForTimeout(200); await audit(page, '求救頁');
  await page.click('#navAdd'); await page.waitForTimeout(150); await audit(page, '連線對話框'); await page.click('#c1');
  await page.click('#brandHome'); await page.waitForTimeout(150);
  const add = await page.$('#mappAdd'); if (add) { await add.click(); await page.waitForTimeout(150); await audit(page, '選帳號對話框'); }
  if (errs.length) problems.push(`JS 例外：${errs[0]}`);
  await ctx.close();
}
{
  const { ctx, page } = await openPage(true);
  await audit(page, '首次啟動・第1步');
  await page.click('#obNext').catch(() => {}); await page.waitForTimeout(150);
  await audit(page, '首次啟動・第2步');
  await ctx.close();
}
await browser.close(); srv.close();

if (problems.length) {
  const uniq = [...new Set(problems)];
  console.log(`❌ 字數預算：${uniq.length} 處超出`);
  uniq.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('✅ 字數預算：全部畫面都在預算內');
