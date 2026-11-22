/**
 * inkstone/arcrun-rag#379（母票 inkstone/InkStoneCo#334）：安裝站「每個 App 一個入口網址」的純函式。
 *
 * 入口網址：`<安裝站>/<app id>`（`/app/<app id>` 是別名）。
 * 🔴 App 清單**只**來自安裝站自己的市集目錄（`/apps/index.json`，見 worker.js 的 appsHandle）——
 *    這裡沒有任何一行 App 名單；目錄沒有的 id 就是「市集沒有這個 App」。
 *
 * 這份檔案刻意不碰 KV、不碰 worker 的全域狀態：目錄怎麼讀（R2／釘子）、實例怎麼認證，
 * 都由 worker.js 以參數傳進來，所以測試可以直接餵假的。
 */

import { RECOVERY, buildRecovery, renderRecoveryCard } from './recovery.mjs';

export const APP_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** 單一請求內最多接力幾輪（Workers 每請求 subrequest 有上限；剩下的交回前端再打）。 */
export const IMPORT_ROUNDS_PER_REQUEST = 4;

/** 把目錄檔收成可顯示的列。壞的一行略過（不整份丟掉）；格式不對回 null。 */
export function parseIndex(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return null; }
  if (!j || typeof j !== 'object' || j.schema !== 1 || !Array.isArray(j.apps)) return null;
  const apps = [];
  const seen = new Set();
  for (const a of j.apps) {
    if (!a || typeof a !== 'object') continue;
    if (!APP_ID_RE.test(String(a.id)) || seen.has(a.id)) continue;
    if (typeof a.name !== 'string' || !a.name) continue;
    if (!SEMVER.test(String(a.version))) continue;
    if (!a.package || typeof a.package.url !== 'string' || !/^packages\/[a-z][a-z0-9_-]{0,63}-\d+\.\d+\.\d+\.json$/.test(a.package.url)) continue;
    seen.add(a.id);
    apps.push({
      id: a.id,
      name: a.name,
      icon: typeof a.icon === 'string' && a.icon ? a.icon : '📦',
      summary: typeof a.summary === 'string' ? a.summary : '',
      version: a.version,
      author: typeof a.author === 'string' ? a.author : '',
      retired: a.retired === true,
      engine_min: typeof a.engine_min === 'string' ? a.engine_min : undefined,
      package: { url: a.package.url, sha256: typeof a.package.sha256 === 'string' ? a.package.sha256.toLowerCase() : undefined },
    });
  }
  return { apps };
}

/** 上架中的 App（已下架的不給入口，也不列出）。 */
export function listedApps(index) {
  return index.apps.filter((a) => !a.retired);
}

export function findApp(index, id) {
  if (!APP_ID_RE.test(String(id))) return null;
  return listedApps(index).find((a) => a.id === id) || null;
}

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 取 App 包並驗證（雜湊、格式、id／版本與目錄一致）。
 * `loadFile(相對路徑)` 由 worker 給：回 Response（讀的就是 `/apps/packages/…`，同一份目錄）。
 * 回 `{ ok:true, pkg }` 或 `{ ok:false, message }`（message 是給人看的話）。
 */
export async function fetchPackage(row, loadFile) {
  let res;
  try { res = await loadFile(row.package.url); } catch (_) { res = null; }
  if (!res || !res.ok) return { ok: false, message: `「${row.name}」的安裝包暫時取不到，稍後再試一次。` };
  const buf = await res.arrayBuffer();
  if (row.package.sha256 && (await sha256Hex(buf)) !== row.package.sha256) {
    return { ok: false, message: `「${row.name}」的安裝包跟目錄對不上，為了安全沒有安裝。請回報給我們。` };
  }
  let pkg;
  try { pkg = JSON.parse(new TextDecoder().decode(buf)); } catch (_) { return { ok: false, message: `「${row.name}」的安裝包壞了，請回報給我們。` }; }
  const d = pkg && pkg.declaration;
  if (!pkg || pkg.format !== 'arcrun-app-package' || !d || d.id !== row.id || d.version !== row.version) {
    return { ok: false, message: `「${row.name}」的安裝包跟目錄說的不是同一版，沒有安裝。請回報給我們。` };
  }
  return { ok: true, pkg };
}

/**
 * 把 App 包交給那台實例的匯入入口（`POST <實例>/apps/import`，與 Portal 的市集安裝走同一支 installApp）。
 * 大 App 一次裝不完時實例回 in_progress＋接續點，這裡最多接 IMPORT_ROUNDS_PER_REQUEST 輪，
 * 還沒好就把接續點交回去，由前端下一個請求接著做。
 *
 * 回傳 state：
 *   done        裝好了（changed=false＝本來就是這一版）
 *   in_progress 還沒好，帶 resume_from／resume_hash 再呼叫一次
 *   retry       實例暫時連不上（剛裝好、網址還在生效），稍等再呼叫
 *   engine_old  這台的平台版本比這個 App 要求的舊
 *   error       其他，message 是給人看的話
 */
export async function importIntoInstance({ apiUrl, authHeaders, pkg, name, from = 0, hash, fetchImpl = fetch, rounds = IMPORT_ROUNDS_PER_REQUEST }) {
  let resumeFrom = Number(from) || 0;
  let resumeHash = hash || undefined;
  const base = String(apiUrl).replace(/\/+$/, '');
  for (let i = 0; i < rounds; i++) {
    const q = new URLSearchParams();
    if (resumeFrom) q.set('from', String(resumeFrom));
    if (resumeHash) q.set('h', String(resumeHash));
    let res;
    try {
      res = await fetchImpl(`${base}/apps/import${q.toString() ? '?' + q : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(pkg),
        signal: AbortSignal.timeout(45000),
      });
    } catch (_) {
      return { state: 'retry', message: '你的 Arcrun 剛裝好，網址還在生效中，稍等一下會自動再試。', resume_from: resumeFrom, resume_hash: resumeHash };
    }
    const body = await res.json().catch(() => null);
    // 404：舊版實例沒有匯入入口——對使用者來說是「平台太舊」，不是 App 壞了
    if (res.status === 404) return { state: 'engine_old', message: '你的 Arcrun 版本比較舊，還裝不了這個 App。到 Arcrun 設定頁按「立即更新」換上新版，再回來按一次安裝。' };
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { state: 'retry', message: '你的 Arcrun 暫時沒回應，稍等一下會自動再試。', resume_from: resumeFrom, resume_hash: resumeHash };
    }
    if (res.status === 409 && body && body.code === 'engine_too_old') {
      return { state: 'engine_old', needs: body.needs, have: body.have, message: `你的 Arcrun 版本比較舊（這個 App 要 ${body.needs || '更新'} 以上），先到 Arcrun 設定頁按「立即更新」，再回來按一次安裝。` };
    }
    if (res.status === 409 && body && body.code === 'older_than_installed') {
      return { state: 'done', changed: false, message: `你已經裝了比這個更新的「${name}」，沒有動它。` };
    }
    if (res.status === 401 || res.status === 403) {
      return { state: 'error', message: '你的 Arcrun 沒有接受這次安裝，請回報給我們。' };
    }
    if (!res.ok || !body) {
      return { state: 'error', message: (body && (body.hint || body.error)) ? String(body.hint || body.error).slice(0, 200) : '這次安裝沒有完成，稍後再試一次；一直失敗請回報給我們。' };
    }
    if (body.in_progress) {
      resumeFrom = Number(body.resume_from) || 0;
      resumeHash = body.resume_hash || undefined;
      continue;
    }
    if (body.installed) {
      return {
        state: 'done',
        changed: body.changed !== false,
        updated: !!body.updated,
        missing_credentials: Array.isArray(body.missing_credentials) ? body.missing_credentials : [],
        message: body.changed === false ? `「${name}」本來就是最新版，已經在你的 Arcrun 裡了。` : `「${name}」裝好了，現在到你的 Arcrun 就看得到它。`,
      };
    }
    return { state: 'error', message: '這次安裝沒有完成，稍後再試一次；一直失敗請回報給我們。' };
  }
  return { state: 'in_progress', resume_from: resumeFrom, resume_hash: resumeHash };
}

// ---------------------------------------------------------------------------
// 頁面主體（外框 pageShell 由 worker.js 套）。esc 由呼叫端傳入，避免兩份實作漂移。
// ---------------------------------------------------------------------------

export function appEntryBody(row, { esc, siteUrl, errorKey }) {
  // #383：錯誤提示統一用 recovery.mjs 的目錄（發生什麼／你的東西現在怎樣／按鈕），按鈕回這頁的表單
  const key = errorKey === 'session' ? 'state' : errorKey;
  const notice = key && RECOVERY[key] ? renderRecoveryCard(buildRecovery(key, { primaryHref: '#email' })) : '';
  return `
${notice}
<h2>${esc(row.icon)} ${esc(row.name)}</h2>
<p class="lead">${esc(row.summary)}</p>
<p class="hint" style="margin-top:-18px;margin-bottom:24px">版本 ${esc(row.version)}${row.author ? `｜${esc(row.author)}` : ''}</p>

<div class="card">
  <h3>按下去會發生什麼</h3>
  <ul class="plain">
    <li><b>還沒有 Arcrun</b>——先幫你裝好 Arcrun，再裝「${esc(row.name)}」，裝完直接看得到</li>
    <li><b>已經有 Arcrun</b>——只裝「${esc(row.name)}」，不重裝、不用再授權 Cloudflare</li>
  </ul>
</div>

<form class="card" method="GET" action="/${esc(row.id)}/go">
  <label for="email">你登記用的 Email</label>
  <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" spellcheck="false" required>
  <div style="height:14px"></div>
  <label for="code">辨識碼</label>
  <input id="code" name="code" type="text" placeholder="例如 BLKYLR9M" autocomplete="off" spellcheck="false" required>
  <p class="hint">填你登記那封信裡的 Email 和辨識碼——這是確認是你本人，不是要你的密碼。找不到？<a href="${esc(siteUrl)}" target="_blank" rel="noopener">重新申請一組</a>，用同一個 Email 就會再寄給你。</p>
  <div style="height:14px"></div>
  <p class="hint" style="margin:0">授權：Sustainable Use License。自用免費、可做內部業務；不可轉售或包成服務賣給別人。<a href="${esc(siteUrl)}/license" target="_blank" rel="noopener">看全文</a></p>
  <label for="agree" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input id="agree" name="agree" type="checkbox" value="1" required style="width:auto;margin:0">我已閱讀並同意授權條款</label>
  <div style="height:20px"></div>
  <button class="btn" type="submit">安裝「${esc(row.name)}」</button>
  <p class="hint" style="text-align:center;margin-top:14px">第一次使用會跳到 Cloudflare 的官方頁面請你確認授權一次，確認完會自動跳回來。</p>
</form>`;
}

export function appNotFoundBody(id, rows, { esc }) {
  const list = rows.length
    ? `<div class="card"><h3>目前有這些 App</h3><ul class="plain">${rows.map((r) => `<li><a href="/${esc(r.id)}"><b>${esc(r.icon)} ${esc(r.name)}</b></a>　<span class="hint">${esc(r.summary).slice(0, 60)}</span></li>`).join('')}</ul></div>`
    : '';
  return `<h2>市集裡沒有這個 App</h2>
<p class="lead">找不到「${esc(id)}」。連結可能打錯了，或它已經下架。</p>
${list}
<a class="btn secondary" href="/">回到安裝首頁</a>`;
}

export function appIndexBody(rows, { esc }) {
  return `<h2>選一個 App 來裝</h2>
<p class="lead">每個 App 都有自己的安裝網址，沒有 Arcrun 的話會一起幫你裝好。</p>
<div class="card"><ul class="plain">${rows.map((r) => `<li><a href="/${esc(r.id)}"><b>${esc(r.icon)} ${esc(r.name)}</b></a>　<span class="hint">${esc(r.summary).slice(0, 60)}</span></li>`).join('')}</ul></div>`;
}

export function appUnavailableBody() {
  return `<h2>App 目錄暫時讀不到</h2>
<p class="lead">這不是你的問題，稍等一下再重新點一次這個連結就好。</p>
<a class="btn secondary" href="/">回到安裝首頁</a>`;
}

/** 安裝進度區塊（已有 Arcrun：直接開始；新裝：等主程式裝完再開始）。 */
export function appProgressBody(row, { esc }) {
  return `<h2>${esc(row.icon)} 正在裝「${esc(row.name)}」</h2>
<p class="lead" id="app-sub">請稍候，不用做任何事。</p>
<div id="app-install" class="card"><p style="margin:0" id="app-msg">準備中…</p></div>
<div id="app-actions"></div>`;
}

/** 前端接力腳本：反覆打 /api/app/install 直到 done／error。cfg＝{ wait, name }。 */
export function appInstallScript() {
  return `
(function(){
  var cfg = window.ARCRUN_APP || {};
  var msg = document.getElementById('app-msg');
  var box = document.getElementById('app-install');
  var acts = document.getElementById('app-actions');
  if (!box) return;
  function say(t){ if (msg) msg.textContent = t; }
  function esc(x){ return String(x).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  // #383：失敗一定有一顆接著做的按鈕——伺服器給 action（{label,href}）就用它，沒有才是「再試一次」
  function fin(ok, t, extra, action){
    box.style.borderColor = ok ? 'var(--ok)' : 'var(--err)';
    say(t);
    var btn = ok ? '' : (action && action.href
      ? '<a class="btn" style="margin-top:12px" href="' + esc(action.href) + '">' + esc(action.label || '繼續') + '</a>'
      : '<a class="btn" style="margin-top:12px" href="">再試一次</a>');
    if (acts) acts.innerHTML = (extra || '') + btn;
  }
  var from = 0, hash = '', tries = 0;
  function step(){
    fetch('/api/app/install', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: from, h: hash }) })
      .then(function(r){ return r.json().catch(function(){ return null; }); })
      .then(function(j){
        if (!j) { fin(false, '這次安裝沒有完成，請再試一次。'); return; }
        if (j.state === 'done') { fin(true, j.message || '裝好了', j.url ? '<a class="btn" style="margin-top:12px" href="' + j.url + '">打開我的 Arcrun</a>' : ''); return; }
        if (j.state === 'in_progress') { from = j.resume_from || 0; hash = j.resume_hash || ''; say('還在裝，請稍候…'); setTimeout(step, 300); return; }
        if (j.state === 'retry') { if (++tries > 20) { fin(false, j.message || '暫時連不上，請稍後再試一次。'); return; } from = j.resume_from || from; hash = j.resume_hash || hash; say(j.message || '稍等一下…'); setTimeout(step, 6000); return; }
        fin(false, j.message || '這次安裝沒有完成，請再試一次。', '', j.action);
      })
      .catch(function(){ if (++tries > 20) { fin(false, '網路好像斷了，請再試一次。'); return; } setTimeout(step, 4000); });
  }
  if (!cfg.wait) { step(); return; }
  // 新裝：主程式裝完（install status 回 done）才輪到 App
  say('先裝好 Arcrun，裝完會接著裝「' + (cfg.name || 'App') + '」…');
  function poll(){
    fetch('/api/install/status', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).then(function(p){
      if (p && p.state === 'done') { say('Arcrun 裝好了，接著裝「' + (cfg.name || 'App') + '」…'); step(); return; }
      if (p && p.state === 'error') { say('Arcrun 沒裝完，請照上面的提示處理後再來。'); return; }
      setTimeout(poll, 3000);
    }).catch(function(){ setTimeout(poll, 4000); });
  }
  poll();
})();
`;
}
