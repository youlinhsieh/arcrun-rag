---
title: 接到你自己的 AI（MCP）
description: 讓 Claude、ChatGPT 等 AI 直接查詢你的私人知識庫。
---

**這是整套東西最有價值的地方**：讓你平常用的 AI，能查你的私人資料。

## 你的 MCP 網址

跟你的知識庫網址同一組，把 `xxxx` 換成你自己的那串：

```
https://arcrun-mcp.xxxx.workers.dev/mcp
```

:::tip[不確定是哪一串？]
登入 portal → 設定頁，那裡可以直接複製。
:::

## 跟別人的 MCP 不一樣

市面上多數 MCP 要你在**自己電腦**上裝一支程式（stdio 模式）。

**你裝的是雲端 MCP** —— 你的 AI 走網址連過來就好，不必在本機裝任何東西。

## 接到 Claude.ai（網頁版／App）

1. 打開 Claude 的**設定 → 連接器**
2. 新增自訂連接器
3. 貼上你的 MCP 網址，儲存

## 接到 Claude Code（終端機）

```bash
claude mcp add --transport http arcrun https://arcrun-mcp.xxxx.workers.dev/mcp
```

然後打 `/mcp` 檢查連上了沒。第一次會要你授權。

## 接到 ChatGPT

**目前只有付費的 Pro／Business／Enterprise／Edu 方案能接**——這是 OpenAI 官方的規定，不是我們的限制。
（Pro 是每月 $200 的頂規方案，跟每月 $20 的 Plus 不是同一個；免費版跟 Plus 版目前都打不開這條路。）

方案符合的話：

1. 打開 ChatGPT **網頁版**（手機 App 目前還不支援）
2. 設定 → **Apps** → 進階設定，打開 **Developer mode**
3. 新增一個 App，貼上你的 MCP 網址，驗證方式選 **OAuth**
4. 存檔，照畫面完成授權

:::caution[能查詢，不能寫入]
接上後 ChatGPT 可以查詢你的知識庫、附出處，跟 Claude 那邊一樣。
但目前**不能拿它寫入或修改**——OpenAI 那邊本來就只開放到「讀取」，
剛好跟本產品「MCP 只提供查詢」一致，沒有損失。
:::

方案不符合？先用 Claude（上面兩節）就好，功能一樣，不必等 OpenAI 開放。

## 有多個知識庫？

**每個知識庫有自己的 MCP 網址，彼此獨立。**
如果你有兩個（例如「個人」和「公司」），分別接上就好，取不同名字：

```bash
claude mcp add --transport http arcrun-personal https://arcrun-mcp.xxxx.workers.dev/mcp
claude mcp add --transport http arcrun-work     https://arcrun-mcp.yyyy.workers.dev/mcp
```

## 接上之後能做什麼

直接問你的 AI，它會自己去查：

> 「幫我查一下我的知識庫，關於請假規則是怎麼寫的？」

它會查到、引用你的檔案內容回答，並告訴你來源是哪一份。
