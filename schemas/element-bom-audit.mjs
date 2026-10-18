// element-bom-audit.mjs — 畫面元素 BOM 的量測邏輯（inkstone/arcrun-rag#261）
//
// leo 2026-10-11：「同一個頁面同一件事情不要用多個元素顯示，就想每個元素就是要花錢買一顆零件。」
// 「BOM 比的是意義不是數字」——同一個數字出現兩次，講兩件事合法；講同一件事就是多花錢。
//
// BOM（element-bom.json）每一列＝一種元素：
//   id     穩定代號
//   sel    CSS 選擇器（要選到「一個零件」，不要選整個容器——容器會把裡面的東西全部蓋住）
//   asks   它回答用戶的哪一個問題（意義）。判準：同一個畫面上兩個零件的 asks 相同＝多花錢
//   repeat true＝同一列在畫面上出現多次是正常的（清單的每一列、每個帳號）
//   pair   true＝控制項與它的標籤是同一個零件（輸入框加欄位名、勾選框加說明），算一個
// 判準（不用關鍵字黑名單）：
//   ① 看得見的零件（有字／圖示／按鈕／有 title／空心圓點）必須落在某一列 BOM 底下，否則＝沒登記
//   ② 一列 BOM 選到多個零件而沒標 repeat＝同一件事用多個元素講
//   ③ 兩列 BOM 的 asks 相同＝同一個意義有多個零件
// 豁免只能寫在 BOM 的 waivers（要有 ref 票號與原因），每次都會印出來，不會悄悄過。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function loadBom(file) {
  return JSON.parse(fs.readFileSync(file || path.join(here, '..', 'collector', 'cmd', 'arcrun-app', 'element-bom.json'), 'utf8'));
}

/** 量目前畫面。回傳 { where, parts, meanings, problems[], waived[] } */
export async function auditBom(page, where, bom, opts = {}) {
  const entries = [...bom.entries, ...(opts.extraEntries || [])];
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  const r = await page.evaluate(({ entries, roots, layout }) => {
    const visible = (e) => { const b = e.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) return false; return e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true; };
    const desc = (e) => {
      const t = e.tagName.toLowerCase();
      const cls = [...e.classList].slice(0, 3).join('.');
      const txt = (e.getAttribute('title') || [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() || '').slice(0, 14);
      return t + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : '') + (txt ? `「${txt}」` : '');
    };
    const roots_ = roots.map((s) => document.querySelector(s)).filter(Boolean);
    const all = [];
    roots_.forEach((r) => r.querySelectorAll('*').forEach((e) => { if (visible(e)) all.push(e); }));
    const inSvg = (e) => e.closest('svg') && e.tagName.toLowerCase() !== 'svg' && e.closest('svg') !== e;
    // 每個零件歸到「最近的、選得到它的 BOM 列」
    const owner = new Map();
    const matchedBy = entries.map(() => []);
    entries.forEach((en, i) => {
      let list = [];
      try { list = all.filter((e) => e.matches(en.sel)); } catch (err) { throw new Error('BOM 選擇器壞了：' + en.id + ' ' + en.sel); }
      // 只取最外層（同一列裡巢狀的算同一個零件）
      list = list.filter((e) => !list.some((o) => o !== e && o.contains(e)));
      matchedBy[i] = list;
    });
    const covers = (e) => { for (let i = 0; i < entries.length; i++) if (matchedBy[i].some((m) => m === e || m.contains(e))) return i; return -1; };
    // widget 偵測：看得到、而且是用戶會當成「一個東西」看的
    const widgets = all.filter((e) => {
      if (inSvg(e)) return false;
      if (layout.some((l) => e.matches(l))) return false; // 版面用的留白，不是零件
      const t = e.tagName.toLowerCase();
      if (['script', 'style', 'main', 'section', 'nav', 'aside', 'header'].includes(t)) return false;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (own) return true;
      if (['svg', 'img', 'input', 'textarea', 'select', 'button', 'canvas'].includes(t)) return true;
      if (e.getAttribute('title') && e.children.length === 0) return true; // 容器自己的 title 不算零件，裡面的才算
      if (e.children.length === 0 && e.matches('i,b,s,em,span,div')) return true; // 空心圓點／色塊
      return false;
    });
    const unregistered = [];
    widgets.forEach((w) => { if (covers(w) < 0) unregistered.push(desc(w)); });
    const perEntry = entries.map((en, i) => ({ id: en.id, asks: en.asks, repeat: !!(en.repeat || en.pair), nodes: matchedBy[i].map(desc) })).filter((p) => p.nodes.length);
    return { unregistered: [...new Set(unregistered)], perEntry };
  }, { entries, roots: opts.roots || ['#side', '#page', '#sheet'], layout: bom.layout || [] });

  const problems = []; const waived = [];
  // 豁免只認「這幾個零件」：之後多出第五個去講同一件事，不在名單裡，照樣被擋
  const waiver = (kind, key, ids) => (bom.waivers || []).find((w) => w.kind === kind && w.key === key && w.ref && w.reason && (!w.ids || (ids || []).every((i) => w.ids.includes(i))));
  const flag = (kind, key, msg, ids) => { const w = waiver(kind, key, ids); if (w) waived.push(`[${where}] 待裁（${w.ref}）：「${key}」＝${(ids && ids.length ? ids : [key]).join(' 與 ')}｜${w.reason}`); else problems.push(`[${where}] ${msg}`); };

  r.unregistered.forEach((u) => flag('unregistered', u.replace(/「.*」/, ''), `沒登記的元素 ${u}：到 element-bom.json 加一列，寫清楚它回答用戶哪一個問題；若它講的意義已有別的零件在講，就不要加這顆零件`));
  r.perEntry.forEach((p) => {
    if (!p.repeat && p.nodes.length > 1) flag('multi', p.id, `「${p.asks}」被 ${p.nodes.length} 個元素同時在講：${p.nodes.join('、')}。留一個，其餘拿掉（若是清單每一列，BOM 該列標 repeat；控制項加標籤標 pair）`, [p.id]);
  });
  const byAsk = new Map();
  r.perEntry.forEach((p) => { const a = byAsk.get(p.asks) || []; a.push(p); byAsk.set(p.asks, a); });
  for (const [asks, ps] of byAsk) if (ps.length > 1) flag('dup', asks, `「${asks}」被 ${ps.length} 個零件重複回答：${ps.map((p) => `${p.id}（${p.nodes[0]}${p.nodes.length > 1 ? ' 等' + p.nodes.length + '個' : ''}）`).join(' 與 ')}。同一個意義只留一個元素`, ps.map((p) => p.id));

  // 元素數／意義數：repeat 的整列算一個零件
  const parts = r.perEntry.reduce((n, p) => n + (p.repeat ? 1 : p.nodes.length), 0);
  const meanings = byAsk.size;
  return { where, parts, meanings, problems, waived };
}
