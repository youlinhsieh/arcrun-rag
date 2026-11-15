// inkstone/arcrun-rag（工單 B，母票 inkstone/Arcrun#343）：已萃好的卡 → 原文層 → 向量層段落。
// 依據：ADR inkstone/InkStoneCo#275 c1794124786576310「待決定」第三條：現有已萃的卡保留當作已沉澱的卡，只補向量層，不重做。
//
// 為什麼從「卡」取原稿而不是回去讀原檔：大前 11-15 的庫裡**沒有任何段落**，而卡已經逐字保留了原稿
// （arcrun-rag#277：「原文表格／原文條列／原文段落／讀圖原文」四個 H2 段，文字照原稿、沒有經過 AI 改寫）。
// 所以雲端就有原稿文字可以切，不用等 Mac 重送（Mac 打包在 inkstone/InkStoneCo#286 等地端）。
//
// 只讀這四個原文層；摘要／重點／實體／關聯一個字都不嵌（卡正文不嵌）。
// 卡本身一個字不動（leo 11-08：舊卡照舊留著）——這支只讀卡、寫段落。
// 沒有原文層的舊卡（#277 之前萃的）＝零段落，如實回報，不猜。
import { createHash } from 'node:crypto';

export const LAYERS = ['原文表格', '原文條列', '原文段落', '讀圖原文'];
// 這些 H2 是卡的章節邊界。讀圖原文的內文本身會有 `## 1.3 Control System` 這種 H2，
// 所以「遇到 H2 就收尾」是錯的——只有在這個集合裡的 H2 才算章節邊界。
const SECTION_H2 = new Set([...LAYERS, '摘要', '重點', '實體', '關聯', '讀不到的內容', '一句話定義']);
// 單元標題：「PDF 第 13 頁的條列：2.3.3 Z-axis」「PDF 第 5 頁的圖片辨識文字」。
// 嚴格比對「第 N 頁的<類型>」才算單元起點，讀圖內文裡的 `### 2.3.1 X-axis` 一律當內文。
// 真資料（大前 lib_1e221c 手冊卡）還有「PDF 第 5 頁的表格（第 1 段）」——一頁的表格太大時卡把它分成幾段，要認得。
const UNIT_RE = /^###\s+(.+?)\s*第\s*(\d+)\s*頁的(表格|條列|段落|圖片辨識文字)(?:（第\s*\d+\s*段）)?(?:：(.*))?\s*$/;

export const TARGET_RUNES = 350; // 評測結果（見 scripts/eval）：700 字一段會把同頁多個主題稀釋掉，小段命中率較高
export const MAX_RUNES = 600;
export const MIN_RUNES = 80;
// 內容（不含標題行）少於這個字數的段落是頁碼、章名之類，不值得嵌入。
export const NOISE_RUNES = 24;
// 卡來源的 chunker_rev：與小幫手檔案切段（collector/passages.go，rev 1、2…）分開編號。
export const CARD_CHUNKER_REV = 102;

const runes = (s) => Array.from(s).length;

/** 把一張卡的 markdown 拆成原文層單元：[{layer, kind, page, srcKind, title, text}]。 */
export function extractUnits(cardMd) {
  const lines = String(cardMd || '').replace(/\r\n?/g, '\n').split('\n');
  const units = [];
  let layer = null;
  let cur = null;
  const close = () => {
    if (cur) {
      cur.text = cur.lines.join('\n').trim();
      delete cur.lines;
      if (cur.text) units.push(cur);
    }
    cur = null;
  };
  for (const ln of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(ln);
    if (h2) {
      const name = h2[1];
      if (SECTION_H2.has(name)) {
        close();
        layer = LAYERS.includes(name) ? name : null;
        continue;
      }
    }
    if (!layer) continue;
    const u = UNIT_RE.exec(ln);
    // 「### 無法逐字抽取的表格」這類說明小節不是單元：原文／條列／段落層裡，任何不是單元的 H3 都收掉目前單元並丟棄；
    // 讀圖原文的內文本身會有 `### 2.3.1 X-axis`，那裡的 H3 一律當內文。
    if (!u && layer !== '讀圖原文' && /^###\s/.test(ln)) { close(); continue; }
    if (u) {
      close();
      cur = { layer, srcKind: u[1].trim(), page: Number(u[2]), kind: u[3], title: (u[4] || '').trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(ln);
  }
  close();
  return units;
}

/** 去掉列首的「第 N 項｜／第 N 段｜／第 N 列｜」編號（卡自己加的，不是原稿；留著只會稀釋向量）。 */
export function cleanRows(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^第\s*\d+\s*(?:項|段|列)｜/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(s, max) {
  const rs = Array.from(s);
  if (rs.length <= max) return [s];
  const out = [];
  let buf = '';
  let n = 0;
  for (let i = 0; i < rs.length; i++) {
    buf += rs[i];
    n++;
    const c = rs[i];
    const boundary = '。！？；\n'.includes(c) || ('.!?'.includes(c) && (i + 1 >= rs.length || rs[i + 1] === ' ' || rs[i + 1] === '\n'));
    if ((boundary && n >= (max * 2) / 3) || n >= max) {
      out.push(buf.trim());
      buf = '';
      n = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 單元 → 段落。同一頁、同一層的相鄰單元合併到目標長度（絕不跨頁合併：引用要對得回「第幾頁」）。
 * 回 [{idx, layer, page, heading, text, content}]；heading＝「卡名 › 層 › PDF 第 N 頁：小節」（進 metadata，供引用）；content＝標題＋內文（嵌的是整段）。
 */
export function buildPassages(pageName, cardMd) {
  const units = extractUnits(cardMd);
  const groups = new Map();
  for (const u of units) {
    const k = `${u.layer}\u0000${u.srcKind}\u0000${u.page}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  const out = [];
  for (const us of groups.values()) {
    const first = us[0];
    const where = `${first.srcKind} 第 ${first.page} 頁`;
    let buf = [];
    let bufRunes = 0;
    let bufTitle = '';
    const emit = () => {
      if (!buf.length) return;
      const body = buf.join('\n\n');
      buf = [];
      bufRunes = 0;
      const title = bufTitle;
      bufTitle = '';
      if (runes(body) < NOISE_RUNES) return;
      const heading = [pageName, first.layer, where + (title ? `：${title}` : '')].join(' › ');
      // content 第一行＝標題路徑：嵌入的是整段，帶「卡名 › 層 › 頁：小節」脈絡。
      // 實測（scripts/eval，2026-11-15）：把 content 縮成只有小節名，hit@3 從 12/14 掉到 11/14，所以保留完整標題。
      out.push({ layer: first.layer, page: first.page, heading, text: body, content: `${heading}\n${body}` });
    };
    for (const u of us) {
      const body = cleanRows(u.text);
      if (!body) continue;
      for (const piece of splitLong(body, MAX_RUNES)) {
        const n = runes(piece);
        if (buf.length && (bufRunes + n > TARGET_RUNES || (u.title !== bufTitle && bufRunes >= MIN_RUNES))) emit();
        if (!buf.length) bufTitle = u.title;
        buf.push(piece);
        bufRunes += n;
      }
    }
    emit();
  }
  out.forEach((p, i) => { p.idx = i; });
  return out;
}

/** 段落 id 前綴：與「小幫手切檔案」的 sha1(機器|庫|路徑) 不同的命名空間（多一個 card 標記），兩條路不會互相覆寫。 */
export function passageIdPrefix(machine, library, pageName) {
  const h = createHash('sha1').update(`card\u0000${machine}\u0000${library}\u0000${pageName}`).digest('hex');
  return `psg-${h.slice(0, 16)}`;
}

export function withIds(passages, machine, library, pageName) {
  const pre = passageIdPrefix(machine, library, pageName);
  return passages.map((p) => ({ ...p, id: `${pre}-${p.idx}` }));
}

/** 段落內容的版本戳：同一份卡文字 → 同一個值（供卡重萃／原稿改版後判斷段落過期）。 */
export function layerHash(passages) {
  const h = createHash('sha1');
  for (const p of passages) h.update(p.content + '\u0000');
  return h.digest('hex').slice(0, 24);
}
