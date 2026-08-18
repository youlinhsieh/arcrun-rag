/**
 * daemon-notes.mjs（薄殼）— 實作已搬去 `collector/cmd/arcrun-app/daemon-notes.mjs`
 *
 * ── 為什麼是薄殼（2026-08-18，D95 第一輪）────────────────────────────────
 * leo 08-17：「結構要很直接，不要有很多扭曲。」
 *
 * daemon 的更新說明投影器本來住在 `installer/scripts/`、讀 repo 根的 docs-site
 * ⇒ **daemon 沒辦法自己交出「這一版對用戶意味什麼」**，也就搬不成獨立 repo。
 * 實作因此搬進 daemon 自己的樹底下，讀 `collector/CHANGELOG.md`。
 *
 * 🔴 方向是**單向**的：**根可以往內伸手，collector 不可以往外伸手。**
 * 本檔就是那隻「往內伸的手」——出貨管線（ship／release／github-release）
 * 的 import 路徑因此完全不用改。
 *
 * ── 一個檔變兩個檔：為什麼查兩處 ────────────────────────────────────────
 * 這個 changelog 原本**同時裝兩條版本線**：桌面版 `v0.18.x` 與雲端引擎 `1.4.x`。
 * 拆開之後：
 *   · `v0.18.x` → `collector/CHANGELOG.md`（daemon 自己的，旁邊就是 `collector/DAEMON_LINE`）
 *   · `1.4.x`   → repo 根的 `CHANGELOG.md`（雲端的，旁邊就是根的 `RELEASE_LINE`）
 * 出貨管線兩條線都要問，所以 `notesFromChangelog()` **先問 collector、再問根**。
 * 版號格式互斥（有沒有 `v` 前綴），不會互相撈到對方的段落。
 *
 * 🔴 **兩份都不是網頁，是出貨原稿**（2026-08-17 leo「這個頁面刪除」，inkstone/arcrun-rag#41）。
 *    雲端那份原本是 `docs-site/src/content/docs/help/changelog.md`——它**同時**是文件站的
 *    一頁與出貨原稿，而 D95 第一輪拆的是 daemon 那半，這半原地沒動。頁面刪掉之後
 *    原稿搬來 repo 根：使用者讀的是 GitHub 版本發佈（由 `github-release.mjs` 拿這兩份檔
 *    的段落產生），文件站不再自己維護一份。
 *
 * ⚠️ 這是過渡形態。collector/ 真的搬成獨立 repo 時，本檔該只剩雲端那一條，
 *    daemon 那條改成向獨立 repo 取。**不要把它當成長期設計。**
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHANGELOG_PATH as DAEMON_CHANGELOG_PATH,
  NOTES_MAX, stripMarkdown, headlinesFor, checkNotes, notesForVersion,
} from '../../collector/cmd/arcrun-app/daemon-notes.mjs';

export { NOTES_MAX, stripMarkdown, headlinesFor, checkNotes };

/** 雲端引擎（`1.4.x`）的版本說明＝repo 根的 `CHANGELOG.md`（出貨原稿，不是網頁）。 */
export const CHANGELOG_REL = 'CHANGELOG.md';
/** 桌面版（`v0.18.x`）的版本說明——已搬進 collector/。 */
export const DAEMON_CHANGELOG_REL = 'collector/CHANGELOG.md';

/**
 * 從說明文件取某一版的「一句話摘要」。**先問 daemon 的，再問雲端的。**
 * 回傳 null＝兩份都沒有這一版（呼叫端該當成錯誤）。
 */
export function notesFromChangelog(repoRoot, version) {
  const daemonPath = repoRoot
    ? join(repoRoot, DAEMON_CHANGELOG_REL)
    : DAEMON_CHANGELOG_PATH;
  const fromDaemon = existsSync(daemonPath) ? notesForVersion(version, daemonPath) : null;
  if (fromDaemon) return fromDaemon;
  return notesForVersion(version, join(repoRoot, CHANGELOG_REL));
}

/**
 * 這個版號的說明在哪一份檔案裡（相對 repo 根）。給錯誤訊息用——
 * 「找不到 v0.18.30」時要能指出**該去哪個檔補**，指錯地方比不指還糟。
 */
export function changelogRelFor(repoRoot, version) {
  const daemonPath = join(repoRoot, DAEMON_CHANGELOG_REL);
  if (existsSync(daemonPath) && notesForVersion(version, daemonPath)) return DAEMON_CHANGELOG_REL;
  if (/^v/.test(String(version))) return DAEMON_CHANGELOG_REL;  // 帶 v ＝ daemon 線
  return CHANGELOG_REL;
}

// CLI：印出某版會顯示的那一行（出貨前想先看一眼時用）
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const v = process.argv[2];
  const root = resolve(join(import.meta.dirname, '..', '..'));
  if (!v) { console.error('用法：node installer/scripts/daemon-notes.mjs <版本，例 v0.18.24>'); process.exit(2); }
  const line = notesFromChangelog(root, v);
  if (!line) {
    console.error(`❌ 說明文件沒有 ${v} 這一版（找過 ${DAEMON_CHANGELOG_REL} 與 ${CHANGELOG_REL}）`);
    process.exit(1);
  }
  // stdout **只有那一行**——它會被別的腳本直接取用，多印一個字就會被塞進 manifest。
  console.log(line);
  console.error(`（${line.length} 字，來源 ${changelogRelFor(root, v)}）`);
  const probs = checkNotes(line);
  if (probs.length) { probs.forEach((p) => console.error('❌ ' + p)); process.exit(1); }
  console.error('✅ 可以送到使用者眼前');
}
