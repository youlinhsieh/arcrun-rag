// check-text-budget.mjs — 安裝器畫面的字數預算檢查（inkstone/arcrun-rag#240 c18316）
//
// 與小幫手共用同一份預算與同一份量測邏輯：repo 根的 schemas/text-budget.json、schemas/text-budget-audit.mjs。
// 做法：用真的 installPage()／INSTALL_SCRIPT／installWarnings()，在瀏覽器裡把「進度、完成、錯誤、
// 管理員彈窗、各種提醒卡」逐個畫出來，量看得到的字。超過預算就印出來並 exit 1。
//
// 範圍：安裝進行中與結果頁（含警告卡、錯誤卡、彈窗）。首頁的說明長文（把知識庫裝到你自己的雲端空間…）
// 是出貨文案契約（copy-contract.test.mjs）管的另一塊，尚未納入——見 #240 留言。
//
// 跑法：node --experimental-sqlite check-text-budget.mjs
import http from 'node:http';
import { auditPage } from '../../schemas/text-budget-audit.mjs';
import worker, { installPage, INSTALL_SCRIPT, installWarnings } from './worker.js';

async function loadChromium() {
  for (const spec of ['playwright', '/Users/youlinhsieh/Documents/tech_projects/InkStoneCo/products/arcrun-rag/node_modules/playwright/index.js']) {
    try { const m = await import(spec); const c = m.chromium || (m.default && m.default.chromium); if (c) return c; } catch { /* 下一個 */ }
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) { console.log('⚠️  沒有 playwright，跳過'); process.exit(0); }
void worker;

const page_html = installPage({}).replace('</body>', '<script src="/install.js"></script></body>');
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/install.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(INSTALL_SCRIPT); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page_html);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

// 讓所有提醒都觸發的結果（真的 installWarnings 產生的字，不是手抄的）
const FULL = {
  url: 'https://arcrun-rag-ui.example.workers.dev', accountName: 'geek6688', health: { bundle_version: '1.4.88' },
  skippedAccelerators: [{ name: 'idx_a', estimatedCost: 10 }], vectorizeWarning: 'x', vectorizeMetadataWarning: 'x',
  routeWarnings: ['svc-a'], healthWarning: 'x', seedError: 'seed fail', cronSyncError: 'cron fail', secretSyncError: 'sync fail',
  skillsSeedError: 'skills fail', credentialSeedError: 'cred fail',
};
const warnings = installWarnings(FULL).filter((w) => w.audience !== 'internal');

const problems = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1029, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.addInitScript('window.fetch = () => new Promise(() => {});');   // 進度輪詢停住，只量我們畫的
await page.goto(origin + '/');
await page.waitForTimeout(300);

const OPTS = { data: '#inst-url,.url-box a,pre,input,.copy-data,footer,.brand,.xnav', roots: ['body'], hoverExempt: '.brand,.xnav' };
const audit = async (where) => { (await auditPage(page, where, OPTS)).forEach((f) => problems.push(f)); };

await audit('進度頁');
await page.evaluate(() => renderSteps([
  { label: '帳號', state: 'done', note: '已確認你的 Cloudflare 帳號，沒有問題，可以繼續下一步' },
  { label: '服務', state: 'running', note: '正在部署你的專屬服務，可能需要一點時間' },
  { label: '檢查', state: 'warn', note: '' }]));
await audit('進度頁・步驟');

await page.evaluate(({ FULL, warnings }) => {
  renderDone({ result: FULL, warnings, internalNotes: [] });
}, { FULL, warnings });
await page.waitForTimeout(150);
await audit('完成頁・警告全開＋管理員彈窗');

await page.evaluate(() => { document.getElementById('acct-modal-overlay')?.remove(); document.getElementById('result').innerHTML = ''; });
await page.evaluate(() => renderError({ error: { step: 'deploy', stepLabel: '服務', message: '部署你的專屬服務時，雲端回了一個沒有預期到的錯誤，請稍後再試', hint: '請按「重新安裝」再試一次；若持續失敗，請把技術細節回報給我們。', detail: 'x', action: { href: '/', label: '回首頁重新連結' } } }));
await audit('錯誤頁');

await page.evaluate(() => { document.getElementById('error').innerHTML = noteCard('var(--warn)', '網址', '這是一段很長的關於專屬網址的說明，原本會整段常駐在畫面上，現在只在展開時最多顯示三行') + noteCard('var(--warn)', '換版本', '同一個帳號之前在另一個通道安裝過，這次會覆蓋它'); });
await audit('提醒卡');
if (errs.length) problems.push('JS 例外：' + errs[0]);
await browser.close(); srv.close();

if (problems.length) {
  const uniq = [...new Set(problems)];
  console.log(`❌ 安裝器字數預算：${uniq.length} 處超出`);
  uniq.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('✅ 安裝器字數預算：結果頁全部在預算內');
