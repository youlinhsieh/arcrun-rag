// App 圖示——只有一個來源：實例（inkstone/arcrun-rag#240 c18275，leo 2026-10-09）
//
// leo：「筆記 icon 在小幫手和在 portal 不同？應從同一個地方拉」。
// 小幫手不存字形、不對照 emoji、不算雜湊：App 清單每筆帶實例挑好的 `glyph` 代號，
// 字形本體（SVG 內層標記）由實例的 glyphs 端點提供（Go 側 glyphs.go 去拿，隨清單一起回來）。
// Portal 改了圖示，小幫手不用改就跟著變。
//
// 拿不到（舊實例沒有端點、清單沒帶 glyph、字形不在表裡、標記不乾淨）⇒ 退回通用圖示。
const OK_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const OK_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points']);

// 實例給的是字串，不能原樣塞進 innerHTML：只留白名單內的圖形標籤與幾何屬性，其餘一律丟掉。
export function cleanGlyph(inner) {
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return '';
    let out = '';
    doc.documentElement.childNodes.forEach((n) => {
      const tag = (n.localName || '').toLowerCase();
      if (n.nodeType !== 1 || !OK_TAGS.has(tag)) return;
      let attrs = '';
      Array.from(n.attributes).forEach((a) => {
        if (OK_ATTRS.has(a.name) && /^[-0-9a-zA-Z .,]*$/.test(a.value)) attrs += ` ${a.name}="${a.value}"`;
      });
      out += `<${tag}${attrs}/>`;
    });
    return out;
  } catch (e) { return ''; }
}

const GENERIC = '<rect x="4" y="4" width="16" height="16" rx="3"/>';

// list＝ListApps() 的回傳（含 glyphs 表）；app＝清單裡的一筆（含 glyph 代號）。
export function glyphSvg(list, app) {
  const inner = list && list.glyphs && app && app.glyph ? cleanGlyph(list.glyphs[app.glyph] || '') : '';
  return `<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner || GENERIC}</svg>`;
}
