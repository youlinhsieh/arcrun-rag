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
 * ── 🔴 2026-08-18（D95 第一輪）：搬進 collector/，且不再往上伸手 ──────────
 * 本檔原本住在 `installer/scripts/`，讀的是 repo 根的 `docs-site/.../changelog.md`。
 * 那讓 **daemon 的更新說明投影器住在 daemon 之外**，而它讀的檔也在 daemon 之外
 * ⇒ `collector/` 沒辦法自己交出「這一版對用戶意味什麼」這句話。
 *
 * 現在：實作住這裡，讀的是**同一棵樹裡的** `collector/CHANGELOG.md`（自我定位，不問 git）。
 * `installer/scripts/daemon-notes.mjs` 變成薄殼，轉呼叫本檔——
 * **根可以往內伸手，collector 不可以往外伸手**，方向是單向的。
 *
 * 用法（collector 內部）：
 *   import { notesForVersion } from './daemon-notes.mjs';
 *   notesForVersion('v0.18.24')   // → 一行字，或 null（changelog 沒這版）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** daemon 的 changelog＝`collector/CHANGELOG.md`。由本檔位置往上兩層推出來，不問 git、不問 repo 根。 */
export const CHANGELOG_PATH = join(import.meta.dirname, '..', '..', 'CHANGELOG.md');
/** daemon 宣告「我這個產品現在走哪一條版本線」的地方（例 `0.18`）。與 changelog 同一棵樹。 */
export const DAEMON_LINE_PATH = join(import.meta.dirname, '..', '..', 'DAEMON_LINE');
/** 畫面上一行讀得完的上限。超過就截，並改叫使用者去看說明文件。 */
export const NOTES_MAX = 100;
const TAIL = '（細節見說明文件）';

// ═══════════════════════════════════════════════════════════════════════════
// 版本線判別器（inkstone/arcrun-rag#88，2026-08-18 第二輪）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 🔴 **本節取代「用 `v` 前綴分辨版本線」的舊做法。**
 *
 * 舊做法的形狀：`^## (v\d+\.\d+\.\d+)（` ——「有 v ＝ daemon 那條線（`v0.18.x`）、
 * 沒 v ＝ 雲端引擎那條線（`1.4.x`）」。它**能動**，但它把「這個字串長什麼樣」
 * 當成「這個字串是誰的」在用，於是：
 *
 *   · leo 2026-08-17 定「對外號就是三個數字，不要 v」⇒ 產生端一改裸號，
 *     那條判斷式**不報錯**，而是往下比對到更舊的 `## v0.18.29（…）`
 *     ⇒ **打包出 0.18.30 的執行檔，manifest 卻宣稱是 v0.18.29。** 靜默、21 站全綠。
 *   · 反過來把它放寬成 `v?` 也不行：daemon 的閘會把雲端的 `## 1.4.47（…）`
 *     當成 daemon 版本撈走（2026-08-18 實撞，`daemon-in-bundle-gate.test.mjs` ①⑮⑯ 轉紅）。
 *
 * ⇒ 兩個方向都壞，是因為判別的承載選錯了。**外觀不是身分。**
 *
 * ── 新的承載：`collector/DAEMON_LINE` 宣告的那條線 ─────────────────────────
 * 那個檔案本來就存在（`daemon-version.py` 靠它決定升版／換線），內容是 `MAJOR.MINOR`。
 * 判斷式因此變成 `^## (v?0\.18\.\d+)（`——
 *   · 它**同時**擋掉「錯的檔」（雲端 `1.4.47` 不在 `0.18` 這條線上）
 *     與「錯的線」（DAEMON_LINE 已換成 `0.19`，卻還在拿 `0.18.x` 出貨）
 *   · 它**不依賴外觀** ⇒ 新的裸號 `0.18.31` 與既有的 `v0.18.30` 都認得
 *     （leo 2026-08-17：既有 tag／檔名不回頭改 ⇒ 過渡期兩種寫法必然並存）
 *   · 它是**宣告出來的事實**，不是猜的：DAEMON_LINE 說了算，改線就改那個檔
 */

/** `DAEMON_LINE` 的合法形狀。不是 `MAJOR.MINOR` 就不是一條線，別猜。 */
export const DAEMON_LINE_RE = /^\d+\.\d+$/;

/**
 * 讀出 daemon 宣告的版本線。**讀不到就回 null，不給預設值。**
 * 給預設值等於「猜一條線」，而猜錯的下場正是本節要治的病（靜默拿到別條線的版號）。
 * @returns {string|null} 例 `'0.18'`
 */
export function readDaemonLine(linePath = DAEMON_LINE_PATH) {
  if (!existsSync(linePath)) return null;
  const raw = readFileSync(linePath, 'utf8').trim();
  return DAEMON_LINE_RE.test(raw) ? raw : null;
}

/**
 * 「這份 changelog 最上面那個**已發佈**的 daemon 版本段」的判斷式。
 *
 * @param {string} line `DAEMON_LINE` 的內容（例 `'0.18'`）。**必填**——沒有線就沒有判別器，
 *   呼叫端該把「問不出線」當成斷，不是當成「用預設值繼續」。
 * @returns {RegExp} 第 1 組＝版本號**原樣**（`v0.18.30` 或 `0.18.31`，怎麼寫就怎麼回）
 */
export function daemonReleasedRe(line) {
  if (!DAEMON_LINE_RE.test(String(line ?? ''))) {
    throw new Error(
      `daemonReleasedRe 需要一條版本線（MAJOR.MINOR，例 0.18），拿到的是 ${JSON.stringify(line)}。\n` +
      `  ⇒ 版本線的真相源是 collector/DAEMON_LINE。讀不到它就沒有判別器，\n` +
      `    此時該讓呼叫端「斷得很大聲」，不是塞一個預設值繼續往下走。`);
  }
  return new RegExp(`^## (v?${line.replace(/\./g, '\\.')}\\.\\d+)（`, 'm');
}

/**
 * 「任何長得像版本段的標題」——🔴 **只給錯誤訊息用，永遠不准拿來做判斷。**
 *
 * 存在的理由：`daemonReleasedRe` 不中的時候，光說「找不到」幫不上忙。
 * 拿這支撈出檔案最上面那一段實際寫的是什麼（例 `1.4.47`），訊息就能說
 * 「你指到的是雲端那條線」而不是含糊的「沒有東西」。
 * **判斷與診斷分開**，正是舊的 `v` 判別器把兩件事混在一起才會出事的地方。
 */
export const ANY_RELEASED_RE = /^## (v?\d+\.\d+\.\d+)（/m;

/** 版本號屬於哪一條線（`v0.18.30` → `0.18`）。回 null＝這根本不是版本號。 */
export function lineOfVersion(version) {
  const m = /^v?(\d+\.\d+)\.\d+$/.exec(String(version ?? '').trim());
  return m ? m[1] : null;
}

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

/**
 * 組成畫面上那一行。回傳 null＝changelog 裡沒有這一版（呼叫端該當成錯誤）。
 * `changelogPath` 只給測試／薄殼覆寫用；正常呼叫不帶，走 collector 自己的 CHANGELOG.md。
 */
export function notesForVersion(version, changelogPath = CHANGELOG_PATH) {
  if (!existsSync(changelogPath)) return null;
  const heads = headlinesFor(readFileSync(changelogPath, 'utf8'), version);
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
// 🔴 2026-08-18：判斷「是不是直接跑本檔」要比**絕對路徑**，不能比檔名尾綴——
//    `installer/scripts/daemon-notes.mjs` 薄殼同名，用尾綴比會讓兩支 CLI 一起開火
//    （實撞：問雲端版號時本檔先 process.exit(1)，薄殼根本沒機會查 docs-site）。
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const v = process.argv[2];
  if (!v) { console.error('用法：node collector/cmd/arcrun-app/daemon-notes.mjs <版本，例 v0.18.24>'); process.exit(2); }
  const line = notesForVersion(v);
  if (!line) { console.error(`❌ changelog 沒有 ${v} 這一版（${CHANGELOG_PATH}）`); process.exit(1); }
  // stdout **只有那一行**——它會被別的腳本（changelog-section.sh）直接取用，
  // 多印一個字就會被塞進 manifest。其餘一律走 stderr。
  console.log(line);
  console.error(`（${line.length} 字）`);
  const probs = checkNotes(line);
  if (probs.length) { probs.forEach((p) => console.error('❌ ' + p)); process.exit(1); }
  console.error('✅ 可以送到使用者眼前');
}
