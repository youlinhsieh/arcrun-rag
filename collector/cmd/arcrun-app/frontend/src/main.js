// Arcrun 桌面 App — 前端（t193）
//
// 版面（leo 08-04 指定，附 Google Drive 截圖）：左側邊欄、右側換頁。
// 🔴 08-04 二輪回饋（本次處理）：
//   ③「開啟知識庫網頁」不該在首頁（會開到錯的庫）⇒ 移到**各庫頁的上方**
//   ④ 一個庫 30 個資料夾放不下 ⇒ **每個知識庫一個獨立分頁**
//   ⑤「加入資料夾」會加到哪個帳號？⇒ 在庫頁裡加，**作用對象就是那個庫**，不會加錯
//   ⑥ 首頁要顯示 status：看守／發現變化／萃取／上傳 ⇒ **狀態時間軸**
import './arcrun-cis.css';   // 共用底層（色票/字體/紋理）——唯一真相源在 arcrun-cis/css/
import './style.css';        // 本 App 的版面
import { glyphSvg } from './appglyph.js';   // App 圖示：字形由實例提供（與 Portal 同一個來源）

const go = window.go.main.App;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 主題：**與 portal 同一套規則**——預設淺色，使用者切換後存 localStorage
// （leo 問「它有淺色佈景？」⇒ 是，portal 預設就是淺色）
const THEME_KEY = 'arcrun_app_theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } })());
$('themeBtn').onclick = () =>
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

// 側邊欄外殼的幾個固定入口（回首頁／版本與更新／求救），只綁一次：
// 不是 renderPage() 換出來的內容，不能放進 wire()（那裡每次換頁都會重跑）。
// 🔴 走「換頁」不走 openSheet()：style.css :248 的既有規約明寫「覆蓋層只給
// 『確認刪除』這類必須打斷的動作，設定頁一律走右側換頁」——這是一頁內容
// （三張卡＋一個表單），不是一次性確認，混用會違反這條既有規約。
$('helpBtn').onclick = () => goPage('help');
$('navUpdate').onclick = () => goPage('update');
$('brandHome').onclick = () => goPage('home');

let state = null;
// page：'home'（跨帳號總覽）| 'lib:<idx>'（某個帳號）| 'app:<accIdx>:<id>' | 'update' | 'help'
//
// inkstone/arcrun-rag#240 c18254（leo 2026-10-09 + Claude Design 稿）：
// 原本的「首頁／App 界面／AI 設定」並列在側欄、同步狀態掛在全站頁首——
// 那是「一個人一個帳號」的設計，而 Arcrun 的特色就是跨帳號，所以一直縫縫補補。
// 現在：首頁只放跨帳號的東西；App、同步、資料夾、用量、AI 設定全部收進各帳號分頁。
// 不再有全站頁首，也不再有 'apps'／'ai' 這兩個全站頁。
let page = 'home';
let libTab = {};          // accIdx -> 'sync'|'folders'|'apps'|'usage'|'ai'（每個帳號各記自己停在哪一分頁）
let appBack = 'home';     // 從 App 詳情「返回」要回哪（首頁，或某個帳號的 App 分頁）
let updateInfo = null;
let obStep = 1;           // 首次啟動精靈目前在第幾步（issue #23，見 onboarding()）

// ── App 啟動器的暫存（arcrun-rag#137）──
//
// 🔴 這是**畫面暫存，不是本機清單**：只活在這個視窗的記憶體裡，關掉就沒了，
//    永遠不寫檔。上游 inkstone/Arcrun#82 已定「安裝態只有一份真相源」＝實例上那一份，
//    桌面端不准另存一份（本票紅線）。存在這裡只是為了不要每次換頁都重打一次網路。
let appsCache = {};       // accIdx -> ListApps() 的回傳（undefined＝還沒問，null＝正在問）
let appDetail = null;     // 目前打開的那個 App 的詳情（GetApp() 的回傳）
let appDetailKey = '';    // 'accIdx:id'，避免慢回應蓋掉已經換過去的另一個 App
let appFrameBridge = null; // App 自帶畫面那個 iframe 的 postMessage 監聽器（換頁時要拆掉）

// ── 覆蓋層（只給必須打斷的確認）──
function openSheet(html, wire) { $('sheet').innerHTML = html; $('overlay').classList.add('on'); if (wire) wire(); }
function closeSheet() { $('overlay').classList.remove('on'); }
$('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ── 側邊欄：最上面是各個 Cloudflare 帳號（inkstone/arcrun-rag#240 c18254，Claude Design 稿）──
//
// 每個帳號兩行：第一行＝字母圓標＋名稱；第二行＝剩餘用量符號（上傳箭頭＋五格＋%）。
// 圓標右上角的小點只在「這個帳號有事要你看」時出現（錯誤／停工／額度／用量低），
// 平常什麼都沒有——配色只有灰階加一個鏽色，鏽色只給需要你出手的事。
// 帳號清單自己捲，底下的「版本與更新／淺色深色／?」固定在視窗內（CSS #side nav overflow）。
function acctLetters(accs) {
  const first = accs.map((a) => (Array.from(a.name || '?')[0] || '?').toUpperCase());
  const cnt = {};
  first.forEach((l) => { cnt[l] = (cnt[l] || 0) + 1; });
  // 兩個帳號開頭同一個字 ⇒ 改用前兩個字，圓標才分得出誰是誰
  return accs.map((a, i) => cnt[first[i]] > 1
    ? Array.from(a.name || '?').slice(0, 2).join('').toUpperCase() : first[i]);
}

// 說明一律一行：講得完的放在那一行，要看更多才點開（inkstone/arcrun-rag#240 c18275）。
// leo：「說明文字就表示設計不良⋯⋯字數不超過一行，畫面簡潔，可以點擊展開」。
// line＝一行摘要（已跳脫前的純文字）；detail＝點開才看到的 HTML 片段。
// 通知展開：最多 3 行、每行 20 字（預算見 textbudget.go）。超過的在 Go 側已用「…」收尾。
function chunkLines(text, per = 20, max = 3) {
  const r = Array.from(String(text || ''));
  const out = [];
  for (let i = 0; i < r.length && out.length < max; i += per) out.push(r.slice(i, i + per).join(''));
  return out.map((l) => `<div class="d one raw">${esc(l)}</div>`).join('');
}

// Wails 把 Go 的錯誤包成 `Error: …`：去掉英文前綴，只留我們自己的短字（#240 c18387）
function errText(ex) { return String((ex && ex.message) || ex || '').replace(/^Error:\s*/, ''); }
function more(line, detail) {
  if (!detail) return `<div class="d one">${esc(line)}</div>`;
  return `<details class="more"><summary>${esc(line)}</summary><div class="d">${detail}</div></details>`;
}

// 這個帳號「有事要你看」的清單：錯誤、停工、額度撞頂、用量偏低。只講它自己的，不混別人的。
// 側欄的鏽色小點、首頁的「需要處理」、首頁的燈號數字都從這一份來，不各算各的。
function needsOf(s, a) {
  // 「有你可以處理的事」才算（#240 c18340）：每一項都帶用戶做得到的動作——
  //   停工 → 回報／關閉；額度用完 → 升級／關閉；用量警告 → 升級／關閉。
  // 自動重試中的失敗、略過的檔案不算（用戶做不了什麼）：只在狀態列留灰色符號。
  // 一個符號一種單位（#240 c18359）：`!` 只數停住的檔案（＝停住卡標題的數字）；
  // 額度用完用 `⏸`、用量快完靠量表變鏽色，各自不進 `!` 的加總（n 為 0）。
  const out = [];
  const st = (s.stalls || []).filter((x) => x.account === a.name);
  if (st.length) out.push({ text: `⚠ 停住 ${st.reduce((t, x) => t + x.count, 0)}`, tab: 'sync', n: st.reduce((t, x) => t + x.count, 0), kind: 'stall' });
  const q = s.quota;
  if (q && (q.account === a.name || (!q.account && (s.accounts || []).length === 1))) {
    out.push({ text: q.headline || '⏸ 額度用完', tab: 'sync', n: 0, kind: 'quota' });
  }
  const b = a.battery;
  if (b && b.warning) out.push({ text: b.warning, tab: 'usage', n: 0, kind: 'usage' });
  return out;
}
const needsN = (items) => items.reduce((t, x) => t + x.n, 0);

let navLast = '';
function renderNav() {
  const accs = (state && state.accounts) || [];
  const L = acctLetters(accs);
  const onAcc = page.startsWith('lib:') ? Number(page.slice(4))
    : page.startsWith('app:') ? Number(page.split(':')[1]) : -1;
  const html = `
    ${accs.length ? `<div class="sec">帳號</div>` : ''}
    ${accs.map((a, i) => {
      const needs = needsOf(state, a);
      const tip = needs.length ? `${needs.length} 則通知` : (a.cloudVerStale ? '有新版可更新' : '');
      return `
      <div class="nav acct${i === onAcc ? ' on' : ''}" data-p="lib:${i}" role="button" tabindex="0" ${tip ? `title="${esc(tip)}"` : ''}>
        <span class="r1"><span class="av">${esc(L[i])}${needs.length ? '<b class="pip" aria-label="有事要看"></b>' : ''}</span>
          <span class="nm">${esc(a.name)}</span>${!needs.length && a.cloudVerStale ? '<b class="upd" aria-label="有新版可更新"></b>' : ''}</span>
        <span class="r2">${usageGauge(a.battery)}</span>
      </div>`;
    }).join('')}
    <button class="addacct" id="navAdd" title="連結另一個帳號" aria-label="連結另一個帳號">＋</button>`;
  if (html !== navLast) {
    navLast = html;
    $('nav').innerHTML = html;
    $('nav').querySelectorAll('.nav[data-p]').forEach((el) => {
      el.onclick = () => goPage(el.dataset.p);
    });
    const add = $('navAdd'); if (add) add.onclick = showConnect;
  }
  $('navUpdate').classList.toggle('on', page === 'update');
  $('helpBtn').classList.toggle('on', page === 'help');
  $('brandHome').classList.toggle('on', page === 'home');
}

// 換頁的唯一入口（側欄、首頁、各處連結都走這裡）。
// 用量要跟雲端當下一致：只在人為動作（開啟、切到帳號頁、視窗回到前景）時問一次，問完再取一次狀態
async function refreshUsage(idx) {
  try { await go.RefreshUsage(idx); await tick(); } catch (e) { /* 問不到就維持原樣 */ }
}
window.addEventListener('focus', () => refreshUsage(-1));

function goPage(p) {
  if (p === page) { renderPage(); return; }
  // 離開 App 頁時把 iframe 的橋拆掉（見 goToApp 同一段理由）。
  if (page.startsWith('app:') && appFrameBridge) {
    window.removeEventListener('message', appFrameBridge); appFrameBridge = null;
  }
  page = p;
  renderNav(); renderPage();
  if (p.startsWith('lib:')) { ensureTabData(Number(p.slice(4))); refreshUsage(Number(p.slice(4))); }
}
function ensureTabData(idx) {
  if (libTabOf(idx) === 'apps') loadApps(idx);
}
function libTabOf(idx) { return libTab[idx] || 'sync'; }
function setLibTab(idx, tab) {
  libTab[idx] = tab;
  renderPage();
  ensureTabData(idx);
}

// ── 首頁：像手機的主畫面（inkstone/arcrun-rag#240 c18275，leo 2026-10-09 原話）──
//   ① 一條細狀態列：帳號正常幾個、通知（鈴鐺＋每個帳號幾件）、同步中、整體進度
//   ② 常用 App 圖示（使用者從各帳號挑「顯示在首頁」的）
// 就這兩樣。沒有說明段落、沒有「需要你處理」清單：
//   · 通知的內容只住在各帳號自己的分頁（同一個訊息不准在兩頁出現），首頁只給件數，按了跳過去
//   · 同步、資料夾、App、用量、AI 與設定、停工回報，全部在各帳號分頁裡
function pageHome(s) {
  if (!s.accounts || !s.accounts.length) return onboarding();
  return statusStrip(s) + sectionMyApps(s);
}

// 狀態列只放符號加數字，不放句子（#240 c18290，leo：「如果你裡面顯示了一句話就要檢討是否不需要這句話」）。
// 符號的意思放在滑過去才出現的 title，版面上一個字都不佔。
const SYM_SYNC = '<svg class="symic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/></svg>';
let notifOpen = false;   // 「! ×N」有沒有展開（只是畫面偏好，不存檔）

function statusStrip(s) {
  const accs = s.accounts || [];
  const attn = accs.map((a, i) => ({ a, i, n: needsOf(s, a) })).filter((x) => x.n.length);
  const total = attn.reduce((t, x) => t + needsN(x.n), 0);   // 只數停住的檔案
  const quotaHit = attn.some((x) => x.n.some((i) => i.kind === 'quota'));
  const syncing = accs.filter((a) => a.status && a.status.syncing);
  const ok = accs.length - attn.length;
  const p = s.progress || {};
  const parts = [];
  // 引擎本身的問題不屬於任何帳號：一個驚歎號，按了打開紀錄檔資料夾
  if (s.engineTrouble) parts.push(`<button class="sp bad lnkpill" id="hLogs" title="同步引擎需要處理——按一下打開紀錄檔資料夾" aria-label="同步引擎需要處理">!</button>`);
  if (ok > 0) parts.push(`<span class="sp" title="${ok} 個帳號正常" aria-label="${ok} 個帳號正常"><i></i>${ok}</span>`);
  // 「! ×N」：N＝下面各帳號卡片上數字的加總（同一個數字，對得上）；按了展開是哪幾個帳號
  if (quotaHit) parts.push(`<span class="sp bad" title="額度用完" aria-label="額度用完">⏸</span>`);
  if (attn.length) parts.push(`<button class="sp bad lnkpill" id="notifToggle" aria-expanded="${notifOpen}" title="有你可以處理的事" aria-label="${total} 件可處理">${total ? `!&thinsp;×${total}` : '▾'}</button>`);
  if (syncing.length) parts.push(`<span class="sp" title="${syncing.length} 個正在同步" aria-label="${syncing.length} 個正在同步">${SYM_SYNC}&thinsp;×${syncing.length}</span>`);
  // 灰色：自動重試中／略過的檔案——用戶做不了什麼，只留符號，不亮紅
  const retry = accs.reduce((t, a) => t + (a.trouble ? a.trouble.count : 0), 0);
  if (retry) parts.push(`<span class="sp quiet" title="自動重試中" aria-label="自動重試中: ${retry}">↻&thinsp;${retry}</span>`);
  if (s.skipped) parts.push(`<span class="sp quiet" title="${esc(s.skipped.title)}">⊘</span>`);
  const chips = notifOpen && attn.length ? `
    <div class="nlist">${attn.map((x) => `
      <button class="nchip" data-golib="${x.i}" data-tab="${esc(x.n[0].tab)}" title="到這個帳號看">${esc(x.a.name)}<b>${needsN(x.n) || (x.n.some((i) => i.kind === 'quota') ? '⏸' : '⚠')}</b></button>`).join('')}</div>` : '';
  return `
    <section class="strip" aria-label="狀態列">
      ${parts.join('')}
      <span class="grow"></span>
      ${p.total ? `<span class="num" title="已整理的檔案數／全部檔案數">${p.done} / ${p.total}</span>` : ''}
    </section>${chips}`;
}

// 「我的 App」的釘選清單。純畫面偏好（要不要擺在首頁），存在這個視窗的 localStorage，
// 不是安裝態——App 裝在哪、有哪些，真相源仍然只有實例那一份（#137 紅線）。
const PIN_KEY = 'arcrun_app_pins';
function loadPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    return Array.isArray(v) ? v.filter((p) => p && p.h && p.id) : [];
  } catch (e) { return []; }
}
let pins = loadPins();
function isPinned(host, id) { return pins.some((p) => p.h === host && p.id === id); }
function togglePin(host, id) {
  pins = isPinned(host, id) ? pins.filter((p) => !(p.h === host && p.id === id)) : pins.concat([{ h: host, id }]);
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (e) {}
  renderPage();
}

function sectionMyApps(s) {
  const accs = s.accounts || [];
  const L = acctLetters(accs);
  const tiles = [];
  pins.forEach((p) => {
    const idx = accs.findIndex((a) => a.host === p.h);
    if (idx < 0) return;                       // 那個帳號已經不在了
    const r = appsCache[idx];
    const found = r && r.apps ? r.apps.find((x) => x.id === p.id) : null;
    if (r && r.apps && !found) return;         // 已經在實例上被移除
    const name = found ? found.name : p.id;
    // 圖示＝實例提供的字形（與 Portal 同一個來源，見 appglyph.js）；拿不到就是通用圖示
    tiles.push(`
      <button class="mapp" data-appopen="${esc(p.id)}" data-appacc="${idx}" aria-label="${esc(name)}（${esc(accs[idx].name)}）" title="${esc(name)} · 寫入 ${esc(accs[idx].name)}">
        <span class="tile">${glyphSvg(r, found)}<b class="corner">${esc(L[idx])}</b></span>
        <span class="lb">${esc(name)}</span>
      </button>`);
  });
  // 沒有任何說明文字：圖示角上的字母＝帳號，滑過去（title）才講是哪個帳號；
  // 怎麼加 App，點「加一個」進去就看得到。
  return `
    <section class="myapps" aria-label="我的 App">
      <div class="mapps">
        ${tiles.join('')}
        <button class="mapp add" id="mappAdd" aria-label="從某個帳號加一個 App" title="從某個帳號加一個 App 到首頁">
          <span class="tile">＋</span>
        </button>
      </div>
    </section>`;
}


// kbVersionLine：單一知識庫的版本，首頁卡與各庫頁共用同一份（不讓兩處各寫各的）。
//
// 🔴 `inkstone/arcrun-rag#159`（leo 2026-08-28）：「**GUI 是國際通用，圖形指示，
//    不限語文**，所以任何出現文字都要謹慎，文字表示『我的設計不夠好所以要靠文字來補』」
//    ⇒ 這一行以前是三句話（「有新版可更新（目前 x → 最新 y）」「已是最新版（x）」
//      「目前連不上這個知識庫，查不到版本」）。現在只剩**版本號與圖示**：
//
//        1.4.60          ✅     已是最新
//        1.4.46 → 1.4.58 ⬆️     有新版（按鈕，按下去帶 email 開安裝頁）
//        ○                      從來沒查到過這台的版本
//
//    說明都收進 title（滑過去才出現），版面上一個字都不佔。
//
// 🔴 「這一輪連不上」**不再抹掉版本號**（見 collector/direct.go 那段註解）：
//    版本查到過就是事實，抽風的是網路。連不上時版本號調淡，滑過去講得出來。
function kbVersionLine(a) {
  const dim = a.cloudVerFresh ? '' : ' dim';
  const tip = a.cloudVerFresh ? '' : '上次查到的版本（現在暫時連不上）';
  if (!a.cloudVerKnown) {
    // 分得出「沒查到這台的版本」與「查到了但暫時不知道最新版是多少」——
    // 前者連版本號都沒有，後者有版本號可以顯示。
    if (!a.cloudVerMine) {
      return `<span class="kbv unknown" role="img" title="還沒查到這個知識庫的版本">○</span>`;
    }
    return `<span class="kbv${dim}" title="${esc(tip || '暫時查不到最新版本，稍後自動再查')}">${esc(a.cloudVerMine)}</span>`;
  }
  if (a.cloudVerStale) {
    return `<span class="kbv${dim}" title="${esc(tip)}">${esc(a.cloudVerMine)} → ${esc(a.cloudVerLatest)}</span>
      <button class="ico" data-updatekb="${esc(a.email || '')}"
        title="前往安裝頁更新這個知識庫" aria-label="前往安裝頁更新這個知識庫">⬆️</button>`;
  }
  return `<span class="kbv${dim}" title="${esc(tip)}">${esc(a.cloudVerMine)}</span>`;   // 最新版就沒有任何圖示
}

// installURLFor：與 portal 版本卡同一個做法——落後才需要按，按下去帶 email 讓安裝頁
// 預填，既有實例更新免辨識碼（安裝器 t154），不必讓使用者自己去 install.arcrun.dev 找。
function installURLFor(email) {
  const base = 'https://install.arcrun.dev/';
  return email ? base + '?email=' + encodeURIComponent(email) : base;
}

// 🔴 G-6.2「不准安靜地略過」（2026-08-06）——J-1/S6 考題的後半句：
//   「Then 我一樣找得到——**或當場被告知這種檔案還不支援**」
// 以前 .doc／.pages 這類檔在 collector 掃描時就被丟掉，畫面上一個字都沒有，
// 使用者只能得到「我丟了檔，然後什麼都沒發生」這個結論。
// 這張卡就是那句話該出現的地方——**首頁**，他每次打開 App 一定會看到。
// 沒有東西被略過時後端回 null ⇒ 這裡回空字串，畫面保持乾淨（沒事不佔版面）。
// 引擎有問題時才長出來：一鍵打開紀錄檔資料夾。
// leo 2026-08-06：「不能用一個 debug mode？」——log 一直都在寫，缺的是入口。
// 檔案因同一個原因停工 ⇒ 卡片＋「回報給 Arcrun」（inkstone/arcrun-rag#240 c18242）。
// leo：「不然只會在用戶那裡默默死掉，讓我們的信賴下跌」。按一下就送，不必自己打字；
// 送的內容全由後端現場重算（原因分類、份數、檔名樣本、錯誤原文、版本號），不含文件內容。
// 回報過的原因標「已回報」，不再要求按、也不會重複開票。
// onlyAccount＝帳號分頁只顯示它自己的（c18000：每個分頁只講自己的事）；null＝首頁全列。
// 同一個帳號的停工合成一張卡：標題＝件數加總（與狀態列的 `!` 同一個數字），
// 展開看各原因各幾份；一顆「回報」送出全部、一顆 × 關閉（#240 c18341）。
function cardStalls(stalls, onlyAccount) {
  const list = (stalls || []).filter((x) => !onlyAccount || x.account === onlyAccount);
  if (!list.length) return '';
  const total = list.reduce((t, x) => t + x.count, 0);
  const lines = list.slice(0, 3).map((x) => `<div class="d one raw" title="${esc(Array.from(x.label).slice(0, 25).join(''))}">${esc(Array.from(x.label).slice(0, 12).join(''))} ${x.count}</div>`).join('');
  // 鍵可能含任何字元（逗號、引號）：一律用 JSON 陣列放在屬性裡，不用分隔字元拼接再切開
  const fps = esc(JSON.stringify(list.map((x) => x.fingerprint)));
  const keys = esc(JSON.stringify(list.map((x) => x.dismissKey)));
  return `
    <div class="card alertcard" role="alert" data-stall-card="1">
      <button class="x" data-dismiss="${keys}" title="關閉" aria-label="關閉">×</button>
      ${list.length > 1
        ? `<details class="more"><summary>⚠ 停住 ${total}</summary>${lines}</details>`
        : `<div class="nt" data-data="1" title="${esc(Array.from(list[0].label).slice(0, 25).join(''))}">⚠ 停住 ${total}</div>`}
      <div class="acts"><button class="primary" data-stallall="${fps}" data-accidx="${(state.accounts || []).findIndex((x) => x.name === list[0].account)}">回報</button></div>
      <div class="d stallmsg" style="margin-top:6px"></div>
    </div>`;
}

// 「今天的 AI 額度用完了」卡（P8，2026-08-09）。
//
// 🔴 存在理由：封測者 Evan 把「額度用完」讀成「這個 AI 沒效」——歸錯因、罵錯對象。
// collector 那半（quota.go）08-07 就把 leo 定的三句話寫進 status.json 了，
// 但畫面從來沒接，使用者撞牆時只看得到「送不上去 N 份」。
//
// leo 08-07 定的三句話骨架（缺一不可，順序就是敘事順序）：
//   ① 成就：「今天已經幫你整理了 N 份」——先講做到什麼，不是先講失敗
//   ② 出口：「可以換一個模型，或升級 Cloudflare（每月 5 美元）」——給選擇不是死路
//   ③ 保證：「不花錢也沒關係，明天早上 8:00 會自動恢復、會接著跑」
// 三句話原文全部來自後端 QuotaNotice（quota.go 組的），這裡不重組字串——
// 避免同一件事在 status.json、診斷檔、畫面各說各話（措辭漂移）。
// 排隊數取自同一份 s.progress（t210 統計層），讓「還剩多少」也有答案。
// accounts＝s.accounts（首頁帳號列表），只用來判斷「現在看守幾個知識庫」——
// inkstone/arcrun-rag#207：只顧一台知識庫的人不用被多告訴一件事；
// 一旦看守超過一台，就必須講出「爆的是哪一台」，不然使用者會以為爆的是自己正在看的那台
// （leo 2026-09-19 實測：測付費的 leo21c，卻被免費的 youlin 爆掉那則訊息誤導）。
function cardQuota(q, p, accounts) {
  if (!q) return '';
  // 額度用完一張卡一行：「⏸ 額度用完 · 08:00 恢復 · 排隊 N」＋「升級」＋「?」連文件（#240 c18306）。
  // 標題（含種類與恢復時間）由 Go 側 compactUI 組好；這裡只接上排隊數。
  // 多帳號時哪一台爆了，不另寫一行——這張卡本來就只出現在爆的那個帳號自己的分頁。
  void accounts;
  const queue = p && p.pending > 0 ? ` · 排隊 ${p.pending}` : '';
  return `
    <div class="card quotacard alertcard" data-quota-kind="${esc(q.kind || '')}" role="alert">
      <button class="x" data-dismiss="${esc(JSON.stringify([q.dismiss_key || '']))}" title="關閉" aria-label="關閉">×</button>
      <div class="qrow"><span class="qt">${esc(q.headline || '')}${queue}</span>
        <button class="primary" data-openurl="https://rag.arcrun.dev/docs/use/quota/#%E6%80%8E%E9%BA%BC%E5%8D%87%E7%B4%9A%E5%9B%9B%E6%AD%A5">升級</button>
        <button class="qmark" data-openurl="https://rag.arcrun.dev/docs/use/quota/" title="額度怎麼算" aria-label="額度怎麼算">?</button></div>
    </div>`;
}

// 今天的用量：常駐的那張卡（`inkstone/arcrun-rag#209`）。
//
// 🔴 它與上面 cardQuota 是**兩張卡，不互相取代**。leo 2026-09-20 原話：
//   「我覺得**不是告訴他爆了**，而是告訴他你現在的還要多久完成，比如 5 天，
//     那就 **1/5、2/5** 就是現在不能立刻完成就有進度條⋯⋯
//     CF 給一個儀表板，我們也要，他隨時可以看到用了多少剩下多少，
//     而且**看到他查詢不會像大量寫入那樣爆掉**。」
// ⇒ cardQuota 講「現在怎麼辦」（只在撞頂時出現）；這張講「你在整條路的哪裡」（隨時都在）。
//
// 🔴 三條紅線，逐條對應票上的：
//   ① **數字要簡單**——leo：「數字應該簡單不要囉嗦」「`1000/100000`、`90332/100000`」。
//      所以分子分母就是一條斜線，**不加千分位、不加句子**（那個形狀是他指名的）。
//   ② **讀取與寫入不准混成一個數字**——混在一起會讓人以為「這產品就是會爆」，
//      而事實正好相反：會卡的只有灌存量那一段的寫入。
//   ③ **算不出來就說算不出來**——搜尋那一行**刻意沒有分子**：搜尋是使用者在網頁上做的，
//      不經過小幫手 ⇒ 這台數不到，而唯一數得到的地方（Cloudflare 分析 API）打不到
//      （`inkstone/arcrun-rag#197`／`#198` 已裁過「不假裝查得到用量」）。
//      放一個假的分子會比空著更貴——它看起來像個答案。
//
// 🔴 **所有數字都是後端算好的**（collector/quotameter.go），這裡一個算式都沒有——
// 同 cardProgress／cardQuota 的慣例：判斷只住一個接縫，前端只負責畫。
function cardQuotaMeter(m) {
  if (!m) return '';
  const rows = [];

  // ── 上傳（寫入）──────────────────────────────────────────────────
  if (m.write_known) {
    rows.push(meterRow('上傳', `${m.write_used_rows}/${m.write_limit_rows}`,
      pct(m.write_used_rows, m.write_limit_rows), m.write_exhausted,
      `今天送了 ${m.write_cards_today} 張卡，每張約 ${m.write_rows_per_card} 列`));
  } else {
    rows.push(`<div class="mrow"><span class="ml">上傳</span>
      <span class="mn dim" title="${esc(m.write_note || '')}">—</span></div>`);
  }

  // ── 搜尋（讀取）：只講得出上限與現況，見上面紅線③ ───────────────────
  rows.push(`<div class="mrow">
    <span class="ml">搜尋</span>
    <span class="mn dim" title="${esc(m.read_note || '')}">上限 ${m.read_limit_rows}/天</span>
    <span class="mstat ${m.read_exhausted ? 'bad' : 'ok'}" role="img"
      title="${esc(m.read_note || '')}" aria-label="${esc(m.read_note || '')}">${m.read_exhausted ? '🔴' : '✅'}</span>
  </div>`);

  // ── 這批還要幾天（leo 要的 1/5）──────────────────────────────────
  let batch = '';
  if (m.batch_known) {
    batch = `<div class="mbatch">
      <div class="mrow">
        <span class="ml" title="這批還要 ${m.batch_total_days} 天，一天送得了約 ${m.batch_cards_per_day} 張">天</span>
        <span class="mn">${m.batch_day_no}/${m.batch_total_days}</span>
        <span class="mbar"><i style="width:${pct(m.batch_day_no, m.batch_total_days)}%"></i></span>
      </div>
      <div class="mrow"><span class="ml" title="排隊中的卡">⏳</span><span class="mn">${m.batch_pending_cards}</span></div>
    </div>`;
  }
  // 沒資料就顯示「—」，原因放在滑過去才出現的 title，版面不放句子（#240 c18299）
  const why = '';
  return `
    <div class="card" data-quota-meter="1">
      <h3>今天的用量</h3>
      <div class="meter">${rows.join('')}</div>
      ${why}
      ${batch}
      <div class="acts">
        <button class="ghost" data-openurl="https://rag.arcrun.dev/docs/use/quota/#%E6%80%8E%E9%BA%BC%E5%8D%87%E7%B4%9A%E5%9B%9B%E6%AD%A5">升級</button>
        <button class="qmark" data-openurl="https://rag.arcrun.dev/docs/use/quota/" title="額度怎麼算" aria-label="額度怎麼算">?</button>
      </div>
    </div>`;
}

// 🔴 上面「怎麼升級付費」那顆按鈕的錨點是**百分比編碼過的**，而且那串編碼是
// **從真的建出來的 HTML 抓的**（docs-site `npm run build` 之後
// `dist/use/quota/index.html` 裡的 `id="怎麼升級四步"`），不是照標題猜的。
// 標題一改字這個連結就會無聲失效——所以 `quota_meter_links_test.go` 盯著它：
// 那支測試會讀 docs-site 的原始 md，確認那個標題還在。
//
// meterRow＝一行「名稱 ・ 分子/分母 ・ 進度條」。撞頂的那一行整條標紅。
function meterRow(label, num, width, bad, tip) {
  return `<div class="mrow">
    <span class="ml">${esc(label)}</span>
    <span class="mn${bad ? ' bad' : ''}" title="${esc(tip || '')}">${esc(num)}</span>
    <span class="mbar${bad ? ' bad' : ''}"><i style="width:${width}%"></i></span>
  </div>`;
}

// pct＝進度條寬度（0〜100 的整數）。**只給 CSS 寬度用，畫面上的數字一律是後端給的原值**
// ——百分比是這裡唯一算的東西，而它不會被當成事實讀（沒有印出來）。
function pct(a, b) {
  if (!b || b <= 0) return 0;
  const v = Math.round((a / b) * 100);
  return v < 0 ? 0 : (v > 100 ? 100 : v);
}

// 你的檔案：分母 + 三個分類（t210，2026-08-08，取代 08-06 逐檔白話翻譯）。
//
// 🔴 leo 08-08 轉述封測者 Evan：「我有 9000 個檔，雲端只有 101 張卡，畫面卻說
//    『20 份沒送進知識庫』——這幾個數字到底是怎麼回事？」病根是首頁每個數字都是
//    本輪的，使用者問的是總量——這張卡改講總量，四個數字（分母＋已送上去＋排隊中＋
//    送不上去）加起來要對得起來，看完的感覺要是「我知道還沒傳，你不要擔心」。
//
// 🔴 leo 08-08：「我不要枚舉每個檔案可能的問題和解法，應該是統計的」「不解釋細節，
//    無法上傳的也摺疊，想看細節才展開」──「送不上去」預設摺疊，展開只有分類與份數，
//    不逐檔列名、不解釋、不給解法；細節去 Docs 說明文件。
//
// 🔴 分類判斷只住在後端 collector/progress.go 的 ClassifyFailure 一個接縫——
//    這裡完全不認得任何分類名稱字串，`g.category` 原樣印出、順序照後端給的陣列，
//    不在前端排序或分支判斷（t214 之後分類要改成資料驅動，才只需要動後端那一個檔）。
function cardProgress(p) {
  if (!p || !p.total) return '';
  return `
    <div class="card">
      <h3>你的檔案</h3>
      <div class="kv" style="margin-top:10px;flex-wrap:wrap">
        <div><div class="big-num">${p.total}</div><div class="k">共幾份</div></div>
        <div><div class="big-num">${p.done}</div><div class="k">已送上去</div></div>
        <div><div class="big-num">${p.pending}</div><div class="k">排隊中</div></div>
        <div><div class="big-num">${p.cantSync}</div><div class="k">送不上去</div></div>
      </div>
      ${p.cantSync > 0 ? `
      <details class="fail" style="margin-top:14px">
        <summary>看看是哪些原因</summary>
        <ul class="breaklist">
          ${(p.groups || []).map((g) => `<li><span>${esc(g.category)}</span><span>${g.count} 份</span></li>`).join('')}
        </ul>
      </details>` : ''}
    </div>`;
}


// ── 各庫頁：動作全部作用在這個庫（不會加錯帳號）──
// ══════════════════════════════════════════════════════════════════════════
// 資料夾結構樹（`inkstone/InkStoneCo#44` 桌面那半，leo 2026-08-26）
//
// leo 的交付定義第一段：「在 Portal 和**桌面小幫手**上，任何一個連上的資料夾
// 都攤得開它完整的巢狀子資料夾樹，每一層看得到這層有幾份、同步了幾份、
// 沒同步的那幾份為什麼沒上去。」Portal 那半已經在跑，這裡是桌面這半。
//
// 🔴 形狀規格＝`inkstone/Arcrun#144`（leo 2026-08-19 驗 1.4.49 之後打回 markmap）：
//   「我的需求是**向右向下**，類似 terminal 的 tree，**一列一列向下往後退縮**，
//     緊湊但可點擊展開，**模擬 Windows 的檔案總管的 tree**，這是一般辦公室用戶
//     都有的經驗，且可以用滑鼠輕易操作，不會佔用大面積。」
//   ⇒ 一列一行、縮排、可摺疊、字級行距貼近作業系統的檔案總管。
//   ⇒ **不用任何樹狀圖套件**：這個形狀就是「縮排的清單」，一個 div 一列就到位；
//     引一包 library 進來只會多一份要跟著 CIS 對齊的樣式來源。
//
// 🔴 **一個判準都不在這裡發明**（同 portal 那半的紅線）：兩個數字與「為什麼沒收」
//   的分類全部由 collector 算好（`collector/foldertree.go`，判準活在 scan.go 那趟
//   WalkDir）。這裡只做兩件事：把節點串成樹、把子樹的數字加起來。
//   哪天想在這裡寫「.py 算不算支援」——停手，那是第二份實作。
// ══════════════════════════════════════════════════════════════════════════

// data：path → 樹（undefined＝還沒問、null＝問過但小幫手還沒回報）
// open：path → 這個資料夾的樹展開了沒
// nodes：path → { 節點路徑: 展開了沒 }（沒有紀錄＝用預設，見 nodeIsOpen）
// why：path → { 節點路徑: 這一列的「為什麼」被點開了沒 }（arcrun-rag#159）
const treeState = { data: {}, open: {}, nodes: {}, why: {} };

// ── 資料夾那一列的狀態圖示（`inkstone/arcrun-rag#159`）────────────────────
//
// leo 2026-08-28：「補送中、資料夾結構、移除，**變成 3 個 emoticon 就好，
// 畫面上都是字壓力很大**」「他要知道的是『我的資料夾是否同步了』，**有同步打勾就好**」
//
// 🔴 這裡**只做代碼→圖示的對照**，一個判斷都不做。
//    「該不該打勾」住在 Go 那一側（cmd/arcrun-app/folder_badge.go，有測試守著）——
//    前端自己判斷就會變成第二套判準，遲早跟後端說的不一樣。
const SYNC_ICON = { ok: '✅', working: '🔄', trouble: '⚠️', unknown: '○' };

// 資料夾兩個獨立的維度，各一個符號、同時顯示（#240 c18410，leo：「同步有同步中或已完成，
// 有出錯是另一回事，出錯檔案外，其他的也能同步」）：
//   ① 同步＝環形進度＋已送上/可同步總數；全送完（出錯的不算）＝滿環打勾
//   ② 出錯＝旁邊獨立的 `!N`，沒有就不顯示
// 四種組合：同步中＋0 錯／同步中＋有錯／已完成＋0 錯／已完成＋有錯。環不會因為有錯而變色。
function folderProgressHtml(f) {
  const total = f.total || 0, done = f.done || 0, errs = f.errors || 0;
  const frac = total ? Math.min(1, done / total) : 0;
  const C = 2 * Math.PI * 7;
  const ring = `<svg class="fring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <circle cx="9" cy="9" r="7" fill="none" class="bg"/>
    <circle cx="9" cy="9" r="7" fill="none" class="arc" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 9 9)"/>
    ${f.sync === 'ok' ? '<path d="m5.6 9.2 2.3 2.3 4.5-4.8" fill="none" class="ck"/>' : ''}</svg>`;
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const nums = f.sync === 'ok' ? fmt(total) : (total ? `${fmt(done)}/${fmt(total)}` : '—');
  const sync = `<span class="fstat fprog ${esc(f.sync || 'unknown')}" role="img" title="${esc(f.syncTip || '')}" aria-label="${esc(f.syncTip || '')}">${ring}<b class="fnum">${nums}</b></span>`;
  const err = errs ? `<span class="ferr" role="img" title="${errs} 份出錯" aria-label="${errs} 份出錯">!${fmt(errs)}</span>` : '';
  return `<span class="fpair">${sync}${err}</span>`;
}

// 資料夾路徑當不了 DOM id（含空白、斜線、中文）⇒ 折成一個穩定的短碼。
function treeBoxId(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return 'ft' + (h >>> 0).toString(36);
}

// 子樹合計：小幫手送的每個數字都只算「這一層直接放的檔」（存兩套遲早對不起來），
// 所以要顯示「這個資料夾底下總共」就得在這裡疊一次。
// 🔴 **沒走進去**的節點整棵不計：不知道裡面有幾個檔，加 0 會讓分母說謊。
// 分辨方法（inkstone/Arcrun#180 之後）：`skipped` 已經改成「這一層的檔不收」，
// 而**走進去過的節點 total_files 是真的**——所以只有 `total_files === 0` 的
// skipped 節點才是「真的沒走進去」，那種才不計。
// 走進去過的（例如 `system-dev/wiki` 6 個範本檔全排除）要照算，
// 不然 leo 要的「知道資料夾下有幾個檔案被萃」在合計上又變回 0。
// （與 portal 的 rollupTree 同一套算法——兩邊看到的數字必須是同一個。）
function rollupTree(nodes) {
  const byPath = {}, kids = {};
  nodes.forEach((n) => { byPath[n.path] = n; (kids[n.parent] = kids[n.parent] || []).push(n); });
  const sums = {};
  function walk(n) {
    const acc = { total: 0, synced: 0, pending: 0, unsupported: 0, excluded: 0, inProgress: [] };
    if (!n.skipped || n.total_files > 0) {
      acc.total = n.total_files; acc.synced = n.synced_files; acc.pending = n.pending_files;
      acc.unsupported = n.unsupported_files; acc.excluded = n.excluded_files;
      // arcrun-rag#213／c10630：走過續讀機制、還沒讀完的大檔——跟其他計數同一套疊法，
      // 這樣不管在哪一層展開，都看得到底下有沒有正在分次讀的大檔。
      if (n.in_progress_files && n.in_progress_files.length) acc.inProgress = n.in_progress_files.slice();
    }
    (kids[n.path] || []).forEach((c) => {
      const x = walk(c);
      acc.total += x.total; acc.synced += x.synced; acc.pending += x.pending;
      acc.unsupported += x.unsupported; acc.excluded += x.excluded;
      if (x.inProgress.length) acc.inProgress = acc.inProgress.concat(x.inProgress);
    });
    sums[n.path] = acc;
    return acc;
  }
  // 根＝parent 是 '-'（collector/foldertree.go 刻意用它，才分得出「我是根」與「父親是根」）
  (kids['-'] || []).forEach(walk);
  // 孤兒節點（父親不在這份清單裡，例如樹被截斷）也要走一次，否則它整棵不會被算到
  nodes.forEach((n) => { if (sums[n.path] === undefined && !byPath[n.parent]) walk(n); });
  return { sums, kids, byPath };
}

// 差額必須解釋得了：總數 − 已同步 ＝ 不支援 ＋ 不收 ＋ 處理中。
// 這行文案的存在理由就是 leo 那句「不上傳通常是不支援，比如程式碼、不支援的格式」
// ——畫面要自己回答，不必問人。
function gapWhy(s) {
  const parts = [];
  if (s.unsupported > 0) parts.push(s.unsupported + ' 份格式還讀不了');
  if (s.excluded > 0) parts.push(s.excluded + ' 份不在收檔範圍（程式碼等）');
  if (s.pending > 0) parts.push(s.pending + ' 份處理中');
  // arcrun-rag#213／c10630：大檔一次讀不完時，「處理中」不再是一句話帶過——
  // 至少讓使用者看得到「正在動、動到哪了」，不是卡住。小檔沒有這份清單，這裡不加東西。
  if (s.inProgress && s.inProgress.length) {
    const shown = s.inProgress.slice(0, 3).map((f) => `${f.name} ${f.percent}%`).join('、');
    const more = s.inProgress.length > 3 ? `等 ${s.inProgress.length} 份` : '';
    parts.push(`大檔分次讀：${shown}${more}`);
  }
  return parts.join('・');
}

// 預設只展開根那一層——**照檔案總管的行為**：打開一個資料夾看到它底下一層，
// 要更深自己點。一次全攤開在 8000 個檔的資料夾上就是一面沒人看得完的牆。
function nodeIsOpen(path, n) {
  const st = treeState.nodes[path] || {};
  return st[n.path] === undefined ? n.depth === 0 : st[n.path];
}

function renderFolderTree(path) {
  const box = $(treeBoxId(path));
  if (!box) return;
  const tree = treeState.data[path];
  if (tree === undefined) { box.innerHTML = `<div class="ftmsg">讀取中…</div>`; return; }
  // 🔴 分得出「還沒掃到」與「掃過、裡面是空的」——後者是 arcrun-rag#106 的正常情況
  //    （指定了空資料夾，它就該在畫面上存在），前者是「再等一下」。
  //    兩者講同一句話，等於拿我們自己編的答案回答使用者。
  if (tree === null) {
    box.innerHTML = `<div class="ftmsg" title="還沒掃到，第一次同步跑完就會出現">—</div>`;
    return;
  }
  const nodes = tree.nodes || [];
  if (!nodes.length) {
    box.innerHTML = `<div class="ftmsg" title="這個資料夾目前是空的">∅</div>`;
    return;
  }
  const r = rollupTree(nodes);
  let html = '';
  function emit(n) {
    const s = r.sums[n.path] || { total: 0, synced: 0, pending: 0, unsupported: 0, excluded: 0 };
    const kids = (r.kids[n.path] || []).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    const open = kids.length ? nodeIsOpen(path, n) : false;
    // 縮排 16px 一層＝檔案總管的量級；一列一行、往後退縮（Arcrun#144 的形狀）。
    const indent = 4 + n.depth * 16;
    // 🔴 三角形用 CSS 畫（`<i>` 那個空元素），**不用 ▸▾ 字元**：
    //    那兩個字在 Windows 的中文字型裡會被當成全形符號、大小與位置各機器不同，
    //    而它正是 leo 2026-08-19 點名「展開字很小、滑鼠不好按」的那個東西。
    //    畫出來的三角形每一台都一樣大，也才控得住點擊區。
    // 可展開的那幾列是**按鈕**，不是裝飾用的 div：標上 role/tabindex/aria-expanded
    // ⇒ 鍵盤按得到、輔助技術念得出「收合／展開」，機械檢查也看得見它是可操作的。
    let row = `<div class="ftrow${kids.length ? ' has' : ''}${open ? ' open' : ''}" style="padding-left:${indent}px"`
      + (kids.length
        ? ` data-tnode="${esc(n.path)}" data-troot="${esc(path)}" role="button" tabindex="0"`
          + ` aria-expanded="${open}" title="${open ? '收合' : '展開'}「${esc(n.name || '')}」"`
        : '') + `>`
      + `<span class="tw">${kids.length ? '<i></i>' : ''}</span>`
      + `<span class="ic">${kids.length && open ? '📂' : '📁'}</span>`
      + `<span class="nm">${esc(n.name || '（未命名）')}</span>`;
    // ── 一列只有：三角形 ＋ 資料夾名 ＋ `X / Y`（`inkstone/arcrun-rag#159`）──
    //
    // leo 2026-08-28：「**上下廢話刪除**，**產生 GUI 就是要讓人減少讀字降低負擔，
    // 你在 GUI 寫這麼多字剛好違背它的原理**」——他的截圖上同一句
    // 「這是安裝範本時鋪下來的空白樣板…」**在一棵樹裡出現了 5 次**。
    //
    // 🔴 **「收起來」不等於「刪掉」**（本票紅線）：那些理由是使用者要救回被跳過的
    //    資料夾時的線索（`inkstone/arcrun-rag#136`）。所以理由沒有被拿掉，
    //    只是**不再預設佔畫面**——點那個數字就展開這一列自己的理由。
    //    🔴 也**不塞進 tooltip**（同一條紅線：「不要把長句子搬進 tooltip 裡繼續長」），
    //    tooltip 只有「點一下看原因」這種操作提示。
    let why = n.skipped
      ? (n.skip_reason || '—')
      : gapWhy(s);
    // #136 驗收 7：使用者已經手動把這個資料夾收進來了 ⇒ 這一列的「為什麼」講的是他的選擇，
    // 而不是系統的預設判斷（那句已經被他覆寫掉了）。
    if (n.included) why = '已手動收進來';
    // 收檔策略那句話（原本掛在樹的上方，leo 圈掉了）改掛在**根那一列**——
    // 它講的就是這個監看根，點根的數字就看得到，資訊沒有消失。
    if (n.parent === '-' && tree.reason) why = why ? `${tree.reason}（${why}）` : tree.reason;
    // 整棵沒走進去（#180 之後：skipped 且 total_files 為 0）⇒ 不准顯示 0/0，
    // 那會是我們自己編的數字。用「—」表示「這個數字我沒有」。
    const noCount = n.skipped && n.total_files === 0;
    const full = !noCount && s.total > 0 && s.synced === s.total;
    const shown = noCount ? '—' : `${s.synced} / ${s.total}`;
    row += `<span class="num${full ? ' full' : ''}${why ? ' hasWhy' : ''}"`
      + (why
        ? ` data-twhy="${esc(n.path)}" data-twroot="${esc(path)}" role="button" tabindex="0" title="點一下看原因"`
        : '')
      + `>${shown}</span>`;
    html += row + `</div>`;
    if (why && (treeState.why[path] || {})[n.path]) {
      // #136 驗收 5／7：被跳過但底下有檔的資料夾 ⇒ 給「收進來」；已收進來的 ⇒ 給「取消收進來」。
      // 🔴 只在**走進去過、確實有檔**（total_files > 0）的跳過節點上給「收進來」——
      //    整棵沒走進去的（node_modules、巢狀 repo，total_files === 0）就算強制收，後端的
      //    走訪剪枝仍然擋著，按了不會生效，所以不給那顆假按鈕。
      const canInclude = n.skipped && n.total_files > 0 && !n.included;
      let act = '';
      if (n.included) {
        act = `<button class="ftinc" data-tiroot="${esc(path)}" data-tinode="${esc(n.path)}" data-tiact="exclude">取消</button>`;
      } else if (canInclude) {
        act = `<button class="ftinc" data-tiroot="${esc(path)}" data-tinode="${esc(n.path)}" data-tiact="include">收進來</button>`;
      }
      html += `<div class="ftwhy" style="padding-left:${indent + 21}px">${esc(why)}${act}</div>`;
    }
    if (open) kids.forEach(emit);
  }
  (r.kids['-'] || []).forEach(emit);
  // 父親不在清單裡的孤兒（樹被截斷時會有）——照樣列出來，缺角要看得見，不要偷偷藏起來
  const seen = {};
  nodes.forEach((n) => { seen[n.path] = true; });
  nodes.forEach((n) => { if (n.parent !== '-' && !seen[n.parent]) emit(n); });

  // 🔴 樹的上方與下方**什麼都不留**（`inkstone/arcrun-rag#159`，leo 在截圖上圈了三處）：
  //    ① 上方的「全部展開／全部收合 ＋ 這是一般資料夾或筆記庫…」整條拿掉
  //    ② 下方的「數字是『已同步 / 這個資料夾底下總共』…」整段拿掉
  //    ③ 下方的補送說明拿掉（狀態改由資料夾那一列的圖示表達）
  //    leo 原話：「**上下廢話刪除，只留乾淨 Tree**」。
  //
  //    收檔策略那句話（tree.reason）沒有消失——它跟每一列的理由走同一條路：
  //    點根那一列的數字就看得到（emit() 裡的 hasWhy）。
  //
  //    **唯一的例外是截斷警告**：它只在樹真的不完整時才出現，而不講就是讓畫面
  //    宣稱「這是全部」——那是說謊，不是廢話。
  let foot = '';
  if (tree.truncated) {
    foot = `<div class="ftmsg" title="只顯示前 ${nodes.length} 個資料夾，實際有 ${tree.total_nodes} 個">${nodes.length} / ${tree.total_nodes}</div>`;
  }
  box.innerHTML = `<div class="ftbody">${html}</div>${foot}`;
  wireTree();
}

// 展開／收合某個資料夾的樹。第一次展開才去讀（同 portal 的 lazy 做法），
// 之後留在記憶體裡——它是**畫面暫存不是第二份真相源**，關掉視窗就沒了。
async function toggleFolderTree(path) {
  treeState.open[path] = !treeState.open[path];
  const box = $(treeBoxId(path));
  // #159：那顆按鈕現在只有一個 CSS 畫的三角形（沒有文字），轉向由 class 決定。
  const btn = document.querySelector(`[data-tree="${cssq(path)}"]`);
  if (btn) {
    btn.setAttribute('aria-expanded', String(!!treeState.open[path]));
    const row = btn.closest('.folder');
    if (row) row.classList.toggle('open', !!treeState.open[path]);
  }
  if (!box) return;
  box.style.display = treeState.open[path] ? '' : 'none';
  if (!treeState.open[path]) return;
  if (treeState.data[path] !== undefined) { renderFolderTree(path); return; }
  renderFolderTree(path); // 先畫「讀取中…」
  try {
    const t = await go.GetFolderTree(path);
    treeState.data[path] = t || null;   // 後端回 null＝還沒回報過
  } catch (e) {
    box.innerHTML = `<div class="err">讀不到這個資料夾的結構：${esc(String(e))}</div>`;
    return;
  }
  renderFolderTree(path);
}

// 屬性選擇器要跳脫引號——資料夾路徑什麼字元都可能有。
function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }

function wireTree() {
  document.querySelectorAll('[data-tnode]').forEach((el) => {
    const toggle = () => {
      const root = el.dataset.troot, np = el.dataset.tnode;
      const st = treeState.nodes[root] || (treeState.nodes[root] = {});
      const tree = treeState.data[root] || { nodes: [] };
      const n = (tree.nodes || []).find((x) => x.path === np);
      st[np] = !(st[np] === undefined ? (n && n.depth === 0) : st[np]);
      renderFolderTree(root);
    };
    el.onclick = toggle;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
  // #159：點數字＝展開這一列自己的「為什麼」。理由沒有被刪掉，只是不再預設佔畫面。
  // stopPropagation：這個數字常常長在「整列可點＝展開子資料夾」的列上，
  // 不擋住的話點原因會順便把子資料夾收掉。
  document.querySelectorAll('[data-twhy]').forEach((el) => {
    const toggle = (e) => {
      e.stopPropagation();
      const root = el.dataset.twroot, np = el.dataset.twhy;
      const st = treeState.why[root] || (treeState.why[root] = {});
      st[np] = !st[np];
      renderFolderTree(root);
    };
    el.onclick = toggle;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } };
  });
  // #136 驗收 5／7：「收進來」／「取消收進來」。
  document.querySelectorAll('[data-tinode]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); setNodeInclude(el.dataset.tiroot, el.dataset.tinode, el.dataset.tiact === 'include', el); };
  });
}

// setNodeInclude 把使用者的「收進來／取消收進來」寫進後端，然後重讀這棵樹。
// 後端寫完會立刻觸發一次同步（見 IncludeFolder），但同步跑完才會重出樹，中間有延遲
// ——所以先把按鈕停用並顯示「處理中…」，再定時重讀，讓畫面追上真實狀態。
async function setNodeInclude(root, np, include, btn) {
  if (btn) { btn.disabled = true; btn.textContent = include ? '收進來…' : '收回…'; }
  try {
    if (include) await go.IncludeFolder(root, np);
    else await go.ExcludeFolder(root, np);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = include ? '收進來' : '取消收進來'; }
    const box = $(treeBoxId(root));
    if (box) { const m = document.createElement('div'); m.className = 'err'; m.textContent = '沒設定成功：' + String(err); box.appendChild(m); }
    return;
  }
  // 重讀樹：同步一跑完，後端就會把新的樹寫回 folder-trees.json，這一列的狀態就會翻面。
  // 保留這一列的「為什麼」是展開的（treeState.why 不動），使用者的視線不會跳掉。
  await reloadFolderTree(root);
}

// reloadFolderTree 強制重新向後端要一次這棵樹（丟掉畫面暫存），保留展開狀態。
async function reloadFolderTree(root) {
  const box = $(treeBoxId(root));
  try {
    const t = await go.GetFolderTree(root);
    treeState.data[root] = t || null;
  } catch (e) {
    if (box) box.innerHTML = `<div class="err">讀不到這個資料夾的結構：${esc(String(e))}</div>`;
    return;
  }
  renderFolderTree(root);
}

// 剩餘用量符號（Claude Design 稿 Meter.dc.html，leo 2026-10-09 認可）：
// 上傳箭頭＋五格＋百分比。箭頭說明量的是「還能送多少上去」；五格橫排等高——
// 不是電池（沒有外框凸頭）、也不是訊號（不是階梯）。一格＝20%，向上取整。
// 平常深灰；只有免費帳號剩 20% 以下才換鏽色。付費多一個 ∞（不會停）：
//   · 雲端有交免費額度剩餘 % ⇒ 格數＋% 照畫，再加 ∞
//   · 雲端沒交 % ⇒ 只畫 ∞，不編數字
// 問不到雲端（舊版雲端）⇒ 五個空格＋「—」，滑過去講原因，不是整個消失。
// 判準全在雲端與 Go 側（accountBattery），這裡只畫。
const UARROW = '<svg class="uarrow" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M6 8V2M3.5 4.5L6 2l2.5 2.5"/><path d="M1.5 8.5v2h9v-2"/></svg>';
function usageGauge(b) {
  if (!b) {
    const tip = '查不到這個知識庫的剩餘用量（它的雲端版本較舊，更新後就會出現）';
    return `<span class="ugauge unk" title="${esc(tip)}" aria-label="${esc(tip)}">${UARROW}<span class="cells"><i></i><i></i><i></i><i></i><i></i></span><span class="ut">—</span></span>`;
  }
  let cells = '';
  if (b.pctKnown) {
    for (let i = 0; i < b.total; i++) {
      const on = i < b.cells;
      cells += `<i class="${on ? 'on' : (i === 0 && b.level !== 'ok' ? 'zero' : '')}"></i>`;
    }
    cells = `<span class="cells">${cells}</span><span class="ut">${esc(String(Math.round(b.percent)))}%</span>`;
  }
  const inf = b.paid ? `<span class="inf" title="付費帳號：用完免費額度也不會停">∞</span>${b.billing ? '<span class="bill" title="免費額度已用完，現在計費">計費中</span>' : ''}` : '';
  return `<span class="ugauge ${esc(b.level)}${b.paid ? ' paid' : ''}" title="${esc(b.line)}" aria-label="${esc(b.line)}">${UARROW}${cells}${inf}</span>`;
}

// ── 帳號分頁（inkstone/arcrun-rag#240 c18254）──
// 第一行＝帳號名稱；這個帳號自己的狀態、動態、用量、錯誤都在名稱底下；別人的不出現。
// 分頁：同步／資料夾／App／用量／AI 與設定。
const LIB_TABS = [['sync', '同步'], ['folders', '資料夾'], ['apps', 'App'], ['usage', '用量'], ['ai', '設定']];

function libPortalURL(a) {
  return 'https://' + a.host.replace('arcrun-cypher-executor.', 'arcrun-rag-ui.') + '/portal/';
}

function libHeadHtml(a) {
  const b = a.battery;
  // 網址不放（與「開啟知識庫網頁」重複）；同步中的句子也不放——狀態列用符號（#240 c18299）
  return `
    <header class="acchead">
      <div class="g">
        <h1 class="nm">${esc(a.name)}</h1>
      </div>
      <div class="accmeter" title="${esc(b ? b.line : '')}">${usageGauge(b)}</div>
      <button class="primary" data-synclib="1">同步</button>
    </header>
    ${libStatusBar(a, state)}`;
}

// 這個帳號的狀態列：符號加數字（檔案／已送上／排隊中／停住了），同步中時符號會呼吸。
// 通知（錯誤、停工、用量）在它下面，不在它上面。
const SYM = {
  files: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M13 3v5h5"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.8 2.8L16 9.8"/></svg>',
  queue: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>',
};
function libStatusBar(a, s) {
  const p = a.progress;
  const st = a.status || {};
  const item = (cls, sym, n, tip) => `<span class="sp ${cls}" title="${esc(tip)}" aria-label="${esc(tip)}: ${n}">${sym}<b>${n}</b></span>`;
  const need = needsN(needsOf(s, a));
  // 版本併進狀態列：最新就只有一個淡色版本號，沒有任何圖示；有新版才亮圖示加「查看」
  const ver = a.cloudVerMine
    ? (a.cloudVerStale
      ? `<span class="sp"><span class="kbv" title="有新版 ${esc(a.cloudVerLatest || '')}">${esc(a.cloudVerMine)}</span><button class="ico" data-updatekb="${esc(a.email || '')}" title="前往安裝頁更新" aria-label="前往安裝頁更新">⬆ 查看</button></span>`
      : `<span class="sp"><span class="kbv${a.cloudVerFresh ? '' : ' dim'}" title="雲端版本">${esc(a.cloudVerMine)}</span></span>`)
    : '';
  const cells = p ? [
    item('', SYM.files, p.total, '這個帳號的檔案'),
    item('', SYM.done, p.done, '已送上'),
    item('', SYM.queue, p.pending, '排隊中'),
  ].join('') : `<span class="sp" title="還沒有檔案進度">—</span>`;
  // `!` ＝下面卡片上能處理的件數（同一個數字）；`↻`＝自動重試中，灰色
  // 近一小時送上雲端幾份：各帳號各自前進、量得出變快了沒（#240 c18413）
  const rate = a.sentHour != null ? `<span class="sp" title="近一小時送上" aria-label="近一小時送上: ${a.sentHour}"><svg class="symic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg><b>${a.sentHour}</b>/h</span>` : '';
  const bang = need ? item('bad', '<span class="bang">!</span>', need, '停住的檔案') : '';
  const pause = needsOf(s, a).some((i) => i.kind === 'quota') ? `<span class="sp bad" title="額度用完" aria-label="額度用完">⏸</span>` : '';
  const retry = a.trouble ? `<span class="sp quiet" title="自動重試中" aria-label="自動重試中: ${a.trouble.count}">↻&thinsp;${a.trouble.count}</span>` : '';
  return `<section class="strip acc" aria-label="這個帳號的狀態列">${ver}${cells}${rate}${bang}${pause}${retry}<span class="grow"></span>${st.syncing ? `<span class="sp" title="同步中" aria-label="同步中"><i class="beat"></i>${SYM_SYNC}</span>` : ''}</section>`;
}

function libTabsHtml(a, idx) {
  const cur = libTabOf(idx);
  return `
    <div class="tabs" role="tablist" aria-label="這個帳號">
      ${LIB_TABS.map(([k, label]) => `
        <button role="tab" class="tab${k === cur ? ' on' : ''}" aria-selected="${k === cur}" data-libtab="${k}">${label}${k === 'folders' ? ` <span class="cnt">${(a.folders || []).length}</span>` : ''}</button>`).join('')}
      <span class="grow"></span>
      <button class="lnk" data-portal="${esc(libPortalURL(a))}">網頁 ↗</button>
    </div>`;
}

function libBodyHtml(s, a, idx) {
  switch (libTabOf(idx)) {
    case 'folders': return tabFolders(s, a, idx);
    case 'apps': return tabApps(a, idx);
    case 'usage': return tabUsage(s, a);
    case 'ai': return tabAI(a);
    default: return tabSync(s, a);
  }
}

function tabSync(s, a) {
  const q = s.quota && (s.quota.account === a.name || (!s.quota.account && (s.accounts || []).length === 1))
    ? cardQuota(s.quota, a.progress, s.accounts) : '';
  // 「送不上去」的分類統計沒有帳號維度，只有一個帳號時才拿來用，免得把別人的數字掛在這頁
  const groups = (s.accounts || []).length === 1 ? cardProgress(s.progress) : '';
  return `
    ${cardStalls(s.stalls, a.name)}
    ${q}
    ${groups}`;
}

function libTroubleHtml() { return ''; }   // 自動重試中的失敗用戶做不了什麼：不亮、不出卡，只在狀態列留灰色 ↻

function tabFolders(s, a, idx) {
  return `
    <div class="folderbar">
      <button class="primary" data-addto="${idx}">加資料夾</button>
    </div>
    ${(a.folders || []).map((f) => f.retiring ? `
      <div class="folder">
        <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="tag retiring">${f.retireError
          ? '⚠ 收回'
          : `收回中${f.retireRemaining ? ` ${f.retireRemaining}` : '…'}`}</span>
      </div>
      ${f.retireError ? `<div class="d folder-note">${esc(f.retireError)}</div>` : ''}` : `
      <div class="folder${treeState.open[f.path] ? ' open' : ''}">
        <button class="tw" data-tree="${esc(f.path)}" aria-expanded="${!!treeState.open[f.path]}"
          title="展開這個資料夾" aria-label="展開或收合這個資料夾的內容"><i></i></button>
        <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
        ${folderProgressHtml(f)}
        <button class="ico" data-rm="${esc(f.path)}" data-acc="${f.accIdx}"
          title="移除這個資料夾" aria-label="移除這個資料夾並從知識庫收回">🗑</button>
      </div>
      <div class="ftbox" id="${treeBoxId(f.path)}"${treeState.open[f.path] ? '' : ' style="display:none"'}></div>`).join('')
      || `<div class="empty"><div class="t" title="這個知識庫還沒有資料夾">∅</div>
           </div>`}`;
}

// App 分頁：這個帳號裝了哪些 App；每個 App 可以挑「顯示在首頁」（首頁圖示角上會標這個帳號的字母）。
function tabApps(a, idx) {
  const r = appsCache[idx];
  if (r === undefined || r === null) {
    return `<div class="card"><div class="d">…</div></div>`;
  }
  if (r.error) {
    // 🔴 「問不到」與「一個都沒裝」是兩件事，畫面上必須分得出來
    //    （使用者該做的事完全相反：一個是修連線，一個是去裝 App）。
    return `<div class="card">
        ${more('看不到這個知識庫的 App', esc(r.error))}
        <div class="acts"><button id="apRetry">重試</button></div>
      </div>`;
  }
  const apps = r.apps || [];
  return `
    <div class="appbar"><span class="s" title="已安裝的 App">${apps.length}</span>
      <button id="apRefresh">重整</button></div>
    <div class="appgrid">
      ${apps.map((x) => `
        <div class="appcell">
          <div class="apptile" data-appopen="${esc(x.id)}" data-appacc="${idx}" title="${esc(x.name)}${x.version ? ' · v' + esc(x.version) : ''}">${glyphSvg(r, x)}</div>
          <div class="nm" title="${esc(x.name)}">${esc(x.name)}</div>
          <button class="pinbtn${isPinned(a.host, x.id) ? ' on' : ''}" data-pin="${esc(x.id)}" data-pinhost="${esc(a.host)}"
            aria-pressed="${isPinned(a.host, x.id)}">${isPinned(a.host, x.id) ? '已釘' : '釘選'}</button>
        </div>`).join('')}
      <div class="appcell">
        <div class="apptile add" id="apAdd" title="到知識庫網頁加裝 App">＋</div>
        <div class="nm dim">加裝 App</div>
      </div>
    </div>
    `;
}

function tabUsage(s, a) {
  const b = a.battery;
  const head = `<div class="card usagecard"><div class="bigmeter">${usageGauge(b)}</div></div>`;
  // 用量明細（上傳列數、這批還要幾天）只算得出「最吃緊的那一個」帳號，不是這個帳號才畫
  const m = s.quotaMeter && s.quotaMeter.account === a.host ? cardQuotaMeter(s.quotaMeter) : '';
  return `${libBatteryWarnHtml(a)}${head}${m}`;
}

function tabAI(a) {
  return `
    <div class="card">
      <h3>這個知識庫</h3>
      <div class="kv" style="margin-top:10px;flex-wrap:wrap">
        ${a.email ? `<div><div class="k">帳號</div><div class="mono">${esc(a.email)}</div></div>` : ''}
        <div><div class="k">雲端版本</div><div class="kbver">${kbVersionLine(a)}</div></div>
      </div>
    </div>`;
}

function libBatteryWarnHtml(a) {
  const b = a.battery;
  if (!b || !b.warning) return '';
  // Go 側已把警告收成一行標題（「⚠ 用量 18%」「⏸ 用量用完」）；動作＝升級，或 × 關閉（#240 c18340）
  return `<div class="card battery-warn alertcard ${esc(b.level)}" role="alert">
    <button class="x" data-dismiss="${esc(JSON.stringify([b.dismissKey || '']))}" title="關閉" aria-label="關閉">×</button>
    <div class="qrow"><span class="qt">${esc(b.warning)}</span>
      <button class="primary" data-openurl="https://rag.arcrun.dev/docs/use/quota/#%E6%80%8E%E9%BA%BC%E5%8D%87%E7%B4%9A%E5%9B%9B%E6%AD%A5">升級</button></div></div>`;
}



function pageUpdate(s) {
  const u = updateInfo;
  const latest = u ? (u.latest || '查詢中…') : '—';
  let action = `<button class="primary" id="uCheck">檢查更新</button>`;
  let note = '';
  if (u && u.staged) {
    action = `<button class="primary" id="uApply">重啟更新</button>`;
    note = '';
  } else if (u && u.available) {
    action = `<button class="primary" id="uDownload">更新</button>`;
    note = u.notes ? `<div class="d">${esc(u.notes)}</div>` : '';
  } else if (u && u.err) {
    note = `<div class="err">${esc(u.err)}</div>`;
  } else if (u) {
    note = `<div class="d" title="你已經是最新版本">✓</div>`;
  }
  return `
    <div class="card">
      <h3>版本與更新</h3>
      <div class="kv" style="margin-top:12px">
        <div><div class="big-num">${esc(s.version || '—')}</div><div class="k">目前版本</div></div>
        <div><div class="big-num">${esc(latest)}</div><div class="k">最新版本</div></div>
      </div>
      <div style="margin-top:14px">${note}</div>
      <div class="acts">${action}</div>
    </div>
    ${cardDiagnostics()}`;
}

// 疑難排解／求救（inkstone/arcrun-rag#210，取代 t213 舊版）：舊版把「匯出診斷檔」
// 單獨放在這頁最下面，leo 自己都找不到（見票 comment 10302：他把「版本與更新頁最
// 底下」跟「Portal 完全沒有按鈕」搞混，連做這個系統的人都會混淆，何況學員）。
// ⇒ 求救**只有一個入口**：左下角「？」（pageHelp，見下）。這裡不再重複放一份
// 「疑難排解」卡片——票上明講「不准有兩個同名的東西」，此處只留指路。
function cardDiagnostics() {
  return '';   // 求救入口永遠在左下角「?」，這裡不放指路句（#240 c18301）
}

// 求救頁（inkstone/arcrun-rag#210）：leo 2026-09-20「這裏連說明都沒有，但有 3 件事：
// 1）匯出；2）打字回報；3）查看文件及 FAQ，這三件事都是用戶求救的大方，
// 但分開在多個位置，可以都放在一起」——三件事同一個地方，桌面端三件都做得到
// （雲端 Portal 版本第 1 件只能引導去開小幫手，見同票 comment 10305）。
// 走一般換頁（跟 pageAI／pageUpdate 同一套），不走 openSheet 覆蓋層——
// style.css :248 明寫覆蓋層只給「確認刪除」這類必須打斷的動作用。
function pageHelp(s) {
  return `
    <div class="card">
      <h3>回報</h3>
      <textarea id="fbText" rows="5" placeholder="…" style="width:100%;box-sizing:border-box"></textarea>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px">
        <input type="checkbox" id="fbAttach" checked/>
        <span title="只有統計數字，不含你的任何文件內容">附上診斷檔</span>
      </label>
      <div class="err" id="fbErr" style="display:none;margin-top:8px"></div>
      <div class="d" id="fbStatus" style="margin-top:8px"></div>
      <div class="acts"><button class="primary" id="fbSend">送出</button></div>
    </div>

    <div class="card">
      <h3>診斷檔</h3>
      <div class="acts"><button id="uDiag">匯出</button></div>
      <div class="d" id="uDiagStatus" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h3>文件</h3>
      <div class="acts"><button id="uDocs">文件</button></div>
    </div>`;
}

// submitFeedback：送出失敗時**內容不能消失**（票上紅字要求）——只有送出成功才清空
// textarea，失敗的話學員不用重打一次。
async function submitFeedback() {
  const textEl = $('fbText');
  const err = $('fbErr');
  const status = $('fbStatus');
  const btn = $('fbSend');
  const text = (textEl.value || '').trim();
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  if (!text) {
    if (err) { err.textContent = '請先填寫'; err.style.display = 'block'; }
    return;
  }
  const attach = !!($('fbAttach') && $('fbAttach').checked);
  if (btn) btn.disabled = true;
  if (status) status.textContent = '送出中…';
  try {
    await go.SubmitFeedback(text, attach);
    if (status) status.textContent = '已送出 ✓';
    textEl.value = '';
  } catch (ex) {
    if (status) status.textContent = '';
    if (err) {
      const t = errText(ex);
      err.textContent = Array.from(t).slice(0, 60).join('');
      err.style.display = 'block';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── 第一次打開的引導（issue #23，從 #18 拆出來）──
//
// 🔴 leo 的驗法：「拿一個從沒裝過的狀態實際走一次：不看文件、不問人，
//    能不能自己完成第一次設定並看到第一個成果。」
// 舊版只有兩顆按鈕＋兩行字，沒有解釋「這是什麼」，也沒有「我做到哪了」的感覺
// ——這裡改成兩步的小精靈，每步都回答「這是什麼／我該做什麼／我做到哪了」：
//   ① 認識 Arcrun：用大白話講清楚在做什麼，不用任何內部詞（collector／namespace／
//      萃取…），只用「資料夾」「知識卡」「知識庫」這些使用者本來就懂或一看就懂的詞
//   ② 連上或申請知識庫：兩條路並排，「還沒有」那條**當場**講清楚回來要做什麼
//      （不是丟出去一個外部網址就沒事，那正是舊版讓人卡住的地方）
// 連線成功後會直接落回首頁——首頁本來就有「狀態時間軸」＋自動種好的範例資料夾
// （見 default_library.go 的 P4），使用者不必再多做一步就能看到「丟檔案 → 知識卡」
// 這條路真的跑起來，那就是「第一個成果」。
function onboarding() {
  const obDots = `
    <div class="obdots">
      <span class="obdot ${obStep === 1 ? 'on' : 'done'}">${obStep === 1 ? '1' : '✓'}</span>
      <span class="obline"></span>
      <span class="obdot ${obStep === 2 ? 'on' : ''}">2</span>
    </div>`;

  if (obStep === 2) {
    return `
      <div class="empty ob">
        ${obDots}
        <div class="obchoice">
          <div class="obcard">
            <div class="obh">已經有了</div>
            <button class="primary" id="obConnect">連線</button>
          </div>
          <div class="obcard">
            <div class="obh">還沒有</div>
            <button id="obInstall">免費申請</button>
          </div>
        </div>
        <button class="ghost" id="obBack" style="margin-top:16px">‹ 返回</button>
      </div>`;
  }

  return `
    <div class="empty ob">
      ${obDots}
      <div class="t">Arcrun</div>
      <button class="primary" id="obNext">開始設定</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// App 啟動器（arcrun-rag#137）
// ═══════════════════════════════════════════════════════════════════════════
//
// leo 2026-08-24：「所有的 App 需要有一個類似 Android/iOS 的九宮格啟動界面，
// 每個 App 有一個 icon，**這會運行在 portal 及 daemon**。」
//
// 🔴 清單一律問實例，桌面端沒有任何寫死或存檔的 App 名單（本票紅線；
//    上游 inkstone/Arcrun#82「安裝態只有一份真相源」）。後端兩條取得路徑
//    與為什麼是兩條，全寫在 collector/cmd/arcrun-app/apps.go 的檔頭。
//
// 🔴 **不掛在每秒的 tick 上**：只有「打開啟動器」「按重新整理」「切知識庫」
//    這三個使用者動作會真的去問實例一次。把它塞進 tick 等於自造輪詢器。

// loadApps 去問某個知識庫裝了哪些 App；問完只在「使用者還停在啟動器」時重畫。
async function loadApps(accIdx, force) {
  if (!force && appsCache[accIdx] !== undefined) return;
  appsCache[accIdx] = null;                      // null＝問中（畫面顯示「查詢中」）
  if (page === 'home' || page.startsWith('lib:')) renderPage();
  let res;
  try {
    res = await go.ListApps(accIdx);
  } catch (ex) {
    res = { accIdx, apps: [], error: String(ex) };
  }
  appsCache[accIdx] = res;
  if (page === 'home' || page.startsWith('lib:')) renderPage();
}


// ── 單一 App 的頁 ─────────────────────────────────────────────────────────

async function loadAppDetail(accIdx, id) {
  const key = accIdx + ':' + id;
  appDetailKey = key;
  appDetail = null;
  renderPage();
  let d;
  try {
    d = await go.GetApp(accIdx, id);
  } catch (ex) {
    d = { id, error: String(ex) };
  }
  if (appDetailKey !== key) return;   // 使用者已經換去別的 App 了，這份回應作廢
  appDetail = d;
  renderNav();                        // 側欄的 App 子項要顯示名字與 icon
  renderPage();
}

function pageApp(accIdx, id) {
  const d = appDetail;
  const head = (ico, nm, ver) => `
    <div class="head">
      <span class="ico">${glyphSvg(appsCache[accIdx], ((appsCache[accIdx] || {}).apps || []).find((x) => x.id === id))}</span>
      <span class="nm">${esc(nm || id)}</span>
      ${ver ? `<span class="vr">v${esc(ver)}</span>` : ''}
      <span class="sp"></span>
      <button data-appback="1">‹ 返回</button>
    </div>`;

  if (!d) return `<div class="appview">${head('', id, '')}<div class="card"><div class="d">載入中…</div></div></div>`;

  if (d.needsLogin) {
    // session 過期／這台機器還沒換過 session。不是錯誤，是「還差一步」。
    return `<div class="appview">${head(d.icon, d.name, d.version)}
      <div class="card">
        <h3 title="要打開 App 的畫面或執行它的動作，需要在這個知識庫登入一次；之後這台電腦會記住一段時間，同步不受影響">登入</h3>
        <div class="field"><div class="lb">帳號</div>
          <input type="text" id="apEmail" value="${esc(d.email || '')}" disabled/></div>
        <div class="field"><div class="lb">密碼</div><input type="password" id="apPw"/></div>
        <div class="err" id="apErr" style="display:none"></div>
        <div class="acts"><button class="primary" id="apLogin">登入</button></div>
      </div></div>`;
  }

  if (d.error) {
    return `<div class="appview">${head(d.icon, d.name, d.version)}
      <div class="card">
        ${more('打不開這個 App', esc(d.error))}
        <div class="acts"><button id="apReload">重試</button></div>
      </div></div>`;
  }

  if (d.hasUi && d.uiHtml) {
    // 自帶畫面 ⇒ 掛進 sandbox iframe（mountAppUI 會在 wire() 之後填內容）。
    return `<div class="appview">${head(d.icon, d.name, d.version)}
      <iframe class="appframe" id="appFrame" sandbox="allow-scripts"></iframe></div>`;
  }

  // 沒有自帶畫面 ⇒ 列出工作流，一條一顆「現在執行」
  //（與 Portal 的系統預設畫面同一套，不另立第二種呈現）。
  const wfs = d.workflows || [];
  if (!wfs.length) {
    return `<div class="appview">${head(d.icon, d.name, d.version)}
      <div class="empty"><div class="t" title="這個 App 沒有自己的畫面，也沒有登記任何工作流">∅</div></div></div>`;
  }
  return `<div class="appview">${head(d.icon, d.name, d.version)}
    ${wfs.map((w) => `
      <div class="wfitem" data-wf="${esc(w.name)}">
        <div class="top">
          <span class="nm" title="${esc(w.description || '')}">${esc(w.name)}</span>
          <button data-apprun="${esc(w.name)}">執行</button>
        </div>
        
        <div class="out"></div>
      </div>`).join('')}`;
}

// mountAppUI 把 App 自帶的 HTML 放進 **sandbox iframe**。
//
// 🔴 為什麼一定要 iframe（這是桌面端與 Portal 的關鍵差異，不是潔癖）：
//    Portal 是網頁，把 App 的 HTML 直接 innerHTML 進去，那段 script 最多拿到
//    同一頁的 fetch 與 session token。**桌面這半不一樣**——這裡的 window 上掛著
//    `window.go.main.App`：`Connect`／`RemoveFolder(…, takedown=true, cleanupLocal=true)`
//    全都在上面。直接 innerHTML ＝ 任何一個 App 的作者都能刪掉使用者雲端的知識
//    ——#138 之後**連他硬碟上的整理稿也刪得掉**，這道窄門只會越來越重要。
//    ⇒ `sandbox="allow-scripts"`（**不給** allow-same-origin ⇒ 不同源，
//      碰不到 parent 的任何東西），只留一條 postMessage 的窄門。
//
// 🔴 窄門的形狀刻意與 Portal 一致：App 作者一樣只認得
//    `window.arcrunApp.action(action, payload)`，回一個 `{ok,status,d}`——
//    這樣同一個 App 的畫面在 Portal 與桌面上都跑得起來，作者不必寫兩份。
function mountAppUI(accIdx, d) {
  const f = $('appFrame');
  if (!f) return;
  const bridge = `
<script>
(function () {
  var seq = 0, pending = {};
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.__arcrun !== 'result') return;
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    p(m.payload);
  });
  window.arcrunApp = {
    action: function (action, payload) {
      return new Promise(function (resolve) {
        var id = ++seq; pending[id] = resolve;
        parent.postMessage({ __arcrun: 'action', id: id, action: action, payload: payload || {} }, '*');
      });
    }
  };
})();
<\/script>`;
  // 讓 App 的畫面跟本體同一套底色／字體（它是 Arcrun 的一部分，不是外站）。
  const skin = `<style>
    :root{color-scheme:${document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'}}
    html,body{margin:0;padding:16px;background:transparent;
      color:${getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#17181A'};
      font-family:-apple-system,"IBM Plex Sans","PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
      font-size:15px}
  </style>`;
  f.srcdoc = '<!doctype html><meta charset="utf-8">' + skin + bridge + d.uiHtml;
  f.onload = () => {
    if (appFrameBridge) window.removeEventListener('message', appFrameBridge);
    appFrameBridge = async (ev) => {
      if (!f.contentWindow || ev.source !== f.contentWindow) return;   // 只認自己這個 iframe
      const m = ev.data;
      if (!m || m.__arcrun !== 'action') return;
      const reply = (payload) =>
        f.contentWindow && f.contentWindow.postMessage({ __arcrun: 'result', id: m.id, payload }, '*');
      try {
        const raw = await go.RunAppAction(accIdx, d.id, String(m.action || ''), JSON.stringify(m.payload || {}));
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { ok: true, result: raw }; }
        reply({ ok: true, status: 200, d: parsed });
      } catch (ex) {
        reply({ ok: false, status: 0, d: { error: String(ex) } });
      }
    };
    window.addEventListener('message', appFrameBridge);
  };
}

// 畫面更新一律先比對：HTML 沒變就完全不碰 DOM（每秒 tick 會呼叫，不能讓正在輸入、
// 展開著的資料夾樹、iframe 因為重畫而跳掉）。
function paint(el, html, key) {
  if (!el) return false;
  if (el._last === html && (key === undefined || el.dataset.view === key)) return false;
  el._last = html;
  if (key !== undefined) el.dataset.view = key;
  el.innerHTML = html;
  wire(el);
  return true;
}

function renderPage() {
  if (!state) return;
  const root = $('page');
  if (page.startsWith('lib:')) return renderLibPage(root, Number(page.slice(4)));
  // 離開帳號分頁後，下次回來要重建三個區塊
  let html;
  if (page.startsWith('app:')) {
    const p = page.split(':');
    html = pageApp(Number(p[1]), p.slice(2).join(':'));
  }
  else if (page === 'update') html = pageUpdate(state);
  else if (page === 'help') html = pageHelp(state);
  else html = pageHome(state);
  const wasLib = !!$('libBody');
  if (paint(root, html, page)) {
    // App 自帶畫面：DOM 換好之後才掛 iframe（srcdoc 要等元素真的在文件裡）
    if (page.startsWith('app:') && appDetail && appDetail.hasUi && appDetail.uiHtml) {
      mountAppUI(Number(page.split(':')[1]), appDetail);
    }
  }
  void wasLib;
}

// 帳號分頁拆成三個區塊各自更新：名稱＋動態＋用量（每秒會變）、分頁列、分頁內容。
// 這樣每秒跳動的「同步中…」不會連累下面正在看的資料夾樹。
function renderLibPage(root, idx) {
  const a = (state.accounts || [])[idx];
  if (!a) { paint(root, `<div class="empty"><div class="t">—</div></div>`, 'lib:none'); return; }
  const key = 'lib:' + idx;
  if (root.dataset.view !== key || !$('libBody')) {
    root.innerHTML = '<div id="libHead"></div><div id="libTabs"></div><div id="libBody"></div>';
    root.dataset.view = key; root._last = null;
  }
  paint($('libHead'), libHeadHtml(a));
  paint($('libTabs'), libTabsHtml(a, idx));
  paint($('libBody'), libBodyHtml(state, a, idx));
}

function wire(root) {
  root = root || $('page');
  const on = (id, fn) => { const e = root.querySelector('#' + id); if (e) e.onclick = fn; };
  const all = (sel) => root.querySelectorAll(sel);
  // uDocs／uDiag／fbSend：求救頁（pageHelp，inkstone/arcrun-rag#210）專用，
  // 求救只有一個入口，不再散落在別的頁面。
  on('uDocs', () => go.OpenURL('https://rag.arcrun.dev/docs/'));
  on('uDiag', exportDiagnostics);
  on('fbSend', submitFeedback);
  on('hLogs', () => go.OpenLogFolder());
  on('hLogs', () => go.OpenLogFolder());
  on('obConnect', showConnect);
  on('obInstall', () => go.OpenURL('https://install.arcrun.dev/'));
  on('obNext', () => { obStep = 2; renderPage(); });
  on('obBack', () => { obStep = 1; renderPage(); });
  on('uCheck', checkUpdate); on('uDownload', downloadUpdate); on('uApply', applyUpdate);
  all('[data-synclib]').forEach((b) => { b.onclick = async () => { await go.SyncNow(); tick(); }; });
  all('[data-portal]').forEach((b) => { b.onclick = () => go.OpenURL(b.dataset.portal); });
  all('[data-openurl]').forEach((b) => { b.onclick = () => go.OpenURL(b.dataset.openurl); });
  all('[data-stallall]').forEach((b) => {
    b.onclick = async () => {
      const fps = JSON.parse(b.dataset.stallall || '[]');
      const msg = b.closest('.alertcard').querySelector('.stallmsg');
      b.disabled = true;
      if (msg) msg.textContent = '…';
      try {
        for (const fp of fps) await go.ReportStall(fp);   // 回報＝已處理，卡片與紅點隨之消失
        await tick();
      } catch (ex) {
        const t = errText(ex);
        b.disabled = false;
        // 真的失敗只留一行，原因點開才看
        if (msg) msg.innerHTML = `<details class="more"><summary>⚠ 失敗</summary><div class="d one raw">${esc(Array.from(t).slice(0, 20).join(''))}</div></details>`;
      }
    };
  });
  // × 關閉：記住鍵（重開 App 仍不亮），同一原因不再出現；份數變多不算新狀況
  all('[data-dismiss]').forEach((b) => {
    b.onclick = async () => {
      let ks = [];
      try { ks = JSON.parse(b.dataset.dismiss || '[]'); } catch (e) { ks = [b.dataset.dismiss]; }
      if (!Array.isArray(ks)) ks = [ks];
      for (const k of ks.filter(Boolean)) { try { await go.Dismiss(k); } catch (e) { /* 關不掉就保留 */ } }
      await tick();
    };
  });
  all('[data-updatekb]').forEach((b) => {
    b.onclick = () => go.OpenURL(installURLFor(b.dataset.updatekb));
  });
  all('[data-addto]').forEach((b) => { b.onclick = () => addFolder(Number(b.dataset.addto)); });
  all('[data-rm]').forEach((b) => {
    b.onclick = () => confirmRemove(Number(b.dataset.acc), b.dataset.rm);
  });
  // #44：資料夾結構。換頁／重畫之後把本來就展開著的那幾棵補回去——
  // 不補的話使用者每次切回這一頁都得重按一次（狀態在 treeState，畫面卻是空的）。
  all('[data-tree]').forEach((b) => {
    b.onclick = () => toggleFolderTree(b.dataset.tree);
    if (treeState.open[b.dataset.tree]) renderFolderTree(b.dataset.tree);
  });

  // ── 帳號分頁／首頁（inkstone/arcrun-rag#240 c18254）──
  all('[data-libtab]').forEach((b) => {
    b.onclick = () => setLibTab(Number(page.slice(4)), b.dataset.libtab);
  });
  all('[data-golib]').forEach((b) => {
    b.onclick = () => { libTab[Number(b.dataset.golib)] = b.dataset.tab || 'sync'; goPage('lib:' + b.dataset.golib); };
  });
  all('[data-pin]').forEach((b) => { b.onclick = () => togglePin(b.dataset.pinhost, b.dataset.pin); });
  on('mappAdd', pickAccountForApp);
  on('notifToggle', () => { notifOpen = !notifOpen; renderPage(); });

  // ── App 啟動器（arcrun-rag#137）──
  on('apConnect', showConnect);
  on('apRefresh', () => loadApps(Number(page.slice(4)), true));
  on('apRetry', () => loadApps(Number(page.slice(4)), true));
  // 加裝 App 在知識庫網頁的 App 市集做，這裡不放說明，直接帶過去
  on('apAdd', () => { const a = (state.accounts || [])[Number(page.slice(4))]; if (a) go.OpenURL(libPortalURL(a)); });
  on('apReload', () => { const p = page.split(':'); loadAppDetail(Number(p[1]), p.slice(2).join(':')); });
  on('apLogin', appLogin);
  all('[data-appopen]').forEach((b) => {
    b.onclick = () => goToApp(Number(b.dataset.appacc), b.dataset.appopen);
  });
  all('[data-appback]').forEach((b) => {
    b.onclick = () => {
      appDetail = null; appDetailKey = '';
      if (appFrameBridge) { window.removeEventListener('message', appFrameBridge); appFrameBridge = null; }
      page = appBack; renderNav(); renderPage();
      if (page.startsWith('lib:')) ensureTabData(Number(page.slice(4)));
    };
  });
  all('[data-apprun]').forEach((b) => { b.onclick = () => runAppAction(b); });

}

// goToApp 換到某個 App 的頁。換頁前先把上一個 App 的 postMessage 監聽器拆掉——
// 不拆的話每開一次 App 就多留一個死監聽器（而且它還綁著舊的 accIdx/appId）。
function goToApp(accIdx, id) {
  if (appFrameBridge) { window.removeEventListener('message', appFrameBridge); appFrameBridge = null; }
  appBack = page.startsWith('lib:') ? page : 'home';
  page = 'app:' + accIdx + ':' + id;
  renderNav();
  loadAppDetail(accIdx, id);
}

async function appLogin() {
  const accIdx = Number(page.split(':')[1]);
  const id = page.split(':').slice(2).join(':');
  const err = $('apErr');
  const btn = $('apLogin');
  if (btn) btn.disabled = true;
  try {
    await go.PortalLogin(accIdx, $('apPw').value);
    if (btn) btn.disabled = false;
    loadAppDetail(accIdx, id);
  } catch (ex) {
    if (btn) btn.disabled = false;
    if (err) { err.textContent = String(ex); err.style.display = 'block'; }
  }
}

// runAppAction：沒有自帶畫面的 App，那顆「現在執行」。
// 🔴 白名單是**實例**裁決的（K6）——這裡不認得任何動作名稱，只負責把按鈕送出去、
//    把實例回的話原樣顯示。失敗就說失敗，不改寫成「可能成功」。
async function runAppAction(btn) {
  const accIdx = Number(page.split(':')[1]);
  const id = page.split(':').slice(2).join(':');
  const item = btn.closest('.wfitem');
  const out = item && item.querySelector('.out');
  btn.disabled = true;
  if (out) { out.className = 'out'; out.textContent = '執行中…'; }
  try {
    const raw = await go.RunAppAction(accIdx, id, btn.dataset.apprun, '{}');
    if (out) out.textContent = '完成：' + String(raw).slice(0, 600);
  } catch (ex) {
    if (out) { out.className = 'out bad'; out.textContent = '失敗：' + String(ex); }
  }
  btn.disabled = false;
}

function render(s) {
  const first = !state;
  state = s;
  $('ver').textContent = s.version || '';
  renderNav();
  renderPage();
  // 🔴 這是**唯一**一次自動去問實例：第一次拿到 state（＝知道有哪些知識庫）之後，
  //    只問「有東西釘在首頁」的那幾個帳號（要拿到 App 的名字與圖示）。
  //    之後只有使用者按重新整理／切到 App 分頁才會再問一次——**不掛在每秒的 tick 上**。
  if (first) {
    refreshUsage(-1);   // 開啟時問一次雲端當下的用量（不是輪詢，見 livebattery.go）
    (s.accounts || []).forEach((a, i) => { if (pins.some((p) => p.h === a.host)) loadApps(i); });
    if (page.startsWith('lib:')) ensureTabData(Number(page.slice(4)));
  }
}

// 首頁「我的 App」的「＋ 加一個」：挑一個帳號，帶去它的 App 分頁。
function pickAccountForApp() {
  const accs = (state && state.accounts) || [];
  if (accs.length === 1) { libTab[0] = 'apps'; goPage('lib:0'); ensureTabData(0); return; }
  const L = acctLetters(accs);
  openSheet(`
    <h2>選帳號</h2>
    ${accs.map((a, i) => `<button class="pickacc" data-pickacc="${i}"><span class="av">${esc(L[i])}</span>${esc(a.name)}</button>`).join('')}
    <div class="acts"><button id="c1">取消</button></div>`,
    () => {
      $('c1').onclick = closeSheet;
      document.querySelectorAll('[data-pickacc]').forEach((b) => {
        b.onclick = () => { const i = Number(b.dataset.pickacc); closeSheet(); libTab[i] = 'apps'; goPage('lib:' + i); ensureTabData(i); };
      });
    });
}

async function tick() { try { render(await go.GetState()); } catch (e) {} refreshOpenTrees(); }

// 🔴 `inkstone/arcrun-rag#200`：展開著的樹要跟著同步進度走。
//
// 以前樹第一次展開讀一次就一直留在記憶體裡——而 collector 一輪途中每送上一份就會
// 重寫 folder-trees.json。leo 2026-09-13 看著 ISEP 每層 0 / N 等了一整晚，
// 雲端那時已經收到 11 份：**就算檔案更新了，畫面也不會去讀**。
//
// 只重讀「現在展開著」的那幾棵，每 3 秒一次（不是每秒——樹上限 300 個節點，
// GetFolderTree 註解 ③ 講過為什麼不掛在每秒的 GetState 上）。內容沒變就不重畫，
// 使用者正在點開的節點與「為什麼」不會因為重讀而跳掉。讀失敗不吵，下一次再試。
let treeRefreshAt = 0;
let treeRefreshing = false;
async function refreshOpenTrees() {
  const now = Date.now();
  if (treeRefreshing || now - treeRefreshAt < 3000) return;
  treeRefreshAt = now;
  treeRefreshing = true;
  try {
    for (const path of Object.keys(treeState.open)) {
      if (!treeState.open[path] || treeState.data[path] === undefined) continue;
      try {
        const next = (await go.GetFolderTree(path)) || null;
        if (JSON.stringify(next) !== JSON.stringify(treeState.data[path])) {
          treeState.data[path] = next;
          renderFolderTree(path);
        }
      } catch (e) { /* 下一次再試 */ }
    }
  } finally {
    treeRefreshing = false;
  }
}

// ── 動作 ──

async function addFolder(accIdx) {
  const p = await go.PickFolder();
  if (!p) return;
  await go.AddFolder(accIdx, p);
  state = await go.GetState(); renderNav(); renderPage();
}

// 移除資料夾＝兩個後果完全不同的動作，所以給兩顆按鈕，不給一顆猜。
//
// 🔴 arcrun-rag#46（leo 2026-08-16 實撞）：「我去把 Logseq plugin 刪掉以後，
//    **採集的 wiki 沒消失**。」舊文案寫的是「已經上傳的知識卡不會被刪除」——
//    那句話**在技術上是對的**，但它預設使用者要的是「只停止同步」，
//    而他要的是「我不要這份資料了」。⇒ 病不在少一句說明，在**替他決定了**。
//    現在兩個選擇都擺出來、後果各寫一行，由他挑。
// 🔴 arcrun-rag#138（leo 2026-08-24）：「碎型會在每個資料夾安裝隱藏資料夾，人工刪除不容易，
//    所以當它斷連，應該要可以幫它把 Arcrun RAG 建立的資料夾刪掉」
//    ⇒ 多一個**獨立的勾選框**，不是第三顆單選：雲端怎麼處理、硬碟怎麼處理是兩件事，
//      合成一個選項就又是替他決定（#46 修掉的正是那個病）。
//    🔴 預設不勾——刪檔不可逆，預設值往「什麼都不動」倒。
//    🔴 勾了才去問清單，並且把**每一筆路徑攤出來**：#138 的驗收條件白紙黑字寫著
//      「使用者要能在動手前看到將要刪掉哪些東西」，按下去就無聲刪光不算做完。
function confirmRemove(accIdx, path) {
  openSheet(`
    <h2>移除</h2>
    <p class="path">${esc(path)}</p>
    <label class="radio"><input type="radio" name="rmMode" value="takedown" checked/>
      <span><b>連同雲端收回</b></span></label>
    <label class="radio"><input type="radio" name="rmMode" value="unwatch"/>
      <span><b>只停同步</b></span></label>
    <label class="radio"><input type="checkbox" id="rmClean"/>
      <span><b title="清掉 Arcrun 放在這個資料夾裡的檔案">清理殘檔</b></span></label>
    <div id="rmPlan" class="d" style="display:none;margin:8px 0 4px"></div>
    <div class="acts"><button id="c1">取消</button><button class="primary" id="c2">確定</button></div>`,
    () => {
      $('c1').onclick = closeSheet;
      const box = $('rmClean'), out = $('rmPlan');
      box.onchange = async () => {
        if (!box.checked) { out.style.display = 'none'; out.innerHTML = ''; return; }
        out.style.display = ''; out.textContent = '…';
        try {
          out.innerHTML = renderCleanupPlan(await go.PlanFolderCleanup(accIdx, path));
        } catch (e) {
          out.textContent = '看不到清單：' + e;
        }
      };
      $('c2').onclick = async () => {
        const mode = document.querySelector('input[name="rmMode"]:checked');
        const takedown = !mode || mode.value === 'takedown';
        await go.RemoveFolder(accIdx, path, takedown, box.checked); closeSheet();
        state = await go.GetState(); renderNav(); renderPage();
      };
    });
}

// renderCleanupPlan 把「將要刪掉什麼／刻意留下什麼」攤成使用者看得懂的清單。
// 🔴 留下的那一半一樣要顯示：沉默地留下殘渣，跟沉默地刪掉一樣糟——他要的是
//    「這個資料夾乾淨了」，那就得讓他看得到還有什麼沒清、為什麼沒清。
function renderCleanupPlan(plan) {
  const rm = (plan && plan.remove) || [], keep = (plan && plan.keep) || [];
  if (!rm.length && !keep.length) return '∅';
  let h = '';
  if (rm.length) {
    h += `<b>刪 ${rm.length} 項（${plan.files} 個檔）</b><ul style="margin:4px 0 0 16px">`;
    for (const it of rm) h += `<li>${esc(it.rel)}${it.is_dir ? '／' : ''}（${it.files} 個檔）</li>`;
    h += '</ul>';
  }
  if (keep.length) {
    h += `<b style="display:block;margin-top:8px">留 ${keep.length} 項</b><ul style="margin:4px 0 0 16px">`;
    for (const k of keep) h += `<li>${esc(k.rel)} — ${esc(k.reason)}</li>`;
    h += '</ul>';
  }
  return h;
}

function showConnect() {
  openSheet(`
    <h2>連線</h2>
    <div class="field"><div class="lb">知識庫網址</div>
      <input type="text" id="u" placeholder="https://arcrun-cypher-executor.xxxx.workers.dev"/></div>
    <div class="field"><div class="lb">Email</div>
      <input type="text" id="e" placeholder="you@example.com"/></div>
    <div class="field"><div class="lb">密碼</div><input type="password" id="p"/></div>
    <div class="err" id="err" style="display:none"></div>
    <div class="acts"><button id="c1">取消</button><button class="primary" id="c2">連線</button></div>`,
    () => {
      $('c1').onclick = closeSheet;
      $('c2').onclick = async () => {
        try {
          await go.Connect($('u').value.trim(), $('e').value.trim(), $('p').value);
          closeSheet(); state = await go.GetState(); renderNav(); renderPage();
        } catch (ex) { $('err').textContent = String(ex); $('err').style.display = 'block'; }
      };
    });
}

async function checkUpdate() {
  updateInfo = { latest: '查詢中…' }; renderPage();
  try { updateInfo = await go.CheckUpdate(); } catch (ex) { updateInfo = { err: String(ex) }; }
  renderPage();
}
async function downloadUpdate() {
  updateInfo = Object.assign({}, updateInfo, { notes: '下載中…請稍候' }); renderPage();
  try { updateInfo = await go.DownloadUpdate(); } catch (ex) { updateInfo = { err: String(ex) }; }
  renderPage();
}
async function applyUpdate() {
  try { await go.ApplyUpdate(); } catch (ex) { updateInfo = { err: String(ex) }; renderPage(); }
}

// 匯出診斷檔（t213）：後端 ExportDiagnostics 自己彈系統存檔對話框；回傳空字串＝
// 使用者按了取消，不算錯誤、不顯示紅字。
async function exportDiagnostics() {
  const el = $('uDiagStatus');
  if (el) el.textContent = '匯出中…';
  try {
    const path = await go.ExportDiagnostics();
    if (el) el.textContent = path ? `已存到：${path}` : '已取消';
  } catch (ex) {
    if (el) el.textContent = '匯出失敗：' + String(ex);
  }
}

tick();
setInterval(tick, 1000);
