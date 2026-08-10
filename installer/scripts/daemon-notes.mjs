/**
 * daemon-notes.mjs — 使用者在「版本與更新」畫面看到的那一行，**由 changelog 機械導出**
 *
 * ── 這支解什麼病（leo 2026-08-08 真機看到 v0.18.24 的更新畫面）────────────
 * leo 原話：「**不要這麼長的散文，簡短講改了什麼，細節去 docs 讀。**」
 *
 * 他看到的是**一整面文字牆**，而且 `**粗體**` 原樣露在畫面上。
 * 真兇不是文案沒寫好，是**出貨當下靠人手工排版**：
 *   出貨時用一段臨時 python 把 changelog 的換行折掉塞進 `manifest.daemon.notes`，
 *   於是四條變成一大段；那段轉換每次出貨都要重寫一次，而且**沒人檢查結果長什麼樣**。
 *
 * ⇒ 與「版本號由內容算」同一種解法：**這一行也由單一真相源導出，不由人當場捏**。
 *
 * ── 為什麼是「只取粗體標題、串成一行」──────────────────────────────────
 * 畫面那個欄位是**純文字**：`main.js:215` 是 `<div class="d">${esc(u.notes)}</div>`，
 *   ① `esc()` ⇒ 任何 markdown 符號都會原樣露出來（leo 看到的 `**` 就是這樣來的）
 *   ② HTML 不保留換行（`.d` 沒有 white-space:pre）⇒ 塞 `\n` 進去也**不會**變成分行
 * ⇒ 唯一能讀的形狀就是**一行短句**。而 changelog 每條的 `**粗體標題**` 本來就是
 *   那條的一句話摘要——直接拿它，不必另外維護第二份文案（第二份必然漂移）。
 *
 * 用法：
 *   import { notesFromChangelog } from './daemon-notes.mjs';
 *   notesFromChangelog(repoRoot, 'v0.18.24')   // → 一行字，或 null（changelog 沒這版）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CHANGELOG_REL = 'docs-site/src/content/docs/help/changelog.md';
/** 畫面上一行讀得完的上限。超過就截，並改叫使用者去看說明文件。 */
export const NOTES_MAX = 100;
const TAIL = '（細節見說明文件）';

/** 把 markdown 行內語法剝成純文字——畫面不渲染 markdown，留著就是雜訊。 */
export function stripMarkdown(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [字](連結) → 字
    .replace(/[*_`]+/g, '')                     // 粗體/斜體/行內碼標記
    .replace(/\s+/g, ' ')                       // 換行與連續空白 → 單一空白
    .trim();
}

/**
 * 從 changelog 取某一版的「一句話摘要」清單。
 * 規則：只認**頂層條目**（行首 `- `）的第一個粗體片段——那就是該條的標題。
 *   沒有粗體的條目退而取整行（截短），因為「有寫總比漏掉好」。
 */
export function headlinesFor(changelogText, version) {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${version.replace(/[.\\]/g, '\\$&')}(\\D|$)`).test(l.trim()));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;                 // 下一版開始
    if (!/^-\s/.test(l)) continue;              // 只取頂層條目（續行、巢狀一律略過）
    const body = l.replace(/^-\s*/, '');
    const bold = body.match(/\*\*([^*]+)\*\*/);
    let h = stripMarkdown(bold ? bold[1] : body);
    h = h.replace(/^[^\p{L}\p{N}「（(]+/u, '');  // 去掉開頭的 emoji／符號
    h = h.replace(/[：:，,。.]+$/, '');           // 去掉尾標點（要串接）
    if (h) out.push(h);
  }
  return out;
}

/** 組成畫面上那一行。回傳 null＝changelog 裡沒有這一版（呼叫端該當成錯誤）。 */
export function notesFromChangelog(repoRoot, version) {
  const p = join(repoRoot, CHANGELOG_REL);
  if (!existsSync(p)) return null;
  const heads = headlinesFor(readFileSync(p, 'utf8'), version);
  if (!heads || !heads.length) return null;

  let line = heads.join('・');
  if (line.length > NOTES_MAX) {
    // 截到「最後一個完整條目」為止，再掛尾巴——不要把句子切一半給使用者看。
    const kept = [];
    for (const h of heads) {
      if ([...kept, h].join('・').length + TAIL.length > NOTES_MAX) break;
      kept.push(h);
    }
    line = (kept.length ? kept.join('・') : heads[0].slice(0, NOTES_MAX - TAIL.length)) + TAIL;
  }
  return line;
}

/**
 * 機械閘用：這一行本身可不可以送到使用者眼前？
 * 回傳問題清單（空＝通過）。這道閘存在的理由＝**手寫的那一行沒有任何人檢查**。
 */
export function checkNotes(notes) {
  const problems = [];
  const s = String(notes ?? '');
  if (!s.trim()) return ['manifest.daemon.notes 是空的——使用者按「檢查更新」看不到這版改了什麼'];
  if (/[*_`#]|\]\(/.test(s)) {
    problems.push(`manifest.daemon.notes 裡有 markdown 符號，畫面是純文字會原樣露出來：${JSON.stringify(s.slice(0, 60))}`);
  }
  if (/\n/.test(s)) {
    problems.push('manifest.daemon.notes 有換行——畫面不保留換行（.d 沒有 white-space:pre），會擠成一坨');
  }
  if (s.length > NOTES_MAX + TAIL.length) {
    problems.push(`manifest.daemon.notes 太長（${s.length} 字，上限 ${NOTES_MAX + TAIL.length}）——leo 08-08：「不要這麼長的散文，簡短講改了什麼，細節去 docs 讀」`);
  }
  return problems;
}

// CLI：印出某版會顯示的那一行（出貨前想先看一眼時用）
if (process.argv[1] && process.argv[1].endsWith('daemon-notes.mjs')) {
  const v = process.argv[2];
  const root = join(import.meta.dirname, '..', '..');
  if (!v) { console.error('用法：node installer/scripts/daemon-notes.mjs <版本，例 v0.18.24>'); process.exit(2); }
  const line = notesFromChangelog(root, v);
  if (!line) { console.error(`❌ changelog 沒有 ${v} 這一版（${CHANGELOG_REL}）`); process.exit(1); }
  // stdout **只有那一行**——它會被別的腳本（changelog-section.sh）直接取用，
  // 多印一個字就會被塞進 manifest。其餘一律走 stderr。
  console.log(line);
  console.error(`（${line.length} 字）`);
  const probs = checkNotes(line);
  if (probs.length) { probs.forEach((p) => console.error('❌ ' + p)); process.exit(1); }
  console.error('✅ 可以送到使用者眼前');
}
