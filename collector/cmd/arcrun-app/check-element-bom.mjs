// check-element-bom.mjs — 畫面元素 BOM 檢查（inkstone/arcrun-rag#261）
//
// 規則與判準見 schemas/element-bom-audit.mjs；BOM 本體是同目錄 element-bom.json。
// 用法：node check-element-bom.mjs <state.json> [dist目錄] [--selftest] [--list]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import { auditBom, loadBom } from '../../../schemas/element-bom-audit.mjs';
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FLAG = (f) => process.argv.includes(f);
const stateFile = ARGS[0];
const dist = ARGS[1] || path.join(here, 'frontend', 'dist');
if (!stateFile || !fs.existsSync(stateFile)) { console.error('用法：node check-element-bom.mjs <state.json> [dist]'); process.exit(2); }

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

const BOM = loadBom(path.join(here, 'element-bom.json'));
const problems = []; const waived = []; const stats = [];
const browser = await chromium.launch();

async function audit(page, where, extra) {
  const r = await auditBom(page, where, BOM, { extraEntries: extra });
  stats.push(`${where.padEnd(18, '　')} 元素 ${String(r.parts).padStart(3)}／意義 ${String(r.meanings).padStart(3)}`);
  r.problems.forEach((p) => problems.push(p)); r.waived.forEach((w) => waived.push(w));
  return r;
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
  await page.click('#helpBtn'); await page.waitForTimeout(200); await audit(page, '求救頁'); await page.evaluate(() => document.getElementById('overlay').classList.remove('on'));
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

// ── 自我驗證（--selftest）：判準真的會擋，而不是永遠綠 ──
//   ① 重現 0.18.98：把『同步中』的閃點塞回狀態列（#260 拿掉的那顆），如實登記它的意義 ⇒ 必須被擋，且點名它與同步鈕
//   ② 加一個沒登記的元素 ⇒ 必須被擋，且訊息講得出出路
if (FLAG('--selftest')) {
  const { ctx, page } = await openPage(false);
  await page.click('#nav .nav.acct[data-p="lib:0"]'); await page.waitForTimeout(250);
  const inject = (html) => page.evaluate((h) => { document.querySelector('.strip.acc').insertAdjacentHTML('afterbegin', h); }, html);
  let bad = 0;
  const expect = (ok, msg, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${msg}${ok ? '' : ' ' + detail}`); if (!ok) bad = 1; };
  console.log('自我驗證');
  const base = await auditBom(page, 'selftest', BOM);
  expect(base.problems.length === 0, '#260 之後的畫面：通過', base.problems.join(' / '));
  await inject('<span class="sp" title="同步中"><i class="beat big"></i></span>');
  const old = await auditBom(page, '0.18.98 重現', BOM, { extraEntries: [{ id: 'ver.dot', sel: ".strip.acc .sp[title='同步中']", asks: '小幫手現在是不是在同步、怎麼立刻同步' }] });
  const hit = old.problems.find((x) => x.includes('重複回答'));
  expect(!!hit && hit.includes('ver.dot') && hit.includes('acc.sync'), '0.18.98（版本號灰點＋同步鈕）：被擋並點名兩個元素', old.problems.join(' / '));
  if (hit) console.log('     ' + hit);
  await page.evaluate(() => document.querySelector('.strip.acc .sp[title="同步中"]').remove());
  await inject('<span class="sp" title="新加的東西">新</span>');
  const un = await auditBom(page, '新增未登記', BOM);
  const u = un.problems.find((x) => x.includes('沒登記'));
  expect(!!u && /element-bom\.json/.test(u) && u.includes('就不要加這顆零件'), '新增沒登記的元素：被擋，訊息講得出出路', un.problems.join(' / '));
  if (u) console.log('     ' + u);
  await ctx.close(); await browser.close(); srv.close();
  process.exit(bad);
}
await browser.close(); srv.close();

if (FLAG('--list')) { [...new Set(problems)].forEach((p) => console.log(p)); process.exit(0); }
console.log('元素數／意義數（每個畫面；repeat 的清單整列算一個零件）');
stats.forEach((s) => console.log('  ' + s));
const wg = new Map(); waived.forEach((w) => { const m = w.match(/^\[([^\]]*)\] (.*)$/s); const k = m ? m[2] : w; wg.set(k, [...(wg.get(k) || []), m ? m[1] : '']); });
const uw = [...wg].map(([k, w]) => `${k}（${w.length > 3 ? w.slice(0, 3).join('、') + ' 等' + w.length + '個畫面' : w.join('、')}）`);
if (uw.length) { console.log(`◐ 待 leo 裁示的重複意義：${uw.length} 處（不擋打包，每次都印）`); uw.forEach((w) => console.log('  - ' + w)); }
if (problems.length) {
  const grp = new Map();
  problems.forEach((p) => { const m = p.match(/^\[([^\]]*)\] (.*)$/s); const k = m ? m[2] : p; grp.set(k, [...(grp.get(k) || []), m ? m[1] : '']); });
  const uniq = [...grp].map(([k, w]) => `${k}（${w.length > 3 ? w.slice(0, 3).join('、') + ' 等' + w.length + '個畫面' : w.join('、')}）`);
  console.log(`❌ 元素 BOM：${uniq.length} 處不合格`);
  uniq.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('✅ 元素 BOM：每個元素都登記了意義，沒有重複');
