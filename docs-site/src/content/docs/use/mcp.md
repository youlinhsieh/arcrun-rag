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

## 怎麼登入：就是你的 Portal 帳號密碼

**沒有另一把「金鑰」或「secret」要找。** 任何 AI 接上來的時候，
都會跳出一個要你輸入 **email ＋ 密碼**的頁面——填**你登入這個知識庫用的那組**就對了。

輸入正確才會發給對方一把有效期限的通行證；輸入錯誤就不發。
所以「知道網址」的人進不來。

## 接到 Claude.ai（網頁版／App）

1. 打開 Claude 的**設定 → 連接器**
2. 新增自訂連接器
3. 貼上你的 MCP 網址，儲存
4. 按授權，在跳出來的頁面填你的 **Portal email ＋ 密碼**

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

:::caution[ChatGPT 那邊只能查詢]
接上後 ChatGPT 可以查詢你的知識庫、附出處，跟 Claude 那邊一樣，
但**不能拿它寫入或修改**——這是 OpenAI 的限制，他們只開放到「讀取」。

**這不代表 MCP 本身只能讀。** Claude 那邊接上後是可以寫的
（建立知識卡、存工作流、加標籤都做得到）。差別在客戶端，不在這個知識庫。
:::

方案不符合？先用 Claude（上面兩節）就好，**功能還更完整**，不必等 OpenAI 開放。

## 接到 n8n、或其他自己架的工具

n8n 的 **MCP Client** 節點：

| 欄位 | 填什麼 |
|---|---|
| Endpoint | 你的 MCP 網址（上面那串，結尾是 `/mcp`） |
| Server Transport | **HTTP Streamable** |
| Authentication | **MCP OAuth2**（不是 Bearer、不是 Header Auth） |

按授權後會跳出帳密頁，填你的 Portal email ＋ 密碼。

:::danger[先讓你的網域被認得，否則連帳密頁都看不到]
授權時，對方會把你送回**它自己的網址**（n8n 叫它 callback URL，
長得像 `https://你的n8n網域/rest/oauth2-credential/callback`）。

**你的知識庫只認得幾個網域**——內建放行的是 Claude 官方那三個
（`claude.ai`／`claude.com`／`anthropic.com`），它們永遠有效、移不掉。
沒被放行的網域，會看到一頁寫著「**這個網域還沒被允許連上你的知識庫**」，
底下附一行技術訊息：

```
invalid_request: redirect_uri missing or not allowed
```

**這不是帳密錯，也不是網址打錯。** 症狀是「連要你輸入帳密的那一頁都出不來」，
非常容易誤判成認證壞掉——看到這一頁就是這個原因。

**怎麼放行**（要用**管理員**帳號）：

1. 用瀏覽器登入你的知識庫 **Portal**
2. 到 **設定 → 接上你的 AI（MCP）→ 允許連線的網址**
3. 把那個工具給你的 callback 網址**整條**貼進去（會自動取出網域），按「加入」
4. 回到剛才那個工具，重新按一次授權

加進去的網域是**跟內建那三個相加**，不是取代——填了自己的 n8n，Claude 那邊照樣通。
不是管理員的話，請管理員照上面加一次即可。
:::

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
