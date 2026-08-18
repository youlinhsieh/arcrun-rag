// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// docs 站（leo 2026-08-04）：
//   「就像一般的 doc 連結，在 rag.arcrun.dev，打開可以查到所有他需要知道的事情」
//   「docs 要**從 rag.arcrun.dev 進去**，不是從 install.arcrun.dev」
// ⇒ base 設 /docs，掛在 rag.arcrun.dev/docs/ 底下。
//
// 原則（leo）：**用戶好用、白癡化**。所以：
//   · 標題用「我要做什麼」的白話，不用系統內部術語
//   · Mac／Windows 分流——在簽章完成前，兩邊撞的牆完全不同
//   · 每段講「這對你意味什麼」，不是講機制
export default defineConfig({
  site: 'https://rag.arcrun.dev',
  base: '/docs',

  // ── 版本說明頁：**已刪除**，轉去 GitHub 版本發佈（leo 2026-08-17「這個頁面刪除」）──
  //
  // leo 2026-08-09 就講過「不要同步，docs 的版本說明直接連回 github 的版本發佈」，
  // 08-17 收口成三個字。文件站從此**不自己維護一份版本內容**：
  //   · 雲端引擎 `1.4.x` 的原稿 → repo 根的 `CHANGELOG.md`（出貨用，不是網頁）
  //   · 桌面版　 `v0.18.x` 的原稿 → `collector/CHANGELOG.md`
  //   · 使用者讀的 → https://github.com/youlinhsieh/arcrun-rag/releases（唯一對外紀錄）
  //
  // 🔴 為什麼是轉址而不是直接 404：這個網址是**公開過的**——它掛在側欄上，也印在
  //   `landing/worker.js` 那句「這一版改了什麼」旁邊，已經跟著 landing 部署到使用者
  //   瀏覽器裡了。repo 內的連結本輪都已改成直接指 GitHub，所以這條轉址不服務任何
  //   內部連結，它只接**書籤與舊 HTML**。一行宣告、沒有程式、沒有真相源可以漂，
  //   而且 `installer/scripts/verify-docs.mjs` 每次出貨會驗它真的還在轉
  //   ⇒ 它不是「留下來要維護的機制」，是一個被閘夾住的宣告。
  redirects: {
    '/help/changelog': 'https://github.com/youlinhsieh/arcrun-rag/releases',
  },

  integrations: [
    starlight({
      title: 'Arcrun RAG 使用說明',
      description: '把你的檔案變成 AI 查得到的知識庫——安裝、更新、接上 AI 的完整說明。',
      defaultLocale: 'root',
      locales: {
        root: { label: '正體中文', lang: 'zh-TW' },
      },
      // 不放 GitHub 連結：repo 是 private，放了只會給用戶 404
      social: [],
      // t185：跨站導覽（rag／install／docs 三站，之後還會加）——覆寫 Header 包一層
      components: { Header: './src/components/Header.astro' },
      sidebar: [
        {
          label: '開始用',
          items: [
            { label: '這是什麼？', slug: 'start/what' },
            { label: '安裝（Mac）', slug: 'start/install-mac' },
            { label: '安裝（Windows）', slug: 'start/install-windows' },
            { label: '連上你的知識庫', slug: 'start/connect' },
          ],
        },
        {
          label: '日常使用',
          items: [
            { label: '放檔案進去', slug: 'use/add-files' },
            { label: '搜尋與問答', slug: 'use/search' },
            { label: '接到你自己的 AI（MCP）', slug: 'use/mcp' },
            { label: '怎麼更新版本', slug: 'use/update' },
          ],
        },
        {
          label: '遇到問題',
          items: [
            { label: '常見問題', slug: 'help/faq' },
            { label: 'Gemini 金鑰被擋（403）', slug: 'help/gemini-403' },
            // 「版本說明」不再是本站的一頁（見上面 redirects 那段）——側欄直接送去 GitHub。
            { label: '版本說明（GitHub）', link: 'https://github.com/youlinhsieh/arcrun-rag/releases', attrs: { target: '_blank' } },
          ],
        },
      ],
    }),
  ],
});
