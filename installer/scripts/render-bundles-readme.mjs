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
 * ⇒ 唯一解法跟那次一樣：**README 由 `BUNDLE_COMPONENTS`（唯一真相源）算出來，不由人寫**。
 *   出貨管線每次出貨都重新產生這份檔案（見 ship.mjs 的 `readme` 步驟）——
 *   內容跟零件清單不同步，在結構上不再可能發生。
 */
import { BUNDLE_COMPONENTS } from './bundle-components.mjs';

/**
 * @param {object} o
 * @param {string} o.release   manifest.release（例 "1.4.30"）
 * @param {string} [o.source]  manifest.source（例 "Arcrun@c4cee35"，不含「Arcrun@」前綴也可）
 * @param {string} [o.built]   manifest.built（例 "2026-08-10"）
 * @param {boolean} [o.hasDaemon] manifest.daemon.version 是否存在——決定要不要提 daemon/ 目錄
 * @returns {string} README.md 全文（含結尾換行）
 */
export function renderBundlesReadme({ release, source, built, hasDaemon }) {
  const src = String(source || '').replace(/^Arcrun@/, '');
  const lines = [
    '# Arcrun RAG — install bundles',
    '',
    'Prebuilt worker/service bundles for the **Arcrun RAG** one-click installer.',
    'Served via jsDelivr; fetched automatically during install — you never need to read this repo.',
    '',
    `- \`manifest.json\` — schema \`arcrun-rag-bundles/v1\`（${BUNDLE_COMPONENTS.length} components，逐顆見下）`,
    ...BUNDLE_COMPONENTS.map((c) => `- \`${c.relDir}/\` — **${c.name}**`),
    hasDaemon ? '- `daemon/` — 桌面 App（Mac／Windows）安裝檔' : null,
    '',
    `Built from \`Arcrun@${src || '(unknown)'}\` by \`installer/scripts/ship.mjs\`` +
      `（arcrun-rag repo，release ${release || '(unknown)'}${built ? `，built ${built}` : ''}）。`,
    '',
    '⚠️ 這份檔案由出貨管線每次自動重寫（`installer/scripts/render-bundles-readme.mjs`）——',
    '不要手動改這裡列的零件清單，要改就改 `installer/scripts/bundle-components.mjs`' +
      '（唯一真相源，改一個地方兩條出貨路徑同時生效）。',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n') + '\n';
}
