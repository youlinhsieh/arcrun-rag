// check-launcher.mjs — App 啟動器的**看得見的驗收**（inkstone/arcrun-rag#137）
//
// 🔴 leo 2026-08-04：「既然是 Web，你做的時候**無法檢視**？」
//    ⇒ 這支就是那句話對 App 啟動器的兌現：真的把 frontend/dist 渲染出來、
//      真的按下去、真的量畫面上有什麼，而不是「看程式碼覺得應該會動」。
//
// 與旁邊 check-render.sh 的分工：
//   · check-render.sh  量 CIS 的像素（lockup 接合／深色模式）——只跑得動 macOS 的 Chrome
//   · 本檔             驗 App 啟動器的**行為**（九宮格／點進去／sandbox 橋／既有頁沒壞）
//     用 playwright 的 chromium，macOS／Linux／CI 都跑得動
//
// 跑法：`node check-launcher.mjs`（沒裝 playwright 就自己跳過，不擋別人的流程）
// 產出：截圖在 /tmp/arcrun-launcher-shots/，每一條檢查印一行 ✅／❌
//
// ⚠️ 這支驗的是**前端這一半**（畫面、互動、sandbox 邊界）。後端那一半
//    （真的去問實例、session／API key 兩條路、白名單由實例裁決）在 apps_test.go，
//    那裡打的是照上游原始碼寫的假實例。**兩邊都綠才算前後端一體。**
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'frontend', 'dist');
const shots = '/tmp/arcrun-launcher-shots';

// playwright 從哪裡來：本地 node_modules 優先，其次全域安裝（CI／雲端常見）。
// CommonJS 包從 ESM import 進來時，具名匯出可能只在 default 上，兩種都接。
async function loadChromium() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright/index.js'];
  for (const spec of tries) {
    try {
      const m = await import(spec);
      const c = m.chromium || (m.default && m.default.chromium);
      if (c) return c;
    } catch { /* 下一個 */ }
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) {
  console.log('⚠️  沒有 playwright，跳過畫面驗收（npm i -D playwright && npx playwright install chromium）');
  process.exit(0);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('❌ 沒有 frontend/dist——先 npm --prefix frontend run build');
  process.exit(1);
}

// ── 靜態伺服器（dist 原樣，不改任何一個 byte）──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

// ── 假後端：形狀逐欄對齊 apps.go 的 UIAppList／UIAppDetail ──
//
// 🔴 這裡**不是**在假裝 Go 那半會怎麼運作（那由 apps_test.go 打真 HTTP 驗）。
//    這裡只回「Go 已經回過來的東西長什麼樣」，讓畫面有東西可畫。
const mock = (scenario) => `
const scenario = ${JSON.stringify(scenario)};
window.__scenario = scenario;
window.__calls = [];
const APPS = [
  { id: 'note',   name: '筆記', icon: '🗒️', hasUi: true,  version: '0.1.0' },
  { id: 'weekly', name: '週報', icon: '📊', hasUi: false, version: '0.2.0' },
];
const DETAIL = {
  note: { id:'note', name:'筆記', icon:'🗒️', version:'0.1.0', hasUi:true,
    uiHtml: '<h3 id="t">河道</h3><button id="go">寫一則</button><pre id="out"></pre>' +
      '<scr'+'ipt>document.getElementById("go").onclick=async()=>{' +
      'const r=await window.arcrunApp.action("notes-create",{text:"嗨"});' +
      'document.getElementById("out").textContent=JSON.stringify(r);};' +
      'document.title="app-ui-loaded";' +
      'window.__peek=(()=>{try{return typeof parent.go}catch(e){return "BLOCKED:"+e.name}})();' +
      '</scr'+'ipt>',
    workflows:[{name:'notes-create',description:'寫入一則筆記'}], actions:['notes-create'] },
  weekly: { id:'weekly', name:'週報', icon:'📊', version:'0.2.0', hasUi:false, uiHtml:'',
    workflows:[{name:'weekly-report',description:'每週一產週報'}], actions:['weekly-report'] },
};
const ACCOUNTS = [{
  name:'我的知識庫', host:'arcrun-cypher-executor.demo.workers.dev', folders:[{path:'/Users/leo/Notes',accIdx:0}],
  cloudVerKnown:true, cloudVerStale:false, cloudVerMine:'1.4.42', email:'leo@example.com',
}];
window.go = { main: { App: {
  GetState: async () => ({
    version:'v0.18.34', statusBig:'看守中 · 資料夾有變動就會自動整理', statusSub:'上次檢查 10:21',
    syncing:false, engine:'workers-ai', geminiKey:'',
    accounts: scenario === 'noaccount' ? [] : ACCOUNTS,
    steps:[{title:'看守資料夾',meta:'有變動就自動開始',state:'done'},
           {title:'發現變化',meta:'上次 10:20',state:'done'},
           {title:'用 AI 整理成知識卡',state:'done'},
           {title:'上傳到你的知識庫',meta:'上次 3 份',state:'done'}],
    skipped:null, engineTrouble:false, logFolder:'/Users/leo/.arcrun-rag',
    progress:{total:120,done:117,pending:3,cantSync:0,groups:[]}, quota:null,
  }),
  ListApps: async (i) => {
    window.__calls.push(['ListApps', i]);
    if (scenario === 'listerror') return { accIdx:i, account:'我的知識庫', apps:[], error:'連不上這個知識庫——請確認網路正常' };
    if (scenario === 'noapps')    return { accIdx:i, account:'我的知識庫', apps:[], error:'', source:'session' };
    return { accIdx:i, account:'我的知識庫', host:'demo', apps:APPS, error:'', source:'session' };
  },
  GetApp: async (i, id) => {
    window.__calls.push(['GetApp', i, id]);
    if (scenario === 'needlogin') return { id, name:'筆記', icon:'🗒️', needsLogin:true, email:'leo@example.com', workflows:[], actions:[] };
    return DETAIL[id];
  },
  RunAppAction: async (i, id, action, payload) => {
    window.__calls.push(['RunAppAction', i, id, action, payload]);
    if (action !== 'notes-create' && action !== 'weekly-report') throw new Error('這個動作不在這個 App 的白名單內');
    return JSON.stringify({ ok:true, result:{ id:'blk_1', echo: JSON.parse(payload||'{}') } });
  },
  PortalLogin: async (i, pw) => { window.__calls.push(['PortalLogin', i]); if (pw !== 'pw') throw new Error('email 或密碼錯誤'); },
  SyncNow: async () => {}, PickFolder: async () => '', AddFolder: async () => {}, RemoveFolder: async () => {},
  SetAI: async () => {}, OpenURL: () => { window.__calls.push(['OpenURL']); }, OpenLogFolder: async () => {},
  Connect: async () => {}, CheckUpdate: async () => ({ latest:'v0.18.34' }),
  DownloadUpdate: async () => ({}), ApplyUpdate: async () => {}, ExportDiagnostics: async () => '',
}}};
`;

let fail = 0;
const ok = (m) => console.log('  ✅ ' + m);
const ng = (m) => { console.log('  ❌ ' + m); fail = 1; };
const check = (cond, m) => (cond ? ok(m) : ng(m));

fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();

async function open(scenario, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();
  await page.addInitScript(`try{localStorage.setItem('arcrun_app_theme','${theme}')}catch(e){}`);
  await page.addInitScript(mock(scenario));
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(origin);
  await page.waitForTimeout(400);
  return { ctx, page, errs };
}

console.log('━━━ App 啟動器畫面驗收 ━━━');

// ① 打開就是九宮格，磁磚是真資料（不是寫死的）
{
  const { ctx, page, errs } = await open('ok');
  await page.waitForSelector('.appgrid', { timeout: 5000 }).catch(() => {});
  const tiles = await page.$$eval('.appcell .nm', (n) => n.map((e) => e.textContent.trim()));
  check(errs.length === 0, `啟動器沒有 JS 例外${errs.length ? '（' + errs[0] + '）' : ''}`);
  check(await page.$('.appgrid') !== null, '打開就看到九宮格');
  check(tiles.join('|') === '筆記|週報|加裝 App', `磁磚＝實例回的那兩個 App ＋ 加裝（實際：${tiles.join('|')}）`);
  check((await page.$eval('.apphead .s', (e) => e.textContent)).includes('2 個 App 已安裝'), '頁首說得出裝了幾個');
  const calls = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'ListApps').length);
  check(calls === 1, `只問了實例一次，不是每秒輪詢（實際 ${calls} 次）`);
  await page.waitForTimeout(2500);
  const calls2 = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'ListApps').length);
  check(calls2 === 1, `2.5 秒後仍然只問過一次（實際 ${calls2} 次）— 沒有掛在每秒的 tick 上`);
  await page.screenshot({ path: `${shots}/01-launcher-light.png` });
  await ctx.close();
}

// ①b 深色模式也要對
{
  const { ctx, page } = await open('ok', 'dark');
  await page.waitForSelector('.appgrid');
  await page.screenshot({ path: `${shots}/02-launcher-dark.png` });
  check(await page.getAttribute('html', 'data-theme') === 'dark', '深色模式渲染得出來');
  await ctx.close();
}

// ② 點一個「有自帶畫面」的 App → 進 sandbox iframe，且橋真的通
{
  const { ctx, page, errs } = await open('ok');
  await page.waitForSelector('.appgrid');
  await page.click('[data-appopen="note"]');
  await page.waitForSelector('#appFrame', { timeout: 5000 });
  const frame = await (await page.$('#appFrame')).contentFrame();
  await frame.waitForSelector('#go', { timeout: 5000 });
  check(true, '點「筆記」進得去，App 自帶畫面渲染出來');
  // 🔴 sandbox 邊界：iframe 裡的 script 不准碰得到 parent 的 window.go
  //    （那上面掛著 RemoveFolder(takedown)／SetAI／Connect）
  const peek = await frame.evaluate(() => window.__peek);
  check(typeof peek === 'string' && peek.startsWith('BLOCKED'), `iframe 碰不到 parent 的 window.go（實際：${peek}）`);
  // 橋：iframe 按鈕 → postMessage → go.RunAppAction → 回到 iframe
  await frame.click('#go');
  await frame.waitForFunction(() => document.getElementById('out').textContent.length > 0, null, { timeout: 5000 });
  const out = await frame.$eval('#out', (e) => e.textContent);
  check(out.includes('blk_1'), `sandbox 橋走得通，結果回得到 App 畫面（實際：${out.slice(0, 80)}）`);
  const call = await page.evaluate(() => window.__calls.find((c) => c[0] === 'RunAppAction'));
  check(call && call[3] === 'notes-create' && JSON.parse(call[4]).text === '嗨', 'payload 原樣送到後端');
  check(errs.length === 0, `App 頁沒有 JS 例外${errs.length ? '（' + errs[0] + '）' : ''}`);
  await page.screenshot({ path: `${shots}/03-app-ui.png` });
  await ctx.close();
}

// ②b 沒有自帶畫面的 App → 工作流清單 ＋「現在執行」
{
  const { ctx, page } = await open('ok');
  await page.waitForSelector('.appgrid');
  await page.click('[data-appopen="weekly"]');
  await page.waitForSelector('.wfitem', { timeout: 5000 });
  check(await page.$eval('.wfitem .nm', (e) => e.textContent) === 'weekly-report', '沒有畫面的 App 列出它的工作流');
  await page.click('[data-apprun="weekly-report"]');
  await page.waitForFunction(() => document.querySelector('.wfitem .out').textContent.includes('完成'), null, { timeout: 5000 });
  check(true, '「現在執行」按得動，結果顯示在那一列底下');
  await page.screenshot({ path: `${shots}/04-app-workflows.png` });
  await ctx.close();
}

// ③ 三種「不是正常」的狀態都要說人話，且分得出來
{
  const { ctx, page } = await open('noapps');
  await page.waitForSelector('.appgrid');
  const txt = await page.textContent('#page');
  check(txt.includes('這個知識庫還沒有 App'), '一個都沒裝 → 說「還沒有 App」並教怎麼裝');
  check(!txt.includes('連不上'), '一個都沒裝時不准講成連線失敗');
  await page.screenshot({ path: `${shots}/05-empty.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open('listerror');
  await page.waitForTimeout(300);
  const txt = await page.textContent('#page');
  check(txt.includes('暫時看不到') && txt.includes('連不上'), '問不到 → 說「問不到」並帶實例的原話');
  check(!txt.includes('還沒有 App'), '問不到時不准講成「一個都沒裝」');
  await page.screenshot({ path: `${shots}/06-error.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open('noaccount');
  await page.waitForTimeout(300);
  const txt = await page.textContent('#page');
  check(txt.includes('歡迎使用 Arcrun') || txt.includes('還沒有連上知識庫'), '沒連任何實例 → 說人話（連線精靈），不是空白');
  await page.screenshot({ path: `${shots}/07-noaccount.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open('needlogin');
  await page.waitForSelector('.appgrid');
  await page.click('[data-appopen="note"]');
  await page.waitForSelector('#apPw', { timeout: 5000 });
  check(await page.inputValue('#apEmail') === 'leo@example.com', 'session 過期 → 長登入框並預填帳號');
  await page.screenshot({ path: `${shots}/08-needlogin.png` });
  await ctx.close();
}

// ④ 驗收條件 3：現有功能一項都沒少
{
  const { ctx, page, errs } = await open('ok');
  await page.waitForSelector('.appgrid');
  const navs = await page.$$eval('#side .nav .nm', (n) => n.map((e) => e.textContent.trim()));
  for (const want of ['App 界面', '首頁', '我的知識庫', 'AI 設定', '版本與更新']) {
    check(navs.includes(want), `側欄仍有「${want}」`);
  }
  const pages = [
    ['home', '現在的狀態'],
    ['lib:0', '開啟知識庫網頁'],
    ['ai', '用哪個 AI 幫你整理文件'],
    ['update', '版本與更新'],
  ];
  for (const [p, marker] of pages) {
    await page.click(`#side .nav[data-p="${p}"]`);
    await page.waitForTimeout(200);
    const t = await page.textContent('#page');
    check(t.includes(marker), `「${p}」頁還在（找得到「${marker}」）`);
  }
  // 全站頁首的同步狀態與「立刻同步」在每一頁都看得到（首頁換走了它們也沒消失）
  check((await page.textContent('#statusBig')).includes('看守中'), '同步狀態在全站頁首，換頁不會不見');
  check(await page.$('#btnSync') !== null, '「立刻同步」按鈕還在');
  check(errs.length === 0, `逛完全部頁面沒有 JS 例外${errs.length ? '（' + errs[0] + '）' : ''}`);
  await page.screenshot({ path: `${shots}/09-existing-update.png` });
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n截圖：${shots}`);
console.log(fail ? '\n❌ 畫面驗收未過' : '\n✅ 畫面驗收全過');
process.exit(fail);
