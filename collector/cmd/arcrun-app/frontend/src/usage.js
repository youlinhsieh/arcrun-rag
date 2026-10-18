// usage.js — 用量分頁：離「爆」或「開始收費」還多遠（inkstone/arcrun-rag#246）
//
// 設計依據：#246 c18628（三題＋活儀表）／c18637（圖示）／c18638（每行樣式）／c18642（三級精密度）。
//
// 🔴 這裡一個判準都沒有：三態、超出量、金額全是 Go 側（usageui.go）算好的，前端只畫。
//    唯一在這裡算的是「往前推」——兩次抓取之間，用雲端給的每分鐘速率讓數字跳動（抓到新值就校正）。
// 🔴 三級精密度（leo 10-10）：
//    高精度＝主表盤＋里程表（最吃緊那一項，會跳）；
//    中精度＝儀表旁兩顆小按鈕（錢＝費用說明或升級／剎車＝去設定），不再是一排三個大方塊（leo 10-11：
//    「Form follows function，不要為了美觀亂加元素」）；離爆多遠只由圓弧說，不再重複一格；
//    低精度＝只在出錯時亮（資料過舊、查不到）。
//    位置固定：計費項永遠是同一個順序，用戶靠位置＋顏色判讀，不靠字。
// 🔴 版面不放句子：全部是圖示＋數字，說明只在 title（hover ≤25 字，字數預算會擋）。

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d, w = 18) => `<svg class="uic" viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => (n > 0 && n < 0.01 ? '<0.01' : n.toFixed(2));

const CYL = '<ellipse cx="9" cy="6" rx="5.5" ry="2.3"/><path d="M3.5 6v10c0 1.3 2.5 2.3 5.5 2.3s5.5-1 5.5-2.3V6"/>';
export const ITEM_ICON = {
  ai: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7Z"/>'),
  vec_store: svg('<circle cx="12" cy="5" r="1.6"/><circle cx="5.5" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="12" cy="12" r="1.6"/>'),
  vec_query: svg('<circle cx="5" cy="6" r="1.3"/><circle cx="5" cy="14" r="1.3"/><circle cx="11" cy="19" r="1.3"/><circle cx="14.5" cy="9.5" r="4"/><path d="m17.5 12.5 3.5 3.5"/>'),
  d1_write: svg(CYL + '<path d="M19.5 9v8M17 14.5l2.5 2.5 2.5-2.5"/>'),
  d1_read: svg(CYL + '<path d="M19.5 17V9M17 11.5 19.5 9l2.5 2.5"/>'),
  cpu: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
  requests: svg('<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>'),
  disk: svg('<rect x="3.5" y="7" width="17" height="10" rx="2"/><circle cx="17" cy="12" r="1"/><path d="M7 12h5"/>'),
  other: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4M12 15.5v.1"/>'),
};
// 費用說明頁（docs-site/src/content/docs/use/cost.md）：這筆錢是 Cloudflare 收的、附 CF 帳單連結。
// 免費帳號的「$」去既有的升級說明（quota 頁的怎麼升級四步），CF 的連結都放在說明裡，畫面不直接導去 CF。
const DOC_COST = 'https://rag.arcrun.dev/docs/use/cost/';
const DOC_UPGRADE = 'https://rag.arcrun.dev/docs/use/quota/#%E6%80%8E%E9%BA%BC%E5%8D%87%E7%B4%9A%E5%9B%9B%E6%AD%A5';
const S = {
  // 三態（表針偏左／偏右＋驚嘆／錢幣／暫停）
  ok: svg('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 15l-4-4"/><circle cx="12" cy="15" r="1.1"/>', 22),
  near: svg('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 15l4-4"/><circle cx="12" cy="15" r="1.1"/><path d="M12 3.5v1.4"/>', 22),
  overPaid: svg('<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.3c-.6-.9-1.5-1.3-2.5-1.3-1.4 0-2.5.8-2.5 2 0 2.8 5 1.6 5 4.2 0 1.2-1.1 2-2.5 2-1.1 0-2-.5-2.6-1.4M12 6.5V8M12 16v1.5"/>', 22),
  overFree: svg('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7M14 8.5v7"/>', 22),
  reset: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>', 14),
  month: svg('<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M9 3.5v4M15 3.5v4"/>', 14),
  paid: svg('<path d="M7 9.5c-2.6 0-4.5 1.2-4.5 2.5S4.4 14.5 7 14.5c3 0 7-5 10-5 2.6 0 4.5 1.2 4.5 2.5s-1.9 2.5-4.5 2.5c-3 0-7-5-10-5Z" transform="translate(0 0)"/>', 16),
  free: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 16),
  local: svg('<rect x="5" y="6" width="14" height="9.5" rx="1.2"/><path d="M3 19h18"/>', 16),
  cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a3.8 3.8 0 0 1-.3 7.5Z"/>', 16),
  brakeOn: svg('<circle cx="11" cy="12" r="7"/><circle cx="11" cy="12" r="2"/><path d="M18.5 8.5v7" stroke-width="3.2"/>', 22),
  brakeOff: svg('<circle cx="11" cy="12" r="7"/><circle cx="11" cy="12" r="2"/><path d="M18.5 8.5v7" opacity=".35"/><path d="M4 20 20 4"/>', 22),
  brakeNa: svg('<circle cx="11" cy="12" r="7" opacity=".4"/><circle cx="11" cy="12" r="2" opacity=".4"/>', 22),
  help: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5M12 16.5v.1"/>', 15),
  stale: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 15),
};
S.paid = svg('<path d="M12 12c-1.7-2.6-3.3-4-5-4a4 4 0 0 0 0 8c1.7 0 3.3-1.4 5-4Zm0 0c1.7 2.6 3.3 4 5 4a4 4 0 0 0 0-8c-1.7 0-3.3 1.4-5 4Z"/>', 16);

const itemIcon = (k) => ITEM_ICON[k] || ITEM_ICON.other;
const nameOf = (u, k) => ((u.items || []).find((x) => x.key === k) || {}).tipName || k;

// 主表盤：半圓，填到最吃緊那一項的 %（越線＝滿格轉紅，數字是超過幾 %）
function dial(u, top) {
  const pct = top ? top.pct : 0;
  const fill = Math.min(100, pct) / 100;
  const R = 52, C = Math.PI * R;
  return `<div class="udial ${esc(u.level)}" title="${esc(u.tipTop)}" aria-label="${esc(u.tipTop)}">
    <svg viewBox="0 0 120 70" width="170" height="99" aria-hidden="true">
      <path class="dtrack" d="M8 62a52 52 0 0 1 104 0" pathLength="${C.toFixed(1)}"/>
      <path class="dfill" d="M8 62a52 52 0 0 1 104 0" style="stroke-dasharray:${(C * fill).toFixed(1)} ${C.toFixed(1)}"/>
    </svg>
    <div class="dmid">${top ? itemIcon(top.key) : S.ok}</div>
    <div class="dpct" data-live-pct="1">${top ? pct : '—'}<small>%</small></div>
  </div>`;
}

// 一個計費項一行：圖示｜用量/（超出量或線）｜$ 或 暫停｜歸零符號＋時間｜細進度條
function row(it, plan) {
  const live = ''; // #260：數字只反映雲端回報的真實用量，不往前推估（leo 10-11：沒在花就不准動）
  const second = it.limit > 0 ? fmt(it.limit) : '';
  // leo 10-11（#261 c19149）：超線就是要付費，金額只由上方「$ 金額」按鈕講；列上不再放 $，也不整列變色。
  const sym = it.pause ? `<span class="upause" title="${esc(it.tipName)}" aria-label="${esc(it.tipName)}">${S.overFree.replace('width="22" height="22"', 'width="15" height="15"')}</span>` : '<span class="usym"></span>';
  const rst = it.reset ? `<span class="ureset" title="${esc(it.tipReset || '')}" aria-label="${esc(it.tipReset || '')}">${it.per === 'month' ? S.month : S.reset}<b>${esc(it.reset)}</b></span>` : '<span class="ureset"></span>';
  // 進度條：額度內一個顏色、超出的部分另一個顏色（像 Cloudflare Workers AI 用量圖，低調）
  const tot = Math.max(it.used, it.limit);
  const inW = it.limit > 0 ? Math.min(it.used, it.limit) / tot * 100 : 0;
  const bar = it.limit > 0 ? `<span class="ubar"><i class="in" style="width:${inW.toFixed(1)}%"></i>${it.used > it.limit ? `<i class="out" style="width:${(100 - inW).toFixed(1)}%"></i>` : ''}</span>` : '<span class="ubar"></span>';
  return `<div class="urow ${esc(it.level)}" data-ukey="${esc(it.key)}">
    <span class="uname" title="${esc(it.tipName)}" aria-label="${esc(it.tipName)}">${itemIcon(it.key)}</span>
    <span class="unum" title="${esc(it.tipNum)}"><b class="uused"${live}>${fmt(it.used)}</b>${second ? `<span class="useg">/</span><span class="u2">${second}</span>` : ''}</span>
    ${sym}${rst}${bar}
  </div>`;
}

export function usageDashboard(u, ctx = {}) {
  if (!u) {
    // 查不到：不編數字（舊版雲端沒有這支）。低精度燈：灰色問號。
    return `<div class="card udash unk"><div class="ulamp" title="查不到 Cloudflare 用量" aria-label="查不到 Cloudflare 用量">${S.help}</div></div>`;
  }
  const top = (u.items || []).find((x) => x.key === u.top);
  const topLive = '';
  const planSym = u.plan === 'paid' ? S.paid : (u.plan === 'local' ? S.local : S.free);
  const planTip = u.plan === 'paid' ? '付費方案 超出才收費' : (u.plan === 'local' ? '地端 沒有帳單' : '免費方案 超出會暫停');
  const age = Date.now() - u.atMs;
  const stale = age > 5 * 60 * 1000;
  const lamp = stale ? `<span class="ulamp warn" title="數字已過時 稍後更新" aria-label="數字已過時">${S.stale}</span>` : '';

  // 高精度：主表盤＋里程表（最吃緊那一項）
  const odo = top ? `<div class="uodo ${esc(top.level)}"${topLive}>
      <span class="uico">${itemIcon(top.key)}</span>
      <span class="uodov"><b class="uused ${top.level === 'over' ? 'bad' : ''}">${fmt(top.used)}</b>${top.limit > 0 ? `<span class="useg">/</span><span class="u2 ${top.level === 'over' ? 'bad' : ''}">${fmt(top.limit)}</span>` : ''}</span>
      ${top.dollar ? '' : (top.pause ? `<span class="upause">${S.overFree.replace('width="22" height="22"', 'width="18" height="18"')}</span>` : '')}
      ${top.reset ? `<span class="ureset" title="${esc(top.tipReset || '')}">${top.per === 'month' ? S.month : S.reset}<b>${esc(top.reset)}</b></span>` : ''}
      ${top.rate > 0 ? `<span class="urate" title="每分鐘增加">+${fmt(top.rate)}<small>/m</small></span>` : ''}
    </div>` : '<div class="uodo ok"><span class="uico">' + S.ok + '</span></div>';

  // 中精度：儀表旁兩顆小按鈕（leo 10-11 #261）。
  //   · 錢：付費＝「$ 本月超線約多少」，點了去費用說明（那筆錢是 Cloudflare 收的）；
  //         免費＝一個「$」，點了去升級說明。想付費的人找錢的符號按，所以升級入口就是這個 $，不另放一顆。
  //   · 剎車：剎車的開關在知識庫網頁的設定（小幫手持的金鑰沒有改設定的權限），按了直接帶過去。
  const brakeIcon = u.brake === 'on' ? S.brakeOn : (u.brake === 'off' ? S.brakeOff : S.brakeNa);
  const small = (h) => h.replace('width="22" height="22"', 'width="17" height="17"');
  const covers = (u.covers || []).map((k) => `<span class="cv" title="${esc(nameOf(u, k))}">${itemIcon(k).replace(/width="18" height="18"/, 'width="12" height="12"')}</span>`).join('');
  const tip = (t) => `title="${esc(t)}" aria-label="${esc(t)}"`;
  let pay = '';
  if (u.upgrade === 'billing') {
    // $ 後面的數字＝所有超線項目的估算費用加總（leo c19149：超過的都會算在上面那個 $，清單各列沒有 $）
    const over = (u.items || []).filter((x) => x.dollar);
    const sumCost = over.reduce((a, x) => a + (x.cost || 0), 0);
    const sumRate = over.reduce((a, x) => a + (x.costRate || 0), 0);
    const live = '';
    pay = `<button class="uact pay${live}" data-openurl="${DOC_COST}" ${tip(u.upgradeTip)}><span class="udollar">$</span>${over.length ? `<b>${usd(sumCost)}</b>` : ''}</button>`;
  } else if (u.upgrade === 'advise' || u.upgrade === 'upgrade') {
    pay = `<button class="uact pay ${u.upgrade === 'advise' ? 'advise' : ''}" data-openurl="${DOC_UPGRADE}" ${tip(u.upgradeTip)}><span class="udollar">$</span></button>`;
  }
  const brk = u.brake === 'on' || u.brake === 'off'
    ? `<button class="uact brk ${esc(u.brake)}"${ctx.brakeUrl ? ` data-openurl="${esc(ctx.brakeUrl)}"` : ''} ${tip(u.tipBrake)}>${small(brakeIcon)}${covers}</button>`
    : `<span class="uact brk na" ${tip(u.tipBrake)}>${small(brakeIcon)}</span>`;
  const acts = `<div class="uacts">${pay}${brk}</div>`;

  const head = `<div class="uhead">
      <span class="ucloud" title="用量來自你自己的 Cloudflare 帳號" aria-label="用量來自你自己的 Cloudflare 帳號">${S.cloud}</span>
      <span class="uplan" title="${esc(planTip)}" aria-label="${esc(planTip)}">${planSym}</span>
      <span class="grow"></span>${lamp}
      <span class="uhelp" title="${esc(u.tipFresh)}" aria-label="${esc(u.tipFresh)}">${S.help}</span>
    </div>`;

  return `<div class="card udash ${esc(u.level)}" data-at="${u.atMs}">
    ${head}
    <div class="uhigh">${dial(u, top)}<div class="uright">${odo}${acts}</div></div>
    <div class="urows">${(u.items || []).map((it) => row(it, u.plan)).join('')}</div>
  </div>`;
}

// ── 往前推（唯一在前端算的東西）──────────────────────────────────────
// 兩次抓取之間，用雲端給的每分鐘速率讓數字跳動；抓到新值（data-at 變了、整塊重畫）就是校正。
// 最多往前推 10 分鐘，過了就停在那裡——資料過時還一直漲會變成編故事。
const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let timer = 0;
export function startUsageTicker() {
  return; // #260：停用往前推估。里程表只准反映雲端回報的真實用量（leo 10-11：閒置五分鐘數字不動）
  // eslint-disable-next-line no-unreachable
  if (timer || reduce) return;
  timer = setInterval(() => {
    const root = document.querySelector('.udash[data-at]');
    if (!root || document.visibilityState === 'hidden') return;
    const at = Number(root.dataset.at);
    const mins = Math.max(0, Math.min(10, (Date.now() - at) / 60000));
    root.querySelectorAll('[data-live]').forEach((el) => {
      const v = Number(el.dataset.base) + Number(el.dataset.rate) * mins;
      const t = fmt(v);
      if (el.textContent !== t) {
        el.textContent = t;
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      }
      const lim = Number(el.dataset.limit);
      const seg = el.parentElement && el.parentElement.querySelector('.u2.bad');
      if (lim > 0 && seg && v > lim) seg.parentElement.title = '額度 ' + fmt(lim) + ' 超出 ' + fmt(v - lim);
      if (el.dataset.odo) {
        const pctEl = root.querySelector('[data-live-pct]');
        if (lim > 0 && pctEl) {
          const p = Math.round(v / lim * 100);
          pctEl.firstChild.textContent = String(p);
        }
      }
    });
    const m = root.querySelector('.umoney');
    if (m) m.querySelector('b').textContent = usd(Number(m.dataset.costBase) + Number(m.dataset.costRate) * mins);
  }, 1000);
}
