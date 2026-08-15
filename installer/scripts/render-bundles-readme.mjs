/**
 * render-bundles-readme.mjs — bundle repo 的 README.md **只能由這裡產生**，不准手寫維護一份數字
 *
 * ── 病史（2026-08-10，總管實測發現）───────────────────────────────────────────
 * `youlinhsieh/arcrun-rag-bundles` 的 README 寫著「25 workers: tier1 components + tier2
 * engines」，而**同一個 repo 的 manifest.json** 老實地宣告 5 顆（release 1.4.30）。
 * 兩份數字互相矛盾，而且矛盾已經存在超過一版都沒人發現——因為出貨管線從來沒有任何一步
 * 碰過 README.md，它是很久以前手打的、之後再也沒有任何機制去核對它還準不準。
 *
 * 這與 `bundle-components.mjs` 檔頭記的那次「兩份人維護的零件清單」是**同一種病**：
 * 只要有兩個地方各自宣稱「這個 bundle 有哪幾顆」，就必然漂移，差別只是這次沒有任何
 * 機械閘夾住它，所以連「漂移了」這件事本身都不會被發現。
 *
 * ⇒ 唯一解法跟那次一樣：**README 由這一版真的算出來的名單產生，不由人寫**。
 *   出貨管線每次出貨都重新產生這份檔案（見 ship.mjs 的 `readme` 步驟）——
 *   內容跟零件清單不同步，在結構上不再可能發生。
 */
import { layoutFor } from './bundle-components.mjs';

/**
 * @param {object} o
 * @param {string} o.release   manifest.release（例 "1.4.30"）
 * @param {string} [o.source]  manifest.source（例 "Arcrun@c4cee35"，不含「Arcrun@」前綴也可）
 * @param {string} [o.built]   manifest.built（例 "2026-08-10"）
 * @param {boolean} [o.hasDaemon] manifest.daemon.version 是否存在——決定要不要提 daemon/ 目錄
 * @param {string[]} o.library      這一版公庫的全部零件名（bundle 裡都有檔案）
 * @param {string[]} o.firstInstall 其中安裝器會直接部署的那幾顆
 * @returns {string} README.md 全文（含結尾換行）
 */
export function renderBundlesReadme({ release, source, built, hasDaemon, library = [], firstInstall = [] }) {
  const first = new Set(firstInstall);
  const src = String(source || '').replace(/^Arcrun@/, '');
  const lines = [
    '# Arcrun RAG — install bundles',
    '',
    'Prebuilt worker/service bundles for the **Arcrun RAG** one-click installer.',
    'Served via jsDelivr; fetched automatically during install — you never need to read this repo.',
    '',
    `- \`manifest.json\` — 索引：\`core\`＝安裝時就部署的 ${firstInstall.length} 顆、` +
      `\`library\`＝這一版公庫的 ${library.length} 顆（其餘用到才下載）`,
    ...library.map((n) => `- \`${layoutFor(n).relDir}/\` — **${n}**${first.has(n) ? '（首裝）' : '（用到才下載）'}`),
    hasDaemon ? '- `daemon/` — 桌面 App（Mac／Windows）安裝檔' : null,
    '',
    `Built from \`Arcrun@${src || '(unknown)'}\` by \`installer/scripts/ship.mjs\`` +
      `（arcrun-rag repo，release ${release || '(unknown)'}${built ? `，built ${built}` : ''}）。`,
    '',
    '⚠️ 這份檔案由出貨管線每次自動重寫（`installer/scripts/render-bundles-readme.mjs`）——',
    '不要手動改這裡列的零件清單——它是算出來的：公庫＝Arcrun 這一版編了什麼，',
    '首裝＝安裝器會推的工作流證明需要什麼（`installer/scripts/bundle-components.mjs`）。',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n') + '\n';
}
