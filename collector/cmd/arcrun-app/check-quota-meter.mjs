#!/usr/bin/env node
/**
 * check-quota-meter.mjs — 用**真的瀏覽器**打開真的 build，看「今天的用量」那張卡
 * （`inkstone/arcrun-rag#209` 驗收條件：「🔴 **前端要用瀏覽器實看**，不是 curl 抓 HTML」）。
 *
 * 🔴 為什麼不是把它塞進 check-render.sh：那支寫死了 macOS 的 Chrome 路徑
 * （`/Applications/Google Chrome.app/...`），在別的機器上它會印「跳過」然後 **exit 0**
 * ——也就是說在 CI 或雲端 session 上，它從來沒有真的看過畫面，而回報是綠的。
 * 這支用 Playwright 找瀏覽器，找不到就**非零離開**，不假裝自己驗過。
 *
 * 它驗的是「使用者真的讀得到那幾個數字」，不是「HTML 裡有那個字串」：
 *   ① 那張卡在首頁上**常駐**（不必撞到額度就看得到）
 *   ② 上傳那一行是 leo 指名的 `X/Y` 形狀，而且分子分母是後端給的原值
 *   ③ 讀取與寫入是**兩行**，而且寫入撞頂時讀取那一行不跟著變紅
 *   ④ 「這批還要幾天」的 `1/5` 在，而且進度條的寬度跟著它走
 *   ⑤ 撞頂那張卡（#197 的）**還在**——票上明寫「不要為了做儀表板而拿掉它」
 *   ⑥ 兩顆按鈕點得下去（真的按一次，接住它要開的網址）
 *
 * 跑法：`node check-quota-meter.mjs`（需要先 `cd frontend && npm run build`）
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Playwright 從哪裡來。
 *
 * 🔴 **找不到就非零離開，不印「跳過」**——那正是 `check-render.sh` 在非 mac 機器上的病：
 * 它找不到 Chrome 就 `exit 0`，於是「沒看過畫面」與「看過而且沒問題」回報成同一件事。
 * 這支寧可紅，也不要假綠。
 *
 * 先試專案自己的（有人把它裝進 devDependencies 時），再試這台的全域安裝
 * （雲端 session 預裝在 /opt，`PLAYWRIGHT_BROWSERS_PATH` 指著瀏覽器；
 *  **不要跑 `playwright install`**，瀏覽器已經在了）。
 */
async function loadChromium() {
  // playwright 主要是 CJS：經 ESM `import()` 進來時，實體可能在 `default` 底下也可能
  // 被 Node 的具名匯出偵測攤平。兩種都接，別假設其中一種（假設錯的下場是
  // `undefined.launch`，而那個錯訊息完全看不出真因）。
  const pick = (m) => m?.chromium ?? m?.default?.chromium;
  try {
    const got = pick(await import('playwright'));
    if (got) return got;
  } catch { /* 往下試全域 */ }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const got = pick(await import(pathToFileURL(join(root, 'playwright', 'index.js')).href));
    if (got) return got;
    throw new Error('全域的 playwright 載進來了，但裡面沒有 chromium');
  } catch (e) {
    console.error('❌ 找不到 playwright（專案內與全域都沒有）——這支不會假裝自己驗過。');
    console.error(`   ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
const chromium = await loadChromium();

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'frontend', 'dist');
if (!existsSync(DIST)) {
  console.error('❌ 沒有 frontend/dist——先 cd frontend && npm run build');
  process.exit(1);
}

// ── 後端會送上來的那一份（形狀＝collector/quotameter.go 的 QuotaMeter，逐欄對應）──
// 數字是第 12 代的實測值：732 列／卡、免費層 10 萬列／天 ⇒ 一天 136 張。
const METER = {
  account: 'arcrun-cypher-executor.youlin-hsieh-dev.workers.dev',
  write_known: true,
  write_used_rows: 90332,
  write_limit_rows: 100000,
  write_cards_today: 123,
  write_rows_per_card: 732,
  write_generation: 12,
  write_exhausted: false,
  read_limit_rows: 5000000,
  read_exhausted: false,
  read_note: '搜尋用的是另一份額度，比上傳寬鬆得多（這台看不到你搜了幾次，那是在網頁上做的）',
  batch_known: true,
  batch_total_days: 5,
  batch_day_no: 1,
  batch_pending_cards: 412,
  batch_total_cards: 550,
  batch_cards_per_day: 136,
  reset_at: '2026-09-22T00:00:00Z',
};

const STATE = {
  version: 'v0.18.58',
  statusBig: '看守中',
  statusSub: '',
  syncing: false,
  engine: 'workers-ai',
  geminiKey: '',
  logFolder: '/tmp',
  engineTrouble: false,
  accounts: [{ name: '我的知識庫', host: 'youlin-hsieh-dev', email: 'a@b.c', folders: [], cloudVerFresh: true, cloudVerKnown: true, cloudVerMine: '1.4.73' }],
  steps: [{ state: 'done', title: '看守資料夾', meta: '' }],
  skipped: null,
  progress: { total: 550, done: 138, pending: 412, cantSync: 0, groups: [] },
  quota: null,
  quotaMeter: METER,
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function serve() {
  const root = await mkdtemp(join(tmpdir(), 'arcrun-meter-'));
  await cp(DIST, root, { recursive: true });
  // dist 的資產是絕對路徑（/assets/…），本機起的 server 照樣吃得到，不必改寫。
  const srv = createServer(async (req, res) => {
    const p = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    try {
      const b = await readFile(p);
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(b);
    } catch {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, root };
}

const problems = [];
function check(ok, msg, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}${detail ? `　${detail}` : ''}`);
  if (!ok) problems.push(msg);
}

async function open(browser, state) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  // window.go 是 Wails 注入的橋。這裡餵它一份**後端真的會送的形狀**，
  // 前端跑的是原封不動的 build——所以看到的排版就是使用者會看到的那個。
  await page.addInitScript((s) => {
    window.go = { main: { App: {
      GetState: async () => s,
      SyncNow: async () => {}, PickFolder: async () => '', AddFolder: async () => {},
      RemoveFolder: async () => {}, SetAI: async () => {}, Connect: async () => {},
      CheckUpdate: async () => ({}), ListApps: async () => [],
      OpenURL: (u) => { window.__opened = (window.__opened || []).concat(u); },
    } } };
  }, state);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  // 🔴 開起來的預設頁是「App 界面」，不是首頁——側邊欄要**真的點一下**才會換頁。
  // 這正是「用瀏覽器實看」與「抓 HTML 找字串」的差別：靜態 HTML 裡連首頁的骨架都沒有。
  await page.locator('[data-p="home"]').click();
  return page;
}

const { srv, port: PORT } = await serve();
const browser = await chromium.launch();
let shot = null;

try {
  // ── 正常狀態 ────────────────────────────────────────────────────────
  console.log('① 平常打開小幫手（沒撞到任何額度）');
  let page = await open(browser, STATE);
  const card = page.locator('[data-quota-meter="1"]');
  await card.waitFor({ timeout: 10_000 });

  check(await card.isVisible(), '「今天的用量」那張卡常駐在首頁');

  // 只數用量表那一區的行（`.mbatch` 裡的進度條也用同一個 .mrow 版面，不算在內）
  const rows = card.locator('.meter > .mrow');
  check((await rows.count()) === 2, '讀取與寫入是分開的兩行，沒有混成一個數字',
    `實際 ${await rows.count()} 行`);

  const upload = (await rows.nth(0).innerText()).replace(/\s+/g, ' ').trim();
  check(upload.includes('90332/100000'),
    '上傳那一行就是 leo 指名的 `90332/100000` 形狀（沒有千分位、沒有句子）', `→ ${upload}`);

  const search = (await rows.nth(1).innerText()).replace(/\s+/g, ' ').trim();
  check(search.includes('5000000') && !search.includes('100000/'),
    '搜尋那一行講的是它自己的上限，不是寫入的', `→ ${search}`);
  check(!/\d+\/5000000/.test(search),
    '搜尋沒有捏造一個「已用多少」的分子（這台數不到，就不該有數字）');

  // 進度條寬度要真的反映數字（量的是**算好之後的樣式**，不是原始碼裡的字串）
  const wPct = await rows.nth(0).locator('.mbar i')
    .evaluate((el) => Math.round((el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width) * 100));
  check(Math.abs(wPct - 90) <= 2, '上傳的進度條長度跟著那個數字走', `量到 ${wPct}%，數字是 90%`);

  const batch = (await card.locator('.mbatch').innerText()).replace(/\s+/g, ' ').trim();
  check(batch.includes('1/5') && batch.includes('5 天'), '「這批還要幾天」是 1/5 的形狀', `→ ${batch}`);
  check(batch.includes('412'), '講得出還有幾張卡排隊中');

  shot = join(tmpdir(), 'arcrun-209-quota-meter.png');
  await card.screenshot({ path: shot });

  // ── 兩顆按鈕真的按一次 ──────────────────────────────────────────────
  console.log('② 付費那條路點得下去（真的按，不是看 HTML）');
  await card.getByText('怎麼升級付費').click();
  await card.getByText('額度怎麼算').click();
  const opened = await page.evaluate(() => window.__opened || []);
  check(opened.length === 2, '兩顆按鈕都按得動', `開了 ${opened.length} 個網址`);
  check(opened.some((u) => u.includes('/docs/use/quota/#')),
    '「怎麼升級付費」直接跳到升級步驟那一段，不是丟他到頁首', `→ ${opened[0] ?? '(無)'}`);
  await page.close();

  // ── 撞頂狀態：#197 那張卡不准被這張取代 ──────────────────────────────
  console.log('③ 寫入撞頂時（票上明寫「不要為了做儀表板而拿掉」#197 那段話）');
  const blown = JSON.parse(JSON.stringify(STATE));
  blown.quotaMeter = { ...METER, write_exhausted: true, write_used_rows: 100000, batch_day_no: 1 };
  blown.quota = {
    kind: 'd1_write',
    headline: '你的雲端知識庫今天的免費寫入額度用完了',
    usage: 'Cloudflare 免費方案的資料庫寫入上限是每天 10 萬列，今天已經用到上限（這不是小幫手或你的檔案壞掉）',
    guarantee: '台北時間明天早上 8:00 恢復，恢復後小幫手會自動接著傳，你不用做任何事',
    exit_options: '升級 Cloudflare Workers 付費方案（每月 5 美元起）就沒有每日上限',
    resume_at: '2126-09-22T00:00:00Z',
  };
  page = await open(browser, blown);
  await page.locator('[data-quota-meter="1"]').waitFor({ timeout: 10_000 });

  const old = page.locator('[data-quota-kind="d1_write"]');
  check(await old.isVisible(), '#197 那張「額度用完了」的卡還在，沒有被新的用量表取代');
  check((await old.innerText()).includes('8:00'), '它照樣講得出幾點恢復');

  const meterRows = page.locator('[data-quota-meter="1"] .meter > .mrow');
  const upBad = await meterRows.nth(0).locator('.mn.bad').count();
  const readBad = await meterRows.nth(1).locator('.bad').count();
  check(upBad === 1, '寫入那一行標紅了');
  check(readBad === 0, '🔴 讀取那一行**沒有**跟著變紅——這正是 leo 要用戶看到的那件事');
  await page.close();

  // ── 舊版雲端：算不出來就說算不出來 ───────────────────────────────────
  console.log('④ 舊版雲端沒回報每卡成本（算不出來的那一格）');
  const unknown = JSON.parse(JSON.stringify(STATE));
  unknown.quotaMeter = {
    write_known: false,
    write_note: '這台雲端還沒有回報「一張卡要花多少額度」，所以算不出用量——更新雲端之後就會有',
    read_limit_rows: 5000000, read_exhausted: false, read_note: '搜尋用的是另一份額度',
    batch_known: false,
    batch_note: '這台雲端還沒有回報「一張卡要花多少額度」，所以算不出用量——更新雲端之後就會有',
  };
  page = await open(browser, unknown);
  const c2 = page.locator('[data-quota-meter="1"]');
  await c2.waitFor({ timeout: 10_000 });
  const txt = (await c2.innerText()).replace(/\s+/g, ' ').trim();
  check(txt.includes('算不出用量'), '畫面直說算不出來', `→ ${txt.slice(0, 60)}…`);
  check(!/\d+\/100000/.test(txt), '🔴 沒有編一個假的用量數字出來');
  check(!/\d+\/\d+\s*$/.test(txt.replace('5000000', '')), '也沒有編一個假的天數');
  await page.close();
} finally {
  await browser.close();
  srv.close();
}

if (shot) {
  await writeFile(join(tmpdir(), 'arcrun-209-shot-path.txt'), shot);
  console.log(`\n📸 那張卡的截圖：${shot}`);
}
if (problems.length) {
  console.error(`\n❌ ${problems.length} 項沒過：\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✅ 瀏覽器實看：全部過');
