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
            { label: '版本說明', slug: 'help/changelog' },
          ],
        },
      ],
    }),
  ],
});
