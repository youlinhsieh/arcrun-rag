// text-budget-audit.mjs — 畫面字數預算的量測邏輯（小幫手與安裝器共用，只有這一份）
// 預算數值在 text-budget.json；規則本體見 InkStoneCo wiki「說明文字代表設計不良」字數預算節。
//   按鈕 ≤4／標籤 ≤6／常駐一行 ≤20 且不帶句號逗號／hover ≤25 且一句／展開 ≤3 行 × 20 字。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUDGET = JSON.parse(fs.readFileSync(path.join(here, 'text-budget.json'), 'utf8'));

/**
 * 量目前頁面上「看得到的字」，回傳違規清單（字串陣列）。
 * opts.data：不是我們寫的字（名稱、路徑、版本、檔名、輸入框）的選擇器；
 * opts.roots：要量的根元素選擇器；opts.hoverExempt：hover 提示不受預算的元素（資料）。
 */
export async function auditPage(page, where, opts) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  const found = await page.evaluate(({ B, DATA, ROOTS, HOVER_EXEMPT }) => {
    const out = [];
    const SENT = new RegExp('[' + B.forbidPunct + ']');
    const cnt = (s) => Array.from(s.replace(/[\s·]/g, '')).length;
    const visible = (e) => { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; return e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(e).visibility !== 'hidden'; };
    for (const sel of ROOTS) {
      const root = document.querySelector(sel);
      if (!root) continue;
      root.querySelectorAll('*').forEach((e) => {
        if (!visible(e) || e.closest(DATA)) return;
        const own = Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
        if (own && !e.matches('script,style')) {
          const n = cnt(own);
          const tag = e.tagName.toLowerCase();
          const role = e.getAttribute('role');
          const isBtn = tag === 'button' || tag === 'a' && e.matches('.btn') || role === 'button' || role === 'tab';
          const isRaw = e.matches('.err,.out,.ftmsg,.folder-note,.raw,pre');
          const isNotifTitle = e.matches('.nt,.qt,details.more > summary');
          const isLabel = !isNotifTitle && e.matches('h1,h2,h3,.lb,.k,.t,.tag,.sec,.ml,.mn,label,summary,.cap,li');
          let limit = isNotifTitle ? B.title : B.detailLineChars, kind = '一行';
          if (isBtn) { limit = role === 'tab' ? B.label : B.button; kind = '按鈕'; }
          else if (isRaw) { limit = e.matches('pre') ? 9999 : (e.matches('.raw') ? B.detailLineChars : 60); kind = '系統原文'; }
          else if (isLabel) { limit = B.label; kind = '標籤'; }
          if (n > limit || (!isRaw && SENT.test(own))) out.push(`${kind} ${n}/${limit} 字：${own}`);
        }
        const t = e.getAttribute('title');
        if (t && !e.closest(HOVER_EXEMPT)) {
          const n = Array.from(t).length;
          if (n > B.hover || (t.match(/[。！？]/g) || []).length > B.hoverSentences) out.push(`hover ${n}/${B.hover} 字：${t}`);
        }
      });
    }
    document.querySelectorAll('details pre').forEach((p) => {
      if (!visible(p) || p.closest(DATA)) return;
      const lines = p.textContent.split('\n').filter((l) => l.length);
      if (p.closest('.keep-long, details.tech')) return;
      if (lines.length > B.detailLines && !p.dataset.full) out.push(`展開 ${lines.length}/${B.detailLines} 行`);
      lines.forEach((l) => { if (Array.from(l).length > B.detailLineChars && !p.dataset.full) out.push(`展開行 ${Array.from(l).length}/${B.detailLineChars} 字：${l}`); });
    });
    return out;
  }, { B: BUDGET, DATA: opts.data, ROOTS: opts.roots, HOVER_EXEMPT: opts.hoverExempt });
  return found.map((f) => `[${where}] ${f}`);
}
