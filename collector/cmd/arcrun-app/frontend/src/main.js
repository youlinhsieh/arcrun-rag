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
  const b = $('themeBtn'); if (b) b.textContent = t === 'dark' ? '☀' : '☾';
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } })());
$('themeBtn').onclick = () =>
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

let state = null;
// page：'apps'（App 啟動器）| 'app:<accIdx>:<id>' | 'home' | 'ai' | 'update' | 'lib:<idx>'
//
// 🔴 arcrun-rag#137：預設落在 App 啟動器，不是首頁——leo 2026-08-24 的原話是
//    「**打開桌面小幫手就看到**跟 Portal 同一套的 App 啟動器」。
//    同步狀態沒有因此消失：它在**全站頁首**（statusBig/statusSub＋「立刻同步」），
//    每一頁都看得到；首頁那些卡片仍在側欄的「首頁」裡，一鍵可達。
//    還沒連任何知識庫時 render() 會把它改回 'home'（那裡才是連線精靈）。
let page = 'apps';
let updateInfo = null;
let obStep = 1;           // 首次啟動精靈目前在第幾步（issue #23，見 onboarding()）

// ── App 啟動器的暫存（arcrun-rag#137）──
//
// 🔴 這是**畫面暫存，不是本機清單**：只活在這個視窗的記憶體裡，關掉就沒了，
//    永遠不寫檔。上游 inkstone/Arcrun#82 已定「安裝態只有一份真相源」＝實例上那一份，
//    桌面端不准另存一份（本票紅線）。存在這裡只是為了不要每次換頁都重打一次網路。
let appsAccIdx = 0;       // 啟動器現在在看哪一個知識庫
let appsCache = {};       // accIdx -> ListApps() 的回傳（undefined＝還沒問，null＝正在問）
let appDetail = null;     // 目前打開的那個 App 的詳情（GetApp() 的回傳）
let appDetailKey = '';    // 'accIdx:id'，避免慢回應蓋掉已經換過去的另一個 App
let appFrameBridge = null; // App 自帶畫面那個 iframe 的 postMessage 監聽器（換頁時要拆掉）

// ── 覆蓋層（只給必須打斷的確認）──
function openSheet(html, wire) { $('sheet').innerHTML = html; $('overlay').classList.add('on'); if (wire) wire(); }
function closeSheet() { $('overlay').classList.remove('on'); }
$('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ── 側邊欄：每個知識庫一項（leo：「每個帳號有獨立的一個頁面」）──
//
// t215（2026-08-08，leo：「在每個知識庫上顯示是否要更新」）：落後的庫名旁加一顆
// 警示點，逛清單時不用點進每個庫就能一眼看出哪個落後（完整說明＋更新按鈕在
// 首頁 cardKbVersions 與各庫頁 kbVersionLine）。
//
// 🔴 頂層 status.md 08-08 深夜記過一個**待 leo confirm、尚未定案**的提案：
// 「單一更新入口（版本白癡化）」——把小幫手自我更新與雲端知識庫更新合併成一顆按鈕。
// 那個提案沒有否定「每庫獨立列出落後狀態」這件事本身（它本來就要「點進去才看細節」），
// 只是問「總覽要不要合併」。這裡先實作 leo 這次明確要的「每庫看得到＋連得到」，
// 之後若那個提案 confirm，是在這層之上疊總覽 pill，不是重做這裡。
function renderNav() {
  const accs = (state && state.accounts) || [];
  // arcrun-rag#137：「App」這一段在最上面，且**只有連了知識庫才出現**——
  // 沒有實例就沒有 App，把一個必定空的入口擺在第一項只會讓人以為壞了。
  // 目前打開的那個 App 以子項的形式掛在「App 界面」下面（同 Portal 的做法：
  // 已安裝的 App 是側欄的一格），這樣使用者知道自己在哪、也回得去。
  const appNav = !accs.length ? '' : `
    <div class="sec">App</div>
    <div class="nav" data-p="apps"><span class="ic">▦</span><span class="nm">App 界面</span></div>
    ${page.startsWith('app:') && appDetail && !appDetail.error ? `
      <div class="nav" data-p="${esc(page)}" style="padding-left:44px">
        <span class="ic">${esc(appDetail.icon || '▢')}</span>
        <span class="nm">${esc(appDetail.name || appDetail.id)}</span>
      </div>` : ''}
    <div class="sec">小幫手</div>`;
  $('nav').innerHTML = `
    ${appNav}
    <div class="nav" data-p="home"><span class="ic">◫</span><span class="nm">首頁</span></div>
    ${accs.length ? `<div class="sec">知識庫</div>` : ''}
    ${accs.map((a, i) => `
      <div class="nav" data-p="lib:${i}">
        <span class="ic">▤</span><span class="nm">${esc(a.name)}</span>
        ${a.cloudVerStale ? `<span class="dot warn" title="有新版可更新"></span>` : ''}
        <span class="cnt">${(a.folders || []).length}</span>
      </div>`).join('')}
    <div class="sec">設定</div>
    <div class="nav" data-p="ai"><span class="ic">✧</span><span class="nm">AI 設定</span></div>
    <div class="nav" data-p="update"><span class="ic">↧</span><span class="nm">版本與更新</span></div>`;
  $('nav').querySelectorAll('.nav').forEach((el) => {
    el.classList.toggle('on', el.dataset.p === page);
    el.onclick = () => {
      const p = el.dataset.p;
      if (p === page) return;
      // 離開 App 頁時把 iframe 的橋拆掉（見 goToApp 同一段理由）。
      if (page.startsWith('app:') && appFrameBridge) {
        window.removeEventListener('message', appFrameBridge); appFrameBridge = null;
      }
      page = p;
      renderNav(); renderPage();
      if (p === 'apps') loadApps(appsAccIdx);
    };
  });
}

// ── 首頁：狀態時間軸（leo：「看守、發現變化、萃取、上傳… 不同 status 在哪裡顯示？」）──
function pageHome(s) {
  if (!s.accounts || !s.accounts.length) return onboarding();
  const st = s.steps || [];
  return `
    <div class="card">
      <h3>現在的狀態</h3>
      <div class="steps">
        ${st.map((x) => `
          <div class="step ${esc(x.state)}">
            <span class="dot"></span>
            <span class="t">${esc(x.title)}</span>
            <span class="m">${esc(x.meta || '')}</span>
          </div>`).join('')}
      </div>
    </div>
    ${cardQuota(s.quota, s.progress)}
    ${cardTrouble(s)}
    ${cardProgress(s.progress)}
    ${cardSkipped(s.skipped)}
    ${cardKbVersions(s)}
    <div class="card">
      <h3>總計</h3>
      <div class="kv" style="margin-top:10px">
        <div><div class="big-num">${s.accounts.length}</div><div class="k">個知識庫</div></div>
        <div><div class="big-num">${s.accounts.reduce((n,a)=>n+(a.folders||[]).length,0)}</div><div class="k">個資料夾在看守</div></div>
      </div>
    </div>`;
}

// t215（2026-08-08，leo：「在每個知識庫上顯示是否要更新，如果要，加開啓 install 頁的
// 連結」）——一個使用者可能連著不只一個知識庫（leo 自己就是），各自雲端版本不同步時，
// 以前完全看不出「哪一個」落後、也沒有地方按。這張卡讓使用者不必逐個庫點進去，
// 首頁一眼看完全部知識庫的版本狀態。
//
// 判準**不在這裡重新發明**：後端 collector.EvalCloudUpdate 與 portal 設定頁那張版本卡
// （console-ui/public/portal/index.html 的 loadVersion()）同一套比法——自己的
// bundle_version 比 install.arcrun.dev/api/latest 的 release，兩邊都是 semver 才逐段
// 整數比較，非 semver（老格式）一律視為落後。前端只負責把後端已經算好的
// cloudVerKnown/cloudVerStale 翻成人話，不做任何版本比較。
function cardKbVersions(s) {
  const accs = s.accounts || [];
  if (!accs.length) return '';
  return `
    <div class="card">
      <h3>知識庫版本</h3>
      <div class="kblist">
        ${accs.map((a) => `
          <div class="kbrow">
            <span class="nm">${esc(a.name)}</span>
            <span class="right">${kbVersionLine(a)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// kbVersionLine：單一知識庫的版本判定文案，首頁卡與各庫頁共用同一份翻譯，
// 不讓兩處各寫各的文字（那樣才真的會出現「兩處講不同的話」）。
//
// 三種情況都要照實講（cloud_version.go 記過的坑：把「查不到」呈現成「一切正常」）：
//   ① Known 且落後 → 紅字＋按鈕，按下去帶 email 開 install 頁（同 portal 版本卡的預填做法）
//   ② Known 且已最新 → 淡字「已是最新版」
//   ③ 不 Known → 照原因分兩句：連不上這個知識庫／查得到目前版本但暫時查不到最新版
function kbVersionLine(a) {
  if (!a.cloudVerKnown) {
    const detail = a.cloudVerMine
      ? `已知版本 ${esc(a.cloudVerMine)}，暫時查不到最新版本（稍後會自動再查）`
      : '目前連不上這個知識庫，查不到版本';
    return `<span class="d">${detail}</span>`;
  }
  if (a.cloudVerStale) {
    return `<span class="warn">有新版可更新（目前 ${esc(a.cloudVerMine)} → 最新 ${esc(a.cloudVerLatest)}）</span>
      <button class="ghost" data-updatekb="${esc(a.email || '')}">前往安裝頁更新</button>`;
  }
  return `<span class="d">已是最新版（${esc(a.cloudVerMine)}）</span>`;
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
function cardTrouble(s) {
  if (!s.engineTrouble) return '';
  return `
    <div class="card">
      <h3>需要回報這個問題？</h3>
      <div class="d">
        詳細的錯誤紀錄已經自動存在你電腦裡，不必開啟任何設定。<br/>
        把 <b>collector.log</b> 和 <b>app.log</b> 傳給我們就能查。
      </div>
      <div class="d" style="margin-top:6px;opacity:.7">${esc(s.logFolder || '')}</div>
      <div class="acts"><button id="hLogs">打開紀錄檔資料夾</button></div>
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
function cardQuota(q, p) {
  if (!q) return '';
  const pending = p && p.pending > 0
    ? `<div class="d" style="margin-top:6px">還有 <b>${p.pending}</b> 份排隊中——會自動接著跑，你不用重丟。</div>` : '';
  return `
    <div class="card">
      <h3>${esc(q.achievement)} 🎉</h3>
      <div class="d" style="margin-top:6px">今天的免費 AI 額度用完了，先休息一下。<b>${esc(q.guarantee)}</b>。</div>
      ${pending}
      <div class="d" style="margin-top:6px">急著要的話：${esc(q.exit_options)}。</div>
      <div class="acts"><button class="ghost" data-openurl="https://rag.arcrun.dev/docs/">看看怎麼做</button></div>
    </div>`;
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
        <div class="d" style="margin-top:8px">這些會自動重試，你不用重丟；細節與怎麼處理，看說明文件。</div>
        <div class="acts"><button class="ghost" data-openurl="https://rag.arcrun.dev/docs/">開啟使用說明</button></div>
      </details>` : ''}
    </div>`;
}

function cardSkipped(k) {
  if (!k) return '';
  return `
    <div class="card">
      <h3>${esc(k.title)}</h3>
      <div class="d" style="margin-top:6px">${esc(k.note)}</div>
      ${(k.files || []).length ? `
        <ul class="skiplist">
          ${k.files.map((f) => `<li>${esc(f)}</li>`).join('')}
          ${k.more ? `<li class="more">…等 ${k.more} 個</li>` : ''}
        </ul>` : ''}
      ${k.other ? `<div class="d" style="margin-top:8px">${esc(k.other)}</div>` : ''}
    </div>`;
}

// ── 各庫頁：動作全部作用在這個庫（不會加錯帳號）──
function pageLib(s, idx) {
  const a = s.accounts[idx];
  if (!a) return `<div class="empty"><div class="t">找不到這個知識庫</div></div>`;
  const portal = 'https://' + a.host.replace('arcrun-cypher-executor.', 'arcrun-rag-ui.') + '/portal/';
  return `
    <div class="libhead">
      <div class="g">
        <div class="nm">${esc(a.name)}</div>
        <div class="host">${esc(a.host)}</div>
      </div>
      <button data-portal="${esc(portal)}">開啟知識庫網頁</button>
      <button class="primary" data-addto="${idx}">加入資料夾</button>
    </div>
    <div class="kbver">${kbVersionLine(a)}</div>
    ${(a.folders || []).map((f) => f.retiring ? `
      <div class="folder">
        <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="tag retiring">${f.retireError
          ? '收回時出錯，會自動再試'
          : `正在從雲端收回…${f.retireRemaining ? `還有 ${f.retireRemaining} 份` : ''}`}</span>
      </div>
      ${f.retireError ? `<div class="d folder-note">${esc(f.retireError)}</div>` : ''}` : `
      <div class="folder">
        <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="tag">自動同步中</span>
        <button class="ghost" data-rm="${esc(f.path)}" data-acc="${f.accIdx}">移除</button>
      </div>`).join('')
      || `<div class="empty"><div class="t">這個知識庫還沒有資料夾</div>
           <div class="d">按右上的「加入資料夾」，選一個要自動整理的資料夾。</div></div>`}`;
}

function pageAI(s) {
  const gem = s.engine === 'gemma';
  return `
    <div class="card">
      <h3>用哪個 AI 幫你整理文件？</h3>
      <label class="radio"><input type="radio" name="ai" value="cloud" ${gem ? '' : 'checked'}/>
        <span><b>雲端 AI</b>（推薦・不必申請任何金鑰）<br/>
        <span class="d">用你自己 Cloudflare 帳號內建的 AI，不需要任何金鑰、不必去別的網站申請。</span></span></label>
      <label class="radio"><input type="radio" name="ai" value="gemini" ${gem ? 'checked' : ''}/>
        <span><b>Google Gemini</b>（需要自己申請金鑰）<br/>
        <span class="d">進階選項。要自己去 aistudio.google.com 申請一把 API Key。</span></span></label>
      <div class="field">
        <div class="lb">Gemini 金鑰${s.geminiKey ? '（目前已設定，清空並儲存即可刪除）' : ''}</div>
        <input type="text" id="k" placeholder="貼上你的 Gemini API Key"/>
      </div>
      <div class="err" id="aiErr" style="display:none"></div>
      <div class="acts"><button class="primary" id="aiSave">儲存</button></div>
    </div>`;
}

function pageUpdate(s) {
  const u = updateInfo;
  const latest = u ? (u.latest || '查詢中…') : '按「檢查更新」查詢';
  let action = `<button class="primary" id="uCheck">檢查更新</button>`;
  let note = '';
  if (u && u.staged) {
    action = `<button class="primary" id="uApply">重新啟動以完成更新</button>`;
    note = `<div class="d">新版 ${esc(u.latest)} 已下載完成，重新啟動就會套用。</div>`;
  } else if (u && u.available) {
    action = `<button class="primary" id="uDownload">下載並安裝 ${esc(u.latest)}</button>`;
    note = u.notes ? `<div class="d">${esc(u.notes)}</div>` : '';
  } else if (u && u.err) {
    note = `<div class="err">${esc(u.err)}</div>`;
  } else if (u) {
    note = `<div class="d">你已經是最新版本。</div>`;
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
    <div class="card">
      <h3>需要協助？</h3>
      <div class="d">安裝、更新、把知識庫接到你的 AI，說明文件都寫在這裡。</div>
      <div class="acts"><button id="uDocs">開啟使用說明</button></div>
    </div>
    ${cardDiagnostics()}`;
}

// 疑難排解／匯出診斷檔（t213，2026-08-08）：leo 直接指令「一顆按鈕下載一個檔案，
// 把檔案發給我」——這裡是那顆按鈕真正住的地方（不是雲端 portal 網頁，那邊碰不到
// 這台電腦上的資料）。按下去在**這台電腦**上合併本機統計＋雲端統計成一份 JSON，
// 彈系統存檔對話框讓你選位置存。只有數字/狀態，不含你的任何文件內容。
function cardDiagnostics() {
  return `
    <div class="card">
      <h3>疑難排解</h3>
      <div class="d">搜尋或同步有問題時，可以匯出一份診斷檔給我們，幫你更快找到問題（只有統計數字，不含你的任何文件內容）。</div>
      <div class="acts"><button id="uDiag">匯出診斷檔</button></div>
      <div class="d" id="uDiagStatus" style="margin-top:8px"></div>
    </div>`;
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
        <div class="obcap">第 2 步・共 2 步・連上你的知識庫</div>
        <div class="t">你已經有知識庫了嗎？</div>
        <div class="d">知識庫是存放你「知識卡」的地方——就像信箱之於信件，之後打開它的網址就能搜尋、AI 也能直接查。</div>
        <div class="obchoice">
          <div class="obcard">
            <div class="obh">已經有了</div>
            <div class="d">手上有網址、帳號、密碼（邀請你的人會給你）。</div>
            <button class="primary" id="obConnect">連上知識庫</button>
          </div>
          <div class="obcard">
            <div class="obh">還沒有</div>
            <div class="d">免費申請一個，幾分鐘完成。<br/>填完會拿到網址、帳號、密碼——<b>回到這裡</b>，按左邊「連上知識庫」貼上去就完成。</div>
            <button id="obInstall">免費申請一個</button>
          </div>
        </div>
        <button class="ghost" id="obBack" style="margin-top:16px">‹ 上一步</button>
      </div>`;
  }

  return `
    <div class="empty ob">
      ${obDots}
      <div class="obcap">第 1 步・共 2 步・認識 Arcrun</div>
      <div class="t">歡迎使用 Arcrun</div>
      <div class="d obintro">
        <p>① 你指定一個資料夾，Arcrun 會在背景幫你看著它。</p>
        <p>② 資料夾裡新增或修改的檔案，會被自動整理成一張張「知識卡」。</p>
        <p>③ 之後不管在哪台電腦、哪個裝置，打開你的知識庫網站，或讓你的 AI 助理直接問，都找得到。</p>
      </div>
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
  if (page === 'apps') renderPage();
  let res;
  try {
    res = await go.ListApps(accIdx);
  } catch (ex) {
    res = { accIdx, apps: [], error: String(ex) };
  }
  appsCache[accIdx] = res;
  if (page === 'apps') renderPage();
}

function pageApps(s) {
  const accs = s.accounts || [];
  if (!accs.length) {
    // 「沒連任何實例時要說人話」（驗收條件 1）——不是空白，也不是壞掉的樣子。
    return `<div class="empty">
      <div class="t">還沒有連上知識庫</div>
      <div class="d">App 住在你的知識庫上，連上之後這裡就會列出它裝了哪些 App。</div>
      <button class="primary" id="apConnect">連上知識庫</button>
    </div>`;
  }
  if (appsAccIdx >= accs.length) appsAccIdx = 0;
  const acc = accs[appsAccIdx];
  const r = appsCache[appsAccIdx];

  // 知識庫切換器：只有一個庫時不畫（一顆永遠只能按自己的按鈕是純噪音）。
  const switcher = accs.length > 1 ? `
    <div class="appswitch">
      ${accs.map((a, i) => `<span class="chip ${i === appsAccIdx ? 'on' : ''}" data-appacc="${i}">${esc(a.name)}</span>`).join('')}
    </div>` : '';

  let sub = '查詢中…';
  let body = `<div class="card"><div class="d">正在問「${esc(acc.name)}」裝了哪些 App…</div></div>`;

  if (r) {
    if (r.error) {
      // 🔴 「問不到」與「一個都沒裝」是兩件事，畫面上必須分得出來
      //    （使用者該做的事完全相反：一個是修連線，一個是去裝 App）。
      sub = '這次沒問到';
      body = `<div class="card">
        <h3>暫時看不到這個知識庫的 App</h3>
        <div class="d">${esc(r.error)}</div>
        <div class="acts"><button id="apRetry">再試一次</button></div>
      </div>`;
    } else {
      const apps = r.apps || [];
      sub = `${apps.length} 個 App 已安裝`;
      body = `<div class="appgrid">
        ${apps.map((a) => `
          <div class="appcell">
            <div class="apptile" data-appopen="${esc(a.id)}" title="${esc(a.name)}${a.version ? ' · v' + esc(a.version) : ''}">${esc(a.icon || '▢')}</div>
            <div class="nm" title="${esc(a.name)}">${esc(a.name)}</div>
          </div>`).join('')}
        <div class="appcell">
          <div class="apptile add" id="apAdd" title="怎麼加裝 App">＋</div>
          <div class="nm dim">加裝 App</div>
        </div>
      </div>
      ${apps.length ? '' : `<div class="card" style="margin-top:26px">
        <h3>這個知識庫還沒有 App</h3>
        <div class="d">App 是裝在知識庫上的：跟你的 AI 說一句「幫我裝一個 X」，
        或用 <b>acr</b> 推一份 App 宣告上去。裝好之後回到這裡按「重新整理」就會出現。</div>
      </div>`}`;
    }
  }

  return `
    <div class="apphead">
      <div class="g">
        <div class="t">App 界面</div>
        <div class="s">${esc(acc.name)} · ${esc(sub)}</div>
      </div>
      <button id="apRefresh">重新整理</button>
    </div>
    ${switcher}
    ${body}`;
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
      <span class="ico">${esc(ico || '▢')}</span>
      <span class="nm">${esc(nm || id)}</span>
      ${ver ? `<span class="vr">v${esc(ver)}</span>` : ''}
      <span class="sp"></span>
      <button data-appback="1">‹ 回 App 界面</button>
    </div>`;

  if (!d) return `<div class="appview">${head('', id, '')}<div class="card"><div class="d">載入中…</div></div></div>`;

  if (d.needsLogin) {
    // session 過期／這台機器還沒換過 session。不是錯誤，是「還差一步」。
    return `<div class="appview">${head(d.icon, d.name, d.version)}
      <div class="card">
        <h3>請先登入這個知識庫</h3>
        <div class="d">要打開 App 的畫面、或執行它的動作，需要你在這個知識庫的帳號登入一次
        （之後這台電腦會記住一段時間，同步不受影響）。</div>
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
        <h3>打不開這個 App</h3>
        <div class="d">${esc(d.error)}</div>
        <div class="acts"><button id="apReload">再試一次</button></div>
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
      <div class="card"><h3>這個 App 沒有可以按的東西</h3>
      <div class="d">它既沒有自己的畫面，也沒有登記任何工作流。</div></div></div>`;
  }
  return `<div class="appview">${head(d.icon, d.name, d.version)}
    ${wfs.map((w) => `
      <div class="wfitem" data-wf="${esc(w.name)}">
        <div class="top">
          <span class="nm">${esc(w.name)}</span>
          <button data-apprun="${esc(w.name)}">現在執行</button>
        </div>
        ${w.description ? `<div class="d">${esc(w.description)}</div>` : ''}
        <div class="out"></div>
      </div>`).join('')}`;
}

// mountAppUI 把 App 自帶的 HTML 放進 **sandbox iframe**。
//
// 🔴 為什麼一定要 iframe（這是桌面端與 Portal 的關鍵差異，不是潔癖）：
//    Portal 是網頁，把 App 的 HTML 直接 innerHTML 進去，那段 script 最多拿到
//    同一頁的 fetch 與 session token。**桌面這半不一樣**——這裡的 window 上掛著
//    `window.go.main.App`：`Connect`／`SetAI`／`RemoveFolder(…, takedown=true, cleanupLocal=true)`
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

function renderPage() {
  if (!state) return;
  let html;
  if (page === 'apps') html = pageApps(state);
  else if (page.startsWith('app:')) {
    const p = page.split(':');
    html = pageApp(Number(p[1]), p.slice(2).join(':'));
  }
  else if (page.startsWith('lib:')) html = pageLib(state, Number(page.slice(4)));
  else if (page === 'ai') html = pageAI(state);
  else if (page === 'update') html = pageUpdate(state);
  else html = pageHome(state);
  // 每個庫頁底下都給「新增知識庫帳號」入口
  if (page === 'home' && state.accounts && state.accounts.length) {
    html += `<div class="acts"><button id="hAcct">新增知識庫帳號</button></div>`;
  }
  $('page').innerHTML = html;
  wire();
}

function wire() {
  const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
  on('uDocs', () => go.OpenURL('https://rag.arcrun.dev/docs/'));
  on('hLogs', () => go.OpenLogFolder());
  on('hLogs', () => go.OpenLogFolder());
  on('hAcct', showConnect); on('obConnect', showConnect);
  on('obInstall', () => go.OpenURL('https://install.arcrun.dev/'));
  on('obNext', () => { obStep = 2; renderPage(); });
  on('obBack', () => { obStep = 1; renderPage(); });
  on('aiSave', saveAI);
  on('uCheck', checkUpdate); on('uDownload', downloadUpdate); on('uApply', applyUpdate);
  on('uDiag', exportDiagnostics);
  document.querySelectorAll('[data-portal]').forEach((b) => { b.onclick = () => go.OpenURL(b.dataset.portal); });
  document.querySelectorAll('[data-openurl]').forEach((b) => { b.onclick = () => go.OpenURL(b.dataset.openurl); });
  document.querySelectorAll('[data-updatekb]').forEach((b) => {
    b.onclick = () => go.OpenURL(installURLFor(b.dataset.updatekb));
  });
  document.querySelectorAll('[data-addto]').forEach((b) => { b.onclick = () => addFolder(Number(b.dataset.addto)); });
  document.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => confirmRemove(Number(b.dataset.acc), b.dataset.rm);
  });

  // ── App 啟動器（arcrun-rag#137）──
  on('apConnect', showConnect);
  on('apRefresh', () => loadApps(appsAccIdx, true));
  on('apRetry', () => loadApps(appsAccIdx, true));
  on('apAdd', showHowToInstallApp);
  on('apReload', () => { const p = page.split(':'); loadAppDetail(Number(p[1]), p.slice(2).join(':')); });
  on('apLogin', appLogin);
  document.querySelectorAll('[data-appacc]').forEach((b) => {
    b.onclick = () => { appsAccIdx = Number(b.dataset.appacc); renderPage(); loadApps(appsAccIdx); };
  });
  document.querySelectorAll('[data-appopen]').forEach((b) => {
    b.onclick = () => goToApp(appsAccIdx, b.dataset.appopen);
  });
  document.querySelectorAll('[data-appback]').forEach((b) => {
    b.onclick = () => { page = 'apps'; appDetail = null; appDetailKey = ''; renderNav(); renderPage(); };
  });
  document.querySelectorAll('[data-apprun]').forEach((b) => { b.onclick = () => runAppAction(b); });

  // App 自帶畫面：DOM 換好之後才掛 iframe（srcdoc 要等元素真的在文件裡）
  if (page.startsWith('app:') && appDetail && appDetail.hasUi && appDetail.uiHtml) {
    mountAppUI(Number(page.split(':')[1]), appDetail);
  }
}

// goToApp 換到某個 App 的頁。換頁前先把上一個 App 的 postMessage 監聽器拆掉——
// 不拆的話每開一次 App 就多留一個死監聽器（而且它還綁著舊的 accIdx/appId）。
function goToApp(accIdx, id) {
  if (appFrameBridge) { window.removeEventListener('message', appFrameBridge); appFrameBridge = null; }
  page = 'app:' + accIdx + ':' + id;
  renderNav();
  loadAppDetail(accIdx, id);
}

// 「加裝 App」：桌面端**不假裝自己能安裝**——安裝是實例上的動作
// （跟 AI 說一句話，或 acr 推一份宣告）。這裡只把「東西從哪來」講清楚，
// 順便給一個開知識庫網頁的出口。
function showHowToInstallApp() {
  const acc = (state.accounts || [])[appsAccIdx];
  const portal = acc ? 'https://' + acc.host.replace('arcrun-cypher-executor.', 'arcrun-rag-ui.') + '/portal/' : '';
  openSheet(`
    <h2>怎麼加裝 App？</h2>
    <p>App 是裝在<b>知識庫</b>上的，不是裝在這台電腦上——所以你在任何一台電腦、
    或在知識庫網頁上，看到的都是同一批 App。</p>
    <p>兩種裝法：跟你的 AI 說「幫我裝一個 ⋯⋯」，或用 <b>acr</b> 把一份 App 宣告推上去。
    裝好之後回到這裡按「重新整理」就會出現。</p>
    <div class="acts">
      <button id="c1">知道了</button>
      ${portal ? `<button class="primary" id="c2">開啟知識庫網頁</button>` : ''}
    </div>`,
    () => {
      $('c1').onclick = closeSheet;
      if ($('c2')) $('c2').onclick = () => { go.OpenURL(portal); closeSheet(); };
    });
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
  const navChanged = state && JSON.stringify((state.accounts||[]).map(a=>[a.name,(a.folders||[]).length]))
                          !== JSON.stringify((s.accounts||[]).map(a=>[a.name,(a.folders||[]).length]));
  // arcrun-rag#137：還沒連上任何知識庫時，第一眼要落在連線精靈（首頁），
  // 不是一個註定空的 App 啟動器。連上之後（accounts 從 0 變成 1）也不要硬把
  // 使用者拉走——他當下正在看剛連好的東西。
  if (first && page === 'apps' && !(s.accounts || []).length) page = 'home';
  state = s;
  $('ver').textContent = s.version || '';
  $('statusBig').textContent = s.statusBig;
  $('statusBig').classList.toggle('syncing', !!s.syncing);
  $('statusSub').textContent = s.statusSub;
  if (first || navChanged) { renderNav(); renderPage(); }
  else if (page === 'home') renderPage();   // 首頁的狀態時間軸要跟著跳
  // 🔴 這是**唯一**一次自動去問實例：第一次拿到 state（＝知道有哪些知識庫）之後。
  //    之後只有使用者按重新整理／切知識庫才會再問一次——**不掛在每秒的 tick 上**。
  if (first && page === 'apps' && (s.accounts || []).length) loadApps(appsAccIdx);
}

async function tick() { try { render(await go.GetState()); } catch (e) {} }

// ── 動作 ──
$('btnSync').onclick = async () => { await go.SyncNow(); tick(); };

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
    <h2>移除這個資料夾？</h2>
    <p>「${esc(path)}」要怎麼處理？<b>你自己的檔案不會被動到</b>——下面兩個選擇差在雲端，最後那個勾選框差在你的硬碟。</p>
    <label class="radio"><input type="radio" name="rmMode" value="takedown" checked/>
      <span><b>連同雲端的知識一起收回</b><br/>
      <span class="d">這個資料夾整理出來的知識會從知識庫刪除，之後搜尋找不到、AI 也不會再拿它回答。<b>刪掉就要不回來</b>。</span></span></label>
    <label class="radio"><input type="radio" name="rmMode" value="unwatch"/>
      <span><b>只停止同步，雲端的知識保留</b><br/>
      <span class="d">以後這個資料夾有變動不會再上傳，但之前整理好的知識留在知識庫裡，搜尋和 AI 照樣找得到。</span></span></label>
    <label class="radio"><input type="checkbox" id="rmClean"/>
      <span><b>順便把 Arcrun RAG 放在這個資料夾裡的檔案清掉</b><br/>
      <span class="d">我們會在每一層資料夾放一個隱藏的整理稿目錄（<code>.wiki</code>／<code>.arcrun-rag</code>），
      散在各層、你自己很難刪乾淨。勾起來會先列出<b>確切要刪哪些</b>給你看過再動手；認不出是我們建的一律留著。</span></span></label>
    <div id="rmPlan" class="d" style="display:none;margin:8px 0 4px"></div>
    <div class="acts"><button id="c1">取消</button><button class="primary" id="c2">確定</button></div>`,
    () => {
      $('c1').onclick = closeSheet;
      const box = $('rmClean'), out = $('rmPlan');
      box.onchange = async () => {
        if (!box.checked) { out.style.display = 'none'; out.innerHTML = ''; return; }
        out.style.display = ''; out.textContent = '正在看這個資料夾裡有哪些是我們建的…';
        try {
          out.innerHTML = renderCleanupPlan(await go.PlanFolderCleanup(accIdx, path));
        } catch (e) {
          out.textContent = '看不到清單（' + e + '）——沒把握就先別勾這一項。';
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
  if (!rm.length && !keep.length) return '這個資料夾裡沒有找到任何 Arcrun RAG 建立的檔案，不需要清理。';
  let h = '';
  if (rm.length) {
    h += `<b>會刪掉這 ${rm.length} 項（共 ${plan.files} 個檔）：</b><ul style="margin:4px 0 0 16px">`;
    for (const it of rm) h += `<li>${esc(it.rel)}${it.is_dir ? '／' : ''}（${it.files} 個檔）</li>`;
    h += '</ul>';
  }
  if (keep.length) {
    h += `<b style="display:block;margin-top:8px">這 ${keep.length} 項我不會動：</b><ul style="margin:4px 0 0 16px">`;
    for (const k of keep) h += `<li>${esc(k.rel)} — ${esc(k.reason)}</li>`;
    h += '</ul>';
  }
  return h;
}

function showConnect() {
  openSheet(`
    <h2>連上你的知識庫</h2>
    <p>貼上你的知識庫網址，再輸入你在網站上設定的帳號密碼。</p>
    <div class="field"><div class="lb">知識庫網址</div>
      <input type="text" id="u" placeholder="https://arcrun-cypher-executor.xxxx.workers.dev"/></div>
    <div class="field"><div class="lb">帳號（Email）</div>
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

async function saveAI() {
  const useGemini = document.querySelector('input[name=ai]:checked').value === 'gemini';
  try {
    await go.SetAI(useGemini, $('k').value.trim());
    state = await go.GetState(); renderPage();
  } catch (ex) { $('aiErr').textContent = String(ex); $('aiErr').style.display = 'block'; }
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
    if (el) el.textContent = path ? `已存到：${path}` : '已取消。';
  } catch (ex) {
    if (el) el.textContent = '匯出失敗：' + String(ex);
  }
}

tick();
setInterval(tick, 1000);
