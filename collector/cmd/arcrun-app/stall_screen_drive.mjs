// stall_screen_drive.mjs — inkstone/arcrun-rag#362 真畫面驗收的驅動端（配 stall_screen_manual_test.go）
// 用法：node stall_screen_drive.mjs <port> <report|decline> <截圖目錄> <done檔>
// 流程：開首頁 → 找得到卡 → 看內容 → 同意通報／不用了 → 卡片變化；再到帳號分頁的資料夾頁確認同一張卡也在。
import fs from 'node:fs';
const [port, mode, outDir, doneFile] = process.argv.slice(2);
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
  try { const m = await import(spec); chromium = m.chromium || (m.default && m.default.chromium); if (chromium) break; } catch { /* 下一個 */ }
}
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const log = (...a) => console.log(...a);
let fail = 0;
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) fail++; };
try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('[data-stall-card]', { timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: `${outDir}/1-home.png` });
  const card = page.locator('[data-stall-card]').first();
  check(await card.count() === 1, '首頁看得到停工卡');
  log('卡上的字：', JSON.stringify((await card.innerText()).replace(/\n+/g, ' | ')));
  // 首頁卡要標出是哪個知識庫、不在首頁送出（只帶人跳過去）；送出在該知識庫的頁面上做
  check(/知識庫：/.test(await card.innerText()), '首頁卡標出屬於哪個知識庫');
  check(await page.locator('[data-stallview]').count() === 0, '首頁不直接送出（沒有「看內容」）');
  await page.locator('[data-gostall]').first().click();
  await page.waitForSelector('[data-stallview], [data-stalldecline]', { timeout: 15000 });
  await page.screenshot({ path: `${outDir}/1b-account-page.png` });
  check(/知識庫：/.test(await page.locator('[data-stall-card]').first().innerText()), '帳號頁的卡也標出知識庫');
  check(await page.locator('[data-stallview]').count() >= 1, '帳號頁上有「看內容」按鈕');
  if (mode === 'report') {
    await page.locator('[data-stallview]').first().click();
    await page.waitForSelector('[data-preview]:not([style*="none"])', { timeout: 15000 });
    const pv = await page.locator('[data-preview]').first().innerText();
    check(pv.includes('【自動回報：檔案停工】') && !/\/tmp\/|\/Users\//.test(pv), '看內容：顯示要寄的內容，不含完整路徑');
    log('預覽前 400 字：', pv.slice(0, 400).replace(/\n/g, ' / '));
    await page.screenshot({ path: `${outDir}/2-preview.png` });
    const btn = page.locator('[data-stallview]').first();
    check((await btn.innerText()).trim() === '同意通報', '按鈕變成「同意通報」');
    await btn.click();
    await page.waitForFunction(() => /已通報/.test(document.body.innerText), null, { timeout: 60000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/3-reported.png` });
    // flash 3 秒後會淡出、換成「已通報 · 處理中」卡
    await page.waitForFunction(() => /處理中/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const txt = await page.locator('[data-stall-card]').first().innerText();
    log('通報後卡上的字：', JSON.stringify(txt.replace(/\n+/g, ' | ')));
    check(/已通報/.test(txt) && /處理中/.test(txt), '卡變成「已通報 · 處理中」');
    check(/[A-Za-z0-9#\/-]*\d{2,}/.test(txt), '卡帶票號');
    await page.screenshot({ path: `${outDir}/4-processing.png` });
  } else {
    await page.locator('[data-stalldecline]').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-stall-card]'), null, { timeout: 15000 });
    check(true, '按「不用了」後卡消失');
    await page.screenshot({ path: `${outDir}/2-declined.png` });
  }
  // 帳號分頁的資料夾頁：同一張卡要在資料夾樹旁（只有還在「問」的時候；已通報／不用了就不重複）
  await page.locator('.nav[data-p="lib:0"]').click();
  await page.locator('[data-libtab="folders"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/5-folders-tab.png` });
  const onFolders = await page.locator('[data-stall-card]').count();
  log('資料夾頁上的停工卡數：', onFolders);
  check(mode === 'report' ? onFolders === 1 : onFolders === 0, mode === 'report' ? '資料夾頁也看得到已通報卡（帶票號）' : '不用了之後資料夾頁也沒有卡');
} catch (e) { log('ERROR', e.message); fail++; await page.screenshot({ path: `${outDir}/error.png` }).catch(() => {}); }
fs.writeFileSync(doneFile, 'x');
await browser.close();
process.exit(fail ? 1 : 0);
